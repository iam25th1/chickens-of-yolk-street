// Badges, server side: the numbers each badge counts (its metric), read for a set of farms with one
// grouped query per family of numbers, and the evaluation that compares them with the catalog's
// thresholds (packages/shared/src/badges.ts). A badge (or a higher level of one) is earned once: its
// row records the level and the day, and the player hears a badgeEarned event. Cosmetic only: nothing
// here moves coins, eggs or prices. Only player farms earn badges.
import {
  BADGES,
  BADGE_BY_ID,
  BADGE_RULES,
  ECONOMY,
  coopCapacity,
  levelAbove,
  levelFor,
  type BadgeCategory,
  type BadgeLevel,
  type BadgeMetric,
  type BadgeView,
  type CoopKind,
  type UnlockId,
} from '@coys/shared';
import { num, type Queryable } from '../db/db';
import type { Ctx } from './ctx';
import { daysNoBreakdown, rivalsOutlasted, traitsOf, worthOf } from './profile';

export type Facts = Partial<Record<BadgeMetric, number>>;

type Family = 'stats' | 'farm' | 'days' | 'climb' | 'profit' | 'machineDays' | 'trades' | 'sales' | 'memory' | 'contracts' | 'flock' | 'machines' | 'rivals' | 'feathers' | 'worth' | 'land';

/** Which query family reads each number. */
const FAMILY: Record<BadgeMetric, Family> = {
  eggsCollected: 'stats',
  eggsPicked: 'stats',
  goldenCollected: 'stats',
  eggsBroken: 'stats',
  ordersFilled: 'stats',
  hagglesLost: 'stats',
  deliveries: 'stats',
  bestDeliveryStreak: 'stats',
  auctionHens: 'stats',
  repairs: 'stats',
  bestRepairStreak: 'stats',
  breakdowns: 'stats',
  nightActions: 'stats',
  bestCrowStreak: 'stats',
  crateNow: 'farm',
  eggsSold: 'farm',
  cashNow: 'farm',
  hagglesWon: 'farm',
  goodDays: 'farm',
  daysPlayed: 'farm',
  renamed: 'farm',
  bestDayLaid: 'days',
  bestShare: 'days',
  top3Days: 'days',
  firstDays: 'days',
  topHalfDays: 'days',
  daysClosed: 'days',
  fedDays: 'days',
  premiumDays: 'days',
  shoestringDays: 'days',
  bestClimb: 'climb',
  bestDayProfit: 'profit',
  profitDays: 'profit',
  conveyorSaved: 'machineDays',
  machineUnits: 'machineDays',
  glutSales: 'trades',
  peakSales: 'trades',
  goldenPeakSales: 'trades',
  bigTrades: 'trades',
  biggestSale: 'sales',
  haggleKinds: 'memory',
  refusals: 'memory',
  cleanContracts: 'contracts',
  contractsTaken: 'contracts',
  fullCoops: 'flock',
  hens: 'flock',
  traitsSeen: 'flock',
  oldestHen: 'flock',
  tophats: 'flock',
  coops: 'flock',
  deluxeCoops: 'flock',
  ownsConveyor: 'machines',
  ownsGrader: 'machines',
  ownsCart: 'machines',
  ownsHopper: 'machines',
  ownsClerk: 'machines',
  machinesOwned: 'machines',
  daysNoBreakdown: 'machines',
  rivalsOutlasted: 'rivals',
  ticketsWon: 'feathers',
  mintedFluff: 'feathers',
  mintedPlume: 'feathers',
  mintedQuill: 'feathers',
  mintedGoldenQuill: 'feathers',
  mintedGrades: 'feathers',
  milestonesReached: 'feathers',
  netWorth: 'worth',
  landPlots: 'land',
  landCoops: 'land',
};

const OWNS: Record<UnlockId, BadgeMetric> = { conveyor: 'ownsConveyor', grader: 'ownsGrader', cart: 'ownsCart', hopper: 'ownsHopper', clerk: 'ownsClerk' };
const MINTED: Record<string, BadgeMetric> = { fluff: 'mintedFluff', plume: 'mintedPlume', quill: 'mintedQuill', 'golden-quill': 'mintedGoldenQuill' };
const json = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

/**
 * Reads the numbers the given metrics need for a set of farms, on `day` (the current day). `closed` is
 * the last closed day (the day itself at its close, else the day before): days on the street and days
 * without a breakdown count closed days.
 */
