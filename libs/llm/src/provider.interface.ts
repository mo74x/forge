export interface LlmCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface LlmCompletionResponse {
  rawJsonText: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface LlmProvider {
  readonly modelName: string;
  completeJson(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

// Pricing table per 1M tokens for exact benchmark reporting in EvalResult

export const MODEL_PRICING_PER_1M: Record<string, { inUsd: number; outUsd: number }> = {
  'gpt-4o': { inUsd: 2.5, outUsd: 10.0 },
  'gpt-4o-mini': { inUsd: 0.15, outUsd: 0.6 },
  'claude-3-5-sonnet': { inUsd: 3.0, outUsd: 15.0 },
  'mock-deterministic': { inUsd: 0.0, outUsd: 0.0 },
};

export function calculateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const rate = MODEL_PRICING_PER_1M[model] || { inUsd: 2.5, outUsd: 10.0 };
  const cost = (tokensIn / 1_000_000) * rate.inUsd + (tokensOut / 1_000_000) * rate.outUsd;
  return Math.round(cost * 1_000_000) / 1_000_000;
}