// The tour's server side: the practice offer (sent once; a first counter always gets a counter back)
// and the hen certificate moment (a day close that mints a player's hen tells the player, and her
// card carries the receipt).
import { describe, expect, it } from 'vitest';
import { ECONOMY, type GameEvent } from '@coys/shared';
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

    expect(await t.game.act(playerId, { t: 'practiceCard', rid: 'p3' })).toMatchObject({ ok: false, code: 'invalid_action' });
    const farm = await t.game.getFarmState(farmId);
    expect(farm.cards.filter((c) => c.kind === 'bulk-order')).toHaveLength(1);
    await t.db.close();
  });
});

describe('the hen certificate moment', () => {
  it('a day close that mints a hen tells her owner, with the token and receipt on her card', async () => {
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

    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();

    const minted = events.filter((e) => e.kind === 'henMinted');
    expect(minted).toHaveLength(3);
    farm = await t.game.getFarmState(farmId);
    for (const e of minted) {
      if (e.kind !== 'henMinted') continue;
      expect(e).toMatchObject({ owner: 'mina.testnet', txHash: 'recorded-mint-1', day: 1, token: `hen-${e.henId}` });
      expect(farm.hens.find((h) => h.id === e.henId)).toMatchObject({ chainOwner: 'mina.testnet', mintTx: 'recorded-mint-1', mintDay: 1 });
    }
    expect((await t.game.getMarketState()).minting).toBe('live');
    await t.db.close();
  });
});
