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

describe('the Feather reveal moment', () => {
  it('a day close mints a redeemed ticket as a Feather and tells its owner its number, grade and receipt; no hen is minted', async () => {
    const chain = new RecordingChain('game.testnet', 3);
    const t = await makeGame({ chain, season: 'mint', seed: 9 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-mint', 'Mina');
    expect((await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'mina.testnet' })).ok).toBe(true);
    const events: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === playerId && o.msg.t === 'event') events.push(o.msg.event);
    });
    await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ('tk', $1, 'full-coop', 'mint', 0, 0)`, [farmId]);
    // every milestone already rolled, so this day close mints only this Feather
    for (const m of MILESTONE_IDS) {
      await t.db.query(`INSERT INTO milestone_rolls (farm_id, milestone, season, day, anchor, seed, roll, odds, won) VALUES ($1, $2, 'mint', 0, 'none', 'x', 0.9, 0.3, false)`, [farmId, m]);
    }
    expect((await t.game.act(playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'tk' })).ok).toBe(true);
    const grade = (await t.game.getFarmState(farmId)).tickets[0]?.grade;
    expect(grade).toBe('fluff');

    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();

    expect(events.filter((e) => e.kind === 'featherMinted')).toEqual([
      { kind: 'featherMinted', ticketId: 'tk', number: 1, grade: 'fluff', milestone: 'full-coop', token: '001', owner: 'mina.testnet', txHash: 'recorded-mint-1', day: 1 },
    ]);
    const farm = await t.game.getFarmState(farmId);
    expect(farm.tickets).toEqual([
      expect.objectContaining({ id: 'tk', status: 'minted', grade: 'fluff', number: 1, owner: 'mina.testnet', mintTx: 'recorded-mint-1', mintDay: 1 }),
    ]);
    expect(chain.batches.flatMap((b) => b.hen_mints)).toEqual([]);
    const market = await t.game.getMarketState();
    expect(market.minting).toBe('live');
    expect(market.feathers).toEqual({ max: 777, minted: 1, left: 776, tickets: 0 });
    await t.db.close();
  });
});
