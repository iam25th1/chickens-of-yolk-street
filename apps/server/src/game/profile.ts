// The player profile's records: a snapshot of every farm at each day close (coins, net worth, rank,
// eggs by grade, profit, share of the street's sales), the counters nothing else keeps (farm_stats),
// the one-time fill from history for farms older than the profile, and the two views: the player's
// own profile (private, over the WebSocket) and a farm's public profile (a whitelist, for anyone).
import {
  BADGES,
  BADGE_RULES,
  ECONOMY,
  EGG_GRADES,
  FEATHER_GRADES,
  UNLOCK_IDS,
  emptyEggStock,
  toMilli,
  topBadges,
  type AgentKind,
  type BadgeLevel,
  type BadgeMark,
  type CoopKind,
  type EggGrade,
  type EggStock,
  type FeatherGrade,
  type MachineTally,
  type ProfileData,
  type ProfileDay,
  type PublicProfile,
  type UnlockId,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import type { Ctx } from './ctx';

// ---- counters ----------------------------------------------------------------------------------

export type StatCounter =
  | 'eggs_laid'
  | 'eggs_collected'
  | 'eggs_picked'
  | 'eggs_broken'
  | 'golden_collected'
  | 'orders_filled'
  | 'haggles_lost'
  | 'auction_hens'
  | 'night_actions';

/** Adds to a farm's counters (its row is made the first time). */
export async function bumpStats(q: Queryable, farmId: string, add: Partial<Record<StatCounter, number>>): Promise<void> {
  const cols = (Object.keys(add) as StatCounter[]).filter((c) => (add[c] ?? 0) !== 0);
  if (!cols.length) return;
  await q.query(
    `INSERT INTO farm_stats (farm_id${cols.map((c) => `, ${c}`).join('')}) VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join('')})
     ON CONFLICT (farm_id) DO UPDATE SET ${cols.map((c) => `${c} = farm_stats.${c} + EXCLUDED.${c}`).join(', ')}`,
    [farmId, ...cols.map((c) => add[c] ?? 0)],
  );
}

/** A contract day delivered: one more delivery and one more in a row. */
export async function statDelivered(q: Queryable, farmId: string): Promise<void> {
  await q.query(
    `INSERT INTO farm_stats (farm_id, deliveries, delivery_streak, best_delivery_streak) VALUES ($1, 1, 1, 1)
     ON CONFLICT (farm_id) DO UPDATE SET deliveries = farm_stats.deliveries + 1, delivery_streak = farm_stats.delivery_streak + 1,
       best_delivery_streak = GREATEST(farm_stats.best_delivery_streak, farm_stats.delivery_streak + 1)`,
    [farmId],
  );
}

/** A contract day missed: the streak starts again. */
export async function statMissed(q: Queryable, farmId: string): Promise<void> {
  await q.query(`INSERT INTO farm_stats (farm_id) VALUES ($1) ON CONFLICT (farm_id) DO UPDATE SET delivery_streak = 0`, [farmId]);
}

/** A repair paid: a machine repaired before it broke keeps the repair streak going. */
export async function statRepaired(q: Queryable, farmId: string, wasBroken: boolean): Promise<void> {
  const step = wasBroken ? 0 : 1;
  await q.query(
    `INSERT INTO farm_stats (farm_id, repairs, repair_streak, best_repair_streak) VALUES ($1, 1, $2, $2)
     ON CONFLICT (farm_id) DO UPDATE SET repairs = farm_stats.repairs + 1, repair_streak = farm_stats.repair_streak + $2,
       best_repair_streak = GREATEST(farm_stats.best_repair_streak, farm_stats.repair_streak + $2)`,
    [farmId, step],
  );
}

/** A machine broke down: counted, and the repair streak ends. */
export async function statBrokeDown(q: Queryable, farmId: string, day: number): Promise<void> {
  await q.query(
    `INSERT INTO farm_stats (farm_id, breakdowns, last_breakdown_day) VALUES ($1, 1, $2)
     ON CONFLICT (farm_id) DO UPDATE SET breakdowns = farm_stats.breakdowns + 1, last_breakdown_day = $2, repair_streak = 0`,
    [farmId, day],
  );
}

/**
 * A player did business: at night (from ECONOMY.day.nightStart) it counts toward the night owl; at
 * dawn (the first BADGE_RULES.dawnShare of the day) it keeps the rooster crow streak, which grows by
 * one for each day in a row with such an action. Returns whether a counter moved.
 */
export async function noteAction(ctx: Ctx, farmId: string): Promise<boolean> {
  const share = ctx.elapsed / ctx.dayMs;
  if (share >= ECONOMY.day.nightStart) {
    await bumpStats(ctx.q, farmId, { night_actions: 1 });
    return true;
  }
  if (share >= BADGE_RULES.dawnShare) return false;
  const [s] = await ctx.q.query('SELECT crow_streak, last_crow_day FROM farm_stats WHERE farm_id = $1', [farmId]);
  const last = s?.last_crow_day === null || s?.last_crow_day === undefined ? null : num(s.last_crow_day);
  if (last === ctx.day) return false;
  const streak = last === ctx.day - 1 ? num(s?.crow_streak) + 1 : 1;
  await ctx.q.query(
    `INSERT INTO farm_stats (farm_id, crow_streak, best_crow_streak, last_crow_day) VALUES ($1, $2, $2, $3)
     ON CONFLICT (farm_id) DO UPDATE SET crow_streak = $2, best_crow_streak = GREATEST(farm_stats.best_crow_streak, $2), last_crow_day = $3`,
    [farmId, streak, ctx.day],
  );
  return true;
}

// ---- net worth ---------------------------------------------------------------------------------

export interface WorthParts {
  cashMilli: number;
  hensMilli: number;
  coopsMilli: number;
  machinesMilli: number;
  landMilli: number;
}

/** Net worth: coins, plus hens at the hen price, coops at their price, machines at their price times their condition, and land at what it cost. */
export function worthOf(cashMilli: number, hens: number, coops: CoopKind[], machines: { unlock: UnlockId; condition: number }[], landMilli = 0): WorthParts & { totalMilli: number } {
  const hensMilli = hens * toMilli(ECONOMY.hen.price);
  const coopsMilli = coops.reduce((s, k) => s + toMilli(ECONOMY.coops.kinds[k].price), 0);
  const machinesMilli = machines.reduce((s, m) => s + Math.round(toMilli(ECONOMY.unlocks[m.unlock].price) * Math.max(0, Math.min(1, m.condition))), 0);
  return { cashMilli, hensMilli, coopsMilli, machinesMilli, landMilli, totalMilli: cashMilli + hensMilli + coopsMilli + machinesMilli + landMilli };
}

type Holding = { hens: number; coops: CoopKind[]; machines: { unlock: UnlockId; condition: number }[]; landMilli: number };

/** Every farm's hens, coops, machines and land, for net worth. */
async function holdings(q: Queryable, farmIds: string[] | null): Promise<Map<string, Holding>> {
  const where = farmIds ? 'AND farm_id = ANY($1::text[])' : '';
  const args = farmIds ? [farmIds] : [];
  const out = new Map<string, Holding>();
  const get = (id: string) => {
    let h = out.get(id);
    if (!h) out.set(id, (h = { hens: 0, coops: [], machines: [], landMilli: 0 }));
    return h;
  };
  for (const r of await q.query(`SELECT farm_id, count(*) AS n FROM hens WHERE status = 'alive' ${where} GROUP BY farm_id`, args)) get(String(r.farm_id)).hens = num(r.n);
  for (const r of await q.query(`SELECT farm_id, kind FROM coops WHERE true ${where}`, args)) get(String(r.farm_id)).coops.push(r.kind as CoopKind);
  for (const r of await q.query(`SELECT farm_id, unlock_id, condition FROM unlocks WHERE true ${where}`, args)) get(String(r.farm_id)).machines.push({ unlock: r.unlock_id as UnlockId, condition: num(r.condition) });
  for (const r of await q.query(`SELECT farm_id, SUM(price_milli) AS paid FROM farm_land WHERE true ${where} GROUP BY farm_id`, args)) get(String(r.farm_id)).landMilli = num(r.paid);
  return out;
}

/** The open farms in rank order (by coins, richest first; the id breaks ties, as the top-three milestone does). */
export async function liveRanks(q: Queryable): Promise<Map<string, number>> {
  const rows = await q.query<{ id: string }>('SELECT id FROM farms WHERE bust_day IS NULL ORDER BY cash_milli DESC, id');
  return new Map(rows.map((r, i) => [String(r.id), i + 1]));
}

// ---- the day close -----------------------------------------------------------------------------

type GradeCounts = Partial<Record<EggGrade, number>>;
export interface LayTally {
  laid: GradeCounts;
  broken: GradeCounts;
  /** Collected by hand or by the belt before the close. */
  collected: GradeCounts;
}

const add = (m: GradeCounts, g: EggGrade, n: number) => {
  m[g] = (m[g] ?? 0) + n;
};
const total = (m: GradeCounts | null | undefined): number => (m ? EGG_GRADES.reduce((s, g) => s + (m[g] ?? 0), 0) : 0);

/** The day's eggs per farm, read before the close carries the ones left on the ground into the crates. */
export async function layTally(q: Queryable, day: number): Promise<Map<string, LayTally>> {
  const out = new Map<string, LayTally>();
  const rows = await q.query(
    `SELECT farm_id, grade, count(*) AS laid, sum(CASE WHEN broken THEN 1 ELSE 0 END) AS broken, sum(CASE WHEN collected AND NOT broken THEN 1 ELSE 0 END) AS collected
     FROM lay_events WHERE day = $1 GROUP BY farm_id, grade`,
    [day],
  );
  for (const r of rows) {
    const id = String(r.farm_id);
    const t = out.get(id) ?? { laid: {}, broken: {}, collected: {} };
    const g = r.grade as EggGrade;
    add(t.laid, g, num(r.laid));
    add(t.broken, g, num(r.broken));
    add(t.collected, g, num(r.collected));
    out.set(id, t);
  }
  return out;
}

const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

/**
 * Day close: each farm's row for the closed day (every open farm, and any that went bust today), and
 * the egg counters from the day's lay events: laid, broken, and what the close itself carried into the
 * crate (hand and belt pick-ups were counted when they happened).
 */
export async function snapshotDay(ctx: Ctx, day: number, lay: Map<string, LayTally>): Promise<void> {
  const q = ctx.q;
  const farms = await q.query(
    `SELECT id, owner_kind, cash_milli, bust_day, fed_multiplier, good_since_day FROM farms WHERE bust_day IS NULL OR bust_day = $1 ORDER BY id`,
    [day],
  );
  if (!farms.length) return;
  const ranks = await liveRanks(q);
  const open = ranks.size;
  const held = await holdings(q, null);
  const sold = new Map<string, GradeCounts>();
  for (const r of await q.query(`SELECT seller_farm, grade, SUM(qty) AS n FROM trades WHERE day = $1 AND seller_farm IS NOT NULL GROUP BY seller_farm, grade`, [day])) {
    const m = sold.get(String(r.seller_farm)) ?? {};
    add(m, r.grade as EggGrade, num(r.n));
    sold.set(String(r.seller_farm), m);
  }
  const [md] = await q.query('SELECT supply FROM market_days WHERE day = $1', [day]);
  const supply = num(md?.supply ?? 0);
  const profit = new Map<string, number>();
  for (const r of await q.query(`SELECT farm_id, SUM(amount_milli) AS p FROM ledger WHERE day = $1 AND kind <> 'start' GROUP BY farm_id`, [day])) profit.set(String(r.farm_id), num(r.p));

  const rows: unknown[][] = [];
  for (const f of farms) {
    const id = String(f.id);
    const h = held.get(id) ?? { hens: 0, coops: [], machines: [], landMilli: 0 };
    const worth = worthOf(num(f.cash_milli), h.hens, h.coops, h.machines, h.landMilli);
    const t = lay.get(id);
    const s = sold.get(id) ?? {};
    const soldN = total(s);
    rows.push([
      id,
      day,
      num(f.cash_milli),
      worth.totalMilli,
      ranks.get(id) ?? null,
      open,
      h.hens,
      profit.get(id) ?? 0,
      JSON.stringify(t?.laid ?? {}),
      JSON.stringify(t?.collected ?? {}),
      JSON.stringify(t?.broken ?? {}),
      total(t?.laid),
      JSON.stringify(s),
      soldN,
      supply > 0 ? soldN / supply : 0,
      num(f.fed_multiplier),
      f.owner_kind === 'player' ? f.good_since_day !== null && f.good_since_day !== undefined : null,
    ]);
    if (t) {
      const laid = total(t.laid);
      const broken = total(t.broken);
      const atClose = laid - broken - total(t.collected);
      const goldenAtClose = (t.laid.golden ?? 0) - (t.broken.golden ?? 0) - (t.collected.golden ?? 0);
      await bumpStats(q, id, { eggs_laid: laid, eggs_broken: broken, eggs_collected: atClose, golden_collected: goldenAtClose });
    }
  }
  await insertDays(q, rows, false);
}

const DAY_COLS = 'farm_id, day, cash_milli, net_worth_milli, rank, open_farms, hens, profit_milli, laid, collected, broken, laid_n, sold, sold_n, share, fed, good';

async function insertDays(q: Queryable, rows: unknown[][], estimated: boolean): Promise<void> {
  const width = 17;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((r) => {
      const b = values.length;
      values.push(...r);
      return `(${Array.from({ length: width }, (_, k) => `$${b + k + 1}`).join(', ')}, ${estimated})`;
    });
    await q.query(
      `INSERT INTO farm_days (${DAY_COLS}, estimated) VALUES ${tuples.join(', ')}
       ON CONFLICT (farm_id, day) DO UPDATE SET cash_milli = EXCLUDED.cash_milli, net_worth_milli = EXCLUDED.net_worth_milli, rank = EXCLUDED.rank,
         open_farms = EXCLUDED.open_farms, hens = EXCLUDED.hens, profit_milli = EXCLUDED.profit_milli, laid = EXCLUDED.laid, collected = EXCLUDED.collected,
         broken = EXCLUDED.broken, laid_n = EXCLUDED.laid_n, sold = EXCLUDED.sold, sold_n = EXCLUDED.sold_n, share = EXCLUDED.share, fed = EXCLUDED.fed,
         good = EXCLUDED.good, estimated = EXCLUDED.estimated`,
      values,
    );
  }
}

