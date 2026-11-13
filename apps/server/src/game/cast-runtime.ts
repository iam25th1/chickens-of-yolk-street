// Runs the cast inside the day close: opens (and reopens) agents, builds what each one sees,
// turns its decision into actions, orders and offers, charges its thinking, and closes it when bust.
import {
  AGENT_KINDS,
  ECONOMY,
  aiFarmCap,
  EGG_GRADES,
  coopCapacity,
  desperation,
  eggPrice,
  feedGramsPerHenDay,
  isCrash,
  loyalistBagPrice,
  marketReference,
  squeezerBagPrice,
  toMilli,
  type AgentKind,
  type CoopKind,
  type EggGrade,
  type FeedTier,
  type MarketDay,
  type UnlockId,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import { CAST, nameFor } from '../agents/cast';
import type { AgentContext, Decision, FarmAction, FarmBrief, WeekNumbers } from '../agents/decision';
import { ENTRANTS, entrantName } from '../agents/entrants';
import type { Candidate } from './cards';
import {
  AGENT_COLUMNS,
  ActionError,
  FARM_COLUMNS,
  agentCash,
  loadMemory,
  moveAgentCash,
  newId,
  setAgentStock,
  toAgent,
  toFarm,
  type AgentRow,
  type Ctx,
  type Farm,
  type WeekStart,
} from './ctx';
import { activeFarms, executeFill, liveMultiplier, loadOrderById, openSells, placeBuyOrder, placeSellOrder, recordTrade } from './market';
import { pick } from './rng';

export type CreateFarm = (
  ctx: Ctx,
  spec: { ownerKind: 'agent'; agentKey: string; name: string; cash: number; hens: number; coops: readonly CoopKind[]; feed: { tier: FeedTier; kg: number } },
) => Promise<string>;

export type ApplyFarmAction = (ctx: Ctx, farm: Farm, action: FarmAction) => Promise<void>;

async function loadAgents(ctx: Ctx, where = "status = 'open'"): Promise<AgentRow[]> {
  return (await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE ${where} ORDER BY kind, generation`)).map(toAgent);
}

/** Opens every role that has no base agent yet, and replaces bust base agents after a short gap. AI farms that entered later are never replaced here. */
export async function ensureCast(ctx: Ctx, createFarm: CreateFarm): Promise<AgentRow[]> {
  const opened: AgentRow[] = [];
  for (const kind of AGENT_KINDS) {
    const [latest] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE kind = $1 AND entrant_key IS NULL ORDER BY generation DESC LIMIT 1`, [kind]);
    const prev = latest ? toAgent(latest) : null;
    if (prev && prev.status === 'open') continue;
    if (prev && (prev.bustDay ?? 0) + ECONOMY.agents.replaceAfterDays > ctx.day) continue;
    const generation = (prev?.generation ?? 0) + 1;
    const member = CAST[kind];
    const name = nameFor(kind, generation);
    const id = newId();
    let farmId: string | null = null;
    let cash = 0;
    let stock: Record<string, number> = {};
    if (member.farm) {
      // brief 1 rivals already have farms keyed by kind; reuse them for the first generation
      const [existing] = generation === 1 ? await ctx.q.query('SELECT id FROM farms WHERE agent_key = $1', [kind]) : [];
      farmId = existing
        ? String(existing.id)
        : await createFarm(ctx, { ownerKind: 'agent', agentKey: generation === 1 ? kind : `${kind}-${generation}`, name, ...member.farm });
    } else if (member.role === 'supplier') {
      cash = toMilli(ECONOMY.suppliers.startCash);
      stock = { cheap: ECONOMY.suppliers.startBags, standard: ECONOMY.suppliers.startBags, premium: Math.round(ECONOMY.suppliers.startBags / 2), markup: 1 };
    } else {
      const b = ECONOMY.buyers;
      cash = toMilli(kind === 'bakery' ? b.bakery.startCash : kind === 'trader' ? b.trader.startCash : b.wholesaler.startCash);
    }
    const week: WeekStart = { day: ctx.day, cashMilli: member.farm ? toMilli(member.farm.cash) : cash, deals: 0, refusals: 0 };
    await ctx.q.query(
      `INSERT INTO agents (id, kind, role, name, generation, cash_milli, farm_id, stock, opened_day, week_start) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, kind, member.role, name, generation, cash, farmId, JSON.stringify(stock), ctx.day, JSON.stringify(week)],
    );
    const [row] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id]);
    if (row) opened.push(toAgent(row));
    if (prev) {
      ctx.out.push({ playerId: null, msg: { t: 'event', event: { kind: 'agentOpened', name, agentKind: kind } } });
      ctx.log(`[agents] ${name} opens as the new ${kind}`);
    }
    ctx.marketChanged = true;
  }
  return opened;
}

/** Open AI farms (rival agents), base rivals bust and waiting to reopen, open player farms, and the cap. */
export async function aiFarmCounts(q: Queryable): Promise<{ open: number; pending: number; players: number; cap: number }> {
  const [r] = await q.query(
    `SELECT (SELECT count(*) FROM agents WHERE status = 'open' AND role = 'rival') AS open,
            (SELECT count(*) FROM farms WHERE owner_kind = 'player' AND bust_day IS NULL) AS players`,
  );
  let pending = 0;
  for (const kind of AGENT_KINDS) {
    if (CAST[kind].role !== 'rival') continue;
    const [latest] = await q.query(`SELECT status FROM agents WHERE kind = $1 AND entrant_key IS NULL ORDER BY generation DESC LIMIT 1`, [kind]);
    if (latest?.status === 'bust') pending++;
  }
  const players = num(r?.players);
  return { open: num(r?.open), pending, players, cap: aiFarmCap(players) };
}

/**
 * The entry rule, at each day close (ctx.day is the new day): while the AI farms (open, plus base
 * rivals about to reopen) are under the cap, a new one enters with ECONOMY.agents.entry.chance when
 * supply stayed under demand on each of the last closed days or a rival went bust lately; under the
 * floor of open AI farms one enters whatever the chance. At most one a day. The game's seeded rng
 * decides, so a seed replays the same street.
 */
export async function enterAiFarm(ctx: Ctx, createFarm: CreateFarm): Promise<AgentRow | null> {
  const e = ECONOMY.agents.entry;
  const counts = await aiFarmCounts(ctx.q);
  const forced = counts.open < e.minAiFarms;
  let why = `only ${counts.open} AI farm${counts.open === 1 ? '' : 's'} open`;
  if (!forced) {
    if (counts.open + counts.pending >= counts.cap) return null;
    const closed = await ctx.q.query('SELECT supply, reference FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT $1', [e.scarceDays]);
    const scarce = closed.length === e.scarceDays && closed.every((d) => d.reference !== null && num(d.supply) < num(d.reference));
    const [bust] = await ctx.q.query(`SELECT name FROM agents WHERE role = 'rival' AND status = 'bust' AND bust_day >= $1 ORDER BY bust_day DESC LIMIT 1`, [
      ctx.day - e.bustLookbackDays,
    ]);
    if (!scarce && !bust) return null;
    if (ctx.rng() >= e.chance) return null;
    why = scarce ? `supply under demand for ${e.scarceDays} days` : `${String(bust?.name)} went bust`;
  }
  const openKeys = (await ctx.q.query<{ entrant_key: string }>(`SELECT entrant_key FROM agents WHERE status = 'open' AND entrant_key IS NOT NULL`)).map((r) => r.entrant_key);
  const free = ENTRANTS.filter((x) => !openKeys.includes(x.key));
  const entrant = pick(ctx.rng, free.length ? free : ENTRANTS);
  const [g] = await ctx.q.query('SELECT COALESCE(MAX(generation), 0) AS g FROM agents WHERE entrant_key = $1', [entrant.key]);
  const generation = num(g?.g) + 1;
  const taken = new Set((await ctx.q.query<{ name: string }>('SELECT name FROM farms WHERE bust_day IS NULL')).map((r) => r.name));
  const plain = entrantName(entrant, generation);
  const name = taken.has(plain) ? `${plain} ${generation}` : plain;
  const farmId = await createFarm(ctx, { ownerKind: 'agent', agentKey: `entrant-${entrant.key}-${generation}`, name, ...entrant.farm });
  const id = newId();
  const week: WeekStart = { day: ctx.day, cashMilli: toMilli(entrant.farm.cash), deals: 0, refusals: 0 };
  await ctx.q.query(
    `INSERT INTO agents (id, kind, role, name, generation, cash_milli, farm_id, stock, opened_day, entrant_key, week_start) VALUES ($1, $2, 'rival', $3, $4, 0, $5, '{}', $6, $7, $8)`,
    [id, entrant.looks, name, generation, farmId, ctx.day, entrant.key, JSON.stringify(week)],
  );
  ctx.out.push({ playerId: null, msg: { t: 'event', event: { kind: 'agentOpened', name, agentKind: entrant.looks } } });
  ctx.log(`[agents] ${name} enters Yolk Street as a new AI farm (${why}); ${counts.open + 1} AI farms open, cap ${counts.cap}`);
  ctx.marketChanged = true;
  const [row] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id]);
  return row ? toAgent(row) : null;
}

export async function openAgents(ctx: Ctx): Promise<AgentRow[]> {
  return loadAgents(ctx);
}

/** What every agent sees of the street the same: the trend, recent busts, and who is open. */
export interface StreetView {
  trend: AgentContext['market']['trend'];
  busts: AgentContext['market']['busts'];
  open: AgentContext['market']['open'];
}

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

export async function streetView(ctx: Ctx): Promise<StreetView> {
  const days = (await ctx.q.query('SELECT supply, reference, next_multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 3')).reverse();
  const demandNow = marketReference(await activeFarms(ctx.q));
  const supplyOverDemand = days.map((d) => round(num(d.supply) / Math.max(1, d.reference === null ? demandNow : num(d.reference)), 2));
  const ms = days.map((d) => num(d.next_multiplier));
  const slope = ms.length >= 2 ? round(((ms.at(-1) ?? 0) - (ms[0] ?? 0)) / (ms.length - 1), 3) : 0;
  const since = ctx.day - ECONOMY.agents.entry.bustLookbackDays;
  const busts = [
    ...(await ctx.q.query(`SELECT name, bust_day FROM agents WHERE status = 'bust' AND bust_day >= $1`, [since])).map((r) => ({ name: String(r.name), ai: true, day: num(r.bust_day) })),
    ...(await ctx.q.query(`SELECT name, bust_day FROM farms WHERE owner_kind = 'player' AND bust_day >= $1`, [since])).map((r) => ({ name: String(r.name), ai: false, day: num(r.bust_day) })),
  ]
    .sort((a, b) => b.day - a.day)
    .slice(0, 5);
  const counts = await aiFarmCounts(ctx.q);
  return { trend: { supplyOverDemand, slope }, busts, open: { aiFarms: counts.open, playerFarms: counts.players } };
}

/** What one agent sees when it decides. Numbers are rounded: the whole of it goes to the model on every call. */
export async function buildContext(ctx: Ctx, agent: AgentRow, history: MarketDay[], auctionHens: number, street: StreetView): Promise<AgentContext> {
  const m = await liveMultiplier(ctx);
  const prices = Object.fromEntries(EGG_GRADES.map((g) => [g, round(eggPrice(g, m, []), 3)])) as Record<EggGrade, number>;
  const sells = await openSells(ctx);
  const cash = (await agentCash(ctx, agent)) / 1000;
  const farms = (await ctx.q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE bust_day IS NULL`)).map(toFarm);
  const briefs: FarmBrief[] = [];
  let own: AgentContext['own'] = null;
  for (const f of farms) {
    const [h] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [f.id]);
    const hens = num(h?.n);
    const kinds = (await ctx.q.query<{ kind: CoopKind }>('SELECT kind FROM coops WHERE farm_id = $1', [f.id])).map((c) => c.kind);
    if (f.id === agent.farmId) {
      own = {
        hens,
        capacity: coopCapacity(kinds),
        freePlots: ECONOMY.coops.plots - kinds.length,
        crate: f.crate,
        feedGrams: f.feed,
        feedTier: f.feedTier,
        unlocks: (await ctx.q.query<{ unlock_id: UnlockId }>('SELECT unlock_id FROM unlocks WHERE farm_id = $1', [f.id])).map((u) => u.unlock_id),
        owes: round(num((await ctx.q.query(`SELECT COALESCE(SUM(due_milli - paid_milli), 0) AS s FROM debts WHERE farm_id = $1 AND status = 'open'`, [f.id]))[0]?.s) / 1000, 2),
      };
      continue;
    }
    const memory = await loadMemory(ctx.q, agent.id, f.id);
    const [contract] = await ctx.q.query(`SELECT 1 FROM contracts WHERE farm_id = $1 AND agent_id = $2 AND status = 'active'`, [f.id, agent.id]);
    const [owes] = await ctx.q.query(`SELECT COALESCE(SUM(due_milli - paid_milli), 0) AS s FROM debts WHERE farm_id = $1 AND agent_id = $2 AND status = 'open'`, [f.id, agent.id]);
    const feed = f.feed.cheap + f.feed.standard + f.feed.premium;
    briefs.push({
      farmId: f.id,
      name: f.name,
      owner: f.ownerKind,
      hens,
      capacity: coopCapacity(kinds),
      crate: f.crate,
      dailyEggs: Math.round(hens * ECONOMY.hen.baseLaying * Math.max(0.5, f.fedMultiplier)),
      feedDays: hens ? round(feed / (hens * feedGramsPerHenDay()), 1) : 99,
      cash: round(f.cashMilli / 1000, 2),
      quality: round(f.quality, 2),
      sells: sells.get(f.id) ?? [],
      hasContractWithMe: Boolean(contract),
      owesMe: round(num(owes?.s) / 1000, 2),
      memory: {
        deals: memory.deals,
        refusals: memory.refusals,
        hagglesWon: memory.hagglesWon,
        hagglesLost: memory.hagglesLost,
        misses: memory.misses,
        sulking: memory.sulkUntil > ctx.day,
      },
    });
  }
  const stock = Object.fromEntries(Object.entries(agent.stock).filter(([k]) => k !== 'markup'));
  return {
    day: ctx.day,
    agent: {
      id: agent.id,
      kind: agent.kind as AgentKind,
      role: agent.role,
      name: agent.name,
      cash: round(cash, 2),
      stock,
      struggling: cash < ECONOMY.agents.struggleCash,
      entrant: agent.entrant,
      reflection: agent.reflection,
      reasons: agent.reasons.slice(-3).map((r) => r.text),
    },
    market: {
      multiplier: round(m, 3),
      prices,
      reference: marketReference(await activeFarms(ctx.q)),
      supplyYesterday: history.at(-1)?.supply ?? 0,
      history: history.slice(-7).map((h) => ({ day: h.day, supply: h.supply, multiplier: round(h.multiplier, 3) })),
      crash: isCrash(m),
      auctionHens,
      ...street,
    },
    own,
    farms: briefs,
  };
}

