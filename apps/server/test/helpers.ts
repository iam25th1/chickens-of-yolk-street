import { openDb, type Db } from '../src/db/db';
import { NoopSettlement, type SettlementPayload, type SettlementResult, type SettlementWriter } from '../src/chain/settlement';
import { Game } from '../src/game/game';
import type { RivalSpec } from '../src/game/agents';
import { seededRng } from '../src/game/rng';

export class RecordingSettlement implements SettlementWriter {
  readonly mode = 'noop' as const;
  readonly payloads: SettlementPayload[] = [];
  private readonly inner = new NoopSettlement('test', () => undefined);
  async write(payload: SettlementPayload): Promise<SettlementResult> {
    this.payloads.push(payload);
    return this.inner.write(payload);
  }
}

export interface TestGame {
  game: Game;
  db: Db;
  settlement: RecordingSettlement;
  clock: { t: number };
}

export async function makeGame(opts: { rivals?: readonly RivalSpec[]; seed?: number } = {}): Promise<TestGame> {
  const db = await openDb('memory://');
  const clock = { t: 1_000_000 };
  const settlement = new RecordingSettlement();
  const game = new Game({
    db,
    settlement,
    now: () => clock.t,
    rng: seededRng(opts.seed ?? 42),
    rivals: opts.rivals ?? [],
    log: () => undefined,
  });
  await game.init();
  return { game, db, settlement, clock };
}
