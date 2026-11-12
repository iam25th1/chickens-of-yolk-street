// The Feathers (beta): testnet NFTs that are claim tickets for the 777 Founding Hens, planned to be
// revealed and minted as hens at the mainnet launch. Ordinary hens are never minted.
//
// At every day close each player farm's standing is checked. A farm in good standing (never bust
// this season, no feed credit unpaid past its due day lately, no contract delivery missed lately)
// that has reached a milestone gets one roll for it, once. The roll is auditable: its seed is the
// SHA-256 of the season, the closed day, the farm, the milestone and the previous day's settlement
// transaction, and the roll is the seed's first 52 bits as a fraction of 2^52. A win is a Feather
// Ticket. The player redeems a ticket on the mint page for a coin fee; its grade comes from the
// farm's management score then, and the next day close mints the Feather (#001 to #777, in mint
// order) on NEAR testnet, game-paid. Rolls stop once the tickets out and Feathers minted reach 777.
import { createHash } from 'node:crypto';
import {
  coopCapacity,
  ECONOMY,
  FEATHER_GRADES,
  MILESTONE_IDS,
  RARITIES,
  toMilli,
  UNLOCK_IDS,
  type CoopKind,
  type FeatherGrade,
  type FeatherSlot,
  type FeatherTicketView,
  type ManagementScore,
  type MilestoneId,
  type Rarity,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import { ActionError, loadFarm, newId, spend, type Ctx } from './ctx';

const F = ECONOMY.feathers;

export interface Standing {
  good: boolean;
  /** Why not, in plain words (empty when good). */
  reasons: string[];
}

/** Good standing on the closed day: never bust, no credit unpaid past due lately, no contract missed lately. */
export async function standing(q: Queryable, farmId: string, day: number): Promise<Standing> {
  const reasons: string[] = [];
  const [f] = await q.query('SELECT bust_day, last_missed_day FROM farms WHERE id = $1', [farmId]);
  if (!f) return { good: false, reasons: ['no farm'] };
  if (f.bust_day !== null && f.bust_day !== undefined) reasons.push('went bust this season');
  const since = day - F.missWindowDays;
  const [d] = await q.query(
    `SELECT count(*) AS n FROM debts WHERE farm_id = $1 AND ((status = 'open' AND due_day < $2) OR (status = 'defaulted' AND due_day > $3))`,
    [farmId, day, since],
  );
  if (num(d?.n) > 0) reasons.push('feed credit unpaid past its due day');
  if (f.last_missed_day !== null && f.last_missed_day !== undefined && num(f.last_missed_day) > since) reasons.push('missed a contract delivery');
  return { good: reasons.length === 0, reasons };
}

/** Whether a farm has reached a milestone, as of the closed day. */
export async function reached(q: Queryable, farmId: string, m: MilestoneId, day: number): Promise<boolean> {
  switch (m) {
    case 'full-coop': {
      const [h] = await q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farmId]);
      const coops = await q.query('SELECT kind FROM coops WHERE farm_id = $1', [farmId]);
      const capacity = coopCapacity(coops.map((c) => c.kind as CoopKind));
      return capacity > 0 && num(h?.n) >= capacity;
    }
    case 'good-week': {
      const [f] = await q.query('SELECT good_since_day FROM farms WHERE id = $1', [farmId]);
      return f?.good_since_day !== null && f?.good_since_day !== undefined && day - num(f.good_since_day) + 1 >= F.goodDays;
    }
    case 'eggs-sold': {
      const [f] = await q.query('SELECT eggs_sold FROM farms WHERE id = $1', [farmId]);
      return num(f?.eggs_sold) >= F.eggsSold;
    }
    case 'haggles-won': {
      const [f] = await q.query('SELECT haggles_won FROM farms WHERE id = $1', [farmId]);
      return num(f?.haggles_won) >= F.hagglesWon;
    }
    case 'all-machines': {
      const [u] = await q.query('SELECT count(DISTINCT unlock_id) AS n FROM unlocks WHERE farm_id = $1', [farmId]);
      return num(u?.n) >= UNLOCK_IDS.length;
    }
    case 'outlast-rival': {
      const [r] = await q.query(
        `SELECT count(*) AS n FROM agents a, farms f WHERE f.id = $1 AND a.role = 'rival' AND a.status = 'bust' AND a.bust_day >= f.created_day`,
        [farmId],
      );
      return num(r?.n) > 0;
    }
    case 'top-three': {
      const rows = await q.query<{ id: string }>(`SELECT id FROM farms WHERE bust_day IS NULL ORDER BY cash_milli DESC, id LIMIT ${F.topRank}`);
      return rows.some((r) => r.id === farmId);
    }
    default:
      return false;
  }
}

