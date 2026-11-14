// The league: a weekly and a seasonal leaderboard of every farm on Yolk Street, players and AI, by
// profit over the window. Profit is net worth at book values (below) at the end of the window less
// net worth at its start, less anything that is not farming: player-to-player trades are taken out
// both ways (so two farms cannot pump one of them up by trading eggs at silly prices) and so are
// Fresh Start grants. Windows: a week runs from Monday 00:00 UTC to the next Monday; a season is
// LEAGUE_SEASON_DAYS long from LEAGUE_START. Weeks before LEAGUE_START are warm-up weeks, scored
// and shown but with no rewards. docs/league.md has the whole of it. Pure: no clock, no database.
import { ECONOMY, EGG_GRADES, FEED_TIERS, toMilli, type CoopKind, type EggGrade, type FeedTier, type MilestoneId, type UnlockId } from './economy';
import type { AgentKind } from './market';

/** An egg at book is its base price times this share (well under what the street pays, so eggs never inflate a score). */
const EGG_BOOK_SHARE = 0.4;

/**
 * Book values, in milli-coins: what each thing a farm holds counts for in its league net worth.
 * Eggs (in the crate and left in open sell orders) at 0.4 of their base price; feed per gram at its
 * bag's list price (a bag is ECONOMY.feed.bagKg); hens at the auction price; coops and machines at
 * their price; land at what the farm paid for it (not here: it is in the farm's records); open debt
 * (due less paid) taken off. Cash counts as itself.
 */
export const LEAGUE_BOOK = {
  eggShare: EGG_BOOK_SHARE,
  eggMilli: Object.fromEntries(EGG_GRADES.map((g) => [g, toMilli(ECONOMY.eggs.basePrice[g] * EGG_BOOK_SHARE)])) as Record<EggGrade, number>,
  /** A full bag's book value per tier; one gram is this over bagGrams. */
  bagMilli: Object.fromEntries(FEED_TIERS.map((t) => [t, toMilli(ECONOMY.feed.tiers[t].bagPrice)])) as Record<FeedTier, number>,
  bagGrams: ECONOMY.feed.bagKg * 1000,
  henMilli: toMilli(ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor),
  coopMilli: Object.fromEntries(Object.entries(ECONOMY.coops.kinds).map(([k, v]) => [k, toMilli(v.price)])) as Record<CoopKind, number>,
  machineMilli: Object.fromEntries(Object.entries(ECONOMY.unlocks).map(([k, v]) => [k, toMilli(v.price)])) as Record<UnlockId, number>,
} as const;

/** What a farm holds, for its league net worth. */
export interface LeagueHoldings {
  cashMilli: number;
  /** In the crate plus what is left in its open sell orders, by grade. */
  eggs: Partial<Record<EggGrade, number>>;
  feedGrams: Record<FeedTier, number>;
  /** Hens alive on the farm. */
  hens: number;
  coops: readonly CoopKind[];
  /** Machines owned (whatever their condition). */
  machines: readonly UnlockId[];
  /** What the farm paid for its land. */
  landMilli: number;
  /** Open debt: due less paid, on debts still open. */
  debtMilli: number;
}

export interface LeagueWorth {
  cashMilli: number;
  eggsMilli: number;
  feedMilli: number;
  hensMilli: number;
  coopsMilli: number;
  machinesMilli: number;
  landMilli: number;
  debtMilli: number;
  totalMilli: number;
}

/** A farm's league net worth at book values, in whole milli-coins, with its parts. */
export function leagueWorth(h: LeagueHoldings): LeagueWorth {
  const B = LEAGUE_BOOK;
  const eggsMilli = EGG_GRADES.reduce((s, g) => s + (h.eggs[g] ?? 0) * B.eggMilli[g], 0);
  const feedMilli = FEED_TIERS.reduce((s, t) => s + Math.round(((h.feedGrams[t] ?? 0) * B.bagMilli[t]) / B.bagGrams), 0);
  const hensMilli = h.hens * B.henMilli;
  const coopsMilli = h.coops.reduce((s, k) => s + B.coopMilli[k], 0);
  const machinesMilli = h.machines.reduce((s, m) => s + B.machineMilli[m], 0);
  const totalMilli = h.cashMilli + eggsMilli + feedMilli + hensMilli + coopsMilli + machinesMilli + h.landMilli - h.debtMilli;
  return { cashMilli: h.cashMilli, eggsMilli, feedMilli, hensMilli, coopsMilli, machinesMilli, landMilli: h.landMilli, debtMilli: h.debtMilli, totalMilli };
}

/**
 * What one player-to-player trade does to a score, taken out again: the seller's gain over book
 * (total less the eggs at book) and the buyer's (the eggs at book less what it paid). Signed, so a
 * trade at a silly price nets to nothing for either side.
 */
export function tradeExclusion(side: 'seller' | 'buyer', grade: EggGrade, qty: number, totalMilli: number): number {
  const book = qty * LEAGUE_BOOK.eggMilli[grade];
  return side === 'seller' ? totalMilli - book : book - totalMilli;
}

// ---- windows -----------------------------------------------------------------------------------