export async function loadFacts(q: Queryable, farmIds: string[], day: number, metrics: Iterable<BadgeMetric>, closed: number = day - 1): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>(farmIds.map((id) => [id, {}]));
  if (!farmIds.length) return out;
  const set = (id: unknown, m: BadgeMetric, v: unknown) => {
    const f = out.get(String(id));
    if (f) f[m] = Math.floor(num(v ?? 0));
  };
  const families = new Set([...metrics].map((m) => FAMILY[m]));
  const ids = [farmIds];
  if (families.has('stats') || families.has('machines') || families.has('flock')) {
    for (const r of await q.query('SELECT * FROM farm_stats WHERE farm_id = ANY($1::text[])', ids)) {
      const id = r.farm_id;
      set(id, 'eggsCollected', r.eggs_collected);
      set(id, 'eggsPicked', r.eggs_picked);
      set(id, 'goldenCollected', r.golden_collected);
      set(id, 'eggsBroken', r.eggs_broken);
      set(id, 'ordersFilled', r.orders_filled);
      set(id, 'hagglesLost', r.haggles_lost);
      set(id, 'deliveries', r.deliveries);
      set(id, 'bestDeliveryStreak', r.best_delivery_streak);
      set(id, 'auctionHens', r.auction_hens);
      set(id, 'repairs', r.repairs);
      set(id, 'bestRepairStreak', r.best_repair_streak);
      set(id, 'breakdowns', r.breakdowns);
      set(id, 'nightActions', r.night_actions);
      set(id, 'bestCrowStreak', r.best_crow_streak);
      const f = out.get(String(id)) as Facts & { lastBreakdown?: number | null; traits?: string[] };
      f.lastBreakdown = r.last_breakdown_day === null || r.last_breakdown_day === undefined ? null : num(r.last_breakdown_day);
      f.traits = json<string[]>(r.traits_seen, []);
    }
  }
  if (families.has('farm')) {
    for (const r of await q.query('SELECT id, cash_milli, crate_white, crate_cream, crate_brown, crate_golden, eggs_sold, haggles_won, good_days, created_day, renamed_day FROM farms WHERE id = ANY($1::text[])', ids)) {
      set(r.id, 'crateNow', num(r.crate_white) + num(r.crate_cream) + num(r.crate_brown) + num(r.crate_golden));
      set(r.id, 'eggsSold', r.eggs_sold);
      set(r.id, 'cashNow', num(r.cash_milli) / 1000);
      set(r.id, 'hagglesWon', r.haggles_won);
      set(r.id, 'goodDays', r.good_days);
      set(r.id, 'daysPlayed', Math.max(0, closed - num(r.created_day) + 1));
      set(r.id, 'renamed', r.renamed_day === null || r.renamed_day === undefined ? 0 : 1);
    }
  }
  if (families.has('days')) {
    const rows = await q.query(
      `SELECT farm_id, MAX(laid_n) AS laid, MAX(share) AS share, count(*) AS closed,
         count(*) FILTER (WHERE rank <= $2) AS top3, count(*) FILTER (WHERE rank = 1) AS first, count(*) FILTER (WHERE rank IS NOT NULL AND rank * 2 <= open_farms) AS half,
         count(*) FILTER (WHERE fed > 0) AS fed, count(*) FILTER (WHERE fed >= $3) AS premium,
         count(*) FILTER (WHERE cash_milli < $4 AND rank IS NOT NULL) AS shoestring
       FROM farm_days WHERE farm_id = ANY($1::text[]) GROUP BY farm_id`,
      [farmIds, ECONOMY.feathers.topRank, ECONOMY.feed.tiers.premium.laying - 1e-6, BADGE_RULES.shoestringCoins * 1000],
    );
    for (const r of rows) {
      set(r.farm_id, 'bestDayLaid', r.laid);
      set(r.farm_id, 'bestShare', Math.round(num(r.share) * 100));
      set(r.farm_id, 'daysClosed', r.closed);
      set(r.farm_id, 'top3Days', r.top3);
      set(r.farm_id, 'firstDays', r.first);
      set(r.farm_id, 'topHalfDays', r.half);
      set(r.farm_id, 'fedDays', r.fed);
      set(r.farm_id, 'premiumDays', r.premium);
      set(r.farm_id, 'shoestringDays', r.shoestring);
    }
  }
  if (families.has('climb')) {
    const rows = await q.query(
      `SELECT farm_id, MAX(prev - rank) AS climb FROM (SELECT farm_id, rank, LAG(rank) OVER (PARTITION BY farm_id ORDER BY day) AS prev FROM farm_days WHERE farm_id = ANY($1::text[])) x
       WHERE prev IS NOT NULL AND rank IS NOT NULL GROUP BY farm_id`,
      ids,
    );
    for (const r of rows) set(r.farm_id, 'bestClimb', Math.max(0, num(r.climb)));
  }
  if (families.has('profit')) {
    const rows = await q.query(
      `SELECT farm_id, MAX(p) AS best, count(*) FILTER (WHERE p > 0) AS good FROM
         (SELECT farm_id, day, SUM(amount_milli) AS p FROM ledger WHERE farm_id = ANY($1::text[]) AND kind <> 'start' AND day < $2 GROUP BY farm_id, day) x GROUP BY farm_id`,
      [farmIds, day],
    );
    for (const r of rows) {
      set(r.farm_id, 'bestDayProfit', Math.max(0, num(r.best) / 1000));
      set(r.farm_id, 'profitDays', r.good);
    }
  }
  if (families.has('machineDays')) {
    for (const r of await q.query(`SELECT farm_id, SUM(units) AS units, SUM(CASE WHEN machine = 'conveyor' THEN saved ELSE 0 END) AS saved FROM machine_days WHERE farm_id = ANY($1::text[]) GROUP BY farm_id`, ids)) {
      set(r.farm_id, 'machineUnits', r.units);
      set(r.farm_id, 'conveyorSaved', r.saved);
    }
  }
  if (families.has('trades')) {
    const rows = await q.query(
      `SELECT t.seller_farm AS id,
         count(*) FILTER (WHERE t.via = 'street' AND m.multiplier <= $2) AS glut,
         count(*) FILTER (WHERE t.via = 'street' AND m.multiplier >= $3) AS peak,
         count(*) FILTER (WHERE t.via = 'street' AND t.grade = 'golden' AND m.multiplier >= $3) AS gpeak,
         count(*) FILTER (WHERE t.total_milli >= $4) AS big
       FROM trades t LEFT JOIN market_days m ON m.day = t.day WHERE t.seller_farm = ANY($1::text[]) GROUP BY t.seller_farm`,
      [farmIds, BADGE_RULES.glutAt + 1e-9, BADGE_RULES.peakAt - 1e-9, BADGE_RULES.bigTradeCoins * 1000],
    );
    for (const r of rows) {
      set(r.id, 'glutSales', r.glut);
      set(r.id, 'peakSales', r.peak);
      set(r.id, 'goldenPeakSales', r.gpeak);
      set(r.id, 'bigTrades', r.big);
    }
  }
  if (families.has('sales')) {
    const rows = await q.query(
      `SELECT farm_id, MAX(n) AS n FROM (SELECT farm_id, deal_id, SUM(qty) AS n FROM orders WHERE farm_id = ANY($1::text[]) AND kind = 'market' AND side = 'sell' GROUP BY farm_id, deal_id) x GROUP BY farm_id`,
      ids,
    );
    for (const r of rows) set(r.farm_id, 'biggestSale', r.n);
  }
  if (families.has('memory')) {
    const rows = await q.query(
      `SELECT m.farm_id, count(DISTINCT a.kind) FILTER (WHERE m.haggles_won > 0 AND a.kind = ANY($2::text[])) AS kinds, COALESCE(SUM(m.refusals), 0) AS refusals
       FROM agent_memory m JOIN agents a ON a.id = m.agent_id WHERE m.farm_id = ANY($1::text[]) GROUP BY m.farm_id`,
      [farmIds, [...BADGE_RULES.haggleKinds]],
    );
    for (const r of rows) {
      set(r.farm_id, 'haggleKinds', r.kinds);
      set(r.farm_id, 'refusals', r.refusals);
    }
  }
  if (families.has('contracts')) {
    for (const r of await q.query(`SELECT farm_id, count(*) AS taken, count(*) FILTER (WHERE status = 'done' AND misses = 0) AS clean FROM contracts WHERE farm_id = ANY($1::text[]) GROUP BY farm_id`, ids)) {
      set(r.farm_id, 'contractsTaken', r.taken);
      set(r.farm_id, 'cleanContracts', r.clean);
    }
  }
  if (families.has('flock') || families.has('worth')) {
    const hens = await q.query(`SELECT farm_id, body, eyes, comb, accessory, born_day FROM hens WHERE status = 'alive' AND farm_id = ANY($1::text[])`, ids);
    const coops = await q.query('SELECT farm_id, kind FROM coops WHERE farm_id = ANY($1::text[])', ids);
    for (const id of farmIds) {
      const mine = hens.filter((h) => h.farm_id === id);
      const kinds = coops.filter((c) => c.farm_id === id).map((c) => c.kind as CoopKind);
      const cap = coopCapacity(kinds);
      const f = out.get(id) as Facts & { traits?: string[]; coopKinds?: CoopKind[] };
      f.coopKinds = kinds;
      set(id, 'hens', mine.length);
      set(id, 'fullCoops', cap > 0 && mine.length >= cap ? 1 : 0);
      set(id, 'oldestHen', mine.reduce((m, h) => Math.max(m, day - num(h.born_day)), 0));
      set(id, 'tophats', mine.filter((h) => h.accessory === 'tophat').length);
      set(id, 'coops', kinds.length);
      set(id, 'deluxeCoops', kinds.filter((k) => k === 'deluxe').length);
      const seen = new Set([...(f.traits ?? []), ...traitsOf(mine as { body: unknown; eyes: unknown; comb: unknown; accessory: unknown }[])]);
      set(id, 'traitsSeen', BADGE_RULES.traits.filter((t) => seen.has(t)).length);
    }
  }
  if (families.has('machines') || families.has('worth')) {
    const rows = await q.query('SELECT farm_id, unlock_id, bought_day, condition FROM unlocks WHERE farm_id = ANY($1::text[])', ids);
    for (const id of farmIds) {
      const mine = rows.filter((r) => r.farm_id === id);
      const f = out.get(id) as Facts & { lastBreakdown?: number | null; machines?: { unlock: UnlockId; condition: number }[] };
      f.machines = mine.map((r) => ({ unlock: r.unlock_id as UnlockId, condition: num(r.condition) }));
      for (const [u, m] of Object.entries(OWNS) as [UnlockId, BadgeMetric][]) set(id, m, mine.some((r) => r.unlock_id === u) ? 1 : 0);
      set(id, 'machinesOwned', mine.length);
      const first = mine.length ? Math.min(...mine.map((r) => num(r.bought_day))) : null;
      set(id, 'daysNoBreakdown', daysNoBreakdown(closed, first, f.lastBreakdown ?? null));
    }
  }
  if (families.has('worth')) {
    const land = new Map((await q.query('SELECT farm_id, SUM(price_milli) AS paid FROM farm_land WHERE farm_id = ANY($1::text[]) GROUP BY farm_id', ids)).map((r) => [String(r.farm_id), num(r.paid)]));
    for (const r of await q.query('SELECT id, cash_milli FROM farms WHERE id = ANY($1::text[])', ids)) {
      const f = out.get(String(r.id)) as Facts & { coopKinds?: CoopKind[]; machines?: { unlock: UnlockId; condition: number }[] };
      set(r.id, 'netWorth', worthOf(num(r.cash_milli), f.hens ?? 0, f.coopKinds ?? [], f.machines ?? [], land.get(String(r.id)) ?? 0).totalMilli / 1000);
    }
  }
  if (families.has('land')) {
    // plots of land owned, and coops standing on them (coop plots past the home plot's)
    for (const r of await q.query('SELECT farm_id, count(*) AS n FROM farm_land WHERE farm_id = ANY($1::text[]) GROUP BY farm_id', ids)) set(r.farm_id, 'landPlots', r.n);
    for (const r of await q.query('SELECT farm_id, count(*) AS n FROM coops WHERE farm_id = ANY($1::text[]) AND plot >= $2 GROUP BY farm_id', [farmIds, ECONOMY.coops.plots])) set(r.farm_id, 'landCoops', r.n);
  }
  if (families.has('rivals')) {
    const n = await rivalsOutlasted(q, farmIds);
    for (const id of farmIds) set(id, 'rivalsOutlasted', n.get(id) ?? 0);
  }
  if (families.has('feathers')) {
    const rows = await q.query(`SELECT farm_id, status, grade, count(*) AS n FROM feather_tickets WHERE farm_id = ANY($1::text[]) GROUP BY farm_id, status, grade`, ids);
    for (const id of farmIds) {
      const mine = rows.filter((r) => r.farm_id === id);
      set(id, 'ticketsWon', mine.reduce((s, r) => s + num(r.n), 0));
      const minted = mine.filter((r) => r.status === 'minted' && r.grade);
      for (const [g, m] of Object.entries(MINTED)) set(id, m, minted.filter((r) => r.grade === g).reduce((s, r) => s + num(r.n), 0));
      set(id, 'mintedGrades', new Set(minted.map((r) => String(r.grade))).size);
    }
    for (const r of await q.query('SELECT farm_id, count(*) AS n FROM milestone_rolls WHERE farm_id = ANY($1::text[]) GROUP BY farm_id', ids)) set(r.farm_id, 'milestonesReached', r.n);
  }
  return out;
}

