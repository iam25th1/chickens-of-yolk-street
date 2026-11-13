import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { NearAiClient } from '../src/ai/nearai';
import { DECISION_MAX_TOKENS, InferenceBudget, SYSTEM, decide, estimateTokens, reflect } from '../src/agents/brain';
import { CAST, reserveFor } from '../src/agents/cast';
import { cleanText, decisionJsonSchema, emptyDecision, parseDecision, validateDecision, type AgentContext, type WeekNumbers } from '../src/agents/decision';
import { ENTRANTS } from '../src/agents/entrants';
import { haggleStep } from '../src/agents/haggle';
import { glutTrend, ruleDecision, ruleReflection, scarceTrend } from '../src/agents/rules';
import { createSessionSigner } from '../src/auth/session';
import { openDb } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { RateLimiter } from '../src/net/ratelimit';

const farm = (over: Partial<AgentContext['farms'][number]> = {}): AgentContext['farms'][number] => ({
  farmId: 'f1',
  name: "Ada's Farm",
  owner: 'player',
  hens: 20,
  capacity: 30,
  crate: { white: 20, cream: 10, brown: 6, golden: 1 },
  dailyEggs: 16,
  feedDays: 1,
  cash: 20,
  quality: 0.4,
  sells: [],
  hasContractWithMe: false,
  owesMe: 0,
  memory: { deals: 2, refusals: 0, hagglesWon: 0, hagglesLost: 0, misses: 0, sulking: false },
  ...over,
});

const ctx = (kind: AgentContext['agent']['kind'], over: Partial<AgentContext> = {}): AgentContext => ({
  day: 4,
  agent: {
    id: 'a1',
    kind,
    role: CAST[kind].role,
    name: CAST[kind].names[0] ?? kind,
    cash: 500,
    stock: { cheap: 10, standard: 10, premium: 10 },
    struggling: false,
    entrant: null,
    reflection: null,
    reasons: [],
  },
  market: {
    multiplier: 1.2,
    prices: { white: 1.2, cream: 1.44, brown: 1.8, golden: 7.2 },
    reference: 270,
    supplyYesterday: 240,
    history: [],
    crash: false,
    auctionHens: 0,
    trend: { supplyOverDemand: [], slope: 0 },
    busts: [],
    open: { aiFarms: 2, playerFarms: 1 },
  },
  own: null,
  farms: [farm()],
  ...over,
});

describe('rule policies follow each character', () => {
  it('the Squeezer prices a desperate farm higher than the Loyalist does', () => {
    const sq = ruleDecision(ctx('squeezer')).offers.find((o) => o.kind === 'feed-deal');
    const lo = ruleDecision(ctx('loyalist')).offers.find((o) => o.kind === 'feed-deal');
    expect(sq && lo && sq.priceShare > lo.priceShare).toBe(true);
    expect(ruleDecision(ctx('loyalist')).offers.some((o) => o.kind === 'credit-terms')).toBe(true);
  });

  it('the bakery offers contracts; the trader walks from farms whose quality slipped', () => {
    expect(ruleDecision(ctx('bakery')).offers.some((o) => o.kind === 'standing-contract')).toBe(true);
    expect(ruleDecision(ctx('trader')).offers.some((o) => o.kind === 'premium-order')).toBe(true);
    const slipped = ruleDecision(ctx('trader', { farms: [farm({ quality: 0.1 })] }));
    expect(slipped.offers.some((o) => o.kind === 'premium-order')).toBe(false);
  });

  it('the wholesaler offers to buy a big crate cheap and warns a farm it cannot buy from of a glut', () => {
    const small = farm({ farmId: 'f2', hens: 6, crate: { white: 2, cream: 1, brown: 0, golden: 0 }, dailyEggs: 4 });
    const d = ruleDecision(ctx('wholesaler', { market: { ...ctx('wholesaler').market, supplyYesterday: 900 }, farms: [farm(), small] }));
    // one card per farm from each agent: the order where it can buy, the warning where it cannot
    expect(d.offers.map((o) => `${o.farmId}:${o.kind}`).sort()).toEqual(['f1:bulk-order', 'f2:glut-warning']);
  });

  it('the Upstart borrows to grow on a good week and dumps fresh eggs in a glut', () => {
    const own = { hens: 28, capacity: 30, freePlots: 2, crate: { white: 0, cream: 0, brown: 0, golden: 0 }, feedGrams: { cheap: 5000, standard: 0, premium: 0 }, feedTier: 'cheap' as const, unlocks: [], owes: 0 };
    const boom = ctx('upstart', { own, market: { ...ctx('upstart').market, history: [1, 2, 3, 4, 5].map((day) => ({ day, supply: 100, multiplier: 1.3 })) } });
    expect(ruleDecision(boom).farmActions.some((a) => a.t === 'buyFeedOnCredit')).toBe(true);
    const glut = ctx('upstart', { own, market: { ...ctx('upstart').market, multiplier: 0.6, supplyYesterday: 400 } });
    const d = ruleDecision(glut);
    expect(d.sellOrders.length).toBeGreaterThan(0);
    expect(d.sellOrders.every((s) => s.priceShare < 0.7)).toBe(true);
  });

  it('Old Money holds half its crate back in a slump and sells the lot once the price recovers', () => {
    const own = { hens: 100, capacity: 102, freePlots: 1, crate: { white: 40, cream: 40, brown: 40, golden: 4 }, feedGrams: { cheap: 0, standard: 0, premium: 90_000 }, feedTier: 'premium' as const, unlocks: [], owes: 0 };
    const sold = (m: number) => {
      const a = ruleDecision(ctx('old-money', { own, market: { ...ctx('old-money').market, multiplier: m } })).farmActions.find((x) => x.t === 'sell');
      return a && a.t === 'sell' ? a.items.white + a.items.cream + a.items.brown + a.items.golden : 0;
    };
    expect(sold(0.85)).toBe(62);
    expect(sold(1.0)).toBe(124);
  });
});

