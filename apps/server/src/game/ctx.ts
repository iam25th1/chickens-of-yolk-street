// Shared plumbing for game modules: a transaction context, row mappers, and the only two ways
// money moves (farm cash with its ledger row, agent cash).
import { randomUUID } from 'node:crypto';
import type { EggStock, FeedStock, FeedTier, ServerMessage } from '@coys/shared';
import { num, type Queryable } from '../db/db';
import type { Rng } from './rng';

export class ActionError extends Error {
  constructor(
    readonly code:
      | 'insufficient_funds'
      | 'insufficient_stock'
      | 'invalid_action'
      | 'not_found'
      | 'farm_bust'
      | 'name_length'
      | 'name_characters'
      | 'name_letters'
      | 'name_rude'
      | 'name_email'
      | 'name_taken'
      | 'name_wait',
    message: string,
  ) {
    super(message);
  }
}

export type Outbound = { playerId: string | null; msg: ServerMessage };

/** One transaction's view of the game. Messages are queued and sent only after commit. */
export interface Ctx {
  q: Queryable;
  /** The database's season: stored with every ledger row and every settled day. */
  season: string;
  day: number;
  /** Length of an in-game day in milliseconds (ECONOMY.day.lengthMs unless a demo shortens it). */
  dayMs: number;
  now: number;
  /** Milliseconds into the current day. */
  elapsed: number;
  rng: Rng;
  log: (line: string) => void;
  out: Outbound[];
  /** Farms whose state changed and should be pushed to their owners. */
  touched: Set<string>;
  marketChanged: boolean;
}

export interface Farm {
  id: string;
  ownerKind: 'player' | 'agent';
  playerId: string | null;
  agentKey: string | null;
  name: string;
  cashMilli: number;
  feedTier: FeedTier;
  feed: FeedStock;
  fedMultiplier: number;
  crate: EggStock;
  bustDay: number | null;
  supplier: 'squeezer' | 'loyalist';
  clerkFloor: number;
  quality: number;
  /** The feed hopper's price cap per bag in milli-coins (0: the list price). */
  hopperCapMilli: number;
}

export const FARM_COLUMNS = `id, owner_kind, player_id, agent_key, name, cash_milli, feed_tier, feed_cheap_g, feed_standard_g,
  feed_premium_g, fed_multiplier, crate_white, crate_cream, crate_brown, crate_golden, bust_day, supplier, clerk_floor, quality, hopper_cap_milli`;

export function toFarm(r: Record<string, unknown>): Farm {
  return {
    id: String(r.id),
    ownerKind: r.owner_kind === 'agent' ? 'agent' : 'player',
    playerId: (r.player_id as string | null) ?? null,
    agentKey: (r.agent_key as string | null) ?? null,
    name: String(r.name),
    cashMilli: num(r.cash_milli),
    feedTier: r.feed_tier as FeedTier,
    feed: { cheap: num(r.feed_cheap_g), standard: num(r.feed_standard_g), premium: num(r.feed_premium_g) },
    fedMultiplier: num(r.fed_multiplier),
    crate: { white: num(r.crate_white), cream: num(r.crate_cream), brown: num(r.crate_brown), golden: num(r.crate_golden) },
    bustDay: r.bust_day === null || r.bust_day === undefined ? null : num(r.bust_day),
    supplier: r.supplier === 'squeezer' ? 'squeezer' : 'loyalist',
    clerkFloor: num(r.clerk_floor ?? 1),
    quality: num(r.quality ?? 0.35),
    hopperCapMilli: num(r.hopper_cap_milli ?? 0),
  };
}

export async function loadFarm(q: Queryable, farmId: string): Promise<Farm> {
  const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [farmId]);
  if (!row) throw new ActionError('not_found', 'farm not found');
  return toFarm(row);
}

/** The only way farm cash changes: balance and ledger row move together. */
export async function moveCash(ctx: Ctx, farmId: string, kind: string, amountMilli: number, ref: string): Promise<void> {
  if (amountMilli === 0) return;
  await ctx.q.query('UPDATE farms SET cash_milli = cash_milli + $2 WHERE id = $1', [farmId, amountMilli]);
  await ctx.q.query('INSERT INTO ledger (farm_id, season, day, kind, amount_milli, ref, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    farmId,
    ctx.season,
    ctx.day,
    kind,
    amountMilli,
    ref,
    ctx.now,
  ]);
  ctx.touched.add(farmId);
}

/** Spends farm cash, refusing to go below zero. */
export async function spend(ctx: Ctx, farm: Farm, kind: string, costMilli: number, ref: string): Promise<void> {
  if (costMilli > farm.cashMilli) {
    throw new ActionError('insufficient_funds', `costs ${(costMilli / 1000).toFixed(2)}, cash is ${(farm.cashMilli / 1000).toFixed(2)}`);
  }
  await moveCash(ctx, farm.id, kind, -costMilli, ref);
  farm.cashMilli -= costMilli;
}

