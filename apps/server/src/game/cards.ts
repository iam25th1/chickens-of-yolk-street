// Decision cards. Agents' offers become 2 to 4 cards per player per day, arriving through the day.
// Players accept, decline, counter (a haggle of up to three rounds against the agent's hidden
// walk-away price) or pick the card's own option. The server prices and executes everything.
import {
  ECONOMY,
  EGG_GRADES,
  creditDue,
  eggPrice,
  toMilli,
  traderPrice,
  type AgentKind,
  type CardChoice,
  type CardKind,
  type CardOutcome,
  type CardView,
  type EggGrade,
  type FeedTier,
  type UnlockId,
} from '@coys/shared';
import { num } from '../db/db';
import { CAST, lineFor, replyFor, reserveFor } from '../agents/cast';
import type { Offer } from '../agents/decision';
import { haggleStep } from '../agents/haggle';
import {
  ActionError,
  AGENT_COLUMNS,
  loadFarm,
  loadMemory,
  moveAgentCash,
  moveCash,
  newId,
  remember,
  setAgentStock,
  spend,
  toAgent,
  type AgentRow,
  type Ctx,
  type Farm,
} from './ctx';
import { markGoal, takePractice } from './goals';
import { emit, executeFill, liveMultiplier, loadOrderById, recordTrade, streetSell } from './market';

export interface Candidate {
  agent: AgentRow;
  offer: Offer;
}

type Side = 'agent_buys' | 'agent_sells' | 'none';

