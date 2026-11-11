// Game server entry: config, database, game clock, HTTP and WebSocket.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearAiClient } from './ai/nearai';
import { createPrivyVerifier } from './auth/privy';
import { createSessionSigner } from './auth/session';
import { createSettlementWriter } from './chain/settlement';
import { openDb } from './db/db';
import { describeEnv, readConfig } from './env';
import { HeuristicBrain, NearAiBrain } from './game/agents';
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

const settlement = createSettlementWriter(process.env, log);
if (settlement.mode === 'noop') {
  log('[settlement] !!! NEAR testnet credentials missing: every daily settlement is a recorded NO-OP, nothing is signed');
}

const nearAi = process.env.NEARAI_API_KEY
  ? new NearAiClient({ apiKey: process.env.NEARAI_API_KEY, baseUrl: process.env.NEARAI_BASE_URL, model: process.env.NEARAI_MODEL })
  : null;
log(nearAi ? `[agents] rival brains on NEAR AI Cloud (${nearAi.model})` : '[agents] NEARAI_API_KEY unset: rivals use the heuristic brain');

const game = new Game({
  db,
  settlement,
  log,
  brainFor: () => (nearAi ? new NearAiBrain(nearAi, log) : new HeuristicBrain()),
});
await game.init();

const server = createGameServer({
  game,
  sessions: createSessionSigner(config.sessionSecret),
  privy: config.privyAppId ? createPrivyVerifier(config.privyAppId, config.privyVerificationKey ?? undefined) : null,
  privyAppId: config.privyAppId,
  devLogin: config.devLogin,
  clientDist: config.clientDist,
  settlementMode: settlement.mode,
  dbKind: db.kind,
  log,
});

const tick = setInterval(() => {
  game.tickIfDue().catch((err: unknown) => log(`[day] tick failed: ${err instanceof Error ? err.stack : String(err)}`));
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
