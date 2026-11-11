// The goal chain: in order, earned by playing, paid once through the ledger.
import { afterEach, describe, expect, it } from 'vitest';
import { GOAL_REWARDS, toMilli } from '@coys/shared';
import { makeGame, type TestGame } from './helpers';

let t: TestGame | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});
let n = 0;
const rid = () => `g${++n}`;

describe('goal chain', () => {
  it('starts open, becomes ready when the player collects, pays once, and keeps its order', async () => {
    t = await makeGame();
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-goal', 'Gus');
    let farm = await t.game.getFarmState(farmId);
    expect(farm.goals.map((g) => g.id)).toEqual(['collect', 'sell', 'coop', 'haggle', 'machine', 'rival']);
    expect(farm.goals[0]).toMatchObject({ id: 'collect', state: 'open', rewardMilli: toMilli(GOAL_REWARDS.collect) });
    // out of order and too early are both refused
    expect(await t.game.act(playerId, { t: 'claimGoal', rid: rid(), goal: 'sell' })).toMatchObject({ ok: false, code: 'invalid_action' });
    expect(await t.game.act(playerId, { t: 'claimGoal', rid: rid(), goal: 'collect' })).toMatchObject({ ok: false, code: 'invalid_action' });

    const egg = farm.layPlan.find((e) => !e.broken);
    if (!egg) throw new Error('no egg planned');
    t.clock.t += egg.atMs + 1;
    expect(await t.game.act(playerId, { t: 'collect', rid: rid(), eggId: egg.id })).toMatchObject({ ok: true });
    farm = await t.game.getFarmState(farmId);
    expect(farm.goals[0]?.state).toBe('ready');
    const cash = farm.cashMilli;
    expect(await t.game.act(playerId, { t: 'claimGoal', rid: rid(), goal: 'collect' })).toMatchObject({ ok: true });
    farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBe(cash + toMilli(GOAL_REWARDS.collect));
    expect(farm.goals[0]?.state).toBe('claimed');
    expect(farm.goals[1]?.state).toBe('open');
    expect(await t.game.act(playerId, { t: 'claimGoal', rid: rid(), goal: 'collect' })).toMatchObject({ ok: false, code: 'invalid_action' });

    // selling the crate readies the next one
    expect(await t.game.act(playerId, { t: 'sell', rid: rid(), items: farm.crate })).toMatchObject({ ok: true });
    farm = await t.game.getFarmState(farmId);
    expect(farm.goals[1]?.state).toBe('ready');
  });
});
