import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { readConfig, readInferenceConfig } from '../src/env';

const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://coys@db/coys', GAME_SEASON: 's1', SESSION_SECRET: 'x'.repeat(32) };

describe('configuration', () => {
  it('production needs a season, a session secret and real Postgres', () => {
    expect(readConfig(prod, '/repo')).toMatchObject({ production: true, season: 's1', databaseUrl: 'postgres://coys@db/coys' });
    expect(() => readConfig({ ...prod, GAME_SEASON: '' }, '/repo')).toThrow(/GAME_SEASON is required/);
    expect(() => readConfig({ ...prod, SESSION_SECRET: '' }, '/repo')).toThrow(/SESSION_SECRET is required/);
    expect(() => readConfig({ ...prod, DATABASE_URL: 'pglite://.data/coys' }, '/repo')).toThrow(/Postgres DATABASE_URL/);
    expect(() => readConfig({ ...prod, DATABASE_URL: '' }, '/repo')).toThrow(/Postgres DATABASE_URL/);
    // only to check a production build where no Postgres is reachable
    expect(readConfig({ ...prod, DATABASE_URL: 'memory://', ALLOW_PGLITE_IN_PRODUCTION: '1' }, '/repo').databaseUrl).toBe('memory://');
    expect(() => readConfig({ ...prod, GAME_SEASON: 'Season 1' }, '/repo')).toThrow(/a-z, 0-9/);
  });

  it('HOST picks the listen address; unset listens on every interface', () => {
    expect(readConfig({}, '/repo').host).toBeNull();
    expect(readConfig({ ...prod, HOST: '127.0.0.1' }, '/repo').host).toBe('127.0.0.1');
  });

  it('DEMO_DAY_SECONDS shortens the day locally; production ignores it unless DEMO_MODE=1', () => {
    expect(readConfig({}, '/repo').dayLengthMs).toBe(ECONOMY.day.lengthMs);
    expect(readConfig({}, '/repo').dayLengthMs).toBe(180_000);
    expect(readConfig({ DEMO_DAY_SECONDS: '45' }, '/repo')).toMatchObject({ dayLengthMs: 45_000, demoDayIgnored: false });
    expect(readConfig({ ...prod, DEMO_DAY_SECONDS: '45' }, '/repo')).toMatchObject({ dayLengthMs: 180_000, demoDayIgnored: true });
    expect(readConfig({ ...prod, DEMO_DAY_SECONDS: '45', DEMO_MODE: '1' }, '/repo')).toMatchObject({ dayLengthMs: 45_000, demoDayIgnored: false });
    expect(() => readConfig({ DEMO_DAY_SECONDS: '5' }, '/repo')).toThrow(/20 to 3600/);
    expect(() => readConfig({ DEMO_DAY_SECONDS: 'fast' }, '/repo')).toThrow(/20 to 3600/);
  });

  it('model caps: one shared cap for every provider (LLM_, with the old NEARAI_ names still read), per-agent caps, prices, pacing', () => {
    expect(readInferenceConfig({})).toEqual({
      capUsd: 1.5,
      capFrom: 'default',
      agentCap: { usd: 0.375, calls: 240 },
      mainPrice: null,
      cheapPrice: null,
      servMainPrice: null,
      servCheapPrice: null,
      priceMove: 0.15,
      gapDays: 3,
      closeBudgetMs: 60_000,
      servReasoningEffort: 'none',
    });
    // the old name is read while the new one is unset, and the new one wins
    expect(readInferenceConfig({ NEARAI_DAILY_SPEND_CAP_USD: '2' })).toMatchObject({ capUsd: 2, capFrom: 'NEARAI_DAILY_SPEND_CAP_USD', agentCap: { usd: 0.5, calls: 240 } });
    expect(readInferenceConfig({ NEARAI_DAILY_SPEND_CAP_USD: '2', LLM_DAILY_CAP_USD: '0.8' })).toMatchObject({ capUsd: 0.8, capFrom: 'LLM_DAILY_CAP_USD' });
    const c = readInferenceConfig({ NEARAI_AGENT_DAILY_CAP_USD: '0.1', NEARAI_AGENT_DAILY_CALLS: '12', NEARAI_MAIN_PRICE: '0.3, 1.2', NEARAI_CHEAP_PRICE: '0.05,0.2' });
    expect(c).toMatchObject({ agentCap: { usd: 0.1, calls: 12 }, mainPrice: { input: 0.3, output: 1.2 }, cheapPrice: { input: 0.05, output: 0.2 } });
    const l = readInferenceConfig({ LLM_AGENT_DAILY_CAP_USD: '0.2', LLM_AGENT_DAILY_CALLS: '50', NEARAI_AGENT_DAILY_CALLS: '12', SERV_CHEAP_PRICE: '0.13,0.65', LLM_PRICE_MOVE: '0.2', LLM_DECISION_GAP_DAYS: '2', LLM_CLOSE_BUDGET_SECONDS: '30', SERV_REASONING_EFFORT: 'low' });
    expect(l).toMatchObject({ agentCap: { usd: 0.2, calls: 50 }, servCheapPrice: { input: 0.13, output: 0.65 }, priceMove: 0.2, gapDays: 2, closeBudgetMs: 30_000, servReasoningEffort: 'low' });
    expect(() => readInferenceConfig({ NEARAI_AGENT_DAILY_CALLS: '2.5' })).toThrow(/NEARAI_AGENT_DAILY_CALLS must be a whole number/);
    expect(() => readInferenceConfig({ LLM_DAILY_CAP_USD: '-1' })).toThrow(/LLM_DAILY_CAP_USD must be a number of 0 or more/);
    expect(() => readInferenceConfig({ NEARAI_DAILY_SPEND_CAP_USD: '-1' })).toThrow(/0 or more/);
    expect(() => readInferenceConfig({ SERV_REASONING_EFFORT: 'max' })).toThrow(/none, low, medium, high/);
    expect(() => readInferenceConfig({ NEARAI_MAIN_PRICE: 'cheap' })).toThrow(/input,output/);
  });
});
