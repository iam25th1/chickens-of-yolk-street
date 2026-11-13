// The chain writer. Once per in-game day it sends one settle_day call to the game contract on
// NEAR testnet, carrying the batch from batch.ts: the egg moves, the net totals of the farms whose
// eggs move, the day's Feathers, and the SHA-256 of the full settlement (kept in the database). A
// version 4 contract stores only a fixed-size head per season, so a settled day adds no storage
// (measured on s1 before: 179 bytes a day, 480 days a real day, about 0.86 NEAR a real day; gas
// is about 0.0004 NEAR a day either way). Agents get testnet sub-accounts of the game account
// (funded from it, and kept in a pool: a bust agent's wallet goes to the next new agent of any
// kind) so their tokens have a home. Without testnet credentials, or before the
// contract is deployed, every day is built the same way and recorded as a loud no-op.
//
// Feathers are minted one at a time, at once, as tickets are redeemed (mintFeather: version 6's
// mint_feather, with the number the server drew), never in a day's settlement. A mint goes out only
// while the game account's free balance can store it: each keeps CHAIN_MINT_NEAR in reserve on top
// of a CHAIN_MIN_BALANCE_NEAR margin (both set from measured costs, see MEASURED below), so
// nothing optional (mints, linking or creating agent wallets) ever eats into the days' own
// settlements; a mint that cannot go out yet waits, at the latest for a day close. The contract
// names its live season: that season's Feathers are the 777, any other season's go into its own
// test collection, which never counts toward the 777.
//
// A day whose close failed to settle (a refused RPC call, say) is caught up later: the next day's
// moves already bring every egg balance up to date, so the missed day is recorded by its digest
// alone with settle_late_days (version 5), paced, once the season has moved past it.
import { createHmac } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Account, JsonRpcProvider, KeyPairSigner, baseEncode, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { num, type Db, type Queryable } from '../db/db';
import { ECONOMY, type FeatherGrade, type MilestoneId } from '@coys/shared';
import { buildDayBatch, buildLateSettlement, commitBatch, digestOf, featherToken, type FullSettlement, type MintedFeather } from './batch';
import type { FeatherRenderer } from './feather-image';
import { testFeatherToken, type Collection } from './mint';

export interface SettleResult {
  status: 'sent' | 'noop' | 'failed';
  txHash: string | null;
  error?: string;
  /** Feathers this settlement minted. */
  minted?: MintedFeather[];
  /** The day's full settlement and its SHA-256 (the digest the chain stores). */
  settlement?: FullSettlement;
  digest?: string;
}

export interface ChainWriter {
  readonly mode: 'noop' | 'near-testnet';
  /** Explorer base for transaction receipts, or null. */
  readonly explorer: string | null;
  /** Whether day closes mint Feathers: live, paused (game account low, or its contract has no Feathers yet), or off. */
  readonly minting: 'live' | 'paused' | 'off';
  /** Feathers the contract has minted, as last read; null without a chain or before version 4. */
  readonly featherMinted: number | null;
  /** The provenance hash the contract holds (founders.json), as last read; null if none yet. */
  readonly provenance: string | null;
  /** The game contract's account, or null without a chain. */
  readonly contractId: string | null;
  /** Settles one closed day of a season. */
  settleDay(db: Db, season: string, day: number): Promise<SettleResult>;
  /** Every Feather on the contract (any season), as last read; absent without a chain. */
  featherTokens?(): Promise<ChainFeather[]>;
  /** Records closed days of a season that failed to settle, once the season has moved past them; absent without a chain. */
  settleLateDays?(db: Db, season: string, days: number[]): Promise<LateResult>;
  /** Which collection a season's Feathers go into: the 777 (the contract's live season) or a test one. Absent: the 777. */
  collectionFor?(season: string): Promise<Collection>;
  /** Mints one Feather now, with the number drawn for it (version 6); absent without a chain. */
  mintFeather?(req: MintRequest): Promise<MintResult>;
}

/** One Feather to mint now: its ticket's details and the number drawn for it. */
export interface MintRequest {
  owner: string;
  grade: FeatherGrade;
  milestone: MilestoneId;
  season: string;
  day: number;
  number: number;
}

