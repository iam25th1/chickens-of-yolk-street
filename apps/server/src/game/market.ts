// The shared market: street sells at the live price, the order book (resting limit orders from
// farms and buyer agents), and the trade log. Every egg sold anywhere counts toward the day's
// supply, which sets tomorrow's price.
import {
  ECONOMY,
  EGG_GRADES,
  eggPrice,
  emptyEggStock,
  limitPriceOk,
  saleValue,
  toMilli,
  type EggGrade,
  type EggStock,
  type GameEvent,
  type TradeView,
  type UnlockId,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import { ActionError, eggTotal, loadFarm, moveAgentCash, moveCash, newId, setAgentStock, toAgent, AGENT_COLUMNS, type AgentRow, type Ctx, type Farm } from './ctx';

const BIG_TRADE_MILLI = 25_000;

export async function liveMultiplier(ctx: Ctx): Promise<number> {
  const [md] = await ctx.q.query('SELECT multiplier FROM market_days WHERE day = $1', [ctx.day]);
  return num(md?.multiplier ?? ECONOMY.market.openingMultiplier);
}

/** Player farms still farming plus open agents: the market's demand scales with them. */
export async function activeFarms(q: Queryable): Promise<number> {
  const [r] = await q.query(
    `SELECT (SELECT count(*) FROM agents WHERE status = 'open') + (SELECT count(*) FROM farms WHERE owner_kind = 'player' AND bust_day IS NULL) AS n`,
  );
  return num(r?.n);
}

export interface TradeInput {
  seller: string;
  sellerFarm?: string | null;
  sellerAgent?: string | null;
  buyer: string;
  buyerFarm?: string | null;
  buyerAgent?: string | null;
  grade: EggGrade;
  qty: number;
  priceMilli: number;
  via: TradeView['via'];
}

/** Logs a sale, adds it to today's supply and tracks the seller's quality. */
export async function recordTrade(ctx: Ctx, t: TradeInput): Promise<void> {
  if (t.qty <= 0) return;
  const total = t.qty * t.priceMilli;
  await ctx.q.query(
    `INSERT INTO trades (day, at, seller, seller_farm, seller_agent, buyer, buyer_farm, buyer_agent, grade, qty, price_milli, total_milli, via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [ctx.day, ctx.now, t.seller, t.sellerFarm ?? null, t.sellerAgent ?? null, t.buyer, t.buyerFarm ?? null, t.buyerAgent ?? null, t.grade, t.qty, t.priceMilli, total, t.via],
  );
  await ctx.q.query('UPDATE market_days SET supply = supply + $2 WHERE day = $1', [ctx.day, t.qty]);
  if (t.sellerFarm) {
    const share = t.grade === 'brown' || t.grade === 'golden' ? 1 : 0;
    await ctx.q.query('UPDATE farms SET quality = quality * 0.85 + $2 * 0.15 WHERE id = $1', [t.sellerFarm, share]);
  }
  ctx.marketChanged = true;
  if (total >= BIG_TRADE_MILLI) {
    const trade: TradeView = { day: ctx.day, seller: t.seller, buyer: t.buyer, grade: t.grade, qty: t.qty, priceMilli: t.priceMilli, totalMilli: total, via: t.via };
    ctx.out.push({ playerId: null, msg: { t: 'event', event: { kind: 'bigTrade', trade } } });
  }
}

export function emit(ctx: Ctx, farm: Farm | null, event: GameEvent): void {
  if (farm?.playerId) ctx.out.push({ playerId: farm.playerId, msg: { t: 'event', event } });
}

/** Instant sell to the street at the live price (the existing market sell). */
export async function streetSell(ctx: Ctx, farm: Farm, items: Partial<EggStock>, unlocks: UnlockId[]): Promise<{ totalMilli: number; multiplier: number; sold: EggStock }> {
  const sold = emptyEggStock();
  for (const g of EGG_GRADES) {
    const n = items[g] ?? 0;
    if (n > farm.crate[g]) throw new ActionError('insufficient_stock', `only ${farm.crate[g]} ${g} eggs in the crate`);
    sold[g] = n;
  }
  if (eggTotal(sold) <= 0) throw new ActionError('invalid_action', 'nothing to sell');
  const multiplier = await liveMultiplier(ctx);
  const totalMilli = toMilli(saleValue(sold, multiplier, unlocks));
  const dealId = newId();
  for (const g of EGG_GRADES) {
    if (!sold[g]) continue;
    const price = toMilli(eggPrice(g, multiplier, unlocks));
    await ctx.q.query(`UPDATE farms SET crate_${g} = crate_${g} - $2 WHERE id = $1`, [farm.id, sold[g]]);
    farm.crate[g] -= sold[g];
    await ctx.q.query(
      `INSERT INTO orders (id, deal_id, farm_id, day, side, kind, grade, qty, price_milli, status, created_at, filled_qty)
       VALUES ($1, $2, $3, $4, 'sell', 'market', $5, $6, $7, 'filled', $8, $6)`,
      [newId(), dealId, farm.id, ctx.day, g, sold[g], price, ctx.now],
    );
    await recordTrade(ctx, { seller: farm.name, sellerFarm: farm.id, buyer: 'Street market', grade: g, qty: sold[g], priceMilli: price, via: 'street' });
  }
  await moveCash(ctx, farm.id, 'sale', totalMilli, dealId);
  farm.cashMilli += totalMilli;
  return { totalMilli, multiplier, sold };
}

interface OrderRow {
  id: string;
  farmId: string | null;
  agentId: string | null;
  side: 'buy' | 'sell';
  grade: EggGrade;
  qty: number;
  filled: number;
  priceMilli: number;
  expiresDay: number;
}

const toOrder = (r: Record<string, unknown>): OrderRow => ({
  id: String(r.id),
  farmId: (r.farm_id as string | null) ?? null,
  agentId: (r.agent_id as string | null) ?? null,
  side: r.side as 'buy' | 'sell',
  grade: r.grade as EggGrade,
  qty: num(r.qty),
  filled: num(r.filled_qty),
  priceMilli: num(r.price_milli),
  expiresDay: num(r.expires_day ?? 0),
});

const ORDER_COLS = 'id, farm_id, agent_id, side, grade, qty, filled_qty, price_milli, expires_day';

async function loadOrder(ctx: Ctx, orderId: string): Promise<OrderRow | null> {
  const [r] = await ctx.q.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 AND status = 'open' AND kind = 'limit'`, [orderId]);
  return r ? toOrder(r) : null;
}

async function party(ctx: Ctx, o: OrderRow): Promise<{ name: string; farm: Farm | null; agent: AgentRow | null }> {
  if (o.farmId) {
    const farm = await loadFarm(ctx.q, o.farmId);
    return { name: farm.name, farm, agent: null };
  }
  const [r] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [o.agentId]);
  const agent = r ? toAgent(r) : null;
  return { name: agent?.name ?? 'Unknown buyer', farm: null, agent };
}

