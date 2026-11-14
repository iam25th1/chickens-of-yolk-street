// Fresh Start: a player farm can end up with nothing to sell and no way to get anything (no eggs, no
// hens and too few coins for one; or hens with no feed, nothing laid today, too few coins for a bag
// and no credit), with no goal to claim either. Such a farm is at a dead end (FarmState.freshStart)
// and may start again: what it leaves behind closes as a bust's does (open orders, contracts, unpaid
// credit written off as defaulted), and it gets the starting coins, the starting feed and hens up to
// the starting flock. It counts as a bust on its record (farms.busts, public on the leaderboard, the
// market's farms ranking and its profile), and what it was given is taken out of its league profit.
import { ECONOMY, FEED_TIERS, power, toMilli } from '@coys/shared';
import { num } from '../db/db';
import { loyalistCreditQuote, millBagMilli, openSuppliers, quoteFrom } from './cast-runtime';
import { ActionError, eggTotal, moveCash, type Ctx, type Farm } from './ctx';
import { goalViews } from './goals';
import { excludeFromOpen, farmWorth } from './league';
import { loadMachines } from './machines';
import { cancelOrder, emit } from './market';

/** The cheapest hen in the shop now (breeder or auction), or the breeder's price with none listed. */
async function cheapestHenMilli(ctx: Ctx): Promise<number> {
  const listed = await ctx.q.query<{ status: string }>(`SELECT DISTINCT status FROM hens WHERE status IN ('forsale', 'auction')`);
  const prices = listed.map((r) => toMilli(ECONOMY.hen.price * (r.status === 'auction' ? ECONOMY.agents.auctionPriceFactor : 1)));
  return prices.length ? Math.min(...prices) : toMilli(ECONOMY.hen.price);
}

/**
 * The cheapest bag of feed the farm could buy now: each tier from each open supplier with it in stock
 * (the player may switch supplier), or from the mill when none has it, less the hopper's discount.
 */
async function cheapestBagMilli(ctx: Ctx, farm: Farm, hens: number): Promise<number> {
  const suppliers = await openSuppliers(ctx);
  const machines = await loadMachines(ctx.q, farm.id);
  const discount = 1 - ECONOMY.unlocks.hopper.feedCostDiscount * power(machines, 'hopper');
  let best = Infinity;
  for (const tier of FEED_TIERS) {
    const stocked = suppliers.filter((a) => (a.stock[tier] ?? 0) > 0);
    if (!stocked.length) best = Math.min(best, Math.round(millBagMilli(tier) * discount));
    for (const a of stocked) best = Math.min(best, Math.round((await quoteFrom(ctx, farm, a, tier, hens)) * discount));
  }
  return best;
}

/** Whether the Loyalist would sell the farm one bag of any tier on credit now. */
async function creditOpen(ctx: Ctx, farm: Farm): Promise<boolean> {
  for (const tier of FEED_TIERS) {
    try {
      await loyalistCreditQuote(ctx, farm, tier, 1);
      return true;
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }
  return false;
}

/**
 * A player farm (not bust) at a dead end: no eggs (in the crate or left in open sell orders), and
 * either no hens and fewer coins than the cheapest hen, or hens with no feed in any tier, none eaten
 * today, fewer coins than the cheapest bag and no credit from the Loyalist; and no goal ready to claim.
 */
export async function deadEnd(ctx: Ctx, farm: Farm): Promise<boolean> {
  if (farm.ownerKind !== 'player' || farm.bustDay !== null) return false;
  if (eggTotal(farm.crate) > 0) return false;
  const [o] = await ctx.q.query(`SELECT COALESCE(SUM(qty - filled_qty), 0) AS n FROM orders WHERE farm_id = $1 AND status = 'open' AND kind = 'limit' AND side = 'sell'`, [farm.id]);
  if (num(o?.n) > 0) return false;
  const [h] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farm.id]);
  const hens = num(h?.n);
  if (hens === 0) {
    if (farm.cashMilli >= (await cheapestHenMilli(ctx))) return false;
  } else {
    if (FEED_TIERS.some((t) => farm.feed[t] > 0) || farm.fedMultiplier > 0) return false;
    if (farm.cashMilli >= (await cheapestBagMilli(ctx, farm, hens))) return false;
    if (await creditOpen(ctx, farm)) return false;
  }
  return !(await goalViews(ctx.q, farm.id)).some((g) => g.state === 'ready');
}

/**
 * Takes a Fresh Start (refused unless the farm is at a dead end). Inserting hens is the game's own
 * (their looks and traits come from its seeded draw). Returns the farm's bust count now.
 */
export async function freshStart(ctx: Ctx, farm: Farm, insertHens: (ctx: Ctx, farmId: string, count: number) => Promise<string[]>): Promise<number> {
  if (!(await deadEnd(ctx, farm))) throw new ActionError('invalid_action', 'a Fresh Start is only for a farm at a dead end: no eggs and no way to get any');
  const before = await farmWorth(ctx.q, farm.id);
  // what it leaves behind closes as a bust's does
  for (const o of await ctx.q.query<{ id: string }>(`SELECT id FROM orders WHERE farm_id = $1 AND status = 'open' AND kind = 'limit'`, [farm.id])) await cancelOrder(ctx, farm, String(o.id));
  await ctx.q.query(`UPDATE contracts SET status = 'cancelled' WHERE farm_id = $1 AND status = 'active'`, [farm.id]);
  await ctx.q.query(`UPDATE debts SET status = 'defaulted' WHERE farm_id = $1 AND status = 'open'`, [farm.id]);
  // the start again: coins, a bag of feed, and hens up to the starting flock
  const s = ECONOMY.start;
  const cash = toMilli(s.cash);
  await moveCash(ctx, farm.id, 'fresh-start', cash, 'a fresh start');
  farm.cashMilli += cash;
  await ctx.q.query(`UPDATE farms SET feed_${s.feed.tier}_g = feed_${s.feed.tier}_g + $2, busts = busts + 1 WHERE id = $1`, [farm.id, s.feed.kg * 1000]);
  const [h] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farm.id]);
  const born = await insertHens(ctx, farm.id, Math.max(0, s.hens - num(h?.n)));
  // all it was given (and the credit written off) at book comes out of its league profit
  const granted = (await farmWorth(ctx.q, farm.id)) - before;
  await excludeFromOpen(ctx, farm.id, granted);
  const [b] = await ctx.q.query('SELECT busts FROM farms WHERE id = $1', [farm.id]);
  const busts = num(b?.busts);
  emit(ctx, farm, { kind: 'freshStart', busts });
  ctx.touched.add(farm.id);
  ctx.marketChanged = true;
  ctx.log(`[fresh] farm ${farm.id} took a Fresh Start on day ${ctx.day}: ${s.cash} coins, ${s.feed.kg} kg of ${s.feed.tier} feed, ${born.length} hens (${(granted / 1000).toFixed(2)} at book, out of its league profit); bust ${busts}`);
  return busts;
}
