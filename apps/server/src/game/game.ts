// The authoritative game. Every price, balance and outcome is computed here from ECONOMY and the
// database; clients only ask for actions. Mutations run one at a time (serial) inside database
// transactions, and messages go out only after a transaction commits.
import { randomBytes } from 'node:crypto';
import {
  BODY_COLOURS,
  ECONOMY,
  power,
  type Unlocks,
  FARM_NAME_PROBLEM_TEXT,
  RENAME_EVERY_DAYS,
  checkFarmName,
  EGG_GRADES,
  FEATHER_GRADES,
  FEED_TIERS,
  RARITIES,
  breakageRate,
  coopCapacity,
  coopUpgradeCost,
  crowdingFactor,
  eggPrice,
  emptyFeedStock,
  feedGramsPerHenDay,
  gradeForRoll,
  henLayingRate,
  isCrash,
  MARKET_CHART_DAYS,
  marketMultiplier,
  marketReference,
  nextCoopKind,
  toMilli,
  type ActionMessage,
  type AgentKind,
  type AiMode,
  type ClockState,
  type CoopKind,
  type DaySummary,
  type EggGrade,
  type ErrorCode,
  type FarmState,
  type FeatherGrade,
  type FeedTier,
  type GameEvent,
  type HenView,
  type LedgerDay,
  type MarketChartDay,
  type MarketDay,
  type MarketState,
  type MintPageData,
  type MilestoneId,
  type OrderView,
  type Rarity,
  type ServerMessage,
  type ShopHenView,
  type ProfileData,
  type PublicProfile,
  topBadges,
  type Settlement,
} from '@coys/shared';
import { num, type Db, type Queryable } from '../db/db';
import { migrate } from '../db/migrations';
import { DecisionCache, MODE_WINDOW_DAYS, aiModeOf, decide, reflect, spendLine, type BrainOptions, type DecisionResult, type Tokens } from '../agents/brain';
import type { FarmAction } from '../agents/decision';
import type { ProviderStatus } from '../ai/chain';
import type { MintedFeather } from '../chain/batch';
import { missedDays, storeLateDays, type ChainWriter, type MintResult } from '../chain/chain';
import { drawForTicket, type Collection } from '../chain/mint';
import { arriveCards, buyBagsFrom, createCards, expireCards, farmCards, practiceCard, respondCard, type Candidate } from './cards';
import {
  applyDecision,
  bustIfBroke,
  buildContext,
  chargeForThinking,
  ensureCast,
  enterAiFarms,
  loyalistCreditQuote,
  openAgents,
  recordReason,
  startWeek,
  storeReflection,
  streetView,
  supplierQuote,
  turnOverStock,
  weekNow,
  weekToReflect,
  type CreateFarm,
} from './cast-runtime';
import { closeContracts, closeDebts, contractViews, debtViews, deliverContract } from './contracts';
import {
  ActionError,
  AGENT_COLUMNS,
  FARM_COLUMNS,
  loadFarm,
  moveCash,
  newId,
  spend,
  toAgent,
  toFarm,
  type Ctx,
  type Farm,
  type Outbound,
  type WeekStart,
} from './ctx';
import { activeFarms, cancelOrder, emit, expireOrders, fillOrderAction, placeSellOrder, streetSell } from './market';
import { featherCount, featherSlots, managementScore, milestoneViews, nextMilestone, rarityEstimates, redeemTicket, rollMilestones, standing, ticketViews } from './feathers';
import { claimGoal, goalViews, markGoal, markToured, toured } from './goals';
import { checkChosenName, nameTaken, renameLegacyFarms, setFarmName, uniqueFarmName } from './names';
import { conveyorCarry, hopperRefill, loadMachines, logMachine, logSale, machineDay, machineViews, repairMachine, wearMachines, type Machines } from './machines';
import { pick, randomSeed, seededRng, weighted, type Rng } from './rng';
import { ACTION_BADGES, CARRY_BADGES, MINT_BADGES, NOTE_BADGES, badgeViews, evaluateBadges, loadFacts } from './badges';
import { backfillProfiles, bumpStats, earnedBadges, layTally, noteAction, profileFor, publicProfileFor, rememberTraits, snapshotDay, statBrokeDown, statRepaired } from './profile';

export { ActionError } from './ctx';
export type { Outbound } from './ctx';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PlayerAction = DistributiveOmit<Exclude<ActionMessage, { t: 'linkWallet' | 'getLedger' | 'getProfile' }>, 'rid'>;

/** Actions that are business on the farm (the night owl and the rooster crow count them); settings and the tour are not. */
const BUSINESS = new Set<string>(['buyHens', 'buyHen', 'buyFeed', 'buyFeedOnCredit', 'buildCoop', 'upgradeCoop', 'buyUnlock', 'repairMachine', 'sell', 'collect', 'claimGoal', 'redeemTicket', 'respondCard', 'deliverContract', 'placeOrder', 'cancelOrder', 'fillOrder']);

export type ActionResult = { ok: true; events: GameEvent[] } | { ok: false; code: ErrorCode; message: string };

/** Cosmetic odds for new hens. The laying trait range is economy and lives in ECONOMY. */
const HEN_LOOK_ODDS = {
  eyes: { default: 60, sleepy: 20, wild: 20 },
  comb: { default: 55, spiky: 15, mohawk: 15, nub: 15 },
  accessory: { none: 70, tophat: 10, bowtie: 10, shades: 10 },
} as const;

export interface GameOptions {
  db: Db;
  chain: ChainWriter;
  brain: Omit<BrainOptions, 'log'>;
  now?: () => number;
  rng?: Rng;
  log?: (line: string) => void;
  /** Open the seven agents (default true; some tests run a quiet market). */
  cast?: boolean;
  /** New AI farms enter the street by the entry rule (default true, with the cast). */
  entrants?: boolean;
  /** In-game day length in ms (default ECONOMY.day.lengthMs; DEMO_DAY_SECONDS shortens it). */
  dayLengthMs?: number;
  /** GAME_SEASON. A fresh database takes it (or makes a dev season); an existing one must match. */
  season?: string | null;
  /** SHA-256 of founders.json (the 777 Founding Hens the Feathers are planned to hatch into). */
  provenance?: string;
  /** SETTLE_EVERY_DAYS: days settle on the chain in ranges of this many, one call each (default 1: every day, its own call). */
  settleEvery?: number;
}

/** The newest public reason in an agent's stored reasons, or null. */
function lastReason(raw: unknown): string | null {
  const list = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { text?: string }[] | null;
  return list?.at(-1)?.text ?? null;
}

/** One agent's turn, gathered before the day close: its decision, and its weekly reflection or the start of its first week. */
interface Gathered {
  agentId: string;
  result: DecisionResult;
  /** The multiplier it decided at. */
  multiplier: number;
  /** brain: the model that wrote it, or rules; provider: the provider that answered, or null. */
  reflection: { text: string; brain: string; provider: string | null; now: WeekStart; tokens: Tokens | null } | null;
  firstWeek: WeekStart | null;
}

/** The AI part of /healthz: no keys, only states and today's numbers. */
export interface AiStatus {
  mode: AiMode;
  providers: Record<'nearai' | 'serv', ProviderStatus>;
  todayUsd: number;
  capUsd: number;
  calls: number;
  failures: number;
}

