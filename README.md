<p align="center"><img src=".github/header.svg" alt="Chickens of Yolk Street: an animated pixel farm with walking hens, a dropping egg and a scrolling egg price ticker" width="100%"></p>

# Chickens of Yolk Street

Run an egg farm in **one shared live market** where every rival, supplier and buyer is an AI agent with its own cash, memory and wallet. Egg prices, gluts and bankruptcies come only from what everyone trades, never from a script. Built at NEAR HACKATHON (tracks: games, agents, NFTs), 1 to 14 November 2026.

**Play:** https://yolkstreet.25th.dev _(live URL placeholder: the deploy is set up in [deploy/pier](deploy/pier/README.md) and goes live before submission)_

| | |
|---|---|
| **Play loop** | Hens lay on a schedule; you collect, sell, buy hens, feed, coops and machines. One in-game day is 3 real minutes, and each day brings 2 to 4 decision cards from the agents. A first-run tour of three cards explains the rest. |
| **Market** | One price multiplier for everyone, set by the whole market's daily supply against demand that grows with the number of farms. Instant street sales, a real order book with limit orders, and player-to-player trades. |
| **Agents** | Seven: two rival farms, two feed suppliers, three egg buyers. Each decides once a day on NEAR AI Cloud (structured JSON output) or its rule policy, pays for its thinking, remembers every deal, haggles in character, borrows, and can go bust. |
| **Chain** | Hens are NEP-171 NFTs, eggs are NEP-245 tokens, and each day settles in one call on NEAR testnet, keyed by season and day. Agents hold sub-account wallets. Players sign in with email; their wallet is made silently. No crypto words in the game: one "on-chain receipt" link in the ledger. |
| **Feel** | Squash and stretch, hitstop, screen shake, particles and layered sound on every action, portraits that talk with voice babble, and a reduce-motion switch. |

## The problem

Farm games fake their economies: prices follow a curve someone wrote, rivals are scripts, and nothing a player does moves the market. On-chain games often go the other way and lead with wallets and tokens, so the game is buried under the plumbing.

Chickens of Yolk Street puts a **real, shared economy** in a toy you can play with one hand. Every egg anyone sells (players and AI agents alike) is supply in the same market. Sell too many and everyone's price falls. NPCs are businesses with wallets: the Squeezer prices your hunger into your feed, the Bakery holds you to your contract, and a rival that overbuilds goes bust and its hens go to auction. The economy evolves without a dev patch, and the chain keeps an honest record of each day while staying out of sight.

## How NEAR fits in

NEAR tools used: **Privy social login** (email, with a silent NEAR wallet), **NEAR AI Cloud** (agent decisions), **NEP-171** hen NFTs, **NEP-245** egg tokens, **sub-account agent wallets**, and **batched testnet settlement** (one call per in-game day).

