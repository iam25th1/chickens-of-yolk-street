import { describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { readConfig } from '../src/env';

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
});
