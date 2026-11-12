// Founding Hens: good standing, milestones, the auditable roll and its odds, the 777 cap, and
// ordinary hens never minted.
import { describe, expect, it } from 'vitest';
import { ECONOMY, MILESTONE_IDS, UNLOCK_IDS } from '@coys/shared';
import { foundingCount, reached, rollFor, rollMilestones, standing } from '../src/game/founding';
import type { Queryable } from '../src/db/db';
import { RecordingChain, makeGame, type TestGame } from './helpers';

const F = ECONOMY.founding;

async function player(t: TestGame, name = 'Ada'): Promise<{ playerId: string; farmId: string }> {
  return t.game.ensurePlayer('dev', `device-${name.toLowerCase()}-0001`, name);
}

/** Puts a plain hen on a farm inside the roll's own transaction. */
const newHen = (q: Queryable) => async (farmId: string): Promise<string> => {
  const id = `fh-${farmId.slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}`;
  await q.query(
    `INSERT INTO hens (id, farm_id, status, body, eyes, comb, accessory, laying_trait, born_day) VALUES ($1, $2, 'alive', 'brown', 'default', 'default', 'none', 1, 1)`,
    [id, farmId],
  );
  return id;
};

describe('the auditable roll', () => {
  it('is the same for the same inputs and changes with any of them', () => {
    const a = rollFor('s1', 4, 'farm-a', 'full-coop', 'TxAnchor');
    expect(rollFor('s1', 4, 'farm-a', 'full-coop', 'TxAnchor')).toEqual(a);
    expect(a.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(a.roll).toBeGreaterThanOrEqual(0);
    expect(a.roll).toBeLessThan(1);
    expect(a.roll).toBe(parseInt(a.seed.slice(0, 13), 16) / 2 ** 52);
    for (const other of [
      rollFor('s2', 4, 'farm-a', 'full-coop', 'TxAnchor'),
      rollFor('s1', 5, 'farm-a', 'full-coop', 'TxAnchor'),
      rollFor('s1', 4, 'farm-b', 'full-coop', 'TxAnchor'),
      rollFor('s1', 4, 'farm-a', 'eggs-sold', 'TxAnchor'),
      rollFor('s1', 4, 'farm-a', 'full-coop', 'TxOther'),
    ]) {
      expect(other.seed).not.toBe(a.seed);
    }
  });

  it(`wins about ${Math.round(F.odds * 100)}% of the time at the configured odds`, () => {
    const n = 20_000;
    let wins = 0;
    for (let i = 0; i < n; i++) if (rollFor('s1', 1 + (i % 50), `farm-${i}`, MILESTONE_IDS[i % MILESTONE_IDS.length] ?? 'full-coop', 'anchor').roll < F.odds) wins++;
    expect(Math.abs(wins / n - F.odds)).toBeLessThan(0.015);
  });
});

describe('good standing', () => {
  it('a new farm is in good standing; a missed delivery or unpaid credit loses it for a few days; bust loses it', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    const day = t.game.getClock().day;
    expect(await standing(t.db, farmId, day)).toEqual({ good: true, reasons: [] });

    await t.db.query('UPDATE farms SET last_missed_day = $2 WHERE id = $1', [farmId, day]);
    expect((await standing(t.db, farmId, day)).reasons).toEqual(['missed a contract delivery']);
    expect((await standing(t.db, farmId, day + F.missWindowDays - 1)).good).toBe(false);
    expect((await standing(t.db, farmId, day + F.missWindowDays)).good).toBe(true);
    await t.db.query('UPDATE farms SET last_missed_day = NULL WHERE id = $1', [farmId]);

    const [agent] = await t.db.query(`SELECT id FROM agents WHERE role = 'supplier' LIMIT 1`);
    await t.db.query(`INSERT INTO debts (id, farm_id, agent_id, principal_milli, due_milli, due_day, status) VALUES ('d1', $1, $2, 1000, 1100, $3, 'defaulted')`, [farmId, agent?.id, day]);
    expect((await standing(t.db, farmId, day)).reasons).toEqual(['feed credit unpaid past its due day']);
    expect((await standing(t.db, farmId, day + F.missWindowDays)).good).toBe(true);
    await t.db.query(`UPDATE debts SET status = 'open', due_day = $1 WHERE id = 'd1'`, [day - 1]);
    expect((await standing(t.db, farmId, day)).good).toBe(false);
    await t.db.query(`UPDATE debts SET status = 'paid' WHERE id = 'd1'`);
    expect((await standing(t.db, farmId, day)).good).toBe(true);

    await t.db.query('UPDATE farms SET bust_day = $2 WHERE id = $1', [farmId, day]);
    expect((await standing(t.db, farmId, day + 30)).reasons).toEqual(['went bust this season']);
    await t.db.close();
  });
});

