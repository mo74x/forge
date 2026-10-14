import { MappingSpec } from '@lattice/mapping-spec';
import { SandboxRunner } from '@lattice/sandbox';
import { TypecheckVerifier } from './stage1-typecheck';
import { AstSecurityScanner } from './stage2-ast-scan';
import { FunctionalVerifiers } from './functional-verifiers';
import {
  GoldenFixture,
  StageResult,
  VerificationPipelineReport,
  WebhookTestVector,
} from './types';

export class VerificationPipeline {
  static runAll(params: {
    adapterFileName: string;
    adapterCode: string;
    spec: MappingSpec;
    goldenFixtures: GoldenFixture[];
    heldOutFixtures: GoldenFixture[];
    webhookVector?: WebhookTestVector;
  }): VerificationPipelineReport {
    const startTotal = Date.now();
    const stages: StageResult[] = [];

    const finish = (failedStage: StageResult['stage'] | null): VerificationPipelineReport => ({
      allPassed: failedStage === null,
      failedStage,
      stages,
      totalDurationMs: Date.now() - startTotal,
    });

    // Stage 1: TypeScript Compiler API Check
    const s1 = TypecheckVerifier.verify(params.adapterFileName, params.adapterCode);
    stages.push(s1);
    if (!s1.passed) return finish('TYPECHECK');

    // Stage 2: AST Security & Banned-API Scan
    const s2 = AstSecurityScanner.verify(params.adapterFileName, params.adapterCode);
    stages.push(s2);
    if (!s2.passed) return finish('AST_SCAN');

    // Instantiate inside isolated V8 Sandbox
    const sandboxedAdapter = SandboxRunner.instantiateAdapter(params.adapterCode);

    // Stage 3: Golden Fixture Tests
    const s3 = FunctionalVerifiers.verifyFixtures(
      sandboxedAdapter,
      params.goldenFixtures,
      'GOLDEN'
    );
    stages.push(s3);
    if (!s3.passed) return finish('GOLDEN');

    // Stage 4: Held-Out Sample Generalization Check
    const s4 = FunctionalVerifiers.verifyFixtures(
      sandboxedAdapter,
      params.heldOutFixtures,
      'HELD_OUT'
    );
    stages.push(s4);
    if (!s4.passed) return finish('HELD_OUT');

    // Stage 5: fast-check Property & Unmapped Field Capture Suite
    const s5 = FunctionalVerifiers.verifyProperties(sandboxedAdapter, params.spec);
    stages.push(s5);
    if (!s5.passed) return finish('PROPERTY');

    // Stage 6: Webhook Cryptographic Test Vector Check
    const s6 = FunctionalVerifiers.verifyWebhookVector(sandboxedAdapter, params.webhookVector);
    stages.push(s6);
    if (!s6.passed) return finish('WEBHOOK');

    return finish(null);
  }
}