import * as crypto from 'crypto';
import { OnboardingOrchestrator } from './orchestrator';
import { LlmCompletionRequest, LlmCompletionResponse, LlmProvider } from '@lattice/llm';
import * as cloudbedsSpecJson from '../../../fixtures/cloudbeds/cloudbeds.reference-spec.json';

class SimulatedRepairLlmProvider implements LlmProvider {
  readonly modelName = 'gpt-4o';
  public callCount = 0;
  public promptsReceived: string[] = [];

  async completeJson(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.callCount++;
    this.promptsReceived.push(req.userPrompt);

    if (this.callCount === 1) {
      // Attempt 1: Model makes a classic mistake — uses 'identity' on total_cents instead of 'centsToDecimal'
      const buggySpec = JSON.parse(JSON.stringify(cloudbedsSpecJson));
      const amountField = buggySpec.fields.find((f: any) => f.canonicalField === 'totalAmount');
      amountField.transform = { kind: 'identity' };

      return {
        rawJsonText: JSON.stringify(buggySpec),
        model: this.modelName,
        tokensIn: 1200,
        tokensOut: 650,
        costUsd: 0.0095,
        latencyMs: 850,
      };
    }

    // Attempt 2: Model receives GOLDEN_FIELD_MISMATCH diagnostic and fixes transform to 'centsToDecimal'
    return {
      rawJsonText: JSON.stringify(cloudbedsSpecJson),
      model: this.modelName,
      tokensIn: 1450,
      tokensOut: 660,
      costUsd: 0.0102,
      latencyMs: 790,
    };
  }
}

describe('Phase 4: Bounded Self-Repair Loop Orchestrator', () => {
  const rawSample = {
    reservation_id: 'cb_501',
    property_id: 'prop_1',
    room_identifier: 'room_9',
    guest_first_name: 'Karim',
    guest_last_name: 'Adel',
    guest_email: 'karim@example.com',
    start_date: '2026-11-01T00:00:00Z',
    end_date: '2026-11-05T00:00:00Z',
    booking_status: 'reserved',
    total_cents: 85000,
    currency_code: 'usd',
    modified_at: '2026-10-14T10:00:00Z',
    door_pin_code: '1234', // Sensitive field
  };

  const expectedCanonical = {
    tenantId: 'unassigned',
    propertyId: 'prop_1',
    unitId: 'room_9',
    guestName: 'Karim Adel',
    guestEmail: 'karim@example.com',
    checkIn: '2026-11-01',
    checkOut: '2026-11-05',
    status: 'CONFIRMED' as const,
    totalAmount: 850,
    currency: 'USD',
  };

  it('catches Attempt 1 money scale error in Stage 3, auto-repairs on Attempt 2, and redacts sensitive fields', async () => {
    const mockLlm = new SimulatedRepairLlmProvider();
    const secret = 'whsec_forge_1';
    const timestamp = '1760440000';
    const rawBody = JSON.stringify(rawSample);
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    const result = await OnboardingOrchestrator.executeRun({
      provider: 'cloudbeds_mock',
      trainingFixtures: [
        {
          sampleId: 'sample-1',
          label: 'standard',
          isHeldOut: false,
          rawPartnerPayload: rawSample,
          expectedCanonical,
        },
      ],
      heldOutFixtures: [],
      webhookVector: {
        rawBody,
        secret,
        headers: {
          'x-cloudbeds-signature': sig,
          'x-cloudbeds-timestamp': timestamp,
          'x-event-id': 'evt_501',
        },
        expectedValid: true,
        expectedEventId: 'evt_501',
      },
      llm: mockLlm,
    });

    // 1. Verify sensitive pin code was NEVER sent in the LLM prompt
    expect(mockLlm.promptsReceived[0]).toContain('[REDACTED_BY_FORGE]');
    expect(mockLlm.promptsReceived[0]).not.toContain('1234');

    // 2. Verify Attempt 1 failed on GOLDEN stage due to totalAmount (85000 vs 850)
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].passed).toBe(false);
    expect(result.attempts[0].failedStage).toBe('GOLDEN');
    expect(mockLlm.promptsReceived[1]).toContain('GOLDEN_FIELD_MISMATCH');
    expect(mockLlm.promptsReceived[1]).toContain('totalAmount');

    // 3. Verify Attempt 2 succeeded across all 6 stages
    expect(result.attempts[1].passed).toBe(true);
    expect(result.status).toBe('READY_FOR_REVIEW');
    expect(result.verificationReport?.allPassed).toBe(true);
  });
});