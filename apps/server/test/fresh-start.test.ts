// Fresh Start: refused away from a dead end; offered at one (no eggs, and no hens and too few coins
// for one, or hens with no feed, nothing eaten today, too few coins for a bag and no Loyalist credit;
// and no goal to claim); it gives the starting coins, feed and hens, writes off what the farm leaves
// behind, counts a bust where everyone sees it, and none of it is league profit.
import { describe, expect, it } from 'vitest';
import { ECONOMY, toMilli, type GameEvent } from '@coys/shared';
import { loadFarm, moveCash } from '../src/game/ctx';
import { deadEnd } from '../src/game/fresh';
import { makeGame, type TestGame } from './helpers';

const score = async (t: TestGame, farmId: string): Promise<number> => {
  const v = await t.game.getLeaderboard('week', null);
  const e = v?.entries.find((x) => x.farmId === farmId);
  if (!e) throw new Error('no league entry');
  return e.scoreMilli;
};

/** Spends every coin, empties the feed and leaves the hens unfed today. */
async function runDry(t: TestGame, farmId: string): Promise<void> {
  const cash = (await t.game.getFarmState(farmId)).cashMilli;
  await t.game.withCtx((ctx) => moveCash(ctx, farmId, 'feed', -cash, 'test'));
  await t.db.query('UPDATE farms SET feed_cheap_g = 0, feed_standard_g = 0, feed_premium_g = 0, fed_multiplier = 0 WHERE id = $1', [farmId]);
}