/** Buyers turn yesterday's eggs into cash: the bakery bakes, the trader and wholesaler resell. */
export async function turnOverStock(ctx: Ctx, agent: AgentRow): Promise<void> {
  if (agent.role !== 'buyer') return;
  const m = await liveMultiplier(ctx);
  let income = 0;
  for (const g of EGG_GRADES) {
    const n = agent.stock[g] ?? 0;
    if (n <= 0) continue;
    if (agent.kind === 'bakery') income += n * toMilli(ECONOMY.buyers.bakery.bakeValue);
    else if (agent.kind === 'trader' && (g === 'brown' || g === 'golden')) income += n * toMilli(ECONOMY.buyers.trader.resale[g]);
    else {
      // resold into the street: it all counts as supply and pushes the price down
      const price = toMilli(eggPrice(g, m, []));
      income += n * price;
      await recordTrade(ctx, { seller: agent.name, sellerAgent: agent.id, buyer: 'Street market', grade: g, qty: n, priceMilli: price, via: 'resale' });
    }
  }
  if (income > 0) await moveAgentCash(ctx, agent, income, 'resale', 'stock');
  agent.stock = Object.fromEntries(Object.entries(agent.stock).filter(([k]) => !EGG_GRADES.includes(k as EggGrade)));
  await setAgentStock(ctx, agent.id, agent.stock);
}

