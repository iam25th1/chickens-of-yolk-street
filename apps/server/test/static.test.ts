// The built client: hashed files are cached for a year, the page is checked every time, and
// precompressed bodies go to browsers that accept them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionSigner } from '../src/auth/session';
import { createGameServer } from '../src/net/server';
import { makeGame, type TestGame } from './helpers';

let t: TestGame;
let server: Server;
let base: string;
let dist: string;
const js = 'console.log("hello from a hashed bundle");'.repeat(40);

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'coys-dist-'));
  mkdirSync(join(dist, 'build'));
  mkdirSync(join(dist, 'assets', 'derived'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>coys</title>');
  writeFileSync(join(dist, 'build', 'index-abc.js'), js);
  writeFileSync(join(dist, 'build', 'index-abc.js.br'), brotliCompressSync(js));
  writeFileSync(join(dist, 'build', 'index-abc.js.gz'), gzipSync(js));
  writeFileSync(join(dist, 'assets', 'derived', 'farm-123.png'), Buffer.from([137, 80, 78, 71]));
  t = await makeGame();
  server = createGameServer({
    game: t.game,
    sessions: createSessionSigner('test-secret'),
    privy: null,
    privyAppId: null,
    devLogin: true,
    clientDist: dist,
    settlementMode: 'noop',
    dbKind: t.db.kind,
    pingDb: () => t.db.query('SELECT 1'),
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.db.close();
  rmSync(dist, { recursive: true, force: true });
});

describe('static files', () => {
  it('sends hashed bundles brotli or gzip compressed with a year of immutable cache', async () => {
    const br = await fetch(`${base}/build/index-abc.js`, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await br.text()).toBe(js);
    const gz = await fetch(`${base}/build/index-abc.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(await gz.text()).toBe(js);
  });

  it('caches derived atlases forever and the page not at all', async () => {
    const atlas = await fetch(`${base}/assets/derived/farm-123.png`);
    expect(atlas.headers.get('cache-control')).toContain('immutable');
    expect(atlas.headers.get('content-type')).toBe('image/png');
    const page = await fetch(`${base}/`);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const missing = await fetch(`${base}/some/route`);
    expect(missing.headers.get('cache-control')).toBe('no-cache');
  });
});
