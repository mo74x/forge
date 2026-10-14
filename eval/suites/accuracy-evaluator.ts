import { MappingSpec } from '@lattice/mapping-spec';
import { OnboardingOrchestrator, OnboardingOrchestrationResult } from '@lattice/repair-loop';
import { GoldenFixture, WebhookTestVector } from '@lattice/verify';
import { LlmProvider } from '@lattice/llm';

export interface SuiteBenchmarkSummary {
  suiteName: string;
  provider: string;
  status: string;
  fieldAccuracy: number; // 0.0 - 1.0
  matchedFields: number;
  totalFields: number;
  attemptsUsed: number;
  firstPassCompiled: boolean;
  escapeHatchCount: number;
  totalCostUsd: number;
  wallClockMs: number;
  runtimeLlmCalls: 0;
}

export class AccuracyEvaluator {
  static async evaluatePartnerOnboarding(params: {
    suiteName: string;
    provider: string;
    trainingFixtures: GoldenFixture[];
    heldOutFixtures: GoldenFixture[];
    webhookVector: WebhookTestVector;
    referenceSpec: MappingSpec;
    llm: LlmProvider;
  }): Promise<{ summary: SuiteBenchmarkSummary; orchestration: OnboardingOrchestrationResult }> {
    const orchestration = await OnboardingOrchestrator.executeRun({
      provider: params.provider,
      trainingFixtures: params.trainingFixtures,
      heldOutFixtures: params.heldOutFixtures,
      webhookVector: params.webhookVector,
      llm: params.llm,
    });

    const totalFields = params.referenceSpec.fields.length;
    let matchedFields = 0;

    if (orchestration.finalSpec) {
      for (const refField of params.referenceSpec.fields) {
        const genField = orchestration.finalSpec.fields.find(
          (f) => f.canonicalField === refField.canonicalField
        );
        if (
          genField &&
          genField.source.path === refField.source.path &&
          genField.transform.kind === refField.transform.kind
        ) {
          matchedFields++;
        }
      }
    }

    const firstAttempt = orchestration.attempts[0];
    const firstPassCompiled =
      firstAttempt !== undefined &&
      firstAttempt.failedStage !== 'ZOD_VALIDATION' &&
      firstAttempt.failedStage !== 'TYPECHECK';

    const escapeHatchCount =
      orchestration.finalSpec?.fields.filter((f) => f.transform.kind === 'custom').length ?? 0;

    return {
      orchestration,
      summary: {
        suiteName: params.suiteName,
        provider: params.provider,
        status: orchestration.status,
        fieldAccuracy: Number((matchedFields / totalFields).toFixed(4)),
        matchedFields,
        totalFields,
        attemptsUsed: orchestration.attempts.length,
        firstPassCompiled,
        escapeHatchCount,
        totalCostUsd: orchestration.totalCostUsd,
        wallClockMs: orchestration.wallClockMs,
        runtimeLlmCalls: 0,
      },
    };
  }

  static generateMarkdownReport(
    benchmarks: SuiteBenchmarkSummary[],
    mutationCatchRate: number,
    caughtCount: number,
    totalMutations: number
  ): string {
    const rows = benchmarks
      .map(
        (b) =>
          `| \`${b.suiteName}\` | \`${b.provider}\` | **${(b.fieldAccuracy * 100).toFixed(1)}%** (${b.matchedFields}/${b.totalFields}) | ${b.firstPassCompiled ? '✅ Yes' : '❌ No'} | ${b.attemptsUsed} | ${b.escapeHatchCount} | $${b.totalCostUsd.toFixed(4)} | ${(b.wallClockMs / 1000).toFixed(2)}s | **0** |`
      )
      .join('\n');

    return `# Forge Evaluation Benchmark Report

| Suite | Partner | Field Accuracy | 1st-Pass Compile | Attempts | Escape Hatches | Cost (USD) | Time to Green | Runtime LLM Calls |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${rows}

## Verifier Robustness (Mutation Testing)
- **Injected Faults Caught:** **${caughtCount} / ${totalMutations} (${(mutationCatchRate * 100).toFixed(1)}%)**
- **Verified Stages:** \`TYPECHECK\`, \`AST_SCAN\`, \`GOLDEN\`, \`HELD_OUT\`, \`PROPERTY\`, \`WEBHOOK\`
`;
  }
}