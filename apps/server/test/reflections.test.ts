// Weekly reflections in the running game: every 7 in-game days each agent writes one (the template
// here, with no model), it is stored and logged, the next week starts from that day's numbers, and
// the agent's next observation reads it. Agents from before reflections start their first week.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { buildContext, streetView } from '../src/game/cast-runtime';
import { AGENT_COLUMNS, toAgent } from '../src/game/ctx';
import { makeGame, type TestGame } from './helpers';

const nextDay = async (t: TestGame): Promise<void> => {
  t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
  await t.game.endDay();
};

describe('weekly reflections', () => {
  it('each agent reflects every seven days on its own numbers; it is stored, logged and read the next time', async () => {
    const t = await makeGame({ cast: true, seed: 4 });
    for (let d = 0; d < 3; d++) await nextDay(t);
    // an agent from before reflections has no week yet: it starts one at its next decision (day 4)
    await t.db.query(`UPDATE agents SET week_start = NULL WHERE kind = 'trader'`);
    // day 8 closes seven days after day 1: the others reflect
    for (let d = 0; d < 5; d++) await nextDay(t);
    const rows = await t.db.query(`SELECT kind, reflection, reflection_day, week_start FROM agents WHERE status = 'open' AND entrant_key IS NULL ORDER BY kind`);
    for (const r of rows) {
      const week = (typeof r.week_start === 'string' ? JSON.parse(r.week_start) : r.week_start) as { day: number };
      if (r.kind === 'trader') {
        expect(r.reflection).toBeNull();
        expect(week.day).toBe(4);
        continue;
      }
      expect(String(r.reflection)).toMatch(/^Days 1 to 8: cash \d+ to \d+ \([+-]\d+\)/);
      expect(String(r.reflection).length).toBeLessThanOrEqual(400);
      expect(Number(r.reflection_day)).toBe(8);
      expect(week.day).toBe(8);
    }
    expect(t.logs.filter((l) => /reflects on its week \(rules\): Days 1 to 8/.test(l)).length).toBe(rows.length - 1);
    expect(t.game.stats.reflections).toBe(rows.length - 1);
    // the next observation carries it
    const seen = await t.game.withCtx(async (ctx) => {
      const [row] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE kind = 'bakery'`);
      return buildContext(ctx, toAgent(row ?? {}), [], 0, await streetView(ctx));
    });
    expect(seen.agent.reflection).toBe(rows.find((r) => r.kind === 'bakery')?.reflection);
    // the trader reflects seven days after its week started
    for (let d = 0; d < 3; d++) await nextDay(t);
    const [trader] = await t.db.query(`SELECT reflection FROM agents WHERE kind = 'trader'`);
    expect(String(trader?.reflection)).toMatch(/^Days 4 to 11: /);
    await t.db.close();
  }, 120_000);
});