describe('Fresh Start', () => {
  it('is refused away from a dead end; at one (no eggs, feed, coins or Loyalist) it starts the farm again, counts a bust and is no profit', async () => {
    // no cast: no Loyalist to give credit, no supplier (the mill sells feed)
    const t = await makeGame();
    const a = await t.game.ensurePlayer('dev', 'dev-fern', 'Fern Hollow');
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(false);
    expect(await t.game.act(a.playerId, { t: 'freshStart', rid: 'f0' })).toMatchObject({ ok: false, code: 'invalid_action' });

    await runDry(t, a.farmId);
    await t.db.query(`UPDATE hens SET status = 'auction', farm_id = NULL WHERE id IN (SELECT id FROM hens WHERE farm_id = $1 AND status = 'alive' ORDER BY id LIMIT 4)`, [a.farmId]);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(true);
    // a goal ready to claim pays coins: no dead end while one waits; nor while eggs wait in the crate
    await t.db.query(`UPDATE farms SET goals = '{"done":["collect"],"claimed":[]}' WHERE id = $1`, [a.farmId]);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(false);
    await t.db.query(`UPDATE farms SET goals = '{}', crate_white = 1 WHERE id = $1`, [a.farmId]);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(false);
    await t.db.query(`UPDATE farms SET crate_white = 0 WHERE id = $1`, [a.farmId]);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(true);

    const before = await score(t, a.farmId);
    const heard: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === a.playerId && o.msg.t === 'event') heard.push(o.msg.event);
    });
    expect((await t.game.act(a.playerId, { t: 'freshStart', rid: 'f1' })).ok).toBe(true);
    const f = await t.game.getFarmState(a.farmId);
    expect(f.cashMilli).toBe(toMilli(ECONOMY.start.cash));
    expect(f.feedGrams[ECONOMY.start.feed.tier]).toBe(ECONOMY.start.feed.kg * 1000);
    expect(f.hens).toHaveLength(ECONOMY.start.hens);
    expect(f.freshStart).toBe(false);
    expect(f.bust).toBe(false);
    expect(heard).toContainEqual({ kind: 'freshStart', busts: 1 });
    expect(await t.game.ledgerTotal(a.farmId)).toBe(f.cashMilli);
    // what it was given is not profit
    expect(await score(t, a.farmId)).toBe(before);
    // the bust count is public: the leaderboard, the market's farms ranking, the public profile
    expect((await t.game.getLeaderboard('week', null))?.entries.find((e) => e.farmId === a.farmId)?.busts).toBe(1);
    expect((await t.game.getMarketState()).ranking.find((r) => r.farmId === a.farmId)?.busts).toBe(1);
    expect((await t.game.getPublicProfile(a.farmId))?.busts).toBe(1);
    // and it is no dead end now
    expect(await t.game.act(a.playerId, { t: 'freshStart', rid: 'f2' })).toMatchObject({ ok: false, code: 'invalid_action' });

    // with no hens at all: fewer coins than the cheapest hen in the shop is a dead end too
    await runDry(t, a.farmId);
    await t.db.query(`UPDATE hens SET status = 'auction', farm_id = NULL WHERE farm_id = $1 AND status = 'alive'`, [a.farmId]);
    await t.game.withCtx((ctx) => moveCash(ctx, a.farmId, 'goal', toMilli(ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor) - 1, 'test'));
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(true);
    await t.game.withCtx((ctx) => moveCash(ctx, a.farmId, 'goal', 1, 'test'));
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(false);
    await t.game.withCtx((ctx) => moveCash(ctx, a.farmId, 'goal', -1, 'test'));
    expect((await t.game.act(a.playerId, { t: 'freshStart', rid: 'f3' })).ok).toBe(true);
    expect((await t.game.getFarmState(a.farmId)).hens).toHaveLength(ECONOMY.start.hens);
    expect((await t.game.getPublicProfile(a.farmId))?.busts).toBe(2);
    await t.db.close();
  });

  it("the Loyalist's credit is a way out; past its limit it is a dead end, and the Fresh Start writes the credit off without making it profit", async () => {
    const t = await makeGame({ cast: true, seed: 3 });
    const a = await t.game.ensurePlayer('dev', 'dev-loyal', 'Loyal Acres');
    await runDry(t, a.farmId);
    // the Loyalist would sell a bag on credit
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(false);
    const [loyalist] = await t.db.query<{ id: string }>(`SELECT id FROM agents WHERE kind = 'loyalist' AND status = 'open'`);
    if (!loyalist) throw new Error('no Loyalist');
    const owed = toMilli(ECONOMY.suppliers.loyalist.creditLimit - 5);
    await t.db.query(`INSERT INTO debts (id, farm_id, agent_id, principal_milli, due_milli, due_day) VALUES ('d1', $1, $2, $3, $3, 99)`, [a.farmId, loyalist.id, owed]);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(true);
    const before = await score(t, a.farmId);
    expect((await t.game.act(a.playerId, { t: 'freshStart', rid: 'f1' })).ok).toBe(true);
    expect((await t.db.query(`SELECT status FROM debts WHERE id = 'd1'`))[0]?.status).toBe('defaulted');
    // the coins, the feed, and the credit written off: none of it is league profit
    expect(await score(t, a.farmId)).toBe(before);
    // an AI farm is never at a dead end
    const [ai] = await t.db.query<{ farm_id: string }>(`SELECT farm_id FROM agents WHERE role = 'rival' AND status = 'open' LIMIT 1`);
    if (!ai) throw new Error('no AI farm');
    await t.db.query('UPDATE farms SET cash_milli = 0, feed_cheap_g = 0, feed_standard_g = 0, feed_premium_g = 0, fed_multiplier = 0, crate_white = 0, crate_cream = 0, crate_brown = 0, crate_golden = 0 WHERE id = $1', [ai.farm_id]);
    expect(await t.game.withCtx(async (ctx) => deadEnd(ctx, await loadFarm(ctx.q, ai.farm_id)))).toBe(false);
    await t.db.close();
  });

  it('a bust Loyalist leaves no credit: the dry farm is at a dead end', async () => {
    const t = await makeGame({ cast: true, seed: 4 });
    const a = await t.game.ensurePlayer('dev', 'dev-dry', 'Dry Gulch');
    await runDry(t, a.farmId);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(false);
    await t.db.query(`UPDATE agents SET status = 'bust', bust_day = 1 WHERE kind = 'loyalist'`);
    expect((await t.game.getFarmState(a.farmId)).freshStart).toBe(true);
    await t.db.close();
  });
});
