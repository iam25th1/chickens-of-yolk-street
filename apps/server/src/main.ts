// Game server entry: config, database, the cast's brains, the chain writer, HTTP and WebSocket.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECONOMY } from '@coys/shared';
import { NEARAI_DEFAULT_CHEAP_MODEL, NearAiClient } from './ai/nearai';
import { InferenceBudget } from './agents/brain';
import { createPrivyVerifier } from './auth/privy';
import { createSessionSigner } from './auth/session';
import { BUILD } from './build-info';
import { createChainWriter } from './chain/chain';
import { FeatherRenderer } from './chain/feather-image';
import { openDb } from './db/db';
import { describeEnv, readConfig } from './env';
import { Game } from './game/game';
import { createGameServer, DRAIN } from './net/server';
import { redactEmails } from './redact';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const log = (line: string): void => console.log(`${new Date().toISOString()} ${redactEmails(line)}`);
const config = readConfig(process.env, repoRoot);
log(`[env] ${describeEnv(process.env)}`);
log(`[build] ${BUILD.version}${BUILD.commit ? ` (${BUILD.commit})` : ''}${config.production ? ', production' : ''}`);
if (config.sessionSecretEphemeral) log('[auth] SESSION_SECRET unset: using a random secret, sessions end on restart');
if (!config.privyAppId) log(`[auth] PRIVY_APP_ID unset: running with the LOCAL DEV LOGIN only${config.production ? ' (!!! on a production server anyone can make a player)' : ''}`);
if (config.dayLengthMs !== ECONOMY.day.lengthMs) log(`[day] DEMO_DAY_SECONDS: an in-game day lasts ${config.dayLengthMs / 1000} s (normally ${ECONOMY.day.lengthMs / 1000} s)`);
if (config.demoDayIgnored) log('[day] DEMO_DAY_SECONDS is ignored in production unless DEMO_MODE=1');

const db = await openDb(config.databaseUrl);
log(`[db] ${db.kind}${config.databaseUrl === 'memory://' ? ' in memory' : db.kind === 'pglite' ? ` at ${config.databaseUrl.slice('pglite://'.length)}` : ''}`);
if (config.production && db.kind === 'pglite') log('[db] !!! PGlite in production (ALLOW_PGLITE_IN_PRODUCTION=1): for checking a build only, not for players');

const renderer = new FeatherRenderer(join(repoRoot, 'apps/client/public/assets'));
// founders.json (the 777 Founding Hens) stays server side; only its SHA-256 is public
const foundersSha = join(repoRoot, 'apps/server/data/founders.json.sha256');
const provenance = existsSync(foundersSha) ? readFileSync(foundersSha, 'utf8').trim().split(/\s+/)[0] ?? '' : '';
log(provenance ? `[feathers] founders.json provenance ${provenance}` : '[feathers] !!! apps/server/data/founders.json.sha256 missing: the mint page shows no provenance');
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
  season: config.season,
  dayLengthMs: config.dayLengthMs,
  provenance,
  brain: {
    client: nearAi,
    budget: new InferenceBudget(db, capUsd),
    model: nearAi?.model ?? '',
    cheapModel,
    pricing: nearAi ? await nearAi.pricing() : new Map(),
  },
});
await game.init();
log(`[season] ${game.season}${config.season ? '' : ' (GAME_SEASON unset: kept from the database, or made for a fresh one)'}`);

const server = createGameServer({
  game,
  sessions: createSessionSigner(config.sessionSecret),
  privy: config.privyAppId ? createPrivyVerifier(config.privyAppId, config.privyVerificationKey ?? undefined) : null,
  privyAppId: config.privyAppId,
  devLogin: config.devLogin,
  clientDist: config.clientDist,
  settlementMode: chain.mode,
  dbKind: db.kind,
  pingDb: () => db.query('SELECT 1'),
  log,
});

const tick = setInterval(() => {
  game.tick().catch((err: unknown) => log(`[day] tick failed: ${err instanceof Error ? err.stack : String(err)}`));
}, 1000);

const listening = (): void => log(`[http] listening on http://${config.host ?? 'localhost'}:${config.port} (day ${game.getClock().day})`);
if (config.host) server.listen(config.port, config.host, listening);
else server.listen(config.port, listening);

const shutdown = (): void => {
  clearInterval(tick);
  // open websockets would keep close() waiting for ever (the host then kills the process): drop
  // them first, then idle keep-alive connections; a half-finished day close rolls back on its own
  server.emit(DRAIN);
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
