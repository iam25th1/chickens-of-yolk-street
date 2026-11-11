// Game server entry: config, database, the cast's brains, the chain writer, HTTP and WebSocket.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEARAI_DEFAULT_CHEAP_MODEL, NearAiClient } from './ai/nearai';
import { InferenceBudget } from './agents/brain';
import { createPrivyVerifier } from './auth/privy';
import { createSessionSigner } from './auth/session';
import { createChainWriter } from './chain/chain';
import { HenRenderer } from './chain/hen-image';
import { openDb } from './db/db';
import { describeEnv, readConfig } from './env';
import { Game } from './game/game';
import { createGameServer } from './net/server';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const config = readConfig(process.env, repoRoot);
log(`[env] ${describeEnv(process.env)}`);
if (config.sessionSecretEphemeral) log('[auth] SESSION_SECRET unset: using a random secret, sessions end on restart');
if (!config.privyAppId) log('[auth] PRIVY_APP_ID unset: running with the LOCAL DEV LOGIN only');

const db = await openDb(config.databaseUrl);
log(`[db] ${db.kind}${db.kind === 'pglite' ? ` at ${config.databaseUrl.slice('pglite://'.length)}` : ''}`);

const renderer = new HenRenderer(join(repoRoot, 'apps/client/public/assets'));
const chain = createChainWriter(process.env, renderer, log);
if (chain.mode === 'noop') log('[chain] !!! NEAR testnet credentials missing: every daily settlement is a recorded NO-OP, nothing is signed');

const nearAi = process.env.NEARAI_API_KEY
  ? new NearAiClient({ apiKey: process.env.NEARAI_API_KEY, baseUrl: process.env.NEARAI_BASE_URL, model: process.env.NEARAI_MODEL })
  : null;
const cheapModel = process.env.NEARAI_CHEAP_MODEL || NEARAI_DEFAULT_CHEAP_MODEL;
const capUsd = Number(process.env.NEARAI_DAILY_SPEND_CAP_USD || 1);
log(
  nearAi
    ? `[agents] agents decide on NEAR AI Cloud (${nearAi.model}, ${cheapModel} when struggling), capped at ${capUsd} USD per UTC day`
    : '[agents] NEARAI_API_KEY unset: agents use their rule policies',
);

const game = new Game({
  db,
  chain,
  log,
  brain: {
    client: nearAi,
    budget: new InferenceBudget(db, capUsd),
    model: nearAi?.model ?? '',
    cheapModel,
    pricing: nearAi ? await nearAi.pricing() : new Map(),
  },
});
await game.init();

const server = createGameServer({
  game,
  sessions: createSessionSigner(config.sessionSecret),
  privy: config.privyAppId ? createPrivyVerifier(config.privyAppId, config.privyVerificationKey ?? undefined) : null,
  privyAppId: config.privyAppId,
  devLogin: config.devLogin,
  clientDist: config.clientDist,
  settlementMode: chain.mode,
  dbKind: db.kind,
  log,
});

const tick = setInterval(() => {
  game.tick().catch((err: unknown) => log(`[day] tick failed: ${err instanceof Error ? err.stack : String(err)}`));
}, 1000);

server.listen(config.port, () => log(`[http] listening on http://localhost:${config.port} (day ${game.getClock().day})`));

const shutdown = (): void => {
  clearInterval(tick);
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