/** How a mint went: sent (confirmed on chain), waiting (it cannot go out yet: no harm done), or failed. */
export interface MintResult {
  status: 'sent' | 'waiting' | 'failed';
  /** The mint's transaction; null when an earlier send had landed unseen. */
  txHash: string | null;
  token: string | null;
  mediaSha256: string | null;
  /** Why it waits or failed, in plain words. */
  note?: string;
  /** The contract holds another Feather with this number: draw the next one. */
  taken?: boolean;
}

/** Whether an RPC error is a refusal worth trying again (a burst limit, a dropped or timed-out connection). */
export const refusedByRpc = (err: unknown): boolean =>
  /\b429\b|rate.?limit|too many requests|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up|\b50[234]\b|timed? ?out/i.test(err instanceof Error ? err.message : String(err));

/**
 * Runs a call, trying again with backoff while the RPC refuses it: waits base, 2 x base, 4 x base
 * and so on, at most `tries` attempts in all. Any other error, or the last refusal, is thrown.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, err: unknown, waitMs: number) => void } = {},
): Promise<T> {
  const tries = opts.tries ?? 5;
  const base = opts.baseMs ?? 1500;
  const sleep = opts.sleep ?? pause;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries - 1 || !refusedByRpc(err)) throw err;
      const wait = base * 2 ** i;
      opts.onRetry?.(i + 1, err, wait);
      await sleep(wait);
    }
  }
}

/** The outcome of recording missed days late. */
export interface LateResult {
  status: 'sent' | 'skipped' | 'failed';
  txHash: string | null;
  error?: string;
  /** The days recorded, each with its full settlement and digest. */
  days: { day: number; settlement: FullSettlement; digest: string }[];
}

/** The contract's compact head for a season (version 4 on). */
interface SeasonHead {
  last_day: number;
  days_settled: number;
  v2_through: number;
}

/** Which missed days can be recorded late: past the season's head, after its version 2 days, not recorded yet. */
export function lateDaysToSend(days: number[], head: SeasonHead, recorded: number[]): number[] {
  return days.filter((d) => d < head.last_day && d > head.v2_through && !recorded.includes(d));
}

/**
 * Whether the database and the contract agree on which days settled: the contract's count of settled
 * days since its version 2 days equals the database's sent days in that range, less the days recorded
 * late. If they differ, a day marked failed may have landed after all, and nothing is sent late.
 */
export function settledCountsAgree(head: SeasonHead, sentDays: number[], recorded: number[]): boolean {
  return sentDays.filter((d) => d > head.v2_through && d <= head.last_day && !recorded.includes(d)).length === head.days_settled;
}

/** A Feather as the contract holds it: its number, grade, milestone, season, day and owner. */
export interface ChainFeather {
  number: number;
  grade: FeatherGrade;
  milestone: MilestoneId;
  season: string;
  day: number;
  owner: string;
}

export interface TestnetConfig {
  accountId: string;
  privateKey: string;
  rpcUrl: string;
  contractId: string;
  /** NEAR kept free for each Feather minted (its token's storage). */
  mintNear: number;
  /** NEAR always kept free on the game account, on top of the mints' reserve. */
  minBalanceNear: number;
  agentFundingNear: number;
}

/** How many Feathers a free balance can mint now: each keeps mintNear, above the margin. */
export function mintsAffordable(availableNear: number, cfg: Pick<TestnetConfig, 'mintNear' | 'minBalanceNear'>, cap: number): number {
  if (cfg.mintNear <= 0) return cap;
  return Math.max(0, Math.min(cap, Math.floor((availableNear - cfg.minBalanceNear) / cfg.mintNear + 1e-9)));
}

/** Throws unless the config can only ever touch testnet. Checked before any key is used. */
export function assertTestnetConfig(cfg: Pick<TestnetConfig, 'accountId' | 'contractId' | 'rpcUrl' | 'privateKey'>): void {
  for (const id of [cfg.accountId, cfg.contractId]) {
    const implicit = /^[0-9a-f]{64}$/.test(id);
    if (!implicit && !id.endsWith('.testnet')) throw new Error(`refusing non-testnet account ${id}`);
  }
  if (!/test/i.test(new URL(cfg.rpcUrl).hostname)) throw new Error(`refusing RPC ${cfg.rpcUrl}: not a testnet endpoint`);
  if (!cfg.privateKey.startsWith('ed25519:')) throw new Error('NEAR_TESTNET_PRIVATE_KEY must be an ed25519:... key');
}

