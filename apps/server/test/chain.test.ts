import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { buildDayBatch, commitBatch } from '../src/chain/batch';
import { NoopChain, agentAccountName, agentPublicKey, assertTestnetConfig } from '../src/chain/chain';
import { HenRenderer } from '../src/chain/hen-image';
import { decodePng } from '../src/chain/png';
import { makeGame } from './helpers';

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
  it('mints collected eggs to wallets, moves sold eggs to buyers, and reconciles from confirmed balances', async () => {
    const t = await makeGame({ cast: true });
    const { playerId, farmId } = await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    await t.db.query(`UPDATE agents SET near_account_id = kind || '1.game.testnet'`);
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    const farm = await t.game.getFarmState(farmId);
    const day = (await t.game.getMarketState()).day - 1;
    const renderer = new HenRenderer(assets);
    const first = await buildDayBatch(t.db, day, { henMintCap: 5, renderer });
    const mintsToAda = first.batch.eggs.filter((m) => m.kind === 'Mint' && m.to === 'ada.testnet');
    const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
    expect(mintsToAda.reduce((s, m) => s + Number(m.amount), 0)).toBeGreaterThanOrEqual(crate);
    expect(first.batch.hen_mints).toHaveLength(5);
    expect(first.batch.hen_mints[0]?.owner_id).toBe('ada.testnet');
    expect(first.batch.digest).toMatch(/^[0-9a-f]{64}$/);
    await commitBatch(t.db, first);

    // the same day again moves nothing: chain balances already match what everyone holds
    const again = await buildDayBatch(t.db, day, { henMintCap: 0, renderer: null });
    expect(again.batch.eggs.filter((m) => m.kind !== 'Transfer' && (m.to === 'ada.testnet' || m.from === 'ada.testnet'))).toEqual([]);
    await t.db.close();
  });

  it('without credentials every day is a loud, recorded no-op', async () => {
    const lines: string[] = [];
    const t = await makeGame();
    const r = await new NoopChain('no keys', (l) => lines.push(l)).settleDay(t.db, 1);
    expect(r).toEqual({ status: 'noop', txHash: null });
    expect(lines.join('\n')).toMatch(/NO-OP for day 1/);
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
