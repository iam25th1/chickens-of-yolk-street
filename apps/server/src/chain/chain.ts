// The chain writer. Once per in-game day it sends one settle_day call to the game contract on
// NEAR testnet, carrying the batch from batch.ts. Agents get testnet sub-accounts of the game
// account (funded from it) so their tokens have a home. Without testnet credentials, or before the
// contract is deployed, every day is built the same way and recorded as a loud no-op.
//
// Founding Hens are minted only by a contract that has them (version 3, which answers
// founding_supply), and only as many as the game account's free balance can store: each mint keeps
// CHAIN_MINT_NEAR in reserve on top of a CHAIN_MIN_BALANCE_NEAR margin. The margin defaults to
// about one real day of settlements at 3-minute days (measured on s1: 179 bytes of state and
// 0.0004 NEAR of gas per settled day, 480 days a real day, so about 1.06 NEAR), so nothing optional
// (mints, linking or creating agent wallets) ever eats into the days' own settlements. A hen that
// cannot be minted yet waits for a later day close.
import { createHmac } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Account, JsonRpcProvider, KeyPairSigner, baseEncode, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { num, type Db } from '../db/db';
import { ECONOMY } from '@coys/shared';
import { buildDayBatch, commitBatch } from './batch';
import type { HenRenderer } from './hen-image';

export interface SettleResult {
  status: 'sent' | 'noop' | 'failed';
  txHash: string | null;
  error?: string;
  /** Founding Hens this settlement minted, and each one's number of 777. */
  minted?: string[];
  numbers?: Map<string, number>;
}

export interface ChainWriter {
  readonly mode: 'noop' | 'near-testnet';
  /** Explorer base for transaction receipts, or null. */
  readonly explorer: string | null;
  /** Whether day closes mint Founding Hens: live, paused (game account low, or its contract has no Founding Hens yet), or off. */
  readonly minting: 'live' | 'paused' | 'off';
  /** Founding Hens the contract has minted, as last read; null without a chain or before version 3. */
  readonly foundingMinted: number | null;
  /** Settles one closed day of a season. */
  settleDay(db: Db, season: string, day: number): Promise<SettleResult>;
}

export interface TestnetConfig {
  accountId: string;
  privateKey: string;
  rpcUrl: string;
  contractId: string;
  /** NEAR kept free for each Founding Hen minted (her token's storage). */
  mintNear: number;
  /** NEAR always kept free on the game account, on top of the mints' reserve. */
  minBalanceNear: number;
  agentFundingNear: number;
}

/** How many Founding Hens a free balance can mint now: each keeps mintNear, above the margin. */
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

export class NoopChain implements ChainWriter {
  readonly mode = 'noop' as const;
  readonly explorer = null;
  readonly minting = 'off' as const;
  readonly foundingMinted = null;
  constructor(
    private readonly reason: string,
    private readonly log: (line: string) => void,
  ) {}

  async settleDay(db: Db, season: string, day: number): Promise<SettleResult> {
    const built = await buildDayBatch(db, season, day, { founding: null, renderer: null });
    this.log(
      `[chain] !!! NO-OP for season ${season} day ${day}: ${this.reason}. Batch built (${built.batch.farms.length} farms, ` +
        `digest ${built.batch.digest.slice(0, 12)}) and recorded in market_days only, not on NEAR testnet.`,
    );
    return { status: 'noop', txHash: null };
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
  /** The contract's founding count; null until read, or when the contract is version 2. */
  private founding: number | null = null;

  constructor(
    private readonly cfg: TestnetConfig,
    private readonly renderer: HenRenderer,
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
    this.readFounding().then(
      (n) => {
        this.founding = n;
      },
      () => undefined,
    );
  }

  get minting(): 'live' | 'paused' {
    return this.low || this.founding === null ? 'paused' : 'live';
  }

  get foundingMinted(): number | null {
    return this.founding;
  }

  /** The contract's Founding Hen count, or null when it has none (version 2: no founding_supply). */
  private async readFounding(): Promise<number | null> {
    try {
      const r = await this.provider.callFunction<{ minted: number; max: number; remaining: number }>({
        contractId: this.cfg.contractId,
        method: 'founding_supply',
        args: {},
      });
      return typeof r?.minted === 'number' ? r.minted : null;
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
      this.founding = await this.readFounding();
      const affordable = mintsAffordable(await this.balanceNear(), this.cfg, ECONOMY.founding.mintsPerBatch);
      this.low = affordable === 0;
      const founding = this.founding === null ? null : { cap: affordable, base: this.founding };
      const built = await buildDayBatch(db, season, day, { founding, renderer: this.renderer });
      const waiting = await db.query(`SELECT count(*) AS n FROM hens WHERE founding_milestone IS NOT NULL AND chain_owner IS NULL AND status = 'alive'`);
      const left = num(waiting[0]?.n) - built.minted.length;
      if (left > 0) {
        this.log(
          this.founding === null
            ? `[chain] ${left} Founding Hens wait: the contract has no Founding Hens yet (upgrade to version 3)`
            : `[chain] ${left} Founding Hens wait: the game account can store ${affordable} mints now (each keeps ${this.cfg.mintNear} NEAR)`,
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
      if (this.founding !== null) this.founding += built.minted.length;
      this.log(
        `[chain] season ${season} day ${day} settled on NEAR testnet: ${txHash} (${built.batch.eggs.length} egg moves, ${built.minted.length} Founding Hens minted, ${built.batch.hen_moves.length} hens moved)`,
      );
      return { status: 'sent', txHash, minted: built.minted, numbers: built.numbers };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`[chain] season ${season} day ${day} FAILED on NEAR testnet: ${error.slice(0, 300)}`);
      return { status: 'failed', txHash: null, error: error.slice(0, 500) };
    }
  }
}

export function createChainWriter(env: NodeJS.ProcessEnv, renderer: HenRenderer, log: (line: string) => void): ChainWriter {
  const accountId = env.NEAR_TESTNET_ACCOUNT_ID;
  const privateKey = env.NEAR_TESTNET_PRIVATE_KEY;
  if (!accountId || !privateKey) return new NoopChain('NEAR_TESTNET_ACCOUNT_ID or NEAR_TESTNET_PRIVATE_KEY is not set', log);
  return new TestnetChain(
    {
      accountId,
      privateKey,
      rpcUrl: env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com',
      contractId: env.NEAR_GAME_CONTRACT_ID || accountId,
      mintNear: Number(env.CHAIN_MINT_NEAR || 0.03),
      minBalanceNear: Number(env.CHAIN_MIN_BALANCE_NEAR || 1.25),
      agentFundingNear: Number(env.AGENT_ACCOUNT_FUNDING_NEAR || 0.05),
    },
    renderer,
    log,
  );
}
