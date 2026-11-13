// Reads configuration from the environment. Variable names only are ever logged, never values.
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { ECONOMY } from '@coys/shared';

export interface ServerConfig {
  production: boolean;
  port: number;
  /** HOST, or null to listen on every interface. */
  host: string | null;
  databaseUrl: string;
  sessionSecret: string;
  sessionSecretEphemeral: boolean;
  privyAppId: string | null;
  privyVerificationKey: string | null;
  devLogin: boolean;
  clientDist: string;
  /** GAME_SEASON, or null to keep the database's season (a fresh dev database makes its own). */
  season: string | null;
  /** Length of an in-game day: 180 s, or DEMO_DAY_SECONDS where demos are allowed. */
  dayLengthMs: number;
  /** DEMO_DAY_SECONDS was set but production ignores it (DEMO_MODE is not 1). */
  demoDayIgnored: boolean;
}

/** Season ids as the game contract accepts them. */
export const SEASON_ID = /^[a-z0-9-]{1,32}$/;

/** Shortest and longest demo day, in seconds. */
export const DEMO_DAY_RANGE = { min: 20, max: 3600 } as const;

export function readConfig(env: NodeJS.ProcessEnv, repoRoot: string): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const season = env.GAME_SEASON || null;
  if (season !== null && !SEASON_ID.test(season)) throw new Error('GAME_SEASON must be 1 to 32 characters of a-z, 0-9 and -');
  if (production && season === null) throw new Error('GAME_SEASON is required in production (for example s1)');

  const rawDb = env.DATABASE_URL || 'pglite://.data/coys';
  const postgres = /^postgres(ql)?:\/\//.test(rawDb);
  if (production && !postgres && env.ALLOW_PGLITE_IN_PRODUCTION !== '1') {
    throw new Error('production needs a Postgres DATABASE_URL (postgres://...); PGlite is for local play and tests');
  }
  if (production && !env.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production, or every restart signs everyone out');
  let databaseUrl = rawDb;
  if (rawDb.startsWith('pglite://')) {
    const dir = rawDb.slice('pglite://'.length);
    databaseUrl = `pglite://${isAbsolute(dir) ? dir : resolve(repoRoot, dir)}`;
  }

  const demoSeconds = env.DEMO_DAY_SECONDS ? Number(env.DEMO_DAY_SECONDS) : null;
  if (demoSeconds !== null && !(Number.isInteger(demoSeconds) && demoSeconds >= DEMO_DAY_RANGE.min && demoSeconds <= DEMO_DAY_RANGE.max)) {
    throw new Error(`DEMO_DAY_SECONDS must be a whole number from ${DEMO_DAY_RANGE.min} to ${DEMO_DAY_RANGE.max}`);
  }
  const demoAllowed = !production || env.DEMO_MODE === '1';

  const privyAppId = env.PRIVY_APP_ID || null;
  return {
    production,
    port: Number(env.PORT || 8787),
    host: env.HOST || null,
    databaseUrl,
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    sessionSecretEphemeral: !env.SESSION_SECRET,
    privyAppId,
    privyVerificationKey: env.PRIVY_VERIFICATION_KEY || null,
    devLogin: !privyAppId || env.ALLOW_DEV_LOGIN === '1',
    clientDist: resolve(repoRoot, 'apps/client/dist'),
    season,
    dayLengthMs: demoSeconds !== null && demoAllowed ? demoSeconds * 1000 : ECONOMY.day.lengthMs,
    demoDayIgnored: demoSeconds !== null && !demoAllowed,
  };
}

export interface InferenceConfig {
  /** NEARAI_DAILY_SPEND_CAP_USD: every agent together, per UTC day. */
  capUsd: number;
  /** NEARAI_AGENT_DAILY_CAP_USD (default a quarter of the global cap) and NEARAI_AGENT_DAILY_CALLS (default 40): one agent, per UTC day. */
  agentCap: { usd: number; calls: number };
  /** NEARAI_MAIN_PRICE and NEARAI_CHEAP_PRICE as "input,output" USD per million tokens; absent ones come from /v1/models or the assumed prices. */
  mainPrice: { input: number; output: number } | null;
  cheapPrice: { input: number; output: number } | null;
}

const nonNegative = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a number of 0 or more`);
  return v;
};

const price = (name: string, raw: string | undefined): { input: number; output: number } | null => {
  if (!raw) return null;
  const [input, output] = raw.split(',').map((x) => Number(x.trim()));
  if (input === undefined || output === undefined || !(input >= 0) || !(output >= 0)) throw new Error(`${name} must be "input,output" in USD per million tokens, for example 0.2,0.8`);
  return { input, output };
};

/** The NEAR AI spend caps and prices. */
export function readInferenceConfig(env: NodeJS.ProcessEnv): InferenceConfig {
  const capUsd = nonNegative('NEARAI_DAILY_SPEND_CAP_USD', env.NEARAI_DAILY_SPEND_CAP_USD, 1);
  const calls = nonNegative('NEARAI_AGENT_DAILY_CALLS', env.NEARAI_AGENT_DAILY_CALLS, 40);
  if (!Number.isInteger(calls)) throw new Error('NEARAI_AGENT_DAILY_CALLS must be a whole number');
  return {
    capUsd,
    agentCap: { usd: nonNegative('NEARAI_AGENT_DAILY_CAP_USD', env.NEARAI_AGENT_DAILY_CAP_USD, capUsd / 4), calls },
    mainPrice: price('NEARAI_MAIN_PRICE', env.NEARAI_MAIN_PRICE),
    cheapPrice: price('NEARAI_CHEAP_PRICE', env.NEARAI_CHEAP_PRICE),
  };
}

export const ENV_NAMES = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'DATABASE_URL',
  'ALLOW_PGLITE_IN_PRODUCTION',
  'GAME_SEASON',
  'DEMO_DAY_SECONDS',
  'DEMO_MODE',
  'SESSION_SECRET',
  'ALLOW_DEV_LOGIN',
  'PRIVY_APP_ID',
  'PRIVY_VERIFICATION_KEY',
  'NEAR_TESTNET_ACCOUNT_ID',
  'NEAR_TESTNET_PRIVATE_KEY',
  'NEAR_TESTNET_RPC_URL',
  'NEAR_GAME_CONTRACT_ID',
  'CHAIN_MINT_NEAR',
  'CHAIN_MIN_BALANCE_NEAR',
  'AGENT_ACCOUNT_FUNDING_NEAR',
  'NEARAI_API_KEY',
  'NEARAI_BASE_URL',
  'NEARAI_MODEL',
  'NEARAI_CHEAP_MODEL',
  'NEARAI_DAILY_SPEND_CAP_USD',
  'NEARAI_AGENT_DAILY_CAP_USD',
  'NEARAI_AGENT_DAILY_CALLS',
  'NEARAI_MAIN_PRICE',
  'NEARAI_CHEAP_PRICE',
] as const;

/** One line per variable: present or missing. Never prints a value. */
export function describeEnv(env: NodeJS.ProcessEnv): string {
  return ENV_NAMES.map((n) => `${n}=${env[n] ? 'set' : 'unset'}`).join(' ');
}
