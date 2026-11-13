// Agent decisions: the rule strategy on routine days, and a model on the days that matter, through
// the provider chain (NEAR AI Cloud, then SERV Reasoning, then the rules). A model call is made only
// on an agent's first look (no model decision yet, such as a new AI farm's first day), for its weekly
// reflection (the week's strategy), and, at most once in LLM_DECISION_GAP_DAYS in-game days, on a hard
// day (a crash or glut, or its cash under its struggle line) or a price move past LLM_PRICE_MOVE since
// its last model decision. The observation is
// trimmed (the most relevant farms, rounded numbers), replies are capped, and the same prompt to the
// same model within a UTC day reuses its validated decision. Every model reply is structured JSON
// validated against the decision schema; anything unusable (an error, a timeout, a reply that does
// not match) falls back to the rules and is logged. One shared daily cap (UTC day) switches every
// agent to rules until the next day, and per-agent caps (calls, failed ones too, and spend) do the
// same for one agent. Struggling agents sit out every other day to save their decision fee.
import { createHash } from 'node:crypto';
import type { AiMode } from '@coys/shared';
import type { Db } from '../db/db';
import { num } from '../db/db';
import { CALL_TIMEOUT_MS, MIN_CALL_MS, type ProviderChain } from '../ai/chain';
import { NEARAI_DEFAULT_CHEAP_MODEL, NEARAI_DEFAULT_MODEL } from '../ai/nearai';
import { asProviderError, type ChatMessage, type InferenceProvider, type Pricing, type ProviderName } from '../ai/provider';
import { SERV_PRICES } from '../ai/serv';
import { brokeLine, personaFor, personalityFor } from './cast';
import { REASON_MAX, cleanText, decisionJsonSchema, emptyDecision, hardDay, validateDecision, type AgentContext, type Decision, type FarmBrief, type WeekNumbers } from './decision';
import { ruleDecision, ruleReflection } from './rules';

export type { Pricing } from '../ai/provider';

export interface DecisionResult {
  decision: Decision;
  /** Who decided: the rules, a provider, or nobody (a struggling agent sitting the day out). */
  brain: 'rules' | ProviderName | 'skipped';
  model: string | null;
  fallback: boolean;
  /** The model call made and the tokens it used, when one was made (also when its reply was unusable). */
  tokens?: Tokens;
}

export interface ReflectionResult {
  text: string;
  brain: 'rules' | ProviderName;
  model: string | null;
  fallback: boolean;
  tokens?: Tokens;
}

export interface Tokens {
  provider: ProviderName;
  model: string;
  tier: 'main' | 'cheap';
  prompt: number;
  completion: number;
}

/**
 * Prices the server charges each model when nothing else says (USD per million tokens). NEAR AI Cloud
 * did not answer while its two were set (402, no credits), so they are estimates for a small
 * open-weight model and a flash model (NEARAI_MAIN_PRICE and NEARAI_CHEAP_PRICE override them, as
 * /v1/models does when it answers). SERV's are its published prices (ai/serv.ts).
 */
export const ASSUMED_PRICING: Readonly<Record<string, Pricing>> = {
  [NEARAI_DEFAULT_MODEL]: { input: 0.2, output: 0.8 },
  [NEARAI_DEFAULT_CHEAP_MODEL]: { input: 0.1, output: 0.4 },
  ...SERV_PRICES,
};

/** A model with no known price is priced high, so a cap is never crossed by surprise. */
export const UNKNOWN_PRICING: Pricing = { input: 1, output: 5 };

export const priceOf = (pricing: Map<string, Pricing>, model: string): Pricing => pricing.get(model) ?? ASSUMED_PRICING[model] ?? UNKNOWN_PRICING;

/** Characters a token, as the estimates count them (the providers' own counts are recorded when they answer). */
export const CHARS_PER_TOKEN = 4;
/** A call reserves its prompt at half as much again as the estimate, and a full reply, so the caps hold. */
export const RESERVE_MARGIN = 1.5;

/** Most tokens a decision and a reflection may answer with (a live SERV decision took 258, a reflection 55). */
export const DECISION_MAX_TOKENS = 400;
export const REFLECTION_MAX_TOKENS = 200;