/**
 * Applies one decision, bounded. 'close' runs before the market closes (farm actions and restock,
 * whose sales count in today's supply); 'open' runs once tomorrow's price is set (orders, fills and
 * offers, priced against it). Returns the offers that become player cards.
 */
export async function applyDecision(ctx: Ctx, agent: AgentRow, d: Decision, applyFarmAction: ApplyFarmAction, phase: 'close' | 'open'): Promise<Candidate[]> {
  const m = await liveMultiplier(ctx);
  const tryIt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      ctx.log(`[agents] ${agent.name} ${what} refused: ${err.message}`);
    }
  };

  if (phase === 'close') {
    if (agent.role === 'rival' && agent.farmId) {
      for (const a of d.farmActions) {
      const [row] = await ctx.q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [agent.farmId]);
      if (row) await tryIt(a.t, () => applyFarmAction(ctx, toFarm(row), a));
      }
    }
    if (agent.role === 'supplier') await restock(ctx, agent, d);
    return [];
  }

  if (agent.role === 'rival' && agent.farmId) {
    for (const s of d.sellOrders) {
      const [row] = await ctx.q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [agent.farmId]);
      if (!row) break;
      const farm = toFarm(row);
      const qty = Math.min(s.qty, farm.crate[s.grade]);
      if (qty > 0) await tryIt('sell order', () => placeSellOrder(ctx, farm, s.grade, qty, Math.max(0.3, Math.min(2.5, s.priceShare)) * eggPrice(s.grade, m, [])));
    }
  }

  if (agent.role === 'buyer') {
    for (const f of d.fills) {
      const order = await loadOrderById(ctx, f.orderId);
      if (!order || order.side !== 'sell') continue;
      if (order.priceMilli > toMilli(eggPrice(order.grade, m, [])) * 1.6) continue;
      await tryIt('fill', () => executeFill(ctx, order, f.qty, { agent }));
    }
    for (const b of d.buyOrders) {
      const price = toMilli(Math.max(0.3, Math.min(1.5, b.priceShare)) * eggPrice(b.grade, m, []));
      const qty = Math.min(b.qty, Math.floor((await agentCash(ctx, agent)) / Math.max(1, price)));
      if (qty > 0) await tryIt('buy order', () => placeBuyOrder(ctx, agent, b.grade, qty, price));
    }
  }

  // offers only to existing player farms
  const players = new Set((await ctx.q.query<{ id: string }>(`SELECT id FROM farms WHERE owner_kind = 'player' AND bust_day IS NULL`)).map((r) => r.id));
  return d.offers.filter((o) => players.has(o.farmId)).map((offer) => ({ agent, offer }));
}

