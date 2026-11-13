// The provider chain with fakes only (no network): NEAR AI Cloud failing and SERV Reasoning answering,
// both failing (the rules), the breakers (402, 429, 5xx), the shared cap's hard stop, the per-agent cap
// counting failed calls, the cache, the days that matter, the close's time budget, pacing, the cost
// log lines, and the mode the market and /healthz report.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { PAUSE_MS, ProviderChain } from '../src/ai/chain';
import { NearAiClient } from '../src/ai/nearai';
import { SERV_PRICES, ServClient } from '../src/ai/serv';
import {
  DECISION_MAX_TOKENS,
  DecisionCache,
  InferenceBudget,
  OBSERVED_FARMS,
  decide,
  decisionFormat,
  decisionMessages,
  modelMoment,
  observe,
  promptTokens,
  reflect,
  reserveUsd,
  spendLine,
  type BrainOptions,
} from '../src/agents/brain';
import { emptyDecision, type AgentContext, type WeekNumbers } from '../src/agents/decision';
import { ruleDecision } from '../src/agents/rules';
import { openDb, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { makeGame } from './helpers';
import { sampleContext } from './recorded-model';

type Body = Record<string, unknown> & { model: string; messages: { role: string; content: string }[] };

/** A fetch that records each request body and answers with `answer` (a status, or a reply's content). */
function fakeFetch(answer: (body: Body) => number | string, seen: Body[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    seen.push(body);
    const a = answer(body);
    if (typeof a === 'number') return new Response(JSON.stringify({ error: { message: 'no' } }), { status: a, headers: { 'x-request-id': 'req-1' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: a } }], usage: { prompt_tokens: 3000, completion_tokens: 140 } }));
  }) as typeof fetch;
}

/** The rule decision for the context the model was shown, as a model would answer it. */
const asRules = (body: Body): string => JSON.stringify(ruleDecision(JSON.parse(body.messages[1]?.content ?? '{}') as AgentContext));

const bakery = (): AgentContext => sampleContext('bakery', 'normal');
const week: WeekNumbers = { fromDay: 1, toDay: 8, cashStart: 500, cashNow: 520, deals: 3, refusals: 1, bustsSeen: 0, multiplierLow: 0.9, multiplierHigh: 1.1, glutDays: 0 };

interface Setup {
  db: Db;
  opts: BrainOptions;
  logs: string[];
  near: Body[];
  serv: Body[];
  clock: { t: number };
  waits: number[];
}

async function setup(o: { near?: (b: Body) => number | string; serv?: (b: Body) => number | string; capUsd?: number; agentCap?: { calls?: number; usd?: number }; closeBudgetMs?: number; cache?: boolean } = {}): Promise<Setup> {
  const db = await openDb('memory://');
  await migrate(db);
  const near: Body[] = [];
  const serv: Body[] = [];
  const clock = { t: 1_000_000 };
  const waits: number[] = [];
  const providers = [
    ...(o.near ? [new NearAiClient({ apiKey: 'near-test-key', fetchImpl: fakeFetch(o.near, near) })] : []),
    ...(o.serv ? [new ServClient({ apiKey: 'serv-test-key', fetchImpl: fakeFetch(o.serv, serv) })] : []),
  ];
  const chain = new ProviderChain(providers, {
    clock: () => clock.t,
    sleep: async (ms) => {
      waits.push(ms);
      clock.t += ms;
    },
    ...(o.closeBudgetMs !== undefined ? { closeBudgetMs: o.closeBudgetMs } : {}),
  });
  const logs: string[] = [];
  const opts: BrainOptions = {
    chain,
    budget: new InferenceBudget(db, o.capUsd ?? 1.5, () => Date.UTC(2026, 10, 13, 12), o.agentCap ?? {}),
    pricing: new Map(),
    log: (l) => logs.push(l),
    ...(o.cache ? { cache: new DecisionCache() } : {}),
  };
  return { db, opts, logs, near, serv, clock, waits };
}