describe('every decision passes one validation', () => {
  const sells = [{ orderId: 'o1', grade: 'white' as const, qty: 6, price: 1 }];
  const seen = (kind: AgentContext['agent']['kind']) => ctx(kind, { farms: [farm({ sells }), farm({ farmId: 'ai1', owner: 'agent' })] });

  it('drops offers to farms it cannot see, to AI farms, and outside its role', () => {
    const raw = {
      ...emptyDecision('n', 'r'),
      offers: [
        { kind: 'bulk-order', farmId: 'f1', qty: 10, priceShare: 0.7, line: '' },
        { kind: 'glut-warning', farmId: 'f1', line: '' },
        { kind: 'bulk-order', farmId: 'nowhere', qty: 10, priceShare: 0.7, line: '' },
        { kind: 'bulk-order', farmId: 'ai1', qty: 10, priceShare: 0.7, line: '' },
        { kind: 'feed-deal', farmId: 'f1', tier: 'cheap', bags: 2, priceShare: 1, line: '' },
      ],
    };
    const dropped: string[] = [];
    const d = validateDecision(raw, seen('wholesaler'), (w) => dropped.push(w));
    expect(d?.offers.map((o) => `${o.farmId}:${o.kind}`)).toEqual(['f1:bulk-order', 'f1:glut-warning']);
    expect(dropped).toHaveLength(3);
  });

  it('fills only orders it can see, no more than they hold; only buyers fill, only rivals sell', () => {
    const raw = { ...emptyDecision('n', 'r'), fills: [{ orderId: 'o1', qty: 50 }, { orderId: 'o1', qty: 5 }, { orderId: 'ghost', qty: 3 }], buyOrders: [{ grade: 'brown', qty: 4, priceShare: 1 }] };
    expect(validateDecision(raw, seen('bakery'))?.fills).toEqual([{ orderId: 'o1', qty: 6 }]);
    const asSupplier = validateDecision({ ...raw, restock: { cheap: 5, standard: 0, premium: 0 }, markup: 1.2 }, seen('squeezer'));
    expect(asSupplier).toMatchObject({ fills: [], buyOrders: [], restock: { cheap: 5 }, markup: 1.2 });
    const own = { hens: 10, capacity: 30, freePlots: 1, crate: { white: 3, cream: 0, brown: 1, golden: 0 }, feedGrams: { cheap: 0, standard: 0, premium: 0 }, feedTier: 'cheap' as const, unlocks: [], owes: 0 };
    const sell = { ...emptyDecision('n', 'r'), farmActions: [{ t: 'sell', items: { white: 99, cream: 5, brown: 1, golden: 0 } }, { t: 'sell', items: { white: 0, cream: 2, brown: 0, golden: 0 } }] };
    expect(validateDecision(sell, { ...seen('upstart'), own })?.farmActions).toEqual([{ t: 'sell', items: { white: 3, cream: 0, brown: 1, golden: 0 } }]);
    expect(validateDecision(sell, seen('bakery'))?.farmActions).toEqual([]);
  });

  it('cuts strings to their lengths without splitting a character, one line, no long dashes', () => {
    const dash = String.fromCharCode(0x2014);
    const long = `${'a'.repeat(79)}\u{1F95A}tail`;
    const d = validateDecision({ ...emptyDecision(`plan${dash}grow\nnow`, long), offers: [{ kind: 'glut-warning', farmId: 'f1', line: 'x'.repeat(300) }] }, seen('trader'));
    expect(d?.reason).toBe('a'.repeat(79));
    expect(d?.note).toBe('plan, grow now');
    expect(d?.offers[0]?.line).toHaveLength(160);
    expect(cleanText(`${'b'.repeat(79)}\u{1F95A}`, 80)).toBe('b'.repeat(79));
    expect(cleanText(`ok${String.fromCharCode(7)}fine`, 80)).toBe('ok fine');
    // the schema still refuses numbers out of range: the whole reply falls back to rules
    expect(validateDecision({ ...emptyDecision('n', 'r'), markup: 9 }, seen('squeezer'))).toBeNull();
    expect(parseDecision(JSON.stringify(emptyDecision('n', 'z'.repeat(200))))?.reason).toHaveLength(80);
  });

  it('a rule decision passes it unchanged, with a public reason under 80 characters, for every kind and market', () => {
    const own = { hens: 28, capacity: 30, freePlots: 2, crate: { white: 9, cream: 4, brown: 2, golden: 0 }, feedGrams: { cheap: 5000, standard: 0, premium: 0 }, feedTier: 'cheap' as const, unlocks: [], owes: 0 };
    const markets = [
      { supplyOverDemand: [1.3, 1.25, 1.2], slope: -0.1, multiplier: 0.7 },
      { supplyOverDemand: [0.8, 0.85, 0.9], slope: 0.05, multiplier: 1.3 },
      { supplyOverDemand: [1, 1, 1], slope: 0, multiplier: 1 },
    ];
    for (const kind of Object.keys(CAST) as (keyof typeof CAST)[]) {
      for (const mk of markets) {
        const c = ctx(kind, { own: CAST[kind].role === 'rival' ? own : null, market: { ...ctx(kind).market, multiplier: mk.multiplier, trend: { supplyOverDemand: mk.supplyOverDemand, slope: mk.slope } } });
        const rule = ruleDecision(c);
        expect(rule.reason.length).toBeGreaterThan(5);
        expect(rule.reason.length).toBeLessThanOrEqual(80);
        expect(validateDecision(rule, c)).toEqual(rule);
      }
    }
  });
});

