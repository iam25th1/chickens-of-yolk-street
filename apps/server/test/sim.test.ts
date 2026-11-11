// 30 in-game days of the whole market, over five fixed seeds: the seven agents plus two headless
// players who play greedily (feed first, accept good cards, haggle sometimes, expand while it pays,
// sell everything). The model brain is a stub that answers each agent's own in-character decision
// as JSON on most calls and garbage on every fourth, under a small spend cap, so fallbacks and the
// cap are exercised too. Each seed prints a report; the economy acceptance is checked across seeds.
import { describe, expect, it } from 'vitest';
import { ECONOMY, emptyEggStock, type FarmState } from '@coys/shared';
import { NearAiClient } from '../src/ai/nearai';
import type { AgentContext } from '../src/agents/decision';
import { ruleDecision } from '../src/agents/rules';
import { RecordingChain, makeGame, type TestGame } from './helpers';

const eggs = (f: FarmState) => f.crate.white + f.crate.cream + f.crate.brown + f.crate.golden;
const SEEDS = [1, 2, 3, 4, 5];

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
    // feed first: keep four days in the trough, standard feed when it can, cheap when short
    for (let i = 0; i < 4; i++) {
      const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
      if (feed >= farm.hens.length * 120 * 4) break;
      const tier = farm.cashMilli >= 110_000 ? 'standard' : 'cheap';
      if (farm.cashMilli < ECONOMY.feed.tiers[tier].bagPrice * 1150) break;
      if (!(await t.game.act(p.playerId, { t: 'buyFeed', rid: `f-${p.farmId}-${day}-${i}`, tier, bags: 1 })).ok) break;
      farm = await t.game.getFarmState(p.farmId);
    }
    const room = farm.coops.reduce((s, c) => s + ECONOMY.coops.kinds[c.kind].capacity, 0) - farm.hens.length;
    // expand with what is left after a bag of feed for the bigger flock
    const afford = Math.floor((farm.cashMilli / 1000 - 25 - ECONOMY.feed.tiers.standard.bagPrice) / ECONOMY.hen.price);
    if (room > 0 && afford > 0) await t.game.act(p.playerId, { t: 'buyHens', rid: `h-${p.farmId}-${day}`, count: Math.min(room, afford, 20) });
    if (farm.cashMilli > 200_000 && farm.coops.length < ECONOMY.coops.plots) await t.game.act(p.playerId, { t: 'buildCoop', rid: `c-${p.farmId}-${day}`, kind: 'red' });
  }
  t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
  await t.game.endDay();
}

interface SeedReport {
  seed: number;
  medianMultiplier: number;
  minMultiplier: number;
  glutDays: number;
  rivalBusts: string[];
  supplyVsDemand: string;
  contracts: { signed: number; delivered: number; missed: number };
  inference: { decisions: number; modelCalls: number; fallbacks: number; skipped: number; spendUsd: number; capUsd: number };
  wholesalerResold: number;
  /** Contract eggs that moved as tokens from a player wallet to the Bakery wallet, and the first receipt. */
  onChainDeliveries: { transfers: number; eggs: number; firstReceipt: string | null };
  cash: Record<string, string>;
}

