import { Project, ScriptTarget, ModuleKind } from 'ts-morph';
import { StageResult, StageDiagnostic } from './types';

export class TypecheckVerifier {
  static verify(adapterFileName: string, adapterSourceCode: string): StageResult {
    const start = Date.now();
    const diagnostics: StageDiagnostic[] = [];

    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.CommonJS,
        strict: true,
        noImplicitAny: true,
        strictNullChecks: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    });

    // Stub virtual ambient declarations for workspace packages so in-memory tsc
    // checks exact contract signatures without disk I/O overhead
    project.createSourceFile(
      'node_modules/@lattice/canonical/index.d.ts',
      `
      export type CanonicalBookingStatus = 'PENDING' | 'CONFIRMED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED';
      export interface CanonicalBooking {
        id?: string;
        tenantId: string;
        propertyId: string;
        unitId: string;
        guestName: string;
        guestEmail?: string | null;
        checkIn: string;
        checkOut: string;
        status: CanonicalBookingStatus;
        totalAmount: number;
        currency: string;
      }
      export interface CanonicalEnvelope<T = unknown> {
        entityType: 'booking' | 'property' | 'transaction';
        externalId: string;
        externalUpdatedAt: Date;
        rawHash: string;
        data: T;
      }
      export function computeCanonicalHash(data: Record<string, unknown>): string;
      `
    );

    project.createSourceFile(
      'node_modules/@lattice/adapters/index.d.ts',
      `
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
        verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, secret: string): boolean;
        extractEventId(payload: unknown, headers: Record<string, string | string[] | undefined>): string;
        extractTimestamp(payload: unknown, headers: Record<string, string | string[] | undefined>): Date;
        toCanonical(external: TExternal): CanonicalEnvelope<CanonicalBooking>;
        fromCanonical(entity: CanonicalBooking, ctx: PushContext): TExternal;
        listChangedSince(cursor: string | null, credentials: Record<string, unknown>): Promise<{ items: TExternal[]; nextCursor: string | null }>;
      }
      `
    );

    project.createSourceFile(
      'node_modules/@lattice/mapping-spec/index.d.ts',
      `
      export interface MappingSpec { [key: string]: any; }
      export function applyTransform(value: unknown, root: unknown, spec: any): any;
      export function getByPath(obj: unknown, jsonPath: string): any;
      export function setByPath(target: Record<string, any>, jsonPath: string, value: unknown): void;
      export function extractUnmappedMetadata(payload: Record<string, unknown>, mappedPaths: Set<string>): Record<string, unknown>;
      `
    );

    const sourceFile = project.createSourceFile(adapterFileName, adapterSourceCode);
    const tsDiagnostics = project.getPreEmitDiagnostics();

    for (const diag of tsDiagnostics) {
      // Ignore missing @types/node in virtual FS for Buffer/crypto if ambient
      const code = diag.getCode();
      const msg = diag.getMessageText().toString();
      if (code === 2307 && msg.includes("'crypto'")) continue;
      if (code === 2580 && msg.includes("'Buffer'")) continue;

      const lineAndCol = diag.getSourceFile()
        ? diag.getSourceFile()!.getLineAndColumnAtPos(diag.getStart() || 0)
        : { line: 0, column: 0 };

      diagnostics.push({
        stage: 'TYPECHECK',
        code: `TS${code}`,
        message: msg,
        line: lineAndCol.line,
        column: lineAndCol.column,
      });
    }

    // Verify at least one exported class implements PartnerAdapter
    const classes = sourceFile.getClasses();
    const implementsAdapter = classes.some((c) =>
      c.getImplements().some((imp) => imp.getText().startsWith('PartnerAdapter'))
    );

    if (!implementsAdapter) {
      diagnostics.push({
        stage: 'TYPECHECK',
        code: 'FORGE_MISSING_INTERFACE',
        message: 'Generated class must explicitly implement PartnerAdapter<T>',
      });
    }

    return {
      stage: 'TYPECHECK',
      passed: diagnostics.length === 0,
      durationMs: Date.now() - start,
      diagnostics,
    };
  }
}