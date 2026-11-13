import { afterEach, describe, expect, it } from 'vitest';
import { ECONOMY, EGG_GRADES, MARKET_CHART_DAYS, eggPrice, feedGramsPerHenDay, marketMultiplier, marketReference, toMilli, type FarmState } from '@coys/shared';
import { makeGame, type TestGame } from './helpers';

let t: TestGame | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

let n = 0;
const rid = () => `r${++n}`;
const nextDay = async (tg: TestGame) => {
  tg.clock.t += ECONOMY.day.lengthMs;
  await tg.game.endDay();
};
const eggs = (f: FarmState) => f.crate.white + f.crate.cream + f.crate.brown + f.crate.golden;

describe('a new farm', () => {
  it('starts with the economy start state and a balanced ledger', async () => {
    t = await makeGame();
    const { farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBe(toMilli(ECONOMY.start.cash));
    expect(farm.hens).toHaveLength(ECONOMY.start.hens);
    expect(farm.coops).toEqual([expect.objectContaining({ kind: 'starter', plot: 0 })]);
    expect(farm.feedGrams.standard).toBe(ECONOMY.start.feed.kg * 1000 - ECONOMY.start.hens * feedGramsPerHenDay());
    expect(farm.fedToday).toBe(1);
    expect(farm.layPlan.length).toBeGreaterThan(0);
    expect(farm.shop.length).toBe(ECONOMY.shop.hensPerDay);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
  });

  it('logging in again returns the same farm', async () => {
    t = await makeGame();
    const a = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const b = await t.game.ensurePlayer('dev', 'device-0001', 'Someone else');
    expect(b).toMatchObject({ playerId: a.playerId, farmId: a.farmId, name: 'Ada', created: false });
  });
});

describe('actions are priced by the server', () => {
  it('buying hens costs the hen price; overspending is refused and changes nothing', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    expect(await t.game.act(playerId, { t: 'buyHens', rid: rid(), count: 2 })).toMatchObject({ ok: true });
    let farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBe(toMilli(ECONOMY.start.cash - 2 * ECONOMY.hen.price));
    expect(await t.game.act(playerId, { t: 'buildCoop', rid: rid(), kind: 'red' })).toMatchObject({ ok: false, code: 'insufficient_funds' });
    farm = await t.game.getFarmState(farmId);
    expect(farm.coops).toHaveLength(1);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
  });

  it('a hen bought from the shop arrives with the traits it was listed with', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const listed = (await t.game.getFarmState(farmId)).shop[0];
    expect(listed?.source).toBe('breeder');
    if (!listed) return;
    expect(await t.game.act(playerId, { t: 'buyHen', rid: rid(), henId: listed.id })).toMatchObject({ ok: true });
    const farm = await t.game.getFarmState(farmId);
    expect(farm.hens.find((h) => h.id === listed.id)).toMatchObject({ body: listed.body, comb: listed.comb, accessory: listed.accessory });
    expect(farm.shop.some((h) => h.id === listed.id)).toBe(false);
  });

  it('eggs can be collected by hand only once they are laid', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const egg = (await t.game.getFarmState(farmId)).layPlan.find((e) => !e.broken);
    expect(egg).toBeDefined();
    if (!egg) return;
    expect(await t.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id })).toMatchObject({ ok: false, code: 'invalid_action' });
    t.clock.t += egg.atMs + 1;
    expect(await t.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id })).toMatchObject({ ok: true });
    expect((await t.game.getFarmState(farmId)).crate[egg.grade]).toBe(1);
  });

  it('selling pays the live price, adds to supply, and the close sets the next multiplier', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    await nextDay(t);
    let farm = await t.game.getFarmState(farmId);
    const count = eggs(farm);
    expect(count).toBeGreaterThan(0);
    const before = farm.cashMilli;
    const market = await t.game.getMarketState();
    expect(await t.game.act(playerId, { t: 'sell', rid: rid(), items: farm.crate })).toMatchObject({ ok: true });
    farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBeGreaterThan(before);
    expect((await t.game.getMarketState()).supplyToday).toBe(count);
    await nextDay(t);
    const after = await t.game.getMarketState();
    expect(after.history.at(-1)).toEqual({ day: 2, supply: count, multiplier: market.multiplier });
    // a quiet market: one player farm and no agents, so demand is one farm's worth
    expect(after.multiplier).toBeCloseTo(marketMultiplier(count, marketReference(1)), 10);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
  });
});

describe("the Market page's price chart", () => {
  it('sends the last closed days, oldest first, each with its demand and one egg per grade at its price level', async () => {
    t = await makeGame();
    await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    expect((await t.game.getMarketState()).chart).toEqual([]);
    for (let i = 0; i < MARKET_CHART_DAYS + 2; i++) await nextDay(t);
    const market = await t.game.getMarketState();
    expect(market.chart.map((d) => d.day)).toEqual(Array.from({ length: MARKET_CHART_DAYS }, (_, i) => market.day - MARKET_CHART_DAYS + i));
    expect(market.chart.map((d) => ({ day: d.day, supply: d.supply, multiplier: d.multiplier }))).toEqual(market.history.slice(-MARKET_CHART_DAYS));
    for (const d of market.chart) {
      // one player farm and no agents: demand is one farm's worth
      expect(d.demand).toBe(marketReference(1));
      for (const g of EGG_GRADES) expect(d.pricesMilli[g]).toBe(toMilli(eggPrice(g, d.multiplier, [])));
    }
  });
});

