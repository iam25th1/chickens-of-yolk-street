// Builds one day's settlement for the game contract, keyed by (season, day).
//
// The full settlement (every farm's net result, every egg move, every Feather minted with its card
// image's hash) is kept in the game's database; its SHA-256 is the digest the chain stores in the
// season's head. The call itself carries only what moves tokens: the egg moves, the net totals of
// the farms whose eggs move, and the day's Feathers.
//
// Eggs: the day's trades between holders with accounts become egg token transfers; then every
// account is reconciled to what it really holds (crate plus eggs in open sell orders, or a buyer's
// stock) with mints and burns. Starting from the balances last confirmed on chain means a failed
// day is simply caught up by the next one, and no move ever burns more than an account holds.
// Feathers: redeemed tickets (queued) mint in redemption order, a few per day, to the player's
// linked wallet; a ticket whose player has no wallet yet waits. Ordinary hens are never minted.
import { createHash } from 'node:crypto';
import { EGG_GRADES, type EggGrade, type FeatherGrade, type MilestoneId } from '@coys/shared';
import { num, type Db } from '../db/db';
import type { FeatherRenderer } from './feather-image';

export interface FarmNet {
  farm: string;
  account: string | null;
  net_milli: string;
}

export interface EggMove {
  kind: 'Mint' | 'Burn' | 'Transfer';
  from: string | null;
  to: string | null;
  grade: string;
  amount: string;
}

/** A Feather to mint: the contract numbers it (#001 to #777, in mint order) and stores the rest with the token. */
export interface FeatherMint {
  owner_id: string;
  grade: FeatherGrade;
  milestone: MilestoneId;
  season: string;
  day: number;
  /** Its Feather card, a still PNG as a data URI. */
  media: string;
  media_hash: string;
}

export interface DayBatch {
  season: string;
  day: number;
  /** SHA-256 (hex) of the day's full settlement, kept as text in market_days.settlement_json. */
  digest: string;
  supply: number;
  multiplier_milli: number;
  /** Net totals of the farms whose eggs move today. */
  farms: FarmNet[];
  eggs: EggMove[];
  /** Present only for a contract with Feathers (version 4). */
  feather_mints?: FeatherMint[];
  /** Always empty: kept because version 2 contracts require the fields. */
  hen_mints: [];
  hen_moves: [];
}

/** The day's full settlement, as the database keeps it. Its SHA-256 is the batch's digest. */
export interface FullSettlement {
  season: string;
  day: number;
  supply: number;
  multiplier_milli: number;
  farms: FarmNet[];
  eggs: EggMove[];
  feathers: { ticket: string; number: number; owner: string; grade: FeatherGrade; milestone: MilestoneId; season: string; day: number; media_sha256: string }[];
}

/** Feather mints for this batch: how many at most, and how many the contract has minted before it. */
export interface FeatherOpts {
  cap: number;
  base: number;
}

export interface MintedFeather {
  ticketId: string;
  number: number;
  token: string;
  owner: string;
  grade: FeatherGrade;
  milestone: MilestoneId;
  mediaSha256: string;
}

export interface BuiltBatch {
  batch: DayBatch;
  settlement: FullSettlement;
  /** Egg balances once this batch lands, to store in chain_balances. */
  balances: Map<string, number>;
  /** Feathers this batch mints, in order. */
  minted: MintedFeather[];
}

const key = (account: string, grade: EggGrade): string => `${account}|${grade}`;
const token = (grade: EggGrade): string => `egg-${grade}`;

/** A Feather's token id: its number, three digits (the contract assigns the same). */
export const featherToken = (n: number): string => String(n).padStart(3, '0');

/** SHA-256 (hex) of a value's JSON. */
export const digestOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Each farm's NEAR testnet account (its player's, or its open agent's), where it has one. A bust
 * agent's wallet goes back to the pool for the next agent of any kind, so its farm holds none.
 */
