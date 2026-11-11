import { afterEach, describe, expect, it } from 'vitest';
import { ECONOMY, feedGramsPerHenDay, marketMultiplier, toMilli, type GameEvent } from '@coys/shared';
import { RIVALS } from '../src/game/agents';
import { makeGame, type TestGame } from './helpers';

let t: TestGame | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const rid = (() => {
  let n = 0;
  return () => `r${++n}`;
})();

describe('a new farm', () => {
  it('starts with the economy start state and a balanced ledger', async () => {
    t = await makeGame();
    const { farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBe(toMilli(ECONOMY.start.cash));
    expect(farm.hens).toHaveLength(ECONOMY.start.hens);
    expect(farm.coops).toEqual([expect.objectContaining({ kind: 'starter', plot: 0 })]);
    // the hens ate one day of feed at dawn
    expect(farm.feedGrams.standard).toBe(ECONOMY.start.feed.kg * 1000 - ECONOMY.start.hens * feedGramsPerHenDay());
    expect(farm.fedToday).toBe(1);
    expect(farm.layPlan.length).toBeGreaterThan(0);
    for (const h of farm.hens) {
      expect(h.layingTrait).toBeGreaterThanOrEqual(ECONOMY.hen.trait.min);
      expect(h.layingTrait).toBeLessThanOrEqual(ECONOMY.hen.trait.max);
    }
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
    expect(farm.hens).toHaveLength(ECONOMY.start.hens + 2);

    const refused = await t.game.act(playerId, { t: 'buildCoop', rid: rid(), kind: 'red' });
    expect(refused).toMatchObject({ ok: false, code: 'insufficient_funds' });
    farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBe(toMilli(ECONOMY.start.cash - 2 * ECONOMY.hen.price));
    expect(farm.coops).toHaveLength(1);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
  });

  it('eggs can be collected by hand only once they are laid', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const farm = await t.game.getFarmState(farmId);
    const egg = farm.layPlan.find((e) => !e.broken);
    expect(egg).toBeDefined();
    if (!egg) return;
    const early = await t.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id });
    expect(early).toMatchObject({ ok: false, code: 'invalid_action' });
    t.clock.t += egg.atMs + 1;
    expect(await t.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id })).toMatchObject({ ok: true });
    expect((await t.game.getFarmState(farmId)).crate[egg.grade]).toBe(1);
    const again = await t.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id });
    expect(again).toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('selling pays the live price, adds to supply, and the close sets the next multiplier', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    let farm = await t.game.getFarmState(farmId);
    const eggs = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
    expect(eggs).toBeGreaterThan(0);
    const cashBefore = farm.cashMilli;
    const market = await t.game.getMarketState();
    expect(market.day).toBe(2);

    const result = await t.game.act(playerId, { t: 'sell', rid: rid(), items: farm.crate });
    expect(result.ok).toBe(true);
    const sold = (result as { events: GameEvent[] }).events[0];
    expect(sold?.kind).toBe('sold');
    farm = await t.game.getFarmState(farmId);
    const expected =
      farm.cashMilli - cashBefore === (sold as { totalMilli: number }).totalMilli &&
      (sold as { multiplier: number }).multiplier === market.multiplier;
    expect(expected).toBe(true);
    expect((await t.game.getMarketState()).supplyToday).toBe(eggs);

    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    const after = await t.game.getMarketState();
    expect(after.history.at(-1)).toEqual({ day: 2, supply: eggs, multiplier: market.multiplier });
    expect(after.multiplier).toBeCloseTo(marketMultiplier(eggs), 10);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
  });

  it('selling more eggs than the crate holds is refused', async () => {
    t = await makeGame();
    const { playerId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    const r = await t.game.act(playerId, { t: 'sell', rid: rid(), items: { golden: 5 } });
    expect(r).toMatchObject({ ok: false, code: 'insufficient_stock' });
  });
});

describe('the day close', () => {
  it('records one settlement batch per day with a digest of every farm net', async () => {
    t = await makeGame();
    await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    t.clock.t += ECONOMY.day.lengthMs;
    expect(await t.game.tickIfDue()).toBe(true);
    expect(t.settlement.payloads).toHaveLength(1);
    const p = t.settlement.payloads[0];
    expect(p).toMatchObject({ game: 'chickens-of-yolk-street', day: 1 });
    expect(p?.digest).toMatch(/^[0-9a-f]{64}$/);
    const market = await t.game.getMarketState();
    expect(market.settlement).toEqual({ day: 1, status: 'noop', txHash: null });
  });

  it('rivals sell into the same market and every ledger balances', async () => {
    t = await makeGame({ rivals: RIVALS });
    const { farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    for (let d = 0; d < 4; d++) {
      t.clock.t += ECONOMY.day.lengthMs;
      await t.game.endDay();
    }
    const market = await t.game.getMarketState();
    expect(market.farms).toMatchObject({ players: 1, agents: 2 });
    expect(market.history.some((d) => d.supply > 0)).toBe(true);
    const farms = await t.db.query<{ id: string; cash_milli: unknown }>('SELECT id, cash_milli FROM farms');
    for (const f of farms) expect(await t.game.ledgerTotal(f.id)).toBe(Number(f.cash_milli));
    expect(await t.game.ledgerTotal(farmId)).toBe((await t.game.getFarmState(farmId)).cashMilli);
  });
});
