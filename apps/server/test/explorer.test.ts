// Receipts stay linked on a server that does not settle (a local copy of a live database): the days
// a testnet call settled keep their explorer links; a database without any has none.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { makeGame } from './helpers';

describe('the explorer for receipts', () => {
  it('without a chain: none, until the database holds a day a testnet call settled', async () => {
    const t = await makeGame({ season: 'copy' });
    expect((await t.game.getMarketState()).explorer).toBeNull();
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    await t.db.query(`UPDATE market_days SET settlement_status = 'sent', settlement_tx = 'realtx' WHERE day = 1`);
    const again = await makeGame({ season: 'copy', db: t.db });
    expect((await again.game.getMarketState()).explorer).toBe('https://testnet.nearblocks.io/txns/');
    await t.db.close();
  }, 120_000);
});