async function farmAccountMap(db: Db): Promise<Map<string, string>> {
  const farmAccounts = new Map<string, string>();
  for (const r of await db.query(
    `SELECT f.id, COALESCE(p.near_account_id, a.near_account_id) AS account FROM farms f
     LEFT JOIN players p ON p.id = f.player_id LEFT JOIN agents a ON a.farm_id = f.id AND a.status = 'open'`,
  )) {
    if (r.account) farmAccounts.set(String(r.id), String(r.account));
  }
  return farmAccounts;
}

/** Every farm's net result for a day, from the ledger, with its account. */
async function dayNets(db: Db, season: string, day: number, farmAccounts: Map<string, string>): Promise<FarmNet[]> {
  const nets = await db.query(
    `SELECT f.id, COALESCE(SUM(l.amount_milli), 0) AS net FROM farms f LEFT JOIN ledger l ON l.farm_id = f.id AND l.season = $1 AND l.day = $2
     GROUP BY f.id ORDER BY f.id`,
    [season, day],
  );
  return nets.map((n) => ({ farm: String(n.id), account: farmAccounts.get(String(n.id)) ?? null, net_milli: String(num(n.net)) }));
}

/**
 * The full settlement of a day whose close failed to settle, recorded late: its supply and multiplier
 * and every farm's net, as the database holds them. No egg moves and no Feathers: the next day that
 * settled already brought every egg balance up to what its holder really has, and a Feather mints
 * only with a live day. Its SHA-256 is the digest the contract records for the day.
 */
export async function buildLateSettlement(db: Db, season: string, day: number): Promise<FullSettlement> {
  const [md] = await db.query('SELECT supply, multiplier, closed_at FROM market_days WHERE season = $1 AND day = $2', [season, day]);
  if (!md || md.closed_at === null || md.closed_at === undefined) throw new Error(`season ${season} day ${day} has not closed`);
  return {
    season,
    day,
    supply: num(md.supply),
    multiplier_milli: Math.round(num(md.multiplier) * 1000),
    farms: await dayNets(db, season, day, await farmAccountMap(db)),
    eggs: [],
    feathers: [],
  };
}

/**
 * The egg moves that bring the chain to what every holder really holds now: the trades of the given
 * days between account holders as transfers (netted per pair and grade), then mints and burns to each
 * account's real holding, starting from the balances last confirmed on chain.
 */
