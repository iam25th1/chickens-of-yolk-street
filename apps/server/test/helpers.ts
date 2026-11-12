import { openDb, type Db } from '../src/db/db';
import { InferenceBudget } from '../src/agents/brain';
import type { NearAiClient } from '../src/ai/nearai';
import { buildDayBatch, commitBatch, type DayBatch } from '../src/chain/batch';
import { NoopChain, agentAccountName, type ChainWriter, type SettleResult } from '../src/chain/chain';
import { Game } from '../src/game/game';
import { seededRng } from '../src/game/rng';

export interface TestGame {
  game: Game;
  db: Db;
  clock: { t: number };
  logs: string[];
}

/**
 * A chain writer that does everything the testnet writer does except sign: it names agent wallets
 * under the game account, builds each day's batch, keeps it, and commits the balances it implies,
 * returning a receipt id per (season, day).
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
  constructor(
    readonly gameAccount = 'game.testnet',
    /** Feathers minted per day (0: none). Minting uses a stand-in card image, not the packed art. */
    readonly mintCap = 0,
  ) {}

  async settleDay(db: Db, season: string, day: number): Promise<SettleResult> {
    for (const a of await db.query('SELECT id, kind, generation FROM agents WHERE near_account_id IS NULL')) {
      await db.query('UPDATE agents SET near_account_id = $2 WHERE id = $1', [a.id, agentAccountName(String(a.kind), Number(a.generation), this.gameAccount)]);
    }
    const renderer = this.mintCap
      ? { render: (grade: string, n: number) => ({ dataUri: `data:image/png;base64,${grade}${n}`, sha256Base64: 'stand-in', sha256Hex: `stand-in-${grade}-${n}` }) }
      : null;
    const feathers = this.featherMinted === null ? null : { cap: this.mintCap, base: this.featherMinted };
    const built = await buildDayBatch(db, season, day, { feathers, renderer: renderer as never });
    this.batches.push(built.batch);
    const txHash = `recorded-${season}-${day}`;
    await commitBatch(db, built, txHash);
    if (this.featherMinted !== null) this.featherMinted += built.minted.length;
    const result: SettleResult = { status: 'sent', txHash, minted: built.minted, settlement: built.settlement, digest: built.batch.digest };
    this.settlements.push(result);
    return result;
  }
}

export async function makeGame(
  opts: { cast?: boolean; seed?: number; client?: NearAiClient | null; capUsd?: number; season?: string; db?: Db; chain?: ChainWriter } = {},
): Promise<TestGame> {
  const db = opts.db ?? (await openDb('memory://'));
  const clock = { t: Date.UTC(2026, 10, 11, 12) };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const game = new Game({
    db,
    chain: opts.chain ?? new NoopChain('test', log),
    now: () => clock.t,
    rng: seededRng(opts.seed ?? 42),
    log,
    cast: opts.cast ?? false,
    season: opts.season ?? null,
    brain: {
      client: opts.client ?? null,
      budget: new InferenceBudget(db, opts.capUsd ?? 1, () => clock.t),
      model: 'test/main',
      cheapModel: 'test/cheap',
      pricing: new Map([
        ['test/main', { input: 1, output: 5 }],
        ['test/cheap', { input: 0.1, output: 0.5 }],
      ]),
    },
  });
  await game.init();
  return { game, db, clock, logs };
}