/** Agent wallet keys are derived from the game key, so no extra secret is stored anywhere. */
export function agentPublicKey(gamePrivateKey: string, kind: string, generation: number): string {
  const seed = createHmac('sha256', gamePrivateKey).update(`coys-agent:${kind}:${generation}`).digest();
  return `ed25519:${baseEncode(ed25519.getPublicKey(seed))}`;
}

export const agentAccountName = (kind: string, generation: number, game: string): string => `${kind.replace(/[^a-z0-9]/g, '')}${generation}.${game}`;

/** Every wallet the pool knows: those it recorded, and any an agent holds (linked before the pool). */
const POOL = `SELECT account FROM agent_wallets UNION SELECT near_account_id AS account FROM agents WHERE near_account_id IS NOT NULL`;
const IN_USE = `EXISTS (SELECT 1 FROM agents a WHERE a.near_account_id = w.account AND a.status = 'open')`;

/**
 * A free wallet from the pool, or null: one whose agents are all bust (of any kind), or that no agent
 * holds. Rivals go bust and AI farms come and go (on s1 a bust about 30 times a real day at 3-minute
 * days), and a fresh funded sub-account for each would cost its funding every time, so a new agent
 * always takes a free wallet before one is created. The same order every time: by account name.
 */
export async function freeWallet(q: Queryable): Promise<string | null> {
  const [r] = await q.query<{ account: string }>(`SELECT w.account FROM (${POOL}) w WHERE NOT ${IN_USE} ORDER BY w.account LIMIT 1`);
  return r?.account ?? null;
}

export interface WalletPool {
  /** Wallets in the pool. */
  poolSize: number;
  free: number;
  inUse: number;
  /** Wallets the game created and funded. */
  created: number;
  /** NEAR sent to fund them (wallets made before the pool are not counted). */
  nearSpent: number;
}

export async function walletPool(q: Queryable): Promise<WalletPool> {
  const [r] = await q.query(
    `SELECT (SELECT count(*) FROM (${POOL}) w) AS pool, (SELECT count(*) FROM (${POOL}) w WHERE ${IN_USE}) AS in_use,
            (SELECT count(*) FROM agent_wallets WHERE funded_near > 0) AS created, (SELECT COALESCE(SUM(funded_near), 0) FROM agent_wallets) AS near`,
  );
  const poolSize = num(r?.pool);
  const inUse = num(r?.in_use);
  return { poolSize, free: poolSize - inUse, inUse, created: num(r?.created), nearSpent: Math.round(num(r?.near) * 1e6) / 1e6 };
}

/**
 * Makes a wallet for a new agent: creates and funds the named sub-account (keyed by the seed and
 * generation), or links it if it already exists. Returns the NEAR sent (0 when only linked), or null
 * when it cannot now (the game account is low, or the call failed); the agent then waits.
 */
export type WalletMaker = (w: { account: string; seed: string; generation: number }) => Promise<number | null>;

/**
 * Gives every open agent without a wallet one: a free pool wallet when there is one (never funding
 * then), else a new one from `make`, recorded in agent_wallets with its funding. Each creation logs
 * the pool's size and the NEAR spent so far.
 */
export async function assignAgentWallets(db: Db, gameAccount: string, make: WalletMaker, log: (line: string) => void, now: () => number = Date.now): Promise<void> {
  const agents = await db.query(`SELECT id, name, kind, generation, entrant_key FROM agents WHERE status = 'open' AND near_account_id IS NULL ORDER BY opened_day, kind, generation`);
  for (const a of agents) {
    const free = await freeWallet(db);
    if (free) {
      await db.query('UPDATE agents SET near_account_id = $2 WHERE id = $1', [a.id, free]);
      log(`[chain] ${String(a.name)} takes over the free pool wallet ${free}`);
      continue;
    }
    // base agents keep the names (and keys) they always had: kind and generation; an entrant its registry key
    const seed = String(a.entrant_key ?? a.kind);
    const account = agentAccountName(seed, num(a.generation), gameAccount);
    const funded = await make({ account, seed, generation: num(a.generation) });
    if (funded === null) continue;
    await db.query(
      `INSERT INTO agent_wallets (account, key_seed, key_generation, funded_near, created_for, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (account) DO NOTHING`,
      [account, seed, num(a.generation), funded, a.id, now()],
    );
    await db.query('UPDATE agents SET near_account_id = $2 WHERE id = $1', [a.id, account]);
    const pool = await walletPool(db);
    log(
      `[chain] ${funded > 0 ? `created agent wallet ${account}, funded with ${funded} NEAR` : `linked existing agent wallet ${account}`} for ${String(a.name)}; ` +
        `pool ${pool.poolSize} (${pool.inUse} in use, ${pool.free} free), ${pool.created} created, ${pool.nearSpent} NEAR spent`,
    );
  }
}