/** A model decision is due once the multiplier moved this share since the agent's last one (LLM_PRICE_MOVE). */
export const PRICE_MOVE = 0.15;
/** An agent asks a model at most once in this many in-game days, its first look and weekly reflection aside (LLM_DECISION_GAP_DAYS). */
export const DECISION_GAP_DAYS = 3;
/** Farms an observation lists at most: the most relevant to the agent. */
export const OBSERVED_FARMS = 6;
/** The agents' mode is the provider that answered within this many in-game days (one strategy week). */
export const MODE_WINDOW_DAYS = 7;

/** The decision schema as a strict response format; oneOf becomes anyOf, which strict modes accept (the branches never overlap). */
export const decisionFormat = (): Record<string, unknown> => ({ type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: strictSchema(decisionJsonSchema()) } });

function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    out[k === 'oneOf' ? 'anyOf' : k] = strictSchema(v);
  }
  return out;
}

/** Prompt tokens a call is expected to take: its messages and its response format, and the provider's own overhead. */
export function promptTokens(messages: readonly ChatMessage[], responseFormat: Record<string, unknown> | undefined, overheadTokens: number): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0) + (responseFormat ? JSON.stringify(responseFormat).length : 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + overheadTokens;
}

const chargeFor = (price: Pricing, prompt: number, completion: number): number => (prompt * price.input + completion * price.output) / 1e6;

/** What a call reserves under the caps before it is made: the prompt with its margin, and a full reply. */
export const reserveUsd = (price: Pricing, prompt: number, maxTokens: number): number => chargeFor(price, Math.ceil(prompt * RESERVE_MARGIN), maxTokens);

export interface AgentCap {
  /** Model calls one agent may make per UTC day, failed ones included. */
  calls: number;
  /** USD one agent may spend per UTC day. */
  usd: number;
}

/**
 * Calls one agent may make per UTC day by default, failed ones included: the most the days that
 * matter allow (a decision every LLM_DECISION_GAP_DAYS and a weekly reflection, 480 in-game days a
 * real day, about 230), so it binds only on failed calls and changed settings.
 */
export const AGENT_DAILY_CALLS = 240;

export interface ProviderUsage {
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  spendUsd: number;
}

export class InferenceBudget {
  readonly agentCap: AgentCap;

  constructor(
    private readonly db: Db,
    readonly capUsd: number,
    private readonly now: () => number = Date.now,
    /** Per agent; by default a quarter of the shared cap and AGENT_DAILY_CALLS calls. */
    agentCap: Partial<AgentCap> = {},
  ) {
    this.agentCap = { calls: agentCap.calls ?? AGENT_DAILY_CALLS, usd: agentCap.usd ?? capUsd / 4 };
  }

  /** Today's UTC day, as the caps count days. */
  today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  async usage(): Promise<{ calls: number; failures: number; fallbacks: number; skipped: number; spendUsd: number }> {
    const [r] = await this.db.query('SELECT calls, failures, fallbacks, skipped, spend_micro_usd FROM inference_usage WHERE utc_day = $1', [this.today()]);
    return { calls: num(r?.calls ?? 0), failures: num(r?.failures ?? 0), fallbacks: num(r?.fallbacks ?? 0), skipped: num(r?.skipped ?? 0), spendUsd: num(r?.spend_micro_usd ?? 0) / 1e6 };
  }

  async agentUsage(agentId: string): Promise<{ calls: number; failures: number; fallbacks: number; spendUsd: number }> {
    const [r] = await this.db.query('SELECT calls, failures, fallbacks, spend_micro_usd FROM agent_inference_usage WHERE agent_id = $1 AND utc_day = $2', [agentId, this.today()]);
    return { calls: num(r?.calls ?? 0), failures: num(r?.failures ?? 0), fallbacks: num(r?.fallbacks ?? 0), spendUsd: num(r?.spend_micro_usd ?? 0) / 1e6 };
  }

