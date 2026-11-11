# Render (fallback host)

Pier is the main host ([deploy/pier](../pier/README.md)); Render is the fallback, described by
[render.yaml](../../render.yaml) at the repo root: one web service and one Postgres database.

## What the Blueprint creates

| Resource | Settings |
|---|---|
| Web service `yolk-street` | runtime Node 24.22.3 (`NODE_VERSION`), plan `0.5c-512mb`, region `frankfurt`, branch `main`, one instance |
| Build | `npm ci --ignore-scripts && npm run build` |
| Start | `node apps/server/dist/main.js` |
| Port | Render's `PORT` (the server reads it) |
| Health check | `/healthz` |
| Deploys | after GitHub checks pass (`autoDeployTrigger: checksPass`) |
| Database `yolk-street-db` | Postgres 18, plan `0.1c-256mb`, database `coys`, user `coys`, private network only (`ipAllowList: []`) |

The free plans also work for a quick look, but a free web service sleeps when idle, which stops
the game clock, and a free database expires.

## Steps

1. In Render, **New > Blueprint**, pick `iam25th1/chickens-of-yolk-street` (give Render access to the
   private repo) and branch `main`. Render reads `render.yaml`.
2. Fill in the values it asks for (they are `sync: false`, so they live only in Render):

   | Variable | Value |
   |---|---|
   | `GAME_SEASON` | `s1` (the same season as Pier when taking over Pier's database) |
   | `SESSION_SECRET` | a long random string (Pier's, to keep players signed in across a move) |
   | `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | from the Privy dashboard (the key is optional) |
   | `NEAR_TESTNET_ACCOUNT_ID`, `NEAR_TESTNET_PRIVATE_KEY` | `play.coys-game.testnet` and its testnet key |
   | `NEARAI_API_KEY` | from cloud.near.ai |

   `NODE_ENV=production`, `DATABASE_URL` (from the database) and `NEARAI_DAILY_SPEND_CAP_USD=2` are
   set by the Blueprint.
3. Apply. The first deploy builds, runs the migrations and boots; check
   `https://<service>.onrender.com/healthz` shows `"ok": true`, `"db": { "kind": "postgres" }` and
   your season.
4. In Privy, add the Render URL (and any custom domain) to the app's allowed domains.

## Restoring Pier's database here

Follow [Moving to Render in an outage](../pier/README.md#moving-to-render-in-an-outage). In short:
suspend the web service, allow your IP on the database, take the database's **external** URL into
`RESTORE_DATABASE_URL`, run `scripts/db-restore.ts`, remove your IP, resume. Use Postgres client
tools of version 18 (the database's version) for the restore.

## Custom domain

To serve `yolkstreet.25th.dev` from Render instead of Pier, add it as a custom domain on the web
service and point the DNS record in the 25th.dev Cloudflare account at the Render host (instead of
the tunnel). Run only one server per season at a time.