export class NoopChain implements ChainWriter {
  readonly mode = 'noop' as const;
  readonly explorer = null;
  readonly minting = 'off' as const;
  readonly featherMinted = null;
  readonly provenance = null;
  readonly contractId = null;
  constructor(
    private readonly reason: string,
    private readonly log: (line: string) => void,
  ) {}

  async settleDay(db: Db, season: string, day: number): Promise<SettleResult> {
    const built = await buildDayBatch(db, season, day, { feathers: null, renderer: null });
    this.log(
      `[chain] !!! NO-OP for season ${season} day ${day}: ${this.reason}. Settlement built (${built.settlement.farms.length} farms, ` +
        `digest ${built.batch.digest.slice(0, 12)}) and recorded in market_days only, not on NEAR testnet.`,
    );
    return { status: 'noop', txHash: null, settlement: built.settlement, digest: built.batch.digest };
  }
}

export class TestnetChain implements ChainWriter {
  readonly mode = 'near-testnet' as const;
  readonly explorer = 'https://testnet.nearblocks.io/txns/';
  private readonly provider: JsonRpcProvider;
  private readonly account: Account;
  private checked = false;
  /** Last known: could the game account not afford a mint? Null until first read. */
  private low: boolean | null = null;
  /** The contract's Feather count, provenance and live season (undefined on version 4); null until read, or when the contract has no Feathers (before version 4). */
  private feathers: { minted: number; provenance: string | null; liveSeason?: string | null } | null = null;

  constructor(
    private readonly cfg: TestnetConfig,
    private readonly renderer: FeatherRenderer,
    private readonly log: (line: string) => void,
  ) {
    assertTestnetConfig(cfg);
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.account = new Account(cfg.accountId, this.provider, KeyPairSigner.fromSecretKey(cfg.privateKey as KeyPairString));
    // the first status read happens at boot, so the game can tell players the truth before a day closes
    this.balanceNear().then(
      (b) => {
        this.low = mintsAffordable(b, cfg, 1) === 0;
      },
      () => undefined,
    );
    this.readFeathers().then(
      (n) => {
        this.feathers = n;
      },
      () => undefined,
    );
  }

  private tokens: { at: number; list: ChainFeather[] } | null = null;

  /** Every Feather token, read a page of 100 at a time and kept for a minute. */
  async featherTokens(): Promise<ChainFeather[]> {
    if (this.tokens && Date.now() - this.tokens.at < 60_000) return this.tokens.list;
    const list: ChainFeather[] = [];
    for (let from = 0; from < ECONOMY.feathers.maxSupply; from += 100) {
      const page = await this.provider.callFunction<{ token_id: string; owner_id: string; metadata?: { extra?: string | null } | null }[]>({
        contractId: this.cfg.contractId,
        method: 'nft_tokens',
        args: { from_index: String(from), limit: 100 },
      });
      for (const t of page ?? []) {
        // a test collection's Feather is never one of the 777
        if (t.token_id.startsWith('test-')) continue;
        try {
          const x = JSON.parse(t.metadata?.extra ?? '{}') as { number?: number; grade?: FeatherGrade; milestone?: MilestoneId; season?: string; day?: number };
          if (typeof x.number === 'number' && x.grade) list.push({ number: x.number, grade: x.grade, milestone: x.milestone ?? 'full-coop', season: x.season ?? '', day: x.day ?? 0, owner: t.owner_id });
        } catch {
          // not a Feather (no token of another kind exists on version 4, but stay safe)
        }
      }
      if (!page || page.length < 100) break;
    }
    this.tokens = { at: Date.now(), list };
    return list;
  }

