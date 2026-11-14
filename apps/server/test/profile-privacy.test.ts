// The public profile's privacy: two players sign in with email (as the Privy client does), play, earn
// badges and close a day; anyone may then open any farm's public profile (GET /api/profile/:farmId),
// and it holds only the whitelisted public fields: never coins, orders, a wallet, a player id, a
// sign-in subject, nor any four-letter piece of either email name. The private profile goes only to
// its own player over the WebSocket, and it holds no piece of an email either.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nameLetters, type PublicProfile, type ServerMessage } from '@coys/shared';
import { createSessionSigner } from '../src/auth/session';
import { grantBadge } from '../src/game/badges';
import { sha256Hex } from '../src/game/names';
import { createGameServer } from '../src/net/server';
import { makeGame, type TestGame } from './helpers';

// made-up addresses, chosen so no game word could contain a piece of them by chance
const PLAYERS = [
  { did: 'did:privy:cm0ccc333', email: 'zyxquop.wemba@example.test' },
  { did: 'did:privy:cm0ddd444', email: 'vrooknix_42@example.test' },
];
const local = (email: string) => email.split('@')[0] as string;

/** Every field a public profile may hold; anything else is a leak. */
const PUBLIC_FIELDS = ['badgeCount', 'badges', 'bust', 'daysOnStreet', 'eggsSold', 'farmId', 'farms', 'guest', 'hagglesWon', 'hens', 'kind', 'name', 'rank', 'rivalsOutlasted'];

let t: TestGame;
let server: Server;
let base: string;
const open: WebSocket[] = [];

