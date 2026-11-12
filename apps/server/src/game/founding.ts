// The Founding Hens: the only hens recorded on NEAR, 777 ever (the contract enforces the cap).
//
// At every day close each player farm's standing is checked. A farm in good standing (never bust
// this season, no feed credit unpaid past its due day lately, no contract delivery missed lately)
// that has reached a milestone gets one roll for it, once. The roll is auditable: its seed is the
// SHA-256 of the season, the closed day, the farm, the milestone and the previous day's settlement
// transaction, and the roll is the seed's first 52 bits as a fraction of 2^52. A win puts a new
// Founding Hen on the farm; the next day close mints her on NEAR with her milestone, season, day
// and traits. Rolls stop once 777 are minted or waiting to be.
import { createHash } from 'node:crypto';
import { coopCapacity, ECONOMY, MILESTONE_IDS, UNLOCK_IDS, type CoopKind, type MilestoneId } from '@coys/shared';
import { num, type Queryable } from '../db/db';
import type { Ctx } from './ctx';

const F = ECONOMY.founding;

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

/** The auditable roll: seed = sha256(season|day|farm|milestone|anchor); roll = first 52 bits / 2^52. */
export function rollFor(season: string, day: number, farmId: string, milestone: string, anchor: string): { seed: string; roll: number } {
  const seed = createHash('sha256').update(`coys-founding|${season}|${day}|${farmId}|${milestone}|${anchor}`).digest('hex');
  return { seed, roll: parseInt(seed.slice(0, 13), 16) / 2 ** 52 };
}

export interface FoundingCount {
  max: number;
  /** Minted on chain, as last read from the contract (or the founding hens recorded here, without a chain). */
  minted: number;
  /** Won here and waiting for a day close to mint them. */
  pending: number;
  remaining: number;
}

/** How many of the 777 are minted, waiting, and left. `chainMinted` is the contract's own count when known. */
export async function foundingCount(q: Queryable, chainMinted: number | null): Promise<FoundingCount> {
  const [r] = await q.query(
    `SELECT count(*) FILTER (WHERE mint_tx IS NULL) AS pending, count(*) FILTER (WHERE mint_tx IS NOT NULL) AS minted FROM hens WHERE founding_milestone IS NOT NULL`,
  );
  const pending = num(r?.pending);
  const minted = chainMinted ?? num(r?.minted);
  return { max: F.maxSupply, minted, pending, remaining: Math.max(0, F.maxSupply - minted - pending) };
}

export interface RollOutcome {
  farmId: string;
  playerId: string | null;
  milestone: MilestoneId;
  won: boolean;
  henId: string | null;
  roll: number;
  seed: string;
}

/**
 * Day close: update every player farm's standing, then roll each newly reached milestone for farms
 * in good standing. `newHen` puts a hen on a farm and returns her id.
 */
export async function rollMilestones(ctx: Ctx, chainMinted: number | null, newHen: (farmId: string) => Promise<string>, odds: number = F.odds): Promise<RollOutcome[]> {
  const q = ctx.q;
  const day = ctx.day;
  const [prev] = await q.query('SELECT settlement_tx FROM market_days WHERE season = $1 AND day = $2', [ctx.season, day - 1]);
  const anchor = (prev?.settlement_tx as string | null | undefined) ?? 'none';
  let { remaining } = await foundingCount(q, chainMinted);
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
    if (f.good_since_day === null) await q.query('UPDATE farms SET good_since_day = $2 WHERE id = $1', [f.id, day]);
    const rolled = new Set((await q.query<{ milestone: string }>('SELECT milestone FROM milestone_rolls WHERE farm_id = $1', [f.id])).map((r) => r.milestone));
    for (const m of MILESTONE_IDS) {
      if (rolled.has(m) || remaining <= 0) continue;
      if (!(await reached(q, f.id, m, day))) continue;
      const { seed, roll } = rollFor(ctx.season, day, f.id, m, anchor);
      const won = roll < odds;
      let henId: string | null = null;
      if (won) {
        henId = await newHen(f.id);
        await q.query('UPDATE hens SET founding_milestone = $2, founding_day = $3 WHERE id = $1', [henId, m, day]);
        remaining--;
      }
      await q.query(
        `INSERT INTO milestone_rolls (farm_id, milestone, season, day, anchor, seed, roll, odds, won, hen_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [f.id, m, ctx.season, day, anchor, seed, roll, odds, won, henId],
      );
      rolled.add(m);
      ctx.log(`[founding] season ${ctx.season} day ${day} farm ${f.id} milestone ${m}: anchor ${anchor} seed ${seed} roll ${roll.toFixed(6)} odds ${odds} ${won ? `WON hen ${henId}` : 'missed'}`);
      out.push({ farmId: f.id, playerId: f.player_id, milestone: m, won, henId, roll, seed });
      ctx.touched.add(f.id);
    }
  }
  return out;
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
