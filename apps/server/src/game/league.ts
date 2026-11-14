// The league, server side: weekly and seasonal leaderboards of every farm (players and AI) by profit
// at book values over the window (packages/shared/src/league.ts has the book values and the windows,
// docs/league.md the rules). A window opens with an entry for every open farm at its net worth then;
// a farm made later enters when it is made, at its starting worth. A farm that goes bust has its
// entries frozen at what it held, before its assets go. Scores are live while a window is open:
// net worth now less net worth at the start, less what is not farming (player-to-player trades, both
// ways, and Fresh Start grants). Ties go to the higher management score, then the earlier start,
// then the farm id. A window's close (at most once: it is claimed by its status, in one transaction
// with everything it does) fixes every score and rank, hashes a season's canonical standings, and
// gives the rewards: a week's top three players a Feather Ticket each (within the 777), a season's
// top ten a grade step on their next redemption, every player farm that sold eggs in a season its
// season badge, and a farm back from a bust in a week's top ten the comeback badge. AI farms rank
// but take no reward (the next player takes the slot); neither does a farm that is bust.
import { createHash } from 'node:crypto';
import {
  EGG_GRADES,
  LEAGUE_TICKET_MILESTONE,
  canonicalStandings,
  leagueSeason,
  leagueSeasonAt,
  leagueWeekAt,
  leagueWorth,
  seasonBadgeId,
  tradeExclusion,
  type AgentKind,
  type BadgeLevel,
  type CoopKind,
  type EggGrade,
  type LeaderboardEntry,
  type LeaderboardPast,
  type LeaderboardView,
  type LeagueBoard,
  type LeagueConfig,
  type LeagueHoldings,
  type LeagueWindowSpec,
  type UnlockId,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import { evaluateBadges } from './badges';
import type { Ctx } from './ctx';
import { featherCount, insertTicket, managementScores } from './feathers';

/** Weekly Feather Tickets go to this many players; season grade steps and silver badges to this many. */
export const LEAGUE_REWARDS = { weekTickets: 3, comebackTop: 10, seasonTop: 10, rankEvent: 10 } as const;

// ---- net worth ---------------------------------------------------------------------------------

/** Each farm's league net worth now (packages/shared/src/league.ts), in milli-coins, with grouped queries. */
export async function farmWorths(q: Queryable, farmIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!farmIds.length) return out;
  const ids = [farmIds];
  const held = new Map<string, LeagueHoldings>();
  for (const r of await q.query(
    'SELECT id, cash_milli, crate_white, crate_cream, crate_brown, crate_golden, feed_cheap_g, feed_standard_g, feed_premium_g FROM farms WHERE id = ANY($1::text[])',
    ids,
  )) {
    held.set(String(r.id), {
      cashMilli: num(r.cash_milli),
      eggs: { white: num(r.crate_white), cream: num(r.crate_cream), brown: num(r.crate_brown), golden: num(r.crate_golden) },
      feedGrams: { cheap: num(r.feed_cheap_g), standard: num(r.feed_standard_g), premium: num(r.feed_premium_g) },
      hens: 0,
      coops: [],
      machines: [],
      landMilli: 0,
      debtMilli: 0,
    });
  }
  const at = (id: unknown): LeagueHoldings | undefined => held.get(String(id));
  for (const r of await q.query(
    `SELECT farm_id, grade, SUM(qty - filled_qty) AS n FROM orders WHERE farm_id = ANY($1::text[]) AND status = 'open' AND kind = 'limit' AND side = 'sell' GROUP BY farm_id, grade`,
    ids,
  )) {
    const h = at(r.farm_id);
    const g = r.grade as EggGrade;
    if (h && EGG_GRADES.includes(g)) h.eggs[g] = (h.eggs[g] ?? 0) + num(r.n);
  }
  for (const r of await q.query(`SELECT farm_id, count(*) AS n FROM hens WHERE status = 'alive' AND farm_id = ANY($1::text[]) GROUP BY farm_id`, ids)) {
    const h = at(r.farm_id);
    if (h) h.hens = num(r.n);
  }
  for (const r of await q.query('SELECT farm_id, kind FROM coops WHERE farm_id = ANY($1::text[])', ids)) (at(r.farm_id)?.coops as CoopKind[] | undefined)?.push(r.kind as CoopKind);
  for (const r of await q.query('SELECT farm_id, unlock_id FROM unlocks WHERE farm_id = ANY($1::text[])', ids)) (at(r.farm_id)?.machines as UnlockId[] | undefined)?.push(r.unlock_id as UnlockId);
  for (const r of await q.query('SELECT farm_id, SUM(price_milli) AS paid FROM farm_land WHERE farm_id = ANY($1::text[]) GROUP BY farm_id', ids)) {
    const h = at(r.farm_id);
    if (h) h.landMilli = num(r.paid);
  }
  for (const r of await q.query(`SELECT farm_id, SUM(due_milli - paid_milli) AS owed FROM debts WHERE status = 'open' AND farm_id = ANY($1::text[]) GROUP BY farm_id`, ids)) {
    const h = at(r.farm_id);
    if (h) h.debtMilli = num(r.owed);
  }
  for (const [id, h] of held) out.set(id, leagueWorth(h).totalMilli);
  return out;
}

