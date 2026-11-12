// The tour's server side: the practice offer (sent once; a first counter always gets a counter back)
// and the hen certificate moment (a day close that mints a player's hen tells the player, and her
// card carries the receipt).
import { describe, expect, it } from 'vitest';
import { ECONOMY, MILESTONE_IDS, type GameEvent } from '@coys/shared';
import { RecordingChain, makeGame } from './helpers';

describe('the practice offer', () => {
  it('arrives at once from a buyer, haggles on the first counter, and is sent only once', async () => {
    const t = await makeGame({ cast: true, seed: 5 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-tour', 'Tess');
    const events: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === playerId && o.msg.t === 'event') events.push(o.msg.event);
    });
    expect(await t.game.act(playerId, { t: 'practiceCard', rid: 'p1' })).toMatchObject({ ok: true });
    const arrived = events.find((e) => e.kind === 'cardArrived');
    expect(arrived?.kind).toBe('cardArrived');
    if (arrived?.kind !== 'cardArrived') return;
    expect(arrived.card).toMatchObject({ kind: 'bulk-order', status: 'open', round: 0 });
    expect(arrived.card.choices).toContain('counter');

    // the client's default counter asks for 10% more: the buyer comes back with a counter
    const ask = (arrived.card.offerMilli * 1.1) / 1000;
    expect(await t.game.act(playerId, { t: 'respondCard', rid: 'p2', cardId: arrived.card.id, choice: 'counter', ask })).toMatchObject({ ok: true });
    const haggle = events.find((e) => e.kind === 'haggle');
    expect(haggle?.kind).toBe('haggle');
    if (haggle?.kind === 'haggle') {
      expect(haggle.card.round).toBe(1);
      expect(haggle.card.offerMilli).toBeGreaterThan(arrived.card.offerMilli);
    }

    // asking again (a replayed tour) sends nothing more
    expect(await t.game.act(playerId, { t: 'practiceCard', rid: 'p3' })).toMatchObject({ ok: true });
    const farm = await t.game.getFarmState(farmId);
    expect(farm.cards.filter((c) => c.kind === 'bulk-order')).toHaveLength(1);
    await t.db.close();
  });
});

describe('feed on credit', () => {
  it('a new player short of coins can take a bag from the Loyalist and owe it', async () => {
    const t = await makeGame({ cast: true, seed: 3 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-credit', 'Cleo');
    const before = await t.game.getFarmState(farmId);
    expect(before.cashMilli).toBeLessThan(ECONOMY.feed.tiers.cheap.bagPrice * 1000);
    expect(await t.game.act(playerId, { t: 'buyFeedOnCredit', rid: 'c1', tier: 'cheap', bags: 1 })).toMatchObject({ ok: true });
    const after = await t.game.getFarmState(farmId);
    expect(after.cashMilli).toBe(before.cashMilli);
    expect(after.feedGrams.cheap - before.feedGrams.cheap).toBe(ECONOMY.feed.bagKg * 1000);
    expect(after.debts.filter((d) => d.status === 'open')).toHaveLength(1);
    await t.db.close();
  });
});

describe('the Founding Hen certificate moment', () => {
  it('a day close mints a won Founding Hen and tells her owner, with her number, milestone and receipt; ordinary hens stay off chain', async () => {
    const chain = new RecordingChain('game.testnet', 3);
    const t = await makeGame({ chain, season: 'mint', seed: 9 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-mint', 'Mina');
    expect((await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'mina.testnet' })).ok).toBe(true);
    const events: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === playerId && o.msg.t === 'event') events.push(o.msg.event);
    });
    let farm = await t.game.getFarmState(farmId);
    expect(farm.hens.every((h) => h.chainOwner === null && h.mintTx === null)).toBe(true);
    const won = farm.hens[0]?.id ?? '';
    await t.db.query(`UPDATE hens SET founding_milestone = 'full-coop', founding_day = 0 WHERE id = $1`, [won]);
    // every milestone already rolled, so this day close mints only her
    for (const m of MILESTONE_IDS) {
      await t.db.query(`INSERT INTO milestone_rolls (farm_id, milestone, season, day, anchor, seed, roll, odds, won, hen_id) VALUES ($1, $2, 'mint', 0, 'none', 'x', 0.9, 0.3, false, NULL)`, [farmId, m]);
    }

    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();

    const minted = events.filter((e) => e.kind === 'henMinted');
    expect(minted).toEqual([
      { kind: 'henMinted', henId: won, token: `founding-${won}`, owner: 'mina.testnet', txHash: 'recorded-mint-1', day: 1, number: 1, milestone: 'full-coop' },
    ]);
    farm = await t.game.getFarmState(farmId);
    expect(farm.hens.find((h) => h.id === won)).toMatchObject({
      chainOwner: 'mina.testnet',
      mintTx: 'recorded-mint-1',
      mintDay: 1,
      founding: { milestone: 'full-coop', day: 0, number: 1 },
    });
    expect(farm.hens.filter((h) => h.id !== won).every((h) => h.chainOwner === null && !h.founding)).toBe(true);
    expect(chain.batches.flatMap((b) => b.hen_mints)).toEqual([]);
    const market = await t.game.getMarketState();
    expect(market.minting).toBe('live');
    expect(market.founding).toMatchObject({ max: 777, minted: 1 });
    await t.db.close();
  });
});