/** A season id for a fresh database started without GAME_SEASON: unique, so it never collides on chain. */
export function devSeason(now: number): string {
  return `dev-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
}

export class Game {
  private readonly db: Db;
  private readonly chain: ChainWriter;
  private readonly brain: BrainOptions;
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly log: (line: string) => void;
  private readonly withCast: boolean;
  private readonly settleEvery: number;
  private readonly withEntrants: boolean;
  private readonly provenance: string;
  private readonly wantSeason: string | null;
  private readonly dayMs: number;
  /** The database's season, known after init(). */
  season = '';
  private readonly listeners = new Set<(out: Outbound) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  /** The collection this season's Feathers mint into, once the contract has said; null before. */
  private collection: Collection | null = null;
  /** The mint queue's run in progress, and whether it should go round once more when done. */
  private mintRun: Promise<void> | null = null;
  private mintAgain = false;
  private clock = { day: 1, dayStartedAt: 0 };
  private ticking = false;
  /** The agents' decisions for the coming close, gathered ahead of midnight so model calls never hold the close up. */
  private gathering: { day: number; promise: Promise<Gathered[] | null> } | null = null;
  /** Decisions, reflections and model calls (by tier, with their tokens), for reports and tests. */
  readonly stats = { decisions: 0, modelCalls: 0, fallbacks: 0, skipped: 0, reflections: 0, reflectionCalls: 0, mainCalls: 0, cheapCalls: 0, promptTokens: 0, completionTokens: 0 };

  constructor(opts: GameOptions) {
    this.db = opts.db;
    this.chain = opts.chain;
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? seededRng(randomSeed());
    this.log = opts.log ?? ((line) => console.log(line));
    this.brain = { cache: new DecisionCache(), ...opts.brain, log: this.log };
    this.withCast = opts.cast ?? true;
    this.settleEvery = Math.max(1, Math.floor(opts.settleEvery ?? 1));
    this.withEntrants = this.withCast && (opts.entrants ?? true);
    this.provenance = opts.provenance ?? '';
    this.wantSeason = opts.season ?? null;
    this.dayMs = opts.dayLengthMs ?? ECONOMY.day.lengthMs;
  }

  // ---- plumbing -------------------------------------------------------------------------------

  on(listener: (out: Outbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(playerId: string | null, msg: ServerMessage): void {
    for (const l of this.listeners) l({ playerId, msg });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private makeCtx(q: Queryable): Ctx {
    const now = this.now();
    return {
      q,
      season: this.season,
      day: this.clock.day,
      dayMs: this.dayMs,
      now,
      elapsed: now - this.clock.dayStartedAt,
      rng: this.rng,
      log: this.log,
      out: [],
      touched: new Set(),
      marketChanged: false,
    };
  }

  /** Runs fn in one transaction, then sends its queued messages and fresh farm and market state. */
  private async inTx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    let ctx: Ctx | null = null;
    const result = await this.db.tx(async (q) => {
      ctx = this.makeCtx(q);
      return fn(ctx);
    });
    await this.flush(ctx as unknown as Ctx);
    return result;
  }

  private async flush(ctx: Ctx): Promise<void> {
    for (const farmId of ctx.touched) {
      const [f] = await this.db.query('SELECT player_id FROM farms WHERE id = $1', [farmId]);
      if (f?.player_id) this.emit(String(f.player_id), { t: 'farm', farm: await this.getFarmState(farmId) });
    }
    for (const o of ctx.out) this.emit(o.playerId, o.msg);
    if (ctx.marketChanged) this.emit(null, { t: 'market', market: await this.getMarketState() });
  }

  getClock(): ClockState {
    return { day: this.clock.day, dayStartedAt: this.clock.dayStartedAt, dayLengthMs: this.dayMs, serverNow: this.now() };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async init(): Promise<void> {
    const applied = await migrate(this.db);
    if (applied.length) this.log(`[db] applied migrations ${applied.join(', ')} (${this.db.kind})`);
    const rows = await this.db.query('SELECT day, day_started_at FROM game_clock WHERE id = 1');
    if (!rows.length) {
      const season = this.wantSeason ?? devSeason(this.now());
      await this.db.tx(async (q) => {
        await q.query('INSERT INTO game_clock (id, day, day_started_at, season) VALUES (1, 1, $1, $2)', [this.now(), season]);
        await q.query('INSERT INTO market_days (season, day, multiplier) VALUES ($1, 1, $2)', [season, ECONOMY.market.openingMultiplier]);
      });
    }
    const [clock] = await this.db.query('SELECT day, day_started_at, season FROM game_clock WHERE id = 1');
    const stored = String(clock?.season);
    if (this.wantSeason !== null && this.wantSeason !== stored) {
      throw new Error(
        `this database holds season ${stored} but GAME_SEASON is ${this.wantSeason}. A new season needs a fresh DATABASE_URL; to carry on, set GAME_SEASON=${stored}.`,
      );
    }
    this.season = stored;
    this.clock = { day: num(clock?.day), dayStartedAt: num(clock?.day_started_at) };
    await this.serial(() =>
      this.inTx(async (ctx) => {
        // farms named at sign-in before farm naming: a generated name now, the owner asked to choose
        const renamed = await renameLegacyFarms(ctx.q, this.rng);
        if (renamed) {
          this.log(`[names] ${renamed} farm${renamed === 1 ? '' : 's'} named at sign-in got a generated name; their owners will be asked to choose one`);
          ctx.marketChanged = true;
        }
        if (this.withCast) await ensureCast(ctx, this.createFarmFn);
        // farms from before the profile: their records and badges, filled in once from their history
        const filled = await backfillProfiles(ctx);
        if (filled.length) {
          await evaluateBadges(ctx, filled, { quiet: true, backfilled: true });
          this.log(`[profile] filled in ${filled.length} farm${filled.length === 1 ? '' : 's'} from their history`);
        }
        const [listed] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE status = 'forsale'`);
        if (num(listed?.n) === 0) await this.refreshShop(ctx);
      }),
    );
  }

  /** Called every second: cards arrive through the day; the day closes when its time is up. */
  async tick(): Promise<void> {
    if (this.now() >= this.clock.dayStartedAt + this.dayMs) {
      await this.tickIfDue();
      return;
    }
    // a model call takes seconds: the agents decide in the day's last stretch (the close's model time
    // and a little more), in the background, so the close itself never waits on a model
    const lead = (this.brain.chain?.closeBudgetMs ?? 0) + 10_000;
    if (this.withCast && lead > 10_000 && !this.gathering && this.now() >= this.clock.dayStartedAt + this.dayMs - lead) {
      this.gathering = { day: this.clock.day, promise: this.gatherDecisions().catch(() => null) };
    }
    await this.serial(() =>
      this.inTx(async (ctx) => {
        await arriveCards(ctx);
        const carried = await conveyorCarry(ctx);
        if (carried.length) await evaluateBadges(ctx, carried, { metrics: CARRY_BADGES });
      }),
    );
  }

  async tickIfDue(): Promise<boolean> {
    if (this.ticking || this.now() < this.clock.dayStartedAt + this.dayMs) return false;
    this.ticking = true;
    try {
      await this.endDay();
      return true;
    } finally {
      this.ticking = false;
    }
  }

  // ---- players --------------------------------------------------------------------------------

  /**
   * Finds or makes a player and their farm. The farm's name never comes from sign-in: an email
   * sign-in gets a generated name and the player is asked to choose one; the local dev login keeps
   * the typed name when it passes the naming rules and is free. `guard` is the email-name guard
   * (a hash and a length, see game/names.ts), kept to refuse farm names that contain it.
   */
  async ensurePlayer(
    provider: 'privy' | 'dev',
    subject: string,
    typedName: string | null,
    guard: { sha256: string; len: number } | null = null,
  ): Promise<{ playerId: string; farmId: string; name: string; created: boolean }> {
    return this.serial(() =>
      this.inTx(async (ctx) => {
        const [found] = await ctx.q.query<{ id: string; farm_id: string; farm_name: string; guard: string | null }>(
          `SELECT p.id, f.id AS farm_id, f.name AS farm_name, p.name_guard_sha256 AS guard FROM players p JOIN farms f ON f.player_id = p.id
           WHERE p.auth_provider = $1 AND p.auth_subject = $2`,
          [provider, subject],
        );
        if (found) {
          if (guard && !found.guard) await ctx.q.query('UPDATE players SET name_guard_sha256 = $2, name_guard_len = $3 WHERE id = $1', [found.id, guard.sha256, guard.len]);
          return { playerId: found.id, farmId: found.farm_id, name: String(found.farm_name), created: false };
        }
        const typed = provider === 'dev' && typedName ? checkFarmName(typedName) : null;
        const keep = typed?.ok && !(await nameTaken(ctx.q, typed.name, null)) ? typed.name : null;
        const name = keep ?? (await uniqueFarmName(ctx.q, this.rng));
        const playerId = newId();
        await ctx.q.query(
          'INSERT INTO players (id, auth_provider, auth_subject, display_name, created_at, name_guard_sha256, name_guard_len) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [playerId, provider, subject, name, this.now(), guard?.sha256 ?? null, guard?.len ?? null],
        );
        const s = ECONOMY.start;
        const farmId = await this.createFarm(ctx, {
          ownerKind: 'player',
          playerId,
          agentKey: null,
          name,
          nameSource: keep ? 'chosen' : 'generated',
          needsName: !keep,
          cash: s.cash,
          hens: s.hens,
          coops: [s.coop],
          feed: s.feed,
        });
        ctx.marketChanged = true;
        return { playerId, farmId, name, created: true };
      }),
    );
  }

  async playerInfo(playerId: string): Promise<{ name: string; farmId: string } | null> {
    const [row] = await this.db.query<{ name: string; farm_id: string }>('SELECT f.name, f.id AS farm_id FROM players p JOIN farms f ON f.player_id = p.id WHERE p.id = $1', [
      playerId,
    ]);
    return row ? { name: String(row.name), farmId: row.farm_id } : null;
  }

  private readonly createFarmFn: CreateFarm = (ctx, spec) => this.createFarm(ctx, { ...spec, playerId: null, nameSource: 'agent', needsName: false });

  private async createFarm(
    ctx: Ctx,
    spec: {
      ownerKind: 'player' | 'agent';
      playerId: string | null;
      agentKey: string | null;
      name: string;
      nameSource: 'generated' | 'chosen' | 'agent';
      needsName: boolean;
      cash: number;
      hens: number;
      coops: readonly CoopKind[];
      feed: { tier: FeedTier; kg: number };
    },
  ): Promise<string> {
    const farmId = newId();
    await ctx.q.query(
      `INSERT INTO farms (id, owner_kind, player_id, agent_key, name, cash_milli, feed_tier, feed_${spec.feed.tier}_g, created_day, name_source, needs_name)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10)`,
      [farmId, spec.ownerKind, spec.playerId, spec.agentKey, spec.name, spec.feed.tier, spec.feed.kg * 1000, ctx.day, spec.nameSource, spec.needsName],
    );
    await moveCash(ctx, farmId, 'start', toMilli(spec.cash), 'opening balance');
    // a new farm's profile counters start here (a farm without them is filled in from history at boot)
    await ctx.q.query('INSERT INTO farm_stats (farm_id) VALUES ($1) ON CONFLICT (farm_id) DO NOTHING', [farmId]);
    for (const [plot, kind] of spec.coops.entries()) {
      await ctx.q.query('INSERT INTO coops (id, farm_id, kind, plot, built_day) VALUES ($1, $2, $3, $4, $5)', [newId(), farmId, kind, plot, ctx.day]);
    }
    await this.insertHens(ctx, farmId, spec.hens);
    await this.planFarmDay(ctx.q, farmId, ctx.day);
    return farmId;
  }

  private async insertHens(ctx: Ctx, farmId: string | null, count: number): Promise<string[]> {
    if (count <= 0) return [];
    const ids: string[] = [];
    const { min, max } = ECONOMY.hen.trait;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let i = 0; i < count; i++) {
      const b = values.length;
      rows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`);
      const henId = newId();
      ids.push(henId);
      values.push(
        henId,
        farmId,
        farmId ? 'alive' : 'forsale',
        pick(this.rng, BODY_COLOURS),
        weighted(this.rng, HEN_LOOK_ODDS.eyes),
        weighted(this.rng, HEN_LOOK_ODDS.comb),
        weighted(this.rng, HEN_LOOK_ODDS.accessory),
        Math.round((min + this.rng() * (max - min)) * 1000) / 1000,
        ctx.day,
        // a random head start staggers laying, so a new flock lays on its first day
        this.rng(),
      );
    }
    await ctx.q.query(
      `INSERT INTO hens (id, farm_id, status, body, eyes, comb, accessory, laying_trait, born_day, lay_progress) VALUES ${rows.join(', ')}`,
      values,
    );
    return ids;
  }

  /** Each morning the breeder lists a fresh handful of hens beside any auction hens. */
  private async refreshShop(ctx: Ctx): Promise<void> {
    await ctx.q.query(`DELETE FROM hens WHERE status = 'forsale'`);
    await this.insertHens(ctx, null, ECONOMY.shop.hensPerDay);
  }

  // ---- state views ----------------------------------------------------------------------------

  async getFarmState(farmId: string): Promise<FarmState> {
    const ctx = this.makeCtx(this.db);
    const q = this.db;
    const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [farmId]);
    if (!row) throw new ActionError('not_found', 'farm not found');
    const farm = toFarm(row);
    const day = this.clock.day;
    const henView = (h: Record<string, unknown>): HenView => ({
      id: String(h.id),
      body: h.body as HenView['body'],
      eyes: h.eyes as HenView['eyes'],
      comb: h.comb as HenView['comb'],
      accessory: h.accessory as HenView['accessory'],
      layingTrait: num(h.laying_trait),
      ageDays: day - num(h.born_day),
    });
    const hens = await q.query(
      'SELECT id, body, eyes, comb, accessory, laying_trait, born_day FROM hens WHERE farm_id = $1 AND status = $2 ORDER BY born_day, id',
      [farmId, 'alive'],
    );
    const coops = await q.query('SELECT id, kind, plot FROM coops WHERE farm_id = $1 ORDER BY plot', [farmId]);
    const unlocks = await this.loadUnlocks(q, farmId);
    const eggs = await q.query('SELECT id, hen_id, at_ms, grade, broken, collected FROM lay_events WHERE farm_id = $1 AND day = $2 ORDER BY at_ms', [farmId, day]);
    const shopRows = await q.query(`SELECT id, body, eyes, comb, accessory, laying_trait, born_day, status FROM hens WHERE status IN ('forsale', 'auction') ORDER BY status, laying_trait DESC LIMIT 12`);
    const orders = await this.orderViews(`o.farm_id = $1`, [farmId], farmId);
    return {
      farmId,
      day,
      name: farm.name,
      cashMilli: farm.cashMilli,
      feedTier: farm.feedTier,
      feedGrams: farm.feed,
      fedToday: farm.fedMultiplier,
      hens: hens.map(henView),
      coops: coops.map((c) => ({ id: String(c.id), kind: c.kind as CoopKind, plot: num(c.plot) })),
      crate: farm.crate,
      unlocks: unlocks.owned,
      machineState: machineViews(unlocks),
      layPlan: eggs.map((e) => ({
        id: String(e.id),
        henId: String(e.hen_id),
        atMs: num(e.at_ms),
        grade: e.grade as EggGrade,
        broken: Boolean(e.broken),
        collected: Boolean(e.collected),
      })),
      bust: farm.bustDay !== null,
      supplier: farm.supplier,
      clerkFloor: farm.clerkFloor,
      cards: await farmCards(ctx, farmId),
      contracts: await contractViews(ctx, farmId),
      debts: await debtViews(ctx, farmId),
      orders,
      goals: await goalViews(q, farmId),
      tourDone: await toured(q, farmId),
      ...(await (async () => {
        const [n] = await q.query('SELECT needs_name, renamed_day FROM farms WHERE id = $1', [farmId]);
        const renamed = n?.renamed_day === null || n?.renamed_day === undefined ? null : num(n.renamed_day);
        const from = renamed === null ? null : renamed + RENAME_EVERY_DAYS;
        return { needsName: Boolean(n?.needs_name), renameFromDay: from !== null && from > day ? from : null };
      })()),
      milestones: await milestoneViews(q, farmId),
      standing: await standing(q, farmId, Math.max(1, day - 1)),
      tickets: await ticketViews(q, farmId),
      score: await managementScore(q, farmId),
      machines: await machineDay(q, farmId, day),
      hopperCapMilli: farm.hopperCapMilli,
      shop: shopRows.map(
        (h): ShopHenView => ({
          ...henView(h),
          source: h.status === 'auction' ? 'auction' : 'breeder',
          priceMilli: toMilli(ECONOMY.hen.price * (h.status === 'auction' ? ECONOMY.agents.auctionPriceFactor : 1)),
        }),
      ),
    };
  }

  private async orderViews(where: string, params: unknown[], viewerFarmId: string | null): Promise<OrderView[]> {
    const rows = await this.db.query(
      `SELECT o.id, o.side, o.grade, o.qty, o.filled_qty, o.price_milli, o.expires_day, o.farm_id, f.name AS farm_name, f.owner_kind, a.name AS agent_name
       FROM orders o LEFT JOIN farms f ON f.id = o.farm_id LEFT JOIN agents a ON a.id = o.agent_id
       WHERE o.status = 'open' AND o.kind = 'limit' AND ${where}
       ORDER BY o.side, CASE WHEN o.side = 'buy' THEN -o.price_milli ELSE o.price_milli END LIMIT 30`,
      params,
    );
    return rows.map((r) => ({
      id: String(r.id),
      side: r.side as 'buy' | 'sell',
      owner: String(r.farm_name ?? r.agent_name ?? 'Unknown'),
      ownerKind: r.farm_id && r.owner_kind === 'player' ? 'player' : 'agent',
      mine: viewerFarmId !== null && r.farm_id === viewerFarmId,
      grade: r.grade as EggGrade,
      qty: num(r.qty) - num(r.filled_qty),
      priceMilli: num(r.price_milli),
      expiresDay: num(r.expires_day),
    }));
  }

  async getMarketState(): Promise<MarketState> {
    const day = this.clock.day;
    const [today] = await this.db.query('SELECT multiplier, supply FROM market_days WHERE day = $1', [day]);
    const multiplier = num(today?.multiplier ?? ECONOMY.market.openingMultiplier);
    const closed = (await this.db.query('SELECT day, supply, multiplier, reference FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 30')).reverse();
    const history = closed.map((r): MarketDay => ({ day: num(r.day), supply: num(r.supply), multiplier: num(r.multiplier) }));
    // the price chart: the last closed days, each with its demand and one egg's price per grade
    const chart = closed.slice(-MARKET_CHART_DAYS).map(
      (r): MarketChartDay => ({
        day: num(r.day),
        multiplier: num(r.multiplier),
        supply: num(r.supply),
        demand: r.reference === null || r.reference === undefined ? null : num(r.reference),
        pricesMilli: Object.fromEntries(EGG_GRADES.map((g) => [g, toMilli(eggPrice(g, num(r.multiplier), []))])) as Record<EggGrade, number>,
      }),
    );
    const reference = marketReference(await activeFarms(this.db));
    const counts = await this.db.query(`SELECT owner_kind, (bust_day IS NOT NULL) AS bust, count(*) AS n FROM farms GROUP BY owner_kind, (bust_day IS NOT NULL)`);
    const farms = { players: 0, agents: 0, bust: 0 };
    for (const c of counts) {
      if (c.bust) farms.bust += num(c.n);
      else if (c.owner_kind === 'agent') farms.agents += num(c.n);
      else farms.players += num(c.n);
    }
    const [settled] = await this.db.query('SELECT day, settlement_status, settlement_tx, settlement_first, settlement_last FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 1');
    const agentRows = await this.db.query(
      `SELECT a.*, f.cash_milli AS farm_cash, (SELECT count(*) FROM hens h WHERE h.farm_id = a.farm_id AND h.status = 'alive') AS hens
       FROM agents a LEFT JOIN farms f ON f.id = a.farm_id
       WHERE a.status = 'open' OR a.bust_day >= $1 ORDER BY a.kind, a.generation`,
      [day - 3],
    );
    // the agents' mode, and each agent's own: the rules unless a provider answered lately (aiModeOf)
    const aiMode = await this.aiMode();
    const brainOf = (a: Record<string, unknown>): AiMode =>
      aiMode !== 'rules' && (a.model_provider === 'nearai' || a.model_provider === 'serv') && num(a.model_day ?? -1e9) >= day - MODE_WINDOW_DAYS && this.brain.chain.usable(a.model_provider) ? a.model_provider : 'rules';
    const ranking = await this.db.query(
      `SELECT f.id, f.name, f.owner_kind, f.cash_milli, f.bust_day, a.kind AS agent_kind,
              (SELECT count(*) FROM hens h WHERE h.farm_id = f.id AND h.status = 'alive') AS hens
       FROM farms f LEFT JOIN agents a ON a.farm_id = f.id ORDER BY (f.bust_day IS NULL) DESC, f.cash_milli DESC LIMIT 12`,
    );
    // each ranked farm's best few badges, for a small row beside its name
    const marks = await earnedBadges(this.db, ranking.map((r) => String(r.id)));
    const trades = await this.db.query(
      `SELECT t.*, (t.seller_agent IS NOT NULL OR sf.owner_kind = 'agent') AS seller_ai, (t.buyer_agent IS NOT NULL OR bf.owner_kind = 'agent') AS buyer_ai
       FROM trades t LEFT JOIN farms sf ON sf.id = t.seller_farm LEFT JOIN farms bf ON bf.id = t.buyer_farm ORDER BY t.total_milli DESC, t.id DESC LIMIT 200`,
    );
    const recentBig = trades
      .filter((t) => num(t.day) >= day - 1)
      .slice(0, 12)
      .map((t) => ({
        day: num(t.day),
        seller: String(t.seller),
        buyer: String(t.buyer),
        grade: t.grade as EggGrade,
        qty: num(t.qty),
        priceMilli: num(t.price_milli),
        totalMilli: num(t.total_milli),
        via: t.via as MarketState['trades'][number]['via'],
        sellerAi: Boolean(t.seller_ai),
        buyerAi: Boolean(t.buyer_ai),
      }));
    return {
      season: this.season,
      day,
      multiplier,
      pricesMilli: Object.fromEntries(EGG_GRADES.map((g) => [g, toMilli(eggPrice(g, multiplier, []))])) as Record<EggGrade, number>,
      supplyToday: num(today?.supply ?? 0),
      reference,
      crash: isCrash(multiplier),
      history,
      chart,
      farms,
      settlement: settled
        ? {
            day: num(settled.day),
            status: settled.settlement_status as Settlement['status'],
            txHash: (settled.settlement_tx as string | null) ?? null,
            first: settled.settlement_first === null || settled.settlement_first === undefined ? null : num(settled.settlement_first),
            last: settled.settlement_last === null || settled.settlement_last === undefined ? null : num(settled.settlement_last),
          }
        : null,
      agents: agentRows.map((a) => ({
        id: String(a.id),
        kind: a.kind as AgentKind,
        role: a.role as 'rival' | 'supplier' | 'buyer',
        name: String(a.name),
        status: a.status === 'bust' ? 'bust' : 'open',
        cashMilli: a.farm_id ? num(a.farm_cash) : num(a.cash_milli),
        generation: num(a.generation),
        hens: a.farm_id ? num(a.hens) : null,
        account: (a.near_account_id as string | null) ?? null,
        reason: lastReason(a.reasons),
        brain: brainOf(a),
      })),
      book: await this.orderViews('true', [], null),
      trades: recentBig,
      ranking: ranking.map((r) => ({
        farmId: String(r.id),
        name: String(r.name),
        kind: r.owner_kind === 'agent' ? ((r.agent_kind as AgentKind) ?? 'upstart') : 'player',
        hens: num(r.hens),
        cashMilli: num(r.cash_milli),
        bust: r.bust_day !== null,
        badges: topBadges(marks.get(String(r.id)) ?? [], 3),
      })),
      explorer: this.chain.explorer,
      minting: this.chain.minting,
      feathers: await (async () => {
        const c = await featherCount(this.db, this.chain.featherMinted);
        return { max: c.max, minted: c.minted, left: c.left, tickets: c.tickets };
      })(),
      aiMode,
    };
  }

  /** The mint page: the Feathers minted so far, by grade, the estimates, recent mints and all 777 slots. Public. */
  async getMintPage(): Promise<MintPageData> {
    const count = await featherCount(this.db, this.chain.featherMinted);
    // the contract is the record: every Feather on it, with this season's own details where the database has them
    const local = await featherSlots(this.db);
    const onChain = this.chain.featherTokens ? await this.chain.featherTokens().catch(() => null) : null;
    const byNumber = new Map(local.map((x) => [x.number, x]));
    for (const t of onChain ?? []) {
      if (byNumber.has(t.number)) continue;
      byNumber.set(t.number, { number: t.number, grade: t.grade, milestone: t.milestone, day: t.day, owner: t.owner, farm: t.season === this.season ? 'A FARM' : `TEST SEASON ${t.season.toUpperCase()}`, mintTx: null });
    }
    const slots = [...byNumber.values()].sort((a, b) => a.number - b.number);
    const byGrade = Object.fromEntries(FEATHER_GRADES.map((g) => [g, slots.filter((x) => x.grade === g).length])) as Record<FeatherGrade, number>;
    const F = ECONOMY.feathers;
    return {
      max: count.max,
      minted: count.minted,
      left: count.left,
      tickets: count.tickets,
      byGrade,
      provenance: this.provenance,
      contract: this.chain.contractId,
      contractUrl: this.chain.contractId ? `https://testnet.nearblocks.io/address/${this.chain.contractId}` : null,
      explorer: this.chain.explorer,
      minting: this.chain.minting,
      redeemFeeMilli: toMilli(F.redeemFee),
      estimates: rarityEstimates(byGrade),
      rarityCounts: Object.fromEntries(RARITIES.map((r, i) => [r, F.rarityCounts[i] ?? 0])) as Record<Rarity, number>,
      gradeWeights: Object.fromEntries(FEATHER_GRADES.map((g) => [g, [...F.gradeWeights[g]]])) as Record<FeatherGrade, number[]>,
      // the most recent mints this server made, then (older) any the contract holds that it did not
      recent: [...(await featherSlots(this.db, 'recent')), ...slots.filter((x) => !local.some((l) => l.number === x.number)).reverse()].slice(0, 8),
      slots,
    };
  }

  /** The player's own profile (private: sent only to its player). */
  async getProfile(farmId: string): Promise<ProfileData> {
    const facts = (await loadFacts(this.db, [farmId], this.clock.day, ['daysNoBreakdown', 'bigTrades'])).get(farmId) ?? {};
    return profileFor(this.db, farmId, this.clock.day, facts, await badgeViews(this.db, farmId));
  }

  /** A farm's public profile (GET /api/profile/:farmId): a whitelist of public fields, or null. */
  async getPublicProfile(farmId: string): Promise<PublicProfile | null> {
    return publicProfileFor(this.db, farmId, this.clock.day);
  }

  async getLedger(farmId: string): Promise<LedgerDay[]> {
    const rows = await this.db.query(
      `SELECT l.day, l.kind, SUM(l.amount_milli) AS amount FROM ledger l WHERE l.farm_id = $1 AND l.day >= $2 GROUP BY l.day, l.kind ORDER BY l.day DESC`,
      [farmId, this.clock.day - 30],
    );
    const days = await this.db.query('SELECT day, settlement_status, settlement_tx, settlement_first, settlement_last FROM market_days WHERE day >= $1', [this.clock.day - 30]);
    const opt = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
    const settle = new Map(
      days.map((d) => [
        num(d.day),
        { day: num(d.day), status: d.settlement_status as Settlement['status'], txHash: (d.settlement_tx as string | null) ?? null, first: opt(d.settlement_first), last: opt(d.settlement_last) },
      ]),
    );
    const out = new Map<number, LedgerDay>();
    for (const r of rows) {
      const day = num(r.day);
      const amount = num(r.amount);
      const d = out.get(day) ?? { day, incomeMilli: 0, costMilli: 0, netMilli: 0, byKind: {}, settlement: settle.get(day) ?? null };
      if (String(r.kind) !== 'start') {
        if (amount >= 0) d.incomeMilli += amount;
        else d.costMilli += -amount;
        d.netMilli += amount;
      }
      d.byKind[String(r.kind)] = (d.byKind[String(r.kind)] ?? 0) + amount;
      out.set(day, d);
    }
    for (const r of await this.db.query('SELECT day, machine, units, saved, milli FROM machine_days WHERE farm_id = $1 AND day >= $2', [farmId, this.clock.day - 30])) {
      const d = out.get(num(r.day));
      if (!d) continue;
      d.machines = { ...d.machines, [String(r.machine)]: { units: num(r.units), saved: num(r.saved), milli: num(r.milli) } };
    }
    return [...out.values()].sort((a, b) => b.day - a.day);
  }

  // ---- actions --------------------------------------------------------------------------------

  /** Validates and applies one player action. */
  async act(playerId: string, action: ActionMessage): Promise<ActionResult> {
    if (action.t === 'getLedger') {
      const info = await this.playerInfo(playerId);
      if (info) this.emit(playerId, { t: 'ledger', days: await this.getLedger(info.farmId) });
      return { ok: true, events: [] };
    }
    if (action.t === 'getProfile') {
      const info = await this.playerInfo(playerId);
      if (info) this.emit(playerId, { t: 'profile', profile: await this.getProfile(info.farmId) });
      return { ok: true, events: [] };
    }
    // a redemption draws its number in the collection its season mints into (the contract says which)
    if (action.t === 'redeemTicket' && this.collection === null) {
      try {
        this.collection = this.chain.collectionFor ? await this.chain.collectionFor(this.season) : 'live';
      } catch {
        return { ok: false, code: 'invalid_action', message: 'NEAR testnet could not be reached just now; your ticket is safe, try again in a moment' };
      }
    }
    const result = await this.serial(async (): Promise<ActionResult> => {
      try {
        await this.inTx(async (ctx) => {
          if (action.t === 'linkWallet') {
            const [p] = await ctx.q.query<{ near_account_id: string | null }>('SELECT near_account_id FROM players WHERE id = $1', [playerId]);
            if (!p) throw new ActionError('not_found', 'player not found');
            if (p.near_account_id && p.near_account_id !== action.accountId) throw new ActionError('invalid_action', 'already linked');
            await ctx.q.query('UPDATE players SET near_account_id = $2 WHERE id = $1', [playerId, action.accountId]);
            return;
          }
          const [row] = await ctx.q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE player_id = $1`, [playerId]);
          if (!row) throw new ActionError('not_found', 'farm not found');
          const farm = toFarm(row);
          const { rid: _rid, ...rest } = action;
          await this.applyPlayerAction(ctx, farm, rest as PlayerAction);
          ctx.touched.add(farm.id);
          // the badges this action can move (and the night owl and the rooster crow, for business)
          const metrics = [...(ACTION_BADGES[action.t] ?? [])];
          if (BUSINESS.has(action.t) && (await noteAction(ctx, farm.id))) metrics.push(...NOTE_BADGES);
          if (metrics.length) await evaluateBadges(ctx, [farm.id], { metrics });
        });
        return { ok: true, events: [] };
      } catch (err) {
        if (err instanceof ActionError) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    });
    // a redeemed ticket mints at once; a newly linked wallet lets waiting mints go
    if (result.ok && (action.t === 'redeemTicket' || action.t === 'linkWallet')) this.kickMints();
    return result;
  }

  private async applyPlayerAction(ctx: Ctx, farm: Farm, action: PlayerAction): Promise<void> {
    if (farm.bustDay !== null) throw new ActionError('farm_bust', 'this farm is bust');
    switch (action.t) {
      case 'respondCard':
        return respondCard(ctx, farm, action.cardId, action.choice, action.ask);
      case 'deliverContract':
        return deliverContract(ctx, farm, action.contractId);
      case 'placeOrder':
        await placeSellOrder(ctx, farm, action.grade, action.qty, action.price);
        return;
      case 'cancelOrder':
        return cancelOrder(ctx, farm, action.orderId);
      case 'fillOrder':
        return fillOrderAction(ctx, farm, action.orderId, action.qty);
      case 'setClerkFloor':
        await ctx.q.query('UPDATE farms SET clerk_floor = $2 WHERE id = $1', [farm.id, action.floor]);
        return;
      case 'setSupplier':
        await ctx.q.query('UPDATE farms SET supplier = $2 WHERE id = $1', [farm.id, action.supplier]);
        return;
      case 'buyHen':
        return this.buyHen(ctx, farm, action.henId);
      case 'practiceCard':
        return practiceCard(ctx, farm);
      case 'tourDone':
        return markToured(ctx.q, farm.id);
      case 'setFarmName': {
        const [st] = await ctx.q.query('SELECT needs_name, renamed_day FROM farms WHERE id = $1', [farm.id]);
        const needsName = Boolean(st?.needs_name);
        const renamedDay = st?.renamed_day === null || st?.renamed_day === undefined ? null : num(st.renamed_day);
        const r = await checkChosenName(ctx.q, { id: farm.id, playerId: farm.playerId, needsName, renamedDay }, action.name, ctx.day);
        if (!r.ok) throw new ActionError(`name_${r.problem}`, FARM_NAME_PROBLEM_TEXT[r.problem]);
        // the first choice is free; a later rename in Settings starts the weekly wait
        await setFarmName(ctx.q, farm.id, r.name, { source: 'chosen', needsName: false, renamedDay: needsName ? null : ctx.day });
        ctx.marketChanged = true;
        return;
      }
      case 'keepFarmName':
        await ctx.q.query('UPDATE farms SET needs_name = false WHERE id = $1', [farm.id]);
        return;
      case 'redeemTicket': {
        const r = await redeemTicket(ctx, farm.id, action.ticketId, this.collection ?? 'live');
        emit(ctx, farm, { kind: 'ticketRedeemed', ticketId: action.ticketId, grade: r.grade, score: r.score, feeMilli: r.feeMilli, number: r.number });
        ctx.marketChanged = true;
        return;
      }
      default:
        return this.applyFarmAction(ctx, farm, action);
    }
  }

  private async buyHen(ctx: Ctx, farm: Farm, henId: string): Promise<void> {
    const [h] = await ctx.q.query(`SELECT status FROM hens WHERE id = $1 AND status IN ('forsale', 'auction')`, [henId]);
    if (!h) throw new ActionError('not_found', 'that hen has been sold');
    const cost = toMilli(ECONOMY.hen.price * (h.status === 'auction' ? ECONOMY.agents.auctionPriceFactor : 1));
    await spend(ctx, farm, 'hens', cost, `hen ${henId.slice(0, 8)}`);
    await ctx.q.query(`UPDATE hens SET status = 'alive', farm_id = $1, lay_progress = 0 WHERE id = $2`, [farm.id, henId]);
    if (h.status === 'auction') await bumpStats(ctx.q, farm.id, { auction_hens: 1 });
    emit(ctx, farm, { kind: 'hensBought', count: 1, fromAuction: h.status === 'auction' ? 1 : 0, costMilli: cost, henIds: [henId] });
  }

  /** Farm actions shared by players and rival agents. */
  private readonly applyFarmAction = async (ctx: Ctx, farm: Farm, action: FarmAction | PlayerAction): Promise<void> => {
    if (farm.bustDay !== null) throw new ActionError('farm_bust', 'this farm is bust');
    const unlocks = await this.loadUnlocks(ctx.q, farm.id);
    switch (action.t) {
      case 'buyHens': {
        const henMilli = toMilli(ECONOMY.hen.price);
        const auctionMilli = toMilli(ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor);
        const auction = await ctx.q.query<{ id: string }>(`SELECT id FROM hens WHERE status = 'auction' ORDER BY laying_trait DESC, id LIMIT $1`, [action.count]);
        const fresh = action.count - auction.length;
        const cost = auction.length * auctionMilli + fresh * henMilli;
        await spend(ctx, farm, 'hens', cost, `${action.count} hens`);
        if (auction.length) {
          await ctx.q.query(`UPDATE hens SET status = 'alive', farm_id = $1, lay_progress = 0 WHERE id = ANY($2::text[])`, [farm.id, auction.map((h) => h.id)]);
          await bumpStats(ctx.q, farm.id, { auction_hens: auction.length });
          ctx.marketChanged = true;
        }
        const born = await this.insertHens(ctx, farm.id, fresh);
        emit(ctx, farm, { kind: 'hensBought', count: action.count, fromAuction: auction.length, costMilli: cost, henIds: [...auction.map((h) => h.id), ...born] });
        return;
      }
      case 'buyFeed':
        await this.buyFeedFor(ctx, farm, action.tier, action.bags, unlocks, null);
        return;
      case 'buyFeedOnCredit': {
        const quote = await loyalistCreditQuote(ctx, farm, action.tier, action.bags);
        await buyBagsFrom(ctx, farm, quote.agent, action.tier, action.bags, quote.unitMilli, true);
        return;
      }
      case 'setFeedTier':
        await ctx.q.query('UPDATE farms SET feed_tier = $2 WHERE id = $1', [farm.id, action.tier]);
        return;
      case 'setHopperCap':
        await ctx.q.query('UPDATE farms SET hopper_cap_milli = $2 WHERE id = $1', [farm.id, toMilli(action.cap)]);
        return;
      case 'buildCoop': {
        const used = new Set((await ctx.q.query<{ plot: number }>('SELECT plot FROM coops WHERE farm_id = $1', [farm.id])).map((r) => num(r.plot)));
        let plot = -1;
        for (let p = 0; p < ECONOMY.coops.plots; p++)
          if (!used.has(p)) {
            plot = p;
            break;
          }
        if (plot < 0) throw new ActionError('invalid_action', 'no free coop plot');
        const cost = toMilli(ECONOMY.coops.kinds[action.kind].price);
        await spend(ctx, farm, 'coop', cost, `build ${action.kind}`);
        const coopId = newId();
        await ctx.q.query('INSERT INTO coops (id, farm_id, kind, plot, built_day) VALUES ($1, $2, $3, $4, $5)', [coopId, farm.id, action.kind, plot, ctx.day]);
        emit(ctx, farm, { kind: 'coopBuilt', coopId, coopKind: action.kind, plot, costMilli: cost });
        return;
      }
      case 'upgradeCoop': {
        const [coop] = await ctx.q.query<{ kind: CoopKind }>('SELECT kind FROM coops WHERE id = $1 AND farm_id = $2', [action.coopId, farm.id]);
        if (!coop) throw new ActionError('not_found', 'coop not found');
        const next = nextCoopKind(coop.kind);
        if (!next) throw new ActionError('invalid_action', 'coop is already the biggest kind');
        const cost = toMilli(coopUpgradeCost(coop.kind, next));
        await spend(ctx, farm, 'coop', cost, `upgrade to ${next}`);
        await ctx.q.query('UPDATE coops SET kind = $2 WHERE id = $1', [action.coopId, next]);
        emit(ctx, farm, { kind: 'coopUpgraded', coopId: action.coopId, coopKind: next, costMilli: cost });
        return;
      }
      case 'buyUnlock': {
        if (unlocks.owned.includes(action.unlock)) throw new ActionError('invalid_action', `${action.unlock} already bought`);
        const cost = toMilli(ECONOMY.unlocks[action.unlock].price);
        await spend(ctx, farm, 'unlock', cost, action.unlock);
        await ctx.q.query('INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, $2, $3)', [farm.id, action.unlock, ctx.day]);
        emit(ctx, farm, { kind: 'unlockBought', unlock: action.unlock, costMilli: cost });
        return;
      }
      case 'repairMachine': {
        const [was] = await ctx.q.query('SELECT broken FROM unlocks WHERE farm_id = $1 AND unlock_id = $2', [farm.id, action.unlock]);
        const cost = await repairMachine(ctx, farm, action.unlock);
        await statRepaired(ctx.q, farm.id, Boolean(was?.broken));
        emit(ctx, farm, { kind: 'machineRepaired', unlock: action.unlock, costMilli: cost });
        return;
      }
      case 'sell': {
        const r = await streetSell(ctx, farm, action.items, unlocks);
        await logSale(ctx, farm, r.sold, r.multiplier, unlocks);
        emit(ctx, farm, { kind: 'sold', items: r.sold, totalMilli: r.totalMilli, multiplier: r.multiplier });
        if (r.totalMilli > 0) await markGoal(ctx.q, farm.id, 'sell');
        return;
      }
      case 'claimGoal':
        await claimGoal(ctx, farm, action.goal);
        return;
      case 'collect': {
        const [egg] = await ctx.q.query('SELECT grade, at_ms, broken, collected FROM lay_events WHERE id = $1 AND farm_id = $2 AND day = $3', [action.eggId, farm.id, ctx.day]);
        if (!egg) throw new ActionError('not_found', 'egg not found');
        if (num(egg.at_ms) > ctx.elapsed) throw new ActionError('invalid_action', 'egg not laid yet');
        if (egg.broken) throw new ActionError('invalid_action', 'egg is broken');
        if (egg.collected) throw new ActionError('invalid_action', 'egg already collected');
        const grade = egg.grade as EggGrade;
        await ctx.q.query('UPDATE lay_events SET collected = true WHERE id = $1', [action.eggId]);
        await ctx.q.query(`UPDATE farms SET crate_${grade} = crate_${grade} + 1 WHERE id = $1`, [farm.id]);
        await bumpStats(ctx.q, farm.id, { eggs_collected: 1, eggs_picked: 1, golden_collected: grade === 'golden' ? 1 : 0 });
        emit(ctx, farm, { kind: 'collected', eggId: action.eggId, grade });
        await markGoal(ctx.q, farm.id, 'collect');
        return;
      }
      default:
        throw new ActionError('invalid_action', 'unknown action');
    }
  };

  private loadUnlocks(q: Queryable, farmId: string): Promise<Machines> {
    return loadMachines(q, farmId);
  }

  // ---- the day --------------------------------------------------------------------------------

  /** Dawn: the hens eat (active tier first) and each hen's laying builds up lay progress. */
  /**
   * A farm's feed purchase from its supplier (or the mill when none is open), with the hopper's
   * discount when it has one. With a cap it is the hopper buying on its own: it skips a price over
   * the cap, buys only what the farm can pay for, and returns what it bought (null for nothing).
   */
  private async buyFeedFor(ctx: Ctx, farm: Farm, tier: FeedTier, bags: number, unlocks: Unlocks, capMilli: number | null): Promise<{ bags: number; unitMilli: number } | null> {
    const [h] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farm.id]);
    const quote = await supplierQuote(ctx, farm, tier, num(h?.n));
    const unit = Math.round(quote.unitMilli * (1 - ECONOMY.unlocks.hopper.feedCostDiscount * power(unlocks, 'hopper')));
    const auto = capMilli !== null;
    if (auto) {
      if (unit > capMilli) return null;
      bags = Math.min(bags, Math.floor(farm.cashMilli / unit), quote.agent ? (quote.agent.stock[tier] ?? 0) : bags);
      if (bags <= 0) return null;
    }
    if (quote.agent) {
      await buyBagsFrom(ctx, farm, quote.agent, tier, bags, unit, false, auto);
    } else {
      await spend(ctx, farm, 'feed', unit * bags, `${bags} ${tier} bags from the mill${auto ? ' (hopper)' : ''}`);
      await ctx.q.query(`UPDATE farms SET feed_${tier}_g = feed_${tier}_g + $2 WHERE id = $1`, [farm.id, bags * ECONOMY.feed.bagKg * 1000]);
      emit(ctx, farm, { kind: 'feedBought', tier, bags, costMilli: unit * bags, supplier: 'the feed mill', ...(auto ? { auto: true } : {}) });
    }
    ctx.touched.add(farm.id);
    return { bags, unitMilli: unit };
  }

  private async planFarmDay(q: Queryable, farmId: string, day: number): Promise<{ feedGramsUsed: number; fedMultiplier: number }> {
    const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [farmId]);
    if (!row) throw new Error(`farm ${farmId} missing`);
    const farm = toFarm(row);
    const hens = await q.query(`SELECT id, laying_trait, born_day, lay_progress FROM hens WHERE farm_id = $1 AND status = 'alive' ORDER BY id`, [farmId]);
    const kinds = (await q.query<{ kind: CoopKind }>('SELECT kind FROM coops WHERE farm_id = $1', [farmId])).map((c) => c.kind);
    const unlocks = await this.loadUnlocks(q, farmId);
    const need = hens.length * feedGramsPerHenDay();
    let remaining = need;
    const used = emptyFeedStock();
    for (const tier of [farm.feedTier, ...FEED_TIERS.filter((t) => t !== farm.feedTier)]) {
      const take = Math.min(remaining, farm.feed[tier]);
      used[tier] = take;
      remaining -= take;
    }
    const feedGramsUsed = need - remaining;
    const fedMultiplier = need > 0 ? FEED_TIERS.reduce((s, t) => s + used[t] * ECONOMY.feed.tiers[t].laying, 0) / need : 0;
    const gradeTier = FEED_TIERS.reduce((best, t) => (used[t] > used[best] || (used[t] === used[best] && t === farm.feedTier) ? t : best), farm.feedTier);
    await q.query(
      `UPDATE farms SET feed_cheap_g = feed_cheap_g - $2, feed_standard_g = feed_standard_g - $3, feed_premium_g = feed_premium_g - $4, fed_multiplier = $5 WHERE id = $1`,
      [farmId, used.cheap, used.standard, used.premium, fedMultiplier],
    );
    const crowding = crowdingFactor(hens.length, coopCapacity(kinds));
    const breakage = breakageRate(unlocks);
    // eggs the conveyor keeps from cracking: they would have broken at the plain rate
    const plainBreakage = ECONOMY.eggs.breakage;
    let saved = 0;
    const { start, end } = ECONOMY.day.layWindow;
    const ids: string[] = [];
    const progress: number[] = [];
    const eggs: unknown[][] = [];
    for (const h of hens) {
      const rate = henLayingRate({ feedMultiplier: fedMultiplier, trait: num(h.laying_trait), ageDays: day - num(h.born_day), crowding });
      let p = num(h.lay_progress) + rate;
      const n = Math.floor(p + 1e-9);
      p = Math.max(0, p - n);
      ids.push(String(h.id));
      progress.push(p);
      for (let i = 0; i < n; i++) {
        const atMs = Math.floor((start + this.rng() * (end - start)) * this.dayMs);
        const grade = gradeForRoll(gradeTier, this.rng());
        const roll = this.rng();
        const keep = roll >= breakage && roll < plainBreakage;
        if (keep) saved++;
        eggs.push([newId(), farmId, String(h.id), day, atMs, grade, roll < breakage, keep]);
      }
    }
    if (ids.length) await q.query('UPDATE hens SET lay_progress = v.p FROM unnest($1::text[], $2::float8[]) AS v(id, p) WHERE hens.id = v.id', [ids, progress]);
    for (let i = 0; i < eggs.length; i += 400) {
      const chunk = eggs.slice(i, i + 400);
      const values: unknown[] = [];
      const rows = chunk.map((e) => {
        const b = values.length;
        values.push(...e);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
      });
      await q.query(`INSERT INTO lay_events (id, farm_id, hen_id, day, at_ms, grade, broken, saved) VALUES ${rows.join(', ')}`, values);
    }
    if (saved > 0) await logMachine(q, farmId, day, 'conveyor', { saved });
    return { feedGramsUsed, fedMultiplier };
  }

  /** Tallies a model call's tier and tokens (a call whose reply was unusable still used them). */
  private count(tokens: Tokens | null): void {
    if (!tokens) return;
    if (tokens.tier === 'main') this.stats.mainCalls++;
    else this.stats.cheapCalls++;
    this.stats.promptTokens += tokens.prompt;
    this.stats.completionTokens += tokens.completion;
  }

  /**
   * Builds each open agent's context and asks its brain, before taking the lock. An agent whose week
   * is up reflects on it first, so the day's decision already reads the new reflection.
   */
  private async gatherDecisions(): Promise<Gathered[]> {
    if (!this.withCast) return [];
    const ctx = this.makeCtx(this.db);
    const agents = await openAgents(ctx);
    const history = (await this.db.query('SELECT day, supply, multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 7'))
      .map((r): MarketDay => ({ day: num(r.day), supply: num(r.supply), multiplier: num(r.multiplier) }))
      .reverse();
    const [today] = await this.db.query('SELECT supply, multiplier FROM market_days WHERE day = $1', [ctx.day]);
    history.push({ day: ctx.day, supply: num(today?.supply ?? 0), multiplier: num(today?.multiplier ?? 1) });
    const [auction] = await this.db.query(`SELECT count(*) AS n FROM hens WHERE status = 'auction'`);
    const street = await streetView(ctx);
    const out: Gathered[] = [];
    // one at a time keeps model calls polite; each is bounded by its own timeout and all of them by the close's time budget
    const chain = this.brain.chain;
    chain.beginClose();
    try {
      for (const agent of agents) {
        const c = await buildContext(ctx, agent, history, num(auction?.n), street);
        const due = await weekToReflect(ctx, agent);
        let reflection: Gathered['reflection'] = null;
        if (due) {
          const r = await reflect(c, due.week, this.brain);
          reflection = { text: r.text, brain: r.model ?? 'rules', provider: r.brain === 'rules' ? null : r.brain, now: due.now, tokens: r.tokens ?? null };
          c.agent.reflection = r.text;
        }
        // a reflection by a model just now counts as its latest model answer
        const lastModelDay = reflection?.provider ? ctx.day : agent.modelDay;
        const result = await decide(c, this.brain, { lastModelMultiplier: agent.modelMultiplier, lastModelDay });
        out.push({ agentId: agent.id, result, multiplier: c.market.multiplier, reflection, firstWeek: !due && !agent.weekStart ? await weekNow(ctx, agent) : null });
      }
    } finally {
      chain.endClose();
    }
    return out;
  }

  /** The daily AI spend line, once a real hour, after a day close (so the mode counts its answers). */
  private async logAiSpend(): Promise<void> {
    const chain = this.brain.chain;
    if (!chain.configured || chain.now() - chain.spendLoggedAt < 3_600_000) return;
    chain.spendLoggedAt = chain.now();
    this.log(await this.aiSpendLine());
  }

  /** The daily AI spend line with the agents' mode. */
  async aiSpendLine(): Promise<string> {
    return `${await spendLine(this.brain.budget)}; mode ${await this.aiMode()}`;
  }

  private capReached(): boolean {
    return this.brain.chain.capReachedOn === this.brain.budget.today();
  }

  /** The agents' mode now (see aiModeOf). */
  async aiMode(): Promise<AiMode> {
    const rows = await this.db.query('SELECT model_provider AS provider, model_day AS day FROM agents WHERE model_day >= $1', [this.clock.day - MODE_WINDOW_DAYS]);
    return aiModeOf(rows, this.clock.day, this.brain.chain, this.capReached());
  }

  /** The AI part of /healthz. */
  async aiStatus(): Promise<AiStatus> {
    const u = await this.brain.budget.usage();
    return {
      mode: await this.aiMode(),
      providers: this.brain.chain.status(),
      todayUsd: Math.round(u.spendUsd * 1e6) / 1e6,
      capUsd: this.brain.budget.capUsd,
      calls: u.calls,
      failures: u.failures,
    };
  }

  /**
   * Ends the day: collect eggs, deliver contracts, settle debts, close cards and orders, let every
   * agent act on its decision and pay for it, close bust agents, close the market on the day's
   * total supply, then open the next day with fresh cards and a fresh shop.
   */
  async endDay(): Promise<void> {
    // the decisions gathered ahead of midnight for this day, or gathered now
    const early = this.gathering?.day === this.clock.day ? await this.gathering.promise : null;
    this.gathering = null;
    const decisions = early ?? (await this.gatherDecisions());
    const closedDay = await this.serial(async () => {
      let ctxOut: Ctx | null = null;
      const outcome = await this.db.tx(async (q) => {
        const ctx = this.makeCtx(q);
        ctxOut = ctx;
        const day = ctx.day;
        // the day's eggs as they lay before the close, for the profile
        const lay = await layTally(q, day);
        // 1. every laid egg goes into its crate
        const collected = new Map<string, number>();
        for (const p of await q.query(`SELECT farm_id, grade, count(*) AS n FROM lay_events WHERE day = $1 AND NOT collected AND NOT broken GROUP BY farm_id, grade`, [day])) {
          const grade = p.grade as EggGrade;
          await q.query(`UPDATE farms SET crate_${grade} = crate_${grade} + $2 WHERE id = $1`, [p.farm_id, num(p.n)]);
          collected.set(String(p.farm_id), (collected.get(String(p.farm_id)) ?? 0) + num(p.n));
        }
        await q.query('UPDATE lay_events SET collected = true WHERE day = $1 AND NOT collected AND NOT broken', [day]);
        const laid = new Map<string, { laid: number; broken: number }>();
        for (const r of await q.query('SELECT farm_id, count(*) AS laid, sum(CASE WHEN broken THEN 1 ELSE 0 END) AS broken FROM lay_events WHERE day = $1 GROUP BY farm_id', [day])) {
          laid.set(String(r.farm_id), { laid: num(r.laid), broken: num(r.broken) });
        }
        // 2. contracts, credit, cards and orders close for the day
        const tally = await closeContracts(ctx);
        await closeDebts(ctx);
        // machines that worked today wear; a worn-out one may break down
        for (const b of await wearMachines(ctx, day, this.rng)) {
          await statBrokeDown(q, b.farmId, day);
          const farm = await loadFarm(q, b.farmId);
          emit(ctx, farm, { kind: 'machineBroke', unlock: b.unlock });
        }
        await expireCards(ctx);
        await expireOrders(ctx);
        // 3. the cast acts
        const acted: { agentId: string; result: DecisionResult }[] = [];
        for (const { agentId, result, multiplier, reflection, firstWeek } of decisions) {
          const [row] = await q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 AND status = 'open'`, [agentId]);
          if (!row) continue;
          const agent = toAgent(row);
          if (reflection) {
            await storeReflection(ctx, agent, reflection.text, reflection.now, reflection.brain);
            if (reflection.provider) await q.query('UPDATE agents SET model_provider = $2, model_day = $3 WHERE id = $1', [agent.id, reflection.provider, day]);
            this.stats.reflections++;
            if (reflection.brain !== 'rules') this.stats.reflectionCalls++;
            this.count(reflection.tokens);
          } else if (firstWeek) await startWeek(ctx, agent, firstWeek);
          await turnOverStock(ctx, agent);
          if (result.brain !== 'skipped') {
            await applyDecision(ctx, agent, result.decision, this.applyFarmAction, 'close');
            acted.push({ agentId, result });
            agent.lastBrain = result.brain;
            await chargeForThinking(ctx, agent);
          }
          this.stats.decisions += result.brain === 'skipped' ? 0 : 1;
          if (result.brain !== 'rules' && result.brain !== 'skipped') {
            this.stats.modelCalls++;
            await q.query('UPDATE agents SET model_provider = $2, model_day = $3, model_multiplier = $4 WHERE id = $1', [agent.id, result.brain, day, multiplier]);
          }
          if (result.fallback) this.stats.fallbacks++;
          if (result.brain === 'skipped') this.stats.skipped++;
          this.count(result.tokens ?? null);
          await recordReason(ctx, agent, result.decision.reason);
          await q.query('UPDATE agents SET last_decided_day = $2, last_brain = $3 WHERE id = $1', [agent.id, day, result.brain]);
          await bustIfBroke(ctx, agent);
        }
        // 4. the market closes on the day's total supply, against demand from every active farm
        const [md] = await q.query('SELECT multiplier, supply FROM market_days WHERE day = $1', [day]);
        const supply = num(md?.supply ?? 0);
        const reference = marketReference(await activeFarms(q));
        const nextMultiplier = marketMultiplier(supply, reference);
        await q.query('UPDATE market_days SET closed_at = $2, next_multiplier = $3, reference = $4 WHERE day = $1', [day, ctx.now, nextMultiplier, reference]);
        // 4b. milestones: one auditable roll each, once, for player farms in good standing; a win is a Feather Ticket
        const rolls = await rollMilestones(ctx, this.chain.featherMinted);
        if (rolls.length) {
          const { left } = await featherCount(q, this.chain.featherMinted);
          for (const r of rolls) {
            if (!r.playerId) continue;
            const next = await nextMilestone(q, r.farmId);
            ctx.out.push({
              playerId: r.playerId,
              msg: { t: 'event', event: { kind: 'milestoneRoll', milestone: r.milestone, won: r.won, ticketId: r.ticketId, next, left, roll: r.roll, odds: ECONOMY.feathers.odds } },
            });
          }
        }
        // 4c. the profile's record of the day, and the badges it moved (players hear them after the close)
        await snapshotDay(ctx, day, lay);
        const playerFarms = (await q.query<{ id: string }>(`SELECT id FROM farms WHERE owner_kind = 'player' ORDER BY id`)).map((r) => String(r.id));
        await rememberTraits(q, playerFarms);
        await evaluateBadges(ctx, playerFarms, { atClose: true });
        // 5. the next day opens
        const newDay = day + 1;
        let start = this.clock.dayStartedAt + this.dayMs;
        if (ctx.now - start > this.dayMs) start = ctx.now; // after downtime, start fresh instead of replaying days
        await q.query('UPDATE game_clock SET day = $1, day_started_at = $2 WHERE id = 1', [newDay, start]);
        await q.query('INSERT INTO market_days (season, day, multiplier) VALUES ($1, $2, $3)', [ctx.season, newDay, nextMultiplier]);
        this.clock = { day: newDay, dayStartedAt: start };
        ctx.day = newDay;
        ctx.elapsed = ctx.now - start;
        // the feed hoppers top up low troughs before the hens eat at dawn
        for (const f of await q.query<{ farm_id: string }>(`SELECT u.farm_id FROM unlocks u JOIN farms f ON f.id = u.farm_id WHERE u.unlock_id = 'hopper' AND NOT u.broken AND f.bust_day IS NULL`)) {
          const m = await loadMachines(q, f.farm_id);
          await hopperRefill(ctx, f.farm_id, (c, farm, tier, bags, cap) => this.buyFeedFor(c, farm, tier, bags, m, cap));
        }
        const plans = new Map<string, { feedGramsUsed: number; fedMultiplier: number }>();
        for (const f of await q.query<{ id: string }>('SELECT id FROM farms WHERE bust_day IS NULL')) plans.set(f.id, await this.planFarmDay(q, f.id, newDay));
        await q.query('DELETE FROM lay_events WHERE day < $1', [newDay - 1]);
        await this.refreshShop(ctx);
        if (this.withCast) await ensureCast(ctx, this.createFarmFn);
        // a new AI farm may enter: when eggs ran short for days, a rival went bust, or too few are open
        if (this.withEntrants) await enterAiFarms(ctx, this.createFarmFn);
        // orders, fills and offers price against the new day's market
        const candidates: Candidate[] = [];
        for (const { agentId, result } of acted) {
          const [row] = await q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 AND status = 'open'`, [agentId]);
          if (row) candidates.push(...(await applyDecision(ctx, toAgent(row), result.decision, this.applyFarmAction, 'open')));
        }
        // other players' open sell orders reach each player as a trade card
        const trades: { farmId: string; orderId: string }[] = [];
        const sells = await q.query(`SELECT o.id, o.farm_id FROM orders o JOIN farms f ON f.id = o.farm_id WHERE o.status = 'open' AND o.kind = 'limit' AND o.side = 'sell' AND f.owner_kind = 'player'`);
        for (const p of await q.query<{ id: string }>(`SELECT id FROM farms WHERE owner_kind = 'player' AND bust_day IS NULL`)) {
          const other = sells.find((s) => s.farm_id !== p.id);
          if (other) trades.push({ farmId: p.id, orderId: String(other.id) });
        }
        await createCards(ctx, candidates, trades);
        await arriveCards(ctx);
        ctx.marketChanged = true;
        return { day, supply, reference, nextMultiplier, collected, laid, plans, tally };
      });
      const ctx = ctxOut as unknown as Ctx;
      const players = await this.db.query<{ id: string; player_id: string }>(`SELECT id, player_id FROM farms WHERE owner_kind = 'player'`);
      for (const p of players) {
        const summary: DaySummary = {
          day: outcome.day,
          laid: outcome.laid.get(p.id)?.laid ?? 0,
          broken: outcome.laid.get(p.id)?.broken ?? 0,
          autoCollected: outcome.collected.get(p.id) ?? 0,
          feedGramsUsed: outcome.plans.get(p.id)?.feedGramsUsed ?? 0,
          fedMultiplier: outcome.plans.get(p.id)?.fedMultiplier ?? 0,
          closingSupply: outcome.supply,
          nextMultiplier: outcome.nextMultiplier,
          delivered: outcome.tally.get(p.id)?.delivered ?? 0,
          missed: outcome.tally.get(p.id)?.missed ?? 0,
        };
        this.emit(p.player_id, { t: 'event', event: { kind: 'dayEnded', summary } });
        ctx.touched.add(p.id);
      }
      await this.flush(ctx);
      this.emit(null, { t: 'clock', clock: this.getClock() });
      this.log(`[day] ${outcome.day} closed: supply ${outcome.supply} of ${outcome.reference} demand, next multiplier ${outcome.nextMultiplier.toFixed(3)}; day ${this.clock.day} begins`);
      return outcome.day;
    });

    if (this.settleEvery > 1 && this.chain.settleRange) {
      await this.settleInRanges(closedDay, false);
      this.emit(null, { t: 'market', market: await this.getMarketState() });
      if (this.chain.collectionFor) this.collection = await this.chain.collectionFor(this.season).catch(() => this.collection);
      this.kickMints();
      return;
    }
    const result = await this.chain.settleDay(this.db, this.season, closedDay);
    await this.db.query(
      'UPDATE market_days SET settlement_status = $3, settlement_tx = $4, settlement_error = $5, settlement_json = COALESCE($6, settlement_json), settlement_digest = COALESCE($7, settlement_digest) WHERE season = $1 AND day = $2',
      [this.season, closedDay, result.status, result.txHash, result.error ?? null, result.settlement ? JSON.stringify(result.settlement) : null, result.digest ?? null],
    );
    if (result.status === 'sent' && result.txHash && result.minted?.length) await this.announceMints(result.minted, result.txHash, closedDay);
    if (result.status === 'sent') await this.catchUpLateDays(closedDay);
    this.emit(null, { t: 'market', market: await this.getMarketState() });
    await this.logAiSpend();
    // the day close's catch-up: any redeemed ticket whose mint is still waiting goes again
    if (this.chain.collectionFor) this.collection = await this.chain.collectionFor(this.season).catch(() => this.collection);
    this.kickMints();
  }

  // ---- instant mints --------------------------------------------------------------------------

  /** Starts the mint queue, or (if it is running) has it go round once more. */
  kickMints(): void {
    if (this.mintRun) {
      this.mintAgain = true;
      return;
    }
    this.mintRun = this.pumpMints()
      .catch((err: unknown) => this.log(`[mint] the queue stopped: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.mintRun = null;
      });
  }

  /** Waits until the mint queue is idle (tests and scripts). */
  async mintsIdle(): Promise<void> {
    while (this.mintRun) await this.mintRun;
  }

  /** Every redeemed ticket of this season, in redemption order, one mint at a time (paced by the chain writer). */
  private async pumpMints(): Promise<void> {
    do {
      this.mintAgain = false;
      const rows = await this.db.query<{ id: string }>(`SELECT id FROM feather_tickets WHERE status = 'queued' AND season = $1 ORDER BY redeemed_seq, id`, [this.season]);
      for (const r of rows) await this.mintTicket(String(r.id));
    } while (this.mintAgain);
  }

  private async mintTicket(ticketId: string): Promise<void> {
    const [t] = await this.db.query(
      `SELECT t.id, t.farm_id, t.grade, t.milestone, t.season, t.day, t.number, t.fee_milli, t.mint_state, t.mint_note, f.player_id, p.near_account_id AS account
       FROM feather_tickets t JOIN farms f ON f.id = t.farm_id LEFT JOIN players p ON p.id = f.player_id WHERE t.id = $1 AND t.status = 'queued'`,
      [ticketId],
    );
    if (!t) return;
    const farmId = String(t.farm_id);
    const playerId = t.player_id ? String(t.player_id) : null;
    const grade = t.grade as FeatherGrade;
    let state = { s: (t.mint_state as string | null) ?? null, note: (t.mint_note as string | null) ?? null };
    const tell = async (event: GameEvent) => {
      if (!playerId) return;
      this.emit(playerId, { t: 'farm', farm: await this.getFarmState(farmId) });
      this.emit(playerId, { t: 'event', event });
    };
    const wait = async (note: string) => {
      if (state.s === 'waiting' && state.note === note) return;
      await this.db.query(`UPDATE feather_tickets SET mint_state = 'waiting', mint_note = $2 WHERE id = $1 AND status = 'queued'`, [ticketId, note]);
      state = { s: 'waiting', note };
      this.log(`[mint] ticket ${ticketId} waits: ${note}`);
      await tell({ kind: 'mintWaiting', ticketId, note });
    };
    if (!this.chain.mintFeather) return wait('this server has no chain to mint on');
    if (!t.account) return wait('link your NEAR wallet in Settings: it mints the moment you do');
    if (this.collection === null) {
      try {
        this.collection = this.chain.collectionFor ? await this.chain.collectionFor(this.season) : 'live';
      } catch {
        return wait('NEAR testnet could not be reached: it goes again at the next day close');
      }
    }
    const collection = this.collection;
    const draw = (alsoTaken: number[]) => this.serial(() => this.inTx((ctx) => drawForTicket(ctx.q, ticketId, this.season, collection, ctx.log, alsoTaken)));
    let number = t.number === null || t.number === undefined ? (await draw([])).number : num(t.number);
    const alsoTaken: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.db.query(`UPDATE feather_tickets SET mint_state = 'sending', mint_note = NULL, mint_tries = mint_tries + 1 WHERE id = $1`, [ticketId]);
      state = { s: 'sending', note: null };
      await tell({ kind: 'mintSent', ticketId, number, grade });
      const r = await this.chain.mintFeather({ owner: String(t.account), grade, milestone: t.milestone as MilestoneId, season: String(t.season), day: num(t.day), number });
      if (r.status === 'sent') return this.mintConfirmed(ticketId, farmId, playerId, number, String(t.account), r);
      if (r.status === 'waiting') return wait(r.note ?? 'the chain is not ready: it goes again at the next day close');
      if (!r.taken) return this.mintFailed(ticketId, farmId, playerId, num(t.fee_milli), r.note ?? 'the mint did not go through');
      alsoTaken.push(number);
      number = (await draw(alsoTaken)).number;
    }
    return this.mintFailed(ticketId, farmId, playerId, num(t.fee_milli), 'every number drawn was taken on chain');
  }

  private async mintConfirmed(ticketId: string, farmId: string, playerId: string | null, number: number, owner: string, r: MintResult): Promise<void> {
    const day = this.clock.day;
    const [t] = await this.serial(() =>
      this.inTx(async (ctx) => {
        await ctx.q.query(
          `UPDATE feather_tickets SET status = 'minted', number = $2, token_id = COALESCE($3, token_id), owner_account = $4, media_sha256 = $5, mint_tx = $6, mint_day = $7,
           mint_state = NULL, mint_note = NULL WHERE id = $1`,
          [ticketId, number, r.token, owner, r.mediaSha256, r.txHash, day],
        );
        ctx.touched.add(farmId);
        ctx.marketChanged = true;
        await evaluateBadges(ctx, [farmId], { metrics: MINT_BADGES });
        return ctx.q.query('SELECT grade, milestone, token_id FROM feather_tickets WHERE id = $1', [ticketId]);
      }),
    );
    this.log(`[mint] ticket ${ticketId} minted Feather ${String(t?.token_id)}: ${r.txHash ?? 'landed earlier'}`);
    if (playerId && t) {
      this.emit(playerId, {
        t: 'event',
        event: { kind: 'featherMinted', ticketId, number, grade: t.grade as FeatherGrade, milestone: t.milestone as MilestoneId, token: String(t.token_id), owner, txHash: r.txHash, day },
      });
    }
  }

  /** A mint that did not go through: the ticket is held again (its number's seed kept, so a new try draws the same number if free) and its fee refunded. */
  private async mintFailed(ticketId: string, farmId: string, playerId: string | null, feeMilli: number, note: string): Promise<void> {
    await this.serial(() =>
      this.inTx(async (ctx) => {
        await moveCash(ctx, farmId, 'feather-fee', feeMilli, ticketId);
        await ctx.q.query(
          `UPDATE feather_tickets SET status = 'held', grade = NULL, score = NULL, fee_milli = NULL, redeemed_day = NULL, redeemed_seq = NULL, number = NULL, token_id = NULL,
           mint_state = NULL, mint_note = $2 WHERE id = $1`,
          [ticketId, note],
        );
        ctx.touched.add(farmId);
        ctx.marketChanged = true;
      }),
    );
    this.log(`[mint] ticket ${ticketId} did not mint (${note}): held again, fee refunded`);
    if (playerId) this.emit(playerId, { t: 'event', event: { kind: 'mintFailed', ticketId, note, refundMilli: feeMilli } });
  }

  /**
   * Settlement in ranges (SETTLE_EVERY_DAYS above 1): the closed day waits as 'batched'; once that many
   * wait (or on a flush, at shutdown), one call settles them all, the range from the first waiting day
   * to the last. A failed call leaves them waiting, and the next close tries the whole range again
   * with the days since (catch-up by range, at most 100 days a call).
   */
  private async settleInRanges(closedDay: number | null, flush: boolean): Promise<void> {
    const settleRange = this.chain.settleRange?.bind(this.chain);
    if (!settleRange) return;
    if (closedDay !== null) {
      await this.db.query(`UPDATE market_days SET settlement_status = 'batched' WHERE season = $1 AND day = $2 AND settlement_status = 'pending'`, [this.season, closedDay]);
    }
    const waiting = (
      await this.db.query<{ day: number }>(`SELECT day FROM market_days WHERE season = $1 AND closed_at IS NOT NULL AND settlement_status = 'batched' ORDER BY day LIMIT 100`, [this.season])
    ).map((r) => num(r.day));
    if (!waiting.length || (!flush && waiting.length < this.settleEvery)) return;
    const first = waiting[0] ?? 0;
    const last = waiting[waiting.length - 1] ?? first;
    const r = await settleRange(this.db, this.season, first, last);
    if (r.status === 'failed') {
      await this.db.query('UPDATE market_days SET settlement_error = $3 WHERE season = $1 AND day = $2', [this.season, last, r.error ?? 'failed']);
      return;
    }
    await this.db.tx(async (q) => {
      await q.query(
        `UPDATE market_days SET settlement_status = $4, settlement_tx = $5, settlement_error = $6, settlement_digest = $7, settlement_first = $2, settlement_last = $3
         WHERE season = $1 AND day BETWEEN $2 AND $3 AND settlement_status = 'batched'`,
        [this.season, first, last, r.status, r.txHash, r.error ?? null, r.digest ?? null],
      );
      if (r.settlement) await q.query('UPDATE market_days SET settlement_json = $3 WHERE season = $1 AND day = $2', [this.season, last, JSON.stringify(r.settlement)]);
    });
    if (r.status === 'sent') await this.catchUpLateDays(last + 1);
  }

  /** Settles the days still waiting for their range (at shutdown, or at a season's end). */
  async flushSettlement(): Promise<void> {
    if (this.settleEvery > 1) await this.serial(() => this.settleInRanges(null, true));
  }

  /**
   * At each day close that settled, any earlier closed day of this season whose settlement failed (or
   * never ran) is recorded late on the chain: one paced call for up to ten days, by their digests.
   */
  private async catchUpLateDays(closedDay: number): Promise<void> {
    if (!this.chain.settleLateDays) return;
    const missed = await missedDays(this.db, this.season, closedDay);
    if (!missed.length) return;
    const late = await this.chain.settleLateDays(this.db, this.season, missed);
    if (late.status !== 'sent') this.log(`[chain] ${missed.length} missed days of ${this.season} wait to be recorded late: ${late.error ?? late.status}`);
    await storeLateDays(this.db, this.season, late);
  }


  /** Each minted Feather's owner hears about it (the reveal moment) and gets their farm's new tickets. */
  private async announceMints(minted: MintedFeather[], txHash: string, day: number): Promise<void> {
    const rows = await this.db.query<{ id: string; farm_id: string; player_id: string | null }>(
      `SELECT t.id, t.farm_id, f.player_id FROM feather_tickets t JOIN farms f ON f.id = t.farm_id WHERE t.id = ANY($1::text[])`,
      [minted.map((m) => m.ticketId)],
    );
    const by = new Map(rows.map((r) => [String(r.id), r]));
    const farms = new Map<string, string>();
    for (const m of minted) {
      const r = by.get(m.ticketId);
      if (!r?.player_id) continue;
      farms.set(String(r.farm_id), String(r.player_id));
      this.emit(String(r.player_id), {
        t: 'event',
        event: { kind: 'featherMinted', ticketId: m.ticketId, number: m.number, grade: m.grade, milestone: m.milestone, token: m.token, owner: m.owner, txHash, day },
      });
    }
    for (const [farmId, playerId] of farms) this.emit(playerId, { t: 'farm', farm: await this.getFarmState(farmId) });
  }

  /** Ledger total for a farm, for audits and tests: always equals the farm's cash. */
  async ledgerTotal(farmId: string): Promise<number> {
    const [r] = await this.db.query('SELECT COALESCE(SUM(amount_milli), 0) AS s FROM ledger WHERE farm_id = $1', [farmId]);
    return num(r?.s);
  }

  /** Test and admin hook: run a mutation inside the game's lock and transaction. */
  async withCtx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    return this.serial(() => this.inTx(fn));
  }
}

