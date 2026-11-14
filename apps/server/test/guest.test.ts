// Guest play: PLAY starts a farm with no sign-in, on a signed HttpOnly cookie; the limits per address
// and per hour; guests never mint; signing in carries every part of the farm into the account (or
// the player chooses which farm to keep); idle guest farms go bust after seven days; and signed-in
// sessions work as before.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GUEST_MINT_TEXT, type ServerMessage } from '@coys/shared';
import { GUEST_COOKIE, createGuestAuth, readCookie } from '../src/auth/guest';
import type { PrivyVerifier } from '../src/auth/privy';
import { createSessionSigner } from '../src/auth/session';
import { GUEST_IDLE_MS } from '../src/game/guests';
import { createGameServer } from '../src/net/server';
import { makeGame, type TestGame } from './helpers';

const SECRET = 'guest-test-secret';

/** Every table with a farm_id column, and how many of its rows belong to this farm. */
async function farmRows(t: TestGame, farmId: string): Promise<Record<string, number>> {
  const tables = await t.db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE column_name = 'farm_id' AND table_schema = 'public' ORDER BY table_name`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [r] = await t.db.query(`SELECT count(*) AS n FROM ${table_name} WHERE farm_id = $1`, [farmId]);
    out[table_name] = Number(r?.n ?? 0);
  }
  return out;
}

const farmOf = async (t: TestGame, playerId: string) => (await t.db.query('SELECT * FROM farms WHERE player_id = $1', [playerId]))[0] ?? null;

describe('guest farms in the game', () => {
  let t: TestGame;
  beforeAll(async () => {
    t = await makeGame();
  });
  afterAll(async () => {
    await t.db.close();
  });

  it('a guest farm starts at once with a generated name, no naming card, and a random unguessable player', async () => {
    const g = await t.game.startGuest('ip-a', { perIpPerDay: 3, perHour: 60 });
    if (!g.ok) throw new Error('refused');
    const [p] = await t.db.query('SELECT auth_provider, auth_subject, near_account_id FROM players WHERE id = $1', [g.playerId]);
    expect(p?.auth_provider).toBe('guest');
    expect(String(p?.auth_subject)).toMatch(/^[0-9a-f]{32}$/);
    expect(p?.near_account_id).toBeNull();
    const state = await t.game.getFarmState(g.farmId);
    expect(state.guest).toBe(true);
    expect(state.needsName).toBe(false);
    expect(state.name).toBe(g.name);
    expect((await t.game.getMarketState()).ranking.find((r) => r.farmId === g.farmId)?.guest).toBe(true);
    expect((await t.game.getPublicProfile(g.farmId))?.guest).toBe(true);
  });

  it('at most perIpPerDay new guest farms from one address a day, and perHour from everyone', async () => {
    const limits = { perIpPerDay: 3, perHour: 5 };
    for (let i = 0; i < 3; i++) expect((await t.game.startGuest('ip-b', limits)).ok).toBe(true);
    expect(await t.game.startGuest('ip-b', limits)).toEqual({ ok: false, limit: 'ip' });
    // ip-a started one above (an hour ago now is still within it): 1 + 3 + 1 = 5 this hour
    expect((await t.game.startGuest('ip-c', limits)).ok).toBe(true);
    expect(await t.game.startGuest('ip-d', limits)).toEqual({ ok: false, limit: 'hour' });
    t.clock.t += 61 * 60 * 1000;
    expect((await t.game.startGuest('ip-d', limits)).ok).toBe(true);
    expect(await t.game.startGuest('ip-b', limits)).toEqual({ ok: false, limit: 'ip' });
    t.clock.t += 23 * 60 * 60 * 1000;
    expect((await t.game.startGuest('ip-b', limits)).ok).toBe(true);
  });

  it('a guest is refused a Feather mint and a wallet, with the sign-in line', async () => {
    const g = await t.game.startGuest('ip-e', { perIpPerDay: 3, perHour: 60 });
    if (!g.ok) throw new Error('refused');
    await t.db.query("INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, 'full-coop', $3, 1, 0)", [`${g.farmId}-t`, g.farmId, t.game.season]);
    expect(await t.game.act(g.playerId, { t: 'redeemTicket', rid: 'r1', ticketId: `${g.farmId}-t` })).toEqual({ ok: false, code: 'sign_in', message: GUEST_MINT_TEXT });
    expect(await t.game.act(g.playerId, { t: 'linkWallet', rid: 'r2', accountId: 'someone.testnet' })).toEqual({ ok: false, code: 'sign_in', message: GUEST_MINT_TEXT });
    const [p] = await t.db.query('SELECT near_account_id FROM players WHERE id = $1', [g.playerId]);
    expect(p?.near_account_id).toBeNull();
    const [ticket] = await t.db.query('SELECT status FROM feather_tickets WHERE id = $1', [`${g.farmId}-t`]);
    expect(ticket?.status).toBe('held');
    // the rest of the game is theirs: an ordinary action goes through
    expect((await t.game.act(g.playerId, { t: 'setFeedTier', rid: 'r3', tier: 'standard' })).ok).toBe(true);
  });

  it('signing in carries every part of the guest farm into a new account, in one step', async () => {
    const g = await t.game.startGuest('ip-f', { perIpPerDay: 3, perHour: 60 });
    if (!g.ok) throw new Error('refused');
    // a farm with some history: days closed, a hen bought, land, a machine, a badge, a ticket
    await t.game.endDay();
    const shop = (await t.game.getFarmState(g.farmId)).shop[0];
    if (shop) expect((await t.game.act(g.playerId, { t: 'buyHen', rid: 'h1', henId: shop.id })).ok).toBe(true);
    await t.db.query("INSERT INTO farm_land (farm_id, plot, bought_day, price_milli) VALUES ($1, 'east', 1, 0)", [g.farmId]);
    await t.db.query("INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, 'conveyor', 1)", [g.farmId]);
    await t.db.query("INSERT INTO badges (farm_id, badge, tier, earned_day, progress) VALUES ($1, 'first-egg', 'plain', 1, 1) ON CONFLICT DO NOTHING", [g.farmId]);
    await t.db.query("INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, 'eggs-sold', $3, 1, 0)", [`${g.farmId}-t`, g.farmId, t.game.season]);
    await t.game.endDay();
    const before = await farmRows(t, g.farmId);
    const farmBefore = await farmOf(t, g.playerId);
    expect(before.ledger).toBeGreaterThan(0);
    expect(before.hens).toBeGreaterThan(0);

    const done = await t.game.claimGuest(g.playerId, 'privy', 'did:privy:new-one', { sha256: 'a'.repeat(64), len: 5 }, null);
    expect(done).toMatchObject({ status: 'done', kept: 'guest', farmId: g.farmId, created: true });
    if (done?.status !== 'done') throw new Error('not done');
    // the same farm, every row it had, now the account's; the guest player holds nothing
    expect(await farmRows(t, g.farmId)).toEqual(before);
    const after = await farmOf(t, done.playerId);
    expect(after?.id).toBe(g.farmId);
    expect({ ...after, player_id: null, needs_name: null }).toEqual({ ...farmBefore, player_id: null, needs_name: null });
    expect(await farmOf(t, g.playerId)).toBeNull();
    const [account] = await t.db.query('SELECT auth_provider, auth_subject, name_guard_sha256 FROM players WHERE id = $1', [done.playerId]);
    expect(account).toEqual({ auth_provider: 'privy', auth_subject: 'did:privy:new-one', name_guard_sha256: 'a'.repeat(64) });
    // the farm is no longer a guest's: it may mint, and it is offered a free rename (KEEP keeps the name)
    const state = await t.game.getFarmState(g.farmId);
    expect(state.guest).toBe(false);
    expect(state.needsName).toBe(true);
    expect(state.renameFromDay).toBeNull();
    expect(state.name).toBe(farmBefore?.name);
    expect(await t.game.playerInfo(g.playerId)).toBeNull();
    // the same guest cannot claim twice
    expect(await t.game.claimGuest(g.playerId, 'privy', 'did:privy:another', null, null)).toBeNull();
  });

  it('a guest farm whose name holds the email name gets a generated one when it moves', async () => {
    const g = await t.game.startGuest('ip-g', { perIpPerDay: 3, perHour: 60 });
    if (!g.ok) throw new Error('refused');
    await t.db.query("UPDATE farms SET name = 'Henrietta Acres' WHERE id = $1", [g.farmId]);
    const { nameGuardOf } = await import('../src/game/names');
    const done = await t.game.claimGuest(g.playerId, 'privy', 'did:privy:henrietta', nameGuardOf('henrietta'), null);
    if (done?.status !== 'done') throw new Error('not done');
    const state = await t.game.getFarmState(g.farmId);
    expect(state.name).not.toContain('Henrietta');
    expect(state.needsName).toBe(true);
  });

  it('an account that already has a farm chooses: keep the guest farm (the other is retired) or keep the account farm', async () => {
    const acct = await t.game.ensurePlayer('dev', 'device-has-a-farm', 'Old Barn Farm');
    const g = await t.game.startGuest('ip-h', { perIpPerDay: 3, perHour: 60 });
    if (!g.ok) throw new Error('refused');
    const ask = await t.game.claimGuest(g.playerId, 'dev', 'device-has-a-farm', null, null);
    expect(ask?.status).toBe('choose');
    if (ask?.status !== 'choose') throw new Error('no choice');
    expect(ask.guest.name).toBe(g.name);
    expect(ask.account.name).toBe('Old Barn Farm');
    expect(ask.account.hens).toBeGreaterThan(0);
    // asking changes nothing
    expect((await farmOf(t, acct.playerId))?.id).toBe(acct.farmId);
    expect((await farmOf(t, g.playerId))?.id).toBe(g.farmId);

    const kept = await t.game.claimGuest(g.playerId, 'dev', 'device-has-a-farm', null, 'guest');
    expect(kept).toMatchObject({ status: 'done', kept: 'guest', playerId: acct.playerId, farmId: g.farmId, created: false });
    expect((await farmOf(t, acct.playerId))?.id).toBe(g.farmId);
    const [old] = await t.db.query('SELECT f.bust_day, p.auth_provider FROM farms f JOIN players p ON p.id = f.player_id WHERE f.id = $1', [acct.farmId]);
    expect(old?.bust_day).not.toBeNull();
    expect(old?.auth_provider).toBe('retired');
    expect(Number((await t.db.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [acct.farmId]))[0]?.n)).toBe(0);
    // the account signs in as before, now to the farm it kept
    expect((await t.game.ensurePlayer('dev', 'device-has-a-farm', null)).farmId).toBe(g.farmId);

    // the other way: keep the account's farm; the guest farm is retired
    const g2 = await t.game.startGuest('ip-h', { perIpPerDay: 3, perHour: 60 });
    if (!g2.ok) throw new Error('refused');
    const keptAccount = await t.game.claimGuest(g2.playerId, 'dev', 'device-has-a-farm', null, 'account');
    expect(keptAccount).toMatchObject({ status: 'done', kept: 'account', playerId: acct.playerId, farmId: g.farmId });
    expect((await farmOf(t, g2.playerId))?.bust_day).not.toBeNull();
    expect(await t.game.guestFarm(g2.playerId)).toBeNull();
  });

  it('a guest farm idle for seven real days goes bust at the day close; an active guest and a signed-in farm do not', async () => {
    const idle = await t.game.startGuest('ip-i', { perIpPerDay: 3, perHour: 60 });
    const active = await t.game.startGuest('ip-i', { perIpPerDay: 3, perHour: 60 });
    const signed = await t.game.ensurePlayer('dev', 'device-away-a-while', null);
    if (!idle.ok || !active.ok) throw new Error('refused');
    // the idle guest won a ticket: while the farm is open it holds a Feather back
    await t.db.query("INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, 'full-coop', $3, 1, 0)", [`${idle.farmId}-t`, idle.farmId, t.game.season]);
    const { featherCount } = await import('../src/game/feathers');
    expect((await featherCount(t.db, 0)).tickets).toBeGreaterThan(0);
    t.clock.t += GUEST_IDLE_MS - 60_000;
    await t.game.touch(active.playerId);
    await t.game.endDay();
    expect((await farmOf(t, idle.playerId))?.bust_day).toBeNull();
    t.clock.t += 2 * 60_000;
    await t.game.endDay();
    expect((await farmOf(t, idle.playerId))?.bust_day).not.toBeNull();
    expect(Number((await t.db.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [idle.farmId]))[0]?.n)).toBe(0);
    // its ticket stays in its records but no longer holds a Feather back
    expect((await t.db.query('SELECT status FROM feather_tickets WHERE id = $1', [`${idle.farmId}-t`]))[0]?.status).toBe('held');
    const counted = (await featherCount(t.db, 0)).tickets;
    const [{ bust_day: bustDay } = { bust_day: null }] = await t.db.query('SELECT bust_day FROM farms WHERE id = $1', [idle.farmId]);
    await t.db.query('UPDATE farms SET bust_day = NULL WHERE id = $1', [idle.farmId]);
    expect((await featherCount(t.db, 0)).tickets).toBe(counted + 1);
    await t.db.query('UPDATE farms SET bust_day = $2 WHERE id = $1', [idle.farmId, bustDay]);
    expect((await farmOf(t, active.playerId))?.bust_day).toBeNull();
    expect((await farmOf(t, signed.playerId))?.bust_day).toBeNull();
    // a bust guest farm is not resumed: PLAY starts a new one
    expect(await t.game.guestFarm(idle.playerId)).toBeNull();
  });
});

describe('guest sessions over HTTP and WebSocket', () => {
  let t: TestGame;
  let server: Server;
  let base = '';
  const sessions = createSessionSigner(SECRET);
  const guestAuth = createGuestAuth(SECRET);
  const privy: PrivyVerifier = { verify: async (token) => ({ did: `did:privy:${token.slice(0, 24)}` }) };

  beforeAll(async () => {
    t = await makeGame();
    server = createGameServer({
      game: t.game,
      sessions,
      privy,
      privyAppId: 'app',
      devLogin: true,
      guest: { auth: guestAuth, limits: { perIpPerDay: 3, perHour: 60 } },
      clientDist: null,
      settlementMode: 'noop',
      dbKind: t.db.kind,
      log: () => undefined,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.db.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const cookieOf = (res: Response): string | null => readCookie(res.headers.get('set-cookie')?.split(';')[0], GUEST_COOKIE);

  /** Says hello over the websocket (with these cookies) and returns the first answer. */
  const hello = async (session: string, cookie?: string): Promise<ServerMessage> => {
    const ws = new WebSocket(`ws://${base}/ws`, cookie ? { headers: { cookie } } : undefined);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const answer = new Promise<ServerMessage>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()) as ServerMessage)));
    ws.send(JSON.stringify({ t: 'hello', v: 2, session }));
    const m = await answer;
    ws.close();
    return m;
  };

  it('PLAY gets a signed, HttpOnly, Secure, SameSite=Lax cookie and no token in the body', async () => {
    const res = await post('/api/login/guest', {}, { 'cf-connecting-ip': '203.0.113.1' });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(new RegExp(`^${GUEST_COOKIE}=`));
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(set).toContain(attr);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['guest', 'name']);
    const token = cookieOf(res);
    if (!token) throw new Error('no cookie');
    // signed with the guest key: it names a guest player, and is no session token
    const id = guestAuth.signer.verify(token);
    expect(id).not.toBeNull();
    expect(sessions.verify(token)).toBeNull();
    // the websocket takes it as the guest's session
    const welcome = await hello('guest', `${GUEST_COOKIE}=${token}`);
    expect(welcome.t).toBe('welcome');
    if (welcome.t === 'welcome') expect(welcome.farm.guest).toBe(true);
    // PLAY again with the cookie: the same farm, not a new one
    const again = await post('/api/login/guest', {}, { cookie: `${GUEST_COOKIE}=${token}`, 'cf-connecting-ip': '203.0.113.1' });
    expect(((await again.json()) as { name: string }).name).toBe(body.name);
    expect(guestAuth.signer.verify(cookieOf(again) ?? '')).toBe(id);
  });

  it('a tampered or forged guest cookie is refused', async () => {
    const res = await post('/api/login/guest', {}, { 'cf-connecting-ip': '203.0.113.2' });
    const token = cookieOf(res) ?? '';
    const [payload, sig] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ p: 'someone-else', e: Date.now() + 1e9 })).toString('base64url');
    for (const bad of [`${forgedPayload}.${sig}`, `${payload}.${sig?.slice(0, -2)}xx`, sessions.sign('someone-else'), 'nonsense']) {
      const m = await hello('guest', `${GUEST_COOKIE}=${bad}`);
      expect(m).toMatchObject({ t: 'error', code: 'unauthenticated' });
    }
    // no cookie at all
    expect(await hello('guest')).toMatchObject({ t: 'error', code: 'unauthenticated' });
  });

  it('a fourth new guest farm from one address is refused with guest_limit (another address still starts)', async () => {
    const ip = { 'cf-connecting-ip': '198.51.100.7' };
    for (let i = 0; i < 3; i++) expect((await post('/api/login/guest', {}, ip)).status).toBe(200);
    const over = await post('/api/login/guest', {}, ip);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'guest_limit', limit: 'ip' });
    expect((await post('/api/login/guest', {}, { 'cf-connecting-ip': '198.51.100.8' })).status).toBe(200);
    // the address itself is never stored, only its keyed hash
    const rows = await t.db.query('SELECT ip_hash FROM guest_starts');
    expect(rows.some((r) => String(r.ip_hash).includes('198.51'))).toBe(false);
  });

  it('signing in with the guest cookie moves the farm to the account and ends the cookie', async () => {
    const res = await post('/api/login/guest', {}, { 'cf-connecting-ip': '203.0.113.3' });
    const cookie = `${GUEST_COOKIE}=${cookieOf(res)}`;
    const guestWelcome = await hello('guest', cookie);
    if (guestWelcome.t !== 'welcome') throw new Error('no welcome');
    const signIn = await post('/api/login/privy', { accessToken: 'token-for-a-brand-new-player' }, { cookie });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get('set-cookie')).toMatch(new RegExp(`^${GUEST_COOKIE}=; Path=/; Max-Age=0`));
    const login = (await signIn.json()) as { session: string; carried: boolean };
    expect(login.carried).toBe(true);
    const welcome = await hello(login.session);
    if (welcome.t !== 'welcome') throw new Error('no welcome');
    expect(welcome.farm.farmId).toBe(guestWelcome.farm.farmId);
    expect(welcome.farm.guest).toBe(false);
    // the old guest cookie no longer opens anything
    expect(await hello('guest', cookie)).toMatchObject({ t: 'error', code: 'unauthenticated' });
  });

  it('an account with a farm is asked to choose (409), then keeps the farm it names', async () => {
    const first = (await (await post('/api/login/privy', { accessToken: 'token-for-a-returning-player' })).json()) as { session: string };
    const own = await hello(first.session);
    if (own.t !== 'welcome') throw new Error('no welcome');
    const res = await post('/api/login/guest', {}, { 'cf-connecting-ip': '203.0.113.4' });
    const cookie = `${GUEST_COOKIE}=${cookieOf(res)}`;
    const ask = await post('/api/login/privy', { accessToken: 'token-for-a-returning-player' }, { cookie });
    expect(ask.status).toBe(409);
    const choice = (await ask.json()) as { error: string; choose: { guest: { name: string }; account: { name: string } } };
    expect(choice.error).toBe('choose');
    expect(choice.choose.account.name).toBe(own.farm.name);
    const keep = await post('/api/login/privy', { accessToken: 'token-for-a-returning-player', keep: 'account' }, { cookie });
    expect(keep.status).toBe(200);
    const back = await hello(((await keep.json()) as { session: string }).session);
    if (back.t !== 'welcome') throw new Error('no welcome');
    expect(back.farm.farmId).toBe(own.farm.farmId);
  });

  it('signed-in sessions work as before, with no cookie', async () => {
    const res = await post('/api/login/dev', { deviceId: 'device-plain-12345' });
    const { session } = (await res.json()) as { session: string };
    expect(res.headers.get('set-cookie')).toBeNull();
    const welcome = await hello(session);
    expect(welcome.t).toBe('welcome');
    if (welcome.t === 'welcome') expect(welcome.farm.guest).toBe(false);
    expect(((await (await fetch(`http://${base}/api/config`)).json()) as { guestPlay: boolean }).guestPlay).toBe(true);
  });
});