  get minting(): 'live' | 'paused' {
    return this.low || this.feathers === null ? 'paused' : 'live';
  }

  get featherMinted(): number | null {
    return this.feathers?.minted ?? null;
  }

  get provenance(): string | null {
    return this.feathers?.provenance ?? null;
  }

  get contractId(): string {
    return this.cfg.contractId;
  }

  /** The contract's Feather count, provenance and live season, or null when it has none (before version 4: no feather_supply). */
  private async readFeathers(): Promise<{ minted: number; provenance: string | null; liveSeason?: string | null } | null> {
    try {
      const r = await this.provider.callFunction<{ minted: number; max: number; remaining: number; provenance: string | null; live_season?: string | null }>({
        contractId: this.cfg.contractId,
        method: 'feather_supply',
        args: {},
      });
      if (typeof r?.minted !== 'number') return null;
      // version 5 always answers live_season (null until set); version 4 has no such field
      return { minted: r.minted, provenance: r.provenance ?? null, ...('live_season' in r ? { liveSeason: r.live_season ?? null } : {}) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/MethodNotFound|method.*not found|CodeDoesNotExist/i.test(msg)) return null;
      throw err;
    }
  }

  private async preflight(): Promise<string | null> {
    if (!this.checked) {
      const status = await this.provider.viewNodeStatus();
      if (status.chain_id !== 'testnet') throw new Error(`RPC reports chain ${status.chain_id}, not testnet; nothing signed`);
      this.checked = true;
    }
    const contract = await new Account(this.cfg.contractId, this.provider).getState();
    if (contract.codeHash === '11111111111111111111111111111111') return 'the game contract is not deployed yet (see deploy/testnet.md)';
    return null;
  }

  private async balanceNear(): Promise<number> {
    const s = await this.account.getState();
    return Number(s.balance.available / 10n ** 21n) / 1000;
  }

