// The real game server for the browser checks: a memory database, no chain (every day a recorded
// no-op), the local dev login, the built client (apps/client/dist), and a clock the test can move
// forward to close days. Never touches NEAR: its Feather mints are a stand-in that answers after a
// short wait (the next ones can be made to fail, as NEAR refusing them would). A named farm can be
// given every machine, a handful of Feather tickets and a wallet, so every screen has content to page;
// the Market can be given eggs to sell, a buyer's order, another player's offer and auction hens;
// and a farm can be given a badge, so its player sees the unlock moment. Guest play is on (PLAY starts
// a guest farm on a cookie), and a farm can win a Feather ticket as a milestone roll would give it.
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ECONOMY, type EggGrade } from '@coys/shared';
import { InferenceBudget } from '../apps/server/src/agents/brain';
import { ProviderChain } from '../apps/server/src/ai/chain';
import { createGuestAuth } from '../apps/server/src/auth/guest';
import { createSessionSigner } from '../apps/server/src/auth/session';
import { NoopChain, type ChainWriter, type MintResult } from '../apps/server/src/chain/chain';
import { openDb } from '../apps/server/src/db/db';
import { grantBadge } from '../apps/server/src/game/badges';
import { Game } from '../apps/server/src/game/game';
import { createGameServer } from '../apps/server/src/net/server';

const DAY_MS = 60_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