/** The hen looks a set of hens show, as "body:cream", "eyes:wild" and so on. */
export const traitsOf = (hens: { body: unknown; eyes: unknown; comb: unknown; accessory: unknown }[]): string[] => [
  ...new Set(hens.flatMap((h) => [`body:${String(h.body)}`, `eyes:${String(h.eyes)}`, `comb:${String(h.comb)}`, `accessory:${String(h.accessory)}`])),
];

/** Day close: every hen look a farm keeps now joins the ones it has kept before (a hen sold away is remembered). */
export async function rememberTraits(q: Queryable, farmIds: string[]): Promise<void> {
  if (!farmIds.length) return;
  const hens = await q.query(`SELECT farm_id, body, eyes, comb, accessory FROM hens WHERE status = 'alive' AND farm_id = ANY($1::text[])`, [farmIds]);
  const seen = new Map<string, Set<string>>();
  for (const r of await q.query('SELECT farm_id, traits_seen FROM farm_stats WHERE farm_id = ANY($1::text[])', [farmIds])) seen.set(String(r.farm_id), new Set(json<string[]>(r.traits_seen) ?? []));
  const now = new Map<string, Set<string>>();
  for (const h of hens) {
    const set = now.get(String(h.farm_id)) ?? new Set<string>();
    for (const t of traitsOf([h as { body: unknown; eyes: unknown; comb: unknown; accessory: unknown }])) set.add(t);
    now.set(String(h.farm_id), set);
  }
  for (const id of farmIds) {
    const before = seen.get(id) ?? new Set<string>();
    const after = new Set([...before, ...(now.get(id) ?? [])]);
    if (after.size === before.size && seen.has(id)) continue;
    await q.query(`INSERT INTO farm_stats (farm_id, traits_seen) VALUES ($1, $2) ON CONFLICT (farm_id) DO UPDATE SET traits_seen = EXCLUDED.traits_seen`, [id, JSON.stringify([...after].sort())]);
  }
}

