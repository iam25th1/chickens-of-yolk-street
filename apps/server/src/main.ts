// Game server entry: config, database, the cast's brains, the chain writer, HTTP and WebSocket.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECONOMY } from '@coys/shared';
import { ProviderChain } from './ai/chain';
import { NearAiClient } from './ai/nearai';
import type { InferenceProvider } from './ai/provider';
import { ServClient } from './ai/serv';
import { InferenceBudget, priceOf, type Pricing } from './agents/brain';
import { createGuestAuth } from './auth/guest';
import { createPrivyVerifier } from './auth/privy';
import { createSessionSigner } from './auth/session';
import { BUILD } from './build-info';
import { createChainWriter } from './chain/chain';
import { FeatherRenderer } from './chain/feather-image';
import { openDb } from './db/db';
import { describeEnv, readConfig, readInferenceConfig } from './env';
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

// the provider chain: NEAR AI Cloud, then SERV Reasoning, each only with its key; then the rules
const inference = readInferenceConfig(process.env);
const env = process.env;
const nearAi = env.NEARAI_API_KEY ? new NearAiClient({ apiKey: env.NEARAI_API_KEY, baseUrl: env.NEARAI_BASE_URL, model: env.NEARAI_MODEL, cheapModel: env.NEARAI_CHEAP_MODEL }) : null;
const serv = env.SERV_API_KEY
  ? new ServClient({ apiKey: env.SERV_API_KEY, baseUrl: env.SERV_BASE_URL, model: env.SERV_MODEL, cheapModel: env.SERV_CHEAP_MODEL, reasoningEffort: inference.servReasoningEffort })
  : null;
const providers: InferenceProvider[] = [nearAi, serv].filter((p): p is NearAiClient | ServClient => p !== null);
// prices: the *_MAIN_PRICE and *_CHEAP_PRICE variables first, then what the provider says (NEAR AI's /v1/models, SERV's published list), then the assumed ones (brain.ts)
const pricing = new Map<string, Pricing>();
for (const p of providers) for (const [model, price] of await p.pricing()) pricing.set(model, price);
if (nearAi && inference.mainPrice) pricing.set(nearAi.model, inference.mainPrice);
if (nearAi && inference.cheapPrice) pricing.set(nearAi.cheapModel, inference.cheapPrice);
if (serv && inference.servMainPrice) pricing.set(serv.model, inference.servMainPrice);
if (serv && inference.servCheapPrice) pricing.set(serv.cheapModel, inference.servCheapPrice);
const priced = (m: string): string => `${m} ${priceOf(pricing, m).input}/${priceOf(pricing, m).output}`;
if (inference.capFrom === 'NEARAI_DAILY_SPEND_CAP_USD') log('[agents] NEARAI_DAILY_SPEND_CAP_USD is the old name of LLM_DAILY_CAP_USD (the cap now covers every provider): rename it');
log(
  providers.length
    ? `[agents] agent decisions run on a provider chain: ${providers
        .map((p) => `${p.label} (${p.cheapModel} for decisions${p.mainOnHardDays ? `, ${p.model} on hard days` : ''}, ${p.model} for weekly reflections)`)
        .join(', then ')}, then the rule-based strategies as the last resort, all under a hard daily spend cap. ` +
        `The live mode is whichever answers (healthz ai.mode, the AI tag's tooltip). A model is asked only when it matters: an agent's first look, its weekly strategy, and at most once in ${inference.gapDays} in-game days a hard day or a price move of ${Math.round(inference.priceMove * 100)}%. ` +
        `Capped at ${inference.capUsd} USD per UTC day for all providers, each agent at ${inference.agentCap.calls} calls and ${inference.agentCap.usd} USD, ${inference.closeBudgetMs / 1000} s of model time per day close; ` +
        `prices per million tokens: ${providers.flatMap((p) => [p.model, p.cheapModel].map(priced)).join(', ')}`
    : '[agents] NEARAI_API_KEY and SERV_API_KEY unset: agents run on their rule strategies (no model provider)',
);
const providerChain = new ProviderChain(providers, { closeBudgetMs: inference.closeBudgetMs });

const game = new Game({
  db,
  chain,
  log,
  season: config.season,
  dayLengthMs: config.dayLengthMs,
  settleEvery: config.settleEvery,
  provenance,
  brain: {
    chain: providerChain,
    budget: new InferenceBudget(db, inference.capUsd, Date.now, inference.agentCap),
    pricing,
    priceMove: inference.priceMove,
    gapDays: inference.gapDays,
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
  demoSession: config.demoSession,
  guest: config.guestLimits ? { auth: createGuestAuth(config.sessionSecret), limits: config.guestLimits } : undefined,
  clientDist: config.clientDist,
  settlementMode: chain.mode,
  dbKind: db.kind,
  pingDb: () => db.query('SELECT 1'),
  log,
});

const tick = setInterval(() => {
  game.tick().catch((err: unknown) => log(`[day] tick failed: ${err instanceof Error ? err.stack : String(err)}`));
}, 1000);

log(config.guestLimits ? `[guest] guest play is on: at most ${config.guestLimits.perIpPerDay} new guest farms per address a day and ${config.guestLimits.perHour} an hour; idle guest farms go bust after 7 days` : '[guest] guest play is off (a guest limit is 0)');
if (config.demoSession) log('[demo] the demo session is ON (DEMO_MODE=1 on a local, non-production server): /?demo=new or /?demo=<farm name> signs straight in');
const listening = (): void => log(`[http] listening on http://${config.host ?? 'localhost'}:${config.port} (day ${game.getClock().day})`);
if (config.host) server.listen(config.port, config.host, listening);
else server.listen(config.port, listening);

const shutdown = (): void => {
  clearInterval(tick);
  // open websockets would keep close() waiting for ever (the host then kills the process): drop
  // them first, then idle keep-alive connections; a half-finished day close rolls back on its own
  server.emit(DRAIN);
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 6000).unref();
  // the days still waiting for their range settle now (best effort: at most a few seconds), then close
  const flushed = game.flushSettlement().catch((err: unknown) => log(`[chain] flush at shutdown failed: ${err instanceof Error ? err.message : String(err)}`));
  void Promise.race([flushed, new Promise((r) => setTimeout(r, 4000))]).then(() => {
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
