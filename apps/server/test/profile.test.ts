// The profile's records: every day close writes a row per farm (coins, net worth, rank, eggs by grade,
// profit, share), the private profile reads them, and a farm from before the profile is filled in
// from its history once, at boot: the same coins, profit, rank and sales the live record writes, its
// counters from the ledger, trades and agents' memories, and its badges earned quietly.
import { afterEach, describe, expect, it } from 'vitest';
import { ECONOMY, EGG_GRADES, type GameEvent } from '@coys/shared';
import { evaluateBadges } from '../src/game/badges';
import { backfillProfiles, worthOf } from '../src/game/profile';
import { makeGame, type TestGame } from './helpers';

let t: TestGame | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

let n = 0;
const rid = () => `p${++n}`;
const nextDay = async (tg: TestGame) => {
  tg.clock.t += ECONOMY.day.lengthMs;
  await tg.game.endDay();
};

/** A player on a street with the cast who collects, sells, delivers, fills a buyer's order and repairs over three days. */
async function played() {
  t = await makeGame({ cast: true, seed: 4 });
  const tg = t;
  const { playerId, farmId } = await tg.game.ensurePlayer('dev', 'device-profile', 'Prue');
  const egg = (await tg.game.getFarmState(farmId)).layPlan.find((e) => !e.broken);
  if (!egg) throw new Error('no egg');
  tg.clock.t += egg.atMs + 1;
  expect(await tg.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id })).toMatchObject({ ok: true });
  await tg.db.query('UPDATE farms SET crate_white = crate_white + 20, crate_brown = 6 WHERE id = $1', [farmId]);
  expect(await tg.game.act(playerId, { t: 'sell', rid: rid(), items: { white: 5, brown: 2 } })).toMatchObject({ ok: true });
  const [bakery] = await tg.db.query(`SELECT id FROM agents WHERE kind = 'bakery'`);
  await tg.db.query(`INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day) VALUES ('k1', $1, $2, 'white', 2, 1500, 1, 1)`, [farmId, bakery?.id]);
  expect(await tg.game.act(playerId, { t: 'deliverContract', rid: rid(), contractId: 'k1' })).toMatchObject({ ok: true });
  const [wholesaler] = await tg.db.query(`SELECT id FROM agents WHERE kind = 'wholesaler'`);
  await tg.db.query(`INSERT INTO orders (id, deal_id, agent_id, day, side, kind, grade, qty, price_milli, status, created_at, expires_day) VALUES ('ob', 'ob', $1, 1, 'buy', 'limit', 'white', 2, 900, 'open', 0, 3)`, [
    wholesaler?.id,
  ]);
  expect(await tg.game.act(playerId, { t: 'fillOrder', rid: rid(), orderId: 'ob', qty: 2 })).toMatchObject({ ok: true });
  await tg.db.query(`UPDATE agent_memory SET haggles_lost = 2 WHERE farm_id = $1 AND agent_id = $2`, [farmId, bakery?.id]);
  await nextDay(tg);
  await tg.db.query(`INSERT INTO unlocks (farm_id, unlock_id, bought_day, condition) VALUES ($1, 'cart', 2, 0.5)`, [farmId]);
  await tg.db.query('UPDATE farms SET cash_milli = cash_milli + 100000 WHERE id = $1', [farmId]);
  await tg.db.query(`INSERT INTO ledger (farm_id, day, kind, amount_milli, ref, created_at) VALUES ($1, 2, 'goal', 100000, 'test', 0)`, [farmId]);
  expect(await tg.game.act(playerId, { t: 'repairMachine', rid: rid(), unlock: 'cart' })).toMatchObject({ ok: true });
  await nextDay(tg);
  await nextDay(tg);
  return { tg, playerId, farmId };
}

