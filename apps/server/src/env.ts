// Reads configuration from the environment. Variable names only are ever logged, never values.
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { ECONOMY } from '@coys/shared';
import { AGENT_DAILY_CALLS, DECISION_GAP_DAYS, PRICE_MOVE } from './agents/brain';
import { CLOSE_BUDGET_MS } from './ai/chain';
import { SERV_REASONING_EFFORTS, type ServReasoningEffort } from './ai/serv';
import { DEFAULT_GUEST_LIMITS, type GuestLimits } from './game/guests';

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
  /**
   * The demo session (POST /api/login/demo, for recording the demo video): signs straight into a new
   * or named farm with no login screen. Only with DEMO_MODE=1 on a server that is not production and
   * listens on loopback only; production never turns it on, whatever else is set.
   */
  demoSession: boolean;
  clientDist: string;
  /** GAME_SEASON, or null to keep the database's season (a fresh dev database makes its own). */
  season: string | null;
  /** Length of an in-game day: 180 s, or DEMO_DAY_SECONDS where demos are allowed. */
  dayLengthMs: number;
  /** DEMO_DAY_SECONDS was set but production ignores it (DEMO_MODE is not 1). */
  demoDayIgnored: boolean;
  /** SETTLE_EVERY_DAYS: days settle on the chain in ranges of this many, one call each (default 10). */
  settleEvery: number;
  /** Guest play's limits (GUEST_FARMS_PER_IP_PER_DAY, GUEST_FARMS_PER_HOUR), or null when either is 0 (guest play off). */
  guestLimits: GuestLimits | null;
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
    demoSession: demoSessionAllowed(env),
    clientDist: resolve(repoRoot, 'apps/client/dist'),
    season,
    dayLengthMs: demoSeconds !== null && demoAllowed ? demoSeconds * 1000 : ECONOMY.day.lengthMs,
    demoDayIgnored: demoSeconds !== null && !demoAllowed,
    settleEvery: settleEveryDays(env.SETTLE_EVERY_DAYS),
    guestLimits: guestLimits(env),
  };
}

/** The guest limits: whole numbers from 0 (guest play off) to 100000; the defaults when unset. */
export function guestLimits(env: NodeJS.ProcessEnv): GuestLimits | null {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Error(`${name} must be a whole number from 0 to 100000`);
    return n;
  };
  const limits = { perIpPerDay: read('GUEST_FARMS_PER_IP_PER_DAY', DEFAULT_GUEST_LIMITS.perIpPerDay), perHour: read('GUEST_FARMS_PER_HOUR', DEFAULT_GUEST_LIMITS.perHour) };
  return limits.perIpPerDay === 0 || limits.perHour === 0 ? null : limits;
}

/** Whether the demo session may run: DEMO_MODE=1, not production, and HOST a loopback address (never all interfaces). */
export function demoSessionAllowed(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return false;
  return env.DEMO_MODE === '1' && ['127.0.0.1', 'localhost', '::1'].includes(env.HOST ?? '');
}

/** SETTLE_EVERY_DAYS as a whole number of days from 1 (every day its own call) to 100; 10 when unset. */
export function settleEveryDays(raw: string | undefined): number {
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('SETTLE_EVERY_DAYS must be a whole number from 1 to 100');
  return n;
}

export interface InferenceConfig {
  /** LLM_DAILY_CAP_USD (default 1.50): every provider and agent together, per UTC day. NEARAI_DAILY_SPEND_CAP_USD is its old name, still read when it is unset. */
  capUsd: number;
  /** Which name the cap came from, for the boot log. */
  capFrom: 'LLM_DAILY_CAP_USD' | 'NEARAI_DAILY_SPEND_CAP_USD' | 'default';
  /**
   * LLM_AGENT_DAILY_CAP_USD (default a quarter of the shared cap) and LLM_AGENT_DAILY_CALLS (default
   * AGENT_DAILY_CALLS, failed calls included): one agent, per UTC day. The NEARAI_AGENT_DAILY_ names
   * are still read when these are unset.
   */
  agentCap: { usd: number; calls: number };
  /** NEARAI_MAIN_PRICE and NEARAI_CHEAP_PRICE as "input,output" USD per million tokens; absent ones come from /v1/models or the assumed prices. */
  mainPrice: { input: number; output: number } | null;
  cheapPrice: { input: number; output: number } | null;
  /** SERV_MAIN_PRICE and SERV_CHEAP_PRICE, the same way; absent ones are SERV's published prices. */
  servMainPrice: { input: number; output: number } | null;
  servCheapPrice: { input: number; output: number } | null;
  /** LLM_PRICE_MOVE (default 0.15): a model decision is due once the multiplier moved this share since the agent's last one. */
  priceMove: number;
  /** LLM_DECISION_GAP_DAYS (default 3): an agent asks a model at most once in this many in-game days, its first look and weekly reflection aside. */
  gapDays: number;
  /** LLM_CLOSE_BUDGET_SECONDS (default 60): all model calls of one day close together, in ms. */
  closeBudgetMs: number;
  /** SERV_REASONING_EFFORT (default none). */
  servReasoningEffort: ServReasoningEffort;
}