/** The auditable roll: seed = sha256("coys-feather|season|day|farm|milestone|anchor"); roll = first 52 bits / 2^52. */
export function rollFor(season: string, day: number, farmId: string, milestone: string, anchor: string): { seed: string; roll: number } {
  const seed = createHash('sha256').update(`coys-feather|${season}|${day}|${farmId}|${milestone}|${anchor}`).digest('hex');
  return { seed, roll: parseInt(seed.slice(0, 13), 16) / 2 ** 52 };
}

export interface FeatherCount {
  max: number;
  /** Minted on chain, as last read from the contract (or the Feathers recorded here, without a chain). */
  minted: number;
  /** Feathers left to mint, of 777. */
  left: number;
  /** Tickets won and not yet minted (held or queued). */
  tickets: number;
  /** Tickets that may still be won: the 777 less the Feathers minted and the tickets out. */
  issuable: number;
}

export async function featherCount(q: Queryable, chainMinted: number | null): Promise<FeatherCount> {
  const [r] = await q.query(
    `SELECT count(*) FILTER (WHERE status IN ('held', 'queued')) AS out, count(*) FILTER (WHERE status = 'minted') AS minted FROM feather_tickets`,
  );
  const minted = Math.max(chainMinted ?? 0, num(r?.minted));
  const tickets = num(r?.out);
  return { max: F.maxSupply, minted, left: Math.max(0, F.maxSupply - minted), tickets, issuable: Math.max(0, F.maxSupply - minted - tickets) };
}

export interface RollOutcome {
  farmId: string;
  playerId: string | null;
  milestone: MilestoneId;
  won: boolean;
  ticketId: string | null;
  roll: number;
  seed: string;
}

/**
 * Day close: update every player farm's standing (and its count of days in good standing), then
 * roll each newly reached milestone for farms in good standing. A win is a Feather Ticket.
 */
export async function rollMilestones(ctx: Ctx, chainMinted: number | null, odds: number = F.odds): Promise<RollOutcome[]> {
  const q = ctx.q;
  const day = ctx.day;
  const [prev] = await q.query('SELECT settlement_tx FROM market_days WHERE season = $1 AND day = $2', [ctx.season, day - 1]);
  const anchor = (prev?.settlement_tx as string | null | undefined) ?? 'none';
  let { issuable } = await featherCount(q, chainMinted);
  const out: RollOutcome[] = [];
  const farms = await q.query<{ id: string; player_id: string | null; good_since_day: number | null }>(
    `SELECT id, player_id, good_since_day FROM farms WHERE owner_kind = 'player' ORDER BY created_day, id`,
  );
  for (const f of farms) {
    const s = await standing(q, f.id, day);
    if (!s.good) {
      if (f.good_since_day !== null) await q.query('UPDATE farms SET good_since_day = NULL WHERE id = $1', [f.id]);
      continue;
    }
    await q.query('UPDATE farms SET good_days = good_days + 1, good_since_day = COALESCE(good_since_day, $2) WHERE id = $1', [f.id, day]);
    const rolled = new Set((await q.query<{ milestone: string }>('SELECT milestone FROM milestone_rolls WHERE farm_id = $1', [f.id])).map((r) => r.milestone));
    for (const m of MILESTONE_IDS) {
      if (rolled.has(m) || issuable <= 0) continue;
      if (!(await reached(q, f.id, m, day))) continue;
      const { seed, roll } = rollFor(ctx.season, day, f.id, m, anchor);
      const won = roll < odds;
      let ticketId: string | null = null;
      if (won) {
        ticketId = newId();
        await q.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, status, created_at) VALUES ($1, $2, $3, $4, $5, 'held', $6)`, [
          ticketId,
          f.id,
          m,
          ctx.season,
          day,
          ctx.now,
        ]);
        issuable--;
      }
      await q.query(
        `INSERT INTO milestone_rolls (farm_id, milestone, season, day, anchor, seed, roll, odds, won, ticket_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [f.id, m, ctx.season, day, anchor, seed, roll, odds, won, ticketId],
      );
      rolled.add(m);
      ctx.log(`[feathers] season ${ctx.season} day ${day} farm ${f.id} milestone ${m}: anchor ${anchor} seed ${seed} roll ${roll.toFixed(6)} odds ${odds} ${won ? `WON ticket ${ticketId}` : 'missed'}`);
      out.push({ farmId: f.id, playerId: f.player_id, milestone: m, won, ticketId, roll, seed });
      ctx.touched.add(f.id);
    }
  }
  return out;
}

