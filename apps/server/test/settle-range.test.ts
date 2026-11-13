// Settlement in ranges (SETTLE_EVERY_DAYS above 1): closed days wait as 'batched' until that many
// wait, then one call settles them all; its digest is the SHA-256 of the range's full record (each
// day's record as the database holds it, and the range's egg moves). A failed call leaves the days
// waiting and the next close sends the whole range again with the days since (catch-up by range); a
// flush (shutdown) sends a partial range; the kept record checks against the database and the chain.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { buildRangeBatch, checkRange, dayRecord, digestOf } from '../src/chain/batch';
import { RecordingChain, makeGame, type TestGame } from './helpers';

async function closeDays(t: TestGame, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
  }
}

const statuses = async (t: TestGame) =>
  (await t.db.query<{ day: number; settlement_status: string }>('SELECT day, settlement_status FROM market_days WHERE closed_at IS NOT NULL ORDER BY day')).map((r) => [Number(r.day), r.settlement_status]);

describe('settlement in ranges', () => {
  it('closed days wait as batched; the tenth close sends one call for all ten, every day marked with its tx and range', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ chain, season: 'rng', settleEvery: 10, cast: true });
    await t.game.ensurePlayer('dev', 'device-range-1', 'Rae');
    await closeDays(t, 9);
    expect(chain.ranges).toHaveLength(0);
    expect(chain.batches).toHaveLength(0);
    expect((await statuses(t)).every(([, s]) => s === 'batched')).toBe(true);
    await closeDays(t, 1);
    expect(chain.ranges).toHaveLength(1);
    const call = chain.ranges[0];
    expect(call?.batch.first_day).toBe(1);
    expect(call?.batch.day).toBe(10);
    const rows = await t.db.query('SELECT day, settlement_status, settlement_tx, settlement_first, settlement_last, settlement_digest FROM market_days WHERE day <= 10 ORDER BY day');
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.settlement_status).toBe('sent');
      expect(r.settlement_tx).toBe('recorded-rng-1-10');
      expect([Number(r.settlement_first), Number(r.settlement_last)]).toEqual([1, 10]);
      expect(r.settlement_digest).toBe(call?.batch.digest);
    }
    // the receipts in the market and the ledger name the range
    const market = await t.game.getMarketState();
    expect(market.settlement).toMatchObject({ day: 10, status: 'sent', txHash: 'recorded-rng-1-10', first: 1, last: 10 });
    await t.db.close();
  }, 120_000);

  it('the digest is the SHA-256 of the range record: every day as the database holds it, and the egg moves netted', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ chain, season: 'hash', settleEvery: 3, cast: true });
    await t.game.ensurePlayer('dev', 'device-range-2', 'Hal');
    await closeDays(t, 3);
    const call = chain.ranges[0];
    expect(call).toBeDefined();
    if (!call?.result.settlement) return;
    const record = call.result.settlement;
    expect(digestOf(record)).toBe(call.batch.digest);
    expect(record.days.map((d) => d.day)).toEqual([1, 2, 3]);
    for (const d of record.days) expect(d).toEqual(await dayRecord(t.db, 'hash', d.day));
    // the same days built again give the same record and digest (nothing else moved since)
    const again = await buildRangeBatch(t.db, 'hash', 1, 3);
    expect(again.settlement.days).toEqual(record.days);
    await t.db.close();
  }, 120_000);

  it('a failed call leaves the days waiting; the next close sends the whole range with the days since (catch-up by range)', async () => {
    const chain = new RecordingChain('game.testnet');
    chain.rangeScript = ['fail', 'fail'];
    const t = await makeGame({ chain, season: 'catch', settleEvery: 3 });
    await t.game.ensurePlayer('dev', 'device-range-3', 'Cat');
    await closeDays(t, 3);
    await closeDays(t, 1);
    expect(chain.ranges).toHaveLength(0);
    expect((await statuses(t)).map(([, s]) => s)).toEqual(['batched', 'batched', 'batched', 'batched']);
    await closeDays(t, 1);
    expect(chain.ranges.map((r) => [r.batch.first_day, r.batch.day])).toEqual([[1, 5]]);
    expect((await statuses(t)).map(([, s]) => s)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']);
    await t.db.close();
  }, 120_000);

  it('a flush (at shutdown) sends the days still waiting as a partial range; a flush with none waiting sends nothing', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ chain, season: 'flush', settleEvery: 10 });
    await t.game.ensurePlayer('dev', 'device-range-4', 'Flo');
    await closeDays(t, 4);
    await t.game.flushSettlement();
    expect(chain.ranges.map((r) => [r.batch.first_day, r.batch.day])).toEqual([[1, 4]]);
    await t.game.flushSettlement();
    expect(chain.ranges).toHaveLength(1);
    await closeDays(t, 10);
    expect(chain.ranges.map((r) => [r.batch.first_day, r.batch.day])).toEqual([
      [1, 4],
      [5, 14],
    ]);
    await t.db.close();
  }, 120_000);

  it('the kept record checks against the database and the digest the chain got; a changed day is found', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ chain, season: 'check', settleEvery: 3, cast: true });
    await t.game.ensurePlayer('dev', 'device-range-5', 'Chet');
    await closeDays(t, 3);
    const sent = chain.ranges[0]?.batch.digest;
    const ok = await checkRange(t.db, 'check', 3);
    expect(ok).toMatchObject({ ok: true, first: 1, last: 3, problems: [] });
    expect(ok.digest).toBe(sent);
    // a ledger line changed after the fact no longer matches its day's record
    const [farm] = await t.db.query<{ id: string }>(`SELECT id FROM farms WHERE owner_kind = 'player' LIMIT 1`);
    await t.db.query(`INSERT INTO ledger (farm_id, season, day, kind, amount_milli, created_at) VALUES ($1, 'check', 2, 'sale', 1000, 0)`, [farm?.id]);
    const bad = await checkRange(t.db, 'check', 3);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toContain('day 2 differs from the database');
    await t.db.close();
  }, 120_000);

  it('with SETTLE_EVERY_DAYS at 1 every day settles on its own, as before', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ chain, season: 'daily' });
    await t.game.ensurePlayer('dev', 'device-range-6', 'Dee');
    await closeDays(t, 3);
    expect(chain.ranges).toHaveLength(0);
    expect(chain.batches.map((b) => b.day)).toEqual([1, 2, 3]);
    await t.db.close();
  }, 120_000);
});
