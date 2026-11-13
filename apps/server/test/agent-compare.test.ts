// The 30-day comparison: the same five seeds and the same two headless players (sim-players.ts),
// once with the recorded stand-in model (recorded-model.ts, replaying test/fixtures/agent-replies.json,
// with an unusable reply every 12th call) and once on the rules alone. It prints, per seed and brain,
// the median and lowest multiplier, glut days, busts, entrants, every agent's final cash, fallbacks
// and calls; then the credits-needed report: calls per agent per in-game day under the days-that-matter
// rule, tokens per call as the server estimates them (real system prompt, trimmed observation and
// response schema, 4 characters a token), 480 in-game days a real day on the live server, and each
// provider's default models at their prices (ASSUMED_PRICING), gated and at full use, per day and per
// week. docs/agents.md quotes its numbers.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, ECONOMY } from '@coys/shared';
import { NEARAI_DEFAULT_CHEAP_MODEL, NEARAI_DEFAULT_MODEL } from '../src/ai/nearai';
import { SERV_DEFAULT_CHEAP_MODEL, SERV_DEFAULT_MODEL } from '../src/ai/serv';
import { ASSUMED_PRICING, decisionFormat, priceOf } from '../src/agents/brain';
import { DEFAULT_DAILY_CAP_USD } from '../src/env';
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

const usd = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4));

/** What one provider would cost at the live pace: per call by kind, and per real day gated and at full use. */
interface ProviderCost {
  name: string;
  decision: number;
  reflection: number;
  gatedDay: number;
  fullDay: number;
}

/**
 * The credits-needed report from the model runs, at the live server's pace: calls measured here under
 * the days-that-matter rule (brain.ts modelMoment), tokens as the server estimates them (4 characters a
 * token, the response schema counted as prompt, SERV's 200 tokens of its own; replies at least what
 * real models answered: 150 tokens a decision, 100 a reflection), each provider's default models and
 * prices, 480 in-game days a real day. Full use is a model decision on every agent day.
 */
function creditsReport(runs: Run[]): { lines: string[]; numbers: { callsPerAgentDay: number; callsDay: number; providers: ProviderCost[] } } {
  const model = runs.filter((r) => r.brain === 'model');
  const sum = (f: (r: Run) => number): number => model.reduce((n, r) => n + f(r), 0);
  const decisions = sum((r) => r.tally?.decisions ?? 0);
  const reflections = sum((r) => r.tally?.reflections ?? 0);
  const hardDecisions = sum((r) => r.stats.mainCalls) - reflections;
  // agent days: every open agent's day, deciding or sitting out
  const agentDays = sum((r) => r.stats.decisions + r.stats.skipped);
  const decidingDays = sum((r) => r.stats.decisions);
  const realDay = (24 * 3600 * 1000) / ECONOMY.day.lengthMs;
  const agentsPerDay = agentDays / (model.length * DAYS);
  const perAgentDay = (n: number): number => n / agentDays;
  const callsPerAgentDay = perAgentDay(decisions + reflections);
  const callsDay = callsPerAgentDay * agentsPerDay * realDay;
  const t4 = (chars: number): number => Math.ceil(chars / 4);
  const schema = JSON.stringify(decisionFormat()).length;
  const decisionIn = t4(sum((r) => r.tally?.decisionPromptChars ?? 0) / Math.max(1, decisions) + schema);
  const decisionOut = Math.max(150, t4(sum((r) => r.tally?.decisionReplyChars ?? 0) / Math.max(1, decisions)));
  const reflectIn = t4(sum((r) => (r.tally?.promptChars ?? 0) - (r.tally?.decisionPromptChars ?? 0)) / Math.max(1, reflections));
  const reflectOut = Math.max(100, t4(sum((r) => (r.tally?.replyChars ?? 0) - (r.tally?.decisionReplyChars ?? 0)) / Math.max(1, reflections)));
  const cost = (price: { input: number; output: number }, prompt: number, completion: number): number => (prompt * price.input + completion * price.output) / 1e6;
  const day = realDay * agentsPerDay;
  const providers: ProviderCost[] = [
    { name: 'nearai', main: NEARAI_DEFAULT_MODEL, cheap: NEARAI_DEFAULT_CHEAP_MODEL, overhead: 0, mainOnHardDays: true },
    { name: 'serv', main: SERV_DEFAULT_MODEL, cheap: SERV_DEFAULT_CHEAP_MODEL, overhead: 200, mainOnHardDays: false },
  ].map((p) => {
    const main = priceOf(new Map(), p.main);
    const cheap = priceOf(new Map(), p.cheap);
    const hard = p.mainOnHardDays ? cost(main, decisionIn + p.overhead, decisionOut) : cost(cheap, decisionIn + p.overhead, decisionOut);
    const routine = cost(cheap, decisionIn + p.overhead, decisionOut);
    const reflection = cost(main, reflectIn + p.overhead, reflectOut);
    const hardShare = hardDecisions / Math.max(1, decisions);
    const decision = hardShare * hard + (1 - hardShare) * routine;
    return {
      name: p.name,
      decision,
      reflection,
      gatedDay: (perAgentDay(decisions) * decision + perAgentDay(reflections) * reflection) * day,
      fullDay: (perAgentDay(decidingDays) * decision + perAgentDay(reflections) * reflection) * day,
    };
  });
  const lines = [
    `measured over ${model.length} seeds x ${DAYS} in-game days: ${decisions + reflections} calls: ${decisions} decisions (${hardDecisions} on hard days) and ${reflections} weekly reflections; ${sum((r) => r.tally?.invalid ?? 0)} unusable replies`,
    `${perAgentDay(decisions).toFixed(3)} decisions and ${perAgentDay(reflections).toFixed(3)} reflections per agent per in-game day (full use: ${perAgentDay(decidingDays).toFixed(3)} decisions), ${agentsPerDay.toFixed(2)} agents a day, ${realDay} in-game days a real day: ${Math.round(callsDay)} calls a real day (full use ${Math.round((perAgentDay(decidingDays) + perAgentDay(reflections)) * day)})`,
    `tokens (4 characters a token): a decision ${decisionIn} in (the response schema ${t4(schema)} of it) + ${decisionOut} out; a reflection ${reflectIn} in + ${reflectOut} out; SERV adds 200 in to each`,
    ...providers.map(
      (p) =>
        `${p.name}: a decision ${p.decision.toFixed(6)} USD, a reflection ${p.reflection.toFixed(6)} USD; ${usd(p.gatedDay)} USD a real day (${usd(p.gatedDay * 7)} a week), full use ${usd(p.fullDay)} USD a day (${usd(p.fullDay * 7)} a week); at the default cap of ${DEFAULT_DAILY_CAP_USD} USD: ${usd(Math.min(p.gatedDay, DEFAULT_DAILY_CAP_USD))} a day gated, ${usd(Math.min(p.fullDay, DEFAULT_DAILY_CAP_USD))} at full use`,
    ),
  ];
  return { lines, numbers: { callsPerAgentDay, callsDay, providers } };
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
    // at the measured pace the days that matter stay under the default shared cap on either provider; full use would not
    for (const p of credits.numbers.providers) {
      expect(p.gatedDay).toBeLessThanOrEqual(DEFAULT_DAILY_CAP_USD);
      expect(p.fullDay).toBeGreaterThan(p.gatedDay * 2);
    }
  }, 600_000);
});
