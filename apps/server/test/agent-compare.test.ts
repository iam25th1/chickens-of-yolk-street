// The 30-day comparison: the same five seeds and the same two headless players (sim-players.ts),
// once with the recorded stand-in model (recorded-model.ts, replaying test/fixtures/agent-replies.json,
// with an unusable reply every 12th call) and once on the rules alone. It prints, per seed and brain,
// the median and lowest multiplier, glut days, busts, entrants, every agent's final cash, fallbacks
// and calls; then the credits-needed report: tokens per call measured here (real system prompt and
// observation, 3 characters a token), calls per agent per in-game day, 480 in-game days a real day
// on the live server, and the two models' prices (ASSUMED_PRICING), with and without the caps.
// docs/agents.md quotes its numbers.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, ECONOMY } from '@coys/shared';
import { NEARAI_DEFAULT_CHEAP_MODEL, NEARAI_DEFAULT_MODEL } from '../src/ai/nearai';
import { ASSUMED_PRICING, SYSTEM, UNKNOWN_PRICING, priceOf } from '../src/agents/brain';
import { validateDecision } from '../src/agents/decision';
import { RecordingChain, makeGame } from './helpers';
import { SITUATIONS, authoredReplies, recordedModel, sampleContext, type AgentReplies, type ReplayTally } from './recorded-model';
import { playDay } from './sim-players';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-replies.json', import.meta.url), 'utf8')) as AgentReplies;
const SEEDS = [1, 2, 3, 4, 5];
const DAYS = 30;
/** Generous caps, so the comparison measures the brains (the credits report applies the real caps). */
const CAP_USD = 20;

interface Run {
  seed: number;
  brain: 'model' | 'rules';
  median: number;
  min: number;
  glutDays: number;
  busts: string[];
  entrants: string[];
  cash: Record<string, number>;
  stats: { decisions: number; skipped: number; fallbacks: number; reflections: number; mainCalls: number; cheapCalls: number; promptTokens: number; completionTokens: number };
  tally: ReplayTally | null;
  spendUsd: number;
}

async function run(seed: number, brain: 'model' | 'rules'): Promise<Run> {
  const model = brain === 'model' ? recordedModel(fixture) : null;
  const t = await makeGame({ cast: true, seed, client: model?.client ?? null, capUsd: CAP_USD, chain: new RecordingChain('game.testnet'), season: `cmp-${seed}`, realModels: true });
  const players = [await t.game.ensurePlayer('dev', 'cmp-player-01', 'Ada'), await t.game.ensurePlayer('dev', 'cmp-player-02', 'Bo')];
  for (let day = 1; day <= DAYS; day++) await playDay(t, players, day);
  const ms = (await t.db.query('SELECT multiplier FROM market_days WHERE closed_at IS NOT NULL ORDER BY day')).map((r) => Number(r.multiplier)).sort((a, b) => a - b);
  const agents = await t.db.query(
    `SELECT a.name, a.status, a.role, a.entrant_key, a.opened_day, a.bust_day, COALESCE(f.cash_milli, a.cash_milli) AS cash FROM agents a LEFT JOIN farms f ON f.id = a.farm_id ORDER BY a.opened_day, a.name`,
  );
  const [usage] = await t.db.query('SELECT COALESCE(SUM(spend_micro_usd), 0) AS s FROM inference_usage');
  const out: Run = {
    seed,
    brain,
    median: ((ms[14] ?? 0) + (ms[15] ?? 0)) / 2,
    min: ms[0] ?? 0,
    glutDays: ms.filter((m) => m <= ECONOMY.market.crashAt).length,
    busts: agents.filter((a) => a.status === 'bust' && a.role === 'rival').map((a) => `${String(a.name)} (day ${String(a.bust_day)})`),
    entrants: agents.filter((a) => a.entrant_key).map((a) => `${String(a.name)} (day ${String(a.opened_day)})`),
    cash: Object.fromEntries(agents.map((a) => [`${String(a.name)}${a.status === 'bust' ? ' (bust)' : ''}`, Math.round(Number(a.cash) / 1000)])),
    stats: { ...t.game.stats },
    tally: model?.tally ?? null,
    spendUsd: Number(usage?.s) / 1e6,
  };
  await t.db.close();
  return out;
}

const pct = (n: number, d: number): string => `${d ? Math.round((n / d) * 100) : 0}%`;
const usd = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4));

