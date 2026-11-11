// A Bakery standing contract delivered on chain: the Bakery offers the contract as a card, the
// player accepts it and delivers, the Bakery pays coins, and that day's settlement batch moves the
// eggs as tokens from the player's wallet to the Bakery's sub-account wallet, with a receipt.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { RecordingChain, makeGame } from './helpers';

describe('an on-chain contract delivery', () => {
  it('the player delivers Bakery contract eggs to the Bakery wallet at day close, and the Bakery pays', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ cast: true, chain, season: 'proof', seed: 7 });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    expect((await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' })).ok).toBe(true);

    // close days until the Bakery's offer lands on the player's card tray
    let card = null;
    for (let i = 0; i < 5 && !card; i++) {
      t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
      await t.game.endDay();
      t.clock.t = t.game.getClock().dayStartedAt + Math.floor(ECONOMY.day.lengthMs * 0.7);
      await t.game.tick();
      card = (await t.game.getFarmState(farmId)).cards.find((c) => c.kind === 'standing-contract' && c.status === 'open') ?? null;
    }
    expect(card).not.toBeNull();
    if (!card) return;
    expect((await t.game.act(playerId, { t: 'respondCard', rid: 'accept', cardId: card.id, choice: 'accept' })).ok).toBe(true);

    let farm = await t.game.getFarmState(farmId);
    const contract = farm.contracts[0];
    expect(contract?.agentName).toBe('Yolk Street Bakery');
    if (!contract) return;
    const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
    expect(crate).toBeGreaterThanOrEqual(contract.qtyPerDay);
    const cashBefore = farm.cashMilli;
    const [bakeryBefore] = await t.db.query(`SELECT id, cash_milli, near_account_id FROM agents WHERE kind = 'bakery'`);
    expect(bakeryBefore?.near_account_id).toBe('bakery1.game.testnet');

    expect((await t.game.act(playerId, { t: 'deliverContract', rid: 'deliver', contractId: contract.id })).ok).toBe(true);
    farm = await t.game.getFarmState(farmId);
    const paid = contract.qtyPerDay * contract.priceMilli;
    expect(farm.cashMilli - cashBefore).toBe(paid);
    const [bakeryAfter] = await t.db.query(`SELECT cash_milli FROM agents WHERE kind = 'bakery'`);
    expect(Number(bakeryBefore?.cash_milli) - Number(bakeryAfter?.cash_milli)).toBe(paid);

    // the day closes and settles: the eggs travel as tokens to the Bakery's wallet
    const day = t.game.getClock().day;
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    const batch = chain.batches.find((b) => b.day === day);
    expect(batch?.season).toBe('proof');
    const delivered = (batch?.eggs ?? []).filter((m) => m.kind === 'Transfer' && m.from === 'ada.testnet' && m.to === 'bakery1.game.testnet');
    expect(delivered.reduce((s, m) => s + Number(m.amount), 0)).toBe(contract.qtyPerDay);
    // the Bakery bakes what it bought at the close, so its tokens are burned in the same batch
    expect((batch?.eggs ?? []).some((m) => m.kind === 'Burn' && m.from === 'bakery1.game.testnet')).toBe(true);
    const [md] = await t.db.query(`SELECT settlement_status, settlement_tx FROM market_days WHERE season = 'proof' AND day = $1`, [day]);
    expect(md).toMatchObject({ settlement_status: 'sent', settlement_tx: `recorded-proof-${day}` });
    // the ledger shows the receipt for that day
    expect((await t.game.getLedger(farmId)).find((d) => d.day === day)?.settlement?.txHash).toBe(`recorded-proof-${day}`);
    await t.db.close();
  });
});