describe('the day record', () => {
  it('each close writes a row per open farm: coins, net worth, rank among the open farms, eggs by grade, profit and share', async () => {
    const { tg, farmId } = await played();
    const rows = await tg.db.query('SELECT * FROM farm_days WHERE farm_id = $1 ORDER BY day', [farmId]);
    expect(rows.map((r) => r.day)).toEqual([1, 2, 3]);
    const [d1] = rows;
    expect(d1?.estimated).toBe(false);
    expect(Number(d1?.sold_n)).toBe(5 + 2 + 2 + 2);
    expect(d1?.sold).toMatchObject({ white: 9, brown: 2 });
    const [md] = await tg.db.query('SELECT supply FROM market_days WHERE day = 1');
    expect(Number(d1?.share)).toBeCloseTo(11 / Number(md?.supply), 6);
    expect(Number(d1?.laid_n)).toBe(Object.values(d1?.laid as Record<string, number>).reduce((a, b) => a + b, 0));
    const sum = (m: unknown) => Object.values(m as Record<string, number>).reduce((a, b) => a + b, 0);
    // the egg picked up by hand is collected; the rest went to the crate at midnight or cracked
    expect(sum(d1?.collected)).toBeGreaterThanOrEqual(1);
    expect(sum(d1?.collected) + sum(d1?.broken)).toBeLessThanOrEqual(Number(d1?.laid_n));
    // every open farm has its row and its place; the places run 1..open
    const day1 = await tg.db.query('SELECT rank, open_farms FROM farm_days WHERE day = 1 AND rank IS NOT NULL ORDER BY rank');
    expect(day1.map((r) => Number(r.rank))).toEqual(day1.map((_, i) => i + 1));
    expect(Number(day1[0]?.open_farms)).toBe(day1.length);
    // profit is the day's ledger without the opening balance
    const [p] = await tg.db.query(`SELECT SUM(amount_milli) AS p FROM ledger WHERE farm_id = $1 AND day = 1 AND kind <> 'start'`, [farmId]);
    expect(Number(d1?.profit_milli)).toBe(Number(p?.p));
    expect(Number(d1?.net_worth_milli)).toBeGreaterThan(Number(d1?.cash_milli));
    expect(d1?.good).toBe(true);
  });

  it('the private profile: overview, eggs, money, flock, machines, market, mint and badges', async () => {
    const { tg, playerId, farmId } = await played();
    const heard: unknown[] = [];
    tg.game.on((o) => {
      if (o.msg.t === 'profile') heard.push(o);
    });
    expect(await tg.game.act(playerId, { t: 'getProfile', rid: rid() })).toMatchObject({ ok: true });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ playerId });
    const p = await tg.game.getProfile(farmId);
    const farm = await tg.game.getFarmState(farmId);
    expect(p).toMatchObject({ farmId, name: 'Prue', day: 4, createdDay: 1, daysPlayed: 3, cashMilli: farm.cashMilli });
    expect(p.days.map((d) => d.day)).toEqual([1, 2, 3]);
    expect(p.rank).toBeGreaterThanOrEqual(1);
    expect(p.farms).toBeGreaterThanOrEqual(p.rank ?? 0);
    const hensMilli = farm.hens.length * ECONOMY.hen.price * 1000;
    expect(p.netWorth).toMatchObject({ cashMilli: farm.cashMilli, hensMilli, coopsMilli: 0, machinesMilli: ECONOMY.unlocks.cart.price * 1000 });
    expect(p.netWorthMilli).toBe(worthOf(farm.cashMilli, farm.hens.length, ['starter'], [{ unlock: 'cart', condition: 1 }]).totalMilli);
    expect(p.eggs.sold).toMatchObject({ white: 9, brown: 2 });
    expect(p.eggs.since).toBe(1);
    expect(p.eggs.totals.picked).toBe(1);
    expect(p.eggs.totals.laid).toBe(EGG_GRADES.reduce((s, g) => s + p.eggs.laid[g], 0));
    expect(p.money.byKind.sale).toBeGreaterThan(0);
    expect(p.money.byKind.repair).toBeLessThan(0);
    expect(p.money.byKind.start).toBeUndefined();
    expect(p.money.best?.day).toBeDefined();
    expect(p.flock.traitsSeen.length).toBeGreaterThanOrEqual(4);
    expect(p.machines).toMatchObject({ repairs: 1, breakdowns: 0, repairStreak: 1, bestRepairStreak: 1, daysNoBreakdown: 2 });
    expect(p.market).toMatchObject({ contractsTaken: 1, contractsKept: 1, contractMisses: 0, deliveries: 1, deliveryStreak: 1, ordersFilled: 1, eggsSold: 11 });
    // (a milestone's roll depends on the season's random name: any tickets won are counted)
    expect(p.mint.ticketsWon).toBe(farm.tickets.length);
    expect(p.mint.milestones).toBe(farm.milestones.filter((m) => m.state !== 'open').length);
    expect(p.badges.length).toBeGreaterThanOrEqual(60);
    expect(p.badges.find((b) => b.id === 'first-sale')).toMatchObject({ level: 'plain', earnedDay: 1 });
    expect(p.badges.find((b) => b.id === 'market-stall')).toMatchObject({ level: null, progress: 11 });
  });
});

