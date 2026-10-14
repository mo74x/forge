import { CanonicalBooking } from '@lattice/canonical';

export type VerificationStageName =
  | 'TYPECHECK'
  | 'AST_SCAN'
  | 'GOLDEN'
  | 'HELD_OUT'
  | 'PROPERTY'
  | 'WEBHOOK';

export interface StageDiagnostic {
  stage: VerificationStageName;
  code: string;
  message: string;
  line?: number;
  column?: number;
  field?: string;
  expected?: unknown;
  actual?: unknown;
  counterexample?: unknown;
}

export interface StageResult {
  stage: VerificationStageName;
  passed: boolean;
  durationMs: number;
  diagnostics: StageDiagnostic[];
}

export interface VerificationPipelineReport {
  allPassed: boolean;
  failedStage: VerificationStageName | null;
  stages: StageResult[];
  totalDurationMs: number;
}

export interface GoldenFixture {
  sampleId: string;
  label: string;
  isHeldOut: boolean;
  rawPartnerPayload: Record<string, unknown>;
  expectedCanonical: CanonicalBooking;
}

export interface WebhookTestVector {
  rawBody: string;
  secret: string;
  headers: Record<string, string>;
  expectedValid: boolean;
  expectedEventId: string;
}