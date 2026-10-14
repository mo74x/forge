import * as crypto from 'crypto';
import { MappingSpecSchema } from '@lattice/mapping-spec';
import { MutationTestingSuite } from './mutation-suite';
import * as cloudbedsSpecJson from '../../fixtures/cloudbeds/cloudbeds.reference-spec.json';

describe('Verifier-of-Verifiers (Mutation Testing Suite)', () => {
  const rawSample = {
    reservation_id: 'cb_700',
    property_id: 'prop_alex_1',
    room_identifier: 'chalet_3',
    guest_first_name: 'Tarek',
    guest_last_name: 'Mansour',
    guest_email: 'tarek@example.com',
    start_date: '2026-11-10T00:00:00Z',
    end_date: '2026-11-15T00:00:00Z',
    booking_status: 'reserved',
    total_cents: 64000,
    currency_code: 'usd',
    modified_at: '2026-10-14T15:00:00Z',
  };

  const expectedCanonical = {
    tenantId: 'unassigned',
    propertyId: 'prop_alex_1',
    unitId: 'chalet_3',
    guestName: 'Tarek Mansour',
    guestEmail: 'tarek@example.com',
    checkIn: '2026-11-10',
    checkOut: '2026-11-15',
    status: 'CONFIRMED' as const,
    totalAmount: 640,
    currency: 'USD',
  };

  it('catches 8 out of 8 (100%) injected faults across all 6 verification stages', async () => {
    const baseSpec = MappingSpecSchema.parse(cloudbedsSpecJson);
    const secret = 'whsec_mut_test';
    const timestamp = '1760450000';
    const rawBody = JSON.stringify(rawSample);
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    const report = await MutationTestingSuite.runSuite({
      baseSpec,
      goldenFixtures: [
        {
          sampleId: 'golden-1',
          label: 'active-booking',
          isHeldOut: false,
          rawPartnerPayload: rawSample,
          expectedCanonical,
        },
      ],
      heldOutFixtures: [
        {
          sampleId: 'holdout-1',
          label: 'voided-booking',
          isHeldOut: true,
          rawPartnerPayload: {
            ...rawSample,
            reservation_id: 'cb_701',
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
          'x-event-id': 'evt_mut_1',
        },
        expectedValid: true,
        expectedEventId: 'evt_mut_1',
      },
    });

    // Every single fault must be caught at its exact designated stage
    for (const r of report.results) {
      expect({ id: r.id, caught: r.caughtCorrectly, actual: r.actualFailedStage }).toEqual({
        id: r.id,
        caught: true,
        actual: r.expectedStage,
      });
    }

    expect(report.totalMutations).toBe(8);
    expect(report.caughtMutations).toBe(8);
    expect(report.catchRate).toBe(1.0);
  });
});