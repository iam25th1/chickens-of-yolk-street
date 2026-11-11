// Real Postgres, when TEST_DATABASE_URL points at a throwaway database (CI starts one): migrations
// are safe to run again and from two instances at once, and a season plays and settles on it.
// The database's public schema is dropped first, so never point this at data you want.
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { openDb } from '../src/db/db';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { RecordingChain, makeGame } from './helpers';

const url = process.env.TEST_DATABASE_URL;

describe.runIf(url)('on real Postgres', () => {
  it('migrations run once even when two servers boot together, and again is a no-op', async () => {
    const a = await openDb(url ?? '');
    const b = await openDb(url ?? '');
    await a.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const [first, second] = await Promise.all([migrate(a), migrate(b)]);
    expect([...first, ...second].sort((x, y) => x - y)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(a)).toEqual([]);
    const ids = (await a.query('SELECT id FROM schema_migrations ORDER BY id')).map((r) => Number(r.id));
    expect(ids).toEqual(MIGRATIONS.map((m) => m.id));
    await a.close();
    await b.close();
  });

  it('a season plays, keeps its ledger and settles by (season, day)', async () => {
    const db = await openDb(url ?? '');
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const chain = new RecordingChain();
    const t = await makeGame({ db, season: 'pg-1', chain, cast: true });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    const farm = await t.game.getFarmState(farmId);
    expect((await t.game.act(playerId, { t: 'sell', rid: 's1', items: farm.crate })).ok).toBe(true);
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(chain.batches.map((b) => [b.season, b.day])).toEqual([
      ['pg-1', 1],
      ['pg-1', 2],
    ]);
    expect((await db.query('SELECT DISTINCT season FROM ledger')).map((r) => r.season)).toEqual(['pg-1']);
    expect(await t.game.ledgerTotal(farmId)).toBe((await t.game.getFarmState(farmId)).cashMilli);
    await expect(makeGame({ db, season: 'pg-2' })).rejects.toThrow(/holds season pg-1/);
    await db.close();
  });
});