/** The grade a management score earns: the highest band it reaches. */
export function gradeFor(score: number): FeatherGrade {
  let grade: FeatherGrade = 'fluff';
  for (const g of FEATHER_GRADES) if (score + 1e-9 >= F.bands[g]) grade = g;
  return grade;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** The farm's management score now: days in good standing, delivery record, haggles won and profit, weighted. */
export async function managementScore(q: Queryable, farmId: string): Promise<ManagementScore> {
  const [f] = await q.query('SELECT good_days, haggles_won, cash_milli FROM farms WHERE id = $1', [farmId]);
  const [delivered] = await q.query(`SELECT count(*) AS n FROM trades WHERE seller_farm = $1 AND via = 'contract'`, [farmId]);
  const [missed] = await q.query('SELECT COALESCE(SUM(misses), 0) AS n FROM contracts WHERE farm_id = $1', [farmId]);
  const d = num(delivered?.n);
  const m = num(missed?.n);
  const parts = {
    goodDays: clamp01(num(f?.good_days) / F.score.full.goodDays),
    delivery: d + m === 0 ? F.score.noContracts : clamp01(d / (d + m)),
    haggles: clamp01(num(f?.haggles_won) / F.score.full.haggles),
    profit: clamp01((num(f?.cash_milli) / 1000 - ECONOMY.start.cash) / F.score.full.profit),
  };
  const w = F.score.weights;
  const score = Math.round((w.goodDays * parts.goodDays + w.delivery * parts.delivery + w.haggles * parts.haggles + w.profit * parts.profit) * 1000) / 1000;
  return { score, grade: gradeFor(score), parts };
}

/** Redeems a held ticket: the coin fee is paid, the grade set from the score now, and it mints at the next day close. */
export async function redeemTicket(ctx: Ctx, farmId: string, ticketId: string): Promise<{ grade: FeatherGrade; score: number; feeMilli: number }> {
  const [t] = await ctx.q.query('SELECT farm_id, status FROM feather_tickets WHERE id = $1', [ticketId]);
  if (!t || t.farm_id !== farmId) throw new ActionError('not_found', 'no such ticket on this farm');
  if (t.status !== 'held') throw new ActionError('invalid_action', 'this ticket is already redeemed');
  const farm = await loadFarm(ctx.q, farmId);
  const feeMilli = toMilli(F.redeemFee);
  await spend(ctx, farm, 'feather-fee', feeMilli, ticketId);
  const { score, grade } = await managementScore(ctx.q, farmId);
  await ctx.q.query(
    `UPDATE feather_tickets SET status = 'queued', grade = $2, score = $3, fee_milli = $4, redeemed_day = $5,
     redeemed_seq = (SELECT COALESCE(MAX(redeemed_seq), 0) + 1 FROM feather_tickets) WHERE id = $1`,
    [ticketId, grade, score, feeMilli, ctx.day],
  );
  ctx.log(`[feathers] farm ${farmId} redeemed ticket ${ticketId}: score ${score.toFixed(3)} grade ${grade}`);
  return { grade, score, feeMilli };
}

export async function ticketViews(q: Queryable, farmId: string): Promise<FeatherTicketView[]> {
  const rows = await q.query('SELECT * FROM feather_tickets WHERE farm_id = $1 ORDER BY day, created_at, id', [farmId]);
  return rows.map((r) => ({
    id: String(r.id),
    milestone: r.milestone as MilestoneId,
    day: num(r.day),
    status: r.status as FeatherTicketView['status'],
    grade: (r.grade as FeatherGrade | null) ?? null,
    score: r.score === null || r.score === undefined ? null : num(r.score),
    number: r.number === null || r.number === undefined ? null : num(r.number),
    owner: (r.owner_account as string | null) ?? null,
    mintTx: (r.mint_tx as string | null) ?? null,
    mintDay: r.mint_day === null || r.mint_day === undefined ? null : num(r.mint_day),
  }));
}

/**
 * Each grade's estimated chance of each hen rarity, given how many Feathers of each grade there are
 * (numbers not yet minted counted as Fluff). A Feather of grade g draws rarity r with chance
 * w[g][r] x[r] / sum over r' of w[g][r'] x[r'], where x scales each rarity so the 777 Feathers'
 * expected rarities add up to exactly 7/70/200/500 (found by iterating). An estimate: the reveal's
 * real draw is without replacement, and it locks then.
 */
export function rarityEstimates(byGrade: Record<FeatherGrade, number>): Record<FeatherGrade, Record<Rarity, number>> {
  const minted = FEATHER_GRADES.reduce((s, g) => s + byGrade[g], 0);
  const n: Record<FeatherGrade, number> = { ...byGrade, fluff: byGrade.fluff + Math.max(0, F.maxSupply - minted) };
  const K = F.rarityCounts;
  const x = [1, 1, 1, 1];
  const p = (g: FeatherGrade): number[] => {
    const w = F.gradeWeights[g];
    const t = w.reduce((s, wr, r) => s + wr * (x[r] ?? 0), 0);
    return w.map((wr, r) => (wr * (x[r] ?? 0)) / t);
  };
  for (let it = 0; it < 500; it++) {
    const expected = [0, 1, 2, 3].map((r) => FEATHER_GRADES.reduce((s, g) => s + n[g] * (p(g)[r] ?? 0), 0));
    let moved = 0;
    for (let r = 0; r < 4; r++) {
      const e = expected[r] ?? 0;
      const k = K[r] ?? 0;
      if (e > 0) {
        const nx = (x[r] ?? 0) * (k / e);
        moved = Math.max(moved, Math.abs(nx - (x[r] ?? 0)) / (x[r] ?? 1));
        x[r] = nx;
      }
    }
    if (moved < 1e-10) break;
  }
  return Object.fromEntries(FEATHER_GRADES.map((g) => [g, Object.fromEntries(RARITIES.map((r, i) => [r, p(g)[i] ?? 0]))])) as Record<FeatherGrade, Record<Rarity, number>>;
}

/** Every minted Feather, in number order, for the mint page. */
export async function featherSlots(q: Queryable): Promise<FeatherSlot[]> {
  const rows = await q.query(
    `SELECT t.number, t.grade, t.milestone, t.day, t.owner_account, t.mint_tx, f.name FROM feather_tickets t JOIN farms f ON f.id = t.farm_id
     WHERE t.status = 'minted' AND t.number IS NOT NULL ORDER BY t.number`,
  );
  return rows.map((r) => ({
    number: num(r.number),
    grade: r.grade as FeatherGrade,
    milestone: r.milestone as MilestoneId,
    day: num(r.day),
    owner: String(r.owner_account ?? ''),
    farm: String(r.name),
    mintTx: (r.mint_tx as string | null) ?? null,
  }));
}

/** The next milestone a farm has not rolled yet, in order, or null. */
export async function nextMilestone(q: Queryable, farmId: string): Promise<MilestoneId | null> {
  const rolled = new Set((await q.query<{ milestone: string }>('SELECT milestone FROM milestone_rolls WHERE farm_id = $1', [farmId])).map((r) => r.milestone));
  return MILESTONE_IDS.find((m) => !rolled.has(m)) ?? null;
}

/** A farm's milestones: rolled (won or missed) or still open. */
export async function milestoneViews(q: Queryable, farmId: string): Promise<{ id: MilestoneId; state: 'open' | 'won' | 'missed'; day: number | null }[]> {
  const rows = new Map((await q.query('SELECT milestone, won, day FROM milestone_rolls WHERE farm_id = $1', [farmId])).map((r) => [String(r.milestone), r]));
  return MILESTONE_IDS.map((id) => {
    const r = rows.get(id);
    return { id, state: r ? (r.won ? 'won' : 'missed') : 'open', day: r ? num(r.day) : null };
  });
}
