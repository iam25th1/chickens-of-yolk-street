// The authoritative game. Every price, balance and outcome is computed here from ECONOMY and the
// database; clients only ask for actions. Mutations run one at a time (serial) inside database
// transactions, so a crash mid-action leaves nothing half-applied.
import { randomUUID } from 'node:crypto';
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
  emptyEggStock,
  emptyFeedStock,
  feedBagPrice,
  feedGramsPerHenDay,
  gradeForRoll,
  henLayingRate,
  isCrash,
  marketMultiplier,
  nextCoopKind,
  saleValue,
  toMilli,
  type ActionMessage,
  type ClockState,
  type CoopKind,
  type DaySummary,
  type EggGrade,
  type EggStock,
  type ErrorCode,
  type FarmState,
  type FeedStock,
  type FeedTier,
  type GameEvent,
  type HenView,
  type MarketDay,
  type MarketState,
  type ServerMessage,
  type UnlockId,
} from '@coys/shared';
import { num, type Db, type Queryable } from '../db/db';
import { migrate } from '../db/migrations';
import { settlementDigest, type SettlementPayload, type SettlementWriter } from '../chain/settlement';
import { HeuristicBrain, RIVALS, type AgentAction, type AgentBrain, type AgentView, type RivalSpec } from './agents';
import { pick, randomSeed, seededRng, weighted, type Rng } from './rng';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A farm action without its request id. Players send these over the wire; agents produce them. */
export type FarmAction = DistributiveOmit<Exclude<ActionMessage, { t: 'linkWallet' }>, 'rid'> | AgentAction;

export type Outbound = { playerId: string | null; msg: ServerMessage };
export type ActionResult = { ok: true; events: GameEvent[] } | { ok: false; code: ErrorCode; message: string };

export class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Cosmetic odds for new hens. The laying trait range is economy and lives in ECONOMY. */
const HEN_LOOK_ODDS = {
  eyes: { default: 60, sleepy: 20, wild: 20 },
  comb: { default: 55, spiky: 15, mohawk: 15, nub: 15 },
  accessory: { none: 70, tophat: 10, bowtie: 10, shades: 10 },
} as const;

export interface GameOptions {
  db: Db;
  settlement: SettlementWriter;
  now?: () => number;
  rng?: Rng;
  rivals?: readonly RivalSpec[];
  brainFor?: (rival: RivalSpec) => AgentBrain;
  log?: (line: string) => void;
}

interface Farm {
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
}

const FARM_COLUMNS = `id, owner_kind, player_id, agent_key, name, cash_milli, feed_tier, feed_cheap_g, feed_standard_g,
  feed_premium_g, fed_multiplier, crate_white, crate_cream, crate_brown, crate_golden, bust_day`;

function toFarm(r: Record<string, unknown>): Farm {
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
  };
}

const sumStock = (s: Partial<Record<string, number>>): number => Object.values(s).reduce<number>((a, b) => a + (b ?? 0), 0);

export class Game {
  private readonly db: Db;
  private readonly settlement: SettlementWriter;
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly rivals: readonly RivalSpec[];
  private readonly brains = new Map<string, AgentBrain>();
  private readonly log: (line: string) => void;
  private readonly listeners = new Set<(out: Outbound) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private clock = { day: 1, dayStartedAt: 0 };
  private ticking = false;