  /**
   * Each open agent gets a wallet: a free one from the pool, else a funded sub-account of the game
   * account. A wallet that already exists on chain only needs linking (its egg balances then take a
   * little state); creating one also needs its funding. Both wait while the game account is under
   * its margin.
   */
  private async ensureAgentAccounts(db: Db): Promise<void> {
    const [waiting] = await db.query(`SELECT count(*) AS n FROM agents WHERE status = 'open' AND near_account_id IS NULL`);
    if (!num(waiting?.n)) return;
    if ((await this.balanceNear()) < this.cfg.minBalanceNear) {
      this.log(`[chain] game account under its ${this.cfg.minBalanceNear} NEAR margin; ${num(waiting?.n)} agent wallets wait to be linked`);
      return;
    }
    let lowSaid = false;
    await assignAgentWallets(db, this.cfg.accountId, async ({ account, seed, generation }) => {
      try {
        const exists = await new Account(account, this.provider).getState().then(
          () => true,
          () => false,
        );
        if (exists) return 0;
        if ((await this.balanceNear()) < this.cfg.minBalanceNear + this.cfg.agentFundingNear) {
          if (!lowSaid) this.log('[chain] game account balance is low; new agent sub-accounts wait');
          lowSaid = true;
          return null;
        }
        await this.account.createSubAccount({ accountOrPrefix: account, publicKey: agentPublicKey(this.cfg.privateKey, seed, generation), nearToTransfer: nearToYocto(this.cfg.agentFundingNear) });
        return this.cfg.agentFundingNear;
      } catch (err) {
        this.log(`[chain] could not create ${account}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }, this.log);
  }

  async settleDay(db: Db, season: string, day: number): Promise<SettleResult> {
    try {
      const blocked = await this.preflight();
      if (blocked) {
        this.log(`[chain] !!! NO-OP for season ${season} day ${day}: ${blocked}`);
        return { status: 'noop', txHash: null, error: blocked };
      }
      await this.ensureAgentAccounts(db);
      this.feathers = await this.readFeathers();
      this.low = mintsAffordable(await this.balanceNear(), this.cfg, 1) === 0;
      // Feathers mint at once now (mintFeather, version 6), never in a day's settlement
      const feathers = this.feathers === null ? null : { cap: 0, base: this.feathers.minted };
      const built = await buildDayBatch(db, season, day, { feathers, renderer: this.renderer });
      const outcome = await this.account.callFunctionRaw({
        contractId: this.cfg.contractId,
        methodName: 'settle_day',
        args: { batch: built.batch },
        gas: teraToGas('300'),
        deposit: 0n,
      });
      const txHash = outcome.transaction_outcome.id;
      await commitBatch(db, built, txHash);
      if (this.feathers !== null) this.feathers.minted += built.minted.length;
      if (built.minted.length) this.tokens = null;
      this.log(
        `[chain] season ${season} day ${day} settled on NEAR testnet: ${txHash} (digest ${built.batch.digest.slice(0, 12)}, ${built.batch.eggs.length} egg moves, ${built.batch.farms.length} farms moving, ${built.minted.length} Feathers minted)`,
      );
      return { status: 'sent', txHash, minted: built.minted, settlement: built.settlement, digest: built.batch.digest };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`[chain] season ${season} day ${day} FAILED on NEAR testnet: ${error.slice(0, 300)}`);
      return { status: 'failed', txHash: null, error: error.slice(0, 500) };
    }
  }

  /** The live season's collection or a test one, from the contract (read once, then at each day close). */
  async collectionFor(season: string): Promise<Collection> {
    if (this.feathers === null) this.feathers = await withBackoff(() => this.readFeathers());
    // version 4 (no live season) has only the 777
    return this.feathers === null || this.feathers.liveSeason === undefined || this.feathers.liveSeason === season ? 'live' : 'test';
  }

  /**
   * Mints one Feather now (version 6's mint_feather), paced and retried with backoff while the RPC
   * refuses. It waits, harmlessly, while the contract cannot mint at once yet, the game account is
   * under its margin, or the chain is not reachable before the call. A number the contract refuses
   * as taken is checked: if the Feather there is this very one (an earlier send that landed unseen),
   * the mint counts as sent; otherwise the caller draws another number.
   */
  async mintFeather(req: MintRequest): Promise<MintResult> {
    const none = { txHash: null, token: null, mediaSha256: null };
    const retry = (what: string) => (attempt: number, err: unknown, wait: number) =>
      this.log(`[chain] ${what} refused (try ${attempt}): ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}; again in ${wait} ms`);
    let token: string | null = null;
    try {
      await pause(PACE_MS);
      const blocked = await withBackoff(() => this.preflight(), { onRetry: retry('status check') });
      if (blocked) return { status: 'waiting', ...none, note: blocked };
      await pause(PACE_MS);
      this.feathers = await withBackoff(() => this.readFeathers(), { onRetry: retry('Feather supply read') });
      if (this.feathers === null) return { status: 'waiting', ...none, note: 'the contract has no Feathers yet' };
      await pause(PACE_MS);
      const affordable = mintsAffordable(await withBackoff(() => this.balanceNear(), { onRetry: retry('balance read') }), this.cfg, 1);
      this.low = affordable === 0;
      if (!affordable) return { status: 'waiting', ...none, note: `the game account is low on testnet NEAR (each mint keeps ${this.cfg.mintNear} NEAR free)` };
      const live = this.feathers.liveSeason === undefined || this.feathers.liveSeason === req.season;
      token = live ? featherToken(req.number) : testFeatherToken(req.season, req.number);
      const img = this.renderer.render(req.grade, req.number);
      const mint = { owner_id: req.owner, grade: req.grade, milestone: req.milestone, season: req.season, day: req.day, media: img.dataUri, media_hash: img.sha256Base64, number: req.number };
      try {
        await pause(PACE_MS);
        const outcome = await withBackoff(
          () => this.account.callFunctionRaw({ contractId: this.cfg.contractId, methodName: 'mint_feather', args: { mint }, gas: teraToGas('100'), deposit: 0n }),
          { onRetry: retry(`mint of Feather ${token}`) },
        );
        const txHash = outcome.transaction_outcome.id;
        const got = returnedString(outcome);
        if (got) token = got;
        if (live) this.feathers.minted += 1;
        this.tokens = null;
        this.log(`[chain] Feather ${token} (${req.grade}, season ${req.season}) minted on NEAR testnet at once: ${txHash}`);
        return { status: 'sent', txHash, token, mediaSha256: img.sha256Hex };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/MethodNotFound|method.*not found/i.test(msg)) return { status: 'waiting', ...none, note: 'the contract cannot mint at once yet (it needs version 6)' };
        if (/number is taken/i.test(msg)) {
          await pause(PACE_MS);
          if (await this.isThisFeather(token, req).catch(() => false)) {
            this.log(`[chain] Feather ${token} was already on chain: an earlier send had landed`);
            this.tokens = null;
            return { status: 'sent', txHash: null, token, mediaSha256: img.sha256Hex, note: 'an earlier send had landed' };
          }
          return { status: 'failed', ...none, taken: true, note: `Feather ${token} is taken on chain` };
        }
        throw err;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[chain] mint of Feather ${token ?? `#${req.number}`} for season ${req.season} FAILED on NEAR testnet: ${msg.slice(0, 300)}`);
      return { status: 'failed', ...none, note: refusedByRpc(err) ? 'NEAR testnet refused the call, even after a few tries' : msg.slice(0, 200) };
    }
  }

  /** Whether the Feather the contract holds under this token id is this request's (same owner, grade, milestone, season and day). */
  private async isThisFeather(token: string, req: MintRequest): Promise<boolean> {
    const t = await this.view<{ owner_id: string; metadata?: { extra?: string | null } | null } | null>('nft_token', { token_id: token });
    if (!t) return false;
    const x = JSON.parse(t.metadata?.extra ?? '{}') as { number?: number; grade?: string; milestone?: string; season?: string; day?: number };
    return t.owner_id === req.owner && x.number === req.number && x.grade === req.grade && x.milestone === req.milestone && x.season === req.season && x.day === req.day;
  }

  /** A view call, retried with backoff when the RPC refuses a burst (429). */
  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return (await this.provider.callFunction({ contractId: this.cfg.contractId, method, args })) as T;
      } catch (err) {
        if (i >= 4 || !/429|rate limit/i.test(err instanceof Error ? err.message : String(err))) throw err;
        await pause(1500 * 2 ** i);
      }
    }
  }

  async settleLateDays(db: Db, season: string, days: number[]): Promise<LateResult> {
    try {
      await pause(PACE_MS);
      const blocked = await this.preflight();
      if (blocked) return { status: 'skipped', txHash: null, error: blocked, days: [] };
      const head = await this.view<SeasonHead | null>('season_head', { season });
      if (!head) return { status: 'skipped', txHash: null, error: `the contract has no season ${season}`, days: [] };
      await pause(PACE_MS);
      const late = await this.view<{ days: number[]; hash: string } | null>('late_days', { season }).catch((err: unknown) => {
        if (/MethodNotFound|method.*not found/i.test(err instanceof Error ? err.message : String(err))) return null;
        throw err;
      });
      if (!late) return { status: 'skipped', txHash: null, error: 'the contract cannot record days late (upgrade to version 5)', days: [] };
      const sent = await db.query<{ day: number }>(`SELECT day FROM market_days WHERE season = $1 AND settlement_status = 'sent'`, [season]);
      if (!settledCountsAgree(head, sent.map((r) => num(r.day)), late.days)) {
        return {
          status: 'skipped',
          txHash: null,
          error: `the contract counts ${head.days_settled} days settled in ${season}, the database a different number: a day marked failed may have landed, so nothing is recorded late (a person should look)`,
          days: [],
        };
      }
      const todo = lateDaysToSend(days, head, late.days);
      if (!todo.length) return { status: 'skipped', txHash: null, error: 'no missed day the contract can record yet', days: [] };
      const out: LateResult['days'] = [];
      for (const day of todo) {
        const settlement = await buildLateSettlement(db, season, day);
        out.push({ day, settlement, digest: digestOf(settlement) });
      }
      await pause(PACE_MS);
      const outcome = await this.account.callFunctionRaw({
        contractId: this.cfg.contractId,
        methodName: 'settle_late_days',
        args: { season, days: out.map((d) => ({ day: d.day, digest: d.digest })) },
        gas: teraToGas('100'),
        deposit: 0n,
      });
      const txHash = outcome.transaction_outcome.id;
      this.log(`[chain] season ${season} days ${todo.join(', ')} recorded late on NEAR testnet: ${txHash} (digests ${out.map((d) => d.digest.slice(0, 12)).join(', ')})`);
      return { status: 'sent', txHash, days: out };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`[chain] season ${season} late days ${days.join(', ')} FAILED on NEAR testnet: ${error.slice(0, 300)}`);
      return { status: 'failed', txHash: null, error: error.slice(0, 500), days: [] };
    }
  }
}