describe('the rules read the trend', () => {
  const own = { hens: 20, capacity: 30, freePlots: 2, crate: { white: 0, cream: 0, brown: 0, golden: 0 }, feedGrams: { cheap: 50_000, standard: 0, premium: 0 }, feedTier: 'cheap' as const, unlocks: [], owes: 0 };
  const withTrend = (kind: AgentContext['agent']['kind'], supplyOverDemand: number[], slope = 0) =>
    ctx(kind, { own: CAST[kind].role === 'rival' ? own : null, market: { ...ctx(kind).market, multiplier: 1.1, trend: { supplyOverDemand, slope } } });
  const hens = (c: AgentContext) => ruleDecision(c).farmActions.reduce((n, a) => n + (a.t === 'buyHens' ? a.count : 0), 0);

  it('tells lasting scarcity from a building glut', () => {
    expect(scarceTrend(withTrend('upstart', [0.8, 0.9, 0.85]))).toBe(true);
    expect(glutTrend(withTrend('upstart', [1.1, 1.2, 1.15]))).toBe(true);
    expect(glutTrend(withTrend('upstart', [0.95, 1.0, 1.08], -0.05))).toBe(true);
    expect(scarceTrend(withTrend('upstart', [1, 1, 1])) || glutTrend(withTrend('upstart', [1, 1, 1]))).toBe(false);
  });

  it('rivals grow into scarcity and stop buying hens into a building glut (outside the Upstart boom)', () => {
    const scarce = hens(withTrend('upstart', [0.8, 0.85, 0.9]));
    const flat = hens(withTrend('upstart', [1, 1, 1]));
    expect(scarce).toBeGreaterThan(flat);
    expect(hens(withTrend('upstart', [1.2, 1.2, 1.2]))).toBe(0);
    expect(hens(withTrend('old-money', [1.2, 1.2, 1.2]))).toBe(0);
    expect(ruleDecision(withTrend('upstart', [1.2, 1.2, 1.2])).reason).toMatch(/glut/i);
  });

  it('buyers bid deeper in a glut and lighter in scarcity', () => {
    const volume = (kind: AgentContext['agent']['kind'], trend: number[]) => ruleDecision(withTrend(kind, trend)).buyOrders.reduce((n, b) => n + b.qty, 0);
    for (const kind of ['bakery', 'trader', 'wholesaler'] as const) {
      expect(volume(kind, [1.2, 1.25, 1.3])).toBeGreaterThan(volume(kind, [1, 1, 1]));
      expect(volume(kind, [0.8, 0.85, 0.9])).toBeLessThan(volume(kind, [1, 1, 1]));
    }
  });

  it('suppliers restock to the street demand, and the Squeezer still prices in desperation', () => {
    // 50 farms of 150 hens eat about 36 bags a day: half of that for five days is more than the 35 bags in stock
    const big = Array.from({ length: 50 }, (_, i) => farm({ farmId: `f${i}`, hens: 150, feedDays: 4, cash: 200 }));
    const stock = { cheap: 35, standard: 35, premium: 35 };
    const c = ctx('loyalist', { agent: { ...ctx('loyalist').agent, cash: 5000, stock }, farms: big });
    expect(ruleDecision(c).restock.standard).toBeGreaterThan(0);
    expect(ruleDecision(ctx('loyalist', { agent: { ...ctx('loyalist').agent, stock } })).restock.standard).toBe(0);
    const sq = ruleDecision(ctx('squeezer', { farms: [farm({ feedDays: 0.5, cash: 5 })] }));
    expect(sq.markup).toBeGreaterThan(1.1);
  });
});