  constructor(opts: GameOptions) {
    this.db = opts.db;
    this.settlement = opts.settlement;
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? seededRng(randomSeed());
    this.rivals = opts.rivals ?? RIVALS;
    this.log = opts.log ?? ((line) => console.log(line));
    for (const r of this.rivals) this.brains.set(r.key, opts.brainFor?.(r) ?? new HeuristicBrain());
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async init(): Promise<void> {
    const applied = await migrate(this.db);
    if (applied.length) this.log(`[db] applied migrations ${applied.join(', ')} (${this.db.kind})`);
    const rows = await this.db.query('SELECT day, day_started_at FROM game_clock WHERE id = 1');
    if (!rows.length) {
      await this.db.tx(async (q) => {
        await q.query('INSERT INTO game_clock (id, day, day_started_at) VALUES (1, 1, $1)', [this.now()]);
        await q.query('INSERT INTO market_days (day, multiplier) VALUES (1, $1)', [ECONOMY.market.openingMultiplier]);
      });
    }
    const [clock] = await this.db.query('SELECT day, day_started_at FROM game_clock WHERE id = 1');
    this.clock = { day: num(clock?.day), dayStartedAt: num(clock?.day_started_at) };
    for (const rival of this.rivals) await this.ensureRival(rival);
  }

  on(listener: (out: Outbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(playerId: string | null, msg: ServerMessage): void {
    for (const l of this.listeners) l({ playerId, msg });
  }

  /** Runs mutations one at a time, in arrival order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  getClock(): ClockState {
    return { day: this.clock.day, dayStartedAt: this.clock.dayStartedAt, dayLengthMs: ECONOMY.day.lengthMs, serverNow: this.now() };
  }

  /** Called on an interval; ends the day once its time is up. */
  async tickIfDue(): Promise<boolean> {
    if (this.ticking || this.now() < this.clock.dayStartedAt + ECONOMY.day.lengthMs) return false;
    this.ticking = true;
    try {
      await this.endDay();
      return true;
    } finally {
      this.ticking = false;
    }
  }

  // ---- players --------------------------------------------------------------------------------

  async ensurePlayer(
    provider: 'privy' | 'dev',
    subject: string,
    displayName: string,
  ): Promise<{ playerId: string; farmId: string; name: string; created: boolean }> {
    return this.serial(() =>
      this.db.tx(async (q) => {
        const [found] = await q.query<{ id: string; display_name: string; farm_id: string }>(
          `SELECT p.id, p.display_name, f.id AS farm_id FROM players p JOIN farms f ON f.player_id = p.id
           WHERE p.auth_provider = $1 AND p.auth_subject = $2`,
          [provider, subject],
        );
        if (found) return { playerId: found.id, farmId: found.farm_id, name: found.display_name, created: false };
        const playerId = randomUUID();
        await q.query(
          'INSERT INTO players (id, auth_provider, auth_subject, display_name, created_at) VALUES ($1, $2, $3, $4, $5)',
          [playerId, provider, subject, displayName, this.now()],
        );
        const s = ECONOMY.start;
        const farmId = await this.createFarm(q, {
          ownerKind: 'player',
          playerId,
          agentKey: null,
          name: `${displayName}'s Farm`,
          cash: s.cash,
          hens: s.hens,
          coops: [s.coop],
          feed: s.feed,
        });
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

  private async ensureRival(rival: RivalSpec): Promise<void> {
    await this.serial(() =>
      this.db.tx(async (q) => {
        const [found] = await q.query('SELECT id FROM farms WHERE agent_key = $1', [rival.key]);
        if (found) return;
        await this.createFarm(q, {
          ownerKind: 'agent',
          playerId: null,
          agentKey: rival.key,
          name: rival.name,
          cash: rival.start.cash,
          hens: rival.start.hens,
          coops: rival.start.coops,
          feed: rival.start.feed,
        });
        this.log(`[agents] ${rival.name} opened with ${rival.start.hens} hens`);
      }),
    );
  }

  private async createFarm(
    q: Queryable,
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
    const day = this.clock.day;
    const farmId = randomUUID();
    await q.query(
      `INSERT INTO farms (id, owner_kind, player_id, agent_key, name, cash_milli, feed_tier, feed_${spec.feed.tier}_g, created_day)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
      [farmId, spec.ownerKind, spec.playerId, spec.agentKey, spec.name, spec.feed.tier, spec.feed.kg * 1000, day],
    );
    await this.moveCash(q, farmId, 'start', toMilli(spec.cash), 'opening balance');
    for (const [plot, kind] of spec.coops.entries()) {
      await q.query('INSERT INTO coops (id, farm_id, kind, plot, built_day) VALUES ($1, $2, $3, $4, $5)', [
        randomUUID(),
        farmId,
        kind,
        plot,
        day,
      ]);
    }
    await this.insertNewHens(q, farmId, spec.hens);
    await this.planFarmDay(q, farmId, day);
    return farmId;
  }

  // ---- state views ----------------------------------------------------------------------------

  async getFarmState(farmId: string): Promise<FarmState> {
    const q = this.db;
    const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [farmId]);
    if (!row) throw new ActionError('not_found', 'farm not found');
    const farm = toFarm(row);
    const day = this.clock.day;
    const hens = await q.query<Record<string, unknown>>(
      `SELECT id, body, eyes, comb, accessory, laying_trait, born_day FROM hens
       WHERE farm_id = $1 AND status = 'alive' ORDER BY born_day, id`,
      [farmId],
    );
    const coops = await q.query<Record<string, unknown>>('SELECT id, kind, plot FROM coops WHERE farm_id = $1 ORDER BY plot', [farmId]);
    const unlocks = await this.loadUnlocks(q, farmId);
    const eggs = await q.query<Record<string, unknown>>(
      'SELECT id, hen_id, at_ms, grade, broken, collected FROM lay_events WHERE farm_id = $1 AND day = $2 ORDER BY at_ms',
      [farmId, day],
    );
    return {
      farmId,
      name: farm.name,
      cashMilli: farm.cashMilli,
      feedTier: farm.feedTier,
      feedGrams: farm.feed,
      fedToday: farm.fedMultiplier,
      hens: hens.map(
        (h): HenView => ({
          id: String(h.id),
          body: h.body as HenView['body'],
          eyes: h.eyes as HenView['eyes'],
          comb: h.comb as HenView['comb'],
          accessory: h.accessory as HenView['accessory'],
          layingTrait: num(h.laying_trait),
          ageDays: day - num(h.born_day),
        }),
      ),
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
    };
  }

  async getMarketState(): Promise<MarketState> {
    const day = this.clock.day;
    const [today] = await this.db.query('SELECT multiplier, supply FROM market_days WHERE day = $1', [day]);
    const multiplier = num(today?.multiplier ?? ECONOMY.market.openingMultiplier);
    const history = (
      await this.db.query(
        'SELECT day, supply, multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 30',
      )
    )
      .map((r): MarketDay => ({ day: num(r.day), supply: num(r.supply), multiplier: num(r.multiplier) }))
      .reverse();
    const counts = await this.db.query(
      `SELECT owner_kind, (bust_day IS NOT NULL) AS bust, count(*) AS n FROM farms GROUP BY owner_kind, (bust_day IS NOT NULL)`,
    );
    const farms = { players: 0, agents: 0, bust: 0 };
    for (const c of counts) {
      if (c.bust) farms.bust += num(c.n);
      else if (c.owner_kind === 'agent') farms.agents += num(c.n);
      else farms.players += num(c.n);
    }
    const [settled] = await this.db.query(
      'SELECT day, settlement_status, settlement_tx FROM market_days WHERE closed_at IS NOT NULL ORDER BY day DESC LIMIT 1',
    );
    return {
      day,
      multiplier,
      pricesMilli: Object.fromEntries(EGG_GRADES.map((g) => [g, toMilli(eggPrice(g, multiplier, []))])) as Record<EggGrade, number>,
      supplyToday: num(today?.supply ?? 0),
      crash: isCrash(multiplier),
      history,
      farms,
      settlement: settled
        ? {
            day: num(settled.day),
            status: settled.settlement_status as 'pending' | 'sent' | 'noop' | 'failed',
            txHash: (settled.settlement_tx as string | null) ?? null,
          }
        : null,
    };
  }

  // ---- actions --------------------------------------------------------------------------------

  /** Validates and applies one player action. Never trusts a client value beyond the action's choice. */
  async act(playerId: string, action: ActionMessage): Promise<ActionResult> {
    return this.serial(async () => {
      let farmId: string | null = null;
      let events: GameEvent[];
      try {
        events = await this.db.tx(async (q) => {
          if (action.t === 'linkWallet') {
            const [p] = await q.query<{ near_account_id: string | null }>('SELECT near_account_id FROM players WHERE id = $1', [playerId]);
            if (!p) throw new ActionError('not_found', 'player not found');
            if (p.near_account_id && p.near_account_id !== action.accountId) throw new ActionError('invalid_action', 'already linked');
            await q.query('UPDATE players SET near_account_id = $2 WHERE id = $1', [playerId, action.accountId]);
            return [];
          }
          const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE player_id = $1`, [playerId]);
          if (!row) throw new ActionError('not_found', 'farm not found');
          const farm = toFarm(row);
          farmId = farm.id;
          const { rid: _rid, ...farmAction } = action;
          return this.applyAction(q, farm, farmAction as FarmAction);
        });
      } catch (err) {
        if (err instanceof ActionError) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
      if (farmId) {
        this.emit(playerId, { t: 'farm', farm: await this.getFarmState(farmId) });
        for (const event of events) this.emit(playerId, { t: 'event', event });
        if (action.t === 'sell') this.emit(null, { t: 'market', market: await this.getMarketState() });
      }
      return { ok: true, events };
    });
  }

  private async applyAction(q: Queryable, farm: Farm, action: FarmAction): Promise<GameEvent[]> {
    if (farm.bustDay !== null) throw new ActionError('farm_bust', 'this farm is bust');
    const day = this.clock.day;
    const unlocks = await this.loadUnlocks(q, farm.id);
    switch (action.t) {
      case 'buyHens': {
        const henMilli = toMilli(ECONOMY.hen.price);
        const auctionMilli = toMilli(ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor);
        const auction = await q.query<{ id: string }>(
          `SELECT id FROM hens WHERE status = 'auction' ORDER BY id LIMIT $1`,
          [action.count],
        );
        const fresh = action.count - auction.length;
        const cost = auction.length * auctionMilli + fresh * henMilli;
        await this.spend(q, farm, 'hens', cost, `${action.count} hens`);
        if (auction.length) {
          await q.query(`UPDATE hens SET status = 'alive', farm_id = $1, lay_progress = 0 WHERE id = ANY($2::text[])`, [
            farm.id,
            auction.map((h) => h.id),
          ]);
        }
        await this.insertNewHens(q, farm.id, fresh);
        return [{ kind: 'hensBought', count: action.count, fromAuction: auction.length, costMilli: cost }];
      }
      case 'buyFeed': {
        const cost = toMilli(feedBagPrice(action.tier, unlocks)) * action.bags;
        await this.spend(q, farm, 'feed', cost, `${action.bags} ${action.tier} bags`);
        await q.query(`UPDATE farms SET feed_${action.tier}_g = feed_${action.tier}_g + $2 WHERE id = $1`, [
          farm.id,
          action.bags * ECONOMY.feed.bagKg * 1000,
        ]);
        return [{ kind: 'feedBought', tier: action.tier, bags: action.bags, costMilli: cost }];
      }
      case 'setFeedTier': {
        await q.query('UPDATE farms SET feed_tier = $2 WHERE id = $1', [farm.id, action.tier]);
        return [];
      }
      case 'buildCoop': {
        const used = new Set((await q.query<{ plot: number }>('SELECT plot FROM coops WHERE farm_id = $1', [farm.id])).map((r) => num(r.plot)));
        let plot = -1;
        for (let p = 0; p < ECONOMY.coops.plots; p++) if (!used.has(p)) { plot = p; break; }
        if (plot < 0) throw new ActionError('invalid_action', 'no free coop plot');
        const cost = toMilli(ECONOMY.coops.kinds[action.kind].price);
        await this.spend(q, farm, 'coop', cost, `build ${action.kind}`);
        const coopId = randomUUID();
        await q.query('INSERT INTO coops (id, farm_id, kind, plot, built_day) VALUES ($1, $2, $3, $4, $5)', [coopId, farm.id, action.kind, plot, day]);
        return [{ kind: 'coopBuilt', coopId, coopKind: action.kind, plot, costMilli: cost }];
      }
      case 'upgradeCoop': {
        const [coop] = await q.query<{ kind: CoopKind }>('SELECT kind FROM coops WHERE id = $1 AND farm_id = $2', [action.coopId, farm.id]);
        if (!coop) throw new ActionError('not_found', 'coop not found');
        const next = nextCoopKind(coop.kind);
        if (!next) throw new ActionError('invalid_action', 'coop is already the biggest kind');
        const cost = toMilli(coopUpgradeCost(coop.kind, next));
        await this.spend(q, farm, 'coop', cost, `upgrade to ${next}`);
        await q.query('UPDATE coops SET kind = $2 WHERE id = $1', [action.coopId, next]);
        return [{ kind: 'coopUpgraded', coopId: action.coopId, coopKind: next, costMilli: cost }];
      }
      case 'buyUnlock': {
        if (unlocks.includes(action.unlock)) throw new ActionError('invalid_action', `${action.unlock} already bought`);
        const cost = toMilli(ECONOMY.unlocks[action.unlock].price);
        await this.spend(q, farm, 'unlock', cost, action.unlock);
        await q.query('INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, $2, $3)', [farm.id, action.unlock, day]);
        return [{ kind: 'unlockBought', unlock: action.unlock, costMilli: cost }];
      }
      case 'sell':
        return [await this.sell(q, farm, action.items, unlocks)];
      case 'collect': {
        const [egg] = await q.query<Record<string, unknown>>(
          'SELECT grade, at_ms, broken, collected FROM lay_events WHERE id = $1 AND farm_id = $2 AND day = $3',
          [action.eggId, farm.id, day],
        );
        if (!egg) throw new ActionError('not_found', 'egg not found');
        if (num(egg.at_ms) > this.now() - this.clock.dayStartedAt) throw new ActionError('invalid_action', 'egg not laid yet');
        if (egg.broken) throw new ActionError('invalid_action', 'egg is broken');
        if (egg.collected) throw new ActionError('invalid_action', 'egg already collected');
        const grade = egg.grade as EggGrade;
        await q.query('UPDATE lay_events SET collected = true WHERE id = $1', [action.eggId]);
        await q.query(`UPDATE farms SET crate_${grade} = crate_${grade} + 1 WHERE id = $1`, [farm.id]);
        return [{ kind: 'collected', eggId: action.eggId, grade }];
      }
    }
  }

  /** Market sell: fills at once at today's live multiplier, computed here, never sent by a client. */
  private async sell(q: Queryable, farm: Farm, items: Partial<EggStock>, unlocks: UnlockId[]): Promise<GameEvent> {
    const sold = emptyEggStock();
    for (const g of EGG_GRADES) {
      const n = items[g] ?? 0;
      if (n > farm.crate[g]) throw new ActionError('insufficient_stock', `only ${farm.crate[g]} ${g} eggs in the crate`);
      sold[g] = n;
    }
    const qty = sumStock(sold);
    if (qty <= 0) throw new ActionError('invalid_action', 'nothing to sell');
    const day = this.clock.day;
    const [md] = await q.query('SELECT multiplier FROM market_days WHERE day = $1', [day]);
    const multiplier = num(md?.multiplier ?? ECONOMY.market.openingMultiplier);
    const totalMilli = toMilli(saleValue(sold, multiplier, unlocks));
    const dealId = randomUUID();
    const now = this.now();
    for (const g of EGG_GRADES) {
      if (!sold[g]) continue;
      await q.query(`UPDATE farms SET crate_${g} = crate_${g} - $2 WHERE id = $1`, [farm.id, sold[g]]);
      await q.query(
        `INSERT INTO orders (id, deal_id, farm_id, day, side, kind, grade, qty, price_milli, status, created_at)
         VALUES ($1, $2, $3, $4, 'sell', 'market', $5, $6, $7, 'filled', $8)`,
        [randomUUID(), dealId, farm.id, day, g, sold[g], toMilli(eggPrice(g, multiplier, unlocks)), now],
      );
    }
    await this.moveCash(q, farm.id, 'sale', totalMilli, dealId);
    await q.query('UPDATE market_days SET supply = supply + $2 WHERE day = $1', [day, qty]);
    return { kind: 'sold', items: sold, totalMilli, multiplier };
  }

  private async spend(q: Queryable, farm: Farm, kind: string, costMilli: number, ref: string): Promise<void> {
    if (costMilli > farm.cashMilli) throw new ActionError('insufficient_funds', `costs ${costMilli / 1000}, cash is ${farm.cashMilli / 1000}`);
    await this.moveCash(q, farm.id, kind, -costMilli, ref);
    farm.cashMilli -= costMilli;
  }

  /** The only way cash changes: the farm balance and its ledger row move together. */
  private async moveCash(q: Queryable, farmId: string, kind: string, amountMilli: number, ref: string): Promise<void> {
    await q.query('UPDATE farms SET cash_milli = cash_milli + $2 WHERE id = $1', [farmId, amountMilli]);
    await q.query('INSERT INTO ledger (farm_id, day, kind, amount_milli, ref, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      farmId,
      this.clock.day,
      kind,
      amountMilli,
      ref,
      this.now(),
    ]);
  }

  private async loadUnlocks(q: Queryable, farmId: string): Promise<UnlockId[]> {
    const rows = await q.query<{ unlock_id: string }>('SELECT unlock_id FROM unlocks WHERE farm_id = $1', [farmId]);
    return UNLOCK_IDS.filter((u) => rows.some((r) => r.unlock_id === u));
  }

  private async insertNewHens(q: Queryable, farmId: string, count: number): Promise<void> {
    if (count <= 0) return;
    const { min, max } = ECONOMY.hen.trait;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let i = 0; i < count; i++) {
      const b = values.length;
      rows.push(`($${b + 1}, $${b + 2}, 'alive', $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`);
      values.push(
        randomUUID(),
        farmId,
        pick(this.rng, BODY_COLOURS),
        weighted(this.rng, HEN_LOOK_ODDS.eyes),
        weighted(this.rng, HEN_LOOK_ODDS.comb),
        weighted(this.rng, HEN_LOOK_ODDS.accessory),
        Math.round((min + this.rng() * (max - min)) * 1000) / 1000,
        this.clock.day,
        // A random head start staggers laying, so a new flock lays on its first day.
        this.rng(),
      );
    }
    await q.query(
      `INSERT INTO hens (id, farm_id, status, body, eyes, comb, accessory, laying_trait, born_day, lay_progress) VALUES ${rows.join(', ')}`,
      values,
    );
  }

  // ---- the day --------------------------------------------------------------------------------

  /**
   * Plans a farm's day at dawn: the hens eat from the trough (active tier first), and each hen's
   * laying rate builds up lay progress; every whole egg becomes a timed lay event.
   */
  private async planFarmDay(q: Queryable, farmId: string, day: number): Promise<{ feedGramsUsed: number; fedMultiplier: number }> {
    const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [farmId]);
    if (!row) throw new Error(`farm ${farmId} missing`);
    const farm = toFarm(row);
    const hens = await q.query<Record<string, unknown>>(
      `SELECT id, laying_trait, born_day, lay_progress FROM hens WHERE farm_id = $1 AND status = 'alive' ORDER BY id`,
      [farmId],
    );
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
    const fedMultiplier =
      need > 0 ? FEED_TIERS.reduce((s, t) => s + used[t] * ECONOMY.feed.tiers[t].laying, 0) / need : 0;
    const gradeTier = FEED_TIERS.reduce((best, t) => (used[t] > used[best] || (used[t] === used[best] && t === farm.feedTier) ? t : best), farm.feedTier);
    await q.query(
      `UPDATE farms SET feed_cheap_g = feed_cheap_g - $2, feed_standard_g = feed_standard_g - $3,
       feed_premium_g = feed_premium_g - $4, fed_multiplier = $5 WHERE id = $1`,
      [farmId, used.cheap, used.standard, used.premium, fedMultiplier],
    );

    const crowding = crowdingFactor(hens.length, coopCapacity(kinds));
    const breakage = breakageRate(unlocks);
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
        const atMs = Math.floor((start + this.rng() * (end - start)) * ECONOMY.day.lengthMs);
        eggs.push([randomUUID(), farmId, String(h.id), day, atMs, gradeForRoll(gradeTier, this.rng()), this.rng() < breakage]);
      }
    }
    if (ids.length) {
      await q.query(
        'UPDATE hens SET lay_progress = v.p FROM unnest($1::text[], $2::float8[]) AS v(id, p) WHERE hens.id = v.id',
        [ids, progress],
      );
    }
    for (let i = 0; i < eggs.length; i += 400) {
      const chunk = eggs.slice(i, i + 400);
      const values: unknown[] = [];
      const rows = chunk.map((e) => {
        const b = values.length;
        values.push(...e);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
      });
      await q.query(`INSERT INTO lay_events (id, farm_id, hen_id, day, at_ms, grade, broken) VALUES ${rows.join(', ')}`, values);
    }
    return { feedGramsUsed, fedMultiplier };
  }

  private async agentViews(): Promise<{ rival: RivalSpec; view: AgentView }[]> {
    const out: { rival: RivalSpec; view: AgentView }[] = [];
    const market = await this.getMarketState();
    for (const rival of this.rivals) {
      const [row] = await this.db.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE agent_key = $1`, [rival.key]);
      if (!row) continue;
      const farm = toFarm(row);
      if (farm.bustDay !== null) continue;
      const [h] = await this.db.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farm.id]);
      const kinds = (await this.db.query<{ kind: CoopKind }>('SELECT kind FROM coops WHERE farm_id = $1', [farm.id])).map((c) => c.kind);
      out.push({
        rival,
        view: {
          farmId: farm.id,
          key: rival.key,
          name: rival.name,
          day: this.clock.day,
          cash: farm.cashMilli / 1000,
          hens: num(h?.n),
          capacity: coopCapacity(kinds),
          freePlots: ECONOMY.coops.plots - kinds.length,
          crate: farm.crate,
          feedGrams: farm.feed,
          feedTier: farm.feedTier,
          unlocks: await this.loadUnlocks(this.db, farm.id),
          multiplier: market.multiplier,
          history: market.history.slice(-7),
          style: rival.style,
        },
      });
    }
    return out;
  }

  /**
   * Ends the day: collect every laid egg, let each agent make its one decision, close the market
   * on the day's total supply, record the settlement batch, then start the next day at dawn.
   */
  async endDay(): Promise<void> {
    // Agent decisions may call NEAR AI Cloud, so they are gathered before taking the lock.
    const views = await this.agentViews();
    const decisions = await Promise.all(
      views.map(async ({ rival, view }) => {
        const brain = this.brains.get(rival.key) ?? new HeuristicBrain();
        const actions = await brain.decide(view).catch(() => [] as AgentAction[]);
        return { rival, farmId: view.farmId, brain: brain.kind, actions };
      }),
    );

    const closed = await this.serial(async () => {
      const day = this.clock.day;
      const now = this.now();
      const outcome = await this.db.tx(async (q) => {
        const collected = new Map<string, number>();
        const pending = await q.query<Record<string, unknown>>(
          `SELECT farm_id, grade, count(*) AS n FROM lay_events WHERE day = $1 AND NOT collected AND NOT broken GROUP BY farm_id, grade`,
          [day],
        );
        for (const p of pending) {
          const grade = p.grade as EggGrade;
          await q.query(`UPDATE farms SET crate_${grade} = crate_${grade} + $2 WHERE id = $1`, [p.farm_id, num(p.n)]);
          collected.set(String(p.farm_id), (collected.get(String(p.farm_id)) ?? 0) + num(p.n));
        }
        await q.query('UPDATE lay_events SET collected = true WHERE day = $1 AND NOT collected AND NOT broken', [day]);
        const laid = new Map<string, { laid: number; broken: number }>();
        for (const r of await q.query<Record<string, unknown>>(
          'SELECT farm_id, count(*) AS laid, sum(CASE WHEN broken THEN 1 ELSE 0 END) AS broken FROM lay_events WHERE day = $1 GROUP BY farm_id',
          [day],
        )) {
          laid.set(String(r.farm_id), { laid: num(r.laid), broken: num(r.broken) });
        }

        const busts: { name: string; hens: number }[] = [];
        for (const d of decisions) {
          for (const action of d.actions) {
            const [row] = await q.query(`SELECT ${FARM_COLUMNS} FROM farms WHERE id = $1`, [d.farmId]);
            if (!row) break;
            try {
              await this.applyAction(q, toFarm(row), action);
            } catch (err) {
              if (!(err instanceof ActionError)) throw err;
              this.log(`[agents] ${d.rival.key} ${action.t} rejected: ${err.message}`);
            }
          }
          const cost = toMilli(ECONOMY.agents.inferenceCostPerDecision * ECONOMY.agents.decisionsPerDay);
          await this.moveCash(q, d.farmId, 'inference', -cost, d.brain);
          const [after] = await q.query<{ cash_milli: unknown }>('SELECT cash_milli FROM farms WHERE id = $1', [d.farmId]);
          if (num(after?.cash_milli) < toMilli(ECONOMY.agents.bustBelowCash)) {
            const hens = await q.query(
              `UPDATE hens SET status = 'auction', farm_id = NULL WHERE farm_id = $1 AND status = 'alive' RETURNING id`,
              [d.farmId],
            );
            await q.query('UPDATE farms SET bust_day = $2 WHERE id = $1', [d.farmId, day]);
            busts.push({ name: d.rival.name, hens: hens.length });
            this.log(`[agents] ${d.rival.name} is bust on day ${day}; ${hens.length} hens go to auction`);
          }
        }

        const [md] = await q.query('SELECT multiplier, supply FROM market_days WHERE day = $1', [day]);
        const supply = num(md?.supply ?? 0);
        const multiplier = num(md?.multiplier ?? ECONOMY.market.openingMultiplier);
        const nextMultiplier = marketMultiplier(supply);
        const nets = await q.query<Record<string, unknown>>(
          `SELECT f.id, f.owner_kind, p.near_account_id, COALESCE(SUM(l.amount_milli), 0) AS net
           FROM farms f LEFT JOIN players p ON p.id = f.player_id LEFT JOIN ledger l ON l.farm_id = f.id AND l.day = $1
           GROUP BY f.id, f.owner_kind, p.near_account_id ORDER BY f.id`,
          [day],
        );
        const farms = nets.map((n) => ({
          farm: String(n.id),
          owner: n.owner_kind === 'agent' ? ('agent' as const) : ('player' as const),
          account: (n.near_account_id as string | null) ?? null,
          netMilli: num(n.net),
        }));
        const payload: SettlementPayload = {
          game: 'chickens-of-yolk-street',
          v: 1,
          day,
          closedAt: now,
          supply,
          multiplier,
          nextMultiplier,
          farms,
          digest: settlementDigest(farms),
        };
        await q.query('UPDATE market_days SET closed_at = $2, next_multiplier = $3, settlement_payload = $4 WHERE day = $1', [
          day,
          now,
          nextMultiplier,
          JSON.stringify(payload),
        ]);

        const newDay = day + 1;
        let start = this.clock.dayStartedAt + ECONOMY.day.lengthMs;
        if (now - start > ECONOMY.day.lengthMs) start = now; // after downtime, start fresh instead of replaying days
        await q.query('UPDATE game_clock SET day = $1, day_started_at = $2 WHERE id = 1', [newDay, start]);
        await q.query('INSERT INTO market_days (day, multiplier) VALUES ($1, $2)', [newDay, nextMultiplier]);
        this.clock = { day: newDay, dayStartedAt: start };

        const plans = new Map<string, { feedGramsUsed: number; fedMultiplier: number }>();
        for (const f of await q.query<{ id: string }>('SELECT id FROM farms WHERE bust_day IS NULL')) {
          plans.set(f.id, await this.planFarmDay(q, f.id, newDay));
        }
        await q.query('DELETE FROM lay_events WHERE day < $1', [newDay - 1]);
        return { day, supply, nextMultiplier, payload, collected, laid, plans, busts };
      });

      const players = await this.db.query<{ id: string; player_id: string }>(
        `SELECT id, player_id FROM farms WHERE owner_kind = 'player'`,
      );
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
        };
        this.emit(p.player_id, { t: 'event', event: { kind: 'dayEnded', summary } });
        this.emit(p.player_id, { t: 'farm', farm: await this.getFarmState(p.id) });
      }
      for (const b of outcome.busts) this.emit(null, { t: 'event', event: { kind: 'rivalBust', name: b.name, hens: b.hens } });
      this.emit(null, { t: 'clock', clock: this.getClock() });
      this.emit(null, { t: 'market', market: await this.getMarketState() });
      this.log(
        `[day] ${outcome.day} closed: supply ${outcome.supply}, next multiplier ${outcome.nextMultiplier.toFixed(3)}; day ${this.clock.day} begins`,
      );
      return outcome;
    });

    const result = await this.settlement.write(closed.payload);
    await this.db.query('UPDATE market_days SET settlement_status = $2, settlement_tx = $3 WHERE day = $1', [
      closed.day,
      result.status,
      result.txHash,
    ]);
    this.emit(null, { t: 'market', market: await this.getMarketState() });
  }

  /** Ledger total for a farm, for audits and tests: always equals the farm's cash. */
  async ledgerTotal(farmId: string): Promise<number> {
    const [r] = await this.db.query('SELECT COALESCE(SUM(amount_milli), 0) AS s FROM ledger WHERE farm_id = $1', [farmId]);
    return num(r?.s);
  }
}