describe('the fill from history', () => {
  it('a farm from before the profile is filled in once, at boot, from its history', async () => {
    const { tg, farmId, playerId } = await played();
    const live = await tg.db.query('SELECT * FROM farm_days ORDER BY farm_id, day');
    const [liveStats] = await tg.db.query('SELECT * FROM farm_stats WHERE farm_id = $1', [farmId]);
    const liveBadges = await tg.db.query<{ badge: string }>('SELECT badge FROM badges WHERE farm_id = $1 AND tier IS NOT NULL ORDER BY badge', [farmId]);
    expect(liveBadges.length).toBeGreaterThan(3);

    // the database as migration 14 leaves an older one: the tables there, empty
    await tg.db.query('DELETE FROM badges');
    await tg.db.query('DELETE FROM farm_days');
    await tg.db.query('DELETE FROM farm_stats');

    // the step itself is quiet: nothing reaches the player
    const out = await tg.game.withCtx(async (ctx) => {
      const ids = await backfillProfiles(ctx);
      await evaluateBadges(ctx, ids, { quiet: true, backfilled: true });
      return { ids, events: ctx.out.filter((o) => o.msg.t === 'event' && (o.msg.event as GameEvent).kind === 'badgeEarned') };
    });
    expect(out.ids).toContain(farmId);
    expect(out.events).toEqual([]);

    // coins, profit, rank, sales and share on every closed day: what the live record wrote
    const filled = await tg.db.query('SELECT * FROM farm_days ORDER BY farm_id, day');
    const key = (r: Record<string, unknown>) => `${String(r.farm_id)}|${String(r.day)}`;
    const byKey = new Map(filled.map((r) => [key(r), r]));
    for (const l of live) {
      const f = byKey.get(key(l));
      expect(f, key(l)).toBeDefined();
      expect(f?.estimated).toBe(true);
      expect(Number(f?.cash_milli), key(l)).toBe(Number(l.cash_milli));
      expect(Number(f?.profit_milli), key(l)).toBe(Number(l.profit_milli));
      expect(f?.rank === null ? null : Number(f?.rank), key(l)).toBe(l.rank === null ? null : Number(l.rank));
      expect(Number(f?.open_farms)).toBe(Number(l.open_farms));
      expect(Number(f?.sold_n)).toBe(Number(l.sold_n));
      expect(Number(f?.share)).toBeCloseTo(Number(l.share), 9);
      expect(Number(f?.net_worth_milli)).toBeGreaterThanOrEqual(Number(f?.cash_milli));
    }
    // laid, collected and broken only where the lay events are still kept (the last closed day)
    const mine = filled.filter((r) => r.farm_id === farmId);
    expect(mine.map((r) => r.laid_n === null)).toEqual([true, true, false]);
    expect(Number(mine[2]?.laid_n)).toBe(Number(live.find((r) => r.farm_id === farmId && r.day === 3)?.laid_n));

    // the counters that history holds
    const [s] = await tg.db.query('SELECT * FROM farm_stats WHERE farm_id = $1', [farmId]);
    expect(s).toMatchObject({ backfilled: true, repairs: 1, deliveries: 1, delivery_streak: 1, best_delivery_streak: 1, orders_filled: 1, haggles_lost: 2, eggs_picked: 0, night_actions: 0 });
    expect(liveStats).toMatchObject({ repairs: 1, deliveries: 1, orders_filled: 1, backfilled: false });
    const farm = await tg.game.getFarmState(farmId);
    expect(Number(s?.eggs_collected)).toBe(11 + EGG_GRADES.reduce((a, g) => a + farm.crate[g], 0));
    expect((s?.traits_seen as string[]).length).toBeGreaterThanOrEqual(4);

    // the badges history earns, as of the boot day, marked as filled in
    const badges = await tg.db.query<{ badge: string; earned_day: number; backfilled: boolean }>('SELECT badge, earned_day, backfilled FROM badges WHERE farm_id = $1 AND tier IS NOT NULL', [farmId]);
    for (const id of ['first-egg', 'first-sale', 'signed', 'first-delivery', 'order-filler', 'handy', 'on-the-road', 'opening-day']) expect(badges.map((b) => b.badge), id).toContain(id);
    expect(badges.every((b) => b.backfilled && b.earned_day === 4)).toBe(true);
    // the player's own profile reads the filled-in days, marked as estimates
    const p = await tg.game.getProfile(farmId);
    expect(p.days.every((d) => d.estimated)).toBe(true);
    expect(playerId).toBeTruthy();
  });

  it('runs at boot once: a restart fills in an older database, and the next restart finds nothing to do', async () => {
    const { tg, farmId } = await played();
    await tg.db.query('DELETE FROM badges');
    await tg.db.query('DELETE FROM farm_days');
    await tg.db.query('DELETE FROM farm_stats');
    const farms = await tg.db.query<{ n: number }>('SELECT count(*) AS n FROM farms');
    const restart = await makeGame({ db: tg.db, cast: true, seed: 4 });
    expect(restart.logs.some((l) => l === `[profile] filled in ${Number(farms[0]?.n)} farms from their history`)).toBe(true);
    const rows = Number((await tg.db.query<{ n: number }>('SELECT count(*) AS n FROM farm_days'))[0]?.n);
    expect(rows).toBeGreaterThan(0);
    const [b] = await tg.db.query<{ n: number }>('SELECT count(*) AS n FROM badges WHERE farm_id = $1 AND tier IS NOT NULL', [farmId]);
    expect(Number(b?.n)).toBeGreaterThan(3);
    const again = await makeGame({ db: tg.db, cast: true, seed: 4 });
    expect(again.logs.some((l) => l.startsWith('[profile] filled in'))).toBe(false);
    expect(Number((await tg.db.query<{ n: number }>('SELECT count(*) AS n FROM farm_days'))[0]?.n)).toBe(rows);
  });
});
