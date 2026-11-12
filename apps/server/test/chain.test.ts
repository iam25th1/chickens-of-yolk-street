import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { buildDayBatch, commitBatch } from '../src/chain/batch';
import { NoopChain, agentAccountName, agentPublicKey, assertTestnetConfig } from '../src/chain/chain';
import { HenRenderer } from '../src/chain/hen-image';
import { decodePng } from '../src/chain/png';
import { openDb } from '../src/db/db';
import { MIGRATIONS } from '../src/db/migrations';
import { RecordingChain, makeGame } from './helpers';

const assets = fileURLToPath(new URL('../../client/public/assets', import.meta.url));

describe('hen portraits for NFT metadata', () => {
  it('renders the stacked trait layers to a 32x32 PNG data URI with its hash', () => {
    const r = new HenRenderer(assets);
    const img = r.render({ body: 'brown', eyes: 'wild', comb: 'mohawk', accessory: 'tophat' });
    expect(img.dataUri).toMatch(/^data:image\/png;base64,/);
    const png = decodePng(Buffer.from(img.dataUri.split(',')[1] ?? '', 'base64'));
    expect([png.width, png.height]).toEqual([32, 32]);
    expect(img.bytes).toBeLessThan(4096);
    expect(Buffer.from(img.sha256Base64, 'base64')).toHaveLength(32);
    expect(r.render({ body: 'brown', eyes: 'wild', comb: 'mohawk', accessory: 'tophat' })).toBe(img);
  });
});