/** Marks the days a late call recorded as settled, with that call's tx and each day's full settlement and digest. */
export async function storeLateDays(db: Db, season: string, late: LateResult): Promise<void> {
  if (late.status !== 'sent') return;
  for (const d of late.days) {
    await db.query(
      `UPDATE market_days SET settlement_status = 'sent', settlement_tx = $3, settlement_error = NULL, settlement_json = $4, settlement_digest = $5 WHERE season = $1 AND day = $2`,
      [season, d.day, late.txHash, JSON.stringify(d.settlement), d.digest],
    );
  }
}

/** Closed days of a season whose settlement failed or never ran, before a given day (oldest first, at most ten). */
export async function missedDays(db: Db, season: string, before: number): Promise<number[]> {
  const rows = await db.query<{ day: number }>(
    `SELECT day FROM market_days WHERE season = $1 AND day < $2 AND closed_at IS NOT NULL AND settlement_status IN ('failed', 'pending') ORDER BY day LIMIT 10`,
    [season, before],
  );
  return rows.map((r) => num(r.day));
}

/** A call's returned string (a JSON string in the receipt's SuccessValue), or null. */
function returnedString(outcome: unknown): string | null {
  const v = (outcome as { status?: { SuccessValue?: string } } | null)?.status?.SuccessValue;
  if (!v) return null;
  try {
    const x: unknown = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
    return typeof x === 'string' ? x : null;
  } catch {
    return null;
  }
}

