import { MappingSpec, MappingSpecSchema } from '@lattice/mapping-spec';
import { QuirkDetector, FieldProfile, ConfidenceScorer } from '@lattice/inference';
import { AdapterCompiler, CompiledAdapterBundle } from '@lattice/codegen';
import {
  VerificationPipeline,
  GoldenFixture,
  StageDiagnostic,
  VerificationPipelineReport,
  VerificationStageName,
  WebhookTestVector,
} from '@lattice/verify';
import { LlmProvider } from '@lattice/llm';
import { PromptBuilder } from './prompt-builder';

export interface AttemptRecord {
  attemptNumber: number;
  spec: MappingSpec | null;
  failedStage: VerificationStageName | 'ZOD_VALIDATION' | null;
  diagnostics: StageDiagnostic[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  passed: boolean;
}

export interface OnboardingOrchestrationResult {
  status: 'READY_FOR_REVIEW' | 'NEEDS_HUMAN';
  finalSpec: MappingSpec | null;
  compiledBundle: CompiledAdapterBundle | null;
  verificationReport: VerificationPipelineReport | null;
  attempts: AttemptRecord[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  wallClockMs: number;
}

export class OnboardingOrchestrator {
  private static readonly MAX_ATTEMPTS = 3;

  static async executeRun(params: {
    provider: string;
    trainingFixtures: GoldenFixture[];
    heldOutFixtures: GoldenFixture[];
    docsExcerpt?: string;
    webhookVector?: WebhookTestVector;
    llm: LlmProvider;
  }): Promise<OnboardingOrchestrationResult> {
    const startWall = Date.now();
    const attempts: AttemptRecord[] = [];

    const trainingPayloads = params.trainingFixtures.map((f) => f.rawPartnerPayload);

    // 1. Stage 1 Deterministic Quirk & Structure Analysis
    const profiles = QuirkDetector.analyzeSamples(trainingPayloads);
    const redactedSamples = this.redactPayloads(trainingPayloads, profiles);

    let currentSpec: MappingSpec | null = null;
    let lastFailedStage: VerificationStageName | 'ZOD_VALIDATION' | null = null;
    let lastDiagnostics: StageDiagnostic[] = [];
    let finalBundle: CompiledAdapterBundle | null = null;
    let finalReport: VerificationPipelineReport | null = null;

    // 2. Bounded 3-Attempt Loop
    for (let attemptNum = 1; attemptNum <= this.MAX_ATTEMPTS; attemptNum++) {
      const systemPrompt = PromptBuilder.buildSystemPrompt();
      const userPrompt =
        attemptNum === 1 || !currentSpec
          ? PromptBuilder.buildInitialProposalPrompt({
              provider: params.provider,
              profiles,
              redactedSamples,
              docsExcerpt: params.docsExcerpt,
            })
          : PromptBuilder.buildRepairPrompt({
              attemptNumber: attemptNum,
              previousSpec: currentSpec,
              failedStage: lastFailedStage as VerificationStageName,
              diagnostics: lastDiagnostics,
              profiles,
            });

      const llmRes = await params.llm.completeJson({
        systemPrompt,
        userPrompt,
        temperature: 0,
      });

      // Validate JSON against MappingSpec Zod Schema
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(llmRes.rawJsonText);
      } catch (err: any) {
        lastFailedStage = 'ZOD_VALIDATION';
        lastDiagnostics = [
          {
            stage: 'TYPECHECK',
            code: 'INVALID_JSON',
            message: `Model did not return valid JSON: ${err.message}`,
          },
        ];
        attempts.push({
          attemptNumber: attemptNum,
          spec: null,
          failedStage: 'ZOD_VALIDATION',
          diagnostics: lastDiagnostics,
          tokensIn: llmRes.tokensIn,
          tokensOut: llmRes.tokensOut,
          costUsd: llmRes.costUsd,
          latencyMs: llmRes.latencyMs,
          passed: false,
        });
        continue;
      }

      const zodCheck = MappingSpecSchema.safeParse(parsedJson);
      if (!zodCheck.success) {
        lastFailedStage = 'ZOD_VALIDATION';
        lastDiagnostics = zodCheck.error.issues.map((iss) => ({
          stage: 'TYPECHECK',
          code: 'ZOD_SPEC_INVALID',
          message: `Path "${iss.path.join('.')}": ${iss.message}`,
        }));
        attempts.push({
          attemptNumber: attemptNum,
          spec: null,
          failedStage: 'ZOD_VALIDATION',
          diagnostics: lastDiagnostics,
          tokensIn: llmRes.tokensIn,
          tokensOut: llmRes.tokensOut,
          costUsd: llmRes.costUsd,
          latencyMs: llmRes.latencyMs,
          passed: false,
        });
        continue;
      }

      // Overwrite model confidence with deterministic cross-sample agreement score
      currentSpec = this.recomputeSpecConfidence(zodCheck.data, trainingPayloads, profiles);

      // 3. Stage 2 Deterministic Codegen
      finalBundle = await AdapterCompiler.compile(currentSpec);

      // 4. Stage 3 Six-Stage Verification Pipeline
      finalReport = VerificationPipeline.runAll({
        adapterFileName: finalBundle.adapterFileName,
        adapterCode: finalBundle.adapterCode,
        spec: currentSpec,
        goldenFixtures: params.trainingFixtures,
        heldOutFixtures: params.heldOutFixtures,
        webhookVector: params.webhookVector,
      });

      if (finalReport.allPassed) {
        attempts.push({
          attemptNumber: attemptNum,
          spec: currentSpec,
          failedStage: null,
          diagnostics: [],
          tokensIn: llmRes.tokensIn,
          tokensOut: llmRes.tokensOut,
          costUsd: llmRes.costUsd,
          latencyMs: llmRes.latencyMs,
          passed: true,
        });

        return this.summarizeResult('READY_FOR_REVIEW', currentSpec, finalBundle, finalReport, attempts, startWall);
      }

      // Record failure & prepare structured diagnostics for next repair iteration
      lastFailedStage = finalReport.failedStage;
      const failedStageObj = finalReport.stages.find((s) => s.stage === finalReport!.failedStage);
      lastDiagnostics = failedStageObj ? failedStageObj.diagnostics : [];

      attempts.push({
        attemptNumber: attemptNum,
        spec: currentSpec,
        failedStage: lastFailedStage,
        diagnostics: lastDiagnostics,
        tokensIn: llmRes.tokensIn,
        tokensOut: llmRes.tokensOut,
        costUsd: llmRes.costUsd,
        latencyMs: llmRes.latencyMs,
        passed: false,
      });

      // Safeguard: Never leak Held-Out ground truth values into repair prompts
      if (lastFailedStage === 'HELD_OUT') {
        lastDiagnostics = lastDiagnostics.map((d) => ({
          ...d,
          expected: '[WITHHELD_HELD_OUT_GROUND_TRUTH]',
          message: `Held-out generalization failed on field "${d.field}". Check enum completeness or optionality handling.`,
        }));
      }
    }

