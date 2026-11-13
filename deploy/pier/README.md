# Deploying on Pier

Chickens of Yolk Street runs as one long-running Node process (the built client, the HTTP API and
the WebSocket on one port) plus a Postgres database. On Pier it is served at
**https://yolkstreet.25th.dev** through a Cloudflare tunnel. Render is the fallback
([deploy/render](../render/README.md)).

## Service settings

| Setting | Value |
|---|---|
| Repository | `iam25th1/chickens-of-yolk-street` (private: give Pier read access) |
| Branch | `main` |
| Node | 24.22.3 (LTS); the repo needs 22.22.2 or newer. Pier runs its own Node, so pin this one by path: the start command names the 24.22.3 `node` binary and each build step runs under `/usr/bin/env PATH=<24.22.3 bin>:...` |
| Working directory | the repository root |
| Build, step 1 | `npm ci --ignore-scripts --include=dev` (Pier runs build steps with `NODE_ENV=production`, which would leave out the build tools) |
| Build, step 2 | `npm run build` |
| Start | `node apps/server/dist/main.js` (straight to Node, so stop signals reach it and it closes cleanly) |
| Port | `8787` by default. On the Pier Mac 8787 is already held by another user's forward, so the service runs on `7570`; Pier passes `PORT` and `HOST=127.0.0.1`, and the server listens on `HOST` when it is set (every interface otherwise) |
| Health check | `GET http://127.0.0.1:<port>/healthz`, healthy on HTTP 200 with `"ok": true` |
| Restart | always; the clock and the day close live in this one process, so run exactly one instance |

The server applies database migrations on every boot. They are safe to run again and take an
advisory lock, so a restart during a deploy cannot race itself.

`/healthz` answers like this (503 and `"ok": false` when the database does not answer within 3 s):

```json
{ "ok": true, "version": "0.1.0", "commit": "50f6e89...", "season": "s1", "day": 12,
  "db": { "kind": "postgres", "ok": true, "ms": 2 }, "settlement": "near-testnet", "uptimeS": 5321 }
```

## Database

A Postgres database of its own (Postgres 16 or newer), for example database `coys` owned by a user
`coys`:

```
DATABASE_URL=postgres://coys:<password>@127.0.0.1:5432/coys
```