/** The numbers a sale can move. */
const SALE: BadgeMetric[] = ['eggsSold', 'bigTrades', 'cashNow'];
const FLOCK: BadgeMetric[] = ['hens', 'fullCoops', 'tophats', 'traitsSeen', 'oldestHen'];

/**
 * The numbers each player action can move, so an action reads only those (a few grouped queries).
 * Everything else (days, ranks, profit, standing, milestones) moves at the day close, which reads them all.
 */
export const ACTION_BADGES: Partial<Record<string, BadgeMetric[]>> = {
  collect: ['eggsCollected', 'eggsPicked', 'goldenCollected', 'crateNow'],
  sell: [...SALE, 'glutSales', 'peakSales', 'goldenPeakSales', 'biggestSale'],
  placeOrder: SALE,
  fillOrder: [...SALE, 'ordersFilled', 'crateNow'],
  respondCard: [...SALE, 'hagglesWon', 'haggleKinds', 'hagglesLost', 'refusals', 'contractsTaken', 'glutSales', 'peakSales', 'goldenPeakSales', 'biggestSale', ...FLOCK],
  deliverContract: [...SALE, 'deliveries', 'bestDeliveryStreak', 'contractsTaken'],
  buyHen: [...FLOCK, 'auctionHens'],
  buyHens: [...FLOCK, 'auctionHens'],
  buildCoop: ['coops', 'deluxeCoops', 'fullCoops', 'landCoops'],
  buyLand: ['landPlots', 'netWorth'],
  upgradeCoop: ['coops', 'deluxeCoops', 'fullCoops'],
  buyUnlock: ['ownsConveyor', 'ownsGrader', 'ownsCart', 'ownsHopper', 'ownsClerk', 'machinesOwned'],
  repairMachine: ['repairs', 'bestRepairStreak'],
  claimGoal: ['cashNow'],
  setFarmName: ['renamed'],
};

