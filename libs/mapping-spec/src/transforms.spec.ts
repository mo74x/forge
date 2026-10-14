import { MappingSpecSchema } from './schema';
import { applyTransform, extractUnmappedMetadata } from './transforms';
import * as cloudbedsSpecJson from '../../../fixtures/cloudbeds/cloudbeds.reference-spec.json';

describe('MappingSpec & Audited Transform Library', () => {
  it('validates the reference Cloudbeds MappingSpec with zero errors', () => {
    const parsed = MappingSpecSchema.safeParse(cloudbedsSpecJson);
    expect(parsed.success).toBe(true);
  });

  it('transforms centsToDecimal and decimalToCents accurately without float drift', () => {
    expect(applyTransform(145099, {}, { kind: 'centsToDecimal', scale: 2 })).toBe(1450.99);
    expect(applyTransform(1450.99, {}, { kind: 'decimalToCents', scale: 2 })).toBe(145099);
  });

  it('transforms {y,m,d} objects to YYYY-MM-DD and back', () => {
    const iso = applyTransform(
      { y: 2026, m: 11, d: 5 },
      {},
      { kind: 'ymdObjectToIso', yearKey: 'y', monthKey: 'm', dayKey: 'd' }
    );
    expect(iso).toBe('2026-11-05');

    const ymd = applyTransform(
      '2026-11-05',
      {},
      { kind: 'isoToYmdObject', yearKey: 'y', monthKey: 'm', dayKey: 'd' }
    );
    expect(ymd).toEqual({ y: 2026, m: 11, d: 5 });
  });

  it('captures unmapped partner fields while automatically redacting sensitive keys', () => {
    const rawPartnerPayload = {
      reservation_id: 'res_1',
      total_cents: 50000,
      has_pet_fee: true,
      late_checkout_requested: '14:00',
      door_pin_code: '9942', // Sensitive: matches /pin/i
      guest_credit_card_token: 'tok_xyz', // Sensitive: matches /card/i and /token/i
    };

    const mappedPaths = new Set(['$.reservation_id', '$.total_cents']);
    const unmapped = extractUnmappedMetadata(rawPartnerPayload, mappedPaths);

    expect(unmapped).toEqual({
      '$.has_pet_fee': true,
      '$.late_checkout_requested': '14:00',
    });
    // Sensitive fields must NEVER leak into unmappedMetadata or prompts
    expect(unmapped['$.door_pin_code']).toBeUndefined();
    expect(unmapped['$.guest_credit_card_token']).toBeUndefined();
  });
});