async function eggMoves(db: Db, firstDay: number, lastDay: number): Promise<{ moves: EggMove[]; balances: Map<string, number>; farmAccounts: Map<string, string> }> {
  // who holds what, off chain
  const farmAccounts = await farmAccountMap(db);
  const agentAccounts = new Map<string, string>();
  for (const r of await db.query('SELECT id, near_account_id FROM agents WHERE near_account_id IS NOT NULL')) agentAccounts.set(String(r.id), String(r.near_account_id));

  const targets = new Map<string, number>();
  for (const f of await db.query('SELECT id, crate_white, crate_cream, crate_brown, crate_golden FROM farms')) {
    const account = farmAccounts.get(String(f.id));
    if (!account) continue;
    for (const g of EGG_GRADES) targets.set(key(account, g), (targets.get(key(account, g)) ?? 0) + num(f[`crate_${g}`]));
  }
  for (const o of await db.query(`SELECT farm_id, grade, qty - filled_qty AS left FROM orders WHERE status = 'open' AND kind = 'limit' AND side = 'sell' AND farm_id IS NOT NULL`)) {
    const account = farmAccounts.get(String(o.farm_id));
    if (account) targets.set(key(account, o.grade as EggGrade), (targets.get(key(account, o.grade as EggGrade)) ?? 0) + num(o.left));
  }
  for (const a of await db.query(`SELECT id, stock FROM agents WHERE role = 'buyer'`)) {
    const account = agentAccounts.get(String(a.id));
    if (!account) continue;
    const stock = (typeof a.stock === 'string' ? JSON.parse(a.stock) : a.stock) as Record<string, number>;
    for (const g of EGG_GRADES) targets.set(key(account, g), stock[g] ?? 0);
  }

  // last confirmed chain balances
  const balances = new Map<string, number>();
  for (const b of await db.query('SELECT account, grade, amount FROM chain_balances')) balances.set(key(String(b.account), b.grade as EggGrade), num(b.amount));
  const bal = (k: string): number => balances.get(k) ?? 0;

  const moves: EggMove[] = [];
  const mint = (account: string, g: EggGrade, n: number) => {
    if (n <= 0) return;
    moves.push({ kind: 'Mint', from: null, to: account, grade: token(g), amount: String(n) });
    balances.set(key(account, g), bal(key(account, g)) + n);
  };

  // the trades between account holders (on these days) move as transfers, netted per pair and grade
  const transfers = new Map<string, number>();
  for (const t of await db.query('SELECT seller_farm, seller_agent, buyer_farm, buyer_agent, grade, qty FROM trades WHERE day BETWEEN $1 AND $2', [firstDay, lastDay])) {
    const from = t.seller_farm ? farmAccounts.get(String(t.seller_farm)) : t.seller_agent ? agentAccounts.get(String(t.seller_agent)) : undefined;
    const to = t.buyer_farm ? farmAccounts.get(String(t.buyer_farm)) : t.buyer_agent ? agentAccounts.get(String(t.buyer_agent)) : undefined;
    if (!from || !to || from === to) continue;
    const k = `${from}|${to}|${t.grade}`;
    transfers.set(k, (transfers.get(k) ?? 0) + num(t.qty));
  }
  for (const [k, n] of transfers) {
    const [from, to, grade] = k.split('|') as [string, string, EggGrade];
    const short = n - bal(key(from, grade));
    if (short > 0) mint(from, grade, short);
    moves.push({ kind: 'Transfer', from, to, grade: token(grade), amount: String(n) });
    balances.set(key(from, grade), bal(key(from, grade)) - n);
    balances.set(key(to, grade), bal(key(to, grade)) + n);
  }

  // then every account is brought to what it really holds
  for (const k of new Set([...targets.keys(), ...balances.keys()])) {
    const [account, grade] = k.split('|') as [string, EggGrade];
    const diff = (targets.get(k) ?? 0) - bal(k);
    if (diff > 0) mint(account, grade, diff);
    if (diff < 0) {
      moves.push({ kind: 'Burn', from: account, to: null, grade: token(grade), amount: String(-diff) });
      balances.set(k, bal(k) + diff);
    }
  }

  return { moves, balances, farmAccounts };
}