export interface TestServer {
  url: string;
  /** Closes n days, as if their time had passed. */
  closeDays(n: number): Promise<void>;
  /** Gives the farm of this name every machine and `tickets` Feather tickets. */
  seed(name: string, tickets: number): Promise<void>;
  /** Links a (made-up) testnet wallet to the named farm's player, so its mints can go out. */
  wallet(name: string, account: string): Promise<void>;
  /** The next n mints fail, as if NEAR testnet refused them after every retry. */
  failMints(n: number): void;
  /** Sets the condition (and broken flag) of the named farm's machines. */
  wear(name: string, machines: Record<string, { condition: number; broken?: boolean }>): Promise<void>;
  /** Days close only when closeDays says (true), or on their own again when their time is up (false). */
  hold(on: boolean): void;
  /** Gives the named farm n more hens (copies of one of its own), as a big flock has, and sends the farm its fresh state. */
  flock(name: string, n: number): Promise<void>;
  /** Sets the named farm's coins (a rich farm's long numbers) and sends the farm its fresh state. */
  cash(name: string, coins: number): Promise<void>;
  /** Shows every player this day number on the clock (a long season's day: four or five digits). Only the clock: nothing closes. */
  day(n: number): void;
  /** Puts these eggs in the named farm's crate and sends the farm its fresh state. */
  crate(name: string, eggs: Partial<Record<EggGrade, number>>): Promise<void>;
  /** An AI buyer's order for eggs at this share of today's price, open for three days; the browsers see it with the next market. Returns its id. */
  buyOrder(grade: EggGrade, qty: number, share: number): Promise<string>;
  /** The AI buyers take back their open orders for these grades (as when they have bought enough), so an offer at a higher price than today's rests instead of filling. */
  pullBids(grades: EggGrade[]): Promise<void>;
  /** n of the breeder's hens go to auction, as a bust farm's would; a farm sees them with its next state. */
  auction(n: number): Promise<void>;
  /** Another player's farm (made as the dev login makes one) offers its eggs at this share of today's price; every browser gets the market. Returns the farm's name and the order's id. */
  trader(name: string, grade: EggGrade, qty: number, share: number): Promise<{ name: string; orderId: string }>;
  /** Gives the named farm a badge at a level now: its player hears it at once (the unlock moment). */
  badge(name: string, badge: string, level: 'bronze' | 'silver' | 'gold' | 'plain'): Promise<void>;
  /** The named farm wins a Feather ticket at a milestone, as a day close's roll would give it: its player hears the roll at once. */
  ticketWon(name: string): Promise<void>;
  /** The named farm's eggs in the crate and its coins (milli), as the server holds them. */
  farmNow(name: string): Promise<{ crate: number; cashMilli: number; guest: boolean }>;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const db = await openDb('memory://');
  let offset = 0;
  const now = () => Date.now() + offset;
  const quiet = () => undefined;
  // no chain, but reported as minting, so the screens show the texts the live game shows; a mint
  // answers after a short wait, as NEAR would (or fails, when the check asks for it)
  const noop = new NoopChain('browser checks', quiet);
  let failing = 0;
  const chain: ChainWriter = {
    mode: 'noop',
    explorer: 'https://testnet.nearblocks.io/txns/',
    minting: 'live',
    featherMinted: 0,
    provenance: null,
    contractId: null,
    settleDay: (q, season, day) => noop.settleDay(q, season, day),
    collectionFor: async () => 'live',
    mintFeather: async (req): Promise<MintResult> => {
      await new Promise((r) => setTimeout(r, 900));
      if (failing > 0) {
        failing--;
        return { status: 'failed', txHash: null, token: null, mediaSha256: null, note: 'NEAR testnet refused the call, even after a few tries' };
      }
      const token = String(req.number).padStart(3, '0');
      return { status: 'sent', txHash: `browser-check-${token}`, token, mediaSha256: 'browser-check' };
    },
  };
  const game = new Game({
    db,
    chain,
    now,
    log: quiet,
    season: 'checks',
    dayLengthMs: DAY_MS,
    provenance: 'bd2daafdc6efe9a68f19d87291d0a41d9ca6cd98a1b1d47568fc06d410ac0651',
    brain: { chain: new ProviderChain([]), budget: new InferenceBudget(db, 0, now), pricing: new Map() },
  });
  await game.init();
  const server = createGameServer({
    game,
    sessions: createSessionSigner('browser-checks-only'),
    privy: null,
    privyAppId: null,
    devLogin: true,
    guest: { auth: createGuestAuth('browser-checks-only'), limits: { perIpPerDay: 1000, perHour: 1000 } },
    clientDist: fileURLToPath(new URL('../apps/client/dist', import.meta.url)),
    settlementMode: 'noop',
    dbKind: db.kind,
    pingDb: () => db.query('SELECT 1'),
    log: quiet,
  });
  let held = false;
  let bids = 0;
  const timer = setInterval(() => {
    if (!held) void game.tick().catch(() => undefined);
  }, 1000);
  /** The named farm, and its player. */
  const farmNamed = async (name: string) => {
    const [farm] = await db.query<{ id: string; player_id: string; clerk_floor: number }>('SELECT id, player_id, clerk_floor FROM farms WHERE name LIKE $1 LIMIT 1', [`${name}%`]);
    if (!farm) throw new Error(`no farm named ${name}`);
    return farm;
  };
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    async closeDays(n) {
      for (let i = 0; i < n; i++) {
        offset += DAY_MS;
        await game.tick();
      }
    },
    async seed(name, tickets) {
      const [farm] = await db.query<{ id: string }>('SELECT id FROM farms WHERE name LIKE $1 LIMIT 1', [`${name}%`]);
      if (!farm) throw new Error(`no farm named ${name}`);
      for (const u of ['conveyor', 'grader', 'cart', 'hopper', 'clerk']) await db.query('INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING', [farm.id, u]);
      const milestones = ['full-coop', 'eggs-sold', 'good-week', 'haggles-won', 'all-machines', 'top-three', 'outlast-rival'];
      for (let i = 0; i < tickets; i++) {
        await db.query("INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, $3, 'checks', 1, 0) ON CONFLICT DO NOTHING", [
          `${farm.id}-t${i}`,
          farm.id,
          milestones[i % milestones.length],
        ]);
      }
    },
    async wallet(name, account) {
      const [farm] = await db.query<{ player_id: string }>('SELECT player_id FROM farms WHERE name LIKE $1 LIMIT 1', [`${name}%`]);
      if (!farm) throw new Error(`no farm named ${name}`);
      await db.query('UPDATE players SET near_account_id = $2 WHERE id = $1', [farm.player_id, account]);
    },
    failMints(n) {
      failing = n;
    },
    async wear(name, machines) {
      const [farm] = await db.query<{ id: string }>('SELECT id FROM farms WHERE name LIKE $1 LIMIT 1', [`${name}%`]);
      if (!farm) throw new Error(`no farm named ${name}`);
      for (const [u, s] of Object.entries(machines)) {
        await db.query('UPDATE unlocks SET condition = $3, broken = $4 WHERE farm_id = $1 AND unlock_id = $2', [farm.id, u, s.condition, s.broken ?? false]);
      }
    },
    hold(on) {
      held = on;
    },
    day(n) {
      const g = game as unknown as { clock: { day: number }; emit(to: string | null, msg: { t: 'clock'; clock: ReturnType<Game['getClock']> }): void };
      g.clock.day = n;
      g.emit(null, { t: 'clock', clock: game.getClock() });
    },
    async flock(name, n) {
      const farm = await farmNamed(name);
      const [hen] = await db.query<{ id: string }>(`SELECT id FROM hens WHERE farm_id = $1 AND status = 'alive' ORDER BY id LIMIT 1`, [farm.id]);
      if (!hen) throw new Error(`${name} has no hen to copy`);
      await db.query(
        `INSERT INTO hens (id, farm_id, status, body, eyes, comb, accessory, laying_trait, born_day, lay_progress)
         SELECT id || '-copy-' || g, farm_id, 'alive', body, eyes, comb, accessory, laying_trait, born_day, 0 FROM hens, generate_series(1, $2::int) AS g WHERE id = $1`,
        [hen.id, n],
      );
      const ok = await game.act(farm.player_id, { t: 'setClerkFloor', rid: 'browser-check', floor: Number(farm.clerk_floor) });
      if (!ok.ok) throw new Error(`could not refresh ${name}: ${ok.message}`);
    },
    async cash(name, coins) {
      const farm = await farmNamed(name);
      await db.query('UPDATE farms SET cash_milli = $2 WHERE id = $1', [farm.id, Math.round(coins * 1000)]);
      const ok = await game.act(farm.player_id, { t: 'setClerkFloor', rid: 'browser-check', floor: Number(farm.clerk_floor) });
      if (!ok.ok) throw new Error(`could not refresh ${name}: ${ok.message}`);
    },
    async crate(name, eggs) {
      const farm = await farmNamed(name);
      for (const [g, n] of Object.entries(eggs)) await db.query(`UPDATE farms SET crate_${g} = $2 WHERE id = $1`, [farm.id, n]);
      // a setting set to what it is: the server sends the farm its state, as after any action
      const ok = await game.act(farm.player_id, { t: 'setClerkFloor', rid: 'browser-check', floor: Number(farm.clerk_floor) });
      if (!ok.ok) throw new Error(`could not refresh ${name}: ${ok.message}`);
    },
    async buyOrder(grade, qty, share) {
      const [agent] = await db.query<{ id: string }>(`SELECT id FROM agents WHERE role = 'buyer' AND status = 'open' ORDER BY id LIMIT 1`);
      if (!agent) throw new Error('no open buyer');
      const market = await game.getMarketState();
      const id = `browser-check-buy-${++bids}`;
      await db.query(
        `INSERT INTO orders (id, deal_id, agent_id, day, side, kind, grade, qty, price_milli, status, created_at, expires_day)
         VALUES ($1, $1, $2, $3, 'buy', 'limit', $4, $5, $6, 'open', $7, $8)`,
        [id, agent.id, market.day, grade, qty, Math.round(market.pricesMilli[grade] * share), now(), market.day + 3],
      );
      return id;
    },
    async pullBids(grades) {
      await db.query(`UPDATE orders SET status = 'cancelled' WHERE side = 'buy' AND status = 'open' AND agent_id IS NOT NULL AND grade = ANY($1::text[])`, [grades]);
    },
    async auction(n) {
      await db.query(`UPDATE hens SET status = 'auction', farm_id = NULL WHERE id IN (SELECT id FROM hens WHERE status = 'forsale' ORDER BY id LIMIT $1)`, [n]);
    },
    async trader(name, grade, qty, share) {
      const p = await game.ensurePlayer('dev', `browser-check-${name}`, name);
      await db.query(`UPDATE farms SET crate_${grade} = crate_${grade} + $2 WHERE id = $1`, [p.farmId, qty]);
      const price = Math.round((await game.getMarketState()).pricesMilli[grade] * share) / 1000;
      const ok = await game.act(p.playerId, { t: 'placeOrder', rid: 'browser-check', grade, qty, price });
      if (!ok.ok) throw new Error(`the trader could not post: ${ok.message}`);
      const [order] = await db.query<{ id: string }>(`SELECT id FROM orders WHERE farm_id = $1 AND status = 'open' AND kind = 'limit' ORDER BY created_at DESC LIMIT 1`, [p.farmId]);
      if (!order) throw new Error('the trader has no open order');
      return { name: p.name, orderId: order.id };
    },
    async badge(name, badge, level) {
      const [farm] = await db.query<{ id: string }>('SELECT id FROM farms WHERE name LIKE $1 LIMIT 1', [`${name}%`]);
      if (!farm) throw new Error(`no farm named ${name}`);
      await game.withCtx((ctx) => grantBadge(ctx, farm.id, badge, level));
    },
    async farmNow(name) {
      const [f] = await db.query(
        `SELECT f.crate_white + f.crate_cream + f.crate_brown + f.crate_golden AS crate, f.cash_milli, p.auth_provider FROM farms f JOIN players p ON p.id = f.player_id WHERE f.name LIKE $1 LIMIT 1`,
        [`${name}%`],
      );
      if (!f) throw new Error(`no farm named ${name}`);
      return { crate: Number(f.crate), cashMilli: Number(f.cash_milli), guest: f.auth_provider === 'guest' };
    },
    async ticketWon(name) {
      const farm = await farmNamed(name);
      await game.withCtx(async (ctx) => {
        const ticketId = `${farm.id}-won-${ctx.day}`;
        await ctx.q.query("INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, 'full-coop', 'checks', $3, 0)", [ticketId, farm.id, ctx.day]);
        ctx.touched.add(farm.id);
        ctx.out.push({
          playerId: farm.player_id,
          msg: { t: 'event', event: { kind: 'milestoneRoll', milestone: 'full-coop', won: true, ticketId, next: 'eggs-sold', left: ECONOMY.feathers.maxSupply - 1, roll: 0.01, odds: ECONOMY.feathers.odds } },
        });
      });
    },
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}