beforeAll(async () => {
  t = await makeGame({ cast: true });
  server = createGameServer({
    game: t.game,
    sessions: createSessionSigner('test-secret'),
    privy: { verify: async (token: string) => ({ did: token.replace(/^token-/, '') }) },
    privyAppId: 'test-app',
    devLogin: false,
    clientDist: null,
    settlementMode: 'noop',
    dbKind: t.db.kind,
    pingDb: () => t.db.query('SELECT 1'),
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const ws of open) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.db.close();
});

function pieces(email: string): string[] {
  const out = new Set<string>([email.toLowerCase(), local(email).toLowerCase()]);
  const letters = nameLetters(local(email));
  for (let i = 0; i + 4 <= letters.length; i++) out.add(letters.slice(i, i + 4));
  return [...out];
}
function leaks(payload: string): string[] {
  const text = payload.toLowerCase();
  const letters = nameLetters(payload);
  return PLAYERS.flatMap((p) => pieces(p.email).filter((s) => text.includes(s) || letters.includes(s)));
}

describe('the public profile', () => {
  it('holds only public fields and no piece of any email; the private profile reaches only its own player', async () => {
    const sockets: { ws: WebSocket; farmId: string; playerId: string; inbox: ServerMessage[]; raw: string[] }[] = [];
    for (const p of PLAYERS) {
      const res = await fetch(`http://${base}/api/login/privy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: `token-${p.did}-padding-to-length`, name: local(p.email), nameGuard: { sha256: sha256Hex(nameLetters(local(p.email))), len: nameLetters(local(p.email)).length } }),
      });
      expect(res.status).toBe(200);
      const { session } = (await res.json()) as { session: string };
      const ws = new WebSocket(`ws://${base}/ws`);
      open.push(ws);
      const inbox: ServerMessage[] = [];
      const raw: string[] = [];
      ws.on('message', (d) => {
        raw.push(d.toString());
        inbox.push(JSON.parse(d.toString()) as ServerMessage);
      });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ t: 'hello', v: 2, session }));
      for (let i = 0; i < 100 && !inbox.some((m) => m.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20));
      const welcome = inbox.find((m) => m.t === 'welcome');
      if (!welcome || welcome.t !== 'welcome') throw new Error('no welcome');
      sockets.push({ ws, farmId: welcome.farm.farmId, playerId: welcome.playerId, inbox, raw });
    }
    const [a, b] = sockets as [(typeof sockets)[0], (typeof sockets)[0]];
    // A links a wallet, sells and earns badges; a day closes
    a.ws.send(JSON.stringify({ t: 'linkWallet', rid: 'w1', accountId: 'zz-secret-wallet.testnet' }));
    await t.db.query('UPDATE farms SET crate_brown = 20 WHERE id = $1', [a.farmId]);
    a.ws.send(JSON.stringify({ t: 'sell', rid: 's1', items: { brown: 5 } }));
    a.ws.send(JSON.stringify({ t: 'placeOrder', rid: 'o1', grade: 'brown', qty: 5, price: 1 }));
    await new Promise((r) => setTimeout(r, 300));
    await t.game.withCtx((ctx) => grantBadge(ctx, a.farmId, 'haggler', 'gold'));
    t.clock.t += 24 * 3600_000;
    await t.game.endDay();
    await new Promise((r) => setTimeout(r, 300));

    // each asks for their own profile: it comes only to them
    a.ws.send(JSON.stringify({ t: 'getProfile', rid: 'p1' }));
    b.ws.send(JSON.stringify({ t: 'getProfile', rid: 'p2' }));
    await new Promise((r) => setTimeout(r, 400));
    const own = (s: (typeof sockets)[0]) => s.inbox.flatMap((m) => (m.t === 'profile' ? [m.profile] : []));
    expect(own(a).map((p) => p.farmId)).toEqual([a.farmId]);
    expect(own(b).map((p) => p.farmId)).toEqual([b.farmId]);
    expect(own(a)[0]?.badges.find((x) => x.id === 'haggler')?.level).toBe('gold');

    // anyone opens any farm's public profile: the two players, an AI farm, and ids that are no farm
    const [ai] = await t.db.query<{ id: string }>(`SELECT id FROM farms WHERE owner_kind = 'agent' LIMIT 1`);
    const publics: string[] = [];
    const profiles: PublicProfile[] = [];
    for (const id of [a.farmId, b.farmId, String(ai?.id)]) {
      const res = await fetch(`http://${base}/api/profile/${id}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      publics.push(text);
      const { profile } = JSON.parse(text) as { profile: PublicProfile };
      expect(Object.keys(JSON.parse(text) as object)).toEqual(['profile']);
      expect(Object.keys(profile).sort()).toEqual(PUBLIC_FIELDS);
      for (const m of profile.badges) expect(Object.keys(m).sort()).toEqual(['id', 'level']);
      profiles.push(profile);
    }
    for (const bad of ['no-such-farm', '..%2F..%2Fetc', 'x'.repeat(80), "a'b"]) expect((await fetch(`http://${base}/api/profile/${bad}`)).status).toBe(404);
    const [pa, pb, pai] = profiles as [PublicProfile, PublicProfile, PublicProfile];
    expect(pa).toMatchObject({ farmId: a.farmId, kind: 'player', bust: false });
    // five sold to the street, and the order's five may have gone to a buyer at the close
    expect(pa.eggsSold).toBeGreaterThanOrEqual(5);
    expect(pa.badges.map((x) => x.id)).toContain('haggler');
    expect(pa.badgeCount).toBeGreaterThanOrEqual(pa.badges.length);
    expect(pb.kind).toBe('player');
    expect(pai.kind).not.toBe('player');
    expect(pai.badges).toEqual([]);

    // nothing private: no coins, wallet, player id, sign-in subject or order in a public profile
    const [walletRow] = await t.db.query<{ near_account_id: string }>('SELECT near_account_id FROM players WHERE id = $1', [a.playerId]);
    expect(walletRow?.near_account_id).toBe('zz-secret-wallet.testnet');
    for (const text of publics) {
      expect(text).not.toMatch(/cash|milli|wallet|account|player_?id|subject|privy|did:|session|order|ledger|testnet/i);
      for (const s of sockets) expect(text).not.toContain(s.playerId);
    }
    // and no piece of either email anywhere: public profiles, private profiles, the market's ranking
    const market = await (await fetch(`http://${base}/api/market`)).text();
    for (const s of sockets) expect(market).not.toContain(s.playerId);
    const all = [...publics, market, ...a.raw, ...b.raw];
    expect(all.flatMap(leaks)).toEqual([]);
    // the ranking carries each farm's id and best badges, for the public profile
    const ranking = (JSON.parse(market) as { market: { ranking: { farmId: string; badges: unknown[] }[] } }).market.ranking;
    expect(ranking.find((r) => r.farmId === a.farmId)?.badges).toEqual(expect.arrayContaining([{ id: 'haggler', level: 'gold' }]));
    for (const s of sockets) s.ws.close();
  });
});