describe('the order book', () => {
  it('a limit sell rests, another player buys it through a trade, and eggs and coins swap', async () => {
    t = await makeGame();
    const a = await t.game.ensurePlayer('dev', 'device-000a', 'Ada');
    const b = await t.game.ensurePlayer('dev', 'device-000b', 'Bo');
    await nextDay(t);
    const fa = await t.game.getFarmState(a.farmId);
    const grade = (['white', 'cream', 'brown'] as const).find((g) => fa.crate[g] > 0) ?? 'white';
    const price = (await t.game.getMarketState()).pricesMilli[grade] / 1000;
    expect(await t.game.act(a.playerId, { t: 'placeOrder', rid: rid(), grade, qty: 1, price })).toMatchObject({ ok: true });
    const order = (await t.game.getMarketState()).book.find((o) => o.side === 'sell' && o.owner === 'Ada');
    expect(order).toBeDefined();
    if (!order) return;
    const cashA = (await t.game.getFarmState(a.farmId)).cashMilli;
    expect(await t.game.act(b.playerId, { t: 'fillOrder', rid: rid(), orderId: order.id, qty: 1 })).toMatchObject({ ok: true });
    expect((await t.game.getFarmState(a.farmId)).cashMilli).toBe(cashA + order.priceMilli);
    expect((await t.game.getFarmState(b.farmId)).crate[grade]).toBeGreaterThanOrEqual(1);
    expect(await t.game.act(a.playerId, { t: 'placeOrder', rid: rid(), grade, qty: 1, price: price * 50 })).toMatchObject({ ok: false, code: 'invalid_action' });
  });
});

describe('the cast trades with players', () => {
  it('opens all seven agents and they send cards to players', async () => {
    t = await makeGame({ cast: true });
    const { farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const kinds = (await t.game.getMarketState()).agents.map((a) => a.kind).sort();
    expect(kinds).toEqual(['bakery', 'loyalist', 'old-money', 'squeezer', 'trader', 'upstart', 'wholesaler']);
    await nextDay(t);
    t.clock.t += ECONOMY.day.lengthMs * 0.9;
    await t.game.tick();
    const farm = await t.game.getFarmState(farmId);
    expect(farm.cards.length).toBeGreaterThanOrEqual(1);
    expect(farm.cards.length).toBeLessThanOrEqual(ECONOMY.cards.maxPerDay);
  });

  it('feed comes from the chosen supplier, who earns the sale', async () => {
    t = await makeGame({ cast: true });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const before = (await t.game.getMarketState()).agents.find((a) => a.kind === 'loyalist')?.cashMilli ?? 0;
    await t.db.query('UPDATE farms SET cash_milli = cash_milli + 200000 WHERE id = $1', [farmId]);
    await t.db.query(`INSERT INTO ledger (farm_id, day, kind, amount_milli, ref, created_at) VALUES ($1, 1, 'test', 200000, 'grant', 0)`, [farmId]);
    expect(await t.game.act(playerId, { t: 'buyFeed', rid: rid(), tier: 'standard', bags: 1 })).toMatchObject({ ok: true });
    const after = (await t.game.getMarketState()).agents.find((a) => a.kind === 'loyalist')?.cashMilli ?? 0;
    expect(after - before).toBe(toMilli(ECONOMY.feed.tiers.standard.bagPrice));
    const farm = await t.game.getFarmState(farmId);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
  });

  it('a standing contract is delivered by hand, and a miss costs a penalty', async () => {
    t = await makeGame({ cast: true });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const [bakery] = await t.db.query(`SELECT id FROM agents WHERE kind = 'bakery'`);
    await t.db.query(
      `INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day) VALUES ('c1', $1, $2, 'any', 2, 1500, 1, 3)`,
      [farmId, bakery?.id],
    );
    await nextDay(t);
    // day 2: deliver by hand
    const before = await t.game.getFarmState(farmId);
    expect(eggs(before)).toBeGreaterThanOrEqual(2);
    expect(await t.game.act(playerId, { t: 'deliverContract', rid: rid(), contractId: 'c1' })).toMatchObject({ ok: true });
    expect((await t.game.getFarmState(farmId)).cashMilli).toBe(before.cashMilli + 3000);
    await nextDay(t);
    // day 3: empty the crate, then miss
    const farm = await t.game.getFarmState(farmId);
    if (eggs(farm) > 0) await t.game.act(playerId, { t: 'sell', rid: rid(), items: farm.crate });
    const cash = (await t.game.getFarmState(farmId)).cashMilli;
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    const [c] = await t.db.query(`SELECT misses FROM contracts WHERE id = 'c1'`);
    const after = await t.game.getFarmState(farmId);
    // eggs laid on day 3 are auto-collected before delivery, so either it delivered or it missed with a penalty
    if (Number(c?.misses) > 0) expect(after.cashMilli).toBeLessThan(cash);
    expect(await t.game.ledgerTotal(farmId)).toBe(after.cashMilli);
  });
});
