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

export const NEARAI_DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';
export const NEARAI_DEFAULT_MODEL = 'zai-org/GLM-5.1-FP8';

export class NearAiClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: NearAiConfig) {
    this.baseUrl = (cfg.baseUrl || NEARAI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = cfg.model || NEARAI_DEFAULT_MODEL;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, max_tokens: opts.maxTokens ?? 1024, temperature: 0.4 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status} (request ${res.headers.get('x-request-id') ?? 'unknown'})`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('NEAR AI Cloud returned no message content');
    return content;
  }
}
