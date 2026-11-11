// Builds one day's settlement batch for the game contract, keyed by (season, day).
//
// Eggs: the day's trades between holders with accounts become egg token transfers; then every
// account is reconciled to what it really holds (crate plus eggs in open sell orders, or a buyer's
// stock) with mints and burns. Starting from the balances last confirmed on chain means a failed
// day is simply caught up by the next one, and no move ever burns more than an account holds.
// Hens: new hens are minted to their owner's account (capped per day), and hens that changed owner
// move. Farms: every farm's net result for the day, plus a SHA-256 digest of that list.
import { createHash } from 'node:crypto';
import { EGG_GRADES, type EggGrade, type HenView } from '@coys/shared';
import { num, type Db } from '../db/db';
import type { HenRenderer } from './hen-image';

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

export interface HenMint {
  token_id: string;
  owner_id: string;
  title: string;
  media: string;
  media_hash: string;
  extra: string;
}

export interface DayBatch {
  season: string;
  day: number;
  supply: number;
  multiplier_milli: number;
  digest: string;
  farms: FarmNet[];
  eggs: EggMove[];
  hen_mints: HenMint[];
  hen_moves: { token_id: string; to: string }[];
}

export interface BuiltBatch {
  batch: DayBatch;
  /** Egg balances once this batch lands, to store in chain_balances. */
  balances: Map<string, number>;
  /** Hens whose chain owner changes once this batch lands. */
  henOwners: Map<string, string>;
}

const key = (account: string, grade: EggGrade): string => `${account}|${grade}`;
const token = (grade: EggGrade): string => `egg-${grade}`;

export const digestOf = (farms: FarmNet[]): string => createHash('sha256').update(JSON.stringify(farms)).digest('hex');

export async function buildDayBatch(db: Db, season: string, day: number, opts: { henMintCap: number; renderer: HenRenderer | null }): Promise<BuiltBatch> {
  // who holds what, off chain
  const farmAccounts = new Map<string, string>();
  for (const r of await db.query(
    `SELECT f.id, COALESCE(p.near_account_id, a.near_account_id) AS account FROM farms f
     LEFT JOIN players p ON p.id = f.player_id LEFT JOIN agents a ON a.farm_id = f.id`,
  )) {
    if (r.account) farmAccounts.set(String(r.id), String(r.account));
  }
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

  // the day's trades between account holders move as transfers
  const transfers = new Map<string, number>();
  for (const t of await db.query('SELECT seller_farm, seller_agent, buyer_farm, buyer_agent, grade, qty FROM trades WHERE day = $1', [day])) {
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

  // hens: mint the newest owned hens (players first), move those that changed hands
  const henOwners = new Map<string, string>();
  const hen_mints: HenMint[] = [];
  const hen_moves: { token_id: string; to: string }[] = [];
  const hens = await db.query(
    `SELECT h.id, h.farm_id, h.body, h.eyes, h.comb, h.accessory, h.laying_trait, h.born_day, h.chain_owner, f.owner_kind
     FROM hens h JOIN farms f ON f.id = h.farm_id WHERE h.status = 'alive' ORDER BY (f.owner_kind = 'player') DESC, h.born_day DESC`,
  );
  for (const h of hens) {
    const account = farmAccounts.get(String(h.farm_id));
    if (!account) continue;
    const id = String(h.id);
    if (!h.chain_owner) {
      if (hen_mints.length >= opts.henMintCap || !opts.renderer) continue;
      const traits = { body: h.body, eyes: h.eyes, comb: h.comb, accessory: h.accessory, laying: num(h.laying_trait), hatched: `day ${num(h.born_day)}` };
      const img = opts.renderer.render(traits as unknown as HenView);
      hen_mints.push({
        token_id: `hen-${id}`,
        owner_id: account,
        title: `Yolk Street hen ${id.slice(0, 8)}`,
        media: img.dataUri,
        media_hash: img.sha256Base64,
        extra: JSON.stringify(Object.fromEntries(Object.entries(traits).map(([k, v]) => [k, String(v)]))),
      });
      henOwners.set(id, account);
    } else if (h.chain_owner !== account) {
      hen_moves.push({ token_id: `hen-${id}`, to: account });
      henOwners.set(id, account);
    }
  }

  const [md] = await db.query('SELECT supply, multiplier FROM market_days WHERE season = $1 AND day = $2', [season, day]);
  const nets = await db.query(
    `SELECT f.id, COALESCE(SUM(l.amount_milli), 0) AS net FROM farms f LEFT JOIN ledger l ON l.farm_id = f.id AND l.season = $1 AND l.day = $2
     GROUP BY f.id ORDER BY f.id`,
    [season, day],
  );
  const farms: FarmNet[] = nets.map((n) => ({ farm: String(n.id), account: farmAccounts.get(String(n.id)) ?? null, net_milli: String(num(n.net)) }));
  return {
    batch: {
      season,
      day,
      supply: num(md?.supply ?? 0),
      multiplier_milli: Math.round(num(md?.multiplier ?? 1) * 1000),
      digest: digestOf(farms),
      farms,
      eggs: moves,
      hen_mints,
      hen_moves,
    },
    balances,
    henOwners,
  };
}

/** Stores the balances and hen owners a landed batch produced. */
export async function commitBatch(db: Db, built: BuiltBatch): Promise<void> {
  await db.tx(async (q) => {
    for (const [k, amount] of built.balances) {
      const [account, grade] = k.split('|');
      await q.query(
        `INSERT INTO chain_balances (account, grade, amount) VALUES ($1, $2, $3)
         ON CONFLICT (account, grade) DO UPDATE SET amount = $3`,
        [account, grade, amount],
      );
    }
    for (const [henId, owner] of built.henOwners) await q.query('UPDATE hens SET chain_owner = $2 WHERE id = $1', [henId, owner]);
  });
}
