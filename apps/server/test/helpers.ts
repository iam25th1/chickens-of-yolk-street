import { openDb, type Db } from '../src/db/db';
import { InferenceBudget, type Pricing } from '../src/agents/brain';
import { ProviderChain } from '../src/ai/chain';
import type { InferenceProvider } from '../src/ai/provider';
import { buildDayBatch, buildLateSettlement, commitBatch, digestOf, type DayBatch } from '../src/chain/batch';
import { NoopChain, assignAgentWallets, type ChainWriter, type LateResult, type MintRequest, type MintResult, type SettleResult } from '../src/chain/chain';
import { tokenFor, type Collection } from '../src/chain/mint';
import { Game } from '../src/game/game';
import { seededRng } from '../src/game/rng';

export interface TestGame {
  game: Game;
  db: Db;
  clock: { t: number };
  logs: string[];
}

/**
 * A chain writer that does everything the testnet writer does except sign: it gives agents wallets
 * under the game account from the same pool (a free one first, else a new one it records as funded
 * with `fundingNear`), builds each day's batch (which never mints: Feathers mint at once), keeps
 * it, and commits the balances it implies, returning a receipt id per (season, day). Its mints keep
 * the contract's rules (a token id once, the 777 for the live season, a test collection otherwise),
 * and `script` makes the next mints refused by the RPC, waiting, or taken.
 */
export class RecordingChain implements ChainWriter {
  readonly mode = 'near-testnet' as const;
  readonly explorer = 'https://testnet.nearblocks.io/txns/';
  readonly minting = 'live' as const;
  readonly provenance = null;
  readonly contractId = 'game.testnet';
  readonly batches: DayBatch[] = [];
  readonly settlements: SettleResult[] = [];
  /** The contract's Feather count (a version 4 contract starts at 0; null: an older contract without Feathers). */
  featherMinted: number | null = 0;
  /** The contract's live season (version 5); undefined: a version 4 contract, which has none. */
  liveSeason: string | null | undefined = undefined;
  /** Days recorded late, in call order. */
  readonly late: LateResult[] = [];
  /** Every mint asked for, in order, and the tokens the contract holds (token id: the request). */
  readonly mints: MintRequest[] = [];
  readonly tokens = new Map<string, MintRequest>();
  /** What the next mints do instead of minting: refused by the RPC (after its retries), waiting, or a number taken. */
  script: ('refuse' | 'wait' | 'taken')[] = [];
  /** Agent wallets it created (funded), in order, and the pool's log lines. */
  readonly created: string[] = [];
  readonly walletLog: string[] = [];
  fundingNear = 0.05;
  constructor(
    readonly gameAccount = 'game.testnet',
    /** Unused since Feathers mint at once; kept so older tests construct the same way. */
    readonly mintCap = 0,
  ) {}

  async collectionFor(season: string): Promise<Collection> {
    return this.liveSeason === undefined || this.liveSeason === season ? 'live' : 'test';
  }

  async mintFeather(req: MintRequest): Promise<MintResult> {
    this.mints.push(req);
    const none = { txHash: null, token: null, mediaSha256: null };
    const next = this.script.shift();
    if (next === 'refuse') return { status: 'failed', ...none, note: 'NEAR testnet refused the call, even after a few tries' };
    if (next === 'wait') return { status: 'waiting', ...none, note: 'the game account is low on testnet NEAR' };
    const collection = await this.collectionFor(req.season);
    const token = tokenFor(collection, req.season, req.number);
    if (next === 'taken' || this.tokens.has(token)) return { status: 'failed', ...none, taken: true, note: `Feather ${token} is taken on chain` };
    this.tokens.set(token, req);
    if (collection === 'live' && this.featherMinted !== null) this.featherMinted += 1;
    return { status: 'sent', txHash: `minted-${token}`, token, mediaSha256: `stand-in-${req.grade}-${req.number}` };
  }

  async settleDay(db: Db, season: string, day: number): Promise<SettleResult> {
    await this.linkWallets(db);
    // as the testnet writer: a day's settlement never mints Feathers
    const feathers = this.featherMinted === null ? null : { cap: 0, base: this.featherMinted };
    const built = await buildDayBatch(db, season, day, { feathers, renderer: null });
    this.batches.push(built.batch);
    const txHash = `recorded-${season}-${day}`;
    await commitBatch(db, built, txHash);
    if (this.featherMinted !== null) this.featherMinted += built.minted.length;
    const result: SettleResult = { status: 'sent', txHash, minted: built.minted, settlement: built.settlement, digest: built.batch.digest };
    this.settlements.push(result);
    return result;
  }

  /** What the testnet writer does at each settlement: every open agent without a wallet gets one from the pool. */
  async linkWallets(db: Db): Promise<void> {
    await assignAgentWallets(
      db,
      this.gameAccount,
      async ({ account }) => {
        this.created.push(account);
        return this.fundingNear;
      },
      (line) => this.walletLog.push(line),
      () => 0,
    );
  }

  async settleLateDays(db: Db, season: string, days: number[]): Promise<LateResult> {
    const out: LateResult['days'] = [];
    for (const day of days) {
      const settlement = await buildLateSettlement(db, season, day);
      out.push({ day, settlement, digest: digestOf(settlement) });
    }
    const result: LateResult = { status: 'sent', txHash: `late-${season}-${days.join('-')}`, days: out };
    this.late.push(result);
    return result;
  }
}

export async function makeGame(
  opts: {
    cast?: boolean;
    seed?: number;
    client?: InferenceProvider | null;
    /** The whole provider chain, in order, instead of one client. */
    providers?: InferenceProvider[];
    capUsd?: number;
    season?: string;
    db?: Db;
    chain?: ChainWriter;
    /** Priced as the server prices the models (ASSUMED_PRICING), instead of 1 in, 5 out for main models and 0.1 in, 0.5 out for cheap ones. */
    realModels?: boolean;
  } = {},
): Promise<TestGame> {
  const db = opts.db ?? (await openDb('memory://'));
  const clock = { t: Date.UTC(2026, 10, 11, 12) };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const providers = opts.providers ?? (opts.client ? [opts.client] : []);
  const testPrices = new Map<string, Pricing>(providers.flatMap((p): [string, Pricing][] => [[p.cheapModel, { input: 0.1, output: 0.5 }], [p.model, { input: 1, output: 5 }]]));
  const game = new Game({
    db,
    chain: opts.chain ?? new NoopChain('test', log),
    now: () => clock.t,
    rng: seededRng(opts.seed ?? 42),
    log,
    cast: opts.cast ?? false,
    season: opts.season ?? null,
    brain: {
      // pacing gaps are not waited for in tests
      chain: new ProviderChain(providers, { sleep: async () => undefined }),
      budget: new InferenceBudget(db, opts.capUsd ?? 1, () => clock.t),
      pricing: opts.realModels ? new Map() : testPrices,
    },
  });
  await game.init();
  return { game, db, clock, logs };
}