async function runSeed(seed: number): Promise<{ report: SeedReport; t: TestGame; players: { playerId: string; farmId: string }[] }> {
  let calls = 0;
  const client = new NearAiClient({
    apiKey: 'sim',
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const c = JSON.parse(body.messages[1]?.content ?? '{}') as AgentContext;
      const content = calls % 4 === 0 ? 'I think I will buy some eggs.' : JSON.stringify(ruleDecision(c));
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2500, completion_tokens: 300 } }));
    }) as typeof fetch,
  });
  const capUsd = 0.25;
  const chain = new RecordingChain('game.testnet');
  const t = await makeGame({ cast: true, client, capUsd, seed, chain, season: `sim-${seed}` });
  const players = [await t.game.ensurePlayer('dev', 'sim-player-01', 'Ada'), await t.game.ensurePlayer('dev', 'sim-player-02', 'Bo')];
  for (const [i, p] of players.entries()) await t.game.act(p.playerId, { t: 'linkWallet', rid: `w${i}`, accountId: ['ada.testnet', 'bo.testnet'][i] ?? 'x.testnet' });
  const cash: Record<string, string[]> = {};
  for (let day = 1; day <= 30; day++) {
    await playDay(t, players, day);
    const rows = await t.db.query(`SELECT a.kind, a.generation, a.status, COALESCE(f.cash_milli, a.cash_milli) AS cash FROM agents a LEFT JOIN farms f ON f.id = a.farm_id`);
    for (const r of rows) (cash[`${String(r.kind)}${Number(r.generation) > 1 ? r.generation : ''}`] ??= Array<string>(day - 1).fill('.')).push(r.status === 'bust' ? 'bust' : String(Math.round(Number(r.cash) / 1000)));
    for (const [i, p] of players.entries()) (cash[`player${i + 1}`] ??= []).push(String(Math.round((await t.game.getFarmState(p.farmId)).cashMilli / 1000)));
  }
  const history = (await t.db.query('SELECT day, supply, multiplier, reference FROM market_days WHERE closed_at IS NOT NULL ORDER BY day')).map((r) => ({
    day: Number(r.day),
    supply: Number(r.supply),
    multiplier: Number(r.multiplier),
    reference: Number(r.reference),
  }));
  const sorted = history.map((h) => h.multiplier).sort((a, b) => a - b);
  const busts = await t.db.query(`SELECT name, bust_day FROM agents WHERE status = 'bust' AND role = 'rival' ORDER BY bust_day`);
  const usage = await t.db.query('SELECT * FROM inference_usage');
  const report: SeedReport = {
    seed,
    medianMultiplier: ((sorted[14] ?? 0) + (sorted[15] ?? 0)) / 2,
    minMultiplier: sorted[0] ?? 0,
    glutDays: history.filter((h) => h.multiplier <= ECONOMY.market.crashAt).length,
    rivalBusts: busts.map((b) => `${String(b.name)} (day ${String(b.bust_day)})`),
    supplyVsDemand: history.map((h) => `${h.day}:${h.supply}/${h.reference}=x${h.multiplier.toFixed(2)}`).join(' '),
    contracts: {
      signed: Number((await t.db.query('SELECT count(*) AS n FROM contracts'))[0]?.n),
      delivered: Number((await t.db.query(`SELECT count(*) AS n FROM trades WHERE via = 'contract'`))[0]?.n),
      missed: Number((await t.db.query('SELECT COALESCE(SUM(misses), 0) AS n FROM contracts'))[0]?.n),
    },
    inference: {
      decisions: t.game.stats.decisions,
      modelCalls: calls,
      fallbacks: t.game.stats.fallbacks,
      skipped: t.game.stats.skipped,
      spendUsd: usage.reduce((s, u) => s + Number(u.spend_micro_usd), 0) / 1e6,
      capUsd,
    },
    onChainDeliveries: (() => {
      const moves = chain.batches.flatMap((b) => b.eggs.filter((m) => m.kind === 'Transfer' && /^bakery\d+\.game\.testnet$/.test(m.to ?? '') && /^(ada|bo)\.testnet$/.test(m.from ?? '')).map((m) => ({ ...m, day: b.day, season: b.season })));
      const first = moves[0];
      return { transfers: moves.length, eggs: moves.reduce((n, m) => n + Number(m.amount), 0), firstReceipt: first ? `recorded-${first.season}-${first.day}` : null };
    })(),
    wholesalerResold: Number((await t.db.query(`SELECT COALESCE(SUM(qty), 0) AS n FROM trades WHERE via = 'resale'`))[0]?.n),
    cash: Object.fromEntries(Object.entries(cash).map(([k, v]) => [k, v.join(' ')])),
  };
  return { report, t, players };
}

describe('30-day market simulation', () => {
  it('five seeds: a typical day near 1.00x, a glut in every seed, rivals going bust, the cap holding', async () => {
    const reports: SeedReport[] = [];
    for (const seed of SEEDS) {
      const { report, t, players } = await runSeed(seed);
      console.log(`SIM REPORT seed ${seed} ${JSON.stringify(report, null, 2)}`);
      reports.push(report);
      // per seed: a glut lowers prices, the spend cap holds, fallbacks happen, contracts settle, ledgers add up
      const history = (await t.db.query('SELECT day, supply, multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day')).map((r) => ({
        day: Number(r.day),
        supply: Number(r.supply),
        multiplier: Number(r.multiplier),
      }));
      expect(history).toHaveLength(30);
      const byDay = new Map(history.map((h) => [h.day, h]));
      const biggest = history.reduce((a, b) => (b.supply > a.supply ? b : a));
      const smallest = history.reduce((a, b) => (b.supply < a.supply ? b : a));
      const after = async (d: number) => byDay.get(d + 1)?.multiplier ?? (await t.game.getMarketState()).multiplier;
      expect(await after(biggest.day)).toBeLessThan(await after(smallest.day));
      expect(report.inference.spendUsd).toBeLessThanOrEqual(report.inference.capUsd);
      expect(report.inference.fallbacks).toBeGreaterThan(0);
      expect(report.contracts.delivered + report.contracts.missed).toBeGreaterThan(0);
      // Bakery contract eggs reach the Bakery's wallet as tokens in the day's settlement batch
      expect(report.onChainDeliveries.transfers).toBeGreaterThan(0);
      for (const p of players) expect(await t.game.ledgerTotal(p.farmId)).toBe((await t.game.getFarmState(p.farmId)).cashMilli);
      await t.db.close();
    }
    console.log(
      `SIM ACCEPTANCE ${reports.map((r) => `seed ${r.seed}: median x${r.medianMultiplier.toFixed(2)}, min x${r.minMultiplier.toFixed(2)}, ${r.glutDays} glut days, rival busts: ${r.rivalBusts.join(', ') || 'none'}, ${r.onChainDeliveries.eggs} contract eggs to the Bakery wallet on chain`).join(' | ')}`,
    );
    for (const r of reports) {
      expect(r.medianMultiplier).toBeGreaterThanOrEqual(0.8);
      expect(r.medianMultiplier).toBeLessThanOrEqual(1.3);
      expect(r.glutDays).toBeGreaterThanOrEqual(1);
    }
    expect(reports.filter((r) => r.rivalBusts.length > 0).length).toBeGreaterThanOrEqual(3);
  }, 600_000);

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