export interface AgentRow {
  id: string;
  kind: string;
  role: 'rival' | 'supplier' | 'buyer';
  name: string;
  generation: number;
  status: 'open' | 'bust';
  cashMilli: number;
  farmId: string | null;
  stock: Record<string, number>;
  openedDay: number;
  bustDay: number | null;
  lastDecidedDay: number;
  lastBrain: string | null;
  account: string | null;
}

export const AGENT_COLUMNS =
  'id, kind, role, name, generation, status, cash_milli, farm_id, stock, opened_day, bust_day, last_decided_day, last_brain, near_account_id';

export function toAgent(r: Record<string, unknown>): AgentRow {
  const stock = typeof r.stock === 'string' ? (JSON.parse(r.stock) as Record<string, number>) : ((r.stock as Record<string, number>) ?? {});
  return {
    id: String(r.id),
    kind: String(r.kind),
    role: r.role as AgentRow['role'],
    name: String(r.name),
    generation: num(r.generation),
    status: r.status === 'bust' ? 'bust' : 'open',
    cashMilli: num(r.cash_milli),
    farmId: (r.farm_id as string | null) ?? null,
    stock,
    openedDay: num(r.opened_day),
    bustDay: r.bust_day === null || r.bust_day === undefined ? null : num(r.bust_day),
    lastDecidedDay: num(r.last_decided_day ?? 0),
    lastBrain: (r.last_brain as string | null) ?? null,
    account: (r.near_account_id as string | null) ?? null,
  };
}

export async function loadAgent(q: Queryable, agentId: string): Promise<AgentRow> {
  const [row] = await q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [agentId]);
  if (!row) throw new ActionError('not_found', 'agent not found');
  return toAgent(row);
}

/** An agent's spendable cash: its farm's cash for rivals, its own for everyone else. */
export async function agentCash(ctx: Ctx, agent: AgentRow): Promise<number> {
  if (agent.farmId) return (await loadFarm(ctx.q, agent.farmId)).cashMilli;
  const [r] = await ctx.q.query('SELECT cash_milli FROM agents WHERE id = $1', [agent.id]);
  return num(r?.cash_milli ?? 0);
}

/** Moves an agent's cash (a rival's goes through its farm ledger). */
export async function moveAgentCash(ctx: Ctx, agent: AgentRow, amountMilli: number, kind: string, ref: string): Promise<void> {
  if (amountMilli === 0) return;
  if (agent.farmId) return moveCash(ctx, agent.farmId, kind, amountMilli, ref);
  await ctx.q.query('UPDATE agents SET cash_milli = cash_milli + $2 WHERE id = $1', [agent.id, amountMilli]);
  agent.cashMilli += amountMilli;
}

export async function setAgentStock(ctx: Ctx, agentId: string, stock: Record<string, number>): Promise<void> {
  await ctx.q.query('UPDATE agents SET stock = $2 WHERE id = $1', [agentId, JSON.stringify(stock)]);
}

export interface Memory {
  deals: number;
  valueMilli: number;
  refusals: number;
  hagglesWon: number;
  hagglesLost: number;
  misses: number;
  sulkUntil: number;
}

export async function loadMemory(q: Queryable, agentId: string, farmId: string): Promise<Memory> {
  const [r] = await q.query('SELECT * FROM agent_memory WHERE agent_id = $1 AND farm_id = $2', [agentId, farmId]);
  return {
    deals: num(r?.deals ?? 0),
    valueMilli: num(r?.value_milli ?? 0),
    refusals: num(r?.refusals ?? 0),
    hagglesWon: num(r?.haggles_won ?? 0),
    hagglesLost: num(r?.haggles_lost ?? 0),
    misses: num(r?.misses ?? 0),
    sulkUntil: num(r?.sulk_until ?? 0),
  };
}

/** Adds to an agent's memory of a farm. */
export async function remember(
  ctx: Ctx,
  agentId: string,
  farmId: string,
  delta: Partial<{ deals: number; value_milli: number; refusals: number; haggles_won: number; haggles_lost: number; misses: number }>,
  sulkUntil?: number,
): Promise<void> {
  const cols = Object.keys(delta) as (keyof typeof delta)[];
  await ctx.q.query(
    `INSERT INTO agent_memory (agent_id, farm_id, last_day${cols.map((c) => `, ${c}`).join('')}${sulkUntil !== undefined ? ', sulk_until' : ''})
     VALUES ($1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}${sulkUntil !== undefined ? `, $${cols.length + 4}` : ''})
     ON CONFLICT (agent_id, farm_id) DO UPDATE SET last_day = $3${cols.map((c, i) => `, ${c} = agent_memory.${c} + $${i + 4}`).join('')}${
       sulkUntil !== undefined ? `, sulk_until = GREATEST(agent_memory.sulk_until, $${cols.length + 4})` : ''
     }`,
    [agentId, farmId, ctx.day, ...cols.map((c) => delta[c] ?? 0), ...(sulkUntil !== undefined ? [sulkUntil] : [])],
  );
}

export const newId = (): string => randomUUID();

export const eggTotal = (s: Partial<EggStock>): number => (s.white ?? 0) + (s.cream ?? 0) + (s.brown ?? 0) + (s.golden ?? 0);