export async function buildDayBatch(db: Db, season: string, day: number, opts: { feathers: FeatherOpts | null; renderer: FeatherRenderer | null }): Promise<BuiltBatch> {
  const { moves, balances, farmAccounts } = await eggMoves(db, day, day);

  // Feathers: redeemed tickets of this season, oldest redemption first, to the player's wallet (the
  // contract mints a Feather only in the season that won it, and only in its live season)
  const minted: MintedFeather[] = [];
  const feather_mints: FeatherMint[] = [];
  if (opts.feathers && opts.renderer && opts.feathers.cap > 0) {
    const queued = await db.query(
      `SELECT t.id, t.grade, t.milestone, t.season, t.day, p.near_account_id AS account FROM feather_tickets t
       JOIN farms f ON f.id = t.farm_id LEFT JOIN players p ON p.id = f.player_id
       WHERE t.status = 'queued' AND t.season = $2 AND p.near_account_id IS NOT NULL ORDER BY t.redeemed_seq, t.id LIMIT $1`,
      [opts.feathers.cap, season],
    );
    for (const t of queued) {
      const number = opts.feathers.base + feather_mints.length + 1;
      const grade = t.grade as FeatherGrade;
      const img = opts.renderer.render(grade, number);
      feather_mints.push({
        owner_id: String(t.account),
        grade,
        milestone: t.milestone as MilestoneId,
        season: String(t.season),
        day: num(t.day),
        media: img.dataUri,
        media_hash: img.sha256Base64,
      });
      minted.push({ ticketId: String(t.id), number, token: featherToken(number), owner: String(t.account), grade, milestone: t.milestone as MilestoneId, mediaSha256: img.sha256Hex });
    }
  }

  const [md] = await db.query('SELECT supply, multiplier FROM market_days WHERE season = $1 AND day = $2', [season, day]);
  const all = await dayNets(db, season, day, farmAccounts);
  const moving = new Set(moves.flatMap((m) => [m.from, m.to]).filter((a): a is string => a !== null));
  const settlement: FullSettlement = {
    season,
    day,
    supply: num(md?.supply ?? 0),
    multiplier_milli: Math.round(num(md?.multiplier ?? 1) * 1000),
    farms: all,
    eggs: moves,
    feathers: minted.map((m, i) => ({
      ticket: m.ticketId,
      number: m.number,
      owner: m.owner,
      grade: m.grade,
      milestone: m.milestone,
      season: feather_mints[i]?.season ?? season,
      day: feather_mints[i]?.day ?? day,
      media_sha256: m.mediaSha256,
    })),
  };
  return {
    batch: {
      season,
      day,
      digest: digestOf(settlement),
      supply: settlement.supply,
      multiplier_milli: settlement.multiplier_milli,
      farms: all.filter((f) => f.account !== null && moving.has(f.account)),
      eggs: moves,
      ...(opts.feathers ? { feather_mints } : {}),
      hen_mints: [],
      hen_moves: [],
    },
    settlement,
    balances,
    minted,
  };
}

/** One closed day as the database records it: its supply, its multiplier and every farm's net result (from the ledger). */
export interface DayRecord {
  season: string;
  day: number;
  supply: number;
  multiplier_milli: number;
  farms: { farm: string; net_milli: string }[];
}

/**
 * Several closed days settled in one call (SETTLE_EVERY_DAYS): each day's record as the database holds
 * it, and the egg moves that bring the chain to what every holder holds at the range's last close.
 * Its SHA-256 is the digest the chain stores.
 */
export interface RangeSettlement {
  season: string;
  first_day: number;
  last_day: number;
  days: DayRecord[];
  eggs: EggMove[];
}

/** The call for a range: a day batch for its last day (the contract checks only that it is past the season's head), with its first day alongside. */
export interface RangeBatch extends DayBatch {
  first_day: number;
}

export interface BuiltRange {
  batch: RangeBatch;
  settlement: RangeSettlement;
  balances: Map<string, number>;
}

/** A closed day's record, as the database holds it (the ledger's nets never change once a day has closed). */
export async function dayRecord(db: Db, season: string, day: number): Promise<DayRecord> {
  const [md] = await db.query('SELECT supply, multiplier, closed_at FROM market_days WHERE season = $1 AND day = $2', [season, day]);
  if (!md || md.closed_at === null || md.closed_at === undefined) throw new Error(`season ${season} day ${day} has not closed`);
  const nets = await db.query(
    `SELECT f.id, COALESCE(SUM(l.amount_milli), 0) AS net FROM farms f LEFT JOIN ledger l ON l.farm_id = f.id AND l.season = $1 AND l.day = $2
     GROUP BY f.id ORDER BY f.id`,
    [season, day],
  );
  return {
    season,
    day,
    supply: num(md.supply),
    multiplier_milli: Math.round(num(md.multiplier) * 1000),
    farms: nets.filter((n) => num(n.net) !== 0).map((n) => ({ farm: String(n.id), net_milli: String(num(n.net)) })),
  };
}