describe('weekly reflections', () => {
  const week: WeekNumbers = { fromDay: 1, toDay: 8, cashStart: 60, cashNow: 41.5, deals: 3, refusals: 5, bustsSeen: 1, multiplierLow: 0.62, multiplierHigh: 1.31, glutDays: 3 };

  it('the rule template states the week in numbers and what changes, in character, under 400 characters', () => {
    for (const kind of Object.keys(CAST) as (keyof typeof CAST)[]) {
      const text = ruleReflection(ctx(kind), week);
      expect(text.length).toBeLessThanOrEqual(400);
      expect(text).toContain('Days 1 to 8: cash 60 to 42 (-18), 3 deals, 5 refusals, 1 bust seen, prices 0.62x to 1.31x (3 glut days).');
      expect(text).not.toContain(String.fromCharCode(0x2014));
      expect(text).toMatch(/Next week:/);
    }
    expect(ruleReflection(ctx('upstart'), week)).toMatch(/fewer new hens/);
  });

  it('the main model writes it when the caps allow; otherwise, or on an empty reply, the template', async () => {
    const db = await openDb('memory://');
    await migrate(db);
    const bodies: Record<string, unknown>[] = [];
    let reply = 'A hard week: too many hens into a glut. Next week I hold back and keep cash for feed.';
    const client = new NearAiClient({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 600, completion_tokens: 60 } }));
      }) as typeof fetch,
    });
    const opts = { client, budget: new InferenceBudget(db, 1), model: 'main', cheapModel: 'cheap', pricing: new Map(), log: () => undefined };
    expect(await reflect(ctx('upstart'), week, opts)).toMatchObject({ brain: 'nearai', model: 'main', text: reply });
    expect(bodies[0]?.model).toBe('main');
    expect(bodies[0]?.response_format).toBeUndefined();
    reply = '  ';
    expect(await reflect(ctx('upstart'), week, opts)).toMatchObject({ brain: 'rules', fallback: true, text: ruleReflection(ctx('upstart'), week) });
    expect(await reflect(ctx('upstart'), week, { ...opts, client: null })).toMatchObject({ brain: 'rules', fallback: false });
    await db.close();
  });
});

