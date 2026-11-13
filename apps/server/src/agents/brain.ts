// Agent decisions through NEAR AI Cloud, with structured JSON output validated against the decision
// schema. Anything unusable (error, timeout, invalid JSON) falls back to the rule policy and is
// logged. Routine days go to the cheap model; weekly reflections and hard days (a crash or glut, or
// the agent's cash under its struggle line) go to the main model. A hard daily spend cap (UTC day)
// switches every agent to rules until the next day, and a per-agent cap (calls and spend) does the
// same for one agent; struggling agents think only every other day.
import type { Db } from '../db/db';
import { num } from '../db/db';
import { NEARAI_DEFAULT_CHEAP_MODEL, NEARAI_DEFAULT_MODEL, type NearAiClient } from '../ai/nearai';
import { brokeLine, personaFor, personalityFor } from './cast';
import { REASON_MAX, cleanText, decisionJsonSchema, emptyDecision, hardDay, validateDecision, type AgentContext, type Decision, type WeekNumbers } from './decision';
import { ruleDecision, ruleReflection } from './rules';

export interface DecisionResult {
  decision: Decision;
  brain: 'rules' | 'nearai' | 'skipped';
  model: string | null;
  fallback: boolean;
  /** The model call made and the tokens it used, when one was made (also when its reply was unusable). */
  tokens?: Tokens;
}

export interface ReflectionResult {
  text: string;
  brain: 'rules' | 'nearai';
  model: string | null;
  fallback: boolean;
  tokens?: Tokens;
}

export interface Tokens {
  model: string;
  prompt: number;
  completion: number;
}

export interface Pricing {
  /** USD per million tokens. */
  input: number;
  output: number;
}

/**
 * Prices assumed for the two default models when /v1/models does not say (USD per million tokens).
 * NEAR AI Cloud did not answer while these were set (402, no credits), so they are estimates for a
 * small open-weight model and a flash model; NEARAI_MAIN_PRICE and NEARAI_CHEAP_PRICE override them.
 */
export const ASSUMED_PRICING: Readonly<Record<string, Pricing>> = {
  [NEARAI_DEFAULT_MODEL]: { input: 0.2, output: 0.8 },
  [NEARAI_DEFAULT_CHEAP_MODEL]: { input: 0.1, output: 0.4 },
};

/** A model with no known price is priced high, so a cap is never crossed by surprise. */
export const UNKNOWN_PRICING: Pricing = { input: 1, output: 5 };

export const priceOf = (pricing: Map<string, Pricing>, model: string): Pricing => pricing.get(model) ?? ASSUMED_PRICING[model] ?? UNKNOWN_PRICING;

/**
 * Tokens a prompt may take, reserved before the call: JSON runs about 3 characters a token, so 2
 * (and a little for the chat template) is a safe upper bound that keeps the caps from being crossed.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 2) + 64;

/** Most tokens a decision and a reflection may answer with. */
export const DECISION_MAX_TOKENS = 1500;
export const REFLECTION_MAX_TOKENS = 200;

export interface AgentCap {
  /** Model calls one agent may make per UTC day. */
  calls: number;
  /** USD one agent may spend per UTC day. */
  usd: number;
}

export class InferenceBudget {
  readonly agentCap: AgentCap;

  constructor(
    private readonly db: Db,
    readonly capUsd: number,
    private readonly now: () => number = Date.now,
    /** Per agent; by default a quarter of the global cap and 40 calls. */
    agentCap: Partial<AgentCap> = {},
  ) {
    this.agentCap = { calls: agentCap.calls ?? 40, usd: agentCap.usd ?? capUsd / 4 };
  }

  private utcDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  async usage(): Promise<{ calls: number; fallbacks: number; skipped: number; spendUsd: number }> {
    const [r] = await this.db.query('SELECT calls, fallbacks, skipped, spend_micro_usd FROM inference_usage WHERE utc_day = $1', [this.utcDay()]);
    return { calls: num(r?.calls ?? 0), fallbacks: num(r?.fallbacks ?? 0), skipped: num(r?.skipped ?? 0), spendUsd: num(r?.spend_micro_usd ?? 0) / 1e6 };
  }