/** The shared daily cap on model spend, every provider together, by default (USD). */
export const DEFAULT_DAILY_CAP_USD = 1.5;

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

/** The new name if it is set, else the old one (a deprecated alias). */
const either = (env: NodeJS.ProcessEnv, name: string, old: string): { name: string; raw: string | undefined } =>
  env[name] !== undefined && env[name] !== '' ? { name, raw: env[name] } : { name: old, raw: env[old] };

/** The model spend caps (shared by every provider), prices and pacing. */
export function readInferenceConfig(env: NodeJS.ProcessEnv): InferenceConfig {
  const cap = either(env, 'LLM_DAILY_CAP_USD', 'NEARAI_DAILY_SPEND_CAP_USD');
  const capUsd = nonNegative(cap.name, cap.raw, DEFAULT_DAILY_CAP_USD);
  const callsVar = either(env, 'LLM_AGENT_DAILY_CALLS', 'NEARAI_AGENT_DAILY_CALLS');
  const calls = nonNegative(callsVar.name, callsVar.raw, AGENT_DAILY_CALLS);
  if (!Number.isInteger(calls)) throw new Error(`${callsVar.name} must be a whole number`);
  const agentUsd = either(env, 'LLM_AGENT_DAILY_CAP_USD', 'NEARAI_AGENT_DAILY_CAP_USD');
  const priceMove = nonNegative('LLM_PRICE_MOVE', env.LLM_PRICE_MOVE, PRICE_MOVE);
  const gapDays = nonNegative('LLM_DECISION_GAP_DAYS', env.LLM_DECISION_GAP_DAYS, DECISION_GAP_DAYS);
  if (!Number.isInteger(gapDays)) throw new Error('LLM_DECISION_GAP_DAYS must be a whole number');
  const closeSeconds = nonNegative('LLM_CLOSE_BUDGET_SECONDS', env.LLM_CLOSE_BUDGET_SECONDS, CLOSE_BUDGET_MS / 1000);
  const effort = env.SERV_REASONING_EFFORT || 'none';
  if (!(SERV_REASONING_EFFORTS as readonly string[]).includes(effort)) throw new Error(`SERV_REASONING_EFFORT must be one of ${SERV_REASONING_EFFORTS.join(', ')}`);
  return {
    capUsd,
    capFrom: cap.raw === undefined || cap.raw === '' ? 'default' : (cap.name as InferenceConfig['capFrom']),
    agentCap: { usd: nonNegative(agentUsd.name, agentUsd.raw, capUsd / 4), calls },
    mainPrice: price('NEARAI_MAIN_PRICE', env.NEARAI_MAIN_PRICE),
    cheapPrice: price('NEARAI_CHEAP_PRICE', env.NEARAI_CHEAP_PRICE),
    servMainPrice: price('SERV_MAIN_PRICE', env.SERV_MAIN_PRICE),
    servCheapPrice: price('SERV_CHEAP_PRICE', env.SERV_CHEAP_PRICE),
    priceMove,
    gapDays,
    closeBudgetMs: Math.round(closeSeconds * 1000),
    servReasoningEffort: effort as ServReasoningEffort,
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
  'SETTLE_EVERY_DAYS',
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
  'SERV_API_KEY',
  'SERV_BASE_URL',
  'SERV_MODEL',
  'SERV_CHEAP_MODEL',
  'SERV_REASONING_EFFORT',
  'SERV_MAIN_PRICE',
  'SERV_CHEAP_PRICE',
  'LLM_DAILY_CAP_USD',
  'LLM_AGENT_DAILY_CAP_USD',
  'LLM_AGENT_DAILY_CALLS',
  'LLM_PRICE_MOVE',
  'LLM_DECISION_GAP_DAYS',
  'LLM_CLOSE_BUDGET_SECONDS',
] as const;

/** One line per variable: present or missing. Never prints a value. */
export function describeEnv(env: NodeJS.ProcessEnv): string {
  return ENV_NAMES.map((n) => `${n}=${env[n] ? 'set' : 'unset'}`).join(' ');
}