describe('haggling', () => {
  const p = CAST.bakery.personality;
  it('accepts an ask inside the walk-away price', () => {
    expect(haggleStep({ offer: 1000, reserve: 1100, round: 0, side: 'agent_buys' }, 1080, p)).toEqual({ outcome: 'accept', price: 1080 });
  });
  it('concedes part of the gap, then walks away after three rounds', () => {
    const r1 = haggleStep({ offer: 1000, reserve: 1100, round: 0, side: 'agent_buys' }, 1300, p);
    expect(r1.outcome).toBe('counter');
    if (r1.outcome === 'counter') expect(r1.offer).toBeCloseTo(1040, 5);
    expect(haggleStep({ offer: 1040, reserve: 1100, round: ECONOMY.haggle.maxRounds - 1, side: 'agent_buys' }, 1300, p)).toEqual({ outcome: 'walk', insulted: false });
  });
  it('proud agents walk away from insulting asks at once', () => {
    expect(haggleStep({ offer: 1000, reserve: 1080, round: 0, side: 'agent_buys' }, 2500, CAST['old-money'].personality)).toEqual({ outcome: 'walk', insulted: true });
  });
  it('remembers: farms that won haggles get less room next time', () => {
    const fresh = reserveFor('bakery', 1000, 'agent_buys', { deals: 0, hagglesWon: 0, misses: 0 });
    const burned = reserveFor('bakery', 1000, 'agent_buys', { deals: 0, hagglesWon: 3, misses: 0 });
    expect(burned).toBeLessThan(fresh);
  });
});

