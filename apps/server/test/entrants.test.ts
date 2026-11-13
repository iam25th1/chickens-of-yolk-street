// AI farms entering Yolk Street: the floor, the cap (counting base rivals about to reopen), the
// chance entry on lasting scarcity, entrants never coming back through the base cast, and what the
// market board shows of them (reasons, the AI flags on trades).
import { describe, expect, it } from 'vitest';
import { ECONOMY, aiFarmCap, type GameEvent } from '@coys/shared';
import { CAST } from '../src/agents/cast';
import { ENTRANTS } from '../src/agents/entrants';
import { makeGame, type TestGame } from './helpers';

const nextDay = async (t: TestGame): Promise<void> => {
  t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
  await t.game.endDay();
};
const openRivals = async (t: TestGame) => t.db.query(`SELECT name, kind, entrant_key, farm_id FROM agents WHERE status = 'open' AND role = 'rival' ORDER BY name`);
const bust = async (t: TestGame, where: string) => {
  const day = t.game.getClock().day;
  for (const a of await t.db.query(`SELECT id, farm_id FROM agents WHERE ${where}`)) {
    await t.db.query(`UPDATE agents SET status = 'bust', bust_day = $2 WHERE id = $1`, [a.id, day]);
    await t.db.query(`UPDATE farms SET bust_day = $2 WHERE id = $1`, [a.farm_id, day]);
  }
};

describe('AI farms enter the street', () => {
  it('under two open AI farms, entrants enter at the next day close whatever the chance, with smaller farms', async () => {
    const t = await makeGame({ cast: true, seed: 5 });
    const events: GameEvent[] = [];
    t.game.on((o) => {
      if (o.msg.t === 'event') events.push(o.msg.event);
    });
    await bust(t, `role = 'rival'`);
    await nextDay(t);
    const open = await openRivals(t);
    expect(open).toHaveLength(2);
    for (const r of open) {
      const e = ENTRANTS.find((x) => x.key === r.entrant_key);
      expect(e).toBeDefined();
      expect(r.kind).toBe(e?.looks);
      const [h] = await t.db.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [r.farm_id]);
      expect(Number(h?.n)).toBe(e?.farm.hens);
      // smaller than the base rival it looks like
      expect(Number(h?.n)).toBeLessThan(CAST[e?.looks ?? 'upstart'].farm?.hens ?? 0);
    }
    expect(events.filter((e) => e.kind === 'agentOpened')).toHaveLength(2);
    expect(t.logs.filter((l) => /enters Yolk Street as a new AI farm \(only [01] AI farms? open\)/.test(l))).toHaveLength(2);
    await t.db.close();
  });

  it('the cap counts base rivals about to reopen; the base cast comes back as before and never brings back an entrant', async () => {
    const t = await makeGame({ cast: true, seed: 8 });
    await bust(t, `role = 'rival'`);
    for (let d = 0; d < 8; d++) {
      await nextDay(t);
      // with no players the cap is the floor of 4: two entrants and two base rivals at most
      expect((await openRivals(t)).length).toBeLessThanOrEqual(4);
      expect((await openRivals(t)).length).toBeGreaterThanOrEqual(2);
    }
    const base = await t.db.query(`SELECT kind, generation, status FROM agents WHERE role = 'rival' AND entrant_key IS NULL ORDER BY kind, generation`);
    expect(base.map((b) => `${String(b.kind)}${String(b.generation)}:${String(b.status)}`)).toEqual(['old-money1:bust', 'old-money2:open', 'upstart1:bust', 'upstart2:open']);
    // an entrant goes bust: only the entry rule may bring one in, never the base cast
    const [entrant] = await t.db.query(`SELECT id, entrant_key FROM agents WHERE entrant_key IS NOT NULL AND status = 'open' LIMIT 1`);
    await bust(t, `id = '${String(entrant?.id)}'`);
    for (let d = 0; d < 5; d++) await nextDay(t);
    const entrants = await t.db.query(`SELECT name FROM agents WHERE entrant_key IS NOT NULL`);
    expect(t.logs.filter((l) => l.includes('enters Yolk Street as a new AI farm'))).toHaveLength(entrants.length);
    await t.db.close();
  });

  it('on lasting scarcity one may enter by chance (the seeded rng), at most one a day, never over the cap', async () => {
    const t = await makeGame({ cast: true, seed: 11 });
    // six player farms that sell nothing: demand grows with them, supply does not, and the cap is 9
    for (let i = 0; i < 6; i++) await t.game.ensurePlayer('dev', `device-000${i}`, `Player ${i}`);
    const cap = aiFarmCap(6);
    expect(cap).toBe(9);
    // a chance entry names its reason; an entry under the floor says how few were open
    const chance = /enters Yolk Street as a new AI farm \((supply under demand for \d+ days|.+ went bust)\)/;
    let first: string | null = null;
    for (let d = 0; d < 40; d++) {
      const seen = t.logs.length;
      await nextDay(t);
      const entered = t.logs.slice(seen).filter((l) => chance.test(l));
      expect(entered.length).toBeLessThanOrEqual(1);
      first ??= entered[0] ?? null;
      expect((await openRivals(t)).length).toBeLessThanOrEqual(cap);
    }
    expect(first).toMatch(new RegExp(`supply under demand for ${ECONOMY.agents.entry.scarceDays} days`));
    await t.db.close();
  });

  it("the market board shows each agent's latest reason, and which trades an AI made", async () => {
    const t = await makeGame({ cast: true, seed: 2 });
    await t.game.ensurePlayer('dev', 'device-0001', 'Ada');
    await nextDay(t);
    const market = await t.game.getMarketState();
    const bakery = market.agents.find((a) => a.kind === 'bakery');
    expect(bakery?.reason).toMatch(/\w/);
    expect(bakery?.reason?.length).toBeLessThanOrEqual(80);
    const rivals = new Set(market.agents.filter((a) => a.role === 'rival').map((a) => a.name));
    for (const tr of market.trades) {
      if (rivals.has(tr.seller)) expect(tr.sellerAi).toBe(true);
      if (tr.buyer === 'Street market') expect(tr.buyerAi).toBe(false);
    }
    const [stored] = await t.db.query(`SELECT reasons FROM agents WHERE kind = 'bakery'`);
    const reasons = (typeof stored?.reasons === 'string' ? JSON.parse(stored.reasons) : stored?.reasons) as { day: number; text: string }[];
    expect(reasons.at(-1)?.text).toBe(bakery?.reason);
    await t.db.close();
  });
});
