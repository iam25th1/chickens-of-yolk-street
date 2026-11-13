// The demo session (recording the demo video): it signs straight into a new or named farm with no
// login screen, so it must never run in production. It needs DEMO_MODE=1, a server that is not
// production and listens on loopback only, and a request from this machine.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionSigner } from '../src/auth/session';
import { demoSessionAllowed, readConfig } from '../src/env';
import { createGameServer } from '../src/net/server';
import { makeGame, type TestGame } from './helpers';

const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://coys@db/coys', SESSION_SECRET: 'x'.repeat(40), GAME_SEASON: 's1', PRIVY_APP_ID: 'app', PRIVY_VERIFICATION_KEY: 'key' };

describe('the demo session switch', () => {
  it('production refuses it, whatever else is set', () => {
    expect(demoSessionAllowed({ NODE_ENV: 'production', DEMO_MODE: '1', HOST: '127.0.0.1' })).toBe(false);
    expect(readConfig({ ...prod, DEMO_MODE: '1', HOST: '127.0.0.1' }, '/repo').demoSession).toBe(false);
    expect(readConfig({ ...prod, DEMO_MODE: '1', HOST: '127.0.0.1', ALLOW_DEV_LOGIN: '1' }, '/repo').demoSession).toBe(false);
  });

  it('off by default, and off unless the server listens on loopback only', () => {
    expect(demoSessionAllowed({})).toBe(false);
    expect(demoSessionAllowed({ HOST: '127.0.0.1' })).toBe(false);
    expect(demoSessionAllowed({ DEMO_MODE: '1' })).toBe(false);
    expect(demoSessionAllowed({ DEMO_MODE: '1', HOST: '0.0.0.0' })).toBe(false);
    expect(demoSessionAllowed({ DEMO_MODE: '0', HOST: '127.0.0.1' })).toBe(false);
    expect(demoSessionAllowed({ DEMO_MODE: '1', HOST: '127.0.0.1' })).toBe(true);
  });
});

describe('POST /api/login/demo', () => {
  let t: TestGame;
  const servers: Server[] = [];
  const start = async (demoSession: boolean): Promise<string> => {
    const server = createGameServer({
      game: t.game,
      sessions: createSessionSigner('test-secret'),
      privy: null,
      privyAppId: 'app',
      devLogin: false,
      demoSession,
      clientDist: null,
      settlementMode: 'noop',
      dbKind: t.db.kind,
      pingDb: () => t.db.query('SELECT 1'),
      log: () => undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const login = (base: string, farm: string) => fetch(`${base}/api/login/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ farm }) });

  beforeAll(async () => {
    t = await makeGame();
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
    await t.db.close();
  });

  it('a production server (the switch off) refuses it, and says so in its config', async () => {
    const base = await start(false);
    expect((await login(base, 'new')).status).toBe(403);
    expect(((await (await fetch(`${base}/api/config`)).json()) as { demoSession: boolean }).demoSession).toBe(false);
  });

  it('a local demo server signs into a new farm (named later in the game) or an existing farm by name', async () => {
    const base = await start(true);
    const fresh = await login(base, 'new');
    expect(fresh.status).toBe(200);
    const made = (await fresh.json()) as { session: string; name: string };
    expect(made.session.length).toBeGreaterThan(20);
    const again = await login(base, made.name);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { name: string }).name).toBe(made.name);
    expect((await login(base, 'No Such Farm Here')).status).toBe(404);
  });
});
