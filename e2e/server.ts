// The real game server for the browser checks: a memory database, no chain (every day a recorded
// no-op), the local dev login, the built client (apps/client/dist), and a clock the test can move
// forward to close days. Never touches NEAR. Farms whose name starts with "Ada Check" can be given
// every machine and a handful of Feather tickets, so every screen has content to page.
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { InferenceBudget } from '../apps/server/src/agents/brain';
import { createSessionSigner } from '../apps/server/src/auth/session';
import { NoopChain, type ChainWriter } from '../apps/server/src/chain/chain';
import { openDb } from '../apps/server/src/db/db';
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
  /** Sets the condition (and broken flag) of the named farm's machines. */
  wear(name: string, machines: Record<string, { condition: number; broken?: boolean }>): Promise<void>;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const db = await openDb('memory://');
  let offset = 0;
  const now = () => Date.now() + offset;
  const quiet = () => undefined;
  // no chain, but reported as minting, so the screens show the texts the live game shows
  const noop = new NoopChain('browser checks', quiet);
  const chain: ChainWriter = {
    mode: 'noop',
    explorer: null,
    minting: 'live',
    featherMinted: 0,
    provenance: null,
    contractId: null,
    settleDay: (q, season, day) => noop.settleDay(q, season, day),
  };
  const game = new Game({
    db,
    chain,
    now,
    log: quiet,
    season: 'checks',
    dayLengthMs: DAY_MS,
    provenance: 'bd2daafdc6efe9a68f19d87291d0a41d9ca6cd98a1b1d47568fc06d410ac0651',
    brain: { client: null, budget: new InferenceBudget(db, 0, now), model: 'none', cheapModel: 'none', pricing: new Map() },
  });
  await game.init();
  const server = createGameServer({
    game,
    sessions: createSessionSigner('browser-checks-only'),
    privy: null,
    privyAppId: null,
    devLogin: true,
    clientDist: fileURLToPath(new URL('../apps/client/dist', import.meta.url)),
    settlementMode: 'noop',
    dbKind: db.kind,
    pingDb: () => db.query('SELECT 1'),
    log: quiet,
  });
  const timer = setInterval(() => void game.tick().catch(() => undefined), 1000);
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
    async wear(name, machines) {
      const [farm] = await db.query<{ id: string }>('SELECT id FROM farms WHERE name LIKE $1 LIMIT 1', [`${name}%`]);
      if (!farm) throw new Error(`no farm named ${name}`);
      for (const [u, s] of Object.entries(machines)) {
        await db.query('UPDATE unlocks SET condition = $3, broken = $4 WHERE farm_id = $1 AND unlock_id = $2', [farm.id, u, s.condition, s.broken ?? false]);
      }
    },
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}