async function restock(ctx: Ctx, agent: AgentRow, d: Decision): Promise<void> {
  const stock = { ...agent.stock };
    for (const t of ['cheap', 'standard', 'premium'] as const) {
      const bags = d.restock[t];
      if (bags <= 0) continue;
      const cost = bags * toMilli(ECONOMY.feed.tiers[t].bagPrice * ECONOMY.suppliers.wholesaleShare);
      if (cost > (await agentCash(ctx, agent))) continue;
      await moveAgentCash(ctx, agent, -cost, 'restock', t);
      stock[t] = (stock[t] ?? 0) + bags;
    }
    stock.markup = Math.max(0.8, Math.min(1.6, d.markup));
    agent.stock = stock;
    await setAgentStock(ctx, agent.id, stock);
}

/** How many public reasons an agent keeps. */
export const REASONS_KEPT = 5;

/** Keeps a decision's public reason with the agent (its last few, newest last). */
export async function recordReason(ctx: Ctx, agent: AgentRow, reason: string): Promise<void> {
  if (!reason) return;
  const reasons = [...agent.reasons, { day: ctx.day, text: reason }].slice(-REASONS_KEPT);
  agent.reasons = reasons;
  await ctx.q.query('UPDATE agents SET reasons = $2 WHERE id = $1', [agent.id, JSON.stringify(reasons)]);
}