One database holds one season. Keep this database for the whole of season `s1`; a new season means a
new database and a new `GAME_SEASON` (see [deploy/testnet.md](../testnet.md#seasons)).

## Environment

Set these on the service. Values marked secret never go in the repo, a chat or a log.

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | turns on the production checks below |
| `PORT` | `8787` (`7570` on the Pier Mac) | Pier sets it from the service port |
| `HOST` | `127.0.0.1` | Pier sets it; listen on loopback only, behind the tunnel |
| `DATABASE_URL` | `postgres://...` | required in production; PGlite is refused |
| `GAME_SEASON` | `s1` | required in production |
| `SESSION_SECRET` | secret: a long random string | required in production |
| `PRIVY_APP_ID` | the Privy app id | public; turns on social login |
| `PRIVY_VERIFICATION_KEY` | Privy verification key (PEM) | optional; without it the server fetches Privy's JWKS |
| `NEAR_TESTNET_ACCOUNT_ID` | `play.coys-game.testnet` | the production contract account ([deploy/testnet.md](../testnet.md)) |
| `NEAR_TESTNET_PRIVATE_KEY` | secret: `ed25519:...` | testnet only |
| `NEARAI_API_KEY` | secret | agents use their rules until the NEAR AI account has credits |
| `NEARAI_DAILY_SPEND_CAP_USD` | for example `2` | hard cap per UTC day |

Leave unset in production: `ALLOW_DEV_LOGIN`, `DEMO_DAY_SECONDS`, `DEMO_MODE`,
`ALLOW_PGLITE_IN_PRODUCTION`. Optional with defaults: `NEAR_TESTNET_RPC_URL`,
`NEAR_GAME_CONTRACT_ID`, `CHAIN_MINT_NEAR`, `CHAIN_MIN_BALANCE_NEAR`,
`AGENT_ACCOUNT_FUNDING_NEAR`, `NEARAI_BASE_URL`, `NEARAI_MODEL`, `NEARAI_CHEAP_MODEL`,
`NEARAI_AGENT_DAILY_CAP_USD`, `NEARAI_AGENT_DAILY_CALLS`, `NEARAI_MAIN_PRICE`, `NEARAI_CHEAP_PRICE`
(see [docs/agents.md](../../docs/agents.md) for the credits they imply). Every variable is described
in [.env.example](../../.env.example).

The boot log lists every variable as `set` or `unset` (never a value) and warns loudly about
anything missing.

## Cloudflare tunnel

The game has a Cloudflare tunnel of its own, `yolkstreet`, in the **25th.dev** account, registered in Pier as a
tunnel record whose cert path is that account's cert. Pier writes its ingress (`yolkstreet.25th.dev` only),
creates the DNS record with that cert, and routes the hostname through its proxy to the service port. A tunnel of
its own means adding the game never restarts the connector of a tunnel that carries other sites.

| Field | Value |
|---|---|
| Hostname | `yolkstreet.25th.dev` |
| Tunnel | `yolkstreet` (25th.dev account) |
| Service | HTTP, through the Pier proxy to the service port on `127.0.0.1` |

Rate limits key on the visitor's address. Behind the tunnel every request reaches the server from loopback,
so the server takes `CF-Connecting-IP` from loopback requests only (Pier's proxy passes it through).

WebSockets need no extra setting: the game connects to `wss://yolkstreet.25th.dev/ws` on the same
host, and Cloudflare tunnels carry WebSocket upgrades.

## Privy

In the Privy dashboard for the game's app, add `https://yolkstreet.25th.dev` to the allowed domains
(and the Render URL, if the fallback is used). The client reads `PRIVY_APP_ID` from the server at
`/api/config`, so changing it needs a restart, not a rebuild.

## Backups

From any machine with Postgres client tools (`pg_dump`, `pg_restore` at the server's major version
or newer) and the database URL in `DATABASE_URL` (or the repo `.env`):

```powershell
npx tsx scripts/db-backup.ts --out backups
```

This writes `backups/coys-<UTC time>.dump`. Run it daily and before every deploy. The password is
passed to `pg_dump` as an environment variable, never on the command line.

On the Pier Mac a launchd agent runs it every day at 03:20 local time, with the database URL from a
`0600` file outside the repo, into a backups folder outside the repo, and keeps 30 days. On 11 November
2026 the first run was restored into a scratch database: all 19 tables came back with the same row counts
as the live database, and the scratch database was dropped.

## Moving to Render in an outage

1. Take a fresh backup on Pier (above), or use the newest one.
2. Create the Render services from `render.yaml` ([deploy/render](../render/README.md)) with the
   same `GAME_SEASON`, `SESSION_SECRET`, NEAR and Privy values, then suspend the web service. Its
   first boot on the empty database is harmless: the restore replaces everything, and a day it
   might close would be refused on chain because the season already settled that day.
3. Allow your IP on the Render database for the restore, put its external URL in
   `RESTORE_DATABASE_URL`, and restore:

   ```powershell
   npx tsx scripts/db-restore.ts --file backups/coys-<time>.dump --url-env RESTORE_DATABASE_URL --yes
   ```

   It runs in one transaction and stops at the first error, so a failed restore changes nothing.
4. Remove your IP from the allow list, resume the web service, and check `/healthz` shows the same
   season and day.
5. Point `yolkstreet.25th.dev` at Render (a CNAME to the Render host, and the custom domain added on
   the Render service), or share the Render URL. Only one server may run a season at a time:
   keep Pier stopped until you move back the same way.
