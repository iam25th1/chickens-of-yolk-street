// Daily settlement on NEAR testnet.
//
// Choice: one FunctionCall per day, record_day on the settlement log contract, carrying the day's
// net trade results as JSON arguments. Why this and not transfers:
// - a NEAR transaction has a single receiver, so paying each farm would be one transaction per
//   farm per day, not one batch;
// - a Transfer action carries no memo, so it cannot record what the money was for;
// - coins are game money, so moving NEAR equal to coin results would misstate them.
// A FunctionCall's arguments are stored with the transaction, so one call records the whole day,
// is readable in any explorer, and costs one signature from the server's testnet account.
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { SETTLEMENT_LOG_METHOD } from './settlement-log-wasm';

export interface SettlementFarm {
  farm: string;
  owner: 'player' | 'agent';
  account: string | null;
  netMilli: number;
}

export interface SettlementPayload {
  game: 'chickens-of-yolk-street';
  v: 1;
  day: number;
  closedAt: number;
  supply: number;
  multiplier: number;
  nextMultiplier: number;
  farms: SettlementFarm[];
  /** SHA-256 of the canonical JSON of farms, so the batch can be checked against the server's ledger. */
  digest: string;
}

export interface SettlementResult {
  status: 'sent' | 'noop' | 'failed';
  txHash: string | null;
  error?: string;
}

export interface SettlementWriter {
  readonly mode: 'noop' | 'near-testnet';
  write(payload: SettlementPayload): Promise<SettlementResult>;
}

export const settlementDigest = (farms: SettlementFarm[]): string =>
  createHash('sha256').update(JSON.stringify(farms)).digest('hex');

export class NoopSettlement implements SettlementWriter {
  readonly mode = 'noop' as const;
  constructor(
    private readonly reason: string,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  async write(payload: SettlementPayload): Promise<SettlementResult> {
    this.log(
      `[settlement] !!! NO-OP for day ${payload.day}: ${this.reason}. ` +
        `The batch (${payload.farms.length} farms, digest ${payload.digest.slice(0, 12)}) is recorded in market_days only, not on NEAR testnet.`,
    );
    return { status: 'noop', txHash: null };
  }
}

export interface TestnetConfig {
  accountId: string;
  privateKey: string;
  rpcUrl: string;
  contractId: string;
}

/** Throws unless the config can only ever touch testnet. Checked before any key is loaded. */
export function assertTestnetConfig(cfg: TestnetConfig): void {
  for (const id of [cfg.accountId, cfg.contractId]) {
    const implicit = /^[0-9a-f]{64}$/.test(id);
    if (!implicit && !id.endsWith('.testnet')) throw new Error(`refusing non-testnet account ${id}`);
  }
  if (!/test/i.test(new URL(cfg.rpcUrl).hostname)) throw new Error(`refusing RPC ${cfg.rpcUrl}: not a testnet endpoint`);
  if (!cfg.privateKey.startsWith('ed25519:')) throw new Error('NEAR_TESTNET_PRIVATE_KEY must be an ed25519:... key');
}

export class NearTestnetSettlement implements SettlementWriter {
  readonly mode = 'near-testnet' as const;
  private readonly provider: JsonRpcProvider;
  private chainChecked = false;

  constructor(
    private readonly cfg: TestnetConfig,
    private readonly log: (line: string) => void = console.log,
  ) {
    assertTestnetConfig(cfg);
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  }

  async write(payload: SettlementPayload): Promise<SettlementResult> {
    try {
      if (!this.chainChecked) {
        const status = await this.provider.viewNodeStatus();
        if (status.chain_id !== 'testnet') throw new Error(`RPC reports chain ${status.chain_id}, not testnet; nothing signed`);
        this.chainChecked = true;
      }
      const signer = KeyPairSigner.fromSecretKey(this.cfg.privateKey as KeyPairString);
      const account = new Account(this.cfg.accountId, this.provider, signer);
      const outcome = await account.callFunctionRaw({
        contractId: this.cfg.contractId,
        methodName: SETTLEMENT_LOG_METHOD,
        args: payload as unknown as Record<string, unknown>,
        gas: teraToGas('30'),
        deposit: 0n,
      });
      const txHash = outcome.transaction_outcome.id;
      this.log(`[settlement] day ${payload.day} written to NEAR testnet: ${txHash}`);
      return { status: 'sent', txHash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`[settlement] day ${payload.day} FAILED on NEAR testnet: ${error}`);
      return { status: 'failed', txHash: null, error };
    }
  }
}

export function createSettlementWriter(env: NodeJS.ProcessEnv, log: (line: string) => void): SettlementWriter {
  const accountId = env.NEAR_TESTNET_ACCOUNT_ID;
  const privateKey = env.NEAR_TESTNET_PRIVATE_KEY;
  if (!accountId || !privateKey) {
    return new NoopSettlement('NEAR_TESTNET_ACCOUNT_ID or NEAR_TESTNET_PRIVATE_KEY is not set', log);
  }
  return new NearTestnetSettlement(
    {
      accountId,
      privateKey,
      rpcUrl: env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com',
      contractId: env.NEAR_SETTLEMENT_CONTRACT_ID || accountId,
    },
    log,
  );
}