  /** Today's calls, failures, tokens and spend by provider. */
  async providerUsage(): Promise<Record<ProviderName, ProviderUsage>> {
    const zero = (): ProviderUsage => ({ calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, spendUsd: 0 });
    const out: Record<ProviderName, ProviderUsage> = { nearai: zero(), serv: zero() };
    for (const r of await this.db.query('SELECT * FROM provider_usage WHERE utc_day = $1', [this.today()])) {
      if (r.provider !== 'nearai' && r.provider !== 'serv') continue;
      out[r.provider] = { calls: num(r.calls), failures: num(r.failures), promptTokens: num(r.prompt_tokens), completionTokens: num(r.completion_tokens), spendUsd: num(r.spend_micro_usd) / 1e6 };
    }
    return out;
  }

  /** True while one more call (at its reserve) still fits under the shared cap. */
  async canSpend(estimateUsd = 0): Promise<boolean> {
    return (await this.usage()).spendUsd + estimateUsd <= this.capUsd;
  }

  /** True while one more call by this agent fits under both of its own daily caps (failed calls count). */
  async canAgentSpend(agentId: string, estimateUsd = 0): Promise<boolean> {
    const u = await this.agentUsage(agentId);
    return u.calls + u.failures + 1 <= this.agentCap.calls && u.spendUsd + estimateUsd <= this.agentCap.usd;
  }

  async record(field: 'calls' | 'fallbacks' | 'skipped', spendUsd = 0, agentId?: string): Promise<void> {
    const micro = Math.round(spendUsd * 1e6);
    await this.db.query(
      `INSERT INTO inference_usage (utc_day, ${field}, spend_micro_usd) VALUES ($1, 1, $2)
       ON CONFLICT (utc_day) DO UPDATE SET ${field} = inference_usage.${field} + 1, spend_micro_usd = inference_usage.spend_micro_usd + $2`,
      [this.today(), micro],
    );
    if (!agentId || field === 'skipped') return;
    await this.db.query(
      `INSERT INTO agent_inference_usage (agent_id, utc_day, ${field}, spend_micro_usd) VALUES ($1, $2, 1, $3)
       ON CONFLICT (agent_id, utc_day) DO UPDATE SET ${field} = agent_inference_usage.${field} + 1, spend_micro_usd = agent_inference_usage.spend_micro_usd + $3`,
      [agentId, this.today(), micro],
    );
  }

  /** One model call, answered or failed: for the shared cap, the agent's caps and its provider's row. */
  async recordCall(r: { provider: ProviderName; agentId: string; ok: boolean; prompt: number; completion: number; spendUsd: number }): Promise<void> {
    const field = r.ok ? 'calls' : 'failures';
    const micro = Math.round(r.spendUsd * 1e6);
    const day = this.today();
    await this.db.query(
      `INSERT INTO inference_usage (utc_day, ${field}, spend_micro_usd) VALUES ($1, 1, $2)
       ON CONFLICT (utc_day) DO UPDATE SET ${field} = inference_usage.${field} + 1, spend_micro_usd = inference_usage.spend_micro_usd + $2`,
      [day, micro],
    );
    await this.db.query(
      `INSERT INTO agent_inference_usage (agent_id, utc_day, ${field}, spend_micro_usd) VALUES ($1, $2, 1, $3)
       ON CONFLICT (agent_id, utc_day) DO UPDATE SET ${field} = agent_inference_usage.${field} + 1, spend_micro_usd = agent_inference_usage.spend_micro_usd + $3`,
      [r.agentId, day, micro],
    );
    await this.db.query(
      `INSERT INTO provider_usage (utc_day, provider, ${field}, prompt_tokens, completion_tokens, spend_micro_usd) VALUES ($1, $2, 1, $3, $4, $5)
       ON CONFLICT (utc_day, provider) DO UPDATE SET ${field} = provider_usage.${field} + 1, prompt_tokens = provider_usage.prompt_tokens + $3,
         completion_tokens = provider_usage.completion_tokens + $4, spend_micro_usd = provider_usage.spend_micro_usd + $5`,
      [day, r.provider, r.prompt, r.completion, micro],
    );
  }
}

/**
 * Validated decisions (and reflections) by prompt, for one UTC day: the same trimmed observation for
 * the same role to the same model is not paid for twice (a day close that is run again, for one).
 */
