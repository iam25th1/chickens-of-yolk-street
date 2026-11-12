// The authoritative game. Every price, balance and outcome is computed here from ECONOMY and the
// database; clients only ask for actions. Mutations run one at a time (serial) inside database
// transactions, and messages go out only after a transaction commits.
import { randomBytes } from 'node:crypto';
import {
  BODY_COLOURS,
  ECONOMY,
  EGG_GRADES,
  FEED_TIERS,
  UNLOCK_IDS,
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
  marketMultiplier,
  marketReference,
  nextCoopKind,
  toMilli,
  type ActionMessage,
  type AgentKind,
  type ClockState,
  type CoopKind,
  type DaySummary,
  type EggGrade,
  type ErrorCode,
  type FarmState,
  type FeedTier,
  type GameEvent,
  type HenView,
  type LedgerDay,
  type MarketDay,
  type MarketState,
  type MilestoneId,
  type OrderView,
  type ServerMessage,
  type ShopHenView,
  type UnlockId,
} from '@coys/shared';
import { num, type Db, type Queryable } from '../db/db';
import { migrate } from '../db/migrations';
import { decide, type BrainOptions, type DecisionResult } from '../agents/brain';
import type { FarmAction } from '../agents/decision';
import { henToken } from '../chain/batch';
import type { ChainWriter } from '../chain/chain';
import { arriveCards, buyBagsFrom, createCards, expireCards, farmCards, practiceCard, respondCard, type Candidate } from './cards';
import {
  applyDecision,
  bustIfBroke,
  buildContext,
  chargeForThinking,
  ensureCast,
  loyalistCreditQuote,
  openAgents,
  supplierQuote,
  turnOverStock,
  type CreateFarm,
} from './cast-runtime';
import { closeContracts, closeDebts, contractViews, debtViews, deliverContract } from './contracts';
import {
  ActionError,
  AGENT_COLUMNS,
  FARM_COLUMNS,
  moveCash,
  newId,
  spend,
  toAgent,
  toFarm,
  type Ctx,
  type Farm,
  type Outbound,
} from './ctx';
import { activeFarms, cancelOrder, emit, expireOrders, fillOrderAction, placeSellOrder, streetSell } from './market';
import { foundingCount, milestoneViews, nextMilestone, rollMilestones, standing } from './founding';
import { claimGoal, goalViews, markGoal, markToured, toured } from './goals';
import { conveyorCarry, hopperRefill, logMachine, logSale, machineDay } from './machines';
import { pick, randomSeed, seededRng, weighted, type Rng } from './rng';

