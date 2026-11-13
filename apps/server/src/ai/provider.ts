// The model providers an agent can decide with, behind one small interface. NEAR AI Cloud and SERV
// Reasoning both speak the OpenAI chat format (POST {base}/chat/completions with a Bearer key), so
// plain fetch is enough and no SDK is pinned. Server-side only: keys never leave here, and an error
// carries the provider, the HTTP status and the request id, never a key.

export type ProviderName = 'nearai' | 'serv';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormat?: Record<string, unknown>;
}

export interface ChatReply {
  content: string;
  usage: Usage | null;
}

export interface Pricing {
  /** USD per million tokens. */
  input: number;
  output: number;
}

export interface InferenceProvider {
  readonly name: ProviderName;
  /** The provider's name for logs. */
  readonly label: string;
  /** The main model: weekly reflections, and hard days where `mainOnHardDays`. */
  readonly model: string;
  /** The cheap model: the other decisions. */
  readonly cheapModel: string;
  /** Hard days (a crash, a glut, a struggling agent) go to the main model; else to the cheap one. */
  readonly mainOnHardDays: boolean;
  /** Least time between two calls, in ms. */
  readonly minGapMs: number;
  /** Prompt tokens the provider adds to every call on its own (billed, not sent by us). */
  readonly overheadTokens: number;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatReply>;
  /** Per-million-token prices the provider publishes, for the spend caps; empty when it does not say. */
  pricing(): Promise<Map<string, Pricing>>;
}

/**
 * Why a call failed, which decides how long its provider is skipped: refused (401, 402 or 403: a bad
 * key or no credits), rate (429), down (5xx, a timeout or no connection), bad-request (any other
 * 4xx), unusable (an answer with no message in it).
 */
export type FailureKind = 'refused' | 'rate' | 'down' | 'bad-request' | 'unusable';

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: FailureKind,
    /** The HTTP status, or null when there was no answer (a timeout or no connection). */
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function failureKind(status: number): FailureKind {
  if (status === 401 || status === 402 || status === 403) return 'refused';
  if (status === 429) return 'rate';
  if (status >= 500) return 'down';
  return 'bad-request';
}

/** Any error from a provider call as a ProviderError (anything unexpected counts as down). */
export function asProviderError(provider: ProviderName, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(provider, 'down', null, err instanceof Error ? err.message : String(err));
}

/** One chat completion over fetch. Throws a ProviderError on anything but an answer with content. */
export async function postChat(a: {
  provider: ProviderName;
  label: string;
  fetchImpl: typeof fetch;
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<ChatReply> {
  let res: Response;
  try {
    res = await a.fetchImpl(a.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(a.body),
      signal: AbortSignal.timeout(a.timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProviderError(a.provider, 'down', null, `${a.label} ${timedOut ? `timed out after ${Math.round(a.timeoutMs / 1000)} s` : 'could not be reached'}`);
  }
  if (!res.ok) throw new ProviderError(a.provider, failureKind(res.status), res.status, `${a.label} ${res.status} (request ${res.headers.get('x-request-id') ?? 'unknown'})`);
  let body: { choices?: { message?: { content?: string | null } }[]; usage?: Usage };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new ProviderError(a.provider, 'down', null, `${a.label} timed out while answering`);
    throw new ProviderError(a.provider, 'unusable', res.status, `${a.label} answered with no JSON`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new ProviderError(a.provider, 'unusable', res.status, `${a.label} returned no message content`);
  return { content, usage: body.usage ?? null };
}
