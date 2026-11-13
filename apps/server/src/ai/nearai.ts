// NEAR AI Cloud, the first provider in the chain. The API is OpenAI-compatible (POST
// {base}/chat/completions with a Bearer key), so plain fetch is enough and no SDK is pinned.
// Server-side only: the key never leaves here.
import { postChat, type ChatMessage, type ChatOptions, type ChatReply, type InferenceProvider, type Pricing } from './provider';

export type { ChatMessage, Usage } from './provider';

export interface NearAiConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  cheapModel?: string;
  fetchImpl?: typeof fetch;
}

export const NEARAI_DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';
/** Open-weight, TEE-hosted, supports structured outputs (checked against /v1/models). */
export const NEARAI_DEFAULT_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
/** The cheaper model, for every decision that is not on a hard day. */
export const NEARAI_DEFAULT_CHEAP_MODEL = 'z-ai/glm-5.3-flash';

export class NearAiClient implements InferenceProvider {
  readonly name = 'nearai' as const;
  readonly label = 'NEAR AI Cloud';
  readonly model: string;
  readonly cheapModel: string;
  /** Its two models are close in price, so hard days get the main one. */
  readonly mainOnHardDays = true;
  readonly minGapMs = 0;
  readonly overheadTokens = 0;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: NearAiConfig) {
    this.baseUrl = (cfg.baseUrl || NEARAI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = cfg.model || NEARAI_DEFAULT_MODEL;
    this.cheapModel = cfg.cheapModel || NEARAI_DEFAULT_CHEAP_MODEL;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatReply> {
    return postChat({
      provider: this.name,
      label: this.label,
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}/chat/completions`,
      apiKey: this.cfg.apiKey,
      body: {
        model: opts.model ?? this.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0.4,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      },
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
  }

  /** Per-million-token prices from /v1/models, for the spend cap. */
  async pricing(): Promise<Map<string, Pricing>> {
    const out = new Map<string, Pricing>();
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
