// The chain writer. Once per in-game day it sends one settle_day call to the game contract on
// NEAR testnet, carrying the batch from batch.ts: the egg moves, the net totals of the farms whose
// eggs move, the day's Feathers, and the SHA-256 of the full settlement (kept in the database). A
// version 4 contract stores only a fixed-size head per season, so a settled day adds no storage
// (measured on s1 before: 179 bytes a day, 480 days a real day, about 0.86 NEAR a real day; gas
// is about 0.0004 NEAR a day either way). Agents get testnet sub-accounts of the game account
// (funded from it) so their tokens have a home. Without testnet credentials, or before the
// contract is deployed, every day is built the same way and recorded as a loud no-op.
//
// Feathers are minted only by a contract that has them (version 4, which answers feather_supply),
// and only as many as the game account's free balance can store: each mint keeps CHAIN_MINT_NEAR
// in reserve on top of a CHAIN_MIN_BALANCE_NEAR margin (default 0.5 NEAR: a few real days of
// settlement gas), so nothing optional (mints, linking or creating agent wallets) ever eats into
// the days' own settlements. A redeemed ticket that cannot be minted yet waits for a later day.
// From version 5 the contract names its live season and mints Feathers for that season only, so a
// test season can never mint against the real 777: this writer sends no mints unless the server's
// season is the contract's live season (and the contract refuses them anyway).
//
// A day whose close failed to settle (a refused RPC call, say) is caught up later: the next day's
// moves already bring every egg balance up to date, so the missed day is recorded by its digest
// alone with settle_late_days (version 5), paced, once the season has moved past it.
import { createHmac } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Account, JsonRpcProvider, KeyPairSigner, baseEncode, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { num, type Db } from '../db/db';
import { ECONOMY, type FeatherGrade, type MilestoneId } from '@coys/shared';
import { buildDayBatch, buildLateSettlement, commitBatch, digestOf, type FullSettlement, type MintedFeather } from './batch';
import type { FeatherRenderer } from './feather-image';

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

/** Whether day closes may send Feather mints to this contract for this season: version 4 has no live season (always), version 5 only its live one. */
export function seasonMayMint(liveSeason: string | null | undefined, season: string): boolean {
  return liveSeason === undefined || liveSeason === season;
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

/**
 * The wallet a new agent takes over: the most recent bust agent of the same kind's, if any. A rival
 * that goes bust is replaced by a successor of its kind (often, in a lively market: on s1 about 30
 * times a real day at 3-minute days), and a fresh funded sub-account for each would cost about
 * 0.057 NEAR every time, so the successor carries on in its predecessor's wallet instead.
 */
export async function successorWallet(db: Db, kind: string): Promise<string | null> {
  const [prev] = await db.query<{ near_account_id: string }>(
    `SELECT near_account_id FROM agents WHERE kind = $1 AND status = 'bust' AND near_account_id IS NOT NULL ORDER BY generation DESC LIMIT 1`,
    [kind],
  );
  return prev?.near_account_id ?? null;
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
   * Each open agent gets a funded sub-account of the game account. A wallet that already exists on
   * chain only needs linking (its egg balances then take a little state); creating one also needs
   * its funding. Both wait while the game account is under its margin.
   */
  private async ensureAgentAccounts(db: Db): Promise<void> {
    const agents = await db.query(`SELECT id, kind, generation FROM agents WHERE status = 'open' AND near_account_id IS NULL ORDER BY kind`);
    if (!agents.length) return;
    if ((await this.balanceNear()) < this.cfg.minBalanceNear) {
      this.log(`[chain] game account under its ${this.cfg.minBalanceNear} NEAR margin; ${agents.length} agent wallets wait to be linked`);
      return;
    }
    let lowSaid = false;
    for (const a of agents) {
      const inherited = await successorWallet(db, String(a.kind));
      if (inherited) {
        await db.query('UPDATE agents SET near_account_id = $2 WHERE id = $1', [a.id, inherited]);
        this.log(`[chain] ${String(a.kind)} ${num(a.generation)} takes over its predecessor's wallet ${inherited}`);
        continue;
      }
      const name = agentAccountName(String(a.kind), num(a.generation), this.cfg.accountId);
      try {
        const exists = await new Account(name, this.provider).getState().then(
          () => true,
          () => false,
        );
        if (!exists && (await this.balanceNear()) < this.cfg.minBalanceNear + this.cfg.agentFundingNear) {
          if (!lowSaid) this.log('[chain] game account balance is low; new agent sub-accounts wait');
          lowSaid = true;
          continue;
        }
        if (!exists) {
          await this.account.createSubAccount({
            accountOrPrefix: name,
            publicKey: agentPublicKey(this.cfg.privateKey, String(a.kind), num(a.generation)),
            nearToTransfer: nearToYocto(this.cfg.agentFundingNear),
          });
          this.log(`[chain] created agent wallet ${name}`);
        }
        await db.query('UPDATE agents SET near_account_id = $2 WHERE id = $1', [a.id, name]);
      } catch (err) {
        this.log(`[chain] could not create ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
      const affordable = mintsAffordable(await this.balanceNear(), this.cfg, ECONOMY.feathers.mintsPerBatch);
      this.low = affordable === 0;
      const mayMint = this.feathers !== null && seasonMayMint(this.feathers.liveSeason, season);
      const feathers = this.feathers === null ? null : { cap: mayMint ? affordable : 0, base: this.feathers.minted };
      const built = await buildDayBatch(db, season, day, { feathers, renderer: this.renderer });
      const waiting = await db.query(`SELECT count(*) AS n FROM feather_tickets WHERE status = 'queued' AND season = $1`, [season]);
      const left = num(waiting[0]?.n) - built.minted.length;
      if (left > 0) {
        this.log(
          this.feathers === null
            ? `[chain] ${left} redeemed Feathers wait: the contract has no Feathers yet (upgrade to version 4)`
            : !mayMint
              ? `[chain] ${left} redeemed Feathers wait: season ${season} is not the contract's live season (${this.feathers.liveSeason ?? 'none set'}), so it mints none`
              : `[chain] ${left} redeemed Feathers wait: the game account can store ${affordable} mints now (each keeps ${this.cfg.mintNear} NEAR), or their player has no wallet linked`,
        );
      }
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
      mintNear: Number(env.CHAIN_MINT_NEAR || 0.035),
      minBalanceNear: Number(env.CHAIN_MIN_BALANCE_NEAR || 0.5),
      agentFundingNear: Number(env.AGENT_ACCOUNT_FUNDING_NEAR || 0.05),
    },
    renderer,
    log,
  );
}