/**
 * What the game account really pays, measured on play.coys-game.testnet on 13 November 2026 (account
 * storage one block before and after, gas burnt over every receipt): a Feather mint stores 1,913 to
 * 2,075 bytes (0.0191 to 0.0208 NEAR) and burns 0.0004 to 0.0005 NEAR of gas; a day's settlement
 * burns 0.00081 to 0.00087 NEAR of gas and stores nothing; a new agent wallet needs 182 bytes of its
 * own (0.0018 NEAR) and never pays for anything itself.
 */
export const MEASURED = { mintNear: 0.0213, settleNear: 0.00084, walletStorageNear: 0.0018 } as const;

/**
 * The thresholds the writer keeps, from those costs plus a buffer: each mint keeps its cost and a
 * quarter more; the margin kept free for settlements is 120 day closes of gas (about six real hours at
 * 3-minute days); a wallet is funded with a little over five times what its own storage needs. A mint
 * goes out at 0.127 NEAR free and a new wallet is made at 0.11 (they used to wait for 0.535 and 0.55).
 */
export const RESERVE = {
  mintNear: Math.ceil(MEASURED.mintNear * 1.25 * 1000) / 1000,
  minBalanceNear: Math.round(MEASURED.settleNear * 120 * 100) / 100,
  agentFundingNear: 0.01,
} as const;

/** The gap between this writer's calls to the public RPC, which refuses bursts. */
const PACE_MS = 1500;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createChainWriter(env: NodeJS.ProcessEnv, renderer: FeatherRenderer, log: (line: string) => void): ChainWriter {
  const accountId = env.NEAR_TESTNET_ACCOUNT_ID;
  const privateKey = env.NEAR_TESTNET_PRIVATE_KEY;
  if (!accountId || !privateKey) return new NoopChain('NEAR_TESTNET_ACCOUNT_ID or NEAR_TESTNET_PRIVATE_KEY is not set', log);
  return new TestnetChain(
    {
      accountId,
      privateKey,
      rpcUrl: env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com',
      contractId: env.NEAR_GAME_CONTRACT_ID || accountId,
      mintNear: Number(env.CHAIN_MINT_NEAR || RESERVE.mintNear),
      minBalanceNear: Number(env.CHAIN_MIN_BALANCE_NEAR || RESERVE.minBalanceNear),
      agentFundingNear: Number(env.AGENT_ACCOUNT_FUNDING_NEAR || RESERVE.agentFundingNear),
    },
    renderer,
    log,
  );
}
