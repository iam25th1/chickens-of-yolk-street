import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { buildDayBatch, commitBatch, digestOf } from '../src/chain/batch';
import { NoopChain, agentAccountName, agentPublicKey, assertTestnetConfig, mintsAffordable } from '../src/chain/chain';
import { FeatherRenderer } from '../src/chain/feather-image';
import { decodePng } from '../src/chain/png';
import { openDb } from '../src/db/db';
import { MIGRATIONS } from '../src/db/migrations';
import { RecordingChain, makeGame } from './helpers';

const assets = fileURLToPath(new URL('../../client/public/assets', import.meta.url));

describe('Feather card images for NFT metadata', () => {
  it('composes the grade frame, its feather and the number at 2x into a PNG data URI with its hash', () => {
    const r = new FeatherRenderer(assets);
    const img = r.render('golden-quill', 7);
    expect(img.dataUri).toMatch(/^data:image\/png;base64,/);
    const png = decodePng(Buffer.from(img.dataUri.split(',')[1] ?? '', 'base64'));
    expect([png.width, png.height]).toEqual([96, 136]);
    // every Feather card fits the room the sandbox measured gas and storage with (2,420 characters)
    for (const g of ['fluff', 'plume', 'quill', 'golden-quill'] as const) for (const n of [1, 388, 777]) expect(r.render(g, n).dataUri.length).toBeLessThanOrEqual(2420);
    expect(Buffer.from(img.sha256Base64, 'base64')).toHaveLength(32);
    expect(img.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(r.render('golden-quill', 7)).toBe(img);
    // the window shows the feather on the frame's paper, the plate shows the number: cards differ by grade and number
    expect(r.render('fluff', 7).sha256Hex).not.toBe(img.sha256Hex);
    expect(r.render('golden-quill', 8).sha256Hex).not.toBe(img.sha256Hex);
    const card = r.card('quill', 1);
    expect([card.width, card.height]).toEqual([48, 68]);
    let clear = 0;
    for (let y = 8; y < 56; y++) for (let x = 8; x < 40; x++) if ((card.data[(y * 48 + x) * 4 + 3] ?? 0) === 0) clear++;
    expect(clear).toBe(0);
  });
});

describe('the daily batch', () => {
  it('mints collected eggs to wallets, Feathers only, compact: the moving farms and the full settlement digest', async () => {
    const t = await makeGame({ cast: true });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    await t.db.query(`UPDATE agents SET near_account_id = kind || '1.game.testnet'`);
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    const farm = await t.game.getFarmState(farmId);
    const day = (await t.game.getMarketState()).day - 1;
    const renderer = new FeatherRenderer(assets);
    // two of Ada's tickets are redeemed (queued); one more is still held
    for (const [id, status, grade, seq] of [
      ['t1', 'queued', 'plume', 2],
      ['t2', 'queued', 'golden-quill', 1],
      ['t3', 'held', null, null],
    ] as const) {
      await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, status, grade, redeemed_seq, created_at) VALUES ($1, $2, 'full-coop', $3, 1, $4, $5, $6, 0)`, [
        id,
        farmId,
        t.game.season,
        status,
        grade,
        seq,
      ]);
    }
    const first = await buildDayBatch(t.db, t.game.season, day, { feathers: { cap: 5, base: 40 }, renderer });
    const mintsToAda = first.batch.eggs.filter((m) => m.kind === 'Mint' && m.to === 'ada.testnet');
    const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
    expect(mintsToAda.reduce((s, m) => s + Number(m.amount), 0)).toBeGreaterThanOrEqual(crate);
    expect(first.batch.hen_mints).toEqual([]);
    expect(first.batch.hen_moves).toEqual([]);
    expect(first.batch.feather_mints?.map((m) => [m.owner_id, m.grade, m.season])).toEqual([
      ['ada.testnet', 'golden-quill', t.game.season],
      ['ada.testnet', 'plume', t.game.season],
    ]);
    expect(first.minted.map((m) => [m.ticketId, m.number, m.token])).toEqual([
      ['t2', 41, '041'],
      ['t1', 42, '042'],
    ]);
    expect(first.batch.feather_mints?.[0]?.media).toBe(renderer.render('golden-quill', 41).dataUri);
    expect(first.batch.digest).toBe(digestOf(first.settlement));
    expect(first.settlement.feathers.map((f) => f.media_sha256)).toEqual([renderer.render('golden-quill', 41).sha256Hex, renderer.render('plume', 42).sha256Hex]);
    expect(first.settlement.farms.length).toBeGreaterThanOrEqual(first.batch.farms.length);
    await commitBatch(t.db, first, 'tx-1');
    // (the day close's own milestone rolls may have added a ticket of their own: look at these three)
    const minted = await t.db.query(`SELECT id, status, number, token_id, owner_account, mint_tx FROM feather_tickets WHERE id IN ('t1', 't2', 't3') ORDER BY id`);
    expect(minted.map((m) => [m.id, m.status, m.number === null ? null : Number(m.number), m.mint_tx])).toEqual([
      ['t1', 'minted', 42, 'tx-1'],
      ['t2', 'minted', 41, 'tx-1'],
      ['t3', 'held', null, null],
    ]);

    // the same day again moves nothing: chain balances already match what everyone holds
    const again = await buildDayBatch(t.db, t.game.season, day, { feathers: { cap: 5, base: 42 }, renderer });
    expect(again.batch.feather_mints).toEqual([]);
    expect(again.batch.eggs.filter((m) => m.kind !== 'Transfer' && (m.to === 'ada.testnet' || m.from === 'ada.testnet'))).toEqual([]);
    // a contract without Feathers (version 2) gets no feather field at all, and still no hens
    const v2 = await buildDayBatch(t.db, t.game.season, day, { feathers: null, renderer });
    expect('feather_mints' in v2.batch).toBe(false);
    expect(v2.batch.hen_mints).toEqual([]);
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
    expect(r).toMatchObject({ status: 'noop', txHash: null });
    expect(r.digest).toBe(digestOf(r.settlement));
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

describe('the Feather reserve', () => {
  it('mints only as many as the free balance stores above the margin, never past the batch cap', () => {
    const cfg = { mintNear: 0.035, minBalanceNear: 0.5 };
    expect(mintsAffordable(0.45, cfg, 20)).toBe(0);
    expect(mintsAffordable(0.5, cfg, 20)).toBe(0);
    expect(mintsAffordable(0.536, cfg, 20)).toBe(1);
    expect(mintsAffordable(0.675, cfg, 20)).toBe(5);
    expect(mintsAffordable(50, cfg, 20)).toBe(20);
  });
});

describe('agent wallets', () => {
  it("a bust agent's successor takes over its wallet instead of a new funded one", async () => {
    const { successorWallet } = await import('../src/chain/chain');
    const t = await makeGame({ cast: true });
    const [upstart] = await t.db.query(`SELECT id, kind FROM agents WHERE kind = 'upstart' LIMIT 1`);
    expect(await successorWallet(t.db, 'upstart')).toBeNull();
    await t.db.query(`UPDATE agents SET status = 'bust', bust_day = 1, near_account_id = 'upstart1.game.testnet' WHERE id = $1`, [upstart?.id]);
    expect(await successorWallet(t.db, 'upstart')).toBe('upstart1.game.testnet');
    // another kind's wallet is never taken over
    expect(await successorWallet(t.db, 'old-money')).toBeNull();
    await t.db.close();
  });
});