describe('the provider chain', () => {
  it('NEAR AI Cloud answering 402 falls through to SERV Reasoning, which decides; SERV gets its own request shape', async () => {
    const s = await setup({ near: () => 402, serv: asRules });
    const r = await decide(bakery(), s.opts);
    expect(r).toMatchObject({ brain: 'serv', model: 'gpt-6-luna', fallback: false, tokens: { provider: 'serv', tier: 'cheap', prompt: 3000, completion: 140 } });
    expect(r.decision.buyOrders.length).toBeGreaterThan(0);
    expect(s.near).toHaveLength(1);
    const body = s.serv[0];
    expect(body).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 400, reasoning_effort: 'none', response_format: { type: 'json_schema', json_schema: { name: 'decision', strict: true } } });
    expect(body?.max_tokens).toBeUndefined();
    expect(body?.messages[0]?.role).toBe('system');
    // strict modes take anyOf, not oneOf, and no $schema
    const schema = JSON.stringify((body?.response_format as { json_schema: { schema: unknown } }).json_schema.schema);
    expect(schema).not.toContain('oneOf');
    expect(schema).not.toContain('$schema');
    expect(schema).toContain('anyOf');
    // the calls are recorded by provider: the failure counts, at no cost
    const u = await s.opts.budget.providerUsage();
    expect(u.nearai).toMatchObject({ calls: 0, failures: 1, spendUsd: 0 });
    expect(u.serv).toMatchObject({ calls: 1, failures: 0, promptTokens: 3000, completionTokens: 140 });
    expect(u.serv.spendUsd).toBeCloseTo((3000 * 0.13 + 140 * 0.65) / 1e6, 9);
    // one line per call, and one for the breaker that opened; never a key
    expect(s.logs.some((l) => /^\[ai\] nearai z-ai\/glm-5\.3-flash Yolk Street Bakery decision \(first look\): 0\+0 tokens, 0\.000000 USD, failed \(NEAR AI Cloud 402/.test(l))).toBe(true);
    expect(s.logs.some((l) => /^\[ai\] serv gpt-6-luna Yolk Street Bakery decision \(first look\): 3000\+140 tokens, 0\.000481 USD, answered$/.test(l))).toBe(true);
    expect(s.logs.filter((l) => /NEAR AI Cloud refused \(a bad key or no credits\) \(HTTP 402\): skipped for 30 min/.test(l))).toHaveLength(1);
    expect(s.logs.join('\n')).not.toMatch(/test-key/);
    await s.db.close();
  });

  it('with SERV failing too, the rules decide, counted as a fallback; both breakers are paused', async () => {
    const s = await setup({ near: () => 402, serv: () => 503 });
    const r = await decide(bakery(), s.opts);
    expect(r).toMatchObject({ brain: 'rules', fallback: true });
    expect(r.decision).toEqual(ruleDecision(bakery()));
    expect(s.opts.chain.status()).toMatchObject({ nearai: { state: 'paused', lastStatus: 402, retryInS: 1800 }, serv: { state: 'paused', lastStatus: 503, retryInS: 120 } });
    expect((await s.opts.budget.usage()).fallbacks).toBe(1);
    // the next decision tries neither: no request, rules
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'rules', fallback: true });
    expect([s.near.length, s.serv.length]).toEqual([1, 1]);
    await s.db.close();
  });

  it('a 402 skips NEAR AI for 30 minutes, then it is tried once more; the breaker logs its change once', async () => {
    const s = await setup({ near: () => 402, serv: asRules });
    for (let i = 0; i < 5; i++) await decide(bakery(), s.opts);
    expect(s.near).toHaveLength(1);
    expect(s.serv).toHaveLength(5);
    s.clock.t += PAUSE_MS.refused;
    await decide(bakery(), s.opts);
    expect(s.near).toHaveLength(2);
    // the same refusal again: no second breaker line
    expect(s.logs.filter((l) => /skipped for 30 min/.test(l))).toHaveLength(1);
    await s.db.close();
  });

  it('a 429 backs off 30 s, doubling; a 5xx skips 2 minutes; an answer closes the breaker and says so', async () => {
    let status: number | null = 429;
    const s = await setup({ serv: (b) => status ?? asRules(b) });
    await decide(bakery(), s.opts);
    expect(s.opts.chain.status().serv).toMatchObject({ state: 'paused', retryInS: 30 });
    s.clock.t += 30_000;
    await decide(bakery(), s.opts);
    expect(s.opts.chain.status().serv).toMatchObject({ state: 'paused', retryInS: 60 });
    s.clock.t += 60_000;
    status = 500;
    await decide(bakery(), s.opts);
    expect(s.opts.chain.status().serv).toMatchObject({ state: 'paused', lastStatus: 500, retryInS: 120 });
    s.clock.t += 120_000;
    status = null;
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'serv' });
    expect(s.opts.chain.status().serv).toEqual({ state: 'answering' });
    expect(s.logs.filter((l) => l.startsWith('[ai] SERV Reasoning'))).toEqual([
      '[ai] SERV Reasoning rate limited (HTTP 429): skipped for 30 s, then tried again; the next provider or the rules decide meanwhile',
      '[ai] SERV Reasoning down or slow (HTTP 500): skipped for 2 min, then tried again; the next provider or the rules decide meanwhile',
      '[ai] SERV Reasoning is answering again',
    ]);
    await s.db.close();
  });

  it('spaces SERV calls at least a second apart', async () => {
    const s = await setup({ serv: asRules });
    await decide(bakery(), s.opts);
    await decide(bakery(), s.opts);
    expect(s.waits).toEqual([1000]);
    s.clock.t += 5000;
    await decide(bakery(), s.opts);
    expect(s.waits).toEqual([1000]);
    await s.db.close();
  });
});

