// Warms the local copy up before recording: runs the local server with short days (the agents on their
// rule strategies) until the late-game farm has today's cards from the Loyalist, the Squeezer, the
// Wholesaler and the bakery, or ten days have passed (so the ledger's last 30 days still hold the real
// testnet receipts). Never touches the live database or the chain.
//
//   npx tsx scripts/demo-video/warm.ts
import { openDb } from '../../apps/server/src/db/db';
import { demoDatabase, startLocal } from './local';
import { LATE_FARM } from './names';

const WANT = ['loyalist', 'squeezer', 'wholesaler', 'bakery'];
const db = await openDb(demoDatabase());
const [farm] = await db.query<{ id: string }>('SELECT id FROM farms WHERE name = $1', [LATE_FARM]);
if (!farm) throw new Error(`no ${LATE_FARM}: run seed.ts first`);
const [start] = await db.query<{ day: number }>('SELECT day FROM game_clock');
const server = await startLocal({ daySeconds: 30, log: (l) => /\[day\] \d+ closed/.test(l) && console.log(l.replace(/^.*\[day\]/, '[day]').slice(0, 100)) });
let have: string[] = [];
try {
  for (let i = 0; i < 10 * 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const [clock] = await db.query<{ day: number }>('SELECT day FROM game_clock');
    const rows = await db.query<{ kind: string }>(`SELECT DISTINCT a.kind FROM cards c JOIN agents a ON a.id = c.agent_id WHERE c.farm_id = $1 AND c.day = $2 AND c.status = 'open'`, [
      farm.id,
      clock?.day,
    ]);
    have = rows.map((r) => r.kind).filter((k) => WANT.includes(k));
    if (have.length === WANT.length) break;
    if ((clock?.day ?? 0) - (start?.day ?? 0) >= 10) break;
  }
} finally {
  await server.stop();
}
const [end] = await db.query<{ day: number }>('SELECT day FROM game_clock');
console.log(JSON.stringify({ fromDay: start?.day, toDay: end?.day, cardsFrom: have }));
await db.close();
process.exit(0);