export async function farmWorth(q: Queryable, farmId: string): Promise<number> {
  return (await farmWorths(q, [farmId])).get(farmId) ?? 0;
}

// ---- windows -----------------------------------------------------------------------------------

export interface WindowRow {
  id: string;
  kind: LeagueBoard;
  seq: number;
  startsAt: number;
  endsAt: number;
  warmup: boolean;
  status: 'open' | 'closed';
  closedAt: number | null;
  standingsSha256: string | null;
  chainTx: string | null;
  chainStatus: string | null;
}

const opt = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

function toWindow(r: Record<string, unknown>): WindowRow {
  return {
    id: String(r.id),
    kind: r.kind === 'season' ? 'season' : 'week',
    seq: num(r.seq),
    startsAt: num(r.starts_at),
    endsAt: num(r.ends_at),
    warmup: Boolean(r.warmup),
    status: r.status === 'closed' ? 'closed' : 'open',
    closedAt: opt(r.closed_at),
    standingsSha256: (r.standings_sha256 as string | null) ?? null,
    chainTx: (r.chain_tx as string | null) ?? null,
    chainStatus: (r.chain_status as string | null) ?? null,
  };
}

/** Writes entries (window, farm, start worth, start time), once each. */
async function insertEntries(q: Queryable, windowId: string, worths: Map<string, number>, startAt: number): Promise<void> {
  const list = [...worths.entries()];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const values: unknown[] = [];
    const rows = chunk.map(([farmId, worth]) => {
      const b = values.length;
      values.push(windowId, farmId, worth, startAt);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
    });
    await q.query(`INSERT INTO league_entries (window_id, farm_id, start_worth_milli, start_at) VALUES ${rows.join(', ')} ON CONFLICT (window_id, farm_id) DO NOTHING`, values);
  }
}