  async agentUsage(agentId: string): Promise<{ calls: number; fallbacks: number; spendUsd: number }> {
    const [r] = await this.db.query('SELECT calls, fallbacks, spend_micro_usd FROM agent_inference_usage WHERE agent_id = $1 AND utc_day = $2', [agentId, this.utcDay()]);
    return { calls: num(r?.calls ?? 0), fallbacks: num(r?.fallbacks ?? 0), spendUsd: num(r?.spend_micro_usd ?? 0) / 1e6 };
  }

  /** True while one more call (at its estimated cost) still fits under the cap. */
  async canSpend(estimateUsd = 0): Promise<boolean> {
    return (await this.usage()).spendUsd + estimateUsd <= this.capUsd;
  }

  /** True while one more call by this agent fits under both of its own daily caps. */
  async canAgentSpend(agentId: string, estimateUsd = 0): Promise<boolean> {
    const u = await this.agentUsage(agentId);
    return u.calls + 1 <= this.agentCap.calls && u.spendUsd + estimateUsd <= this.agentCap.usd;
  }

  async record(field: 'calls' | 'fallbacks' | 'skipped', spendUsd = 0, agentId?: string): Promise<void> {
    const micro = Math.round(spendUsd * 1e6);
    await this.db.query(
      `INSERT INTO inference_usage (utc_day, ${field}, spend_micro_usd) VALUES ($1, 1, $2)
       ON CONFLICT (utc_day) DO UPDATE SET ${field} = inference_usage.${field} + 1, spend_micro_usd = inference_usage.spend_micro_usd + $2`,
      [this.utcDay(), micro],
    );
    if (!agentId || field === 'skipped') return;
    await this.db.query(
      `INSERT INTO agent_inference_usage (agent_id, utc_day, ${field}, spend_micro_usd) VALUES ($1, $2, 1, $3)
       ON CONFLICT (agent_id, utc_day) DO UPDATE SET ${field} = agent_inference_usage.${field} + 1, spend_micro_usd = agent_inference_usage.spend_micro_usd + $3`,
      [agentId, this.utcDay(), micro],
    );
  }
}

export interface BrainOptions {
  client: NearAiClient | null;
  budget: InferenceBudget;
  /** The main model: weekly reflections and hard days. */
  model: string;
  /** The cheap model: routine days. */
  cheapModel: string;
  pricing: Map<string, Pricing>;
  log: (line: string) => void;
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
    `Only offer to farmIds listed and fill orderIds listed. Keep lines in character, under 160 characters. Leave arrays empty when not your role. reason: one public line in character, under ${REASON_MAX} characters, saying why you did what you did today; players read it on the Market page.`,
  ].join('\n');
};

/** The system prompt for a weekly reflection. */
export const REFLECT_SYSTEM = (c: AgentContext): string =>
  [
    `You are ${c.agent.name}, a ${c.agent.role} (${c.agent.kind}) in Yolk Street, a shared egg market. Persona: ${personaFor(c.agent.kind, c.agent.entrant)}`,
    'Write your weekly reflection from the numbers given: what went well or badly last week, and what you will change. Plain text, in character, two or three sentences, under 400 characters.',
  ].join('\n');

const chargeFor = (price: Pricing, prompt: number, completion: number): number => (prompt * price.input + completion * price.output) / 1e6;

/**
 * Runs one model call under both caps: reserves its most expensive cost first (the prompt and a
 * full reply), records the spend, and returns the reply, or null when a cap is reached or the call
 * failed (counted as a fallback).
 */