/**
 * Executes qty against a resting order at its price. The taker is a farm (selling into a buy
 * order, or buying another farm's eggs) or a buyer agent (buying a farm's eggs).
 */
export async function executeFill(ctx: Ctx, order: OrderRow, qty: number, taker: { farm?: Farm; agent?: AgentRow }): Promise<number> {
  const open = order.qty - order.filled;
  let n = Math.min(qty, open);
  if (n <= 0) return 0;
  const maker = await party(ctx, order);
  const price = order.priceMilli;

  if (order.side === 'buy') {
    // taker sells eggs from its crate into the buy order
    const seller = taker.farm;
    if (!seller) throw new ActionError('invalid_action', 'only farms sell into buy orders');
    n = Math.min(n, seller.crate[order.grade]);
    const buyerCash = maker.agent ? (maker.agent.farmId ? (await loadFarm(ctx.q, maker.agent.farmId)).cashMilli : maker.agent.cashMilli) : (maker.farm?.cashMilli ?? 0);
    n = Math.min(n, Math.floor(buyerCash / Math.max(1, price)));
    if (n <= 0) throw new ActionError('insufficient_stock', 'nothing to fill');
    await ctx.q.query(`UPDATE farms SET crate_${order.grade} = crate_${order.grade} - $2 WHERE id = $1`, [seller.id, n]);
    seller.crate[order.grade] -= n;
    await moveCash(ctx, seller.id, 'sale', n * price, order.id);
    seller.cashMilli += n * price;
    if (maker.agent) {
      await moveAgentCash(ctx, maker.agent, -n * price, 'purchase', order.id);
      const stock = { ...maker.agent.stock, [order.grade]: (maker.agent.stock[order.grade] ?? 0) + n };
      await setAgentStock(ctx, maker.agent.id, stock);
    }
    await recordTrade(ctx, { seller: seller.name, sellerFarm: seller.id, buyer: maker.name, buyerAgent: maker.agent?.id ?? null, buyerFarm: maker.farm?.id ?? null, grade: order.grade, qty: n, priceMilli: price, via: 'order' });
    emit(ctx, seller, { kind: 'orderFilled', orderId: order.id, side: 'sell', qty: n, priceMilli: price, counterparty: maker.name });
  } else {
    // taker buys a farm's reserved eggs
    const sellerFarm = maker.farm;
    if (!sellerFarm) throw new ActionError('not_found', 'seller gone');
    if (taker.farm) {
      if (taker.farm.id === sellerFarm.id) throw new ActionError('invalid_action', 'that is your own order');
      n = Math.min(n, Math.floor(taker.farm.cashMilli / Math.max(1, price)));
      if (n <= 0) throw new ActionError('insufficient_funds', 'not enough coins');
      await moveCash(ctx, taker.farm.id, 'purchase', -n * price, order.id);
      taker.farm.cashMilli -= n * price;
      await ctx.q.query(`UPDATE farms SET crate_${order.grade} = crate_${order.grade} + $2 WHERE id = $1`, [taker.farm.id, n]);
      taker.farm.crate[order.grade] += n;
      emit(ctx, taker.farm, { kind: 'orderFilled', orderId: order.id, side: 'buy', qty: n, priceMilli: price, counterparty: sellerFarm.name });
    } else if (taker.agent) {
      const cash = taker.agent.farmId ? (await loadFarm(ctx.q, taker.agent.farmId)).cashMilli : taker.agent.cashMilli;
      n = Math.min(n, Math.floor(cash / Math.max(1, price)));
      if (n <= 0) return 0;
      await moveAgentCash(ctx, taker.agent, -n * price, 'purchase', order.id);
      const stock = { ...taker.agent.stock, [order.grade]: (taker.agent.stock[order.grade] ?? 0) + n };
      taker.agent.stock = stock;
      await setAgentStock(ctx, taker.agent.id, stock);
    }
    await moveCash(ctx, sellerFarm.id, 'sale', n * price, order.id);
    const buyerName = taker.farm?.name ?? taker.agent?.name ?? 'Buyer';
    await recordTrade(ctx, {
      seller: sellerFarm.name,
      sellerFarm: sellerFarm.id,
      buyer: buyerName,
      buyerFarm: taker.farm?.id ?? null,
      buyerAgent: taker.agent?.id ?? null,
      grade: order.grade,
      qty: n,
      priceMilli: price,
      via: taker.farm ? 'player' : 'order',
    });
    emit(ctx, sellerFarm, { kind: 'orderFilled', orderId: order.id, side: 'sell', qty: n, priceMilli: price, counterparty: buyerName });
    ctx.touched.add(sellerFarm.id);
  }
  const filled = order.filled + n;
  await ctx.q.query(`UPDATE orders SET filled_qty = $2, status = CASE WHEN $2 >= qty THEN 'filled' ELSE 'open' END WHERE id = $1`, [order.id, filled]);
  order.filled = filled;
  return n;
}

