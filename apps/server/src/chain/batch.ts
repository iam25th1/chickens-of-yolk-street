// Builds one day's settlement batch for the game contract, keyed by (season, day).
//
// Eggs: the day's trades between holders with accounts become egg token transfers; then every
// account is reconciled to what it really holds (crate plus eggs in open sell orders, or a buyer's
// stock) with mints and burns. Starting from the balances last confirmed on chain means a failed
// day is simply caught up by the next one, and no move ever burns more than an account holds.
// Hens: only Founding Hens (won at milestones, 777 ever) are minted, to their owner's account, a
// few per day; ordinary hens are not recorded. Hens on chain that changed owner move. Farms: every
// farm's net result for the day, plus a SHA-256 digest of that list.
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

/** A Founding Hen to mint: the contract numbers her (#n of 777) and stores the rest with the token. */
export interface FoundingMint {
  token_id: string;
  owner_id: string;
  media: string;
  media_hash: string;
  /** Her traits, as JSON. */
  traits: string;
  milestone: string;
  season: string;
  day: number;
}

export interface DayBatch {
  season: string;
  day: number;
  supply: number;
  multiplier_milli: number;
  digest: string;
  farms: FarmNet[];
  eggs: EggMove[];
  /** Always empty: ordinary hens are not minted (version 2 contracts still require the field). */
  hen_mints: [];
  /** Present only for a contract that mints Founding Hens (version 3). */
  founding_mints?: FoundingMint[];
  hen_moves: { token_id: string; to: string }[];
}

/** Founding mints for this batch: how many at most, and how many the contract has minted before it. */
export interface FoundingOpts {
  cap: number;
  base: number;
}

export interface BuiltBatch {
  batch: DayBatch;
  /** Egg balances once this batch lands, to store in chain_balances. */
  balances: Map<string, number>;
  /** Hens whose chain owner changes once this batch lands. */
  henOwners: Map<string, string>;
  /** Founding Hens this batch mints, in order (a subset of henOwners), and the number each gets. */
  minted: string[];
  numbers: Map<string, number>;
}

const key = (account: string, grade: EggGrade): string => `${account}|${grade}`;
const token = (grade: EggGrade): string => `egg-${grade}`;

/** A hen's NFT token id: Founding Hens are founding-<id>; hens minted by version 2 were hen-<id>. */
export const henToken = (id: string, founding: boolean): string => (founding ? `founding-${id}` : `hen-${id}`);

export const digestOf = (farms: FarmNet[]): string => createHash('sha256').update(JSON.stringify(farms)).digest('hex');

export async function buildDayBatch(db: Db, season: string, day: number, opts: { founding: FoundingOpts | null; renderer: HenRenderer | null }): Promise<BuiltBatch> {
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

  // hens: mint waiting Founding Hens, oldest win first; move hens on chain that changed hands
  const henOwners = new Map<string, string>();
  const founding_mints: FoundingMint[] = [];
  const hen_moves: { token_id: string; to: string }[] = [];
  const minted: string[] = [];
  const numbers = new Map<string, number>();
  const hens = await db.query(
    `SELECT id, farm_id, body, eyes, comb, accessory, laying_trait, born_day, chain_owner, founding_milestone, founding_day FROM hens
     WHERE status = 'alive' AND (chain_owner IS NOT NULL OR founding_milestone IS NOT NULL) ORDER BY founding_day, id`,
  );
  for (const h of hens) {
    const account = farmAccounts.get(String(h.farm_id));
    if (!account) continue;
    const id = String(h.id);
    const founding = h.founding_milestone !== null && h.founding_milestone !== undefined;
    if (!h.chain_owner) {
      if (!founding || !opts.founding || !opts.renderer || founding_mints.length >= opts.founding.cap) continue;
      const traits = { body: String(h.body), eyes: String(h.eyes), comb: String(h.comb), accessory: String(h.accessory), laying: num(h.laying_trait).toFixed(3) };
      const img = opts.renderer.render(traits as unknown as HenView);
      founding_mints.push({
        token_id: henToken(id, true),
        owner_id: account,
        media: img.dataUri,
        media_hash: img.sha256Base64,
        traits: JSON.stringify(traits),
        milestone: String(h.founding_milestone),
        season,
        day: num(h.founding_day),
      });
      henOwners.set(id, account);
      minted.push(id);
      numbers.set(id, opts.founding.base + founding_mints.length);
    } else if (h.chain_owner !== account) {
      hen_moves.push({ token_id: henToken(id, founding), to: account });
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
      hen_mints: [],
      ...(opts.founding ? { founding_mints } : {}),
      hen_moves,
    },
    balances,
    henOwners,
    minted,
    numbers,
  };
}

/** Stores the balances and hen owners a landed batch produced. */
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
    for (const [henId, owner] of built.henOwners) await q.query('UPDATE hens SET chain_owner = $2 WHERE id = $1', [henId, owner]);
    for (const henId of built.minted) {
      await q.query('UPDATE hens SET mint_tx = $2, mint_day = $3, founding_no = $4 WHERE id = $1', [henId, txHash, built.batch.day, built.numbers.get(henId) ?? null]);
    }
  });
}
