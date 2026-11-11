// 30 in-game days of the whole market: the seven agents plus two headless players who play
// greedily (accept good cards, haggle sometimes, expand while it pays, sell everything). The
// model brain is a stub that answers valid JSON on some calls and garbage on others, under a
// small spend cap, so fallbacks and the cap are exercised too. Results print as a report.
import { describe, expect, it } from 'vitest';
import { ECONOMY, emptyEggStock, type FarmState } from '@coys/shared';
import { NearAiClient } from '../src/ai/nearai';
import { emptyDecision } from '../src/agents/decision';
import { makeGame, type TestGame } from './helpers';

const eggs = (f: FarmState) => f.crate.white + f.crate.cream + f.crate.brown + f.crate.golden;

async function playDay(t: TestGame, players: { playerId: string; farmId: string }[], day: number): Promise<void> {
  // cards arrive through the day; walk the clock across the day in steps
  for (const frac of [0.15, 0.35, 0.55, 0.75, 0.95]) {
    const start = t.game.getClock().dayStartedAt;
    t.clock.t = start + Math.floor(ECONOMY.day.lengthMs * frac);
    await t.game.tick();
    for (const p of players) {
      const farm = await t.game.getFarmState(p.farmId);
      for (const card of farm.cards.filter((c) => c.status === 'open')) {
        const haggle = card.choices.includes('counter') && (day + card.id.charCodeAt(0)) % 3 === 0;
        const choice = haggle ? 'counter' : card.choices.includes('accept') ? 'accept' : (card.choices[0] ?? 'decline');
        const ask = haggle ? (card.offerMilli / 1000) * (card.kind === 'feed-deal' || card.kind === 'credit-terms' ? 0.85 : 1.2) : undefined;
        await t.game.act(p.playerId, { t: 'respondCard', rid: `${card.id}-${frac}`, cardId: card.id, choice, ...(ask ? { ask } : {}) });
      }
      for (const c of farm.contracts.filter((c) => !c.deliveredToday)) {
        await t.game.act(p.playerId, { t: 'deliverContract', rid: `d-${c.id}-${day}-${frac}`, contractId: c.id });
      }
    }
  }
  for (const p of players) {
    let farm = await t.game.getFarmState(p.farmId);
    if (eggs(farm) > 0) await t.game.act(p.playerId, { t: 'sell', rid: `s-${p.farmId}-${day}`, items: farm.crate });
    farm = await t.game.getFarmState(p.farmId);
    const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
    if (feed < farm.hens.length * 120 * 4 && farm.cashMilli > 110_000) await t.game.act(p.playerId, { t: 'buyFeed', rid: `f-${p.farmId}-${day}`, tier: 'standard', bags: 1 });
    farm = await t.game.getFarmState(p.farmId);
    const room = farm.coops.reduce((s, c) => s + ECONOMY.coops.kinds[c.kind].capacity, 0) - farm.hens.length;
    const afford = Math.floor((farm.cashMilli / 1000 - 25) / ECONOMY.hen.price);
    if (room > 0 && afford > 0) await t.game.act(p.playerId, { t: 'buyHens', rid: `h-${p.farmId}-${day}`, count: Math.min(room, afford, 20) });
    if (farm.cashMilli > 200_000 && farm.coops.length < ECONOMY.coops.plots) await t.game.act(p.playerId, { t: 'buildCoop', rid: `c-${p.farmId}-${day}`, kind: 'red' });
  }
  t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
  await t.game.endDay();
}

