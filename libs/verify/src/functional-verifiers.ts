import * as fc from 'fast-check';
import { PartnerAdapter } from '@lattice/adapters';
import { CanonicalBooking } from '@lattice/canonical';
import { MappingSpec } from '@lattice/mapping-spec';
import {
  GoldenFixture,
  StageDiagnostic,
  StageResult,
  WebhookTestVector,
} from './types';

export class FunctionalVerifiers {
  private static readonly CORE_FIELDS: (keyof CanonicalBooking)[] = [
    'propertyId',
    'unitId',
    'guestName',
    'guestEmail',
    'checkIn',
    'checkOut',
    'status',
    'totalAmount',
    'currency',
  ];

  /**
   * Stage 3 (Golden) & Stage 4 (Held-Out):
   * Compares adapter output field-by-field against human-verified ground truth.
   */
  static verifyFixtures(
    adapter: PartnerAdapter,
    fixtures: GoldenFixture[],
    stageName: 'GOLDEN' | 'HELD_OUT'
  ): StageResult {
    const start = Date.now();
    const diagnostics: StageDiagnostic[] = [];

    for (const fixture of fixtures) {
      try {
        const envelope = adapter.toCanonical(fixture.rawPartnerPayload);
        const actual = envelope.data;
        const expected = fixture.expectedCanonical;

        for (const field of this.CORE_FIELDS) {
          const expVal = expected[field] ?? null;
          const actVal = actual[field] ?? null;

          if (expVal !== actVal) {
            diagnostics.push({
              stage: stageName,
              code: `${stageName}_FIELD_MISMATCH`,
              message: `Sample "${fixture.label}" (${fixture.sampleId}) failed on field "${field}": expected ${JSON.stringify(expVal)}, got ${JSON.stringify(actVal)}`,
              field,
              expected: expVal,
              actual: actVal,
            });
          }
        }
      } catch (err: any) {
        diagnostics.push({
          stage: stageName,
          code: `${stageName}_RUNTIME_ERROR`,
          message: `Sample "${fixture.label}" threw runtime error: ${err.message}`,
        });
      }
    }

    return {
      stage: stageName,
      passed: diagnostics.length === 0,
      durationMs: Date.now() - start,
      diagnostics,
    };
  }

  /**
   * Stage 5: fast-check Property-Based Testing
   * Verifies:
   * 1. Round-trip invariant over representable CanonicalBookings (including leap years, unicode names, 0.01 cents)
   * 2. Zero silent data loss: custom unmapped partner fields survive round-trip in `unmappedMetadata`.
   */
  static verifyProperties(adapter: PartnerAdapter, spec: MappingSpec): StageResult {
    const start = Date.now();
    const diagnostics: StageDiagnostic[] = [];

    // Restrict generated statuses to those representable by the partner if statusLossy is true
    const representableStatuses: CanonicalBooking['status'][] = spec.statusLossy
      ? ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED']
      : ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'];

    const bookingArbitrary = fc.record({
      id: fc.uuid(),
      tenantId: fc.constant('unassigned'),
      propertyId: fc.stringMatching(/^[a-zA-Z0-9_-]{3,16}$/),
      unitId: fc.stringMatching(/^[a-zA-Z0-9_-]{2,12}$/),
      // Generate realistic First + Last name with Unicode characters
      guestName: fc
        .tuple(
          fc.stringMatching(/^[A-Za-zÀ-ÿ]{2,12}$/),
          fc.stringMatching(/^[A-Za-zÀ-ÿ]{2,12}$/)
        )
        .map(([first, last]) => `${first} ${last}`),
      guestEmail: fc.option(fc.emailAddress(), { nil: null }),
      checkIn: fc.constantFrom('2026-02-28', '2028-02-29', '2026-11-01', '2026-12-31'), // Includes leap day 2028-02-29
      checkOut: fc.constantFrom('2026-03-05', '2028-03-02', '2026-11-15', '2027-01-05'),
      status: fc.constantFrom(...representableStatuses),
      totalAmount: fc.integer({ min: 1, max: 9999999 }).map((cents) => Number((cents / 100).toFixed(2))),
      currency: fc.constantFrom('USD', 'EUR', 'EGP', 'GBP', 'AED'),
      unmappedMetadata: fc.constant({
        '$.custom_partner_flag': 'preserve_me',
        '$.extra_cleaning_fee': 45,
      }),
    });

    try {
      fc.assert(
        fc.property(bookingArbitrary, (canonicalInput) => {
          const externalPayload = adapter.fromCanonical(canonicalInput, {
            connectionId: 'prop-test',
            tenantId: 't-1',
          });
          const roundTripped = adapter.toCanonical(externalPayload).data as CanonicalBooking & {
            unmappedMetadata?: Record<string, unknown>;
          };

          // 1. Check all core canonical business fields
          for (const field of this.CORE_FIELDS) {
            if (roundTripped[field] !== canonicalInput[field]) {
              throw new Error(
                `Round-trip mismatch on "${field}": input=${JSON.stringify(canonicalInput[field])}, output=${JSON.stringify(roundTripped[field])}`
              );
            }
          }

          // 2. Check zero silent data loss on unmapped fields
          if (
            roundTripped.unmappedMetadata?.['$.custom_partner_flag'] !== 'preserve_me' ||
            roundTripped.unmappedMetadata?.['$.extra_cleaning_fee'] !== 45
          ) {
            throw new Error(
              `Unmapped fields dropped during round-trip: ${JSON.stringify(roundTripped.unmappedMetadata)}`
            );
          }

          return true;
        }),
        { numRuns: 200 }
      );
    } catch (err: any) {
      diagnostics.push({
        stage: 'PROPERTY',
        code: 'PROPERTY_COUNTEREXAMPLE',
        message: err.message,
        counterexample: err.counterexample,
      });
    }

    return {
      stage: 'PROPERTY',
      passed: diagnostics.length === 0,
      durationMs: Date.now() - start,
      diagnostics,
    };
  }

