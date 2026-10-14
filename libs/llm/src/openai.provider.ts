import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  calculateCostUsd,
} from './provider.interface';

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    readonly modelName: string = process.env.FORGE_LLM_MODEL || 'gpt-4o',
    private readonly apiKey: string = process.env.OPENAI_API_KEY || '',
    private readonly baseUrl: string = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ) {}

  async completeJson(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const start = Date.now();

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        temperature: req.temperature ?? 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`LLM Provider HTTP ${response.status}: ${errBody}`);
    }

    const data = (await response.json()) as any;
    const rawJsonText = data.choices?.[0]?.message?.content || '{}';
    const tokensIn = data.usage?.prompt_tokens || 0;
    const tokensOut = data.usage?.completion_tokens || 0;

    return {
      rawJsonText,
      model: this.modelName,
      tokensIn,
      tokensOut,
      costUsd: calculateCostUsd(this.modelName, tokensIn, tokensOut),
      latencyMs: Date.now() - start,
    };
  }
}