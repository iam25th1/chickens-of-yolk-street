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
}

export function readConfig(env: NodeJS.ProcessEnv, repoRoot: string): ServerConfig {
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
  };
}

export const ENV_NAMES = [
  'PORT',
  'DATABASE_URL',
  'SESSION_SECRET',
  'ALLOW_DEV_LOGIN',
  'PRIVY_APP_ID',
  'PRIVY_VERIFICATION_KEY',
  'NEAR_TESTNET_ACCOUNT_ID',
  'NEAR_TESTNET_PRIVATE_KEY',
  'NEAR_TESTNET_RPC_URL',
  'NEAR_SETTLEMENT_CONTRACT_ID',
  'NEARAI_API_KEY',
  'NEARAI_BASE_URL',
  'NEARAI_MODEL',
] as const;

/** One line per variable: present or missing. Never prints a value. */
export function describeEnv(env: NodeJS.ProcessEnv): string {
  return ENV_NAMES.map((n) => `${n}=${env[n] ? 'set' : 'unset'}`).join(' ');
}
