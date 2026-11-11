// The chain writer. Once per in-game day it sends one settle_day call to the game contract on
// NEAR testnet, carrying the batch from batch.ts. Agents get testnet sub-accounts of the game
// account (funded from it) so their tokens have a home. Without testnet credentials, or before the
// contract is deployed, every day is built the same way and recorded as a loud no-op.
import { createHmac } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Account, JsonRpcProvider, KeyPairSigner, baseEncode, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { num, type Db } from '../db/db';
import { buildDayBatch, commitBatch } from './batch';
import type { HenRenderer } from './hen-image';

export interface SettleResult {
  status: 'sent' | 'noop' | 'failed';
  txHash: string | null;
  error?: string;
}

export interface ChainWriter {
  readonly mode: 'noop' | 'near-testnet';
  /** Explorer base for transaction receipts, or null. */
  readonly explorer: string | null;
  /** Settles one closed day of a season. */
  settleDay(db: Db, season: string, day: number): Promise<SettleResult>;
}

export interface TestnetConfig {
  accountId: string;
  privateKey: string;
  rpcUrl: string;
  contractId: string;
  henMintCap: number;
  minBalanceNear: number;
  agentFundingNear: number;
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
  constructor(
    private readonly reason: string,
    private readonly log: (line: string) => void,
  ) {}

  async settleDay(db: Db, season: string, day: number): Promise<SettleResult> {
    const built = await buildDayBatch(db, season, day, { henMintCap: 0, renderer: null });
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

  constructor(
    private readonly cfg: TestnetConfig,
    private readonly renderer: HenRenderer,
    private readonly log: (line: string) => void,
  ) {
    assertTestnetConfig(cfg);
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.account = new Account(cfg.accountId, this.provider, KeyPairSigner.fromSecretKey(cfg.privateKey as KeyPairString));
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

  /** Each open agent gets a funded sub-account of the game account. */
  private async ensureAgentAccounts(db: Db): Promise<void> {
    const agents = await db.query(`SELECT id, kind, generation FROM agents WHERE status = 'open' AND near_account_id IS NULL ORDER BY kind`);
    for (const a of agents) {
      if ((await this.balanceNear()) < this.cfg.minBalanceNear + this.cfg.agentFundingNear) {
        this.log('[chain] game account balance is low; agent sub-accounts wait');
        return;
      }
      const name = agentAccountName(String(a.kind), num(a.generation), this.cfg.accountId);
      try {
        const exists = await new Account(name, this.provider).getState().then(
          () => true,
          () => false,
        );
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
      const lowBalance = (await this.balanceNear()) < this.cfg.minBalanceNear;
      const built = await buildDayBatch(db, season, day, { henMintCap: lowBalance ? 0 : this.cfg.henMintCap, renderer: this.renderer });
      if (lowBalance) this.log('[chain] game account balance is low; hen mints wait for a top-up');
      const outcome = await this.account.callFunctionRaw({
        contractId: this.cfg.contractId,
        methodName: 'settle_day',
        args: { batch: built.batch },
        gas: teraToGas('300'),
        deposit: 0n,
      });
      const txHash = outcome.transaction_outcome.id;
      await commitBatch(db, built);
      this.log(
        `[chain] season ${season} day ${day} settled on NEAR testnet: ${txHash} (${built.batch.eggs.length} egg moves, ${built.batch.hen_mints.length} hens minted, ${built.batch.hen_moves.length} moved)`,
      );
      return { status: 'sent', txHash };
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
      henMintCap: Number(env.CHAIN_HEN_MINTS_PER_DAY || 12),
      minBalanceNear: Number(env.CHAIN_MIN_BALANCE_NEAR || 2),
      agentFundingNear: Number(env.AGENT_ACCOUNT_FUNDING_NEAR || 0.05),
    },
    renderer,
    log,
  );
}
