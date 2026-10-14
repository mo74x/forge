import { CanonicalBooking, CanonicalEnvelope } from '@lattice/canonical';

export interface PushContext {
  connectionId: string;
  tenantId: string;
  idempotencyKey?: string;
  supportsOriginHeader?: boolean;
}

export interface AdapterCapabilities {
  supportsOriginHeader: boolean;
  supportsIdempotencyKey: boolean;
  supportsIncrementalPull: boolean;
  rateLimit: { rps: number; burst: number };
}

export interface PartnerAdapter<TExternal = any> {
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    secret: string
  ): boolean;
  extractEventId(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>
  ): string;
  extractTimestamp(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Date;
  toCanonical(external: TExternal): CanonicalEnvelope<CanonicalBooking>;
  fromCanonical(entity: CanonicalBooking, ctx: PushContext): TExternal;
  listChangedSince(
    cursor: string | null,
    credentials: Record<string, unknown>
  ): Promise<{ items: TExternal[]; nextCursor: string | null }>;
}
