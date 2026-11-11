// Agent decisions through NEAR AI Cloud, with structured JSON output validated against the decision
// schema. Anything unusable (error, timeout, invalid JSON) falls back to the rule policy and is
// logged. A hard daily spend cap (UTC day) switches every agent to rules until the next day;
// struggling agents think only every other day, on the cheaper model.
import type { Db } from '../db/db';
import { num } from '../db/db';
import type { NearAiClient } from '../ai/nearai';
import { CAST } from './cast';
import { decisionJsonSchema, emptyDecision, parseDecision, type AgentContext, type Decision } from './decision';
import { ruleDecision } from './rules';

export interface DecisionResult {
  decision: Decision;
  brain: 'rules' | 'nearai' | 'skipped';
  model: string | null;
  fallback: boolean;
}

export interface Pricing {
  /** USD per million tokens. */
  input: number;
  output: number;
}

export class InferenceBudget {
  constructor(
    private readonly db: Db,
    readonly capUsd: number,
    private readonly now: () => number = Date.now,
  ) {}

  private utcDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  async usage(): Promise<{ calls: number; fallbacks: number; skipped: number; spendUsd: number }> {
    const [r] = await this.db.query('SELECT calls, fallbacks, skipped, spend_micro_usd FROM inference_usage WHERE utc_day = $1', [this.utcDay()]);
    return { calls: num(r?.calls ?? 0), fallbacks: num(r?.fallbacks ?? 0), skipped: num(r?.skipped ?? 0), spendUsd: num(r?.spend_micro_usd ?? 0) / 1e6 };
  }

  /** True while one more call (at its estimated cost) still fits under the cap. */
  async canSpend(estimateUsd = 0): Promise<boolean> {
    return (await this.usage()).spendUsd + estimateUsd <= this.capUsd;
  }

  async record(field: 'calls' | 'fallbacks' | 'skipped', spendUsd = 0): Promise<void> {
    await this.db.query(
      `INSERT INTO inference_usage (utc_day, ${field}, spend_micro_usd) VALUES ($1, 1, $2)
       ON CONFLICT (utc_day) DO UPDATE SET ${field} = inference_usage.${field} + 1, spend_micro_usd = inference_usage.spend_micro_usd + $2`,
      [this.utcDay(), Math.round(spendUsd * 1e6)],
    );
  }
}

export interface BrainOptions {
  client: NearAiClient | null;
  budget: InferenceBudget;
  model: string;
  cheapModel: string;
  pricing: Map<string, Pricing>;
  log: (line: string) => void;
}

const SYSTEM = (c: AgentContext): string => {
  const who = CAST[c.agent.kind];
  return [
    `You are ${c.agent.name}, a ${c.agent.role} (${c.agent.kind}) in Yolk Street, a shared egg market of players and AI agents.`,
    `Personality: concession ${who.personality.concession}, pride ${who.personality.pride}.`,
    'Each decision costs you 0.50 coins. Below 0 cash you go bust and close.',
    'Egg prices = base price (white 1.00, cream 1.20, brown 1.50, golden 6.00) times one market multiplier that falls as total daily supply rises: clamp((600 / supply) ^ 0.8, 0.40, 2.50).',
    'Decide for the coming day. Prices you set are shares of the live price (priceShare). Offers become decision cards for players, who may accept, decline or haggle.',
    'Rivals use farmActions and may offer undercut or buyout-offer; suppliers set markup, restock and offer feed-deal or credit-terms; buyers post buyOrders, fill sell orders, and offer standing-contract, premium-order, bulk-order or glut-warning.',
    'Only offer to farmIds listed. Keep lines in character, under 160 characters. Leave arrays empty when not your role.',
  ].join('\n');
};

/** Asks the model for one agent's decision, or falls back to the rules. */
export async function decide(c: AgentContext, opts: BrainOptions): Promise<DecisionResult> {
  const struggling = c.agent.struggling;
  if (struggling && c.day % 2 === 1) {
    await opts.budget.record('skipped');
    return { decision: emptyDecision('too broke to think today'), brain: 'skipped', model: null, fallback: false };
  }
  const rules = (): DecisionResult => ({ decision: ruleDecision(c), brain: 'rules', model: null, fallback: false });
  if (!opts.client) return rules();
  const model = struggling ? opts.cheapModel : opts.model;
  const price = opts.pricing.get(model) ?? { input: 1, output: 5 };
  // reserve a typical call (about 2.5k tokens in, 1.5k out at most) so the cap is never crossed
  const estimate = (2500 * price.input + 1500 * price.output) / 1e6;
  if (!(await opts.budget.canSpend(estimate))) {
    await opts.budget.record('fallbacks');
    return { ...rules(), fallback: true };
  }
  try {
    const { content, usage } = await opts.client.chat(
      [
        { role: 'system', content: SYSTEM(c) },
        { role: 'user', content: JSON.stringify(c) },
      ],
      {
        model,
        maxTokens: 1500,
        timeoutMs: 20_000,
        responseFormat: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: decisionJsonSchema() } },
      },
    );
    const spend = ((usage?.prompt_tokens ?? 2000) * price.input + (usage?.completion_tokens ?? 500) * price.output) / 1e6;
    await opts.budget.record('calls', spend);
    const decision = parseDecision(content);
    if (decision) return { decision, brain: 'nearai', model, fallback: false };
    opts.log(`[agents] ${c.agent.name}: model reply did not match the decision schema; using rules`);
  } catch (err) {
    opts.log(`[agents] ${c.agent.name}: NEAR AI call failed (${err instanceof Error ? err.message : String(err)}); using rules`);
  }
  await opts.budget.record('fallbacks');
  return { ...rules(), fallback: true };
}