// ---- the fill from history ---------------------------------------------------------------------

/**
 * Once, for every farm without a farm_stats row (a farm from before the profile): its closed days and
 * its counters, made from the history that exists (migration 14 says what is filled in and what is
 * not). Returns the farms filled in. Safe to run on every boot: a filled-in farm has its row.
 */
export async function backfillProfiles(ctx: Ctx): Promise<string[]> {
  const q = ctx.q;
  const missing = await q.query(
    `SELECT f.id, f.created_day, f.bust_day, f.crate_white, f.crate_cream, f.crate_brown, f.crate_golden, f.eggs_sold, f.last_missed_day
     FROM farms f LEFT JOIN farm_stats s ON s.farm_id = f.id WHERE s.farm_id IS NULL ORDER BY f.id`,
  );
  if (!missing.length) return [];
  const ids = missing.map((f) => String(f.id));
  const lastClosed = ctx.day - 1;

  // every farm's coins at the end of each day (the ledger, cumulated), for the ranks of the past
  const all = await q.query('SELECT id, created_day, bust_day FROM farms');
  const perDay = new Map<string, Map<number, { total: number; profit: number }>>();
  for (const r of await q.query(`SELECT farm_id, day, SUM(amount_milli) AS total, SUM(CASE WHEN kind <> 'start' THEN amount_milli ELSE 0 END) AS profit FROM ledger GROUP BY farm_id, day`)) {
    const m = perDay.get(String(r.farm_id)) ?? new Map<number, { total: number; profit: number }>();
    m.set(num(r.day), { total: num(r.total), profit: num(r.profit) });
    perDay.set(String(r.farm_id), m);
  }
  const cashAt = new Map<string, Map<number, number>>();
  for (const f of all) {
    const id = String(f.id);
    const days = perDay.get(id) ?? new Map<number, { total: number; profit: number }>();
    const out = new Map<number, number>();
    let run = 0;
    const first = Math.min(num(f.created_day), ...days.keys());
    for (let d = first; d <= lastClosed; d++) {
      run += days.get(d)?.total ?? 0;
      out.set(d, run);
    }
    cashAt.set(id, out);
  }
  const rankAt = (d: number): Map<string, number> => {
    const open = all.filter((f) => num(f.created_day) <= d && (f.bust_day === null || f.bust_day === undefined || num(f.bust_day) > d));
    open.sort((a, b) => (cashAt.get(String(b.id))?.get(d) ?? 0) - (cashAt.get(String(a.id))?.get(d) ?? 0) || (String(a.id) < String(b.id) ? -1 : 1));
    return new Map(open.map((f, i) => [String(f.id), i + 1]));
  };

  const sold = new Map<string, Map<number, GradeCounts>>();
  for (const r of await q.query(`SELECT seller_farm, day, grade, SUM(qty) AS n FROM trades WHERE seller_farm = ANY($1::text[]) GROUP BY seller_farm, day, grade`, [ids])) {
    const m = sold.get(String(r.seller_farm)) ?? new Map<number, GradeCounts>();
    const g = m.get(num(r.day)) ?? {};
    add(g, r.grade as EggGrade, num(r.n));
    m.set(num(r.day), g);
    sold.set(String(r.seller_farm), m);
  }
  const supply = new Map((await q.query('SELECT day, supply FROM market_days')).map((r) => [num(r.day), num(r.supply)]));
  const lay = new Map<string, Map<number, LayTally>>();
  for (const r of await q.query(
    `SELECT farm_id, day, grade, count(*) AS laid, sum(CASE WHEN broken THEN 1 ELSE 0 END) AS broken, sum(CASE WHEN collected AND NOT broken THEN 1 ELSE 0 END) AS collected
     FROM lay_events WHERE farm_id = ANY($1::text[]) AND day <= $2 GROUP BY farm_id, day, grade`,
    [ids, lastClosed],
  )) {
    const m = lay.get(String(r.farm_id)) ?? new Map<number, LayTally>();
    const t = m.get(num(r.day)) ?? { laid: {}, broken: {}, collected: {} };
    add(t.laid, r.grade as EggGrade, num(r.laid));
    add(t.broken, r.grade as EggGrade, num(r.broken));
    add(t.collected, r.grade as EggGrade, num(r.collected));
    m.set(num(r.day), t);
    lay.set(String(r.farm_id), m);
  }
  const hens = await q.query(`SELECT farm_id, born_day, body, eyes, comb, accessory FROM hens WHERE status = 'alive' AND farm_id = ANY($1::text[])`, [ids]);
  const coops = await q.query('SELECT farm_id, kind, built_day FROM coops WHERE farm_id = ANY($1::text[])', [ids]);
  const machines = await q.query('SELECT farm_id, unlock_id, bought_day, condition, broken FROM unlocks WHERE farm_id = ANY($1::text[])', [ids]);

  const rows: unknown[][] = [];
  const ranks = new Map<number, Map<string, number>>();
  for (const f of missing) {
    const id = String(f.id);
    const until = f.bust_day === null || f.bust_day === undefined ? lastClosed : Math.min(lastClosed, num(f.bust_day));
    for (let d = num(f.created_day); d <= until; d++) {
      if (!ranks.has(d)) ranks.set(d, rankAt(d));
      const r = ranks.get(d) ?? new Map<string, number>();
      const cash = cashAt.get(id)?.get(d) ?? 0;
      // net worth estimated with the hens, coops and machines the farm has today, from the day each arrived
      const henN = hens.filter((h) => h.farm_id === id && num(h.born_day) <= d).length;
      const worth = worthOf(
        cash,
        henN,
        coops.filter((c) => c.farm_id === id && num(c.built_day) <= d).map((c) => c.kind as CoopKind),
        machines.filter((m) => m.farm_id === id && num(m.bought_day) <= d).map((m) => ({ unlock: m.unlock_id as UnlockId, condition: num(m.condition) })),
      );
      const s = sold.get(id)?.get(d) ?? {};
      const soldN = total(s);
      const sup = supply.get(d) ?? 0;
      const t = lay.get(id)?.get(d) ?? null;
      rows.push([
        id,
        d,
        cash,
        worth.totalMilli,
        r.get(id) ?? null,
        r.size,
        henN,
        perDay.get(id)?.get(d)?.profit ?? 0,
        t ? JSON.stringify(t.laid) : null,
        t ? JSON.stringify(t.collected) : null,
        t ? JSON.stringify(t.broken) : null,
        t ? total(t.laid) : null,
        JSON.stringify(s),
        soldN,
        sup > 0 ? soldN / sup : 0,
        null,
        null,
      ]);
    }
  }
  await insertDays(q, rows, true);

  // the counters, from what the tables hold
  const one = async (sql: string, args: unknown[] = [ids]): Promise<Map<string, number>> => new Map((await q.query(sql, args)).map((r) => [String(r.id), num(r.n)]));
  const goldenSold = await one(`SELECT seller_farm AS id, SUM(qty) AS n FROM trades WHERE seller_farm = ANY($1::text[]) AND grade = 'golden' GROUP BY seller_farm`);
  const ordersFilled = await one(`SELECT seller_farm AS id, count(*) AS n FROM trades WHERE seller_farm = ANY($1::text[]) AND via = 'order' GROUP BY seller_farm`);
  // a contract day of mixed grades is one trade per grade: count each buyer once a day
  const deliveries = await one(`SELECT seller_farm AS id, count(DISTINCT (day, buyer_agent)) AS n FROM trades WHERE seller_farm = ANY($1::text[]) AND via = 'contract' GROUP BY seller_farm`);
  const lost = await one(`SELECT farm_id AS id, SUM(haggles_lost) AS n FROM agent_memory WHERE farm_id = ANY($1::text[]) GROUP BY farm_id`);
  const repairs = await one(`SELECT farm_id AS id, count(*) AS n FROM ledger WHERE farm_id = ANY($1::text[]) AND kind = 'repair' GROUP BY farm_id`);
  const auction = await one(`SELECT farm_id AS id, count(*) AS n FROM ledger WHERE farm_id = ANY($1::text[]) AND kind = 'hens' AND ref LIKE 'hen %' AND amount_milli = $2 GROUP BY farm_id`, [
    ids,
    -toMilli(ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor),
  ]);
  for (const f of missing) {
    const id = String(f.id);
    const kept = [...(lay.get(id)?.values() ?? [])];
    const laid = kept.reduce((s, t) => s + total(t.laid), 0);
    const broken = kept.reduce((s, t) => s + total(t.broken), 0);
    const crate = num(f.crate_white) + num(f.crate_cream) + num(f.crate_brown) + num(f.crate_golden);
    // eggs into the crate: at least every egg sold and every egg in it now (eggs bought from neighbours count too)
    const collected = num(f.eggs_sold) + crate;
    const since = f.last_missed_day === null || f.last_missed_day === undefined ? null : num(f.last_missed_day);
    const streakRows = await q.query(
      `SELECT count(DISTINCT (day, buyer_agent)) AS n FROM trades WHERE seller_farm = $1 AND via = 'contract' AND ($2::int IS NULL OR day > $2::int)`,
      [id, since],
    );
    const streak = num(streakRows[0]?.n);
    const brokenNow = machines.filter((m) => m.farm_id === id && m.broken).length;
    await q.query(
      `INSERT INTO farm_stats (farm_id, eggs_laid, eggs_collected, eggs_broken, golden_collected, orders_filled, haggles_lost, deliveries, delivery_streak,
         best_delivery_streak, auction_hens, repairs, breakdowns, traits_seen, backfilled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13, true) ON CONFLICT (farm_id) DO NOTHING`,
      [
        id,
        Math.max(laid, collected),
        collected,
        broken,
        (goldenSold.get(id) ?? 0) + num(f.crate_golden),
        ordersFilled.get(id) ?? 0,
        lost.get(id) ?? 0,
        deliveries.get(id) ?? 0,
        streak,
        auction.get(id) ?? 0,
        repairs.get(id) ?? 0,
        brokenNow,
        JSON.stringify(traitsOf(hens.filter((h) => h.farm_id === id) as { body: unknown; eyes: unknown; comb: unknown; accessory: unknown }[]).sort()),
      ],
    );
  }
  return ids;
}