/** What business at night or at dawn moves (game/profile.ts noteAction). */
export const NOTE_BADGES: BadgeMetric[] = ['nightActions', 'bestCrowStreak'];
/** What a Feather minted moves. */
export const MINT_BADGES: BadgeMetric[] = ['ticketsWon', 'mintedFluff', 'mintedPlume', 'mintedQuill', 'mintedGoldenQuill', 'mintedGrades'];
/** What the conveyor's carry moves. */
export const CARRY_BADGES: BadgeMetric[] = ['eggsCollected', 'goldenCollected', 'crateNow'];

export interface EvaluateOptions {
  /** Only these categories (default: every badge). */
  categories?: Iterable<BadgeCategory>;
  /** Only the badges that count these numbers. */
  metrics?: Iterable<BadgeMetric>;
  /** Earn without telling the player (the fill from history). */
  quiet?: boolean;
  /** Mark what is earned as filled in from history. */
  backfilled?: boolean;
  /** At a day close (the current day is the one closing). */
  atClose?: boolean;
}

/**
 * Evaluates badges for player farms: each badge whose number reaches a higher level than the farm
 * holds is earned (its row records the level and the day) and, unless quiet, the player hears a
 * badgeEarned event; every badge's count is kept for the profile's progress. Returns what was earned.
 */
