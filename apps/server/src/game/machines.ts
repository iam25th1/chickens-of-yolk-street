// What the machines do, and the daily tally the machine cards and the ledger show.
//
// - Conveyor: every egg rides the belt into the crate carryMs after it is laid (collection is
//   automatic), and breakage falls to 2%; eggs it kept from cracking are counted as saved.
// - Grader: +10% on every egg sold; the tally keeps the extra coins.
// - Delivery cart: delivers standing contracts at day close (contracts.ts); the tally keeps eggs.
// - Feed hopper: -10% on feed; at day close it pours feed in when the trough runs low, from the
//   farm's supplier, only at or under the farm's price cap.
// - Sales clerk: +5% on sales and takes good offers on its own (cards.ts).
//
// Every machine wears (config in ECONOMY.unlocks[*].wear and ECONOMY.wear): its condition falls each
// day it works (the cart: each delivery), its effect is full at 50% and over and falls in line
// below, under 20% a day close may break it (it stops until repaired), and a repair to 100% costs a
// share of its price in proportion to what is missing.
import {
  ECONOMY,
  UNLOCK_IDS,
  feedBagPrice,
  feedGramsPerHenDay,
  machineEffect,
  repairCost,
  saleValue,
  toMilli,
  type EggGrade,
  type EggStock,
  type FeedTier,
  type MachinePower,
  type MachineView,
  type UnlockId,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import { ActionError, loadFarm, moveCash, type Ctx, type Farm } from './ctx';
import { emit } from './market';

/** A farm's machines: which it owns, each one's condition, and the effect share the price formulas use. */
export interface Machines extends MachinePower {
  owned: UnlockId[];
  state: Partial<Record<UnlockId, { condition: number; broken: boolean }>>;
}

export async function loadMachines(q: Queryable, farmId: string): Promise<Machines> {
  const rows = await q.query<{ unlock_id: string; condition: number; broken: boolean }>('SELECT unlock_id, condition, broken FROM unlocks WHERE farm_id = $1', [farmId]);
  const owned = UNLOCK_IDS.filter((u) => rows.some((r) => r.unlock_id === u));
  const state: Machines['state'] = {};
  const power: Partial<Record<UnlockId, number>> = {};
  for (const r of rows) {
    const u = r.unlock_id as UnlockId;
    state[u] = { condition: num(r.condition), broken: Boolean(r.broken) };
    power[u] = machineEffect(num(r.condition), Boolean(r.broken));
  }
  return { owned, state, power };
}

/** What the machine cards show: condition, effect now, whether it is broken, and the repair price. */
export function machineViews(m: Machines): Partial<Record<UnlockId, MachineView>> {
  const out: Partial<Record<UnlockId, MachineView>> = {};
  for (const u of m.owned) {
    const s = m.state[u] ?? { condition: 1, broken: false };
    out[u] = { condition: s.condition, broken: s.broken, effect: machineEffect(s.condition, s.broken), repairMilli: toMilli(repairCost(u, s.condition)) };
  }
  return out;
}

/** Wears a machine by an amount (a day's work, or one delivery). */
export async function wearMachine(q: Queryable, farmId: string, u: UnlockId, amount: number): Promise<void> {
  await q.query('UPDATE unlocks SET condition = GREATEST(0, condition - $3) WHERE farm_id = $1 AND unlock_id = $2', [farmId, u, amount]);
}

/**
 * Day close: every machine that worked today wears (the cart wore at each delivery), and one under
 * the breakdown line may break. Returns the machines that broke, for the farms' owners to hear.
 */
export async function wearMachines(ctx: Ctx, day: number, rnd: () => number): Promise<{ farmId: string; unlock: UnlockId }[]> {
  const broke: { farmId: string; unlock: UnlockId }[] = [];
  const rows = await ctx.q.query<{ farm_id: string; unlock_id: string; condition: number; broken: boolean }>(
    `SELECT u.farm_id, u.unlock_id, u.condition, u.broken FROM unlocks u JOIN farms f ON f.id = u.farm_id WHERE f.bust_day IS NULL ORDER BY u.farm_id, u.unlock_id`,
  );
  const worked = new Set(
    (await ctx.q.query<{ farm_id: string; machine: string }>('SELECT farm_id, machine FROM machine_days WHERE day = $1 AND (units > 0 OR milli > 0)', [day])).map((r) => `${r.farm_id}|${r.machine}`),
  );
  for (const r of rows) {
    const u = r.unlock_id as UnlockId;
    if (r.broken) continue;
    let condition = num(r.condition);
    if (u !== 'cart' && worked.has(`${r.farm_id}|${u}`)) {
      condition = Math.max(0, condition - ECONOMY.unlocks[u].wear);
      await ctx.q.query('UPDATE unlocks SET condition = $3 WHERE farm_id = $1 AND unlock_id = $2', [r.farm_id, u, condition]);
    }
    if (condition < ECONOMY.wear.breakdownBelow && rnd() < ECONOMY.wear.breakdownChance) {
      await ctx.q.query('UPDATE unlocks SET broken = true WHERE farm_id = $1 AND unlock_id = $2', [r.farm_id, u]);
      broke.push({ farmId: String(r.farm_id), unlock: u });
      ctx.touched.add(String(r.farm_id));
    }
  }
  return broke;
}

/** Repairs a machine to 100%: pays its repair price, and it works again. */
export async function repairMachine(ctx: Ctx, farm: Farm, u: UnlockId): Promise<number> {
  const [row] = await ctx.q.query<{ condition: number; broken: boolean }>('SELECT condition, broken FROM unlocks WHERE farm_id = $1 AND unlock_id = $2', [farm.id, u]);
  if (!row) throw new ActionError('not_found', 'the farm has no such machine');
  const condition = num(row.condition);
  if (condition >= 1 && !row.broken) throw new ActionError('invalid_action', 'it needs no repair');
  const cost = toMilli(repairCost(u, condition));
  if (farm.cashMilli < cost) throw new ActionError('insufficient_funds', 'not enough coins for the repair');
  await moveCash(ctx, farm.id, 'repair', -cost, `${u} repaired`);
  farm.cashMilli -= cost;
  await ctx.q.query('UPDATE unlocks SET condition = 1, broken = false WHERE farm_id = $1 AND unlock_id = $2', [farm.id, u]);
  ctx.touched.add(farm.id);
  return cost;
}

export interface MachineTally {
  units: number;
  saved: number;
  milli: number;
}

/** Adds to a machine's tally for a day. */
export async function logMachine(q: Queryable, farmId: string, day: number, machine: UnlockId, add: Partial<MachineTally>): Promise<void> {
  await q.query(
    `INSERT INTO machine_days (farm_id, day, machine, units, saved, milli) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (farm_id, day, machine) DO UPDATE SET units = machine_days.units + $4, saved = machine_days.saved + $5, milli = machine_days.milli + $6`,
    [farmId, day, machine, add.units ?? 0, add.saved ?? 0, Math.round(add.milli ?? 0)],
  );
}

export async function machineDay(q: Queryable, farmId: string, day: number): Promise<Partial<Record<UnlockId, MachineTally>>> {
  const out: Partial<Record<UnlockId, MachineTally>> = {};
  for (const r of await q.query('SELECT machine, units, saved, milli FROM machine_days WHERE farm_id = $1 AND day = $2', [farmId, day])) {
    out[r.machine as UnlockId] = { units: num(r.units), saved: num(r.saved), milli: num(r.milli) };
  }
  return out;
}

/** The conveyor's carry: eggs laid long enough ago ride into the crate. Runs every tick. */
export async function conveyorCarry(ctx: Ctx): Promise<void> {
  const cutoff = ctx.elapsed - ECONOMY.unlocks.conveyor.carryMs;
  if (cutoff < 0) return;
  const rows = await ctx.q.query(
    `SELECT l.id, l.farm_id, l.grade FROM lay_events l JOIN unlocks u ON u.farm_id = l.farm_id AND u.unlock_id = 'conveyor' AND NOT u.broken
     WHERE l.day = $1 AND NOT l.collected AND NOT l.broken AND l.at_ms <= $2 ORDER BY l.farm_id, l.at_ms`,
    [ctx.day, cutoff],
  );
  if (!rows.length) return;
  const byFarm = new Map<string, { id: string; grade: EggGrade }[]>();
  for (const r of rows) {
    const list = byFarm.get(String(r.farm_id)) ?? [];
    list.push({ id: String(r.id), grade: r.grade as EggGrade });
    byFarm.set(String(r.farm_id), list);
  }
  for (const [farmId, eggs] of byFarm) {
    await ctx.q.query('UPDATE lay_events SET collected = true WHERE id = ANY($1::text[])', [eggs.map((e) => e.id)]);
    const add: Partial<EggStock> = {};
    for (const e of eggs) add[e.grade] = (add[e.grade] ?? 0) + 1;
    for (const [g, n] of Object.entries(add)) await ctx.q.query(`UPDATE farms SET crate_${g} = crate_${g} + $2 WHERE id = $1`, [farmId, n]);
    await logMachine(ctx.q, farmId, ctx.day, 'conveyor', { units: eggs.length });
    const farm = await loadFarm(ctx.q, farmId);
    for (const e of eggs) emit(ctx, farm, { kind: 'collected', eggId: e.id, grade: e.grade, auto: true });
    ctx.touched.add(farmId);
  }
}

/** A street sale's machine tally: what the grader's +10% and the clerk's +5% added (at their effect now). */
export async function logSale(ctx: Ctx, farm: Farm, sold: Partial<EggStock>, multiplier: number, m: MachinePower): Promise<void> {
  const eggs = Object.values(sold).reduce((a, b) => a + (b ?? 0), 0);
  const plain = saleValue(sold, multiplier, { power: {} });
  const graded = saleValue(sold, multiplier, { power: { grader: m.power.grader ?? 0 } });
  const all = saleValue(sold, multiplier, m);
  if ((m.power.grader ?? 0) > 0) await logMachine(ctx.q, farm.id, ctx.day, 'grader', { units: eggs, milli: (graded - plain) * 1000 });
  if ((m.power.clerk ?? 0) > 0) await logMachine(ctx.q, farm.id, ctx.day, 'clerk', { milli: (all - graded) * 1000 });
}

/** The price cap the hopper buys under, in milli-coins per bag (the farm's own, or the list price). */
export function hopperCap(farm: Farm, tier: FeedTier): number {
  return farm.hopperCapMilli && farm.hopperCapMilli > 0 ? farm.hopperCapMilli : Math.round(ECONOMY.feed.tiers[tier].bagPrice * 1000);
}

/**
 * The hopper at day close: when the trough holds less than refillBelowDays of the active feed, it
 * pours in enough to reach fillToDays, from the farm's own supplier, at or under the price cap and
 * within the farm's coins. buy() is the farm's own feed purchase (game.ts), told it is automatic.
 */
export async function hopperRefill(
  ctx: Ctx,
  farmId: string,
  buy: (ctx: Ctx, farm: Farm, tier: FeedTier, bags: number, unitCap: number) => Promise<{ bags: number; unitMilli: number } | null>,
): Promise<void> {
  const farm = await loadFarm(ctx.q, farmId);
  const [h] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farmId]);
  const need = num(h?.n) * feedGramsPerHenDay();
  if (need <= 0) return;
  const tier = farm.feedTier;
  const { refillBelowDays, fillToDays } = ECONOMY.unlocks.hopper;
  if (farm.feed[tier] >= need * refillBelowDays) return;
  const bagGrams = ECONOMY.feed.bagKg * 1000;
  const bags = Math.min(ECONOMY.limits.maxBagsPerPurchase, Math.ceil((need * fillToDays - farm.feed[tier]) / bagGrams));
  if (bags <= 0) return;
  const done = await buy(ctx, farm, tier, bags, hopperCap(farm, tier));
  if (!done) return;
  // what the hopper's 10% saved on the bags it poured
  const full = done.unitMilli / (1 - ECONOMY.unlocks.hopper.feedCostDiscount);
  await logMachine(ctx.q, farmId, ctx.day, 'hopper', { units: done.bags, milli: (full - done.unitMilli) * done.bags });
}

/** List price of a bag after the hopper's discount (for display). */
export const hopperBagPrice = (tier: FeedTier): number => feedBagPrice(tier, ['hopper']);