// ---- the views ---------------------------------------------------------------------------------

const plus = (a: EggStock, b: GradeCounts | null): void => {
  for (const g of EGG_GRADES) a[g] += b?.[g] ?? 0;
};

/**
 * Closed days the farm's machines have run since the last breakdown (a breakdown happens at a close),
 * or since its first machine arrived; 0 without machines. `closed` is the last closed day.
 */
export function daysNoBreakdown(closed: number, firstBought: number | null, lastBreakdown: number | null): number {
  if (firstBought === null) return 0;
  return Math.max(0, closed - Math.max(firstBought - 1, lastBreakdown ?? 0));
}

/** Rival farms gone bust since the farm opened (not itself). */
export async function rivalsOutlasted(q: Queryable, farmIds: string[]): Promise<Map<string, number>> {
  const rows = await q.query(
    `SELECT f.id, count(a.id) AS n FROM farms f JOIN agents a ON a.role = 'rival' AND a.status = 'bust' AND a.bust_day >= f.created_day AND a.farm_id IS DISTINCT FROM f.id
     WHERE f.id = ANY($1::text[]) GROUP BY f.id`,
    [farmIds],
  );
  return new Map(rows.map((r) => [String(r.id), num(r.n)]));
}

/** The farm's earned badges, as marks. */
export async function earnedBadges(q: Queryable, farmIds: string[]): Promise<Map<string, BadgeMark[]>> {
  const out = new Map<string, BadgeMark[]>();
  if (!farmIds.length) return out;
  const known = new Set(BADGES.map((b) => b.id));
  for (const r of await q.query('SELECT farm_id, badge, tier FROM badges WHERE tier IS NOT NULL AND farm_id = ANY($1::text[])', [farmIds])) {
    if (!known.has(String(r.badge))) continue;
    const list = out.get(String(r.farm_id)) ?? [];
    list.push({ id: String(r.badge), level: r.tier as BadgeLevel });
    out.set(String(r.farm_id), list);
  }
  return out;
}

