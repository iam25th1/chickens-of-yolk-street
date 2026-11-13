// Privacy: two players sign in with email (as the Privy client does, an older client even sending
// its email name), trade with each other and the street, and nothing any player or the public
// receives (WebSocket messages, the public market and mint page) contains either email or any
// four-letter piece of either email name. Farm names are generated, never taken from sign-in.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nameLetters, type ServerMessage } from '@coys/shared';
import { createSessionSigner } from '../src/auth/session';
import { sha256Hex } from '../src/game/names';
import { createGameServer } from '../src/net/server';
import { makeGame, type TestGame } from './helpers';

// made-up addresses, chosen so no game word could contain a piece of them by chance
const PLAYERS = [
  { did: 'did:privy:cm0aaa111', email: 'qwyzzle.vrkt@example.test' },
  { did: 'did:privy:cm0bbb222', email: 'brrmvix_77@example.test' },
];
const local = (email: string) => email.split('@')[0] as string;

let t: TestGame;
let server: Server;
let base: string;

beforeAll(async () => {
  t = await makeGame({ cast: true });
  server = createGameServer({
    game: t.game,
    sessions: createSessionSigner('test-secret'),
    // a stand-in for Privy's token check: the token names the player's id
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.db.close();
});

/** Every piece of an email a payload must never hold: the address, and each run of four letters or digits of its name. */
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

describe('player emails never reach anyone', () => {
  it('two email players: no payload holds either email or any piece of either email name', async () => {
    const received: string[] = [];
    const sockets: { ws: WebSocket; farmId: string; inbox: ServerMessage[] }[] = [];
    for (const p of PLAYERS) {
      const res = await fetch(`http://${base}/api/login/privy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // an older client also sent the email name as `name`: the server must ignore it
        body: JSON.stringify({ accessToken: `token-${p.did}-padding-to-length`, name: local(p.email), nameGuard: { sha256: sha256Hex(nameLetters(local(p.email))), len: nameLetters(local(p.email)).length } }),
      });
      const text = await res.text();
      received.push(text);
      expect(res.status).toBe(200);
      const { session } = JSON.parse(text) as { session: string };
      const ws = new WebSocket(`ws://${base}/ws`);
      const inbox: ServerMessage[] = [];
      ws.on('message', (d) => {
        received.push(d.toString());
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
      expect(welcome.farm.needsName).toBe(true);
      sockets.push({ ws, farmId: welcome.farm.farmId, inbox });
    }
    const [a, b] = sockets as [(typeof sockets)[0], (typeof sockets)[0]];
    // A posts a sell order (B sees it in the book and as a trade card), sells to the street, and B buys from A
    await t.db.query('UPDATE farms SET crate_brown = 20, crate_golden = 10 WHERE id = $1', [a.farmId]);
    a.ws.send(JSON.stringify({ t: 'placeOrder', rid: 'o1', grade: 'brown', qty: 5, price: 1 }));
    a.ws.send(JSON.stringify({ t: 'sell', rid: 's1', items: { golden: 10 } }));
    await new Promise((r) => setTimeout(r, 300));
    const book = (await t.game.getMarketState()).book.find((o) => o.side === 'sell' && o.mine === false);
    if (book) b.ws.send(JSON.stringify({ t: 'fillOrder', rid: 'f1', orderId: book.id, qty: 2 }));
    // a day closes, so ledgers, rankings and cards go round
    t.clock.t += 24 * 3600_000;
    await t.game.endDay();
    await new Promise((r) => setTimeout(r, 300));
    for (const path of ['/api/market', '/api/feathers', '/api/config', '/healthz']) received.push(await (await fetch(`http://${base}${path}`)).text());
    for (const s of sockets) s.ws.close();

    expect(received.length).toBeGreaterThan(10);
    const found = received.flatMap(leaks);
    expect(found, 'pieces of an email in a payload').toEqual([]);
    // and the farms' public names are generated, not the email names
    const names = (await t.db.query<{ name: string }>(`SELECT name FROM farms WHERE owner_kind = 'player'`)).map((r) => r.name);
    expect(names).toHaveLength(2);
    for (const n of names) expect(leaks(n)).toEqual([]);
    // (the farms' names did go round: the check above looked at real traffic)
    for (const n of names) expect(received.some((r) => r.includes(n)), n).toBe(true);
    // the database keeps only the email-name guard (a hash), never the name
    const rows = await t.db.query(`SELECT * FROM players`);
    expect(rows.flatMap((r) => leaks(JSON.stringify(r)))).toEqual([]);
  });
});

describe('logs', () => {
  it('replace anything shaped like an email address', async () => {
    const { redactEmails } = await import('../src/redact');
    expect(redactEmails('[http] POST /api/login/privy failed for someone.name+tag@mail.example.co.uk today')).toBe('[http] POST /api/login/privy failed for [email] today');
    expect(redactEmails('[chain] season s1 day 3 settled: 4ZbiAX13 (play.coys-game.testnet)')).toBe('[chain] season s1 day 3 settled: 4ZbiAX13 (play.coys-game.testnet)');
  });
});