/** Deals and refusals with every farm, all time: the week's counts are the difference from its start. */
async function dealTotals(q: Queryable, agentId: string): Promise<{ deals: number; refusals: number }> {
  const [r] = await q.query('SELECT COALESCE(SUM(deals), 0) AS deals, COALESCE(SUM(refusals), 0) AS refusals FROM agent_memory WHERE agent_id = $1', [agentId]);
  return { deals: num(r?.deals), refusals: num(r?.refusals) };
}

/** Where an agent's week stands now: its numbers today, to start the next week from. */
export async function weekNow(ctx: Ctx, agent: AgentRow): Promise<WeekStart> {
  return { day: ctx.day, cashMilli: await agentCash(ctx, agent), ...(await dealTotals(ctx.q, agent.id)) };
}

/**
 * The week an agent reflects on, once ECONOMY.agents.reflectEveryDays have passed since its week
 * started: its cash then and now, deals and refusals since, the busts it saw, and the market's
 * range. Null when no reflection is due (or its week has not started yet).
 */
export async function weekToReflect(ctx: Ctx, agent: AgentRow): Promise<{ week: WeekNumbers; now: WeekStart } | null> {
  const from = agent.weekStart;
  if (!from || ctx.day - from.day < ECONOMY.agents.reflectEveryDays) return null;
  const now = await weekNow(ctx, agent);
  const days = await ctx.q.query('SELECT multiplier FROM market_days WHERE day >= $1 AND day <= $2', [from.day, ctx.day]);
  const ms = days.map((d) => num(d.multiplier));
  const [b] = await ctx.q.query(
    `SELECT (SELECT count(*) FROM agents WHERE status = 'bust' AND bust_day >= $1 AND id <> $2) + (SELECT count(*) FROM farms WHERE owner_kind = 'player' AND bust_day >= $1) AS n`,
    [from.day, agent.id],
  );
  return {
    now,
    week: {
      fromDay: from.day,
      toDay: ctx.day,
      cashStart: round(from.cashMilli / 1000, 2),
      cashNow: round(now.cashMilli / 1000, 2),
      deals: Math.max(0, now.deals - from.deals),
      refusals: Math.max(0, now.refusals - from.refusals),
      bustsSeen: num(b?.n),
      multiplierLow: round(Math.min(...ms, 99), 2),
      multiplierHigh: round(Math.max(...ms, 0), 2),
      glutDays: ms.filter((x) => isCrash(x)).length,
    },
  };
}

