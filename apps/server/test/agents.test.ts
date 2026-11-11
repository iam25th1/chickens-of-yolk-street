import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { NearAiClient } from '../src/ai/nearai';
import { InferenceBudget, decide } from '../src/agents/brain';
import { CAST, reserveFor } from '../src/agents/cast';
import { decisionJsonSchema, emptyDecision, parseDecision, type AgentContext } from '../src/agents/decision';
import { haggleStep } from '../src/agents/haggle';
import { ruleDecision } from '../src/agents/rules';
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
  agent: { id: 'a1', kind, role: CAST[kind].role, name: CAST[kind].names[0] ?? kind, cash: 500, stock: { cheap: 10, standard: 10, premium: 10 }, struggling: false },
  market: { multiplier: 1.2, prices: { white: 1.2, cream: 1.44, brown: 1.8, golden: 7.2 }, supplyYesterday: 300, history: [], crash: false, auctionHens: 0 },
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

  it('the wholesaler offers to buy a big crate cheap and warns of a glut', () => {
    const d = ruleDecision(ctx('wholesaler', { market: { ...ctx('wholesaler').market, supplyYesterday: 900 } }));
    expect(d.offers.map((o) => o.kind).sort()).toEqual(['bulk-order', 'glut-warning']);
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
  const okDecision = { ...emptyDecision('ok'), buyOrders: [{ grade: 'white', qty: 5, priceShare: 0.9 }] };
  const clientReturning = (content: string, calls: { body: Record<string, unknown> }[]) =>
    new NearAiClient({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
      }) as typeof fetch,
    });
  const brainOpts = async (client: NearAiClient, capUsd = 1) => {
    const db = await openDb('memory://');
    await migrate(db);
    return {
      db,
      opts: {
        client,
        budget: new InferenceBudget(db, capUsd),
        model: 'main',
        cheapModel: 'cheap',
        pricing: new Map([['main', { input: 1, output: 5 }]]),
        log: () => undefined,
      },
    };
  };

  it('asks for structured JSON output and accepts a valid decision', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls));
    const r = await decide(ctx('bakery'), opts);
    expect(r).toMatchObject({ brain: 'nearai', model: 'main', fallback: false });
    expect(r.decision.buyOrders).toHaveLength(1);
    expect(calls[0]?.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'decision', strict: true } });
    expect((await opts.budget.usage()).calls).toBe(1);
    await db.close();
  });

  it('a malformed model response falls back to the rule policy and is logged', async () => {
    for (const bad of ['not json at all', '{"note":"x"}', JSON.stringify({ ...okDecision, offers: [{ kind: 'free-money', farmId: 'f1' }] })]) {
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
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls), 0.011);
    await decide(ctx('bakery'), opts);
    await decide(ctx('bakery'), opts);
    const third = await decide(ctx('bakery'), opts);
    expect(calls).toHaveLength(1);
    expect(third).toMatchObject({ brain: 'rules', fallback: true });
    await db.close();
  });

  it('a struggling agent thinks only every other day, on the cheaper model', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const { db, opts } = await brainOpts(clientReturning(JSON.stringify(okDecision), calls));
    const poor = (day: number) => ctx('bakery', { day, agent: { ...ctx('bakery').agent, cash: 10, struggling: true } });
    expect((await decide(poor(5), opts)).brain).toBe('skipped');
    expect((await decide(poor(6), opts)).model).toBe('cheap');
    expect(calls[0]?.body.model).toBe('cheap');
    await db.close();
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
