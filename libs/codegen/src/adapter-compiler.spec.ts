import { AdapterCompiler } from './adapter-compiler';
import { MappingSpecSchema } from '@lattice/mapping-spec';
import { QuirkDetector } from '@lattice/inference';
import * as cloudbedsSpecJson from '../../../fixtures/cloudbeds/cloudbeds.reference-spec.json';

describe('Phase 2: Deterministic Inference & Codegen Compiler', () => {
  const samplePayloads = [
    {
      reservation_id: 'cb_901',
      property_id: 'prop_cairo_1',
      room_identifier: 'apt_12',
      guest_first_name: 'Omar',
      guest_last_name: 'Sharif',
      guest_email: 'omar@example.com',
      start_date: '2026-12-01T00:00:00Z',
      end_date: '2026-12-10T00:00:00Z',
      booking_status: 'reserved',
      total_cents: 125000,
      currency_code: 'usd',
      modified_at: '2026-10-14T12:00:00Z',
      vip_late_checkout: true,
      smart_lock_pin: '4412', // Should be detected as sensitive!
    },
  ];

  it('deterministically detects date, money, and sensitive quirks without an LLM', () => {
    const profiles = QuirkDetector.analyzeSamples(samplePayloads);

    expect(profiles.get('$.total_cents')?.quirk).toBe('INTEGER_CENTS');
    expect(profiles.get('$.start_date')?.quirk).toBe('ISO_DATE_STRING');
    expect(profiles.get('$.guest_email')?.quirk).toBe('EMAIL_STRING');
    expect(profiles.get('$.smart_lock_pin')?.sensitive).toBe(true);
    expect(profiles.get('$.smart_lock_pin')?.distinctValues).toEqual(['[REDACTED]']);
  });

  it('compiles a MappingSpec into deterministic TypeScript code (snapshot invariant)', async () => {
    const spec = MappingSpecSchema.parse(cloudbedsSpecJson);

    const run1 = await AdapterCompiler.compile(spec);
    const run2 = await AdapterCompiler.compile(spec);

    // Byte-for-byte identical output guarantee
    expect(run1.adapterCode).toBe(run2.adapterCode);
    expect(run1.hasCustomEscapeHatch).toBe(false);
    expect(run1.adapterCode).toContain('export class CloudbedsMockAdapter');
    expect(run1.adapterCode).toContain('crypto.timingSafeEqual');
  });

  it('safely escapes webhook strings and prevents template string code injection (G1)', async () => {
    const maliciousHeaderSpec = MappingSpecSchema.parse({
      ...cloudbedsSpecJson,
      webhook: {
        algorithm: 'hmac-sha256',
        signatureHeader: "x-sig'; console.log('hacked'); //",
        timestampHeader: "x-ts'; process.exit(1); //",
        eventIdSource: {
          location: 'header',
          keyOrPath: "x-id'; evil(); //",
        },
        timestampSource: {
          location: 'header',
          keyOrPath: "x-ts'; evil(); //",
          format: 'EPOCH_SECONDS',
        },
      },
    });

    const compiledHeader = await AdapterCompiler.compile(maliciousHeaderSpec);
    // Malicious quotes should be properly escaped inside JSON string literals and not unescaped raw syntax
    expect(compiledHeader.adapterCode).toContain(
      JSON.stringify("x-sig'; console.log('hacked'); //")
    );
    expect(compiledHeader.adapterCode).not.toContain("headers['x-sig';");

    const maliciousBodySpec = MappingSpecSchema.parse({
      ...cloudbedsSpecJson,
      webhook: {
        algorithm: 'hmac-sha1-body',
        bodySignatureKey: "sig'; malicious(); //",
        eventIdSource: {
          location: 'body',
          keyOrPath: "$.event_id'; malicious(); //",
        },
        timestampSource: {
          location: 'body',
          keyOrPath: "$.timestamp'; malicious(); //",
          format: 'EPOCH_SECONDS',
        },
      },
    });

    const compiledBody = await AdapterCompiler.compile(maliciousBodySpec);
    expect(compiledBody.adapterCode).toContain(
      JSON.stringify("sig'; malicious(); //")
    );
    expect(compiledBody.adapterCode).toContain(
      JSON.stringify("$.event_id'; malicious(); //")
    );
    expect(compiledBody.adapterCode).not.toContain("parsed['sig';");
  });
});