/** Builds the settlement of closed days first to last of a season, in one call. */
export async function buildRangeBatch(db: Db, season: string, first: number, last: number): Promise<BuiltRange> {
  if (last < first) throw new Error(`an empty range: ${first} to ${last}`);
  const days: DayRecord[] = [];
  for (let d = first; d <= last; d++) days.push(await dayRecord(db, season, d));
  const { moves, balances, farmAccounts } = await eggMoves(db, first, last);
  const settlement: RangeSettlement = { season, first_day: first, last_day: last, days, eggs: moves };
  // the farms whose tokens move, with their net over the range (the contract only counts them)
  const moving = new Set(moves.flatMap((m) => [m.from, m.to]).filter((a): a is string => a !== null));
  const net = new Map<string, number>();
  for (const d of days) for (const f of d.farms) net.set(f.farm, (net.get(f.farm) ?? 0) + Number(f.net_milli));
  const farms: FarmNet[] = [...net]
    .map(([farm, n]) => ({ farm, account: farmAccounts.get(farm) ?? null, net_milli: String(n) }))
    .filter((f) => f.account !== null && moving.has(f.account))
    .sort((a, b) => a.farm.localeCompare(b.farm));
  const lastDay = days[days.length - 1];
  return {
    batch: {
      season,
      day: last,
      first_day: first,
      digest: digestOf(settlement),
      supply: days.reduce((n, d) => n + d.supply, 0),
      multiplier_milli: lastDay?.multiplier_milli ?? 1000,
      farms,
      eggs: moves,
      hen_mints: [],
      hen_moves: [],
    },
    settlement,
    balances,
  };
}

/**
 * Checks a settled range against the database: its kept record hashes to its kept digest (the one the
 * chain holds), and each day's record in it is still exactly what the database holds for that day.
 */
export async function checkRange(db: Db, season: string, lastDay: number): Promise<{ ok: boolean; first: number; last: number; digest: string; problems: string[] }> {
  const [row] = await db.query('SELECT settlement_json, settlement_digest, settlement_first, settlement_last FROM market_days WHERE season = $1 AND day = $2', [season, lastDay]);
  const problems: string[] = [];
  if (!row?.settlement_json) return { ok: false, first: lastDay, last: lastDay, digest: '', problems: [`no settlement kept for day ${lastDay}`] };
  const kept = (typeof row.settlement_json === 'string' ? JSON.parse(row.settlement_json) : row.settlement_json) as RangeSettlement;
  const digest = String(row.settlement_digest ?? '');
  if (digestOf(kept) !== digest) problems.push('the kept record does not hash to the kept digest');
  if (kept.first_day !== num(row.settlement_first) || kept.last_day !== lastDay) problems.push('the kept range does not match its days');
  for (const d of kept.days) {
    const now = await dayRecord(db, season, d.day);
    if (JSON.stringify(now) !== JSON.stringify(d)) problems.push(`day ${d.day} differs from the database`);
  }
  return { ok: problems.length === 0, first: kept.first_day, last: kept.last_day, digest, problems };
}

/** Stores the egg balances a landed call leaves on chain. */
export async function commitBalances(db: Db, balances: Map<string, number>): Promise<void> {
  await db.tx(async (q) => {
    for (const [k, amount] of balances) {
      const [account, grade] = k.split('|');
      await q.query(`INSERT INTO chain_balances (account, grade, amount) VALUES ($1, $2, $3) ON CONFLICT (account, grade) DO UPDATE SET amount = $3`, [account, grade, amount]);
    }
  });
}

/** Stores the balances and the Feathers a landed batch produced. */
export async function commitBatch(db: Db, built: BuiltBatch, txHash: string | null = null): Promise<void> {
  await db.tx(async (q) => {
    for (const [k, amount] of built.balances) {
      const [account, grade] = k.split('|');
      await q.query(
        `INSERT INTO chain_balances (account, grade, amount) VALUES ($1, $2, $3)
         ON CONFLICT (account, grade) DO UPDATE SET amount = $3`,
        [account, grade, amount],
      );
    }
    for (const m of built.minted) {
      await q.query(
        `UPDATE feather_tickets SET status = 'minted', number = $2, token_id = $3, owner_account = $4, media_sha256 = $5, mint_tx = $6, mint_day = $7 WHERE id = $1`,
        [m.ticketId, m.number, m.token, m.owner, m.mediaSha256, txHash, built.batch.day],
      );
    }
  });
}