  /**
   * Stage 6: Cryptographic Webhook Test Vector Verifier
   * Verifies both positive (valid HMAC passes) and negative (tampered signature fails) cases.
   */
  static verifyWebhookVector(adapter: PartnerAdapter, vector?: WebhookTestVector): StageResult {
    const start = Date.now();
    const diagnostics: StageDiagnostic[] = [];

    if (!vector) {
      diagnostics.push({
        stage: 'WEBHOOK',
        code: 'WEBHOOK_VECTOR_MISSING',
        message: 'No webhook test vector supplied; verifyWebhook cannot be cryptographically verified.',
      });
      return { stage: 'WEBHOOK', passed: false, durationMs: Date.now() - start, diagnostics };
    }

    try {
      const rawBuf = Buffer.from(vector.rawBody, 'utf8');
      const parsedBody = JSON.parse(vector.rawBody);

      // 1. Valid vector must return expectedValid (true)
      const actualValid = adapter.verifyWebhook(vector.headers, rawBuf, vector.secret);
      if (actualValid !== vector.expectedValid) {
        diagnostics.push({
          stage: 'WEBHOOK',
          code: 'WEBHOOK_SIG_MISMATCH',
          message: `verifyWebhook returned ${actualValid} on valid test vector (expected ${vector.expectedValid})`,
          expected: vector.expectedValid,
          actual: actualValid,
        });
      }

      // 2. Tampered secret MUST return false (guards against `return true` hallucination!)
      const tamperedCheck = adapter.verifyWebhook(vector.headers, rawBuf, 'wrong_secret_key_000');
      if (tamperedCheck !== false) {
        diagnostics.push({
          stage: 'WEBHOOK',
          code: 'WEBHOOK_ACCEPTS_FORGERY',
          message: 'CRITICAL: verifyWebhook returned true for a tampered secret key!',
        });
      }

      // 3. Verify extractEventId
      const extractedId = adapter.extractEventId(parsedBody, vector.headers);
      if (extractedId !== vector.expectedEventId) {
        diagnostics.push({
          stage: 'WEBHOOK',
          code: 'WEBHOOK_EVENT_ID_MISMATCH',
          message: `extractEventId returned "${extractedId}", expected "${vector.expectedEventId}"`,
          expected: vector.expectedEventId,
          actual: extractedId,
        });
      }
    } catch (err: any) {
      diagnostics.push({
        stage: 'WEBHOOK',
        code: 'WEBHOOK_RUNTIME_ERROR',
        message: `Webhook verification threw error: ${err.message}`,
      });
    }

    return {
      stage: 'WEBHOOK',
      passed: diagnostics.length === 0,
      durationMs: Date.now() - start,
      diagnostics,
    };
  }
}