/** A farm's limit sell: eggs leave the crate into the order, then it matches any good buy order. */
export async function placeSellOrder(ctx: Ctx, farm: Farm, grade: EggGrade, qty: number, priceCoins: number): Promise<string> {
  const multiplier = await liveMultiplier(ctx);
  if (!limitPriceOk(grade, priceCoins, multiplier)) throw new ActionError('invalid_action', 'price is too far from the market');
  if (qty > farm.crate[grade]) throw new ActionError('insufficient_stock', `only ${farm.crate[grade]} ${grade} eggs in the crate`);
  const [count] = await ctx.q.query(`SELECT count(*) AS n FROM orders WHERE farm_id = $1 AND status = 'open' AND kind = 'limit'`, [farm.id]);
  if (num(count?.n) >= ECONOMY.orders.maxOpenPerFarm) throw new ActionError('invalid_action', 'too many open orders');
  const price = toMilli(priceCoins);
  const id = newId();
  await ctx.q.query(`UPDATE farms SET crate_${grade} = crate_${grade} - $2 WHERE id = $1`, [farm.id, qty]);
  farm.crate[grade] -= qty;
  await ctx.q.query(
    `INSERT INTO orders (id, deal_id, farm_id, day, side, kind, grade, qty, price_milli, status, created_at, expires_day)
     VALUES ($1, $1, $2, $3, 'sell', 'limit', $4, $5, $6, 'open', $7, $8)`,
    [id, farm.id, ctx.day, grade, qty, price, ctx.now, ctx.day + ECONOMY.orders.expireAfterDays],
  );
  ctx.marketChanged = true;
  // cross with resting buy orders at or above the ask, best price first
  const sell = await loadOrder(ctx, id);
  const buys = await ctx.q.query(
    `SELECT ${ORDER_COLS} FROM orders WHERE status = 'open' AND kind = 'limit' AND side = 'buy' AND grade = $1 AND price_milli >= $2 ORDER BY price_milli DESC, created_at`,
    [grade, price],
  );
  for (const b of buys.map(toOrder)) {
    if (!sell || sell.filled >= sell.qty || !b.agentId) break;
    const [ar] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 AND status = 'open'`, [b.agentId]);
    if (!ar) continue;
    const agent = toAgent(ar);
    const want = Math.min(b.qty - b.filled, sell.qty - sell.filled);
    // the incoming sell meets the resting buy: the buyer pays its own (higher) bid
    const n = await executeFill(ctx, { ...sell, priceMilli: b.priceMilli }, want, { agent });
    sell.filled += n;
    if (n > 0) {
      await ctx.q.query(`UPDATE orders SET filled_qty = filled_qty + $2, status = CASE WHEN filled_qty + $2 >= qty THEN 'filled' ELSE 'open' END WHERE id = $1`, [b.id, n]);
    }
  }
  return id;
}

/** A buyer agent's resting buy order; it first takes any farm sell orders at or below its bid. */
export async function placeBuyOrder(ctx: Ctx, agent: AgentRow, grade: EggGrade, qty: number, priceMilli: number): Promise<void> {
  const sells = await ctx.q.query(
    `SELECT ${ORDER_COLS} FROM orders WHERE status = 'open' AND kind = 'limit' AND side = 'sell' AND grade = $1 AND price_milli <= $2 ORDER BY price_milli, created_at`,
    [grade, priceMilli],
  );
  let left = qty;
  for (const s of sells.map(toOrder)) {
    if (left <= 0) break;
    left -= await executeFill(ctx, s, left, { agent });
  }
  if (left <= 0) return;
  await ctx.q.query(
    `INSERT INTO orders (id, deal_id, agent_id, day, side, kind, grade, qty, price_milli, status, created_at, expires_day)
     VALUES ($1, $1, $2, $3, 'buy', 'limit', $4, $5, $6, 'open', $7, $8)`,
    [newId(), agent.id, ctx.day, grade, left, priceMilli, ctx.now, ctx.day + 1],
  );
  ctx.marketChanged = true;
}

export async function fillOrderAction(ctx: Ctx, farm: Farm, orderId: string, qty: number): Promise<void> {
  const order = await loadOrder(ctx, orderId);
  if (!order) throw new ActionError('not_found', 'that order is gone');
  if (order.farmId === farm.id) throw new ActionError('invalid_action', 'that is your own order');
  const n = await executeFill(ctx, order, qty, { farm });
  if (n <= 0) throw new ActionError('insufficient_stock', 'nothing filled');
}

export async function cancelOrder(ctx: Ctx, farm: Farm, orderId: string): Promise<void> {
  const order = await loadOrder(ctx, orderId);
  if (!order || order.farmId !== farm.id) throw new ActionError('not_found', 'order not found');
  await returnEggs(ctx, order);
  await ctx.q.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
  ctx.marketChanged = true;
}

async function returnEggs(ctx: Ctx, order: OrderRow): Promise<void> {
  const left = order.qty - order.filled;
  if (order.side === 'sell' && order.farmId && left > 0) {
    await ctx.q.query(`UPDATE farms SET crate_${order.grade} = crate_${order.grade} + $2 WHERE id = $1`, [order.farmId, left]);
    ctx.touched.add(order.farmId);
  }
}

/** Day close: expired orders come off the book; unsold eggs go back to their crates. */
export async function expireOrders(ctx: Ctx): Promise<void> {
  const rows = await ctx.q.query(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'open' AND kind = 'limit' AND expires_day <= $1`, [ctx.day]);
  for (const o of rows.map(toOrder)) {
    await returnEggs(ctx, o);
    await ctx.q.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [o.id]);
  }
}

/** Open sell orders by farm, for agent contexts. */
export async function openSells(ctx: Ctx): Promise<Map<string, { orderId: string; grade: EggGrade; qty: number; price: number }[]>> {
  const rows = await ctx.q.query(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'open' AND kind = 'limit' AND side = 'sell' AND farm_id IS NOT NULL`);
  const out = new Map<string, { orderId: string; grade: EggGrade; qty: number; price: number }[]>();
  for (const o of rows.map(toOrder)) {
    const list = out.get(o.farmId as string) ?? [];
    list.push({ orderId: o.id, grade: o.grade, qty: o.qty - o.filled, price: o.priceMilli / 1000 });
    out.set(o.farmId as string, list);
  }
  return out;
}

export async function loadOrderById(ctx: Ctx, orderId: string): Promise<OrderRow | null> {
  return loadOrder(ctx, orderId);
}