describe('cost control', () => {
  it('the shared cap is a hard stop: no call after it until the next UTC day, and the mode turns to rules', async () => {
    // room for one answered call (3000 in, 140 out) and one more reserve, not two
    const reserve = reserveUsd(SERV_PRICES['gpt-6-luna'] ?? { input: 1, output: 5 }, promptTokens(decisionMessages(bakery()), decisionFormat(), 200), DECISION_MAX_TOKENS);
    const capUsd = (3000 * 0.13 + 140 * 0.65) / 1e6 + reserve;
    // the agent's own cap set wide, so only the shared one binds
    const s = await setup({ serv: asRules, capUsd, agentCap: { usd: 1 } });
    for (let i = 0; i < 4; i++) await decide(bakery(), s.opts);
    expect(s.serv).toHaveLength(2);
    expect((await s.opts.budget.usage()).spendUsd).toBeLessThanOrEqual(capUsd);
    expect(s.logs.filter((l) => /today's AI spend cap \([\d.]+ USD\) is reached: every agent uses its rules until 00:00 UTC/.test(l))).toHaveLength(1);
    expect(s.opts.chain.capReachedOn).toBe('2026-11-13');
    await s.db.close();
  });

  it("each agent's own cap counts failed calls: past it, the rules", async () => {
    const s = await setup({ near: () => 500, serv: asRules, agentCap: { calls: 3 } });
    // NEAR fails once (then is paused), SERV answers twice: three calls for this agent
    for (let i = 0; i < 4; i++) await decide(bakery(), s.opts);
    expect(s.near.length + s.serv.length).toBe(3);
    expect(await s.opts.budget.agentUsage('sample-bakery')).toMatchObject({ calls: 2, failures: 1, fallbacks: 2 });
    // another agent still has its own room
    expect(await decide(sampleContext('trader', 'normal'), s.opts)).toMatchObject({ brain: 'serv' });
    await s.db.close();
  });

  it('the same prompt to the same model on the same UTC day reuses its decision and its reflection: no second call', async () => {
    const s = await setup({ serv: (b) => (b.response_format ? asRules(b) : 'A steady week of bread. Next week I bid a little deeper on brown eggs.'), cache: true });
    const first = await decide(bakery(), s.opts);
    const again = await decide(bakery(), s.opts);
    expect(s.serv).toHaveLength(1);
    expect(again).toMatchObject({ brain: 'serv', model: 'gpt-6-luna', fallback: false, decision: first.decision });
    expect(again.tokens).toBeUndefined();
    expect(s.logs.filter((l) => /decision \(first look\): the same prompt today, its decision reused \(no call\)/.test(l))).toHaveLength(1);
    const r1 = await reflect(bakery(), week, s.opts);
    const r2 = await reflect(bakery(), week, s.opts);
    expect(s.serv).toHaveLength(2);
    expect(r2).toMatchObject({ brain: 'serv', model: 'gpt-5.4-mini', text: r1.text });
    await s.db.close();
  });

  it('only the days that matter go to a model; routine days use the rules with no call', async () => {
    const when = { priceMove: 0.15, gapDays: 3 };
    const c = bakery();
    expect(modelMoment(c, {}, when)).toBe('first look');
    expect(modelMoment(c, { lastModelMultiplier: c.market.multiplier, lastModelDay: c.day - 5 }, when)).toBeNull();
    expect(modelMoment(c, { lastModelMultiplier: c.market.multiplier / 1.2, lastModelDay: c.day - 5 }, when)).toBe('price move');
    expect(modelMoment(c, { lastModelMultiplier: c.market.multiplier / 1.2, lastModelDay: c.day - 1 }, when)).toBeNull();
    const glut = sampleContext('bakery', 'glut');
    expect(modelMoment(glut, { lastModelMultiplier: glut.market.multiplier, lastModelDay: glut.day - 3 }, when)).toBe('hard day');
    const s = await setup({ serv: asRules });
    const routine = await decide(c, s.opts, { lastModelMultiplier: c.market.multiplier, lastModelDay: c.day - 4 });
    expect(routine).toMatchObject({ brain: 'rules', fallback: false });
    expect(s.serv).toHaveLength(0);
    // a struggling agent still sits out every other day, before any of this
    const poor = { ...c, day: 13, agent: { ...c.agent, cash: 10, struggling: true } };
    expect(await decide(poor, s.opts)).toMatchObject({ brain: 'skipped', decision: { note: 'too broke to pay for a decision today' } });
    await s.db.close();
  });

  it("a day close's time budget: once it is spent, the agents still waiting use their rules, said once", async () => {
    const s = await setup({ serv: asRules, closeBudgetMs: 6500 });
    s.opts.chain.beginClose();
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'serv' });
    // the second waits its second's gap and still has 5.5 s; the third would have 4.5 s, under the least a call needs (5 s)
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'serv' });
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'rules', fallback: true });
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'rules', fallback: true });
    s.opts.chain.endClose();
    expect(s.serv).toHaveLength(2);
    expect(s.logs.filter((l) => /model time \(7 s\) is spent/.test(l))).toHaveLength(1);
    // outside a close there is no budget
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'serv' });
    await s.db.close();
  });

  it('the observation lists the most relevant farms only, players first, with rounded numbers', () => {
    const c = bakery();
    const farm = c.farms[0];
    if (!farm) throw new Error('sample has farms');
    const many = Array.from({ length: 12 }, (_, i) => ({ ...farm, farmId: `f${i}`, owner: i % 3 === 0 ? ('player' as const) : ('agent' as const), cash: 10.456 + i }));
    const seen = observe({ ...c, farms: many, market: { ...c.market, multiplier: 1.23456 } });
    expect(seen.farms).toHaveLength(OBSERVED_FARMS);
    expect(seen.farms.slice(0, 4).every((f) => f.owner === 'player')).toBe(true);
    expect(seen.farms[0]?.cash).toBe(10);
    expect(seen.market.multiplier).toBe(1.23);
    expect(JSON.stringify(seen).length).toBeLessThan(JSON.stringify({ ...c, farms: many }).length);
  });

  it('the daily spend line: calls and USD by provider against the cap', async () => {
    const s = await setup({ near: () => 402, serv: asRules });
    await decide(bakery(), s.opts);
    expect(await spendLine(s.opts.budget)).toBe('[ai] today: nearai 0 calls (1 failed) 0.0000 USD, serv 1 calls 0.0005 USD; cap 1.50 USD');
    await s.db.close();
  });
});