async function callModel(
  c: AgentContext,
  opts: BrainOptions,
  model: string,
  messages: { role: 'system' | 'user'; content: string }[],
  maxTokens: number,
  responseFormat?: Record<string, unknown>,
): Promise<{ content: string; tokens: Tokens } | null> {
  if (!opts.client) return null;
  const price = priceOf(opts.pricing, model);
  const prompt = estimateTokens(messages.map((m) => m.content).join('\n'));
  const estimate = chargeFor(price, prompt, maxTokens);
  if (!(await opts.budget.canSpend(estimate)) || !(await opts.budget.canAgentSpend(c.agent.id, estimate))) {
    await opts.budget.record('fallbacks', 0, c.agent.id);
    return null;
  }
  try {
    const { content, usage } = await opts.client.chat(messages, { model, maxTokens, timeoutMs: 20_000, ...(responseFormat ? { responseFormat } : {}) });
    const tokens = { model, prompt: usage?.prompt_tokens ?? prompt, completion: usage?.completion_tokens ?? Math.ceil(content.length / 3) };
    await opts.budget.record('calls', chargeFor(price, tokens.prompt, tokens.completion), c.agent.id);
    return { content, tokens };
  } catch (err) {
    opts.log(`[agents] ${c.agent.name}: NEAR AI call failed (${err instanceof Error ? err.message : String(err)}); using rules`);
    await opts.budget.record('fallbacks', 0, c.agent.id);
    return null;
  }
}

/** The rule decision, through the same validation as a model's. */
export const ruleResult = (c: AgentContext, fallback = false): DecisionResult => ({
  decision: validateDecision(ruleDecision(c), c) ?? emptyDecision('rules', ''),
  brain: 'rules',
  model: null,
  fallback,
});

/** Asks the model for one agent's decision, or falls back to the rules. */
export async function decide(c: AgentContext, opts: BrainOptions): Promise<DecisionResult> {
  if (c.agent.struggling && c.day % 2 === 1) {
    await opts.budget.record('skipped');
    return { decision: emptyDecision('too broke to think today', brokeLine(c.agent.kind)), brain: 'skipped', model: null, fallback: false };
  }
  if (!opts.client) return ruleResult(c);
  const model = hardDay(c) ? opts.model : opts.cheapModel;
  const reply = await callModel(
    c,
    opts,
    model,
    [
      { role: 'system', content: SYSTEM(c) },
      { role: 'user', content: JSON.stringify(c) },
    ],
    DECISION_MAX_TOKENS,
    { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: decisionJsonSchema() } },
  );
  if (!reply) return ruleResult(c, true);
  const decision = validateDecision(reply.content, c, (what) => opts.log(`[agents] ${c.agent.name}: dropped ${what}`));
  if (decision) return { decision, brain: 'nearai', model, fallback: false, tokens: reply.tokens };
  opts.log(`[agents] ${c.agent.name}: model reply did not match the decision schema; using rules`);
  await opts.budget.record('fallbacks', 0, c.agent.id);
  return { ...ruleResult(c, true), tokens: reply.tokens };
}

/** The weekly reflection: by the main model when the caps allow, else from the rule template. */
export async function reflect(c: AgentContext, week: WeekNumbers, opts: BrainOptions): Promise<ReflectionResult> {
  const rules = (fallback: boolean): ReflectionResult => ({ text: ruleReflection(c, week), brain: 'rules', model: null, fallback });
  if (!opts.client) return rules(false);
  const reply = await callModel(
    c,
    opts,
    opts.model,
    [
      { role: 'system', content: REFLECT_SYSTEM(c) },
      { role: 'user', content: JSON.stringify({ week, cash: c.agent.cash, lastReflection: c.agent.reflection, reasons: c.agent.reasons, trend: c.market.trend }) },
    ],
    REFLECTION_MAX_TOKENS,
  );
  if (!reply) return rules(true);
  const text = cleanText(reply.content.replace(/^["'`]+|["'`]+$/g, ''), 400);
  if (text.length >= 20) return { text, brain: 'nearai', model: opts.model, fallback: false, tokens: reply.tokens };
  opts.log(`[agents] ${c.agent.name}: model reflection was empty; using the template`);
  await opts.budget.record('fallbacks', 0, c.agent.id);
  return { ...rules(true), tokens: reply.tokens };
}