/** Stores a weekly reflection, starts the agent's next week, and logs it. */
export async function storeReflection(ctx: Ctx, agent: AgentRow, text: string, now: WeekStart, brain: string): Promise<void> {
  await ctx.q.query('UPDATE agents SET reflection = $2, reflection_day = $3, week_start = $4 WHERE id = $1', [agent.id, text, ctx.day, JSON.stringify(now)]);
  agent.reflection = text;
  agent.reflectionDay = ctx.day;
  agent.weekStart = now;
  ctx.log(`[agents] ${agent.name} reflects on its week (${brain}): ${text}`);
}

/** Starts an agent's first week (agents opened before weekly reflections have none yet). */
export async function startWeek(ctx: Ctx, agent: AgentRow, now: WeekStart): Promise<void> {
  await ctx.q.query('UPDATE agents SET week_start = $2 WHERE id = $1', [agent.id, JSON.stringify(now)]);
  agent.weekStart = now;
}

/** Thinking costs coins; an agent below zero is bust. */
export async function chargeForThinking(ctx: Ctx, agent: AgentRow): Promise<void> {
  await moveAgentCash(ctx, agent, -toMilli(ECONOMY.agents.inferenceCostPerDecision), 'inference', agent.lastBrain ?? 'rules');
}

export async function bustIfBroke(ctx: Ctx, agent: AgentRow): Promise<boolean> {
  const cash = await agentCash(ctx, agent);
  if (cash >= toMilli(ECONOMY.agents.bustBelowCash)) return false;
  let hens = 0;
  if (agent.farmId) {
    hens = (await ctx.q.query(`UPDATE hens SET status = 'auction', farm_id = NULL WHERE farm_id = $1 AND status = 'alive' RETURNING id`, [agent.farmId])).length;
    await ctx.q.query('UPDATE farms SET bust_day = $2 WHERE id = $1', [agent.farmId, ctx.day]);
  }
  await ctx.q.query(`UPDATE agents SET status = 'bust', bust_day = $2 WHERE id = $1`, [agent.id, ctx.day]);
  await ctx.q.query(`UPDATE orders SET status = 'cancelled' WHERE agent_id = $1 AND status = 'open'`, [agent.id]);
  await ctx.q.query(`UPDATE contracts SET status = 'cancelled' WHERE agent_id = $1 AND status = 'active'`, [agent.id]);
  // a bust supplier's credit is forgiven
  await ctx.q.query(`UPDATE debts SET status = 'paid' WHERE agent_id = $1 AND status = 'open'`, [agent.id]);
  ctx.out.push({ playerId: null, msg: { t: 'event', event: { kind: 'rivalBust', name: agent.name, agentKind: agent.kind as AgentKind, hens } } });
  ctx.log(`[agents] ${agent.name} is bust on day ${ctx.day}${hens ? `; ${hens} hens go to auction` : ''}`);
  ctx.marketChanged = true;
  return true;
}