export async function evaluateBadges(ctx: Ctx, farmIds: string[], opts: EvaluateOptions = {}): Promise<{ farmId: string; badge: string; level: BadgeLevel }[]> {
  const q = ctx.q;
  if (!farmIds.length) return [];
  const players = await q.query<{ id: string; player_id: string | null }>(`SELECT id, player_id FROM farms WHERE owner_kind = 'player' AND id = ANY($1::text[])`, [farmIds]);
  if (!players.length) return [];
  const ids = players.map((p) => String(p.id));
  const cats = opts.categories ? new Set(opts.categories) : null;
  const only = opts.metrics ? new Set(opts.metrics) : null;
  const defs = BADGES.filter((b) => (!cats || cats.has(b.category)) && (!only || only.has(b.metric)));
  if (!defs.length) return [];
  const facts = await loadFacts(q, ids, ctx.day, new Set(defs.map((b) => b.metric)), opts.atClose ? ctx.day : ctx.day - 1);
  const held = new Map<string, { level: BadgeLevel | null; day: number | null; progress: number }>();
  for (const r of await q.query('SELECT farm_id, badge, tier, earned_day, progress FROM badges WHERE farm_id = ANY($1::text[]) AND badge = ANY($2::text[])', [ids, defs.map((b) => b.id)])) {
    held.set(`${String(r.farm_id)}|${String(r.badge)}`, {
      level: (r.tier as BadgeLevel | null) ?? null,
      day: r.earned_day === null || r.earned_day === undefined ? null : num(r.earned_day),
      progress: num(r.progress),
    });
  }
  const earned: { farmId: string; badge: string; level: BadgeLevel }[] = [];
  const rows: unknown[][] = [];
  for (const p of players) {
    const f = facts.get(String(p.id)) ?? {};
    for (const b of defs) {
      const value = f[b.metric] ?? 0;
      const was = held.get(`${p.id}|${b.id}`);
      const level = levelFor(b, value);
      if (levelAbove(level, was?.level ?? null)) {
        rows.push([p.id, b.id, level, ctx.day, value, opts.backfilled ?? false]);
        earned.push({ farmId: String(p.id), badge: b.id, level: level as BadgeLevel });
        if (!opts.quiet && p.player_id) ctx.out.push({ playerId: p.player_id, msg: { t: 'event', event: { kind: 'badgeEarned', badge: b.id, level: level as BadgeLevel, day: ctx.day } } });
      } else if (!was || was.progress !== value) {
        rows.push([p.id, b.id, was?.level ?? null, was?.day ?? null, value, false]);
      }
    }
  }
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((r) => {
      const at = values.length;
      values.push(...r);
      return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}::int, $${at + 5}, $${at + 6})`;
    });
    await q.query(
      `INSERT INTO badges (farm_id, badge, tier, earned_day, progress, backfilled) VALUES ${tuples.join(', ')}
       ON CONFLICT (farm_id, badge) DO UPDATE SET tier = EXCLUDED.tier, earned_day = EXCLUDED.earned_day, progress = EXCLUDED.progress,
         backfilled = badges.backfilled OR EXCLUDED.backfilled`,
      values,
    );
  }
  return earned;
}

/** Every catalog badge for a farm's profile: the level held (or null), the day, and the count. */
export async function badgeViews(q: Queryable, farmId: string): Promise<BadgeView[]> {
  const rows = new Map((await q.query('SELECT badge, tier, earned_day, progress FROM badges WHERE farm_id = $1', [farmId])).map((r) => [String(r.badge), r]));
  return BADGES.map((b) => {
    const r = rows.get(b.id);
    return {
      id: b.id,
      level: (r?.tier as BadgeLevel | null | undefined) ?? null,
      earnedDay: r?.earned_day === null || r?.earned_day === undefined ? null : num(r.earned_day),
      progress: num(r?.progress ?? 0),
    };
  });
}

/** Test and admin hook: gives a farm a badge at a level now (the player hears it, as if earned). */
export async function grantBadge(ctx: Ctx, farmId: string, badge: string, level: BadgeLevel): Promise<void> {
  if (!BADGE_BY_ID.has(badge)) throw new Error(`no badge ${badge}`);
  await ctx.q.query(
    `INSERT INTO badges (farm_id, badge, tier, earned_day, progress) VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (farm_id, badge) DO UPDATE SET tier = EXCLUDED.tier, earned_day = EXCLUDED.earned_day`,
    [farmId, badge, level, ctx.day],
  );
  const [f] = await ctx.q.query<{ player_id: string | null }>('SELECT player_id FROM farms WHERE id = $1', [farmId]);
  if (f?.player_id) ctx.out.push({ playerId: f.player_id, msg: { t: 'event', event: { kind: 'badgeEarned', badge, level, day: ctx.day } } });
}