export class DecisionCache {
  private day = '';
  private readonly map = new Map<string, Decision | string>();
  constructor(private readonly max = 500) {}

  static key(model: string, role: string, messages: readonly ChatMessage[]): string {
    return createHash('sha256').update(JSON.stringify([model, role, messages.map((m) => m.content)])).digest('hex');
  }

  get(key: string, day: string): Decision | string | null {
    if (day !== this.day) return null;
    return this.map.get(key) ?? null;
  }

  set(key: string, decision: Decision | string, day: string): void {
    if (day !== this.day) {
      this.map.clear();
      this.day = day;
    }
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value ?? '');
    this.map.set(key, decision);
  }
}

export interface BrainOptions {
  chain: ProviderChain;
  budget: InferenceBudget;
  pricing: Map<string, Pricing>;
  log: (line: string) => void;
  /** LLM_PRICE_MOVE (default PRICE_MOVE). */
  priceMove?: number;
  /** LLM_DECISION_GAP_DAYS (default DECISION_GAP_DAYS). */
  gapDays?: number;
  cache?: DecisionCache;
}

/** The system prompt for a decision: who the agent is, how the market works, what it may do. */
export const SYSTEM = (c: AgentContext): string => {
  const p = personalityFor(c.agent.kind, c.agent.entrant);
  return [
    `You are ${c.agent.name}, a ${c.agent.role} (${c.agent.kind}) in Yolk Street, a shared egg market of players and AI agents.`,
    `Persona: ${personaFor(c.agent.kind, c.agent.entrant)}`,
    `Haggling: concession ${p.concession}, pride ${p.pride}.`,
    'Each decision costs you 0.50 coins. Below 0 cash you go bust and close.',
    'Egg prices = base price (white 1.00, cream 1.20, brown 1.50, golden 6.00) times one market multiplier that falls as total daily supply rises: clamp((reference / supply) ^ 0.8, 0.40, 2.50), where reference (market.reference) is demand, which grows with the number of active farms.',
    'market.trend: the last three closed days, supply over demand (above 1 a glut, below 1 scarcity) and the multiplier change per day. market.busts: who went bust lately. market.open: AI farms and player farms open. agent.reflection: your own note on last week; agent.reasons: what you said lately.',
    'Rivals may buy feed on the Loyalist credit (buyFeedOnCredit); it falls due with interest in a few days and an agent always pays in full, even into the red.',
    'Decide for the coming day. Prices you set are shares of the live price (priceShare). Offers become decision cards for players, who may accept, decline or haggle.',
    'Rivals use farmActions and may offer undercut or buyout-offer; suppliers set markup, restock and offer feed-deal or credit-terms; buyers post buyOrders, fill sell orders, and offer standing-contract, premium-order, bulk-order or glut-warning.',
    `Only offer to farmIds listed and fill orderIds listed. Keep lines in character, under 160 characters, and the reply short: three offers at most, note under ten words. Leave arrays empty when not your role. reason: one public line in character, under ${REASON_MAX} characters, saying why you did what you did today; players read it on the Market page.`,
  ].join('\n');
};

/** The system prompt for a weekly reflection. */
export const REFLECT_SYSTEM = (c: AgentContext): string =>
  [
    `You are ${c.agent.name}, a ${c.agent.role} (${c.agent.kind}) in Yolk Street, a shared egg market. Persona: ${personaFor(c.agent.kind, c.agent.entrant)}`,
    'Write your weekly reflection from the numbers given: what went well or badly last week, and what you will change. Plain text, in character, two or three sentences, under 400 characters.',
  ].join('\n');

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** How much a farm matters to an agent of this role: players it can make offers to first. */
const relevance = (f: FarmBrief, role: AgentContext['agent']['role']): number =>
  (f.owner === 'player' ? 4 : 0) +
  (f.hasContractWithMe ? 3 : 0) +
  (f.owesMe > 0 ? 2 : 0) +
  (role === 'buyer' && f.sells.length > 0 ? 3 : 0) +
  (role === 'supplier' ? 2 / (1 + Math.max(0, f.feedDays)) : 0) +
  Math.min(1, f.dailyEggs / 100);