/** Opens a window unless it exists, with an entry for every open farm at its net worth now. Returns whether it opened. */
export async function openWindow(ctx: Ctx, w: LeagueWindowSpec): Promise<boolean> {
  const made = await ctx.q.query(
    `INSERT INTO league_windows (id, kind, seq, starts_at, ends_at, warmup) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [w.id, w.kind, w.seq, w.startsAt, w.endsAt, w.warmup],
  );
  if (!made.length) return false;
  const farms = (await ctx.q.query<{ id: string }>('SELECT id FROM farms WHERE bust_day IS NULL ORDER BY id')).map((r) => String(r.id));
  await insertEntries(ctx.q, w.id, await farmWorths(ctx.q, farms), ctx.now);
  ctx.log(`[league] ${w.kind} ${w.id} (${w.kind} ${w.seq}${w.warmup ? ', a warm-up' : ''}) opens with ${farms.length} farms; it ends ${new Date(w.endsAt).toISOString()}`);
  return true;
}

/** Opens the week and the season (from LEAGUE_START on) that hold now, if they are not open yet. */
export async function ensureWindows(ctx: Ctx, cfg: LeagueConfig): Promise<void> {
  await openWindow(ctx, leagueWeekAt(ctx.now, cfg));
  const season = leagueSeasonAt(ctx.now, cfg);
  if (season) await openWindow(ctx, season);
}

/** Open windows whose end has come, oldest first. */
export async function dueWindows(q: Queryable, now: number): Promise<WindowRow[]> {
  return (await q.query(`SELECT * FROM league_windows WHERE status = 'open' AND ends_at <= $1 ORDER BY ends_at, kind`, [now])).map(toWindow);
}

/** The soonest end of an open window, or null. */
export async function nextWindowEnd(q: Queryable): Promise<number | null> {
  const [r] = await q.query(`SELECT MIN(ends_at) AS t FROM league_windows WHERE status = 'open'`);
  return opt(r?.t);
}

// ---- entries: made, frozen, grants taken out ---------------------------------------------------

const OPEN_ENTRY = `end_worth_milli IS NULL AND window_id IN (SELECT id FROM league_windows WHERE status = 'open')`;

/** A farm made now enters every open window at its starting worth. */
export async function enterFarm(ctx: Ctx, farmId: string): Promise<void> {
  const open = await ctx.q.query<{ id: string }>(`SELECT id FROM league_windows WHERE status = 'open'`);
  if (!open.length) return;
  const worth = await farmWorth(ctx.q, farmId);
  for (const w of open) await insertEntries(ctx.q, String(w.id), new Map([[farmId, worth]]), ctx.now);
}

/** A farm going bust: its open entries freeze at its net worth now (call before its assets go). */
export async function freezeEntries(ctx: Ctx, farmId: string): Promise<void> {
  const [has] = await ctx.q.query(`SELECT 1 AS x FROM league_entries WHERE farm_id = $1 AND ${OPEN_ENTRY} LIMIT 1`, [farmId]);
  if (!has) return;
  const worth = await farmWorth(ctx.q, farmId);
  await ctx.q.query(`UPDATE league_entries SET end_worth_milli = $2, bust = true WHERE farm_id = $1 AND ${OPEN_ENTRY}`, [farmId, worth]);
}

/** Value that is not farming (a Fresh Start's grant) is taken out of the farm's open entries' profit. */
export async function excludeFromOpen(ctx: Ctx, farmId: string, milli: number): Promise<void> {
  if (milli === 0) return;
  await ctx.q.query(`UPDATE league_entries SET excluded_milli = excluded_milli + $2 WHERE farm_id = $1 AND ${OPEN_ENTRY}`, [farmId, milli]);
}

// ---- standings ---------------------------------------------------------------------------------

export interface Standing {
  farmId: string;
  name: string;
  kind: 'player' | AgentKind;
  guest: boolean;
  playerId: string | null;
  /** The farm is bust now (it takes no reward). */
  farmBust: boolean;
  /** It went bust in this window: its score froze then. */
  bust: boolean;
  busts: number;
  startAt: number;
  /** Net worth at the end (frozen, closed) or now. */
  worthMilli: number;
  scoreMilli: number;
  rank: number;
  prevRank: number | null;
}

const ENTRY_SELECT = `SELECT e.*, f.name, f.owner_kind, f.player_id, f.busts, f.bust_day, p.auth_provider,
  (SELECT a.kind FROM agents a WHERE a.farm_id = f.id ORDER BY a.generation DESC LIMIT 1) AS agent_kind
  FROM league_entries e JOIN farms f ON f.id = e.farm_id LEFT JOIN players p ON p.id = f.player_id`;

function standingOf(r: Record<string, unknown>): Standing {
  const agent = r.owner_kind === 'agent';
  return {
    farmId: String(r.farm_id),
    name: String(r.name),
    kind: agent ? ((r.agent_kind as AgentKind | null) ?? 'upstart') : 'player',
    guest: r.auth_provider === 'guest',
    playerId: agent ? null : ((r.player_id as string | null) ?? null),
    farmBust: r.bust_day !== null && r.bust_day !== undefined,
    bust: Boolean(r.bust),
    busts: num(r.busts),
    startAt: num(r.start_at),
    worthMilli: 0,
    scoreMilli: num(r.score_milli),
    rank: num(r.rank),
    prevRank: opt(r.prev_rank),
  };
}

/**
 * A window's standings now: every entry's score (net worth at its end, or now, less its start, less
 * what is taken out) and its live rank. Player-to-player trades from the entry's start to `now` are
 * taken out at query time, for both farms (when both are player farms).
 */
export async function liveStandings(q: Queryable, windowId: string, now: number): Promise<Standing[]> {
  const rows = await q.query(`${ENTRY_SELECT} WHERE e.window_id = $1`, [windowId]);
  if (!rows.length) return [];
  const open = rows.filter((r) => r.end_worth_milli === null || r.end_worth_milli === undefined).map((r) => String(r.farm_id));
  const worths = await farmWorths(q, open);
  const starts = new Map(rows.map((r) => [String(r.farm_id), num(r.start_at)]));
  const traded = new Map<string, number>();
  const from = Math.min(...starts.values());
  const add = (farmId: unknown, at: number, milli: number) => {
    const start = starts.get(String(farmId));
    if (start === undefined || at < start) return;
    traded.set(String(farmId), (traded.get(String(farmId)) ?? 0) + milli);
  };
  for (const t of await q.query(
    `SELECT t.at, t.seller_farm, t.buyer_farm, t.grade, t.qty, t.total_milli FROM trades t
     JOIN farms sf ON sf.id = t.seller_farm JOIN farms bf ON bf.id = t.buyer_farm
     WHERE t.via = 'player' AND t.at >= $1 AND t.at <= $2 AND sf.owner_kind = 'player' AND bf.owner_kind = 'player'`,
    [from, now],
  )) {
    const grade = t.grade as EggGrade;
    add(t.seller_farm, num(t.at), tradeExclusion('seller', grade, num(t.qty), num(t.total_milli)));
    add(t.buyer_farm, num(t.at), tradeExclusion('buyer', grade, num(t.qty), num(t.total_milli)));
  }
  const list = rows.map((r) => {
    const s = standingOf(r);
    const frozen = r.end_worth_milli === null || r.end_worth_milli === undefined ? null : num(r.end_worth_milli);
    s.worthMilli = frozen ?? worths.get(s.farmId) ?? 0;
    s.scoreMilli = s.worthMilli - num(r.start_worth_milli) - num(r.excluded_milli) - (traded.get(s.farmId) ?? 0);
    return s;
  });
  await rank(q, list);
  return list;
}

/** Ranks standings in place: score, then (for ties) management score, then the earlier start, then the farm id. */
async function rank(q: Queryable, list: Standing[]): Promise<void> {
  list.sort((a, b) => b.scoreMilli - a.scoreMilli);
  const tied = new Set<string>();
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1] as Standing;
    const b = list[i] as Standing;
    if (a.scoreMilli === b.scoreMilli) tied.add(a.farmId).add(b.farmId);
  }
  const mgmt = await managementScores(q, [...tied]);
  list.sort((a, b) => b.scoreMilli - a.scoreMilli || (mgmt.get(b.farmId) ?? 0) - (mgmt.get(a.farmId) ?? 0) || a.startAt - b.startAt || (a.farmId < b.farmId ? -1 : a.farmId > b.farmId ? 1 : 0));
  list.forEach((s, i) => (s.rank = i + 1));
}

/** A closed window's final standings, by rank (each farm's bust count as at the close). */
export async function finalStandings(q: Queryable, windowId: string): Promise<Standing[]> {
  const rows = await q.query(`${ENTRY_SELECT} WHERE e.window_id = $1 AND e.rank IS NOT NULL ORDER BY e.rank`, [windowId]);
  return rows.map((r) => {
    const s = standingOf(r);
    s.worthMilli = num(r.end_worth_milli);
    s.busts = num(r.busts_at_close ?? r.busts);
    return s;
  });
}

// ---- the close ---------------------------------------------------------------------------------

/** The SHA-256 (hex) of a closed season's canonical standings. */
export function standingsSha256(w: { id: string; seq: number; startsAt: number; endsAt: number }, list: readonly { farmId: string; scoreMilli: number; rank: number; busts: number }[]): string {
  return createHash('sha256').update(canonicalStandings(w, list)).digest('hex');
}

/** Records a reward once: true only for the call that recorded it. */
async function grant(ctx: Ctx, windowId: string, farmId: string, reward: string): Promise<boolean> {
  const r = await ctx.q.query(`INSERT INTO league_rewards (window_id, farm_id, reward, granted_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING farm_id`, [
    windowId,
    farmId,
    reward,
    ctx.now,
  ]);
  return r.length > 0;
}

/**
 * Closes a window, once (it is claimed by its status, so a second call, or a second server, does
 * nothing): every entry's final net worth, score, rank and bust count; a season's standings hash; the
 * rewards (none in a warm-up week). Returns the season's number and hash to store on chain, or null.
 * `chainMinted`: the contract's Feather count, for the 777 cap on weekly tickets.
 */
export async function closeWindow(ctx: Ctx, windowId: string, chainMinted: number | null): Promise<{ seq: number; sha256: string } | null> {
  const [row] = await ctx.q.query(`UPDATE league_windows SET status = 'closed', closed_at = $2 WHERE id = $1 AND status = 'open' RETURNING *`, [windowId, ctx.now]);
  if (!row) return null;
  const w = toWindow(row);
  const list = await liveStandings(ctx.q, w.id, ctx.now);
  if (list.length) {
    await ctx.q.query(
      `UPDATE league_entries e SET end_worth_milli = v.worth, score_milli = v.score, rank = v.rank, busts_at_close = v.busts
       FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::int[], $6::int[]) AS v(farm_id, worth, score, rank, busts)
       WHERE e.window_id = $1 AND e.farm_id = v.farm_id`,
      [w.id, list.map((s) => s.farmId), list.map((s) => s.worthMilli), list.map((s) => s.scoreMilli), list.map((s) => s.rank), list.map((s) => s.busts)],
    );
  }
  let stored: { seq: number; sha256: string } | null = null;
  if (w.kind === 'season') {
    const sha256 = standingsSha256(w, list);
    await ctx.q.query('UPDATE league_windows SET standings_sha256 = $2 WHERE id = $1', [w.id, sha256]);
    stored = { seq: w.seq, sha256 };
  }
  const top = list[0];
  ctx.log(`[league] ${w.kind} ${w.id} closed: ${list.length} farms${top ? `, first ${top.name} (${(top.scoreMilli / 1000).toFixed(2)})` : ''}${stored ? `, standings sha256 ${stored.sha256}` : ''}${w.warmup ? ' (a warm-up: no rewards)' : ''}`);
  if (!w.warmup) await (w.kind === 'week' ? rewardWeek(ctx, w, list, chainMinted) : rewardSeason(ctx, w, list));
  ctx.marketChanged = true;
  return stored;
}

/** Player farms still farming, in final rank order: the places rewards go by (AI farms and bust farms skipped). */
const placesOf = (list: Standing[]): Standing[] => list.filter((s) => s.kind === 'player' && !s.farmBust);

async function rewardWeek(ctx: Ctx, w: WindowRow, list: Standing[], chainMinted: number | null): Promise<void> {
  const places = placesOf(list);
  let { issuable } = await featherCount(ctx.q, chainMinted);
  for (const s of places.slice(0, LEAGUE_REWARDS.weekTickets)) {
    if (issuable <= 0) {
      ctx.log(`[league] week ${w.id}: no Feather Ticket left to give (777 out or minted); ${s.name} gets none`);
      break;
    }
    if (!(await grant(ctx, w.id, s.farmId, 'ticket'))) continue;
    const ticketId = await insertTicket(ctx, s.farmId, LEAGUE_TICKET_MILESTONE);
    issuable--;
    ctx.log(`[league] week ${w.id}: ${s.name} (rank ${s.rank}) wins Feather Ticket ${ticketId}`);
  }
  const back: string[] = [];
  for (const s of places.slice(0, LEAGUE_REWARDS.comebackTop)) if (s.busts > 0 && (await grant(ctx, w.id, s.farmId, 'comeback'))) back.push(s.farmId);
  if (back.length) await evaluateBadges(ctx, back, { metrics: ['comebacks'] });
}

async function rewardSeason(ctx: Ctx, w: WindowRow, list: Standing[]): Promise<void> {
  const places = placesOf(list);
  for (const s of places.slice(0, LEAGUE_REWARDS.seasonTop)) {
    if (!(await grant(ctx, w.id, s.farmId, 'grade-boost'))) continue;
    await ctx.q.query('UPDATE farms SET grade_boost = 1 WHERE id = $1', [s.farmId]);
    ctx.touched.add(s.farmId);
  }
  // the season's badge: every player farm that sold eggs in it; gold for first, silver for the top ten
  const players = list.filter((s) => s.kind === 'player');
  if (!players.length) return;
  const sold = new Set(
    (
      await ctx.q.query<{ farm_id: string }>(`SELECT DISTINCT farm_id FROM ledger WHERE kind = 'sale' AND created_at >= $1 AND created_at <= $2 AND farm_id = ANY($3::text[])`, [
        w.startsAt,
        ctx.now,
        players.map((s) => s.farmId),
      ])
    ).map((r) => String(r.farm_id)),
  );
  const place = new Map(places.map((s, i) => [s.farmId, i + 1]));
  const badge = seasonBadgeId(w.seq);
  for (const s of players) {
    if (!sold.has(s.farmId) || !(await grant(ctx, w.id, s.farmId, 'badge'))) continue;
    const p = place.get(s.farmId) ?? null;
    const level: BadgeLevel = p === 1 ? 'gold' : p !== null && p <= LEAGUE_REWARDS.seasonTop ? 'silver' : 'bronze';
    await ctx.q.query(
      `INSERT INTO badges (farm_id, badge, tier, earned_day, progress) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (farm_id, badge) DO UPDATE SET tier = EXCLUDED.tier, earned_day = EXCLUDED.earned_day, progress = EXCLUDED.progress`,
      [s.farmId, badge, level, ctx.day, level === 'gold' ? 3 : level === 'silver' ? 2 : 1],
    );
    if (s.playerId) ctx.out.push({ playerId: s.playerId, msg: { t: 'event', event: { kind: 'badgeEarned', badge, level, day: ctx.day } } });
  }
}

// ---- the day close -----------------------------------------------------------------------------

/**
 * At each day close: every open entry keeps its rank now as prev_rank (the arrows against
 * yesterday), and a player farm that climbs into the week's top ten (from below it, or new) hears so.
 */
export async function leagueDayClose(ctx: Ctx): Promise<void> {
  for (const w of (await ctx.q.query(`SELECT * FROM league_windows WHERE status = 'open' ORDER BY kind`)).map(toWindow)) {
    const list = await liveStandings(ctx.q, w.id, ctx.now);
    if (!list.length) continue;
    if (w.kind === 'week') {
      for (const s of list) {
        if (!s.playerId || s.bust || s.rank > LEAGUE_REWARDS.rankEvent) continue;
        if (s.prevRank === null || s.prevRank > LEAGUE_REWARDS.rankEvent) ctx.out.push({ playerId: s.playerId, msg: { t: 'event', event: { kind: 'leagueRank', board: 'week', rank: s.rank } } });
      }
    }
    await ctx.q.query(
      `UPDATE league_entries e SET prev_rank = v.rank FROM unnest($2::text[], $3::int[]) AS v(farm_id, rank) WHERE e.window_id = $1 AND e.farm_id = v.farm_id`,
      [w.id, list.map((s) => s.farmId), list.map((s) => s.rank)],
    );
  }
}

// ---- views -------------------------------------------------------------------------------------

/**
 * GET /api/leaderboard: a board's window (the one asked for by id, else the open one, else the last
 * closed), its entries (live ranks while open), when the week and season end, and the closed windows
 * before it. Null for an id that is no window of the board. Public fields only.
 */
export async function leaderboardView(q: Queryable, board: LeagueBoard, id: string | null, cfg: LeagueConfig, now: number, explorer: string | null): Promise<LeaderboardView | null> {
  let row: Record<string, unknown> | undefined;
  if (id !== null) {
    [row] = await q.query('SELECT * FROM league_windows WHERE id = $1 AND kind = $2', [id, board]);
    if (!row) return null;
  } else {
    [row] = await q.query(`SELECT * FROM league_windows WHERE kind = $1 ORDER BY (status = 'open') DESC, starts_at DESC LIMIT 1`, [board]);
  }
  const w = row ? toWindow(row) : null;
  const list = w ? (w.status === 'open' ? await liveStandings(q, w.id, now) : await finalStandings(q, w.id)) : [];
  const entries = list.map(
    (s): LeaderboardEntry => ({ rank: s.rank, farmId: s.farmId, name: s.name, kind: s.kind, guest: s.guest, bust: s.bust, busts: s.busts, scoreMilli: s.scoreMilli, prevRank: s.prevRank }),
  );
  const week = leagueWeekAt(now, cfg);
  const season = leagueSeasonAt(now, cfg) ?? leagueSeason(1, cfg);
  const pastRows = await q.query(
    `SELECT w.id, w.seq, w.ends_at, w.standings_sha256, w.chain_tx, f.name AS winner, f.owner_kind,
       (SELECT a.kind FROM agents a WHERE a.farm_id = f.id ORDER BY a.generation DESC LIMIT 1) AS agent_kind
     FROM league_windows w LEFT JOIN league_entries e ON e.window_id = w.id AND e.rank = 1 LEFT JOIN farms f ON f.id = e.farm_id
     WHERE w.kind = $1 AND w.status = 'closed' ORDER BY w.ends_at DESC LIMIT 10`,
    [board],
  );
  const past = pastRows.map(
    (r): LeaderboardPast => ({
      id: String(r.id),
      seq: num(r.seq),
      endsAt: num(r.ends_at),
      winner: r.winner === null || r.winner === undefined ? null : { name: String(r.winner), kind: r.owner_kind === 'agent' ? ((r.agent_kind as AgentKind | null) ?? 'upstart') : 'player' },
      standingsSha256: (r.standings_sha256 as string | null) ?? null,
      chainTx: (r.chain_tx as string | null) ?? null,
      explorerUrl: r.chain_tx && explorer ? `${explorer}${String(r.chain_tx)}` : null,
    }),
  );
  return {
    board,
    window: w ? { id: w.id, seq: w.seq, startsAt: w.startsAt, endsAt: w.endsAt, warmup: w.warmup, status: w.status, standingsSha256: w.standingsSha256, chainTx: w.chainTx } : null,
    entries,
    next: { weekEndsAt: week.endsAt, seasonStartsAt: season.startsAt, seasonEndsAt: season.endsAt },
    past,
  };
}

/** A farm's best final rank in a closed week and season (warm-up weeks left out), for its profile. */
export async function bestRanks(q: Queryable, farmId: string): Promise<{ bestWeek: number | null; bestSeason: number | null }> {
  const rows = await q.query(
    `SELECT w.kind, MIN(e.rank) AS best FROM league_entries e JOIN league_windows w ON w.id = e.window_id
     WHERE e.farm_id = $1 AND w.status = 'closed' AND NOT w.warmup AND e.rank IS NOT NULL GROUP BY w.kind`,
    [farmId],
  );
  const best = (kind: LeagueBoard): number | null => opt(rows.find((r) => r.kind === kind)?.best);
  return { bestWeek: best('week'), bestSeason: best('season') };
}