describe('30-day market simulation', () => {
  it('runs seven agents and two players: prices move with supply, contracts settle, the cap holds', async () => {
    let calls = 0;
    const client = new NearAiClient({
      apiKey: 'sim',
      fetchImpl: (async () => {
        calls++;
        const content = calls % 4 === 0 ? 'I think I will buy some eggs.' : JSON.stringify({ ...emptyDecision('sim model'), markup: 1 });
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2500, completion_tokens: 300 } }));
      }) as typeof fetch,
    });
    const capUsd = 0.25;
    const t = await makeGame({ cast: true, client, capUsd, seed: 7 });
    const players = [await t.game.ensurePlayer('dev', 'sim-player-01', 'Ada'), await t.game.ensurePlayer('dev', 'sim-player-02', 'Bo')];
    for (let day = 1; day <= 30; day++) await playDay(t, players, day);

    const market = await t.game.getMarketState();
    const history = (await t.db.query('SELECT day, supply, multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day')).map((r) => ({
      day: Number(r.day),
      supply: Number(r.supply),
      multiplier: Number(r.multiplier),
    }));
    const busts = await t.db.query(`SELECT name, kind, bust_day FROM agents WHERE status = 'bust' ORDER BY bust_day`);
    const delivered = Number((await t.db.query(`SELECT count(*) AS n FROM trades WHERE via = 'contract'`))[0]?.n);
    const missed = Number((await t.db.query('SELECT COALESCE(SUM(misses), 0) AS n FROM contracts'))[0]?.n);
    const contracts = Number((await t.db.query('SELECT count(*) AS n FROM contracts'))[0]?.n);
    const usage = await t.db.query('SELECT * FROM inference_usage');
    const spend = usage.reduce((s, u) => s + Number(u.spend_micro_usd), 0) / 1e6;
    const report = {
      days: history.length,
      series: history.map((h) => `${h.day}:${h.supply}/${h.multiplier.toFixed(2)}`).join(' '),
      multiplier: { min: Math.min(...history.map((h) => h.multiplier)), max: Math.max(...history.map((h) => h.multiplier)) },
      supply: { min: Math.min(...history.map((h) => h.supply)), max: Math.max(...history.map((h) => h.supply)) },
      busts: busts.map((b) => `${b.name} (day ${b.bust_day})`),
      contracts: { signed: contracts, delivered, missed },
      inference: { decisions: t.game.stats.decisions, modelCalls: calls, fallbacks: t.game.stats.fallbacks, skipped: t.game.stats.skipped, spendUsd: spend, capUsd },
      agentsOpen: market.agents.filter((a) => a.status === 'open').map((a) => a.name),
      players: await Promise.all(players.map(async (p) => ((await t.game.getFarmState(p.farmId)).cashMilli / 1000).toFixed(2))),
    };
    console.log(`SIM REPORT ${JSON.stringify(report, null, 2)}`);

    expect(history).toHaveLength(30);
    // a glut lowers prices: the day after the biggest supply is priced below the day after the smallest
    const byDay = new Map(history.map((h) => [h.day, h]));
    const biggest = history.reduce((a, b) => (b.supply > a.supply ? b : a));
    const smallest = history.reduce((a, b) => (b.supply < a.supply ? b : a));
    const after = (d: number) => byDay.get(d + 1)?.multiplier ?? market.multiplier;
    expect(after(biggest.day)).toBeLessThan(after(smallest.day));
    expect(spend).toBeLessThanOrEqual(capUsd);
    expect(t.game.stats.fallbacks).toBeGreaterThan(0);
    expect(delivered + missed).toBeGreaterThan(0);
    for (const p of players) expect(await t.game.ledgerTotal(p.farmId)).toBe((await t.game.getFarmState(p.farmId)).cashMilli);
    await t.db.close();
  }, 300_000);

  it('a rival can go bust in a glut; its hens go to auction and a new rival opens', async () => {
    const t = await makeGame({ cast: true, seed: 3 });
    const [up] = await t.db.query(`SELECT id, farm_id FROM agents WHERE kind = 'upstart'`);
    // Upstart over-expanded into a glut: little cash, an empty trough, a crashed market
    await t.db.query(`UPDATE farms SET cash_milli = 400, feed_cheap_g = 0, feed_standard_g = 0, feed_premium_g = 0 WHERE id = $1`, [up?.farm_id]);
    await t.db.query(`INSERT INTO ledger (farm_id, day, kind, amount_milli, ref, created_at) SELECT $1, 1, 'test', 400 - cash_milli, 'scenario', 0 FROM farms WHERE id = $1`, [up?.farm_id]);
    await t.db.query(`UPDATE market_days SET multiplier = 0.4 WHERE day = 1`);
    await t.db.query(`UPDATE farms SET crate_white = 0, crate_cream = 0, crate_brown = 0, crate_golden = 0 WHERE id = $1`, [up?.farm_id]);
    await t.db.query('DELETE FROM lay_events WHERE farm_id = $1', [up?.farm_id]);
    for (let d = 0; d < 6; d++) {
      t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
      await t.game.endDay();
    }
    const [busted] = await t.db.query(`SELECT status, bust_day FROM agents WHERE id = $1`, [up?.id]);
    expect(busted?.status).toBe('bust');
    const [farm] = await t.db.query('SELECT bust_day FROM farms WHERE id = $1', [up?.farm_id]);
    expect(farm?.bust_day).not.toBeNull();
    const successors = await t.db.query(`SELECT name, generation, status FROM agents WHERE kind = 'upstart' ORDER BY generation`);
    expect(successors.length).toBe(2);
    expect(successors[1]).toMatchObject({ generation: 2, status: 'open' });
    // Old Money buys cheap auction hens when others bust
    const [oldMoney] = await t.db.query(`SELECT a.farm_id FROM agents a WHERE a.kind = 'old-money'`);
    const ledger = await t.db.query(`SELECT kind FROM ledger WHERE farm_id = $1 AND kind = 'hens'`, [oldMoney?.farm_id]);
    const auction = Number((await t.db.query(`SELECT count(*) AS n FROM hens WHERE status = 'auction'`))[0]?.n);
    expect(ledger.length > 0 || auction > 0).toBe(true);
    expect(emptyEggStock()).toEqual({ white: 0, cream: 0, brown: 0, golden: 0 });
    await t.db.close();
  }, 120_000);
});