describe('the mode the game reports', () => {
  it('rules with no provider; serv once SERV answers (market, each agent, /healthz); rules again once it is refused', async () => {
    const rulesOnly = await makeGame({ cast: true, seed: 5 });
    expect((await rulesOnly.game.getMarketState()).aiMode).toBe('rules');
    expect((await rulesOnly.game.aiStatus()).providers).toEqual({ nearai: { state: 'off' }, serv: { state: 'off' } });
    await rulesOnly.db.close();

    let refuse = false;
    const servBodies: Body[] = [];
    const serv = new ServClient({ apiKey: 'serv-test-key', fetchImpl: fakeFetch((b) => (refuse ? 402 : asRules(b)), servBodies) });
    const t = await makeGame({ cast: true, seed: 5, providers: [serv] });
    expect((await t.game.getMarketState()).aiMode).toBe('rules');
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    // every agent's first look went to SERV (an AI farm that entered at the close has not decided yet)
    const market = await t.game.getMarketState();
    expect(market.aiMode).toBe('serv');
    const answered = new Set((await t.db.query(`SELECT name FROM agents WHERE model_provider = 'serv'`)).map((r) => String(r.name)));
    expect(answered.size).toBeGreaterThanOrEqual(7);
    for (const a of market.agents) expect(a.brain).toBe(answered.has(a.name) ? 'serv' : 'rules');
    const status = await t.game.aiStatus();
    expect(status).toMatchObject({ mode: 'serv', providers: { nearai: { state: 'off' }, serv: { state: 'answering' } }, capUsd: 1 });
    expect(status.calls).toBe(servBodies.length);
    expect(status.todayUsd).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toMatch(/key/i);
    expect(t.logs.some((l) => /^\[ai\] today: nearai 0 calls 0\.0000 USD, serv \d+ calls 0\.\d{4} USD; cap 1\.00 USD; mode serv$/.test(l))).toBe(true);
    // a routine next day: no new calls for agents that just decided
    const before = servBodies.length;
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(servBodies.length - before).toBeLessThan(before);
    // SERV refuses (no credits): the mode is the rules at once
    refuse = true;
    await t.db.query('UPDATE agents SET model_multiplier = NULL');
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect((await t.game.getMarketState()).aiMode).toBe('rules');
    expect((await t.game.getMarketState()).agents.every((a) => a.brain === 'rules')).toBe(true);
    expect((await t.game.aiStatus()).providers.serv).toMatchObject({ state: 'paused', lastStatus: 402 });
    await t.db.close();
  }, 60_000);

  it('an unusable reply is not an answer: the rules decide and nothing else changes', async () => {
    const s = await setup({ serv: () => JSON.stringify({ ...emptyDecision('x', 'y'), offers: [{ kind: 'free-money' }] }) });
    expect(await decide(bakery(), s.opts)).toMatchObject({ brain: 'rules', fallback: true });
    expect(s.opts.chain.status().serv).toEqual({ state: 'answering' });
    await s.db.close();
  });
});