/** The Loyalist's quote for feed on credit, within its credit limit for that farm. */
export async function loyalistCreditQuote(ctx: Ctx, farm: Farm, tier: FeedTier, bags: number): Promise<{ agent: AgentRow; unitMilli: number }> {
  const [agent] = await loadAgents(ctx, `status = 'open' AND kind = 'loyalist'`);
  if (!agent || (agent.stock[tier] ?? 0) < bags) throw new ActionError('insufficient_stock', `no open Loyalist with ${bags} ${tier} bags`);
  const unitMilli = toMilli(loyalistBagPrice(tier, (await loadMemory(ctx.q, agent.id, farm.id)).deals) * (agent.stock.markup ?? 1));
  const [owed] = await ctx.q.query(`SELECT COALESCE(SUM(due_milli - paid_milli), 0) AS s FROM debts WHERE farm_id = $1 AND agent_id = $2 AND status = 'open'`, [
    farm.id,
    agent.id,
  ]);
  if (num(owed?.s) + unitMilli * bags > toMilli(ECONOMY.suppliers.loyalist.creditLimit)) throw new ActionError('invalid_action', 'over the Loyalist credit limit');
  return { agent, unitMilli };
}

/** The farm's chosen supplier quotes a bag (the Squeezer prices desperation in; the Loyalist rewards loyalty). */
export async function supplierQuote(ctx: Ctx, farm: Farm, tier: FeedTier, hens: number): Promise<{ agent: AgentRow | null; unitMilli: number }> {
  const agents = await loadAgents(ctx, `status = 'open' AND role = 'supplier'`);
  const order = [farm.supplier, farm.supplier === 'squeezer' ? 'loyalist' : 'squeezer'];
  for (const kind of order) {
    const agent = agents.find((a) => a.kind === kind && (a.stock[tier] ?? 0) > 0);
    if (!agent) continue;
    const feed = farm.feed.cheap + farm.feed.standard + farm.feed.premium;
    const feedDays = hens ? feed / (hens * feedGramsPerHenDay()) : 99;
    const base =
      kind === 'squeezer'
        ? squeezerBagPrice(tier, desperation(feedDays, farm.cashMilli / 1000))
        : loyalistBagPrice(tier, (await loadMemory(ctx.q, agent.id, farm.id)).deals);
    return { agent, unitMilli: toMilli(base * (agent.stock.markup ?? 1)) };
  }
  // no supplier open: the feed mill sells at list price plus a little
  return { agent: null, unitMilli: toMilli(ECONOMY.feed.tiers[tier].bagPrice * 1.15) };
}
