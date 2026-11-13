// Machines at work: a farm with all five, over three in-game days, shows each one's effect in its
// state (eggs carried into the crate, the trough topped up) and in the daily tally the machine cards
// and the ledger read.
import { describe, expect, it } from 'vitest';
import { ECONOMY, UNLOCK_IDS, feedGramsPerHenDay, toMilli } from '@coys/shared';
import { moveCash, newId } from '../src/game/ctx';
import { makeGame } from './helpers';

describe('machines at work', () => {
  it('conveyor, grader, cart, hopper and clerk each do their job over three days', async () => {
    const t = await makeGame({ cast: true, seed: 21 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-machines', 'Mo');
    await t.game.withCtx((ctx) => moveCash(ctx, farmId, 'start', toMilli(2000), 'test funds'));
    for (const unlock of UNLOCK_IDS) expect(await t.game.act(playerId, { t: 'buyUnlock', rid: `u-${unlock}`, unlock })).toMatchObject({ ok: true });
    // a standing contract for the cart, and a near-empty trough for the hopper
    const [bakery] = await t.db.query(`SELECT id FROM agents WHERE kind = 'bakery'`);
    const day0 = t.game.getClock().day;
    await t.db.query(`INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day) VALUES ($1, $2, $3, 'any', 2, 1200, $4, $5)`, [
      newId(),
      farmId,
      bakery?.id,
      day0,
      day0 + 5,
    ]);
    await t.db.query(`UPDATE farms SET feed_cheap_g = 0, feed_standard_g = $2, feed_premium_g = 0, crate_white = 6 WHERE id = $1`, [farmId, feedGramsPerHenDay() * 10]);

    const days: number[] = [];
    for (let i = 0; i < 3; i++) {
      const clock = t.game.getClock();
      days.push(clock.day);
      // late in the day: every egg laid so far has ridden the belt into the crate
      t.clock.t = clock.dayStartedAt + Math.floor(ECONOMY.day.lengthMs * 0.9);
      await t.game.tick();
      const farm = await t.game.getFarmState(farmId);
      const laid = farm.layPlan.filter((e) => !e.broken && e.atMs <= Math.floor(ECONOMY.day.lengthMs * 0.9) - ECONOMY.unlocks.conveyor.carryMs);
      expect(laid.every((e) => e.collected), 'the conveyor carried every egg laid in time').toBe(true);
      // keep two eggs for the cart, sell the rest through the grader and the clerk
      const crate = { ...farm.crate };
      if (crate.white >= 2) crate.white -= 2;
      if (crate.white + crate.cream + crate.brown + crate.golden > 0) expect(await t.game.act(playerId, { t: 'sell', rid: `s${i}`, items: crate })).toMatchObject({ ok: true });
      t.clock.t = clock.dayStartedAt + ECONOMY.day.lengthMs;
      await t.game.endDay();
    }

    const tally = async (day: number) => (await t.game.withCtx(async (ctx) => (await import('../src/game/machines')).machineDay(ctx.q, farmId, day)));
    const all = await Promise.all(days.map(tally));
    const sum = (u: (typeof UNLOCK_IDS)[number], k: 'units' | 'saved' | 'milli') => all.reduce((n, d) => n + (d[u]?.[k] ?? 0), 0);
    expect(sum('conveyor', 'units'), 'eggs carried').toBeGreaterThan(0);
    expect(sum('grader', 'units'), 'eggs graded').toBeGreaterThan(0);
    expect(sum('grader', 'milli'), 'coins the grader added').toBeGreaterThan(0);
    expect(sum('clerk', 'milli'), 'coins the clerk added').toBeGreaterThan(0);
    expect(sum('cart', 'units'), 'eggs the cart delivered').toBeGreaterThan(0);
    expect(sum('hopper', 'units'), 'bags the hopper poured').toBeGreaterThan(0);
    expect(sum('hopper', 'milli'), 'coins the hopper saved').toBeGreaterThan(0);

    // the farm state carries today's tally, and the ledger each day's
    const ledger = await t.game.getLedger(farmId);
    const withMachines = ledger.filter((d) => d.machines && Object.keys(d.machines).length > 0);
    expect(withMachines.length).toBeGreaterThanOrEqual(2);
    expect(withMachines.some((d) => (d.machines?.hopper?.milli ?? 0) > 0)).toBe(true);
    const farm = await t.game.getFarmState(farmId);
    expect(farm.machines).toBeTypeOf('object');
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
    await t.db.close();
  });

  it('the hopper never pays over its cap', async () => {
    const t = await makeGame({ cast: true, seed: 4 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-cap', 'Cap');
    await t.game.withCtx((ctx) => moveCash(ctx, farmId, 'start', toMilli(500), 'test funds'));
    expect(await t.game.act(playerId, { t: 'buyUnlock', rid: 'h', unlock: 'hopper' })).toMatchObject({ ok: true });
    expect(await t.game.act(playerId, { t: 'setHopperCap', rid: 'c', cap: 1 })).toMatchObject({ ok: true });
    await t.db.query(`UPDATE farms SET feed_cheap_g = 0, feed_standard_g = 0, feed_premium_g = 0 WHERE id = $1`, [farmId]);
    const day = t.game.getClock().day;
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    const tally = await t.game.withCtx(async (ctx) => (await import('../src/game/machines')).machineDay(ctx.q, farmId, day + 1));
    expect(tally.hopper?.units ?? 0).toBe(0);
    expect((await t.game.getFarmState(farmId)).hopperCapMilli).toBe(1000);
    await t.db.close();
  });
});

describe('machine wear', () => {
  const setup = async () => {
    const t = await makeGame({ cast: true, seed: 33 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-wear', 'Wren');
    await t.game.withCtx((ctx) => moveCash(ctx, farmId, 'start', toMilli(2000), 'test funds'));
    for (const unlock of UNLOCK_IDS) expect(await t.game.act(playerId, { t: 'buyUnlock', rid: `u-${unlock}`, unlock })).toMatchObject({ ok: true });
    const closeDay = async () => {
      t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
      await t.game.endDay();
    };
    return { t, playerId, farmId, closeDay };
  };

  it('a machine that works loses its daily wear; one that stands idle does not', async () => {
    const { t, playerId, farmId, closeDay } = await setup();
    // a sale works the grader and the clerk; nothing works the hopper (the trough is full)
    await t.db.query(`UPDATE farms SET crate_white = 10, feed_standard_g = $2 WHERE id = $1`, [farmId, feedGramsPerHenDay() * 400]);
    expect(await t.game.act(playerId, { t: 'sell', rid: 's', items: { white: 10 } })).toMatchObject({ ok: true });
    await closeDay();
    const s = (await t.game.getFarmState(farmId)).machineState;
    expect(s.grader?.condition).toBeCloseTo(1 - ECONOMY.unlocks.grader.wear);
    expect(s.clerk?.condition).toBeCloseTo(1 - ECONOMY.unlocks.clerk.wear);
    expect(s.hopper?.condition).toBe(1);
    expect(s.grader?.effect).toBe(1);
    await t.db.close();
  });

  it('a worn machine gives less, a broken one nothing, and a repair restores it for its price share', async () => {
    const { t, playerId, farmId } = await setup();
    const sale = async (rid: string) => {
      await t.db.query(`UPDATE farms SET crate_white = 10 WHERE id = $1`, [farmId]);
      const before = (await t.game.getFarmState(farmId)).cashMilli;
      expect(await t.game.act(playerId, { t: 'sell', rid, items: { white: 10 } })).toMatchObject({ ok: true });
      return (await t.game.getFarmState(farmId)).cashMilli - before;
    };
    const full = await sale('full');
    // the grader at 25%: half its +10%; broken: none of it
    await t.db.query(`UPDATE unlocks SET condition = 0.25 WHERE farm_id = $1 AND unlock_id = 'grader'`, [farmId]);
    const worn = await sale('worn');
    await t.db.query(`UPDATE unlocks SET broken = true WHERE farm_id = $1 AND unlock_id = 'grader'`, [farmId]);
    const broken = await sale('broken');
    expect(worn).toBeLessThan(full);
    expect(broken).toBeLessThan(worn);
    expect((full - broken) / (full - worn)).toBeCloseTo(2, 0);
    const state = (await t.game.getFarmState(farmId)).machineState.grader;
    expect(state).toMatchObject({ broken: true, effect: 0 });
    expect(state?.repairMilli).toBe(toMilli(ECONOMY.unlocks.grader.price * ECONOMY.wear.repairShare * 0.75));
    const cash = (await t.game.getFarmState(farmId)).cashMilli;
    expect(await t.game.act(playerId, { t: 'repairMachine', rid: 'fix', unlock: 'grader' })).toMatchObject({ ok: true });
    const after = await t.game.getFarmState(farmId);
    expect(after.machineState.grader).toMatchObject({ condition: 1, broken: false, effect: 1, repairMilli: 0 });
    expect(cash - after.cashMilli).toBe(state?.repairMilli);
    expect(await t.game.act(playerId, { t: 'repairMachine', rid: 'again', unlock: 'grader' })).toMatchObject({ ok: false, code: 'invalid_action' });
    expect(await t.game.ledgerTotal(farmId)).toBe(after.cashMilli);
    await t.db.close();
  });

  it('under 20% a machine breaks down at a day close sooner or later, and a broken machine stops', async () => {
    const { t, farmId, closeDay } = await setup();
    await t.db.query(`UPDATE unlocks SET condition = 0.1 WHERE farm_id = $1`, [farmId]);
    for (let i = 0; i < 40; i++) {
      await closeDay();
      const s = (await t.game.getFarmState(farmId)).machineState;
      if (UNLOCK_IDS.every((u) => s[u]?.broken)) break;
    }
    const s = (await t.game.getFarmState(farmId)).machineState;
    expect(UNLOCK_IDS.every((u) => s[u]?.broken), JSON.stringify(s)).toBe(true);
    // a broken conveyor carries nothing: late in the day the eggs are still on the ground
    const clock = t.game.getClock();
    t.clock.t = clock.dayStartedAt + Math.floor(ECONOMY.day.lengthMs * 0.9);
    await t.game.tick();
    const farm = await t.game.getFarmState(farmId);
    expect(farm.layPlan.filter((e) => !e.broken && e.atMs < ECONOMY.day.lengthMs * 0.5).every((e) => !e.collected)).toBe(true);
    await t.db.close();
  });

  it('the cart wears at each delivery', async () => {
    const { t, playerId, farmId, closeDay } = await setup();
    void playerId;
    const [bakery] = await t.db.query(`SELECT id FROM agents WHERE kind = 'bakery'`);
    const day0 = t.game.getClock().day;
    await t.db.query(`INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day) VALUES ($1, $2, $3, 'any', 2, 1200, $4, $5)`, [newId(), farmId, bakery?.id, day0, day0 + 5]);
    await t.db.query(`UPDATE farms SET crate_white = 20 WHERE id = $1`, [farmId]);
    await closeDay();
    expect((await t.game.getFarmState(farmId)).machineState.cart?.condition).toBeCloseTo(1 - ECONOMY.unlocks.cart.wear);
    await t.db.close();
  });
});
