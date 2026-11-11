import { openDb, type Db } from '../src/db/db';
import { InferenceBudget } from '../src/agents/brain';
import type { NearAiClient } from '../src/ai/nearai';
import { NoopChain } from '../src/chain/chain';
import { Game } from '../src/game/game';
import { seededRng } from '../src/game/rng';

export interface TestGame {
  game: Game;
  db: Db;
  clock: { t: number };
  logs: string[];
}

export async function makeGame(opts: { cast?: boolean; seed?: number; client?: NearAiClient | null; capUsd?: number } = {}): Promise<TestGame> {
  const db = await openDb('memory://');
  const clock = { t: Date.UTC(2026, 10, 11, 12) };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const game = new Game({
    db,
    chain: new NoopChain('test', log),
    now: () => clock.t,
    rng: seededRng(opts.seed ?? 42),
    log,
    cast: opts.cast ?? false,
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