| NEAR piece | What it does here | Status in this build |
|---|---|---|
| **Game contract on testnet** (`near-sdk` 5.30.1) | One contract on the game account: hen NFTs (NEP-171, `near-contract-standards` 5.30.1), egg tokens (NEP-245, `near-sdk-contract-tools` 4.0.0 from the near org), and `settle_day`, owner only, once per in-game day of a season. | **Live** on `coys-game.testnet`, upgraded in place to the season-aware version (tx [`HXYRgKDn...`](https://testnet.nearblocks.io/txns/HXYRgKDnKS7TveYSwDHQp31nsNtzx2jnw64F2hUA39Cf)). Wasm built in CI with `cargo near`, sha256 `fc7645dc...`. Production gets its own account ([deploy/testnet.md](deploy/testnet.md)). |
| **Agent wallets** (near-api-js 7.5.3) | Each agent gets a testnet sub-account of the game account (`bakery1.coys-game.testnet` and so on), funded from it; its eggs and hens settle to it. A contract delivery moves egg tokens from the player's wallet to the Bakery's. | **Live**: seven wallets, and a delivery proven on chain (below). |
| **Privy social login** (docs.near.org social login) | Email sign-in; a NEAR testnet wallet is created silently with Privy's extended-chains API; the server verifies the ES256 access token with `jose`. That wallet holds the player's hens and eggs. | Wired. Needs `PRIVY_APP_ID` and the live domain in Privy's allowed domains. |
| **NEAR AI Cloud** (OpenAI-compatible) | Every agent's daily decision, as structured JSON output (`json_schema`, strict) checked against a zod schema; anything unusable falls back to rules and is logged. Hard daily spend cap. | Wired. Needs `NEARAI_API_KEY` and account credits; default model `Qwen/Qwen3.6-35B-A3B-FP8`, cheaper `z-ai/glm-5.3-flash` for struggling agents. |

**Testnet receipts.** Every link opens the transaction on the testnet explorer.

| When | What | Transaction |
|---|---|---|
| 11 Nov | Game contract deployed and initialised on `coys-game.testnet` (version 1) | [Bzhs5zTq...](https://testnet.nearblocks.io/txns/Bzhs5zTqUJFNE83HzjZsCUonxhwkcHTXuV868nbMdGoc) |
| 11 Nov | Seven agent wallets created: `bakery1`, `loyalist1`, `oldmoney1`, `squeezer1`, `trader1`, `upstart1`, `wholesaler1` (each `.coys-game.testnet`) | on the first day close |
| 11 Nov | Day 1 settled: 94 egg tokens and 12 hen NFTs minted | [tW6D6wqy...](https://testnet.nearblocks.io/txns/tW6D6wqyd97366MCi59in83ge8N8RfRZwtKHuxEDrLm) |
| 11 Nov | Day 2 settled: 54 eggs minted, 4 burned (a street sale), 12 more hens | [2b2wWs9X...](https://testnet.nearblocks.io/txns/2b2wWs9XSU8MDcPmpUeyujtbmUXPRZfsbfduF17TS8MS) |
| 11 Nov | Day 3 settled: 26 eggs minted, 16 burned, 12 more hens | [42awyreg...](https://testnet.nearblocks.io/txns/42awyregh4i6BgKDQTXBmjqZa4MBfrPKSJTrfYHRQvTC) |
| 11 Nov | Contract upgraded in place to seasons; `migrate` files days 1 to 3 under the season `legacy`, keeping all 36 hens and every egg balance | [HXYRgKDn...](https://testnet.nearblocks.io/txns/HXYRgKDnKS7TveYSwDHQp31nsNtzx2jnw64F2hUA39Cf) |
| 11 Nov | Season `delivery-proof` day 1: a fresh season starts at day 1 on the same contract | [FwR1skf3...](https://testnet.nearblocks.io/txns/FwR1skf3G1weRLRypZLhyb7CbBcKzVKuoKQ3n6FQoFJQ) |
| 11 Nov | Season `delivery-proof` day 2: the player delivers 3 eggs on a Bakery standing contract; two NEP-245 `mt_transfer` events move 1 white and 2 cream from the player's wallet `f9ad7ca1...` to `bakery1.coys-game.testnet`, which then bakes them (burned) | [2Erp19yX...](https://testnet.nearblocks.io/txns/2Erp19yXaNGekgt6a8EgK2q66gSnDRpAAmQmb3cH2ifF) |
| 11 Nov | Season `tour5-20261111`: the headless tour behind the screenshots, one settlement per 30-second day for 12 days (the ledger links in the ledger screenshot are these) | day 1 [8WeCaoGp...](https://testnet.nearblocks.io/txns/8WeCaoGpJJ72nHqpVcnunnrN8FAEgzJWvAm44VbfT1ER), day 12 [2jebGi4R...](https://testnet.nearblocks.io/txns/2jebGi4RLcinhyvL6WC7pizakx5WAmpvepMqGYJEdNk6) |

Check it yourself with view calls on `coys-game.testnet`: `day_record({"season": "delivery-proof", "day": 2})` (shows `egg_transfers: 2`), `last_settled_day({"season": "legacy"})` (3), `nft_total_supply()`; the `mt_transfer` events are in the day 2 transaction's receipts. NEAR AI Cloud answered 402 (no credits on the account yet) in these runs, so every agent used its rule policy and each fallback was logged: the path the tests also cover.

**Live deploy.** https://yolkstreet.25th.dev runs season `s1` on Pier, settling to its own production contract
account `play.coys-game.testnet` ([deploy/pier](deploy/pier/README.md), [deploy/testnet.md](deploy/testnet.md)).
Checked on 11 November 2026 at about 20:06 UTC:

```json
{"ok":true,"version":"0.1.0","commit":"a2d54b574f2f","season":"s1","day":2,"db":{"kind":"postgres","ok":true,"ms":0},"settlement":"near-testnet","uptimeS":108}
```

| When | What | Transaction |
|---|---|---|
| 11 Nov | `play.coys-game.testnet` created by `coys-game.testnet` with the same public key, funded with 5.33 NEAR | [9bejUg6V...](https://testnet.nearblocks.io/txns/9bejUg6VLDakSHe7MZj6ecQatNrSv9ifS5rBajpztiKY) |
| 11 Nov | Game contract (wasm sha256 `fc7645dc...`) deployed and initialised on it, owner `play.coys-game.testnet` | [5ZdpvZgA...](https://testnet.nearblocks.io/txns/5ZdpvZgA4U4idi6DorRN8AfH5kMcHk2CzyGnwp9gy2Gd) |
| 11 Nov | Agent wallet `upstart1.play.coys-game.testnet`, 0.05 NEAR | [DBsnzZUE...](https://testnet.nearblocks.io/txns/DBsnzZUETH8aLTt5Sk7aFY42bcMZ6UCNGaZMqi2q8BqW) |
| 11 Nov | Agent wallet `oldmoney1.play.coys-game.testnet`, 0.05 NEAR | [6zrX27tX...](https://testnet.nearblocks.io/txns/6zrX27tXnVYGCNnribskBo9EJGWDeQXBMSsNsCuXgbVs) |
| 11 Nov | Agent wallet `squeezer1.play.coys-game.testnet`, 0.05 NEAR | [2pCBa4nx...](https://testnet.nearblocks.io/txns/2pCBa4nxkasgRLiZnT66gcRXLL3FZuuh6KRjzKTtiBUt) |
| 11 Nov | Agent wallet `loyalist1.play.coys-game.testnet`, 0.05 NEAR | [J5XmcTQb...](https://testnet.nearblocks.io/txns/J5XmcTQb5TbGhr6kjzBgq7N9QbSEVDcKuMbepxrvkrJB) |
| 11 Nov | Agent wallet `bakery1.play.coys-game.testnet`, 0.05 NEAR | [6XoSGUAn...](https://testnet.nearblocks.io/txns/6XoSGUAnp98xLnTB7vg1LyS6vmS5bk99h274iTg4Jf4A) |
| 11 Nov | Agent wallet `trader1.play.coys-game.testnet`, 0.05 NEAR | [FfCVpyMj...](https://testnet.nearblocks.io/txns/FfCVpyMjNcZScYkGu75JYy6oVBSn3LWVtSWqxTgaaM4a) |
| 11 Nov | Agent wallet `wholesaler1.play.coys-game.testnet`, 0.05 NEAR | [4xqGJnhA...](https://testnet.nearblocks.io/txns/4xqGJnhAcTpRHM2wEZU2H9PZLvKd5k2LDcnzGMpt3jRf) |
| 11 Nov | Season `s1` day 1 settled on the production contract (`last_settled_day({"season": "s1"})` is 1) | [Fz56pALi...](https://testnet.nearblocks.io/txns/Fz56pALiRXbLvt9ZK6R6ZwRg1uhzdeJ2XRyxcipHdaS6) |

Also checked live: the title page, `/build/index-BL-i4f2Y.js` and `/assets/sprites/12-crate.png` answer 200, a
WebSocket on `wss://yolkstreet.25th.dev/ws` upgrades (101) and answers a ping, and `/api/market` serves the market
state. Waiting on a top-up: after the contract's storage and the seven wallets, `play.coys-game.testnet` holds about
1.5 NEAR available, under the 2 NEAR reserve, so hen mints wait and the server links the seven wallets to their
agents only once the balance is back above 2.05 NEAR (12 NEAR recommended). Eggs settle meanwhile.

## Try it

Node 22.22.2 or newer (CI and the deploy docs use 24.22.3). Each step says what to do and what you should see. Commands are the same in PowerShell and a POSIX shell unless shown otherwise.

1. **Install.** Run `npm ci --ignore-scripts`. You see the lockfile install with no package install scripts (`.npmrc` also sets `ignore-scripts=true`).
2. **Test.** Run `npm test`. On a fresh clone you see **85 tests pass and 3 skip**: the 2 Postgres tests need `TEST_DATABASE_URL` (CI sets it), and the asset re-pack check needs a coys-assets checkout beside the repo. Among them: the economy sheet (margin **0.46**, payback **17.3** days, multiplier **0.54** at 1300 supply against the fixed 600 reference, a 30-hen coop **full on day 16**), the five-seed 30-day market simulation, haggling, model fallbacks, seasons, the chain batch with a contract delivery moving tokens to the Bakery, `/healthz`, and two real WebSocket clients in one market.
3. **Play.** Run `npm run dev` and open http://localhost:5173. You see an egg fill up over the loading plate, then the title: the logo stamps in and the price ticker scrolls.
4. **Sign in.** Press **PLAY**. With `PRIVY_APP_ID` set you sign in with email; without it a red **LOCAL DEV LOGIN** label asks for a name. You see your farm: 10 hens, a starter coop, **50.00** coins, **DAY001**.
5. **Take the tour.** On a first visit your hen talks you through three cards: **COLLECT**, **SELL**, **DECISION CARDS**. You see each card swing in while she talks; **SKIP** closes it, and it does not come back on that browser.
6. **Collect and sell.** Click an egg a hen just laid: you see it pop into the crate. Press **SELL N EGGS**: a **SOLD** stamp slams and coins arc to the counter.
7. **Meet the agents.** From day 2 cards slide in: a portrait talks in its own voice while its line types out (the Bakery offering a standing contract, the Wholesaler a bulk order, the Squeezer a feed deal). Press **ACCEPT**: you see the right stamp slam.
8. **Win a haggle.** On a buyer's card, press **-** a few times so **YOUR PRICE** sits just above the offer, then **COUNTER**. You see the card flip to gold with confetti and the win chime (inside the agent's walk-away price).
9. **Lose one.** On another card, press **+** many times and **COUNTER**. You see the agent counter, get cross, and after three rounds (or at once, if it is proud) walk off with the fail sound.
10. **Sell into a glut.** Speed days up: `DEMO_DAY_SECONDS=30` before `npm run dev` (PowerShell: `$env:DEMO_DAY_SECONDS = "30"; npm run dev`). Open the **market board**: you see **SOLD n OF d**, today's sales against demand. When a day's supply runs well past demand (Old Money releasing its hoard, the Wholesaler reselling), you see the next multiplier fall, the ticker turn red at 0.80 or lower, the **GLUT WARNING** card in the tray, and the tension music take over.
11. **Watch a rival bust.** The Upstart borrows feed from the Loyalist to grow on good weeks. When a glut meets its debt, it goes below zero: you see its sign tip over, a price wave cross the ticker, feathers fall, and its hens appear in the shop as **AUCTION** hens at half price; a new rival opens three days later. At 30-second days this usually happens 8 to 14 minutes into a season.
12. **Deliver a contract.** Accept the Bakery's contract, then press **DELIVER** on the desk each day (or buy the delivery cart: it delivers at dusk). You see coins arrive; with testnet credentials the day's batch moves those egg tokens to the Bakery's wallet. Miss one and you pay a penalty and the Bakery remembers.
13. **Read the ledger.** Open the **ledger** (top bar): you see the season, day-by-day income, costs and net, contracts and debts, and an **ON-CHAIN RECEIPT** link per settled day that opens the testnet explorer.
14. **Comfort.** **SETTINGS**: music and sound volumes and **REDUCE MOTION** are kept per browser. With reduce motion, stamps still slam and chime, but nothing shakes or freezes.
15. **Production build.** `npm run build`, then start it as production would (PowerShell):
    `$env:NODE_ENV = "production"; $env:GAME_SEASON = "local"; $env:SESSION_SECRET = "a-long-random-string"; $env:DATABASE_URL = "postgres://..."; node apps/server/dist/main.js`.
    Open http://localhost:8787/healthz: you see `{"ok":true,"version":"0.1.0","commit":"...","season":"local",...,"db":{"kind":"postgres","ok":true,...}}`. Without a Postgres at hand, `ALLOW_PGLITE_IN_PRODUCTION=1` with `DATABASE_URL=memory://` checks the build on PGlite (never for players).

## Screenshots and video

| Title | Sign in |
|---|---|
| ![The title plate: the logo stamped in over the farm, PLAY and SETTINGS, the live price ticker](docs/screenshots/title.png) | ![The login panel with the labelled local dev login](docs/screenshots/login.png) |
| **First-run tour** | **Farm** |
| ![The farm's hen talks while the COLLECT card explains clicking eggs into the crate](docs/screenshots/onboarding.png) | ![The farm on day 1: hens, coop, trough, crate, the HUD and the card tray](docs/screenshots/farm.png) |
| **A sale** | **Haggle win** |
| ![The SOLD stamp on the crate card after selling the day's eggs](docs/screenshots/sale.png) | ![The Wholesaler's bulk order flipped to gold with confetti and a SOLD stamp after a counter inside its walk-away price](docs/screenshots/haggle-win.png) |
| **Haggle fail** | **Glut** |
| ![A standing contract stamped DECLINED after the Bakery walked away from an ask far above its price](docs/screenshots/haggle-fail.png) | ![The ticker turned red, MARKET CRASH, and the GLUT WARNING card at 0.72x](docs/screenshots/glut.png) |
| **Rival bust** | **Ledger with receipts** |
| ![Upstart Eggs went bust: its sign tips over and its hens go to auction](docs/screenshots/bust.png) | ![The ledger for the season with an ON-CHAIN RECEIPT link per settled day](docs/screenshots/ledger.png) |
| **Market board** | **Shop** |
| ![Market board over the town square: split-flap ticker with sales against demand, order book, farms ranked with signs, the cast](docs/screenshots/market.png) | ![Listed hens drawn from their trait layers with laying trait and price](docs/screenshots/shop.png) |

Screenshots come from a headless tour of the built game at 1280x720: the real server code in-process with 30-second demo days and live testnet settlement in the season `tour5-20261111`, and the built client in headless Edge, with 0 console errors or warnings. The sale, haggles, glut and receipts happened on their own. The bust was staged: a one-player tour had no natural bust by day 12, so the tour gave the Upstart a 64.80 Loyalist debt falling due that day, and the game's own rules did the rest (collected in full in a glut, below zero, bust). Natural busts are what the simulation shows.

**Video:** _slot for a direct upload (drag the gameplay video into this section on GitHub)._

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI["React shell<br/>cards, haggling, market board,<br/>ledger, anime.js timelines"]
    PX["PixiJS canvas<br/>farm and town square"]
    PV["Privy<br/>email login, silent NEAR wallet"]
  end
  subgraph Server["Game server (Node, authoritative)"]
    WS["WebSocket protocol v2<br/>strict zod schemas, rate limits"]
    GM["Game: day clock, market,<br/>order book, cards, contracts, ledger"]
    AG["Seven agents<br/>rules or model, memory, cash"]
    CW["Chain writer<br/>day batch"]
  end
  DB[("Postgres in production<br/>PGlite locally<br/>one season per database")]
  AI["NEAR AI Cloud<br/>structured JSON decisions"]
  subgraph Testnet["NEAR testnet"]
    GC["game contract<br/>NEP-171 hens, NEP-245 eggs,<br/>settle_day(season, day)"]
    SA["agent sub-accounts<br/>bakery1, upstart1, ..."]
    PW["player wallets<br/>(Privy)"]
  end
  UI <--> WS
  PX --- UI
  PV -- "access token" --> WS
  WS --> GM
  GM <--> DB
  AG -- "orders, offers,<br/>farm actions" --> GM
  AG -- "decide" --> AI
  GM -- "day close" --> CW
  CW -- "settle_day" --> GC
  CW -- "create and fund" --> SA
  GC -. "eggs and hens held by" .-> SA
  GC -. "eggs and hens held by" .-> PW
```

**Where it runs.** One Node process per season serves the built client, the API and the WebSocket on one port; Pier runs it on a Mac behind a Cloudflare tunnel, and Render is the fallback with a restore path between them ([deploy/pier](deploy/pier/README.md), [deploy/render](deploy/render/README.md)).

```mermaid
flowchart LR
  P["Players' browsers"] -- "https and wss" --> CF["Cloudflare tunnel<br/>yolkstreet.25th.dev"]
  subgraph Mac["Pier on the Mac (main)"]
    N["node apps/server/dist/main.js<br/>port 8787, /healthz"]
    PG[("Postgres<br/>season s1")]
    N <--> PG
  end
  CF --> N
  subgraph Render["Render (fallback)"]
    RN["web service<br/>same build and start"]
    RPG[("Postgres 18<br/>private network")]
    RN <--> RPG
  end
  PG -. "scripts/db-backup.ts<br/>daily and before deploys" .-> BK[["pg_dump<br/>backups/coys-time.dump"]]
  BK -. "scripts/db-restore.ts<br/>in an outage" .-> RPG
  N -- "settle_day" --> T["play.coys-game.testnet"]
  RN -. "same season, same contract" .-> T
```

The client never sends a balance or an outcome. It asks for actions; the only prices it sends are proposals (a haggle ask, a limit order) that the server bounds and that an agent or counterparty must accept. The server applies every action in a database transaction and answers with state and events that drive the juice.

## The economy

Every number lives in one object, `ECONOMY` in [`packages/shared/src/economy.ts`](packages/shared/src/economy.ts), including every agent's costs, markups, penalties and thresholds.

**Market price.** One multiplier for every grade's base price (white 1.00, cream 1.20, brown 1.50, golden 6.00), set by the total eggs sold that day by all players and agents (street sales, order fills, card deals, contract deliveries and the wholesaler's resales) against demand $D_d$, which grows with the number of active farms $F_d$ (player farms plus open agents):

$$
m_{d+1} = \operatorname{clamp}\left(\left(\frac{D_d}{S_d}\right)^{0.8},\ 0.40,\ 2.50\right)
\qquad
D_d = 15 \cdot F_d
$$

With two players and the seven agents, $D = 135$: a typical day sits near $1.00$ whether Yolk Street has two farms or twenty. The economy sheet keeps the fixed reference $D = 600$ (at $S = 1300$, $m = 0.54$). The market has crashed when $m \le 0.80$.

**Hen payback.** With base laying $0.80$, feed laying multiplier $f$, breakage $b$, the tier's expected egg price $\bar p$ at multiplier $m$, and feed at $0.12$ kg a day from a 25 kg bag of price $P$:

$$
\text{margin} = 0.80\, f\,(1-b)\,\bar p\, m - \frac{P}{25}\cdot 0.12
\qquad
\text{payback} = \frac{8}{\text{margin}}
$$

On standard feed at $m = 1$: margin $= 0.4624$, payback $= 17.3$ days.

**Feed from the Squeezer.** Its bag price rises with how desperate a farm looks, $\delta \in [0, 1]$ (feed days left weigh most, low cash adds): $P_{sq} = P \cdot (1.05 + 0.5\,\delta)$. The Loyalist takes 2% off per past deal, up to 15%, and offers credit due in 5 days at 8%.

## The agent cast

| Agent | Role | Character (rule policy and haggling) |
|---|---|---|
| **Upstart Eggs** | rival farm | Lives on the Loyalist's feed credit. On a good week (recent closes averaging 1.08x or more) it borrows, puts every coin into hens and packs its coops past capacity; in a glut it dumps its fresh eggs below the Wholesaler's bid. Agents repay credit in full even into the red, so a boom that turns into a glut busts it. Undercuts players to the trader. Haggles loosely. |
| **Old Money Farms** | rival farm | Never panics: below 0.90x it holds half its crate back and sells the lot once the price recovers (a glut of its own), keeps cash, premium feed, buys bust farms' hens at auction. Makes buyout offers to struggling players. Proud: walks away from insulting asks. |
| **The Squeezer** | feed supplier | Reads desperation (low feed, low cash) and prices it in. Barely bends in a haggle. |
| **The Loyalist** | feed supplier | Rewards repeat buyers with discounts and offers credit terms; never extends credit after a default. Bends the most. |
| **Yolk Street Bakery** | egg buyer | Wants steady volume: offers standing contracts and posts daily buy orders. A missed delivery costs a penalty; two cancel the contract and start a sulk. |
| **The Market Trader** | egg buyer | Pays a premium for brown and golden, up to what it resells for in town; walks away from farms whose quality slips; warns of gluts. |
| **The Wholesaler** | egg buyer | Buys anything in bulk at a low price (bulk-order cards sized from a farm's daily lay, standing bids under the market, deeper in a glut), resells it into the street the next day: the same eggs count as supply twice, which drags a glut out. |

Each agent has its own cash, stock and **memory of every farm** (deals, value, refusals, haggles won and lost, missed deliveries, sulks) in Postgres. It decides once per in-game day and pays 0.50 coins per decision from its own cash. Below 40 coins it thinks only every other day, on the cheaper model, so a struggling business visibly gets worse. Below zero it closes: its orders and contracts end, a rival's hens go to auction at half price, and a new agent of the same role opens three days later under a fresh name.

## Systems

<details>
<summary><b>Agent decisions</b>: one shape for rules and the model, always validated</summary>

- Each agent sees a context: its cash and stock, the live market and recent history, auction hens, its own farm (rivals), and a brief of every farm with its memory of it (`apps/server/src/agents/decision.ts`).
- The model gets a role and personality prompt and must answer with the decision JSON schema (`response_format: json_schema, strict`). The reply is parsed and validated with zod; anything else falls back to the rule policy and the fallback is logged and counted.
- The game bounds every number: prices are shares of the live price within bands, quantities are capped by stock and cash, offers only reach real player farms, and every farm action goes through the same validated actions players use.
- Spend cap: `NEARAI_DAILY_SPEND_CAP_USD` per UTC day, tracked from token usage and the model's per-token price (from `/v1/models`). Each call reserves its estimated cost first, so the cap is never crossed; past it, agents use rules until the next day.
- Decisions apply in two phases: farm actions and restock before the market closes (their sales count today), then orders, fills and offers once tomorrow's price is set.

</details>

<details>
<summary><b>Cards and haggling</b>: 2 to 4 a day, never scripted</summary>

- Agents' offers become cards (bulk order, premium order, standing contract, feed deal, credit terms, undercut, buyout offer, glut warning), plus player trade cards from other players' sell orders. At most one per agent and four per player per day, arriving at 12%, 30%, 48% and 64% of the day.
- Choices: accept, decline, counter, and the card's own options (switch supplier, match price, sell now or hold, sell hens).
- A counter is a proposal. The agent accepts any ask inside its hidden walk-away price; otherwise it concedes part of the gap (its personality's concession), and walks away after three rounds, or at once from an insulting ask if it is proud. The walk-away price comes from personality and memory: regulars get more room, farms that won haggles get less, missed deliveries cost room.
- The sales clerk auto-accepts bulk and premium orders at or above the player's floor; the delivery cart delivers standing contracts at dusk.

</details>

<details>
<summary><b>Order book</b></summary>

- Buyer agents post buy orders each day; farms post limit sells (the eggs leave the crate into the order and come back if it expires after 3 days). Orders cross at the resting price, best price first.
- Players sell into buy orders, buy each other's eggs (also offered as player trade cards), and cancel their own orders. Every fill is a trade on the market board and counts as supply.

</details>

<details>
<summary><b>Chain</b>: one contract, one call a day</summary>

- `contracts/coys-game` (Rust, `near-sdk` 5.30.1): NEP-171 hens from `near-contract-standards`, NEP-245 eggs from `near-sdk-contract-tools` (`Nep245` derive without per-account storage fees, so holders need no deposit; the contract pays storage), `Owner` access control, and `settle_day`.
- `settle_day(batch)`: owner only; within a season, days strictly in order and each once. It mints, transfers and burns egg tokens, mints hens with their metadata, moves hens that changed hands, stores the day's summary and digest under (season, day), and emits a `day_settled` event with the season.
- **Seasons**: a season is one game world from day 1, and one database holds one season (`GAME_SEASON`). A new season starts again at day 1 on the same contract while repeats within a season are refused; a server pointed at another season's database refuses to start. Version 1 settled days without seasons; `migrate` upgrades it in place and files those days under `legacy` (done on `coys-game.testnet`).
- The batch (`apps/server/src/chain/batch.ts`): the day's trades between holders become egg transfers; then every account is reconciled to what it really holds (crate plus open sell orders, or a buyer's stock) with mints and burns, starting from the balances last confirmed on chain. A failed day is caught up by the next, and no burn exceeds a balance. Every farm's net result travels in the call with a SHA-256 digest.
- **Hen images**: the stacked trait layers are rendered once at mint into a 32x32 PNG (about 1 KB) and stored in the token metadata as a data URI with its `media_hash`. Why: it is the simplest correct storage. The token is self-contained and verifiable from the chain alone, with no image host, pinning service or URL to keep alive, and a 1 KB portrait costs about 0.01 NEAR of storage. Mints are capped per day (`CHAIN_HEN_MINTS_PER_DAY`, default 12) and wait when the game account runs low.
- **Agent wallets**: sub-accounts of the game account, funded from it (`AGENT_ACCOUNT_FUNDING_NEAR`, default 0.05), with keys derived from the game key by HMAC so no extra secret is stored.
- **Players**: the Privy wallet holds their hens and eggs. Minting and transfers happen only in the day batch, never per click.
- Testnet only, enforced in code before any key is used: accounts must be `.testnet` (or implicit), RPC hosts must be testnet, and the RPC's `chain_id` must say `testnet` before anything is signed. Without credentials, every day's batch is built the same way and logged as a NO-OP.
- **Deliveries on chain**: a contract delivery is a trade from the player's wallet to the Bakery's sub-account, so the day's batch moves the eggs as NEP-245 tokens between them (then burns them when the Bakery bakes). Proven on testnet (receipt above), in a dedicated test, and in every seed of the simulation.
- Tests: 8 contract unit tests and 5 **sandbox tests** (`contracts/sandbox-tests`, near-workspaces 0.24): a full day settlement, holder transfers, only the game can settle or mint, a new season settling day 1 after an old season ended at day 3, and the version 1 wasm (kept in `contracts/sandbox-tests/res`) upgrading in place. They run in CI (Linux); the wasm CI builds is what gets deployed (`npm run deploy-contract` checks its sha256, testnet only, see [deploy/testnet.md](deploy/testnet.md)).

</details>

<details>
<summary><b>Server</b>: authoritative, transactional, reconnect safe</summary>

- `apps/server`: Node, `ws`, `pg` and PGlite behind one `Db` interface. `DATABASE_URL=postgres://...` uses Postgres; `pglite://<dir>` (default `.data/coys`) or `memory://` uses embedded PGlite for local play and tests. Production (`NODE_ENV=production`) refuses PGlite and requires `GAME_SEASON` and `SESSION_SECRET`.
- Migrations run on every boot and are safe to repeat; on Postgres they run in one transaction under an advisory lock, so two instances booting together cannot race (tested on real Postgres in CI). v1 (clock, market days, players, farms, coops, hens, unlocks, lay events, orders, ledger), v2 (agents, memory, cards, contracts, debts, order book fields, trades, inference usage, confirmed chain balances), v3 (each day's demand), v4 (seasons on the clock, market days and every ledger row; market days keyed by season and day).
- `/healthz` (and `/api/health`) reports the version and commit baked in at build time, the season, the day and a timed database round trip; it answers 503 when the database does not.
- `DEMO_DAY_SECONDS` (20 to 3600) shortens the in-game day for recording; production ignores it unless `DEMO_MODE=1`. The client takes the day length from the server clock.
- Backups: `scripts/db-backup.ts` (pg_dump to `backups/coys-<UTC time>.dump`) and `scripts/db-restore.ts` (pg_restore in one transaction, stops at the first error); the password reaches the tools as an environment variable, never on a command line. CI round-trips a backup between two Postgres databases.
- Every farm cash change writes the balance and a ledger row in the same transaction; tests check the ledger total equals cash, for players and rival farms, across a 30-day simulation.
- Mutations run one at a time; messages go out only after commit. Strict zod schemas reject any extra field. Per-player rate limits, reconnect-safe request ids.

</details>

<details>
<summary><b>Client</b>: screens, juice and sound</summary>

- 640x360, scaled by a whole number, nearest-neighbour everywhere. PixiJS draws the farm and the town square; anime.js drives every UI motion.
- **Card overlay**: slides in with an overshoot and a paper swoosh; the portrait talks with its voice babble while the line types out; outcomes play the agent's expression and slam a stamp; a haggle win flips the card to gold with a hitstop, shake, confetti and the win chime; a fail sends the agent walking with the fail sound.
- **Market board**: town square plate with animated bunting and a milling crowd (market murmur loop), split-flap ticker board by grade, farms ranked with their signs, the cast, big trades, the order book.
- **Ledger**: day-by-day profit, contracts, debts, and the on-chain receipt link per day.
- **Shop**: listed hens drawn from their trait layers with laying trait and price (auction hens marked), feed with supplier switching, coops, machines.
- **Rival bust**: the sign tips over, a price wave crosses the ticker, medium shake, falling feathers, the collapse crash and the bust sting. **Glut**: the ticker drops red and the market tension music plays until prices recover.
- **First-run tour**: three cards told by the farm's own hen (collecting, selling, decision cards), with the offer cards' art and swing-in; skippable and shown once per browser. Offer cards wait until it closes, and an unanswered card closes with its day.
- **Page**: descriptive title and meta description, a favicon and a 1200x630 share image cut from the sprites by `scripts/make-share-images.ts`.
- Everything from brief 1 stays: lays, hand collect, big haul, deal stamp, coop builds, unlocks, crash, new day.

</details>

<details>
<summary><b>Simulation</b>: 30 in-game days, five seeds, seven agents and two headless players</summary>

`apps/server/test/sim.test.ts` runs the whole market for 30 days on five fixed seeds. The stub model answers each agent's own in-character decision as JSON on most calls and garbage on every fourth, under a 0.25 USD cap; both headless players have wallets, and every day settles through a recording chain writer that builds the real batch. The test checks, per seed: the median day's multiplier is between 0.80 and 1.30, at least one day falls to 0.80 or below, contract eggs move on chain to the Bakery's wallet, the spend cap holds, and ledgers equal cash; and a rival busts naturally in at least three of the five seeds.

| Seed | Median day | Lowest day | Days at 0.80x or below | Rival bust | Contracts (signed, delivered, missed) | Bakery contract eggs moved on chain | Wholesaler resold | Model calls, fallbacks, spend (cap 0.25 USD) |
|---|---|---|---|---|---|---|---|---|
| 1 | 1.10x | 0.67x | 11 | Upstart Eggs, day 25 | 8, 50, 8 | 103 | 168 | 66, 154, 0.2424 USD |
| 2 | 1.08x | 0.66x | 10 | Upstart Eggs, day 15 | 9, 36, 13 | 78 | 231 | 64, 157, 0.2416 USD |
| 3 | 1.07x | 0.65x | 10 | Upstart Eggs, day 17 | 8, 37, 9 | 89 | 205 | 65, 156, 0.2420 USD |
| 4 | 1.10x | 0.66x | 11 | Upstart Eggs, day 15 | 9, 35, 13 | 94 | 239 | 64, 157, 0.2416 USD |
| 5 | 1.16x | 0.64x | 10 | Upstart Eggs, day 15 | 8, 39, 9 | 101 | 189 | 63, 158, 0.2412 USD |

Demand is 135 a day (two players and seven agents) and drops to 120 while a bust rival's successor is waiting to open. Seed 1, day by day (supply of demand, then the multiplier it set): days 6 to 18 swing between about 220 and 90 eggs as Old Money holds half its crate below 0.90x and releases it on the recovery, so the price alternates between roughly 1.3x and 0.7x; the Upstart's cash runs 12, 80, 104, 36, 121 and it busts on day 25 when its feed credit falls due in a glut. The only 2.50x day is day 2, after a first day with no sales. Hen and order ids are random, so the exact numbers move a little between runs; the acceptance holds on every run.

The companion test forces a glut on Upstart Eggs (no cash, empty trough, crashed market): it goes bust on day 2, its hens go to auction, and Hatch and Dash opens as the new rival on day 5.

</details>

<details>
<summary><b>Asset pipeline</b>: verified, byte for byte</summary>

- `npm run pack-assets` checks all 375 manifest files of `iam25th1/coys-assets` against their SHA-256 and packs 67 sprite sheets (PixiJS JSON with rows, per-frame durations and anchors) and 59 sounds (124 MP3 takes, 12 gapless loop OGGs). PNG, MP3 and OGG files are copied byte for byte.
- Hen trait layers match `01-hen-anims` frame for frame; brown and black bodies are palette swaps in code. The server renders hen NFT portraits with the same passes.

</details>

<details>
<summary><b>Security</b></summary>

- No secrets in the repo or the client bundle: `.env` is ignored; `.env.example` names and describes every variable with no values; the client reads only the public Privy app id from `/api/config`; the built bundle is grepped for key-like strings.
- The model key, the testnet key and agent keys live only on the server. Testnet only, enforced in code.
- Every dependency pinned exactly; installed with `npm ci --ignore-scripts` locally and in CI; Rust crates pinned with `Cargo.lock` and built `--locked`; cargo-near checksum-verified in CI.

</details>

## Environment variables

All optional for local play. Copy `.env.example` to `.env` at the repo root. Production needs `NODE_ENV=production`, `GAME_SEASON`, `SESSION_SECRET` and a Postgres `DATABASE_URL` ([deploy/pier](deploy/pier/README.md) lists every variable).

| Variable | Used by | Without it |
|---|---|---|
| `NODE_ENV` | server | local play rules (PGlite allowed, demo days allowed) |
| `PORT`, `DATABASE_URL`, `SESSION_SECRET` | server | 8787; PGlite at `.data/coys`; a random secret per boot |
| `HOST` | server | listens on every interface |
| `GAME_SEASON` | server | a fresh database makes its own `dev-...` season; an existing one keeps its own |
| `DEMO_DAY_SECONDS`, `DEMO_MODE` | server | 180-second days; `DEMO_MODE=1` lets a production server use demo days |
| `ALLOW_PGLITE_IN_PRODUCTION` | server | production refuses PGlite (set only to check a build) |
| `ALLOW_DEV_LOGIN` | server | dev login only when Privy is not set up |
| `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | server, client (via `/api/config`) | labelled local dev login |
| `NEAR_TESTNET_ACCOUNT_ID`, `NEAR_TESTNET_PRIVATE_KEY` | server, deploy script | daily settlement is a recorded NO-OP |
| `NEAR_TESTNET_RPC_URL`, `NEAR_GAME_CONTRACT_ID` | server | `https://test.rpc.fastnear.com`; the signing account |
| `CHAIN_HEN_MINTS_PER_DAY`, `CHAIN_MIN_BALANCE_NEAR`, `AGENT_ACCOUNT_FUNDING_NEAR` | server | 12; 2; 0.05 |
| `NEARAI_API_KEY`, `NEARAI_BASE_URL`, `NEARAI_MODEL`, `NEARAI_CHEAP_MODEL` | server | agents use their rule policies |
| `NEARAI_DAILY_SPEND_CAP_USD` | server | 1.00 |
| `ASSETS_DIR` | `npm run pack-assets` | required to re-pack |

## Commands

| Command | Does |
|---|---|
| `npm ci --ignore-scripts` | install from the lockfile, no install scripts |
| `npm run dev` | server (port 8787) and client (Vite, port 5173) |
| `npm test` | Vitest: economy, agents, haggling, market, chain batch, simulation, WebSocket, packer, pixel passes |
| `npm run typecheck` / `npm run lint` | strict TypeScript; ESLint plus a check that no file holds an em dash |
| `npm run build` / `npm start` | bundle the server and client; serve both on one port |
| `npm run deploy-contract -- --wasm <file> --account <id.testnet> [--create] [--migrate]` | deploy a CI-built contract to a testnet account (sha256 checked, mainnet refused; see [deploy/testnet.md](deploy/testnet.md)) |
| `npx tsx scripts/db-backup.ts` / `scripts/db-restore.ts` | back up the Postgres database to `backups/`, or restore a dump into another (see [deploy/pier](deploy/pier/README.md)) |
| `npx tsx scripts/make-share-images.ts` | cut the favicon and the share image from the sprites |
| `cd contracts/coys-game && cargo test` | contract unit tests (CI also runs `cargo near build` and the sandbox tests) |

## Repository layout

```
apps/client          Vite + React shell + PixiJS world + anime.js motion + Web Audio
apps/server          game server: HTTP, WebSocket, game, agents, cards, market, chain, db
packages/shared      economy config and formulas, agent pricing, protocol, pixel passes
contracts/coys-game  the game contract (Rust); res/ holds the CI-built wasm and its sha256
contracts/sandbox-tests  near-workspaces sandbox tests for the contract (res/ holds the version 1 wasm)
scripts              asset packer, dev runner, text check, testnet deploy, backups, share images
deploy               Pier and Render settings, testnet contract accounts and seasons
render.yaml          Render Blueprint (fallback host)
docs/screenshots     headless captures of this build
docs/submission      drafts: demo shot list, post drafts, form fields
```

## What is stubbed, and why

- **Contract builds run in CI, not on this Windows machine**: Windows Application Control blocks the unsigned build scripts cargo compiles, so the contract is built and sandbox-tested on Linux in CI, and the deployed wasm is the CI artifact (its sha256 is committed and checked by the deploy script).
- **Privy end to end** needs a real browser and inbox; the server and client sides are wired and tested headlessly up to the token check.
- **NEAR AI decisions** need credits on the NEAR AI account (it answers 402 without them); until then every agent runs on its rule policy, which is also what the model is held to.
- **Player credit default** is remembered and blocks further credit, but a player is never pushed below zero; agents always repay in full.
- **Hen NFT mints are capped per day** to keep gas and the game account's storage in check; older hens catch up on later days.
- **The live deploy** (Pier on the Mac, the tunnel, Render) is set up from [deploy/](deploy/); it is not run from this repository.

## Verification

On a fresh clone: `npm ci --ignore-scripts`, then typecheck, lint, test and build all pass. CI is green: the TypeScript job (with PostgreSQL 16: the Postgres tests, the production build booting against Postgres with `/healthz` checked, and a backup restored into a second database) and the contracts job (unit tests, `cargo near build`, sandbox tests). The economy sheet tests hit their values exactly; the five-seed simulation meets the economy acceptance; a malformed model answer falls back to rules; a new season settles day 1 after an old season ended at day 3; non-game accounts cannot mint or settle; two real WebSocket clients see the same prices and each other's trades; no secrets in the repo or bundle; no file has an em dash.

The live Pier deploy and its tunnel were checked end to end on 11 November 2026 (receipts under [How NEAR fits in](#how-near-fits-in)).

**Not verifiable headlessly:** a Render deploy, Privy login on the live domain, NEAR AI decisions without credits, how haggling and cards feel, whether portraits and voices read right, and how the market evolves over weeks of real play.

## Build log

### Brief 3: deploy, polish and submission prep (11 November 2026)

- Economy tension: demand scales with active farms (15 per farm), so a typical day sits near 1.00x; the Upstart lives on feed credit and booms into busts, Old Money hoards and releases, the Wholesaler resells into gluts. Accepted on five seeds of the 30-day simulation.
- Season-safe settlement: the contract keys days by (season, day), upgraded in place on testnet with version 1 days kept as `legacy`; one season per database, on every ledger row.
- A Bakery contract delivery proven on testnet: egg tokens from the player's wallet to `bakery1.coys-game.testnet`.
- Deploy readiness: `/healthz`, production checks, Postgres migrations under an advisory lock, demo days, backups and restore, Pier and Render settings, a testnet-only deploy script; CI runs Postgres, the production boot and a backup round trip.
- Polish: first-run tour, favicon and share image, page meta, stale cards closed at the day's end; screenshots from a headless tour of the built game with live testnet receipts.
- Submission drafts in `docs/submission`.

### Brief 2: agents, cards and chain (11 November 2026)

- Seven agents with personalities, memory, cash and wallets; decisions on NEAR AI Cloud as structured JSON with rule fallbacks, a hard daily spend cap, struggling agents on a cheaper model every other day, busts and replacements.
- Decision cards with three-round haggling, standing contracts and deliveries, feed credit, the sales clerk, a real order book and player-to-player trades.
- Screens: card overlay with talking portraits and voices, market board over the town square, ledger with on-chain receipts, a shop of hens with visible traits.
- Juice: card arrivals, haggle win and fail, rival bust (sign, price wave, feathers), glut music.
- Chain: one game contract on NEAR testnet (NEP-171 hens, NEP-245 eggs, daily `settle_day`), sandbox-tested in CI and deployed; agent sub-account wallets; hen portraits rendered at mint.
- A 30-day simulation and a rival-bust scenario in the test suite.

### Brief 1: foundation and farm loop (11 November 2026)

- Merged the asset backup (coys-assets PR #1) and packed 67 sheets and 59 sounds from it, byte for byte.
- Monorepo: client, server and shared packages; strict TypeScript, ESLint, Vitest; pinned dependencies; CI on `npm ci --ignore-scripts`.
- Economy in one config object, tested against the sheet (0.46 margin, 17.3-day payback, 0.54 multiplier at 1300, day 16 coop fill).
- Authoritative server on Postgres or PGlite: day clock, shared market, order book, ledger, strict protocol, rate limits, reconnect-safe request ids.
- Privy email login with a silent NEAR testnet wallet, and a labelled dev login fallback.
- Designed screens with real art: loading, title, login, farm, settings; the full farm loop with juice and sound on every action.
