// Reads configuration from the environment. Variable names only are ever logged, never values.
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  sessionSecretEphemeral: boolean;
  privyAppId: string | null;
  privyVerificationKey: string | null;
  devLogin: boolean;
  clientDist: string;
  /** GAME_SEASON, or null to keep the database's season (a fresh dev database makes its own). */
  season: string | null;
}

/** Season ids as the game contract accepts them. */
export const SEASON_ID = /^[a-z0-9-]{1,32}$/;

export function readConfig(env: NodeJS.ProcessEnv, repoRoot: string): ServerConfig {
  const season = env.GAME_SEASON || null;
  if (season !== null && !SEASON_ID.test(season)) throw new Error('GAME_SEASON must be 1 to 32 characters of a-z, 0-9 and -');
  if (env.NODE_ENV === 'production' && season === null) throw new Error('GAME_SEASON is required in production (for example s1)');
  const rawDb = env.DATABASE_URL || 'pglite://.data/coys';
  let databaseUrl = rawDb;
  if (rawDb.startsWith('pglite://')) {
    const dir = rawDb.slice('pglite://'.length);
    databaseUrl = `pglite://${isAbsolute(dir) ? dir : resolve(repoRoot, dir)}`;
  }
  const privyAppId = env.PRIVY_APP_ID || null;
  return {
    port: Number(env.PORT || 8787),
    databaseUrl,
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    sessionSecretEphemeral: !env.SESSION_SECRET,
    privyAppId,
    privyVerificationKey: env.PRIVY_VERIFICATION_KEY || null,
    devLogin: !privyAppId || env.ALLOW_DEV_LOGIN === '1',
    clientDist: resolve(repoRoot, 'apps/client/dist'),
    season,
  };
}

export const ENV_NAMES = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'GAME_SEASON',
  'SESSION_SECRET',
  'ALLOW_DEV_LOGIN',
  'PRIVY_APP_ID',
  'PRIVY_VERIFICATION_KEY',
  'NEAR_TESTNET_ACCOUNT_ID',
  'NEAR_TESTNET_PRIVATE_KEY',
  'NEAR_TESTNET_RPC_URL',
  'NEAR_GAME_CONTRACT_ID',
  'CHAIN_HEN_MINTS_PER_DAY',
  'CHAIN_MIN_BALANCE_NEAR',
  'AGENT_ACCOUNT_FUNDING_NEAR',
  'NEARAI_API_KEY',
  'NEARAI_BASE_URL',
  'NEARAI_MODEL',
  'NEARAI_CHEAP_MODEL',
  'NEARAI_DAILY_SPEND_CAP_USD',
] as const;

/** One line per variable: present or missing. Never prints a value. */
export function describeEnv(env: NodeJS.ProcessEnv): string {
  return ENV_NAMES.map((n) => `${n}=${env[n] ? 'set' : 'unset'}`).join(' ');
}