/** The player's own profile. Private: sent only to the farm's player. */
export async function profileFor(q: Queryable, farmId: string, day: number, facts: Partial<Record<string, number>>, badges: ProfileData['badges']): Promise<ProfileData> {
  const [f] = await q.query('SELECT id, name, cash_milli, created_day, good_days, eggs_sold, haggles_won FROM farms WHERE id = $1', [farmId]);
  if (!f) throw new Error('farm not found');
  const [st] = await q.query('SELECT * FROM farm_stats WHERE farm_id = $1', [farmId]);
  const h = (await holdings(q, [farmId])).get(farmId) ?? { hens: 0, coops: [], machines: [], landMilli: 0 };
  const worth = worthOf(num(f.cash_milli), h.hens, h.coops, h.machines, h.landMilli);
  const ranks = await liveRanks(q);

  const all = await q.query('SELECT * FROM farm_days WHERE farm_id = $1 ORDER BY day', [farmId]);
  const days: ProfileDay[] = all.slice(-30).map((r) => ({
    day: num(r.day),
    cashMilli: num(r.cash_milli),
    netWorthMilli: num(r.net_worth_milli),
    rank: r.rank === null || r.rank === undefined ? null : num(r.rank),
    farms: num(r.open_farms),
    profitMilli: num(r.profit_milli),
    laid: r.laid_n === null || r.laid_n === undefined ? null : num(r.laid_n),
    collected: r.collected === null || r.collected === undefined ? null : total(json<GradeCounts>(r.collected)),
    broken: r.broken === null || r.broken === undefined ? null : total(json<GradeCounts>(r.broken)),
    sold: num(r.sold_n),
    estimated: Boolean(r.estimated),
  }));
  const laid = emptyEggStock();
  const collected = emptyEggStock();
  const broken = emptyEggStock();
  let since: number | null = null;
  for (const r of all) {
    if (r.laid === null || r.laid === undefined) continue;
    since ??= num(r.day);
    plus(laid, json<GradeCounts>(r.laid));
    plus(collected, json<GradeCounts>(r.collected));
    plus(broken, json<GradeCounts>(r.broken));
  }
  const sold = emptyEggStock();
  for (const r of await q.query('SELECT grade, SUM(qty) AS n FROM trades WHERE seller_farm = $1 GROUP BY grade', [farmId])) sold[r.grade as EggGrade] = num(r.n);

  const byKind: Record<string, number> = {};
  for (const r of await q.query(`SELECT kind, SUM(amount_milli) AS n FROM ledger WHERE farm_id = $1 AND kind <> 'start' GROUP BY kind`, [farmId])) byKind[String(r.kind)] = num(r.n);
  const daily = await q.query(`SELECT day, SUM(amount_milli) AS p FROM ledger WHERE farm_id = $1 AND kind <> 'start' AND day < $2 GROUP BY day ORDER BY day`, [farmId, day]);
  let best: { day: number; profitMilli: number } | null = null;
  let worst: { day: number; profitMilli: number } | null = null;
  for (const r of daily) {
    const p = { day: num(r.day), profitMilli: num(r.p) };
    if (!best || p.profitMilli > best.profitMilli) best = p;
    if (!worst || p.profitMilli < worst.profitMilli) worst = p;
  }

  const work: Partial<Record<UnlockId, MachineTally>> = {};
  for (const r of await q.query('SELECT machine, SUM(units) AS u, SUM(saved) AS s, SUM(milli) AS m FROM machine_days WHERE farm_id = $1 GROUP BY machine', [farmId])) {
    if ((UNLOCK_IDS as readonly string[]).includes(String(r.machine))) work[r.machine as UnlockId] = { units: num(r.u), saved: num(r.s), milli: num(r.m) };
  }
  const [c] = await q.query(`SELECT count(*) AS taken, count(*) FILTER (WHERE status = 'done' AND misses = 0) AS kept, COALESCE(SUM(misses), 0) AS misses FROM contracts WHERE farm_id = $1`, [farmId]);
  const [tickets] = await q.query('SELECT count(*) AS n FROM feather_tickets WHERE farm_id = $1', [farmId]);
  const [rolls] = await q.query('SELECT count(*) AS n FROM milestone_rolls WHERE farm_id = $1', [farmId]);
  const minted = Object.fromEntries(FEATHER_GRADES.map((g) => [g, 0])) as Record<FeatherGrade, number>;
  for (const r of await q.query(`SELECT grade, count(*) AS n FROM feather_tickets WHERE farm_id = $1 AND status = 'minted' AND grade IS NOT NULL GROUP BY grade`, [farmId])) {
    if ((FEATHER_GRADES as readonly string[]).includes(String(r.grade))) minted[r.grade as FeatherGrade] = num(r.n);
  }
  const last = all.at(-1);
  const bestShare = all.reduce((m, r) => Math.max(m, num(r.share)), 0);
  return {
    farmId,
    name: String(f.name),
    day,
    createdDay: num(f.created_day),
    daysPlayed: Math.max(0, day - num(f.created_day)),
    cashMilli: num(f.cash_milli),
    netWorthMilli: worth.totalMilli,
    netWorth: { cashMilli: worth.cashMilli, hensMilli: worth.hensMilli, coopsMilli: worth.coopsMilli, machinesMilli: worth.machinesMilli, landMilli: worth.landMilli },
    rank: ranks.get(farmId) ?? null,
    farms: ranks.size,
    goodDays: num(f.good_days),
    days,
    eggs: {
      laid,
      collected,
      broken,
      sold,
      since,
      totals: {
        collected: num(st?.eggs_collected),
        picked: num(st?.eggs_picked),
        laid: num(st?.eggs_laid),
        broken: num(st?.eggs_broken),
        sold: num(f.eggs_sold),
        golden: num(st?.golden_collected),
      },
    },
    money: { byKind, best, worst },
    flock: { traitsSeen: [...new Set([...(json<string[]>(st?.traits_seen) ?? []), ...traitsOf(await q.query(`SELECT body, eyes, comb, accessory FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farmId]))])].sort(), auctionHens: num(st?.auction_hens) },
    machines: {
      repairs: num(st?.repairs),
      breakdowns: num(st?.breakdowns),
      repairStreak: num(st?.repair_streak),
      bestRepairStreak: num(st?.best_repair_streak),
      daysNoBreakdown: facts.daysNoBreakdown ?? 0,
      work,
    },
    market: {
      contractsTaken: num(c?.taken),
      contractsKept: num(c?.kept),
      contractMisses: num(c?.misses),
      deliveries: num(st?.deliveries),
      deliveryStreak: num(st?.delivery_streak),
      bestDeliveryStreak: num(st?.best_delivery_streak),
      hagglesWon: num(f.haggles_won),
      hagglesLost: num(st?.haggles_lost),
      ordersFilled: num(st?.orders_filled),
      eggsSold: num(f.eggs_sold),
      sharePct: last ? Math.round(num(last.share) * 1000) / 10 : 0,
      bestSharePct: Math.round(bestShare * 1000) / 10,
      rivalsOutlasted: (await rivalsOutlasted(q, [farmId])).get(farmId) ?? 0,
      bigTrades: facts.bigTrades ?? 0,
    },
    mint: { ticketsWon: num(tickets?.n), milestones: num(rolls?.n), minted },
    badges,
  };
}

/** The farm's id as the public profile accepts it: letters, digits and dashes. */
export const PUBLIC_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * A farm's public profile: built field by field from a whitelist, never from a whole row. Its name,
 * kind (for its sign and the AI tag), rank, a few headline numbers and its badges. Never coins, a
 * wallet, orders, a player id or anything from sign-in.
 */
export async function publicProfileFor(q: Queryable, farmId: string, day: number): Promise<PublicProfile | null> {
  if (!PUBLIC_ID.test(farmId)) return null;
  const [f] = await q.query(
    `SELECT f.id, f.name, f.owner_kind, f.bust_day, f.created_day, f.eggs_sold, f.haggles_won, a.kind AS agent_kind,
       (SELECT count(*) FROM hens h WHERE h.farm_id = f.id AND h.status = 'alive') AS hens
     FROM farms f LEFT JOIN agents a ON a.farm_id = f.id WHERE f.id = $1 LIMIT 1`,
    [farmId],
  );
  if (!f) return null;
  const ranks = await liveRanks(q);
  const marks = (await earnedBadges(q, [farmId])).get(farmId) ?? [];
  const isAgent = f.owner_kind === 'agent';
  const profile: PublicProfile = {
    farmId: String(f.id),
    name: String(f.name),
    kind: isAgent ? ((f.agent_kind as AgentKind | null) ?? 'upstart') : 'player',
    bust: f.bust_day !== null && f.bust_day !== undefined,
    rank: ranks.get(farmId) ?? null,
    farms: ranks.size,
    daysOnStreet: Math.max(0, day - num(f.created_day)),
    hens: num(f.hens),
    eggsSold: num(f.eggs_sold),
    hagglesWon: num(f.haggles_won),
    rivalsOutlasted: (await rivalsOutlasted(q, [farmId])).get(farmId) ?? 0,
    badgeCount: marks.length,
    badges: topBadges(marks, 12).map((m) => ({ id: m.id, level: m.level })),
  };
  return profile;
}