/**
 * What the model sees: the agent's context trimmed to the OBSERVED_FARMS most relevant farms (four sell
 * orders each), five days of history, its last two reasons and three busts, numbers rounded. Same
 * shape as the context, so a decision against it validates against the whole one.
 */
export function observe(c: AgentContext): AgentContext {
  const farms = c.farms
    .map((f, i) => ({ f, i, score: relevance(f, c.agent.role) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, OBSERVED_FARMS)
    .map(({ f }) => ({ ...f, cash: Math.round(f.cash), quality: r2(f.quality), owesMe: r2(f.owesMe), sells: f.sells.slice(0, 4).map((o) => ({ ...o, price: r2(o.price) })) }));
  return {
    ...c,
    agent: { ...c.agent, cash: Math.round(c.agent.cash * 10) / 10, reasons: c.agent.reasons.slice(-2) },
    market: {
      ...c.market,
      multiplier: r2(c.market.multiplier),
      prices: Object.fromEntries(Object.entries(c.market.prices).map(([g, p]) => [g, r2(p)])) as AgentContext['market']['prices'],
      history: c.market.history.slice(-5).map((h) => ({ ...h, multiplier: r2(h.multiplier) })),
      busts: c.market.busts.slice(0, 3),
    },
    farms,
  };
}

/** The two messages of a decision call. */
export const decisionMessages = (c: AgentContext): ChatMessage[] => [
  { role: 'system', content: SYSTEM(c) },
  { role: 'user', content: JSON.stringify(observe(c)) },
];

export type Moment = 'first look' | 'hard day' | 'price move';

/**
 * Why today's decision should go to a model, or null for a routine day (the rules decide, no call):
 * the agent's first look (no model decision yet, such as a new AI farm's first day); else, once
 * `gapDays` have passed since its last model answer, a hard day or a move of the multiplier by
 * `priceMove` or more since its last model decision. The weekly reflection is the week's strategy
 * call, made apart from this.
 */
export function modelMoment(c: AgentContext, seen: DecideSeen, when: { priceMove: number; gapDays: number }): Moment | null {
  const last = seen.lastModelMultiplier;
  if (last === null || last === undefined || !(last > 0)) return 'first look';
  if (seen.lastModelDay !== null && seen.lastModelDay !== undefined && c.day - seen.lastModelDay < when.gapDays) return null;
  if (hardDay(c)) return 'hard day';
  if (Math.abs(c.market.multiplier / last - 1) >= when.priceMove) return 'price move';
  return null;
}

export interface DecideSeen {
  /** The multiplier at the agent's last model decision; null or absent when it has had none. */
  lastModelMultiplier?: number | null;
  /** The in-game day of its last model answer (a decision or a reflection); null or absent when none. */
  lastModelDay?: number | null;
}

interface Ask {
  what: 'decision' | 'reflection';
  /** Why it is asked, for the log. */
  why: string;
  tier: (p: InferenceProvider) => 'main' | 'cheap';
  messages: ChatMessage[];
  maxTokens: number;
  responseFormat?: Record<string, unknown>;
}

type Answer = { provider: InferenceProvider; model: string; key: string | null } & ({ content: string; tokens: Tokens } | { cached: Decision | string });

/**
 * One model answer through the chain: each provider that is not paused, in order, under the shared
 * cap and the agent's own (each call first reserves its prompt with a margin and a full reply), its
 * pacing and the day close's time budget. Every call is logged and recorded by provider; a failure
 * moves its provider's breaker and goes on to the next. Null when no provider answered.
 */
async function ask(c: AgentContext, opts: BrainOptions, a: Ask): Promise<Answer | null> {
  const { chain, budget, log } = opts;
  const today = budget.today();
  for (const p of chain.ready()) {
    const tier = a.tier(p);
    const model = tier === 'main' ? p.model : p.cheapModel;
    const key = opts.cache ? DecisionCache.key(model, `${c.agent.role} ${a.what}`, a.messages) : null;
    const cached = key ? opts.cache?.get(key, today) : null;
    if (key && cached) {
      log(`[ai] ${p.name} ${model} ${c.agent.name} ${a.what} (${a.why}): the same prompt today, its decision reused (no call)`);
      return { provider: p, model, key, cached };
    }
    const outOfTime = (): null => {
      const line = chain.outOfTime();
      if (line) log(line);
      return null;
    };
    if (chain.timeLeft() < MIN_CALL_MS) return outOfTime();
    const price = priceOf(opts.pricing, model);
    const prompt = promptTokens(a.messages, a.responseFormat, p.overheadTokens);
    const reserve = reserveUsd(price, prompt, a.maxTokens);
    if (!(await budget.canSpend(reserve))) {
      if (chain.capReachedOn !== today) log(`[ai] today's AI spend cap (${budget.capUsd.toFixed(2)} USD) is reached: every agent uses its rules until 00:00 UTC`);
      chain.capReachedOn = today;
      return null;
    }
    if (!(await budget.canAgentSpend(c.agent.id, reserve))) return null;
    await chain.pace(p);
    if (chain.timeLeft() < MIN_CALL_MS) return outOfTime();
    const timeoutMs = Math.min(CALL_TIMEOUT_MS, chain.timeLeft());
    try {
      const reply = await p.chat(a.messages, { model, maxTokens: a.maxTokens, timeoutMs, ...(a.responseFormat ? { responseFormat: a.responseFormat } : {}) });
      // no usage in the answer: charge the reserve
      const tokens: Tokens = { provider: p.name, model, tier, prompt: reply.usage?.prompt_tokens ?? Math.ceil(prompt * RESERVE_MARGIN), completion: reply.usage?.completion_tokens ?? a.maxTokens };
      const usd = chargeFor(price, tokens.prompt, tokens.completion);
      await budget.recordCall({ provider: p.name, agentId: c.agent.id, ok: true, prompt: tokens.prompt, completion: tokens.completion, spendUsd: usd });
      log(`[ai] ${p.name} ${model} ${c.agent.name} ${a.what} (${a.why}): ${tokens.prompt}+${tokens.completion} tokens, ${usd.toFixed(6)} USD, answered`);
      const line = chain.succeeded(p);
      if (line) log(line);
      return { provider: p, model, key, content: reply.content, tokens };
    } catch (err) {
      const e = asProviderError(p.name, err);
      // a timed-out call may still have run on the provider's side: charge its prompt
      const usd = e.status === null ? chargeFor(price, prompt, 0) : 0;
      await budget.recordCall({ provider: p.name, agentId: c.agent.id, ok: false, prompt: 0, completion: 0, spendUsd: usd });
      log(`[ai] ${p.name} ${model} ${c.agent.name} ${a.what} (${a.why}): 0+0 tokens, ${usd.toFixed(6)} USD, failed (${e.message})`);
      const line = chain.failed(p, e);
      if (line) log(line);
    }
  }
  return null;
}

/** The rule decision, through the same validation as a model's. */
export const ruleResult = (c: AgentContext, fallback = false): DecisionResult => ({
  decision: validateDecision(ruleDecision(c), c) ?? emptyDecision('rules', ''),
  brain: 'rules',
  model: null,
  fallback,
});

/** One agent's decision: the rules on a routine day, else a model through the chain, falling back to the rules. */
export async function decide(c: AgentContext, opts: BrainOptions, seen: DecideSeen = {}): Promise<DecisionResult> {
  if (c.agent.struggling && c.day % 2 === 1) {
    await opts.budget.record('skipped');
    return { decision: emptyDecision('too broke to pay for a decision today', brokeLine(c.agent.kind)), brain: 'skipped', model: null, fallback: false };
  }
  if (!opts.chain.configured) return ruleResult(c);
  const why = modelMoment(c, seen, { priceMove: opts.priceMove ?? PRICE_MOVE, gapDays: opts.gapDays ?? DECISION_GAP_DAYS });
  if (!why) return ruleResult(c);
  const hard = hardDay(c);
  const answer = await ask(c, opts, {
    what: 'decision',
    why,
    tier: (p) => (hard && p.mainOnHardDays ? 'main' : 'cheap'),
    messages: decisionMessages(c),
    maxTokens: DECISION_MAX_TOKENS,
    responseFormat: decisionFormat(),
  });
  if (!answer) {
    await opts.budget.record('fallbacks', 0, c.agent.id);
    return ruleResult(c, true);
  }
  const brain = answer.provider.name;
  if ('cached' in answer) {
    const again = typeof answer.cached === 'string' ? null : validateDecision(answer.cached, c);
    if (again) return { decision: again, brain, model: answer.model, fallback: false };
    return ruleResult(c, true);
  }
  const decision = validateDecision(answer.content, c, (what) => opts.log(`[agents] ${c.agent.name}: dropped ${what}`));
  if (decision) {
    if (answer.key) opts.cache?.set(answer.key, decision, opts.budget.today());
    return { decision, brain, model: answer.model, fallback: false, tokens: answer.tokens };
  }
  opts.log(`[agents] ${c.agent.name}: model reply did not match the decision schema; using rules`);
  await opts.budget.record('fallbacks', 0, c.agent.id);
  return { ...ruleResult(c, true), tokens: answer.tokens };
}

/** The weekly reflection (the week's strategy): by a main model when the chain and the caps allow, else from the rule template. */
export async function reflect(c: AgentContext, week: WeekNumbers, opts: BrainOptions): Promise<ReflectionResult> {
  const rules = (fallback: boolean): ReflectionResult => ({ text: ruleReflection(c, week), brain: 'rules', model: null, fallback });
  if (!opts.chain.configured) return rules(false);
  const answer = await ask(c, opts, {
    what: 'reflection',
    why: 'weekly strategy',
    tier: () => 'main',
    messages: [
      { role: 'system', content: REFLECT_SYSTEM(c) },
      { role: 'user', content: JSON.stringify({ week, cash: c.agent.cash, lastReflection: c.agent.reflection, reasons: c.agent.reasons, trend: c.market.trend }) },
    ],
    maxTokens: REFLECTION_MAX_TOKENS,
  });
  if (answer && 'cached' in answer && typeof answer.cached === 'string') return { text: answer.cached, brain: answer.provider.name, model: answer.model, fallback: false };
  if (!answer || 'cached' in answer) {
    await opts.budget.record('fallbacks', 0, c.agent.id);
    return rules(true);
  }
  const text = cleanText(answer.content.replace(/^["'`]+|["'`]+$/g, ''), 400);
  if (text.length >= 20) {
    if (answer.key) opts.cache?.set(answer.key, text, opts.budget.today());
    return { text, brain: answer.provider.name, model: answer.model, fallback: false, tokens: answer.tokens };
  }
  opts.log(`[agents] ${c.agent.name}: model reflection was empty; using the template`);
  await opts.budget.record('fallbacks', 0, c.agent.id);
  return { ...rules(true), tokens: answer.tokens };
}

/** The daily AI spend line: calls and estimated USD per provider today, against the shared cap. */
export async function spendLine(budget: InferenceBudget): Promise<string> {
  const u = await budget.providerUsage();
  const part = (n: ProviderName): string => `${n} ${u[n].calls} calls${u[n].failures ? ` (${u[n].failures} failed)` : ''} ${u[n].spendUsd.toFixed(4)} USD`;
  return `[ai] today: ${part('nearai')}, ${part('serv')}; cap ${budget.capUsd.toFixed(2)} USD`;
}

/**
 * The agents' mode: the provider whose answer is the latest within MODE_WINDOW_DAYS in-game days (rows
 * of each agent's latest model answer: provider and day), unless it has been refused since (a bad key or no credits) or the
 * shared cap is spent today; else the rules.
 */
export function aiModeOf(answers: readonly Record<string, unknown>[], today: number, chain: ProviderChain, capReached: boolean): AiMode {
  if (capReached) return 'rules';
  let best: { provider: ProviderName; day: number } | null = null;
  for (const a of answers) {
    const provider = a.provider;
    if ((provider !== 'nearai' && provider !== 'serv') || a.day === null || a.day === undefined) continue;
    const day = num(a.day);
    if (day < today - MODE_WINDOW_DAYS || !chain.usable(provider)) continue;
    if (!best || day > best.day) best = { provider, day };
  }
  return best?.provider ?? 'rules';
}