const CHOICES: Record<CardKind, CardChoice[]> = {
  'bulk-order': ['accept', 'counter', 'decline'],
  'premium-order': ['accept', 'counter', 'decline'],
  'standing-contract': ['accept', 'counter', 'decline'],
  'feed-deal': ['accept', 'counter', 'switchSupplier', 'decline'],
  'credit-terms': ['accept', 'counter', 'decline'],
  undercut: ['matchPrice', 'hold'],
  'buyout-offer': ['sellHens', 'counter', 'decline'],
  'glut-warning': ['sellNow', 'hold'],
  'player-trade': ['accept', 'decline'],
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const coins = (milli: number): string => (milli / 1000).toFixed(2);

interface CardRow {
  id: string;
  farmId: string;
  agentId: string | null;
  kind: CardKind;
  day: number;
  arriveAtMs: number;
  status: CardView['status'];
  round: number;
  offerMilli: number;
  reserveMilli: number;
  side: Side;
  qty: number;
  grade: EggGrade | 'any' | null;
  tier: FeedTier | null;
  days: number | null;
  ref: string | null;
  line: string;
}

const toCard = (r: Record<string, unknown>): CardRow => ({
  id: String(r.id),
  farmId: String(r.farm_id),
  agentId: (r.agent_id as string | null) ?? null,
  kind: r.kind as CardKind,
  day: num(r.day),
  arriveAtMs: num(r.arrive_at_ms),
  status: r.status as CardView['status'],
  round: num(r.round),
  offerMilli: num(r.offer_milli),
  reserveMilli: num(r.reserve_milli),
  side: r.side as Side,
  qty: num(r.qty),
  grade: (r.grade as EggGrade | 'any' | null) ?? null,
  tier: (r.tier as FeedTier | null) ?? null,
  days: r.days === null || r.days === undefined ? null : num(r.days),
  ref: (r.ref as string | null) ?? null,
  line: String(r.line),
});

export async function cardView(ctx: Ctx, c: CardRow): Promise<CardView> {
  let kind: AgentKind | null = null;
  let from = 'Yolk Street';
  if (c.agentId) {
    const [a] = await ctx.q.query('SELECT kind, name FROM agents WHERE id = $1', [c.agentId]);
    kind = (a?.kind as AgentKind) ?? null;
    from = String(a?.name ?? from);
  } else if (c.kind === 'player-trade' && c.ref) {
    const [o] = await ctx.q.query('SELECT f.name FROM orders o JOIN farms f ON f.id = o.farm_id WHERE o.id = $1', [c.ref]);
    from = String(o?.name ?? 'A neighbour');
  }
  return {
    id: c.id,
    kind: c.kind,
    agentKind: kind,
    from,
    day: c.day,
    arriveAtMs: c.arriveAtMs,
    status: c.status,
    round: c.round,
    offerMilli: c.offerMilli,
    qty: c.qty,
    grade: c.grade,
    tier: c.tier,
    days: c.days,
    line: c.line,
    choices: c.status === 'open' ? CHOICES[c.kind] : [],
  };
}

export async function farmCards(ctx: Ctx, farmId: string): Promise<CardView[]> {
  const rows = await ctx.q.query('SELECT * FROM cards WHERE farm_id = $1 AND day = $2 AND notified ORDER BY arrive_at_ms', [farmId, ctx.day]);
  return Promise.all(rows.map((r) => cardView(ctx, toCard(r))));
}

/** Prices an offer for a farm, in milli-coins per unit, with the side that haggles. */
function price(o: Offer, m: number): { unit: number; qty: number; side: Side; grade: EggGrade | 'any' | null; tier: FeedTier | null; days: number | null } {
  const white = eggPrice('white', m, []);
  switch (o.kind) {
    case 'bulk-order':
      return { unit: toMilli(clamp(o.priceShare, 0.4, 1) * white), qty: o.qty, side: 'agent_buys', grade: 'any', tier: null, days: null };
    case 'premium-order': {
      const live = eggPrice(o.grade, m, []);
      const cap = ECONOMY.buyers.trader.resale[o.grade] * 0.95;
      return { unit: toMilli(Math.min(cap, clamp(o.priceShare, 1, 1.6) * live)), qty: o.qty, side: 'agent_buys', grade: o.grade, tier: null, days: null };
    }
    case 'standing-contract':
      return { unit: toMilli(clamp(o.priceShare, 0.8, 1.6) * white), qty: o.qtyPerDay, side: 'agent_buys', grade: 'any', tier: null, days: o.days };
    case 'feed-deal':
      return { unit: toMilli(clamp(o.priceShare, 0.8, 1.6) * ECONOMY.feed.tiers[o.tier].bagPrice), qty: o.bags, side: 'agent_sells', grade: null, tier: o.tier, days: null };
    case 'credit-terms':
      return {
        unit: toMilli(clamp(o.priceShare, 0.85, 1.4) * ECONOMY.feed.tiers[o.tier].bagPrice),
        qty: o.bags,
        side: 'agent_sells',
        grade: null,
        tier: o.tier,
        days: ECONOMY.suppliers.loyalist.creditDays,
      };
    case 'undercut':
      return { unit: toMilli(clamp(o.priceShare, 0.7, 1) * traderPrice(o.grade === 'golden' ? 'golden' : 'brown', m)), qty: o.qty, side: 'none', grade: o.grade, tier: null, days: null };
    case 'buyout-offer':
      return { unit: toMilli(clamp(o.priceShare, 0.5, 1.2) * ECONOMY.hen.price), qty: o.hens, side: 'agent_buys', grade: null, tier: null, days: null };
    case 'glut-warning':
      return { unit: 0, qty: 0, side: 'none', grade: null, tier: null, days: null };
  }
}

function score(kind: CardKind, unit: number, qty: number, crash: boolean): number {
  if (kind === 'glut-warning') return crash ? 1e9 : 1;
  if (kind === 'feed-deal' || kind === 'credit-terms') return 40_000 + qty * 1000;
  return unit * Math.max(1, qty);
}

/**
 * Turns the day's offers into cards for each player farm: at most one per agent, at most
 * ECONOMY.cards.maxPerDay, spread over the arrival times.
 */
export async function createCards(ctx: Ctx, candidates: Candidate[], playerTrades: { farmId: string; orderId: string }[]): Promise<number> {
  const m = await liveMultiplier(ctx);
  const crash = m <= ECONOMY.market.crashAt;
  const byFarm = new Map<string, { agent: AgentRow | null; offer: Offer | null; orderId?: string; s: number }[]>();
  for (const c of candidates) {
    const p = price(c.offer, m);
    const list = byFarm.get(c.offer.farmId) ?? [];
    if (list.some((x) => x.agent?.id === c.agent.id)) continue;
    list.push({ agent: c.agent, offer: c.offer, s: score(c.offer.kind, p.unit, p.qty, crash) });
    byFarm.set(c.offer.farmId, list);
  }
  for (const t of playerTrades) {
    const list = byFarm.get(t.farmId) ?? [];
    list.push({ agent: null, offer: null, orderId: t.orderId, s: 5_000 });
    byFarm.set(t.farmId, list);
  }
  let made = 0;
  for (const [farmId, list] of byFarm) {
    const [farm] = await ctx.q.query(`SELECT owner_kind FROM farms WHERE id = $1 AND bust_day IS NULL`, [farmId]);
    if (!farm || farm.owner_kind !== 'player') continue;
    list.sort((a, b) => b.s - a.s);
    const pick = list.slice(0, ECONOMY.cards.maxPerDay);
    for (const [i, item] of pick.entries()) {
      const at = Math.floor((ECONOMY.cards.arriveAt[i] ?? 0.7) * ctx.dayMs);
      if (item.offer && item.agent) {
        const p = price(item.offer, m);
        const kind = item.agent.kind as AgentKind;
        const memory = await loadMemory(ctx.q, item.agent.id, farmId);
        const reserve = p.side === 'none' ? p.unit : Math.round(reserveFor(kind, p.unit, p.side, memory));
        const due = item.offer.kind === 'credit-terms' ? coins(Math.round(creditDue((p.unit * p.qty) / 1000) * 1000)) : '';
        const line =
          item.offer.line.trim().slice(0, 160) ||
          lineFor(kind, item.offer.kind, { qty: p.qty, price: coins(p.unit), tier: p.tier ?? '', days: p.days ?? '', grade: p.grade ?? '', due });
        await ctx.q.query(
          `INSERT INTO cards (id, farm_id, agent_id, kind, day, arrive_at_ms, offer_milli, reserve_milli, side, qty, grade, tier, days, line)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [newId(), farmId, item.agent.id, item.offer.kind, ctx.day, at, p.unit, reserve, p.side, p.qty, p.grade, p.tier, p.days, line],
        );
      } else if (item.orderId) {
        const order = await loadOrderById(ctx, item.orderId);
        if (!order) continue;
        const [seller] = await ctx.q.query('SELECT name FROM farms WHERE id = $1', [order.farmId]);
        const left = order.qty - order.filled;
        const line = lineFor(null, 'player-trade', { seller: String(seller?.name ?? 'A neighbour'), qty: left, grade: order.grade, price: coins(order.priceMilli) });
        await ctx.q.query(
          `INSERT INTO cards (id, farm_id, kind, day, arrive_at_ms, offer_milli, reserve_milli, side, qty, grade, ref, line)
           VALUES ($1, $2, 'player-trade', $3, $4, $5, $5, 'none', $6, $7, $8, $9)`,
          [newId(), farmId, ctx.day, at, order.priceMilli, left, order.grade, order.id, line],
        );
      }
      made++;
    }
  }
  return made;
}

/** Cards whose time has come: tell the player, and let the sales clerk take good offers. */
export async function arriveCards(ctx: Ctx): Promise<void> {
  const rows = await ctx.q.query('SELECT * FROM cards WHERE day = $1 AND NOT notified AND arrive_at_ms <= $2 ORDER BY arrive_at_ms', [ctx.day, ctx.elapsed]);
  for (const r of rows) {
    const card = toCard(r);
    await ctx.q.query('UPDATE cards SET notified = true WHERE id = $1', [card.id]);
    const farm = await loadFarm(ctx.q, card.farmId);
    emit(ctx, farm, { kind: 'cardArrived', card: await cardView(ctx, card) });
    ctx.touched.add(farm.id);
    if (card.kind === 'bulk-order' || card.kind === 'premium-order') {
      const [clerk] = await ctx.q.query(`SELECT 1 FROM unlocks WHERE farm_id = $1 AND unlock_id = 'clerk'`, [farm.id]);
      const m = await liveMultiplier(ctx);
      const live = toMilli(eggPrice(card.grade && card.grade !== 'any' ? card.grade : 'white', m, []));
      if (clerk && card.offerMilli >= live * farm.clerkFloor) {
        try {
          await acceptCard(ctx, farm, card, card.offerMilli, 'accepted', true);
        } catch (err) {
          if (!(err instanceof ActionError)) throw err;
        }
      }
    }
  }
}

/** Day close: unanswered cards expire. */
export async function expireCards(ctx: Ctx): Promise<void> {
  await ctx.q.query(`UPDATE cards SET status = 'expired' WHERE day = $1 AND status = 'open'`, [ctx.day]);
}

async function agentFor(ctx: Ctx, card: CardRow): Promise<AgentRow> {
  const [r] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [card.agentId]);
  if (!r) throw new ActionError('not_found', 'that trader has left');
  const a = toAgent(r);
  if (a.status !== 'open') throw new ActionError('invalid_action', `${a.name} has closed`);
  return a;
}

async function resolve(ctx: Ctx, farm: Farm, card: CardRow, status: CardView['status'], outcome: CardOutcome, totalMilli: number, auto: boolean): Promise<void> {
  await ctx.q.query('UPDATE cards SET status = $2, outcome_milli = $3 WHERE id = $1', [card.id, status, totalMilli]);
  card.status = status;
  emit(ctx, farm, { kind: 'cardResolved', card: await cardView(ctx, card), outcome, totalMilli, auto });
  if (outcome === 'won' && !auto) await markGoal(ctx.q, farm.id, 'haggle');
  ctx.touched.add(farm.id);
}

/** Takes up to n eggs of a grade (or any grade, cheapest first) from a farm's crate. */
async function takeEggs(ctx: Ctx, farm: Farm, grade: EggGrade | 'any', n: number): Promise<Partial<Record<EggGrade, number>>> {
  const taken: Partial<Record<EggGrade, number>> = {};
  let left = n;
  for (const g of grade === 'any' ? EGG_GRADES : [grade]) {
    const k = Math.min(left, farm.crate[g]);
    if (k <= 0) continue;
    await ctx.q.query(`UPDATE farms SET crate_${g} = crate_${g} - $2 WHERE id = $1`, [farm.id, k]);
    farm.crate[g] -= k;
    taken[g] = k;
    left -= k;
  }
  return taken;
}

/** A buyer agent takes eggs from a farm at a unit price; returns the total paid. */
export async function sellToAgent(ctx: Ctx, farm: Farm, agent: AgentRow, grade: EggGrade | 'any', qty: number, unit: number, via: 'card' | 'contract'): Promise<number> {
  const cash = agent.farmId ? (await loadFarm(ctx.q, agent.farmId)).cashMilli : agent.cashMilli;
  const n = Math.min(qty, Math.floor(cash / Math.max(1, unit)));
  if (n <= 0) throw new ActionError('invalid_action', `${agent.name} cannot pay right now`);
  const taken = await takeEggs(ctx, farm, grade, n);
  let total = 0;
  const stock = { ...agent.stock };
  for (const [g, k] of Object.entries(taken) as [EggGrade, number][]) {
    total += k * unit;
    stock[g] = (stock[g] ?? 0) + k;
    await recordTrade(ctx, { seller: farm.name, sellerFarm: farm.id, buyer: agent.name, buyerAgent: agent.id, grade: g, qty: k, priceMilli: unit, via });
  }
  if (total <= 0) throw new ActionError('insufficient_stock', 'not enough eggs in the crate');
  await moveCash(ctx, farm.id, 'sale', total, `${via}:${agent.kind}`);
  farm.cashMilli += total;
  await moveAgentCash(ctx, agent, -total, 'purchase', farm.id);
  agent.stock = stock;
  await setAgentStock(ctx, agent.id, stock);
  await remember(ctx, agent.id, farm.id, { deals: 1, value_milli: total });
  return total;
}

/** Buys bags from a supplier agent at a unit price per bag. */
export async function buyBagsFrom(ctx: Ctx, farm: Farm, supplier: AgentRow, tier: FeedTier, bags: number, unit: number, credit: boolean): Promise<number> {
  const have = supplier.stock[tier] ?? 0;
  if (have < bags) throw new ActionError('insufficient_stock', `${supplier.name} has only ${have} ${tier} bags`);
  const total = unit * bags;
  if (credit) {
    const due = Math.round(creditDue(total / 1000) * 1000);
    await ctx.q.query(
      'INSERT INTO debts (id, farm_id, agent_id, principal_milli, due_milli, due_day) VALUES ($1, $2, $3, $4, $5, $6)',
      [newId(), farm.id, supplier.id, total, due, ctx.day + ECONOMY.suppliers.loyalist.creditDays],
    );
  } else {
    await spend(ctx, farm, 'feed', total, `${bags} ${tier} from ${supplier.kind}`);
    await moveAgentCash(ctx, supplier, total, 'feed sale', farm.id);
  }
  const stock = { ...supplier.stock, [tier]: have - bags };
  supplier.stock = stock;
  await setAgentStock(ctx, supplier.id, stock);
  await ctx.q.query(`UPDATE farms SET feed_${tier}_g = feed_${tier}_g + $2 WHERE id = $1`, [farm.id, bags * ECONOMY.feed.bagKg * 1000]);
  await remember(ctx, supplier.id, farm.id, { deals: 1, value_milli: total });
  emit(ctx, farm, { kind: 'feedBought', tier, bags, costMilli: credit ? 0 : total, supplier: supplier.name });
  return total;
}

async function acceptCard(ctx: Ctx, farm: Farm, card: CardRow, unit: number, status: 'accepted' | 'won', auto: boolean): Promise<void> {
  let total = 0;
  switch (card.kind) {
    case 'bulk-order':
    case 'premium-order':
      total = await sellToAgent(ctx, farm, await agentFor(ctx, card), card.grade ?? 'any', card.qty, unit, 'card');
      break;
    case 'standing-contract': {
      const agent = await agentFor(ctx, card);
      await ctx.q.query(
        'INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [newId(), farm.id, agent.id, card.grade ?? 'any', card.qty, unit, ctx.day, ctx.day + (card.days ?? 4) - 1],
      );
      await remember(ctx, agent.id, farm.id, { deals: 1 });
      total = unit * card.qty * (card.days ?? 1);
      break;
    }
    case 'feed-deal':
    case 'credit-terms':
      total = await buyBagsFrom(ctx, farm, await agentFor(ctx, card), card.tier ?? 'standard', card.qty, unit, card.kind === 'credit-terms');
      break;
    case 'undercut': {
      // match the rival's price: sell to the market trader at it
      const [t] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE kind = 'trader' AND status = 'open' ORDER BY generation DESC LIMIT 1`);
      if (!t) throw new ActionError('invalid_action', 'no trader is buying');
      total = await sellToAgent(ctx, farm, toAgent(t), card.grade ?? 'brown', card.qty, unit, 'card');
      break;
    }
    case 'buyout-offer': {
      const agent = await agentFor(ctx, card);
      if (!agent.farmId) throw new ActionError('invalid_action', 'no farm to take the hens');
      const hens = await ctx.q.query(`SELECT id FROM hens WHERE farm_id = $1 AND status = 'alive' ORDER BY born_day, id LIMIT $2`, [farm.id, card.qty]);
      const buyerCash = (await loadFarm(ctx.q, agent.farmId)).cashMilli;
      const n = Math.min(hens.length, Math.floor(buyerCash / Math.max(1, unit)));
      if (n <= 0) throw new ActionError('invalid_action', `${agent.name} cannot pay right now`);
      const ids = hens.slice(0, n).map((h) => String(h.id));
      await ctx.q.query('UPDATE hens SET farm_id = $1, lay_progress = 0 WHERE id = ANY($2::text[])', [agent.farmId, ids]);
      total = n * unit;
      await moveCash(ctx, farm.id, 'hens sold', total, card.id);
      await moveCash(ctx, agent.farmId, 'hens bought', -total, card.id);
      await remember(ctx, agent.id, farm.id, { deals: 1, value_milli: total });
      ctx.touched.add(agent.farmId);
      break;
    }
    case 'glut-warning': {
      const unlocks = (await ctx.q.query<{ unlock_id: UnlockId }>('SELECT unlock_id FROM unlocks WHERE farm_id = $1', [farm.id])).map((u) => u.unlock_id);
      if (farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden <= 0) throw new ActionError('insufficient_stock', 'the crate is empty');
      total = (await streetSell(ctx, farm, { ...farm.crate }, unlocks)).totalMilli;
      break;
    }
    case 'player-trade': {
      const order = card.ref ? await loadOrderById(ctx, card.ref) : null;
      if (!order) throw new ActionError('not_found', 'those eggs are already gone');
      const n = await executeFill(ctx, order, card.qty, { farm });
      if (n <= 0) throw new ActionError('insufficient_funds', 'not enough coins');
      total = n * order.priceMilli;
      break;
    }
  }
  await resolve(ctx, farm, card, status, status === 'won' ? 'won' : 'accepted', total, auto);
}

/** A player's answer to a card. */
export async function respondCard(ctx: Ctx, farm: Farm, cardId: string, choice: CardChoice, ask: number | undefined): Promise<void> {
  const [r] = await ctx.q.query('SELECT * FROM cards WHERE id = $1 AND farm_id = $2', [cardId, farm.id]);
  if (!r) throw new ActionError('not_found', 'card not found');
  const card = toCard(r);
  if (card.day !== ctx.day || card.status !== 'open') throw new ActionError('invalid_action', 'that card is closed');
  if (card.arriveAtMs > ctx.elapsed) throw new ActionError('invalid_action', 'that card has not arrived');
  if (!CHOICES[card.kind].includes(choice)) throw new ActionError('invalid_action', `${choice} is not an option on this card`);

  switch (choice) {
    case 'accept':
    case 'sellHens':
    case 'matchPrice':
    case 'sellNow':
      return acceptCard(ctx, farm, card, card.offerMilli, card.round > 0 ? 'won' : 'accepted', false);
    case 'decline':
    case 'hold':
      if (card.kind === 'undercut' && choice === 'hold') await rivalTakesSale(ctx, card);
      if (card.agentId && choice === 'decline') await remember(ctx, card.agentId, farm.id, { refusals: 1 });
      return resolve(ctx, farm, card, 'declined', 'declined', 0, false);
    case 'switchSupplier': {
      const agent = await agentFor(ctx, card);
      await ctx.q.query('UPDATE farms SET supplier = $2 WHERE id = $1', [farm.id, agent.kind]);
      return resolve(ctx, farm, card, 'accepted', 'accepted', 0, false);
    }
    case 'counter': {
      if (card.side === 'none' || ask === undefined) throw new ActionError('invalid_action', 'this card has no price to haggle');
      const agent = await agentFor(ctx, card);
      const kind = agent.kind as AgentKind;
      const askMilli = toMilli(ask);
      const result = haggleStep({ offer: card.offerMilli, reserve: card.reserveMilli, round: card.round, side: card.side }, askMilli, CAST[kind].personality);
      if (result.outcome === 'accept') {
        await remember(ctx, agent.id, farm.id, { haggles_won: 1 });
        card.line = replyFor(kind, 'win', { price: coins(askMilli) });
        await ctx.q.query('UPDATE cards SET line = $2, round = round + 1 WHERE id = $1', [card.id, card.line]);
        card.round += 1;
        return acceptCard(ctx, farm, card, askMilli, 'won', false);
      }
      if (result.outcome === 'counter') {
        const offer = Math.round(result.offer);
        card.offerMilli = offer;
        card.round += 1;
        card.line = replyFor(kind, 'counter', { price: coins(offer) });
        await ctx.q.query('UPDATE cards SET offer_milli = $2, round = $3, line = $4 WHERE id = $1', [card.id, offer, card.round, card.line]);
        const mood = card.round >= ECONOMY.haggle.maxRounds - 1 ? 'cross' : 'firm';
        emit(ctx, farm, { kind: 'haggle', card: await cardView(ctx, card), mood });
        ctx.touched.add(farm.id);
        return;
      }
      await remember(ctx, agent.id, farm.id, { haggles_lost: 1, refusals: 1 });
      card.line = replyFor(kind, result.insulted ? 'insulted' : 'walk', {});
      await ctx.q.query('UPDATE cards SET line = $2 WHERE id = $1', [card.id, card.line]);
      return resolve(ctx, farm, card, 'failed', 'failed', 0, false);
    }
  }
}

/**
 * The tour's practice offer: a buyer asks for a few eggs at a little under today's white price,
 * arriving at once. Its walk-away price sits just above the offer, so a first counter always gets a
 * counter back: the player sees a haggle happen. Sent once per farm, beside the day's own cards;
 * asking again does nothing.
 */
export async function practiceCard(ctx: Ctx, farm: Farm): Promise<void> {
  const [row] = await ctx.q.query(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE status = 'open' AND role = 'buyer' ORDER BY (kind = 'wholesaler') DESC, (kind = 'trader') DESC, kind LIMIT 1`,
  );
  if (!row) throw new ActionError('not_found', 'no buyer is open');
  // a replayed tour asks again: the offer came once, so there is nothing more to send
  if (!(await takePractice(ctx.q, farm.id))) return;
  const agent = toAgent(row);
  const kind = agent.kind as AgentKind;
  const m = await liveMultiplier(ctx);
  const unit = Math.max(10, Math.round((toMilli(eggPrice('white', m, [])) * 0.95) / 10) * 10);
  const stock = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  const qty = Math.max(1, Math.min(4, stock));
  const id = newId();
  const line = lineFor(kind, 'bulk-order', { qty, price: coins(unit), grade: 'any' });
  await ctx.q.query(
    `INSERT INTO cards (id, farm_id, agent_id, kind, day, arrive_at_ms, offer_milli, reserve_milli, side, qty, grade, line, notified)
     VALUES ($1, $2, $3, 'bulk-order', $4, $5, $6, $7, 'agent_buys', $8, 'any', $9, true)`,
    [id, farm.id, agent.id, ctx.day, Math.max(0, ctx.elapsed - 1), unit, Math.round(unit * 1.05), qty, line],
  );
  const [r] = await ctx.q.query('SELECT * FROM cards WHERE id = $1', [id]);
  emit(ctx, farm, { kind: 'cardArrived', card: await cardView(ctx, toCard(r as Record<string, unknown>)) });
  ctx.touched.add(farm.id);
}

/** When a player holds against an undercut, the rival sells its own eggs to the trader instead. */
async function rivalTakesSale(ctx: Ctx, card: CardRow): Promise<void> {
  if (!card.agentId) return;
  const rival = await agentFor(ctx, card).catch(() => null);
  const [t] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE kind = 'trader' AND status = 'open' ORDER BY generation DESC LIMIT 1`);
  if (!rival?.farmId || !t) return;
  const rivalFarm = await loadFarm(ctx.q, rival.farmId);
  const grade = card.grade && card.grade !== 'any' ? card.grade : 'brown';
  if (rivalFarm.crate[grade] <= 0) return;
  await sellToAgent(ctx, rivalFarm, toAgent(t), grade, Math.min(card.qty, rivalFarm.crate[grade]), card.offerMilli, 'card').catch(() => 0);
}

export const cardCount = async (ctx: Ctx, farmId: string): Promise<number> =>
  num((await ctx.q.query('SELECT count(*) AS n FROM cards WHERE farm_id = $1 AND day = $2', [farmId, ctx.day]))[0]?.n ?? 0);
