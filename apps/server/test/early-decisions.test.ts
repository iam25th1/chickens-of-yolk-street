// The agents decide ahead of midnight: in the day's last stretch the tick gathers their decisions in
// the background, and the close uses them instead of waiting on model calls of its own.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { makeGame } from './helpers';

describe('decisions gathered ahead of midnight', () => {
  it('the last stretch of the day gathers them once, and the close uses them without gathering again', async () => {
    const t = await makeGame({ cast: true, seed: 3 });
    const game = t.game as unknown as { gatherDecisions: () => Promise<unknown[]> };
    const real = game.gatherDecisions.bind(t.game);
    let calls = 0;
    game.gatherDecisions = async () => {
      calls++;
      return real();
    };
    const start = t.game.getClock().dayStartedAt;
    // early in the day: nothing yet
    t.clock.t = start + 10_000;
    await t.game.tick();
    expect(calls).toBe(0);
    // within the last stretch: gathered once, however often the tick runs
    t.clock.t = start + ECONOMY.day.lengthMs - 20_000;
    await t.game.tick();
    await t.game.tick();
    expect(calls).toBe(1);
    // midnight: the close uses them
    t.clock.t = start + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(calls).toBe(1);
    // the next day without an early gather: the close gathers itself
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(calls).toBe(2);
    await t.db.close();
  }, 120_000);
});