describe('milestones', () => {
  it('each is reached from the farm, its counters and the board', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    const day = t.game.getClock().day;
    const is = (m: (typeof MILESTONE_IDS)[number], d = day) => reached(t.db, farmId, m, d);

    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3 WHERE id = $1', [farmId, F.eggsSold - 1, F.hagglesWon - 1]);
    expect([await is('eggs-sold'), await is('haggles-won')]).toEqual([false, false]);
    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3 WHERE id = $1', [farmId, F.eggsSold, F.hagglesWon]);
    expect([await is('eggs-sold'), await is('haggles-won')]).toEqual([true, true]);

    expect(await is('all-machines')).toBe(false);
    for (const u of UNLOCK_IDS) await t.db.query('INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, $2, 1)', [farmId, u]);
    expect(await is('all-machines')).toBe(true);

    await t.db.query('UPDATE farms SET good_since_day = $2 WHERE id = $1', [farmId, day]);
    expect(await is('good-week', day + F.goodDays - 2)).toBe(false);
    expect(await is('good-week', day + F.goodDays - 1)).toBe(true);

    expect(await is('outlast-rival')).toBe(false);
    await t.db.query(`UPDATE agents SET status = 'bust', bust_day = $1 WHERE id = (SELECT id FROM agents WHERE role = 'rival' LIMIT 1)`, [day]);
    expect(await is('outlast-rival')).toBe(true);

    // two richer players push Ada off the board's top three (with the two rival farms)
    for (const n of ['Bo', 'Cy']) await t.db.query('UPDATE farms SET cash_milli = 99999999 WHERE id = $1', [(await player(t, n)).farmId]);
    await t.db.query('UPDATE farms SET cash_milli = 0 WHERE id = $1', [farmId]);
    expect(await is('top-three')).toBe(false);
    await t.db.query('UPDATE farms SET cash_milli = 999999999 WHERE id = $1', [farmId]);
    expect(await is('top-three')).toBe(true);

    await t.db.query(`DELETE FROM hens WHERE farm_id = $1`, [farmId]);
    expect(await is('full-coop')).toBe(false);
    await t.db.close();
  });

  it('every reached milestone gets one roll, once, logged with its seed, and a win puts a Founding Hen on the farm', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3, cash_milli = 999999999 WHERE id = $1', [farmId, F.eggsSold, F.hagglesWon]);

    const first = await t.game.withCtx((ctx) => rollMilestones(ctx, 0, newHen(ctx.q), 1));
    const ids = first.map((r) => r.milestone);
    expect(ids).toEqual(expect.arrayContaining(['eggs-sold', 'haggles-won', 'top-three']));
    expect(first.every((r) => r.won && r.henId)).toBe(true);
    const hens = await t.db.query('SELECT founding_milestone, founding_day FROM hens WHERE farm_id = $1 AND founding_milestone IS NOT NULL ORDER BY founding_milestone', [farmId]);
    expect(hens.map((h) => h.founding_milestone)).toEqual([...ids].sort());
    const rows = await t.db.query('SELECT milestone, seed, roll, anchor, won FROM milestone_rolls WHERE farm_id = $1', [farmId]);
    expect(rows).toHaveLength(ids.length);
    for (const r of rows) expect(rollFor(t.game.season, t.game.getClock().day, farmId, String(r.milestone), String(r.anchor))).toEqual({ seed: r.seed, roll: r.roll });
    expect(t.logs.filter((l) => l.startsWith('[founding]') && /seed [0-9a-f]{64} roll/.test(l))).toHaveLength(ids.length);

    // never again for the same milestone (the new hens may fill the coop: that one is new)
    const second = await t.game.withCtx((ctx) => rollMilestones(ctx, 0, newHen(ctx.q), 1));
    expect(second.filter((r) => ids.includes(r.milestone))).toEqual([]);
    expect(await t.game.withCtx((ctx) => rollMilestones(ctx, 0, newHen(ctx.q), 1))).toEqual([]);
    await t.db.close();
  });

  it('a missed roll is final and kind; a farm out of good standing does not roll', async () => {
    const t = await makeGame({ cast: true });
    const a = await player(t, 'Ada');
    const b = await player(t, 'Bo');
    for (const f of [a, b]) await t.db.query('UPDATE farms SET eggs_sold = $2 WHERE id = $1', [f.farmId, F.eggsSold]);
    await t.db.query('UPDATE farms SET last_missed_day = $2 WHERE id = $1', [b.farmId, t.game.getClock().day]);
    const out = await t.game.withCtx((ctx) => rollMilestones(ctx, 0, newHen(ctx.q), 0));
    expect(out.filter((r) => r.farmId === b.farmId)).toEqual([]);
    const ada = out.filter((r) => r.farmId === a.farmId);
    expect(ada.find((r) => r.milestone === 'eggs-sold')).toMatchObject({ won: false, henId: null });
    const [hens] = await t.db.query('SELECT count(*) AS n FROM hens WHERE founding_milestone IS NOT NULL');
    expect(Number(hens?.n)).toBe(0);
    const [farmB] = await t.db.query('SELECT good_since_day FROM farms WHERE id = $1', [b.farmId]);
    expect(farmB?.good_since_day).toBeNull();
    await t.db.close();
  });

  it('rolls stop at 777: never more Founding Hens than the cap, counting those waiting to be minted', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3 WHERE id = $1', [farmId, F.eggsSold, F.hagglesWon]);
    expect(await t.game.withCtx((ctx) => rollMilestones(ctx, F.maxSupply, newHen(ctx.q), 1))).toEqual([]);
    const one = await t.game.withCtx((ctx) => rollMilestones(ctx, F.maxSupply - 1, newHen(ctx.q), 1));
    expect(one).toHaveLength(1);
    expect(await foundingCount(t.db, F.maxSupply - 1)).toEqual({ max: 777, minted: 776, pending: 1, remaining: 0 });
    await t.db.close();
  });
});

describe('ordinary hens', () => {
  it('are never minted: day after day the batches carry only Founding Hens', async () => {
    const chain = new RecordingChain('game.testnet', F.mintsPerBatch);
    const t = await makeGame({ cast: true, chain, season: 'ord', seed: 5 });
    const { playerId, farmId } = await player(t);
    await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    for (let d = 0; d < 4; d++) {
      t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
      await t.game.endDay();
    }
    expect(chain.batches).toHaveLength(4);
    expect(chain.batches.flatMap((b) => b.hen_mints)).toEqual([]);
    const founding = new Set(
      (await t.db.query<{ id: string }>('SELECT id FROM hens WHERE founding_milestone IS NOT NULL')).map((r) => `founding-${r.id}`),
    );
    for (const m of chain.batches.flatMap((b) => b.founding_mints ?? [])) expect(founding.has(m.token_id)).toBe(true);
    const ordinary = await t.db.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND founding_milestone IS NULL AND chain_owner IS NOT NULL`, [farmId]);
    expect(Number(ordinary[0]?.n)).toBe(0);
    await t.db.close();
  });
});