    // Exceeded 3 attempts -> Escalate cleanly to human review with diagnostics
    return this.summarizeResult('NEEDS_HUMAN', currentSpec, finalBundle, finalReport, attempts, startWall);
  }

  private static recomputeSpecConfidence(
    spec: MappingSpec,
    samples: Record<string, unknown>[],
    profiles: Map<string, FieldProfile>
  ): MappingSpec {
    const updatedFields = spec.fields.map((field) => {
      const scored = ConfidenceScorer.scoreFieldMapping(field, samples, profiles);
      return {
        ...field,
        confidence: scored.confidence,
        evidence: scored.evidence,
      };
    });

    return {
      ...spec,
      fields: updatedFields,
    };
  }

  private static redactPayloads(
    samples: Record<string, unknown>[],
    profiles: Map<string, FieldProfile>
  ): Record<string, unknown>[] {
    const sensitivePaths = new Set(
      Array.from(profiles.values())
        .filter((p) => p.sensitive)
        .map((p) => p.path.replace(/^\$\./, ''))
    );

    return samples.map((s) => {
      const clone = JSON.parse(JSON.stringify(s));
      for (const path of sensitivePaths) {
        if (path in clone) {
          clone[path] = '[REDACTED_BY_FORGE]';
        }
      }
      return clone;
    });
  }

  private static summarizeResult(
    status: 'READY_FOR_REVIEW' | 'NEEDS_HUMAN',
    finalSpec: MappingSpec | null,
    compiledBundle: CompiledAdapterBundle | null,
    verificationReport: VerificationPipelineReport | null,
    attempts: AttemptRecord[],
    startWall: number
  ): OnboardingOrchestrationResult {
    return {
      status,
      finalSpec,
      compiledBundle,
      verificationReport,
      attempts,
      totalTokensIn: attempts.reduce((acc, a) => acc + a.tokensIn, 0),
      totalTokensOut: attempts.reduce((acc, a) => acc + a.tokensOut, 0),
      totalCostUsd: Number(attempts.reduce((acc, a) => acc + a.costUsd, 0).toFixed(6)),
      wallClockMs: Date.now() - startWall,
    };
  }
}