describe('the daily batch', () => {
  it('mints collected eggs to wallets, Founding Hens only, and reconciles from confirmed balances', async () => {
    const t = await makeGame({ cast: true });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    await t.db.query(`UPDATE agents SET near_account_id = kind || '1.game.testnet'`);
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    const farm = await t.game.getFarmState(farmId);
    const day = (await t.game.getMarketState()).day - 1;
    const renderer = new HenRenderer(assets);
    // two of Ada's hens are Founding Hens won at milestones; the rest are ordinary
    const [a, b] = farm.hens;
    await t.db.query(`UPDATE hens SET founding_milestone = 'full-coop', founding_day = 1 WHERE id = $1`, [a?.id]);
    await t.db.query(`UPDATE hens SET founding_milestone = 'eggs-sold', founding_day = 1 WHERE id = $1`, [b?.id]);
    const first = await buildDayBatch(t.db, t.game.season, day, { founding: { cap: 5, base: 40 }, renderer });
    const mintsToAda = first.batch.eggs.filter((m) => m.kind === 'Mint' && m.to === 'ada.testnet');
    const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
    expect(mintsToAda.reduce((s, m) => s + Number(m.amount), 0)).toBeGreaterThanOrEqual(crate);
    expect(first.batch.hen_mints).toEqual([]);
    // every Founding Hen (these two, and any the day close's milestone rolls won), oldest win first
    const won = await t.db.query<{ id: string }>('SELECT id FROM hens WHERE founding_milestone IS NOT NULL ORDER BY founding_day, id');
    expect(won.map((h) => h.id)).toEqual(expect.arrayContaining([a?.id, b?.id]));
    expect(first.batch.founding_mints?.map((m) => [m.token_id, m.owner_id, m.season])).toEqual(won.map((h) => [`founding-${h.id}`, 'ada.testnet', t.game.season]));
    expect(JSON.parse(first.batch.founding_mints?.[0]?.traits ?? '{}')).toHaveProperty('comb');
    expect([...first.numbers.values()]).toEqual(won.map((_, i) => 41 + i));
    expect(first.batch.digest).toMatch(/^[0-9a-f]{64}$/);
    await commitBatch(t.db, first);

    // the same day again moves nothing: chain balances already match what everyone holds
    const again = await buildDayBatch(t.db, t.game.season, day, { founding: { cap: 5, base: 42 }, renderer });
    expect(again.batch.founding_mints).toEqual([]);
    // a version 2 contract gets no founding field at all, and still no ordinary hens
    const v2 = await buildDayBatch(t.db, t.game.season, day, { founding: null, renderer });
    expect('founding_mints' in v2.batch).toBe(false);
    expect(v2.batch.hen_mints).toEqual([]);
    expect(again.batch.eggs.filter((m) => m.kind !== 'Transfer' && (m.to === 'ada.testnet' || m.from === 'ada.testnet'))).toEqual([]);
    await t.db.close();
  });

  it('a database keeps one season: ledger rows and batches carry it, and another GAME_SEASON is refused', async () => {
    const chain = new RecordingChain();
    const t = await makeGame({ season: 's1', chain });
    expect(t.game.season).toBe('s1');
    await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(chain.batches.map((b) => [b.season, b.day])).toEqual([['s1', 1]]);
    const seasons = await t.db.query('SELECT DISTINCT season FROM ledger');
    expect(seasons.map((r) => r.season)).toEqual(['s1']);
    const [day1] = await t.db.query(`SELECT settlement_tx FROM market_days WHERE season = 's1' AND day = 1`);
    expect(day1?.settlement_tx).toBe('recorded-s1-1');
    expect((await t.game.getMarketState()).season).toBe('s1');

    await expect(makeGame({ db: t.db, season: 's2' })).rejects.toThrow(/holds season s1 but GAME_SEASON is s2/);
    expect((await makeGame({ db: t.db })).game.season).toBe('s1');
    await t.db.close();
  });

  it('a fresh database without GAME_SEASON makes its own season, so it never repeats a settled day', async () => {
    const a = await makeGame();
    const b = await makeGame();
    expect(a.game.season).toMatch(/^dev-\d{8}-[0-9a-f]{6}$/);
    expect(a.game.season).not.toBe(b.game.season);
    await a.db.close();
    await b.db.close();
  });

  it('a database from before seasons carries on as the legacy season, like the upgraded contract', async () => {
    const db = await openDb('memory://');
    await db.exec('CREATE TABLE schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at bigint NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 3)) {
      await db.exec(m.sql);
      await db.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, 0)', [m.id, m.name]);
    }
    await db.query('INSERT INTO game_clock (id, day, day_started_at) VALUES (1, 4, $1)', [Date.UTC(2026, 10, 11, 12)]);
    await db.query('INSERT INTO market_days (day, multiplier) VALUES (3, 2.5), (4, 2.5)');
    const t = await makeGame({ db });
    expect(t.game.season).toBe('legacy');
    expect(t.game.getClock().day).toBe(4);
    // (season, day) is the key now: the same day number may exist in another season
    await db.query(`INSERT INTO market_days (season, day, multiplier) VALUES ('s2', 4, 1)`);
    expect((await db.query('SELECT season FROM market_days WHERE day = 4 ORDER BY season')).map((r) => r.season)).toEqual(['legacy', 's2']);
    await db.close();
  });

  it('without credentials every day is a loud, recorded no-op', async () => {
    const lines: string[] = [];
    const t = await makeGame();
    const r = await new NoopChain('no keys', (l) => lines.push(l)).settleDay(t.db, t.game.season, 1);
    expect(r).toEqual({ status: 'noop', txHash: null });
    expect(lines.join('\n')).toMatch(new RegExp(`NO-OP for season ${t.game.season} day 1`));
    await t.db.close();
  });
});

describe('testnet only', () => {
  it('refuses mainnet accounts and RPC hosts before using a key', () => {
    const ok = { accountId: 'coys.testnet', privateKey: 'ed25519:abc', rpcUrl: 'https://test.rpc.fastnear.com', contractId: 'coys.testnet' };
    expect(() => assertTestnetConfig(ok)).not.toThrow();
    expect(() => assertTestnetConfig({ ...ok, accountId: 'coys.near' })).toThrow(/non-testnet/);
    expect(() => assertTestnetConfig({ ...ok, rpcUrl: 'https://rpc.mainnet.near.org' })).toThrow(/not a testnet/);
  });

  it('agent wallets are sub-accounts with keys derived from the game key', () => {
    expect(agentAccountName('old-money', 2, 'coys.testnet')).toBe('oldmoney2.coys.testnet');
    const a = agentPublicKey('ed25519:secret', 'bakery', 1);
    expect(a).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(agentPublicKey('ed25519:secret', 'bakery', 1)).toBe(a);
    expect(agentPublicKey('ed25519:secret', 'bakery', 2)).not.toBe(a);
  });
});