export type LeagueBoard = 'week' | 'season';
export const LEAGUE_BOARDS = ['week', 'season'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const LEAGUE_WEEK_MS = 7 * DAY_MS;

/** LEAGUE_START (ms since the epoch) and LEAGUE_SEASON_DAYS. */
export interface LeagueConfig {
  start: number;
  seasonDays: number;
}

export const LEAGUE_DEFAULTS: LeagueConfig = { start: Date.UTC(2026, 10, 16), seasonDays: 14 };

/** A week's or a season's window: its id, number, start and end (ms), and whether it is a warm-up week. */
export interface LeagueWindowSpec {
  id: string;
  kind: LeagueBoard;
  seq: number;
  startsAt: number;
  endsAt: number;
  warmup: boolean;
}

/** Monday 00:00 UTC on or before t. */
export function mondayOf(t: number): number {
  const day = Math.floor(t / DAY_MS) * DAY_MS;
  // 1 January 1970 was a Thursday: getUTCDay 0 is Sunday
  const dow = new Date(day).getUTCDay();
  return day - ((dow + 6) % 7) * DAY_MS;
}

/** The first league week: the one starting on the first Monday 00:00 UTC at or after LEAGUE_START. */
function firstWeek(cfg: LeagueConfig): number {
  const m = mondayOf(cfg.start);
  return m === cfg.start ? m : m + LEAGUE_WEEK_MS;
}

export const leagueWeekId = (startsAt: number): string => `w-${new Date(startsAt).toISOString().slice(0, 10)}`;
export const leagueSeasonId = (seq: number): string => `s-${seq}`;

/**
 * The week holding t. Its number counts from the first league week (1); warm-up weeks (starting
 * before LEAGUE_START) count 0, -1 and so on back.
 */
export function leagueWeekAt(t: number, cfg: LeagueConfig): LeagueWindowSpec {
  const startsAt = mondayOf(t);
  const seq = Math.round((startsAt - firstWeek(cfg)) / LEAGUE_WEEK_MS) + 1;
  return { id: leagueWeekId(startsAt), kind: 'week', seq, startsAt, endsAt: startsAt + LEAGUE_WEEK_MS, warmup: startsAt < cfg.start };
}

/** Season n (1, 2, ...): from LEAGUE_START + (n - 1) x seasonDays to LEAGUE_START + n x seasonDays. */
export function leagueSeason(seq: number, cfg: LeagueConfig): LeagueWindowSpec {
  const len = cfg.seasonDays * DAY_MS;
  const startsAt = cfg.start + (seq - 1) * len;
  return { id: leagueSeasonId(seq), kind: 'season', seq, startsAt, endsAt: startsAt + len, warmup: false };
}

/** The season holding t, or null before LEAGUE_START. */
export function leagueSeasonAt(t: number, cfg: LeagueConfig): LeagueWindowSpec | null {
  if (t < cfg.start) return null;
  return leagueSeason(Math.floor((t - cfg.start) / (cfg.seasonDays * DAY_MS)) + 1, cfg);
}

// ---- standings ---------------------------------------------------------------------------------

/** The ticket milestone a weekly top three win carries (a Feather Ticket not won at a milestone roll). */
export const LEAGUE_TICKET_MILESTONE = 'league-week';
/** What a Feather Ticket was won at: a milestone, or a week's top three. */
export type TicketMilestone = MilestoneId | typeof LEAGUE_TICKET_MILESTONE;

/** One farm in a closed season's canonical standings. */
export interface StandingsEntry {
  farmId: string;
  scoreMilli: number;
  rank: number;
  busts: number;
}

/**
 * The canonical standings of a closed season, exactly as hashed: JSON of { board, id, seq, startsAt,
 * endsAt, entries } with the entries by rank, each [farmId, scoreMilli, rank, busts]. Its SHA-256
 * (hex) is the season's standings_sha256, stored on chain (scripts/league-hash.ts recomputes it).
 */
export function canonicalStandings(w: { id: string; seq: number; startsAt: number; endsAt: number }, entries: readonly StandingsEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.rank - b.rank || (a.farmId < b.farmId ? -1 : a.farmId > b.farmId ? 1 : 0));
  return JSON.stringify({ board: 'season', id: w.id, seq: w.seq, startsAt: w.startsAt, endsAt: w.endsAt, entries: sorted.map((e) => [e.farmId, e.scoreMilli, e.rank, e.busts]) });
}

// ---- the API -----------------------------------------------------------------------------------

/** A window as GET /api/leaderboard shows it. */
export interface LeaderboardWindow {
  id: string;
  seq: number;
  startsAt: number;
  endsAt: number;
  warmup: boolean;
  status: 'open' | 'closed';
  /** A closed season's canonical standings hash; null otherwise. */
  standingsSha256: string | null;
  /** The transaction that stored that hash on NEAR testnet, once sent. */
  chainTx: string | null;
}

/** One farm on a board: live ranks while the window is open, the final ones once it closed. */
export interface LeaderboardEntry {
  rank: number;
  farmId: string;
  name: string;
  kind: 'player' | AgentKind;
  /** A player farm with no sign-in yet. */
  guest: boolean;
  /** Went bust in this window: its score froze then. */
  bust: boolean;
  /** Times the farm has gone bust (Fresh Starts included); a closed window shows the count at its close. */
  busts: number;
  scoreMilli: number;
  /** The rank at the last day close (for the up and down arrows), or null. */
  prevRank: number | null;
}

/** A closed window of the same board, newest first. */
export interface LeaderboardPast {
  id: string;
  seq: number;
  endsAt: number;
  winner: { name: string; kind: 'player' | AgentKind } | null;
  standingsSha256: string | null;
  chainTx: string | null;
  /** The chain transaction on the testnet explorer, or null. */
  explorerUrl: string | null;
}

/** GET /api/leaderboard?board=week|season&id=<window id>. Public: no player ids, no wallets, no coins. */
export interface LeaderboardView {
  board: LeagueBoard;
  /** The window asked for (or the open one); null before the first season starts, on the season board. */
  window: LeaderboardWindow | null;
  entries: LeaderboardEntry[];
  /** When this week ends, and when the season in play (or the first, before LEAGUE_START) starts and ends. */
  next: { weekEndsAt: number; seasonStartsAt: number; seasonEndsAt: number };
  past: LeaderboardPast[];
}
