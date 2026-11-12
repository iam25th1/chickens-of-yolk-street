// Removing a player: the farm leaves the market (players count, demand, ranking) with every row it
// owned; other farms are untouched.
import { describe, expect, it } from 'vitest';
import { makeGame } from '../../apps/server/test/helpers';
import { planRemoval, removePlayer } from '../lib/remove';

describe('remove-player', () => {
  it('takes a player farm out of the game entirely and leaves the rest', async () => {
    const t = await makeGame({ cast: true, seed: 11 });
    const keep = await t.game.ensurePlayer('dev', 'device-keep', 'Kay');
    const gone = await t.game.ensurePlayer('dev', 'device-gone', 'Verify Bot');
    expect(await t.game.act(gone.playerId, { t: 'buyUnlock', rid: 'u1', unlock: 'conveyor' })).toMatchObject({ ok: true });
    const before = await t.game.getMarketState();
    expect(before.farms.players).toBe(2);
    expect(before.ranking.some((r) => r.name.startsWith('Verify Bot'))).toBe(true);

    const plan = await planRemoval(t.db, gone.playerId);
    expect(plan.rows.hens).toBe(10);
    expect(plan.rows.unlocks).toBe(1);
    await removePlayer(t.db, gone.playerId);

    const after = await t.game.getMarketState();
    expect(after.farms.players).toBe(1);
    expect(after.ranking.some((r) => r.name.startsWith('Verify Bot'))).toBe(false);
    expect(after.reference).toBeLessThan(before.reference);
    for (const table of ['hens', 'coops', 'unlocks', 'ledger', 'cards', 'lay_events'])
      expect((await t.db.query(`SELECT count(*) AS n FROM ${table} WHERE farm_id = $1`, [gone.farmId]))[0]?.n).toBe(0);
    expect(await t.db.query('SELECT 1 FROM players WHERE id = $1', [gone.playerId])).toHaveLength(0);
    // the other farm is untouched
    expect((await t.game.getFarmState(keep.farmId)).hens).toHaveLength(10);
    await expect(planRemoval(t.db, gone.playerId)).rejects.toThrow('no player');
    await t.db.close();
  });
});
