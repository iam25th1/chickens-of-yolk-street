// NEAR AI Cloud client. The API is OpenAI-compatible (POST {base}/chat/completions with a Bearer
// key), so plain fetch is enough and no SDK is pinned. Server-side only: the key never leaves here.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NearAiConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export const NEARAI_DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';
/** Open-weight, TEE-hosted, supports structured outputs (checked against /v1/models). */
export const NEARAI_DEFAULT_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
/** Cheaper model for agents that are struggling. */
export const NEARAI_DEFAULT_CHEAP_MODEL = 'z-ai/glm-5.3-flash';

export class NearAiClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: NearAiConfig) {
    this.baseUrl = (cfg.baseUrl || NEARAI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = cfg.model || NEARAI_DEFAULT_MODEL;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async chat(
    messages: ChatMessage[],
    opts: { model?: string; maxTokens?: number; timeoutMs?: number; responseFormat?: Record<string, unknown> } = {},
  ): Promise<{ content: string; usage: Usage | null }> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? this.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0.4,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status} (request ${res.headers.get('x-request-id') ?? 'unknown'})`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: Usage };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('NEAR AI Cloud returned no message content');
    return { content, usage: body.usage ?? null };
  }

  /** Per-million-token prices from /v1/models, for the spend cap. */
  async pricing(): Promise<Map<string, { input: number; output: number }>> {
    const out = new Map<string, { input: number; output: number }>();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.cfg.apiKey}` }, signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { data?: { id: string; pricing?: { input?: number; output?: number } }[] };
      for (const m of body.data ?? []) if (m.pricing) out.set(m.id, { input: Number(m.pricing.input ?? 1), output: Number(m.pricing.output ?? 5) });
    } catch {
      // keep the defaults in the brain
    }
    return out;
  }
}