export { ActionError } from './ctx';
export type { Outbound } from './ctx';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PlayerAction = DistributiveOmit<Exclude<ActionMessage, { t: 'linkWallet' | 'getLedger' }>, 'rid'>;

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
  /** In-game day length in ms (default ECONOMY.day.lengthMs; DEMO_DAY_SECONDS shortens it). */
  dayLengthMs?: number;
  /** GAME_SEASON. A fresh database takes it (or makes a dev season); an existing one must match. */
  season?: string | null;
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
  private readonly wantSeason: string | null;
  private readonly dayMs: number;
  /** The database's season, known after init(). */
  season = '';
  private readonly listeners = new Set<(out: Outbound) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private clock = { day: 1, dayStartedAt: 0 };
  private ticking = false;
  /** Decisions and calls per day, for reports and tests. */
  readonly stats = { decisions: 0, modelCalls: 0, fallbacks: 0, skipped: 0 };

  constructor(opts: GameOptions) {
    this.db = opts.db;
    this.chain = opts.chain;
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? seededRng(randomSeed());
    this.log = opts.log ?? ((line) => console.log(line));
    this.brain = { ...opts.brain, log: this.log };
    this.withCast = opts.cast ?? true;
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
        if (this.withCast) await ensureCast(ctx, this.createFarmFn);
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
    await this.serial(() =>
      this.inTx(async (ctx) => {
        await arriveCards(ctx);
        await conveyorCarry(ctx);
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

  async ensurePlayer(provider: 'privy' | 'dev', subject: string, displayName: string): Promise<{ playerId: string; farmId: string; name: string; created: boolean }> {
    return this.serial(() =>
      this.inTx(async (ctx) => {
        const [found] = await ctx.q.query<{ id: string; display_name: string; farm_id: string }>(
          `SELECT p.id, p.display_name, f.id AS farm_id FROM players p JOIN farms f ON f.player_id = p.id
           WHERE p.auth_provider = $1 AND p.auth_subject = $2`,
          [provider, subject],
        );
        if (found) return { playerId: found.id, farmId: found.farm_id, name: found.display_name, created: false };
        const playerId = newId();
        await ctx.q.query('INSERT INTO players (id, auth_provider, auth_subject, display_name, created_at) VALUES ($1, $2, $3, $4, $5)', [
          playerId,
          provider,
          subject,
          displayName,
          this.now(),
        ]);
        const s = ECONOMY.start;
        const farmId = await this.createFarm(ctx, { ownerKind: 'player', playerId, agentKey: null, name: `${displayName}'s Farm`, cash: s.cash, hens: s.hens, coops: [s.coop], feed: s.feed });
        ctx.marketChanged = true;
        return { playerId, farmId, name: displayName, created: true };
      }),
    );
  }

  async playerInfo(playerId: string): Promise<{ name: string; farmId: string } | null> {
    const [row] = await this.db.query<{ display_name: string; farm_id: string }>(
      'SELECT p.display_name, f.id AS farm_id FROM players p JOIN farms f ON f.player_id = p.id WHERE p.id = $1',
      [playerId],
    );
    return row ? { name: row.display_name, farmId: row.farm_id } : null;
  }

  private readonly createFarmFn: CreateFarm = (ctx, spec) => this.createFarm(ctx, { ...spec, playerId: null });

  private async createFarm(
    ctx: Ctx,
    spec: {
      ownerKind: 'player' | 'agent';
      playerId: string | null;
      agentKey: string | null;
      name: string;
      cash: number;
      hens: number;
      coops: readonly CoopKind[];
      feed: { tier: FeedTier; kg: number };
    },
  ): Promise<string> {
    const farmId = newId();
    await ctx.q.query(
      `INSERT INTO farms (id, owner_kind, player_id, agent_key, name, cash_milli, feed_tier, feed_${spec.feed.tier}_g, created_day)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
      [farmId, spec.ownerKind, spec.playerId, spec.agentKey, spec.name, spec.feed.tier, spec.feed.kg * 1000, ctx.day],
    );
    await moveCash(ctx, farmId, 'start', toMilli(spec.cash), 'opening balance');
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
      ...(h.chain_owner === undefined ? {} : { chainOwner: h.chain_owner ? String(h.chain_owner) : null }),
      ...(h.mint_tx === undefined ? {} : { mintTx: h.mint_tx ? String(h.mint_tx) : null, mintDay: h.mint_day === null ? null : num(h.mint_day) }),
      ...(h.founding_milestone
        ? { founding: { milestone: h.founding_milestone as MilestoneId, day: num(h.founding_day), number: h.founding_no === null ? null : num(h.founding_no) } }
        : {}),
    });
    const hens = await q.query(
      'SELECT id, body, eyes, comb, accessory, laying_trait, born_day, chain_owner, mint_tx, mint_day, founding_milestone, founding_day, founding_no FROM hens WHERE farm_id = $1 AND status = $2 ORDER BY born_day, id',
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
      unlocks,
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
      milestones: await milestoneViews(q, farmId),
      standing: await standing(q, farmId, Math.max(1, day - 1)),
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
      `SELECT o.id, o.side, o.grade, o.qty, o.filled_qty, o.price_milli, o.expires_day, o.farm_id, f.name AS farm_name, a.name AS agent_name
       FROM orders o LEFT JOIN farms f ON f.id = o.farm_id LEFT JOIN agents a ON a.id = o.agent_id
       WHERE o.status = 'open' AND o.kind = 'limit' AND ${where}
       ORDER BY o.side, CASE WHEN o.side = 'buy' THEN -o.price_milli ELSE o.price_milli END LIMIT 30`,
      params,
    );
    return rows.map((r) => ({
      id: String(r.id),
      side: r.side as 'buy' | 'sell',
      owner: String(r.farm_name ?? r.agent_name ?? 'Unknown'),
      ownerKind: r.farm_id ? 'player' : 'agent',
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
    const history = (await this.db.query('SELECT day, supply, multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 30'))
      .map((r): MarketDay => ({ day: num(r.day), supply: num(r.supply), multiplier: num(r.multiplier) }))
      .reverse();
    const reference = marketReference(await activeFarms(this.db));
    const counts = await this.db.query(`SELECT owner_kind, (bust_day IS NOT NULL) AS bust, count(*) AS n FROM farms GROUP BY owner_kind, (bust_day IS NOT NULL)`);
    const farms = { players: 0, agents: 0, bust: 0 };
    for (const c of counts) {
      if (c.bust) farms.bust += num(c.n);
      else if (c.owner_kind === 'agent') farms.agents += num(c.n);
      else farms.players += num(c.n);
    }
    const [settled] = await this.db.query('SELECT day, settlement_status, settlement_tx FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 1');
    const agentRows = await this.db.query(
      `SELECT a.*, f.cash_milli AS farm_cash, (SELECT count(*) FROM hens h WHERE h.farm_id = a.farm_id AND h.status = 'alive') AS hens
       FROM agents a LEFT JOIN farms f ON f.id = a.farm_id
       WHERE a.status = 'open' OR a.bust_day >= $1 ORDER BY a.kind, a.generation`,
      [day - 3],
    );
    const ranking = await this.db.query(
      `SELECT f.name, f.owner_kind, f.cash_milli, f.bust_day, a.kind AS agent_kind,
              (SELECT count(*) FROM hens h WHERE h.farm_id = f.id AND h.status = 'alive') AS hens
       FROM farms f LEFT JOIN agents a ON a.farm_id = f.id ORDER BY (f.bust_day IS NULL) DESC, f.cash_milli DESC LIMIT 12`,
    );
    const trades = await this.db.query('SELECT * FROM trades ORDER BY total_milli DESC, id DESC LIMIT 200');
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
      farms,
      settlement: settled
        ? { day: num(settled.day), status: settled.settlement_status as 'pending' | 'sent' | 'noop' | 'failed', txHash: (settled.settlement_tx as string | null) ?? null }
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
      })),
      book: await this.orderViews('true', [], null),
      trades: recentBig,
      ranking: ranking.map((r) => ({
        name: String(r.name),
        kind: r.owner_kind === 'agent' ? ((r.agent_kind as AgentKind) ?? 'upstart') : 'player',
        hens: num(r.hens),
        cashMilli: num(r.cash_milli),
        bust: r.bust_day !== null,
      })),
      explorer: this.chain.explorer,
      minting: this.chain.minting,
      founding: await foundingCount(this.db, this.chain.foundingMinted),
    };
  }

  async getLedger(farmId: string): Promise<LedgerDay[]> {
    const rows = await this.db.query(
      `SELECT l.day, l.kind, SUM(l.amount_milli) AS amount FROM ledger l WHERE l.farm_id = $1 AND l.day >= $2 GROUP BY l.day, l.kind ORDER BY l.day DESC`,
      [farmId, this.clock.day - 30],
    );
    const days = await this.db.query('SELECT day, settlement_status, settlement_tx FROM market_days WHERE day >= $1', [this.clock.day - 30]);
    const settle = new Map(days.map((d) => [num(d.day), { day: num(d.day), status: d.settlement_status as 'pending', txHash: (d.settlement_tx as string | null) ?? null }]));
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
    return this.serial(async () => {
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
        });
        return { ok: true, events: [] };
      } catch (err) {
        if (err instanceof ActionError) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    });
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
        if (unlocks.includes(action.unlock)) throw new ActionError('invalid_action', `${action.unlock} already bought`);
        const cost = toMilli(ECONOMY.unlocks[action.unlock].price);
        await spend(ctx, farm, 'unlock', cost, action.unlock);
        await ctx.q.query('INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, $2, $3)', [farm.id, action.unlock, ctx.day]);
        emit(ctx, farm, { kind: 'unlockBought', unlock: action.unlock, costMilli: cost });
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
        emit(ctx, farm, { kind: 'collected', eggId: action.eggId, grade });
        await markGoal(ctx.q, farm.id, 'collect');
        return;
      }
      default:
        throw new ActionError('invalid_action', 'unknown action');
    }
  };

  private async loadUnlocks(q: Queryable, farmId: string): Promise<UnlockId[]> {
    const rows = await q.query<{ unlock_id: string }>('SELECT unlock_id FROM unlocks WHERE farm_id = $1', [farmId]);
    return UNLOCK_IDS.filter((u) => rows.some((r) => r.unlock_id === u));
  }

  // ---- the day --------------------------------------------------------------------------------

  /** Dawn: the hens eat (active tier first) and each hen's laying builds up lay progress. */
  /**
   * A farm's feed purchase from its supplier (or the mill when none is open), with the hopper's
   * discount when it has one. With a cap it is the hopper buying on its own: it skips a price over
   * the cap, buys only what the farm can pay for, and returns what it bought (null for nothing).
   */
  private async buyFeedFor(ctx: Ctx, farm: Farm, tier: FeedTier, bags: number, unlocks: UnlockId[], capMilli: number | null): Promise<{ bags: number; unitMilli: number } | null> {
    const [h] = await ctx.q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farm.id]);
    const quote = await supplierQuote(ctx, farm, tier, num(h?.n));
    const unit = Math.round(quote.unitMilli * (unlocks.includes('hopper') ? 1 - ECONOMY.unlocks.hopper.feedCostDiscount : 1));
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

  /** Builds each open agent's context and asks its brain, before taking the lock. */
  private async gatherDecisions(): Promise<{ agentId: string; result: DecisionResult }[]> {
    if (!this.withCast) return [];
    const ctx = this.makeCtx(this.db);
    const agents = await openAgents(ctx);
    const history = (await this.db.query('SELECT day, supply, multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 7'))
      .map((r): MarketDay => ({ day: num(r.day), supply: num(r.supply), multiplier: num(r.multiplier) }))
      .reverse();
    const [today] = await this.db.query('SELECT supply, multiplier FROM market_days WHERE day = $1', [ctx.day]);
    history.push({ day: ctx.day, supply: num(today?.supply ?? 0), multiplier: num(today?.multiplier ?? 1) });
    const [auction] = await this.db.query(`SELECT count(*) AS n FROM hens WHERE status = 'auction'`);
    const out: { agentId: string; result: DecisionResult }[] = [];
    // one at a time keeps model calls polite; each is bounded by its own timeout
    for (const agent of agents) {
      const c = await buildContext(ctx, agent, history, num(auction?.n));
      const result = await decide(c, this.brain);
      out.push({ agentId: agent.id, result });
    }
    return out;
  }

  /**
   * Ends the day: collect eggs, deliver contracts, settle debts, close cards and orders, let every
   * agent act on its decision and pay for it, close bust agents, close the market on the day's
   * total supply, then open the next day with fresh cards and a fresh shop.
   */
  async endDay(): Promise<void> {
    const decisions = await this.gatherDecisions();
    const closedDay = await this.serial(async () => {
      let ctxOut: Ctx | null = null;
      const outcome = await this.db.tx(async (q) => {
        const ctx = this.makeCtx(q);
        ctxOut = ctx;
        const day = ctx.day;
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
        await expireCards(ctx);
        await expireOrders(ctx);
        // 3. the cast acts
        const acted: { agentId: string; result: DecisionResult }[] = [];
        for (const { agentId, result } of decisions) {
          const [row] = await q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 AND status = 'open'`, [agentId]);
          if (!row) continue;
          const agent = toAgent(row);
          await turnOverStock(ctx, agent);
          if (result.brain !== 'skipped') {
            await applyDecision(ctx, agent, result.decision, this.applyFarmAction, 'close');
            acted.push({ agentId, result });
            agent.lastBrain = result.brain;
            await chargeForThinking(ctx, agent);
          }
          this.stats.decisions += result.brain === 'skipped' ? 0 : 1;
          if (result.brain === 'nearai') this.stats.modelCalls++;
          if (result.fallback) this.stats.fallbacks++;
          if (result.brain === 'skipped') this.stats.skipped++;
          await q.query('UPDATE agents SET last_decided_day = $2, last_brain = $3 WHERE id = $1', [agent.id, day, result.brain]);
          await bustIfBroke(ctx, agent);
        }
        // 4. the market closes on the day's total supply, against demand from every active farm
        const [md] = await q.query('SELECT multiplier, supply FROM market_days WHERE day = $1', [day]);
        const supply = num(md?.supply ?? 0);
        const reference = marketReference(await activeFarms(q));
        const nextMultiplier = marketMultiplier(supply, reference);
        await q.query('UPDATE market_days SET closed_at = $2, next_multiplier = $3, reference = $4 WHERE day = $1', [day, ctx.now, nextMultiplier, reference]);
        // 4b. milestones: one auditable roll each, once, for player farms in good standing
        const rolls = await rollMilestones(ctx, this.chain.foundingMinted, async (farmId) => {
          const [henId] = await this.insertHens(ctx, farmId, 1);
          if (!henId) throw new Error('no hen inserted');
          return henId;
        });
        if (rolls.length) {
          const { remaining } = await foundingCount(q, this.chain.foundingMinted);
          for (const r of rolls) {
            if (!r.playerId) continue;
            const next = await nextMilestone(q, r.farmId);
            ctx.out.push({
              playerId: r.playerId,
              msg: { t: 'event', event: { kind: 'milestoneRoll', milestone: r.milestone, won: r.won, henId: r.henId, next, remaining, roll: r.roll, odds: ECONOMY.founding.odds } },
            });
          }
        }
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
        for (const f of await q.query<{ farm_id: string }>(`SELECT u.farm_id FROM unlocks u JOIN farms f ON f.id = u.farm_id WHERE u.unlock_id = 'hopper' AND f.bust_day IS NULL`)) {
          await hopperRefill(ctx, f.farm_id, (c, farm, tier, bags, cap) => this.buyFeedFor(c, farm, tier, bags, ['hopper'], cap));
        }
        const plans = new Map<string, { feedGramsUsed: number; fedMultiplier: number }>();
        for (const f of await q.query<{ id: string }>('SELECT id FROM farms WHERE bust_day IS NULL')) plans.set(f.id, await this.planFarmDay(q, f.id, newDay));
        await q.query('DELETE FROM lay_events WHERE day < $1', [newDay - 1]);
        await this.refreshShop(ctx);
        if (this.withCast) await ensureCast(ctx, this.createFarmFn);
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

    const result = await this.chain.settleDay(this.db, this.season, closedDay);
    await this.db.query('UPDATE market_days SET settlement_status = $3, settlement_tx = $4, settlement_error = $5 WHERE season = $1 AND day = $2', [
      this.season,
      closedDay,
      result.status,
      result.txHash,
      result.error ?? null,
    ]);
    if (result.status === 'sent' && result.txHash && result.minted?.length) await this.announceMints(result.minted, result.txHash, closedDay, result.numbers);
    this.emit(null, { t: 'market', market: await this.getMarketState() });
  }

  /** Each minted Founding Hen's owner hears about it (the certificate moment) and gets the hen's new card. */
  private async announceMints(henIds: string[], txHash: string, day: number, numbers?: Map<string, number>): Promise<void> {
    const rows = await this.db.query<{ id: string; chain_owner: string; farm_id: string; player_id: string | null; founding_milestone: string | null }>(
      `SELECT h.id, h.chain_owner, h.farm_id, f.player_id, h.founding_milestone FROM hens h JOIN farms f ON f.id = h.farm_id WHERE h.id = ANY($1::text[]) AND f.owner_kind = 'player'`,
      [henIds],
    );
    const farms = new Map<string, string>();
    for (const r of rows) {
      if (!r.player_id) continue;
      farms.set(String(r.farm_id), String(r.player_id));
      const id = String(r.id);
      this.emit(String(r.player_id), {
        t: 'event',
        event: {
          kind: 'henMinted',
          henId: id,
          token: henToken(id, true),
          owner: String(r.chain_owner),
          txHash,
          day,
          number: numbers?.get(id) ?? null,
          milestone: (r.founding_milestone as MilestoneId | null) ?? null,
        },
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

