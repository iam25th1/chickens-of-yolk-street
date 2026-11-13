// The provider chain: NEAR AI Cloud first, then SERV Reasoning, then the rules (in the brain). Each
// provider has a breaker held in memory: a refusal (401, 402 or 403: a bad key or no credits) skips
// it for 30 minutes, a 429 backs off from 30 seconds doubling to 10 minutes, and a 5xx, a timeout or
// a bad request skips it for 2 minutes doubling to 30. A breaker reports only its changes (paused,
// paused for a new reason, answering again), never each skipped call. Calls to one provider are
// spaced by its own gap, and all model calls of one day close share a time budget, after which the
// agents still waiting use their rules that day. Clocks here are real time, not the game's.
import type { FailureKind, InferenceProvider, ProviderError, ProviderName } from './provider';

export const PAUSE_MS = {
  refused: 30 * 60_000,
  rate: { first: 30_000, max: 10 * 60_000 },
  down: { first: 2 * 60_000, max: 30 * 60_000 },
} as const;

/** Default time budget for all model calls of one day close (LLM_CLOSE_BUDGET_SECONDS). */
export const CLOSE_BUDGET_MS = 60_000;
/** Longest one call may take. */
export const CALL_TIMEOUT_MS = 20_000;

export interface ProviderStatus {
  /** off: no key. ready: may be called. answering: its last call answered. paused: skipped for now. */
  state: 'off' | 'ready' | 'answering' | 'paused';
  /** The HTTP status of its latest failure (null for a timeout), while it is failing. */
  lastStatus?: number | null;
  /** Seconds until it is tried again, while paused. */
  retryInS?: number;
}

const pauseFor = (kind: FailureKind, strikes: number): number => {
  if (kind === 'refused') return PAUSE_MS.refused;
  const p = kind === 'rate' ? PAUSE_MS.rate : PAUSE_MS.down;
  return Math.min(p.max, p.first * 2 ** Math.max(0, strikes - 1));
};

const minutes = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

const WHY: Record<FailureKind, string> = {
  refused: 'refused (a bad key or no credits)',
  rate: 'rate limited',
  down: 'down or slow',
  'bad-request': 'refused the request',
  unusable: 'answered with nothing usable',
};

class Breaker {
  private until = 0;
  private strikes = 0;
  private last: { kind: FailureKind; status: number | null } | null = null;
  answered = false;

  isOpen(now: number): boolean {
    return now < this.until;
  }

  /** Records a failure and returns the log line when this is a change worth one. */
  fail(label: string, err: ProviderError, now: number): string | null {
    const same = this.last !== null && this.last.kind === err.kind && this.last.status === err.status;
    this.strikes = same ? this.strikes + 1 : 1;
    this.answered = false;
    // an answer with nothing usable in it is about that one request: no pause
    const pause = err.kind === 'unusable' ? 0 : pauseFor(err.kind, this.strikes);
    this.until = now + pause;
    const changed = !same;
    this.last = { kind: err.kind, status: err.status };
    if (!changed || pause === 0) return null;
    return `[ai] ${label} ${WHY[err.kind]}${err.status ? ` (HTTP ${err.status})` : ''}: skipped for ${minutes(pause)}, then tried again; the next provider or the rules decide meanwhile`;
  }

  /** Records an answer and returns the log line when the provider was failing. */
  succeed(label: string): string | null {
    const was = this.last;
    this.strikes = 0;
    this.until = 0;
    this.last = null;
    this.answered = true;
    return was ? `[ai] ${label} is answering again` : null;
  }

  status(now: number): ProviderStatus {
    if (this.isOpen(now)) return { state: 'paused', lastStatus: this.last?.status ?? null, retryInS: Math.ceil((this.until - now) / 1000) };
    if (this.answered) return { state: 'answering' };
    return this.last ? { state: 'ready', lastStatus: this.last.status } : { state: 'ready' };
  }

  /** Refused (a bad key or no credits) and not yet answering again. */
  refused(): boolean {
    return this.last?.kind === 'refused';
  }
}

export interface ChainOptions {
  /** Real time in ms (tests pass their own). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Most time all model calls of one day close may take together, in ms. */
  closeBudgetMs?: number;
}

export class ProviderChain {
  readonly providers: readonly InferenceProvider[];
  readonly closeBudgetMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly breakers = new Map<ProviderName, Breaker>();
  private readonly lastCallAt = new Map<ProviderName, number>();
  private deadline = Infinity;
  private outOfTimeSaid = false;
  /** The UTC day the shared spend cap was reached on, if it was. */
  capReachedOn: string | null = null;
  /** When the daily AI spend line was last logged (real ms). */
  spendLoggedAt = -Infinity;

  constructor(providers: readonly InferenceProvider[], opts: ChainOptions = {}) {
    this.providers = providers;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.closeBudgetMs = opts.closeBudgetMs ?? CLOSE_BUDGET_MS;
    for (const p of providers) this.breakers.set(p.name, new Breaker());
  }

  now(): number {
    return this.clock();
  }

  /** True when any provider has a key. */
  get configured(): boolean {
    return this.providers.length > 0;
  }

  /** The providers to try now, in order: every one with a key that is not paused. */
  ready(): InferenceProvider[] {
    const now = this.clock();
    return this.providers.filter((p) => !this.breakers.get(p.name)?.isOpen(now));
  }

  /** A provider that has a key and was not refused (a bad key or no credits) since it last answered. */
  usable(name: string): boolean {
    const b = this.breakers.get(name as ProviderName);
    return b !== undefined && !b.refused();
  }

  /** Starts a day close's time budget. */
  beginClose(): void {
    this.deadline = this.clock() + this.closeBudgetMs;
    this.outOfTimeSaid = false;
  }

  /** Ends it: calls made outside a day close have no budget but their own timeouts. */
  endClose(): void {
    this.deadline = Infinity;
  }

  /** Time left in this day close's budget, in ms. */
  timeLeft(): number {
    return this.deadline - this.clock();
  }

  /** The log line for a spent close budget, once per close. */
  outOfTime(): string | null {
    if (this.outOfTimeSaid) return null;
    this.outOfTimeSaid = true;
    return `[ai] this day close's model time (${Math.round(this.closeBudgetMs / 1000)} s) is spent: the agents still to decide use their rules today`;
  }

  /** Waits until a call to this provider keeps its gap from the one before, and marks the call started. */
  async pace(p: InferenceProvider): Promise<void> {
    const last = this.lastCallAt.get(p.name);
    const wait = last === undefined ? 0 : last + p.minGapMs - this.clock();
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt.set(p.name, this.clock());
  }

  succeeded(p: InferenceProvider): string | null {
    return this.breakers.get(p.name)?.succeed(p.label) ?? null;
  }

  failed(p: InferenceProvider, err: ProviderError): string | null {
    return this.breakers.get(p.name)?.fail(p.label, err, this.clock()) ?? null;
  }

  /** Each provider's state, for /healthz: never a key. */
  status(): Record<ProviderName, ProviderStatus> {
    const now = this.clock();
    const out: Record<ProviderName, ProviderStatus> = { nearai: { state: 'off' }, serv: { state: 'off' } };
    for (const p of this.providers) out[p.name] = this.breakers.get(p.name)?.status(now) ?? { state: 'off' };
    return out;
  }
}
