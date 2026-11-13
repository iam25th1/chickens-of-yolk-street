// SERV Reasoning (OpenServ), the second provider in the chain: tried when NEAR AI Cloud fails, has no
// key or is paused. OpenAI-compatible (POST {base}/chat/completions with a Bearer key), with three
// differences from NEAR AI that matter here: every request must carry a system message (else 400),
// the reply cap is max_completion_tokens, and reasoning_effort (none, low, medium, high) sets how much
// hidden reasoning a model may bill for. Strict json_schema response formats work as they are.
// Server-side only: the key never leaves here.
import { postChat, type ChatMessage, type ChatOptions, type ChatReply, type InferenceProvider, type Pricing } from './provider';

export const SERV_DEFAULT_BASE_URL = 'https://inference-api.openserv.ai/v1';
/** The main model: weekly reflections. */
export const SERV_DEFAULT_MODEL = 'gpt-5.4-mini';
/** The cheap model: every decision, hard days too (the main one costs about eight times as much). */
export const SERV_DEFAULT_CHEAP_MODEL = 'gpt-6-luna';
export const SERV_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type ServReasoningEffort = (typeof SERV_REASONING_EFFORTS)[number];

/**
 * SERV's published prices, USD per million tokens (input, output), from docs.openserv.ai/serv-reasoning.
 * Its answers carry token counts but no cost, so these are what the spend caps charge. Confirm them
 * in the OpenServ console (Usage) and override with SERV_MAIN_PRICE and SERV_CHEAP_PRICE if they move.
 */
export const SERV_PRICES: Readonly<Record<string, Pricing>> = {
  'gpt-6-luna': { input: 0.13, output: 0.65 },
  'gpt-5.6-luna': { input: 0.25, output: 1.5 },
  'gpt-5.4-nano': { input: 0.25, output: 1.6 },
  'gemini-3.1-flash-lite': { input: 0.3, output: 1.8 },
  'gpt-5.4-mini': { input: 1, output: 6 },
  'claude-haiku-4.5': { input: 1.25, output: 6.5 },
};

export interface ServConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  cheapModel?: string;
  reasoningEffort?: ServReasoningEffort;
  fetchImpl?: typeof fetch;
}

export class ServClient implements InferenceProvider {
  readonly name = 'serv' as const;
  readonly label = 'SERV Reasoning';
  readonly model: string;
  readonly cheapModel: string;
  readonly mainOnHardDays = false;
  /** Rate limits are not published: one call a second at most. */
  readonly minGapMs = 1000;
  /** SERV bills about 200 prompt tokens of its own on every call (a 5-token prompt was billed about 200). */
  readonly overheadTokens = 200;
  readonly reasoningEffort: ServReasoningEffort;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ServConfig) {
    this.baseUrl = (cfg.baseUrl || SERV_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = cfg.model || SERV_DEFAULT_MODEL;
    this.cheapModel = cfg.cheapModel || SERV_DEFAULT_CHEAP_MODEL;
    this.reasoningEffort = cfg.reasoningEffort ?? 'none';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatReply> {
    // a request without a system message is refused (400): give it a plain one
    const withSystem: ChatMessage[] = messages.some((m) => m.role === 'system') ? messages : [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages];
    return postChat({
      provider: this.name,
      label: this.label,
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}/chat/completions`,
      apiKey: this.cfg.apiKey,
      body: {
        model: opts.model ?? this.model,
        messages: withSystem,
        max_completion_tokens: opts.maxTokens ?? 1024,
        reasoning_effort: this.reasoningEffort,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      },
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
  }

  /** SERV publishes no price list over its API: the published prices above. */
  pricing(): Promise<Map<string, Pricing>> {
    return Promise.resolve(new Map(Object.entries(SERV_PRICES)));
  }
}