/** The credits-needed report from the model runs, at the live server's pace. */
function creditsReport(runs: Run[]): {
  lines: string[];
  numbers: { calls: number; perCall: number; callsPerAgentDay: number; agentsPerDay: number; uncappedDay: number; cappedDay: number; worstDay: number };
} {
  const model = runs.filter((r) => r.brain === 'model');
  const sum = (f: (r: Run) => number): number => model.reduce((n, r) => n + f(r), 0);
  const tokens = (m: string, k: 'calls' | 'prompt' | 'completion'): number => sum((r) => r.tally?.tokens[m]?.[k] ?? 0);
  const main = { calls: tokens(NEARAI_DEFAULT_MODEL, 'calls'), prompt: tokens(NEARAI_DEFAULT_MODEL, 'prompt'), completion: tokens(NEARAI_DEFAULT_MODEL, 'completion') };
  const cheap = { calls: tokens(NEARAI_DEFAULT_CHEAP_MODEL, 'calls'), prompt: tokens(NEARAI_DEFAULT_CHEAP_MODEL, 'prompt'), completion: tokens(NEARAI_DEFAULT_CHEAP_MODEL, 'completion') };
  const calls = main.calls + cheap.calls;
  const decisions = sum((r) => r.tally?.decisions ?? 0);
  const reflections = sum((r) => r.tally?.reflections ?? 0);
  const t3 = (chars: number, n: number): number => Math.round(chars / 3 / Math.max(1, n));
  const decisionIn = t3(
    sum((r) => r.tally?.decisionPromptChars ?? 0),
    decisions,
  );
  const decisionOut = t3(
    sum((r) => r.tally?.decisionReplyChars ?? 0),
    decisions,
  );
  const reflectIn = t3(
    sum((r) => (r.tally?.promptChars ?? 0) - (r.tally?.decisionPromptChars ?? 0)),
    reflections,
  );
  const reflectOut = t3(
    sum((r) => (r.tally?.replyChars ?? 0) - (r.tally?.decisionReplyChars ?? 0)),
    reflections,
  );
  const system = Math.round(SYSTEM(sampleContext('upstart', 'normal')).length / 3);
  const priceMain = priceOf(new Map(), NEARAI_DEFAULT_MODEL);
  const priceCheap = priceOf(new Map(), NEARAI_DEFAULT_CHEAP_MODEL);
  const costAt = (pm: { input: number; output: number }, pc: { input: number; output: number }): number =>
    (main.prompt * pm.input + main.completion * pm.output + cheap.prompt * pc.input + cheap.completion * pc.output) / 1e6 / calls;
  const perCall = costAt(priceMain, priceCheap);
  // agent-days: every open agent's day, thinking or skipping
  const agentDays = sum((r) => r.stats.decisions + r.stats.skipped);
  const callsPerAgentDay = calls / agentDays;
  const agentsPerDay = agentDays / (model.length * DAYS);
  const realDay = (24 * 3600 * 1000) / ECONOMY.day.lengthMs;
  const callsDay = callsPerAgentDay * agentsPerDay * realDay;
  const uncappedDay = callsDay * perCall;
  // the default caps: each agent 40 calls and a quarter of the global cap a UTC day, all of them the global 1 USD
  const capUsd = 1;
  const agentCalls = 40;
  const capped = (cost: number): number => Math.min(Math.min(Math.min(callsPerAgentDay * realDay, agentCalls) * cost, capUsd / 4) * agentsPerDay, capUsd);
  const cappedDay = capped(perCall);
  const worst = costAt(UNKNOWN_PRICING, UNKNOWN_PRICING);
  const lines = [
    `measured over ${model.length} seeds x ${DAYS} in-game days: ${calls} calls: ${decisions} decisions (${main.calls - reflections} on the main model on hard days, ${cheap.calls} on the cheap one) and ${reflections} weekly reflections (main); ${sum((r) => r.tally?.invalid ?? 0)} unusable replies`,
    `tokens (3 characters a token): a decision ${decisionIn} in (system prompt ${system}, the rest the observation) + ${decisionOut} out; a reflection ${reflectIn} in + ${reflectOut} out`,
    `prices per million tokens (assumed, config): main ${priceMain.input} in / ${priceMain.output} out, cheap ${priceCheap.input} / ${priceCheap.output}; an average call ${usd(perCall)} USD`,
    `${callsPerAgentDay.toFixed(3)} calls per agent per in-game day, ${agentsPerDay.toFixed(2)} agents open on average, ${realDay} in-game days a real day: ${Math.round(callsDay)} calls a real day`,
    `uncapped: ${usd(uncappedDay)} USD a real day, ${usd(uncappedDay * 30)} USD per 30 days (${usd(uncappedDay / agentsPerDay)} USD per agent a day)`,
    `default caps (1 USD a day; each agent 40 calls, 0.25 USD): ${usd(cappedDay)} USD a real day, ${usd(cappedDay * 30)} USD per 30 days; the model makes ${pct(agentCalls, callsPerAgentDay * realDay)} of an agent's calls, rules the rest`,
    `if both models cost ${UNKNOWN_PRICING.input}/${UNKNOWN_PRICING.output} (the server's price for an unknown model): ${usd(callsDay * worst)} USD a real day uncapped, ${usd(capped(worst))} capped`,
  ];
  return { lines, numbers: { calls, perCall, callsPerAgentDay, agentsPerDay, uncappedDay, cappedDay, worstDay: capped(worst) } };
}

