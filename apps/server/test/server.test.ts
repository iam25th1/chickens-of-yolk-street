// End to end over HTTP and WebSocket: the server rejects forged prices and balances, needs a
// session, rate-limits, and applies a retried request only once.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ECONOMY, toMilli, type ServerMessage } from '@coys/shared';
import { createSessionSigner } from '../src/auth/session';
import { createGameServer } from '../src/net/server';
import { makeGame, type TestGame } from './helpers';

let t: TestGame;
let server: Server;
let base: string;

beforeAll(async () => {
  t = await makeGame();
  server = createGameServer({
    game: t.game,
    sessions: createSessionSigner('test-secret'),
    privy: null,
    privyAppId: null,
    devLogin: true,
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

class Client {
  readonly inbox: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      const waiter = this.waiters.find((w) => w.pred(m));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(m);
      } else this.inbox.push(m);
    });
  }
  static async open(): Promise<Client> {
    const ws = new WebSocket(`ws://${base}/ws`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Client(ws);
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    const found = this.inbox.find(pred);
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
  ack(rid: string): Promise<ServerMessage> {
    return this.next((m) => m.t === 'ack' && m.rid === rid);
  }
}

async function login(deviceId: string): Promise<string> {
  const res = await fetch(`http://${base}/api/login/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Tester', deviceId }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: string }).session;
}

async function connected(deviceId: string): Promise<{ c: Client; cash: number; welcome: Extract<ServerMessage, { t: 'welcome' }> }> {
  const session = await login(deviceId);
  const c = await Client.open();
  c.send({ t: 'hello', v: 2, session });
  const welcome = await c.next((m) => m.t === 'welcome');
  if (welcome.t !== 'welcome') throw new Error('no welcome');
  return { c, cash: welcome.farm.cashMilli, welcome };
}

async function cashNow(c: Client): Promise<number> {
  for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i]?.t === 'farm') c.inbox.splice(i, 1);
  c.send({ t: 'setFeedTier', rid: `probe-${Math.random()}`, tier: 'standard' });
  const farm = await c.next((m) => m.t === 'farm');
  return farm.t === 'farm' ? farm.farm.cashMilli : NaN;
}

describe('the server is authoritative', () => {
  it('rejects a sell that carries a client price', async () => {
    const { c, cash } = await connected('forge-price-01');
    c.send({ t: 'sell', rid: 'f1', items: { white: 1 }, price: 999 });
    expect(await c.ack('f1')).toMatchObject({ ok: false, code: 'bad_message' });
    c.send({ t: 'sell', rid: 'f2', items: { white: 1, priceMilli: 999_000 } });
    expect(await c.ack('f2')).toMatchObject({ ok: false, code: 'bad_message' });
    expect(await cashNow(c)).toBe(cash);
    c.ws.close();
  });

  it('rejects a client balance, made-up actions and negative counts', async () => {
    const { c, cash } = await connected('forge-cash-01');
    c.send({ t: 'buyHens', rid: 'g1', count: 1, cashMilli: 999_999_999 });
    expect(await c.ack('g1')).toMatchObject({ ok: false, code: 'bad_message' });
    c.send({ t: 'setCash', rid: 'g2', cashMilli: 999_999_999 });
    expect(await c.ack('g2')).toMatchObject({ ok: false, code: 'bad_message' });
    c.send({ t: 'buyHens', rid: 'g3', count: -5 });
    expect(await c.ack('g3')).toMatchObject({ ok: false, code: 'bad_message' });
    c.send({ t: 'buyFeed', rid: 'g4', tier: 'premium', bags: 1 });
    expect(await c.ack('g4')).toMatchObject({ ok: false, code: 'insufficient_funds' });
    expect(await cashNow(c)).toBe(cash);
    c.ws.close();
  });

  it('refuses actions before hello and bad sessions', async () => {
    const c = await Client.open();
    c.send({ t: 'buyHens', rid: 'h1', count: 1 });
    expect(await c.ack('h1')).toMatchObject({ ok: false, code: 'unauthenticated' });
    c.send({ t: 'hello', v: 2, session: 'forged.token' });
    expect(await c.next((m) => m.t === 'error')).toMatchObject({ code: 'unauthenticated' });
  });

  it('applies a retried request id once', async () => {
    const { c, cash } = await connected('dedupe-0001');
    c.send({ t: 'buyHens', rid: 'same', count: 1 });
    expect(await c.ack('same')).toMatchObject({ ok: true });
    c.send({ t: 'buyHens', rid: 'same', count: 1 });
    expect(await c.ack('same')).toMatchObject({ ok: true, duplicate: true });
    expect(await cashNow(c)).toBe(cash - toMilli(ECONOMY.hen.price));
    c.ws.close();
  });

  it('rate-limits a burst of actions per player', async () => {
    const { c } = await connected('burst-00001');
    for (let i = 0; i < 40; i++) c.send({ t: 'setFeedTier', rid: `b${i}`, tier: 'cheap' });
    const acks = await Promise.all(Array.from({ length: 40 }, (_, i) => c.ack(`b${i}`)));
    const limited = acks.filter((a) => a.t === 'ack' && !a.ok && a.code === 'rate_limited');
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.length).toBeLessThan(40);
    c.ws.close();
  });

  it('serves the public market and config', async () => {
    const market = (await (await fetch(`http://${base}/api/market`)).json()) as { market: { day: number } };
    expect(market.market.day).toBe(1);
    const config = (await (await fetch(`http://${base}/api/config`)).json()) as { devLogin: boolean; privyAppId: null };
    expect(config).toMatchObject({ devLogin: true, privyAppId: null });
  });
});

describe('one shared market', () => {
  it('two real clients see the same prices and each other\'s trades', async () => {
    const a = await connected('shared-mkt-a');
    const b = await connected('shared-mkt-b');
    const wa = a.welcome;
    const wb = b.welcome;
    expect(wa.market.pricesMilli).toEqual(wb.market.pricesMilli);
    expect(wa.market.multiplier).toBe(wb.market.multiplier);

    // A sells a crate of golden eggs into the street
    await t.db.query('UPDATE farms SET crate_golden = 10 WHERE id = $1', [wa.farm.farmId]);
    a.c.send({ t: 'sell', rid: 'gold', items: { golden: 10 } });
    expect(await a.c.ack('gold')).toMatchObject({ ok: true });
    const big = await b.c.next((m) => m.t === 'event' && m.event.kind === 'bigTrade');
    if (big.t !== 'event' || big.event.kind !== 'bigTrade') throw new Error('no trade');
    expect(big.event.trade).toMatchObject({ seller: wa.farm.name, grade: 'golden', qty: 10 });
    const seenByB = await b.c.next((m) => m.t === 'market' && m.market.supplyToday >= 10);
    const seenByA = await a.c.next((m) => m.t === 'market' && m.market.supplyToday >= 10);
    if (seenByA.t !== 'market' || seenByB.t !== 'market') throw new Error('no market');
    expect(seenByB.market.supplyToday).toBe(seenByA.market.supplyToday);
    expect(seenByB.market.trades[0]).toMatchObject({ seller: wa.farm.name, qty: 10 });
    a.c.ws.close();
    b.c.ws.close();
  });
});