describe('model decisions', () => {
  const okDecision = { ...emptyDecision('ok', 'Buying a few whites.'), buyOrders: [{ grade: 'white', qty: 5, priceShare: 0.9 }] };
  const clientReturning = (content: string, calls: { body: Record<string, unknown> }[]) =>
    new NearAiClient({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
      }) as typeof fetch,
    });
  const brainOpts = async (client: NearAiClient, capUsd = 1, agentCap: { calls?: number; usd?: number } = {}) => {
    const db = await openDb('memory://');
    await migrate(db);
    return {
      db,
      opts: {
        client,
        budget: new InferenceBudget(db, capUsd, Date.now, agentCap),
        model: 'main',
        cheapModel: 'cheap',
        pricing: new Map([['main', { input: 1, output: 5 }]]),
        log: () => undefined,
      },
    };
  };

  it('asks for structured JSON output and accepts a valid decision; a routine day goes to the cheap model', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls));
    const r = await decide(ctx('bakery'), opts);
    expect(r).toMatchObject({ brain: 'nearai', model: 'cheap', fallback: false });
    expect(r.decision.reason).toBe('Buying a few whites.');
    expect(r.decision.buyOrders).toHaveLength(1);
    expect(calls[0]?.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'decision', strict: true } });
    expect((await opts.budget.usage()).calls).toBe(1);
    await db.close();
  });

  it('a malformed model response falls back to the rule policy and is logged', async () => {
    const { reason: _, ...noReason } = okDecision;
    for (const bad of ['not json at all', '{"note":"x"}', JSON.stringify({ ...okDecision, offers: [{ kind: 'free-money', farmId: 'f1' }] }), JSON.stringify(noReason)]) {
      const logs: string[] = [];
      const { db, opts } = await brainOpts(clientReturning(bad, []));
      const r = await decide(ctx('bakery'), { ...opts, log: (l: string) => logs.push(l) });
      expect(r).toMatchObject({ brain: 'rules', fallback: true });
      expect(r.decision).toEqual(ruleDecision(ctx('bakery')));
      expect(logs.join('\n')).toMatch(/did not match the decision schema/);
      expect((await opts.budget.usage()).fallbacks).toBe(1);
      await db.close();
    }
  });

  it('once the daily spend cap is reached, agents use rules', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    // the cap fits exactly one call's reserve (the prompt and a full reply); the agent's own cap is set wide
    const c = ctx('bakery');
    const reserve = (estimateTokens(`${SYSTEM(c)}\n${JSON.stringify(c)}`) * 1 + DECISION_MAX_TOKENS * 5) / 1e6;
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls), reserve, { usd: 1 });
    await decide(ctx('bakery'), opts);
    await decide(ctx('bakery'), opts);
    const third = await decide(ctx('bakery'), opts);
    expect(calls).toHaveLength(1);
    expect(third).toMatchObject({ brain: 'rules', fallback: true });
    await db.close();
  });

  it('a struggling agent thinks only every other day; the days it thinks are hard days, on the main model', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls));
    const poor = (day: number) => ctx('bakery', { day, agent: { ...ctx('bakery').agent, cash: 10, struggling: true } });
    const skipped = await decide(poor(5), opts);
    expect(skipped.brain).toBe('skipped');
    expect(skipped.decision.reason).toMatch(/ovens/i);
    expect((await decide(poor(6), opts)).model).toBe('main');
    expect(calls[0]?.body.model).toBe('main');
    await db.close();
  });

  it('a crash or glut day goes to the main model', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls));
    const crash = ctx('bakery', { market: { ...ctx('bakery').market, multiplier: 0.7, crash: true } });
    const glut = ctx('bakery', { market: { ...ctx('bakery').market, supplyYesterday: 400 } });
    expect((await decide(crash, opts)).model).toBe('main');
    expect((await decide(glut, opts)).model).toBe('main');
    expect(calls.map((c) => c.body.model)).toEqual(['main', 'main']);
    await db.close();
  });

  it('each agent has its own daily cap on calls and spend; past it, rules, counted as a fallback', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls), 1, { calls: 2 });
    for (let i = 0; i < 3; i++) await decide(ctx('bakery'), opts);
    const other = await decide({ ...ctx('trader'), agent: { ...ctx('trader').agent, id: 'a2' } }, opts);
    expect(calls).toHaveLength(3);
    expect(other.brain).toBe('nearai');
    expect(await opts.budget.agentUsage('a1')).toMatchObject({ calls: 2, fallbacks: 1 });
    expect((await opts.budget.usage()).fallbacks).toBe(1);
    // the spend cap: a reserve bigger than the agent's daily USD is refused at once
    const poor = await brainOpts(clientReturning(JSON.stringify(okDecision), []), 1, { usd: 0.0001 });
    expect(await decide(ctx('bakery'), poor.opts)).toMatchObject({ brain: 'rules', fallback: true });
    expect(poor.opts.budget.agentCap).toEqual({ calls: 40, usd: 0.0001 });
    // defaults: a quarter of the global cap and 40 calls
    expect(new InferenceBudget(db, 2).agentCap).toEqual({ calls: 40, usd: 0.5 });
    await db.close();
    await poor.db.close();
  });

  it('the system prompt carries the persona; entrants have their own', () => {
    expect(SYSTEM(ctx('squeezer'))).toContain(CAST.squeezer.persona);
    const entrant = ctx('upstart', { agent: { ...ctx('upstart').agent, entrant: 'early-bird', name: 'Early Bird Eggs' } });
    expect(SYSTEM(entrant)).toContain(ENTRANTS.find((e) => e.key === 'early-bird')?.persona ?? 'missing');
    for (const k of Object.keys(CAST) as (keyof typeof CAST)[]) expect(CAST[k].persona.length).toBeGreaterThan(100);
  });

  it('the decision schema is valid JSON Schema and parses fenced replies', () => {
    expect(decisionJsonSchema()).toMatchObject({ type: 'object' });
    expect(parseDecision('```json\n' + JSON.stringify(okDecision) + '\n```')?.note).toBe('ok');
  });
});

describe('sessions and rate limits', () => {
  it('verifies its own tokens and rejects tampered or expired ones', () => {
    let now = 1000;
    const s = createSessionSigner('secret', () => now);
    const token = s.sign('player-1', 500);
    expect(s.verify(token)).toBe('player-1');
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'player-2', e: 99999 })).toString('base64url');
    expect(s.verify(`${forged}.${sig}`)).toBeNull();
    now = 2000;
    expect(s.verify(token)).toBeNull();
  });
  it('allows a burst, then refills over time', () => {
    let now = 0;
    const r = new RateLimiter(3, 1, () => now);
    expect([r.take('a'), r.take('a'), r.take('a'), r.take('a')]).toEqual([true, true, true, false]);
    now = 1000;
    expect(r.take('a')).toBe(true);
  });
});