describe('model against rules, 30 days', () => {
  it('the recorded replies are what the recording script writes, and every one passes the server validation', () => {
    if (fixture.source === 'authored') expect(fixture).toEqual(JSON.parse(JSON.stringify(authoredReplies())));
    for (const kind of AGENT_KINDS) {
      for (const situation of SITUATIONS) {
        const entry = fixture.samples[kind][situation];
        expect(entry.replies.length).toBeGreaterThan(0);
        for (const reply of entry.replies) {
          const c = sampleContext(kind, situation);
          expect(validateDecision(reply, c)).not.toBeNull();
          expect(reply.reason.length).toBeLessThanOrEqual(80);
        }
      }
      for (const text of fixture.reflections[kind]) expect(text.length).toBeLessThanOrEqual(400);
    }
    expect(fixture.invalid.every((r) => validateDecision(r, sampleContext('bakery', 'normal')) === null)).toBe(true);
    expect(ASSUMED_PRICING[NEARAI_DEFAULT_MODEL]).toBeDefined();
  });

  it('five seeds, twice: the recorded model and the rules; prints the comparison and the credits needed', async () => {
    const runs: Run[] = [];
    for (const seed of SEEDS) for (const brain of ['model', 'rules'] as const) runs.push(await run(seed, brain));
    const row = (r: Run): string =>
      `seed ${r.seed} ${r.brain.padEnd(5)} | median x${r.median.toFixed(2)} | min x${r.min.toFixed(2)} | glut days ${String(r.glutDays).padStart(2)} | busts ${r.busts.length} | entrants ${r.entrants.length} | fallbacks ${r.stats.fallbacks} | calls ${r.tally?.calls ?? 0} (main ${r.stats.mainCalls}, cheap ${r.stats.cheapCalls}) | reflections ${r.stats.reflections}`;
    console.log(`AGENT COMPARE\n${runs.map(row).join('\n')}`);
    for (const r of runs)
      console.log(
        `AGENT CASH seed ${r.seed} ${r.brain}: ${Object.entries(r.cash)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}; busts ${r.busts.join(', ') || 'none'}; entrants ${r.entrants.join(', ') || 'none'}`,
      );
    const med = (list: number[]): number => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
    for (const brain of ['model', 'rules'] as const) {
      const rs = runs.filter((r) => r.brain === brain);
      console.log(
        `AGENT SUMMARY ${brain}: median of medians x${med(rs.map((r) => r.median)).toFixed(2)}, lowest x${Math.min(...rs.map((r) => r.min)).toFixed(2)}, glut days ${rs.reduce((n, r) => n + r.glutDays, 0)}, rival busts ${rs.reduce((n, r) => n + r.busts.length, 0)}, entrants ${rs.reduce((n, r) => n + r.entrants.length, 0)}, fallbacks ${rs.reduce((n, r) => n + r.stats.fallbacks, 0)}, calls ${rs.reduce((n, r) => n + (r.tally?.calls ?? 0), 0)}`,
      );
    }
    const credits = creditsReport(runs);
    console.log(`CREDITS NEEDED\n${credits.lines.join('\n')}`);

    for (const r of runs) {
      if (r.brain === 'rules') {
        expect(r.stats).toMatchObject({ mainCalls: 0, cheapCalls: 0, fallbacks: 0 });
        expect(r.stats.reflections).toBeGreaterThan(0);
        continue;
      }
      // the model run used both tiers, wrote reflections on the main model, fell back on unusable replies, stayed under its cap
      expect(r.stats.cheapCalls).toBeGreaterThan(0);
      expect(r.stats.mainCalls).toBeGreaterThan(0);
      expect(r.stats.reflections).toBeGreaterThan(0);
      expect(r.tally?.reflections).toBeGreaterThan(0);
      expect(r.stats.fallbacks).toBeGreaterThanOrEqual(r.tally?.invalid ?? 0);
      expect(r.tally?.invalid).toBeGreaterThan(0);
      expect(r.spendUsd).toBeLessThanOrEqual(CAP_USD);
    }
    expect(credits.numbers.cappedDay).toBeLessThanOrEqual(1);
    expect(credits.numbers.worstDay).toBeLessThanOrEqual(1);
    expect(credits.numbers.uncappedDay).toBeGreaterThan(credits.numbers.cappedDay);
  }, 600_000);
});
