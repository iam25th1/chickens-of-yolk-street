<p align="center"><img src=".github/header.svg" alt="Chickens of Yolk Street: an animated pixel farm with walking hens, a dropping egg and a scrolling egg price ticker" width="100%"></p>

# Chickens of Yolk Street

Run an egg farm in **one shared live market** where every rival, supplier and buyer is an AI agent with its own cash, memory and wallet. Egg prices, gluts and bankruptcies come only from what everyone trades, never from a script. Built at NEAR HACKATHON (tracks: games, agents, NFTs), 1 to 14 November 2026.

**Play:** https://yolkstreet.25th.dev (live on NEAR testnet, season `s1`; how it is hosted: [deploy/pier](deploy/pier/README.md))

| | |
|---|---|
| **Play loop** | Hens lay on a schedule; you collect, sell, buy hens, feed, coops and machines. One in-game day is 3 real minutes, and each day brings 2 to 4 decision cards from the agents. Everything on the farm is clickable; a first-run tour walks the loop by doing it, then a chain of goals pays coins for learning the rest. |
| **Market** | One price multiplier for everyone, set by the whole market's daily supply against demand that grows with the number of farms. Instant street sales, a real order book with limit orders, and player-to-player trades. |
| **Agents** | Seven: two rival farms, two feed suppliers, three egg buyers. Each decides once a day on NEAR AI Cloud (structured JSON output) or its rule policy, pays for its thinking, remembers every deal, haggles in character, borrows, and can go bust. |
| **Chain** | Only **777 Founding Hens** will ever exist: NEP-171 NFTs won at milestones, capped on chain. Eggs are NEP-245 tokens, and each day settles in one call on NEAR testnet, keyed by season and day. Agents hold sub-account wallets. Players sign in with email; their wallet is made silently. No crypto words in the game: one "on-chain receipt" link in the ledger. |
| **Feel** | Squash and stretch, hitstop, screen shake, particles and layered sound on every action, portraits that talk with voice babble, and a reduce-motion switch. |

## The problem

Farm games fake their economies: prices follow a curve someone wrote, rivals are scripts, and nothing a player does moves the market. On-chain games often go the other way and lead with wallets and tokens, so the game is buried under the plumbing.

Chickens of Yolk Street puts a **real, shared economy** in a toy you can play with one hand. Every egg anyone sells (players and AI agents alike) is supply in the same market. Sell too many and everyone's price falls. NPCs are businesses with wallets: the Squeezer prices your hunger into your feed, the Bakery holds you to your contract, and a rival that overbuilds goes bust and its hens go to auction. The economy evolves without a dev patch, and the chain keeps an honest record of each day while staying out of sight.

## How NEAR fits in

NEAR tools used: **Privy social login** (email, with a silent NEAR wallet), **NEAR AI Cloud** (agent decisions), **NEP-171** hen NFTs, **NEP-245** egg tokens, **sub-account agent wallets**, and **batched testnet settlement** (one call per in-game day).

| NEAR piece | What it does here | Status in this build |
|---|---|---|
| **Game contract on testnet** (`near-sdk` 5.30.1) | One contract on the game account: Founding Hen NFTs (NEP-171, `near-contract-standards` 5.30.1, 777 ever, capped on chain from version 3), egg tokens (NEP-245, `near-sdk-contract-tools` 4.0.0 from the near org), and `settle_day`, owner only, once per in-game day of a season. | **Live** on `coys-game.testnet`, upgraded in place to the season-aware version (tx [`HXYRgKDn...`](https://testnet.nearblocks.io/txns/HXYRgKDnKS7TveYSwDHQp31nsNtzx2jnw64F2hUA39Cf)). Wasm built in CI with `cargo near`, sha256 `fc7645dc...`. Production gets its own account ([deploy/testnet.md](deploy/testnet.md)). Version 3 (the Founding Hens, sha256 `9bc8bfba...`) is built and tested and waits for a top-up to be deployed (Build log, brief 6). |
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
state. Waiting on a top-up: on 12 November at 15:59 UTC `play.coys-game.testnet` held 0.658 NEAR available, and
its own settlements cost about 1.06 NEAR a real day (179 bytes and 0.0004 NEAR of gas per 3-minute day). Until it is
topped up, the Founding Hens contract upgrade waits (0.614 NEAR short of the reserve, Build log brief 6), won Founding
Hens wait to be minted, the seven agent wallets wait to be linked, and the market state reports minting as `paused`
with honest wording on every hen's card.

## Try it

Node 22.22.2 or newer (CI and the deploy docs use 24.22.3). Each step says what to do and what you should see. Commands are the same in PowerShell and a POSIX shell unless shown otherwise.

1. **Install.** Run `npm ci --ignore-scripts`. You see the lockfile install with no package install scripts (`.npmrc` also sets `ignore-scripts=true`).
2. **Test.** Run `npm test`. On a fresh clone you see **282 tests pass and 3 skip**: the 2 Postgres tests need `TEST_DATABASE_URL` (CI sets it), and the asset re-pack check needs a coys-assets checkout beside the repo. Among them: the economy sheet (margin **0.46**, payback **17.3** days, multiplier **0.54** at 1300 supply against the fixed 600 reference, a 30-hen coop **full on day 16**), the five-seed 30-day market simulation, haggling, model fallbacks, seasons, the chain batch with a contract delivery moving tokens to the Bakery, `/healthz`, two real WebSocket clients in one market, and every frame of every derived animation (no blank frame, no neighbouring row, atlases up to date).
3. **Play.** Run `npm run dev` and open http://localhost:5173. You see an egg fill up over the loading plate, then the title: the logo stamps in and the price ticker scrolls.
4. **Sign in.** Press **PLAY**. With `PRIVY_APP_ID` set you sign in with email; without it a red **LOCAL DEV LOGIN** label asks for a name. You see your farm: 10 hens, a starter coop, **50.00** coins, **DAY001**.
5. **Take the tour.** The first time you enter your farm the tour starts on its own: your hen walks you through the loop by doing it (collect an egg, sell, the market, feed, an offer, a hen, machines, rivals, the ledger). Each step ends when you do the thing; **SKIP** ends it, and it never comes back unless you press **REPLAY THE TOUR** in **SETTINGS**. After it, the goal in the corner shows what to aim for next, with a **CLAIM** button and coins when you reach it. The **?** in the top bar opens **HOW TO PLAY**, the guide to everything.
6. **Collect and sell.** Click an egg a hen just laid: you see it pop into the crate, **COLLECT** in the top bar drops by one and **SELL** rises by one. Click the crate (or press **SELL N EGGS** on the card): a **SOLD** stamp slams and coins arc to the counter. Click anything else on the farm (a hen, the trough, a coop, the farmhouse, the sign, a machine) to open its card.
7. **Meet the agents.** From day 2 cards slide in: a portrait talks in its own voice while its line types out (the Bakery offering a standing contract, the Wholesaler a bulk order, the Squeezer a feed deal). Press **ACCEPT**: you see the right stamp slam.
8. **Win a haggle.** On a buyer's card, press **-** a few times so **YOUR PRICE** sits just above the offer, then **COUNTER**. You see the card flip to gold with confetti and the win chime (inside the agent's walk-away price).
9. **Lose one.** On another card, press **+** many times and **COUNTER**. You see the agent counter, get cross, and after three rounds (or at once, if it is proud) walk off with the fail sound.
10. **Sell into a glut.** Speed days up: `DEMO_DAY_SECONDS=30` before `npm run dev` (PowerShell: `$env:DEMO_DAY_SECONDS = "30"; npm run dev`). Open the **market board**: you see **SOLD n OF d**, today's sales against demand. When a day's supply runs well past demand (Old Money releasing its hoard, the Wholesaler reselling), you see the next multiplier fall, the ticker turn red at 0.80 or lower, the **GLUT WARNING** card in the tray, and the tension music take over.
11. **Watch a rival bust.** The Upstart borrows feed from the Loyalist to grow on good weeks. When a glut meets its debt, it goes below zero: you see its sign tip over, a price wave cross the ticker, feathers fall, and its hens appear in the shop as **AUCTION** hens at half price; a new rival opens three days later. At 30-second days this usually happens 8 to 14 minutes into a season.
12. **Deliver a contract.** Accept the Bakery's contract, then press **DELIVER** on the desk each day (or buy the delivery cart: it delivers at dusk). You see coins arrive; with testnet credentials the day's batch moves those egg tokens to the Bakery's wallet. Miss one and you pay a penalty and the Bakery remembers.
13. **Read the ledger.** Open the **ledger** (top bar): you see the season, day-by-day income, costs and net, contracts and debts, and an **ON-CHAIN RECEIPT** link per settled day that opens the testnet explorer.
14. **Comfort.** **SETTINGS**: a volume and a mute for each of twelve sound groups (master, music, ambience, hens, eggs and money, cards and stamps, haggling, machines, market and rivals, agent voices, buttons, new day and stings), a reset button, and **REDUCE MOTION**, kept per browser. Each change applies at once and plays a sample. With reduce motion, stamps still slam and chime, but nothing shakes or freezes.
15. **Win a Founding Hen.** Reach a milestone in good standing (fill your coops, sell 500 eggs, win 10 haggles...). At the day close you get one roll at 30%: a win puts a Founding Hen on your farm, and the next day close records her on NEAR with a certificate. A miss says so kindly and names the next milestone. The ledger lists them all.
16. **Production build.** `npm run build`, then start it as production would (PowerShell):
    `$env:NODE_ENV = "production"; $env:GAME_SEASON = "local"; $env:SESSION_SECRET = "a-long-random-string"; $env:DATABASE_URL = "postgres://..."; node apps/server/dist/main.js`.
    Open http://localhost:8787/healthz: you see `{"ok":true,"version":"0.1.0","commit":"...","season":"local",...,"db":{"kind":"postgres","ok":true,...}}`. Without a Postgres at hand, `ALLOW_PGLITE_IN_PRODUCTION=1` with `DATABASE_URL=memory://` checks the build on PGlite (never for players).

## Screenshots and video

The live site on 12 November 2026 after the visual-quality pass (season `s1`), from fresh headless browsers through the
tunnel. The farm at every listed size, UI drawn at whole device pixels:

| 1280x720 | 1920x1080 |
|---|---|
| ![The farm at 1280x720: top bar, the whole farm in the free area, the crate's sell card and waiting cards in the side panel, a hint above the goal tracker bottom left](docs/screenshots/live-1280x720.png) | ![The farm at 1920x1080: three device pixels per world pixel, a crate hint above the goal tracker, one card waiting](docs/screenshots/live-1920x1080.png) |
| **2560x1440 at 2x (5120x2880 device pixels)** | **390x844 (phone)** |
| ![The farm at 2560x1440 on a 2x screen: eight device pixels per UI pixel and full-detail painted hens](docs/screenshots/live-2560x1440@2x.png) | ![The phone layout: the top bar on two rows, the farm across the width, the goal tracker under it, the sell card and the card list below](docs/screenshots/live-390x844.png) |

The tour and the modals, at 1280x720. The market board shows the temporary check farms the verification used (removed afterwards):

| Tour step 1: collect | Tour step 4: gluts |
|---|---|
| ![The spotlight dims everything but an egg on the ground, tagged TAP THE EGG; the step box reads 1/10 COLLECT AN EGG with progress dots, BACK and SKIP](docs/screenshots/live-tour-collect.png) | ![The market board open, the supply meter spotlit with TAP THE METER; the step box explains gluts and shortages](docs/screenshots/live-tour-glut.png) |
| **A card, composed** | **Market board** |
| ![The Wholesaler's bulk order as one panel: portrait and line on top, what accepting means, the card art upright beside it, the answers in one row](docs/screenshots/live-card.png) | ![Today's price per grade on split flaps, the street's sales against what it needs, and the farms ranked with the bust ones](docs/screenshots/live-board.png) |
| **Shop** | **A hen's card** |
| ![The shop's hens: each one of a kind, drawn from her trait layers at full detail, with how she lays and her price](docs/screenshots/live-shop.png) | ![A hen's portrait at twice her farm size, her traits in words, and her certificate: pending while recording on NEAR is paused](docs/screenshots/live-hen.png) |
| **Feed** | **Ledger** |
| ![Feed tiers with how each changes laying, buy now or on the Loyalist's credit, and the supplier switch](docs/screenshots/live-feed.png) | ![The ledger: each day's coins in and out with its record on NEAR, contracts and debts, and hen certificates](docs/screenshots/live-ledger.png) |

<details>
<summary><b>The earlier build (11 November): title, tour, sale, haggles, glut, bust, ledger, market, shop</b></summary>

<br>

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

</details>

**Video:** _slot for a direct upload (drag the gameplay video into this section on GitHub)._

## Founding Hens, machines at work, sound and a guide (12 November 2026)

**Founding Hens.** Regular hens are no longer minted. Only **777 Founding Hens** will ever exist, a cap the contract
itself enforces. A farm in good standing gets one roll at each of seven milestones, once; a win puts a Founding Hen on
the farm and the next day close mints her on NEAR with her portrait, traits, milestone, season, day and her number of 777.
Everything about it, including how to audit a roll, is in [docs/founding-hens.md](docs/founding-hens.md); the mainnet
path is a written checklist, [docs/mainnet-checklist.md](docs/mainnet-checklist.md), with no mainnet action taken.

| Milestone | Reached when |
|---|---|
| First full coop | the coops are full for the first time |
| A good week | 7 day closes in a row in good standing |
| 500 eggs sold | street, orders, cards and contracts all count |
| 10 haggles won | countered by hand and won |
| All five machines | conveyor, grader, cart, hopper and clerk |
| Outlast a rival | a rival farm goes bust after yours opened |
| Top three | a day ends with the farm in the board's top 3 |

Good standing: never bust this season, no feed credit unpaid past its due day lately, no contract delivery missed in the
last 3 days. Each roll is made on the server from a seed fixed by a public record written before it:

$$
\text{roll} = \frac{\big\lfloor \mathrm{SHA256}(\texttt{coys-founding}\,|\,\text{season}\,|\,\text{day}\,|\,\text{farm}\,|\,\text{milestone}\,|\,\text{previous settlement tx}) \,/\, 2^{204} \big\rfloor}{2^{52}}, \qquad \text{won} \iff \text{roll} < 0.3
$$

Every roll is stored with its inputs and logged, at most one hen per milestone, and rolls stop at 777 (minted plus
waiting). A missed roll gets a kind message naming the next milestone. The market board shows how many of the 777 are
left; the ledger lists certificates, milestones and good standing.

**Contract version 3** (`contracts/coys-game`): `settle_day` takes `founding_mints` and refuses ordinary `hen_mints`;
`FOUNDING_MAX = 777` is a `require!` on chain; `founding_supply()` reports minted, max and remaining; `migrate()`
upgrades version 2 in place. 11 unit tests and 6 sandbox tests on the CI-built wasm, among them **mint 777 then refuse
the 778th**, and an upgrade of the exact code running on `play.coys-game.testnet` (read with `view_code`). The testnet
upgrade waits for funds: see the Build log, brief 6.

**The farm.** Coop doors stay shut at rest, swing once when a hen goes in or out, and creak now and then. The world draws
in a fixed layer order (ground, animated ground, floor, things sorted by their feet, labels, effects), which ended the
straw tile that cut the belt and the doors that flapped with the idle loop. The farm fills the whole free window: the
yard takes at least half its width, hens spread out, one unbroken conveyor runs along the bottom into the crate, and one
fence runs the full width with a gate where the path leaves.

| Machine | Size (world px) | Spot | What it does now, every day |
|---|---|---|---|
| Conveyor | 16 px belt tiles, one continuous run | along the bottom of the yard into the crate | carries each egg to the crate 5 s after it is laid; 2% breakage instead of 5%; counts the eggs it saved |
| Egg grader | 48x48 | beside the crate, at the belt's end | flashes as it sorts; +10% on every egg, shown in the sell panel |
| Delivery cart | 48x48 | parked by the crate on the path | drives down the path through the gate and back when it delivers a contract |
| Feed hopper | 48x72 | beside the trough | refills the trough at day close below 1.5 days of feed, up to a price cap you set; 10% cheaper, in the ledger |
| Sales clerk | 48x48 | at a desk on the strip right of the path | stamps the offers it takes on its own; +5% on sales |

Each machine has a name plate and a pad, rises in with a ring when bought, and its card says what it did today. The rival
signs are back on the board and at the farm's edge: they sway, and tip over when a rival busts. The tour's hen talks
again in the hen step.

**Sound settings.** Twelve sliders, each with a mute: master, music, ambience, hens, eggs and money, cards and stamps,
haggling, machines, market and rivals, agent voices, buttons, and new day and stings. Every one of the game's 59 sounds
belongs to exactly one (a test checks it). Changes apply at once, a sample plays on release, settings persist per
browser, and a reset button restores the defaults.

**How to play.** A guide in eleven sections, each with a picture from the game's own art: the goal, your day, eggs and the
crate, the shared market, feed and laying, offers and haggling and contracts, machines, rivals and busts, Founding Hens,
milestones, and a glossary. It opens from Settings and from the **?** in the top bar.

**Beta.** A BETA tag on the title logo, in the top bar and in the page title. The first-run tour now starts for every new
player on their first farm entry with no click, and never again unless replayed: the server remembers it per player
(`tourDone`), and the browser remembers it too.

**Checked live** on 12 November 2026 (commit `c48d2f2`), from fresh headless browsers through the tunnel, with five
temporary check farms made through the game's own `ensurePlayer` and removed afterwards (`scripts/remove-player.ts`,
service stopped; no trades with anyone). One check farm owned all five machines.

| 1280x720 | 1920x1080 |
|---|---|
| ![The farm at 1280x720: coop door shut, one belt along the bottom into the grader and crate, the fence along the bottom with a gate on the path, every machine on its pad with a name plate, BETA in the top bar](docs/screenshots/founders-farm-1280x720.png) | ![The farm at 1920x1080: the yard across most of the width, hens spread out, the hopper by the trough, the clerk at its desk right of the path, the cart by the crate](docs/screenshots/founders-farm-1920x1080.png) |
| **2560x1440** | **390x844 (phone)** |
| ![The farm at 2560x1440: the same composition at four device pixels a world pixel](docs/screenshots/founders-farm-2560x1440.png) | ![The phone: the farm across the width and most of the height, the guide and the side panel below](docs/screenshots/founders-farm-390x844.png) |

| First-run tour, no click, 1280x720 | First-run tour, 390x844 | Title with BETA |
|---|---|---|
| ![A brand-new player's first farm entry: the tour's first step is up at once, the spotlight on an egg](docs/screenshots/founders-tour-1280x720.png) | ![The same on a phone](docs/screenshots/founders-tour-390x844.png) | ![The title plate with the BETA stamp beside the logo](docs/screenshots/founders-title-beta.png) |

| How to play | Sound settings | Market board |
|---|---|---|
| ![The guide: eleven sections on the left, Founding Hens open on the right with its picture](docs/screenshots/founders-guide-founding.png) | ![Twelve sound groups, each with a slider, a percentage and a mute, a reset button, reduce motion, How to play and Replay the tour](docs/screenshots/founders-settings-sound.png) | ![The board with FOUNDING HENS: 773 OF 777 LEFT TO WIN, 4 WAITING (while the check farms were in play)](docs/screenshots/founders-board-founding.png) |
| **Ledger** | **An ordinary hen** | **A machine's card** |
| ![The ledger: machine lines per day, Founding Hen certificates, every milestone with its state, and good standing](docs/screenshots/founders-ledger-milestones.png) | ![An ordinary hen's card: not recorded on NEAR; only Founding Hens, won at milestones, are](docs/screenshots/founders-hen-ordinary.png) | ![The conveyor's card: what it does and what it did today](docs/screenshots/founders-machine-conveyor.png) |

- **First-run tour:** for a brand-new player at 1280x720, 1920x1080 and 390x844 the first step was up 16 to 208 ms after
  the farm appeared, with no click on the farm; after Skip it did not come back on a reload, nor in a second fresh
  browser for the same player.
- **Layout:** at 1280x720, 1920x1080, 2560x1440 and 390x844 the top bar, side panel, tracker and toasts never
  overlapped; all five machines were on screen with their plates, none under a UI zone; one belt; no page errors.
- **30-second capture** ([founders-live-30s.mp4](docs/screenshots/founders-live-30s.mp4), the equipped check farm at
  1280x720): an egg is laid in the yard, rides the belt and drops into the grader and crate. The coop door is shut in
  31 of the 32 one-second frames; it swung once, with no hen near it: the rare idle creak (every 25 to 75 s).

  ![Four frames a little under a second apart: an egg in the yard, then on the belt, moving right into the grader](docs/screenshots/founders-belt-ride.png)

- **Milestones, live:** the first day closes on this build rolled every milestone the farms had reached, each logged
  with its anchor and seed. The real player's farm missed three (top three by 0.0027) and then **won a Founding Hen**
  at a good week (roll 0.003145, day 409). She waits on the farm until the contract is upgraded; the board says 776 of
  777 left, 1 waiting. The check farms' wins went with them.
- **Found and fixed while checking:** the phone left half its screen empty under the side panel (the farm now takes the
  height it can, PR #13); phones whose world zoom is 1 (360x640, 375x667 at 2x) threw `sprite 16-farmhouse not loaded`
  (they now load the smallest painted level, PR #13); the guide's list ran over its text (short names, PR #14).

## Visual quality and the tour (12 November 2026)

A recording of the live game at 2560x1284 on a 2x Mac showed assets that looked like 240p, soft top bar and card text,
jagged text on tilted cards, panels piling onto the farm and each other, and a tour that taught only collecting. Causes
and fixes:

| What was seen | Cause | Fix |
|---|---|---|
| Mushy portraits, card art, hens | the previous pass cut every painted sheet down to the grid measured from its outlines (8 source pixels for a hen), throwing away the painting inside: 20% to 67% of visible pixels changed (round trip at that grid, [asset report](docs/asset-report.md)) | each sheet keeps the largest factor whose nearest round trip is near pixel-identical; painted sheets pass at no factor, so they keep their full resolution, cut per screen density |
| Soft top bar, cards and shop | the UI was laid out at 640x360 and scaled by a fraction (1.78 on that screen) | the UI is drawn at a whole number of device pixels per UI pixel through CSS zoom, pixel fonts at whole multiples |
| Jagged "96.00 / BAG" | the card came to rest tilted 2 degrees, stamps at 8 | nothing that carries text rotates; motion is translate and scale in whole-pixel steps |
| Uneven pixels in the world | the world zoom was window height / 360 (3.57 device pixels a world pixel) | the world is drawn at a whole number of device pixels per world pixel, placed on whole device pixels |
| Panels, card art and hints over the farm and each other | free-floating panels with no backdrop; the card was three loose pieces | fixed zones that never overlap; one modal at a time over a dimmed backdrop; a card is one composed panel |
| A tour that taught one thing | four corner messages ended by events, nothing pointed at | ten spotlight steps that move on only when the player does the thing |

**Art at its own detail.** `npm run derive-assets` tries factors 2, 3, 4, 6, 8, 12 and 16 and keeps the largest whose
nearest round trip changes at most 0.5% of visible pixels by more than 24 of 255. The 25 exact sheets pass at their
grid with 0.00% error and ship whole as lossless PNG. Every painted sheet fails even at 2 (6.5% to 31.7%), so it keeps
its original resolution. The hen and its trait layers are judged together and share that factor, so they still stack
pixel for pixel. Painted art ships as WebP pages (alpha lossless) cut by exact area coverage at 2, 3, 4, 6 and 8 texels
per design pixel, on a grid that starts at each sprite's pivot. A screen loads the density that divides its zoom, so a
texel is one device pixel (or a whole square of them). [docs/asset-report.md](docs/asset-report.md) lists every sheet:
factors tried, the factor chosen and its round-trip error, and the previous grid's error.

**Whole pixels everywhere.** With a window of $W \times H$ device pixels, the UI zoom and the farm's zoom are

$$
p = \max\{\, s \in \{2,3,4,6,8\} : W/s \ge 560,\ H/s \ge 330 \,\}, \qquad k = \max\{\, s : 502\,s \le W_{\text{world}},\ 312\,s \le H_{\text{world}} \,\}
$$

where $W_{\text{world}} \times H_{\text{world}}$ is the free area left by the top bar and the side panel, with room for the
guide under the farm's ground line. 1280x720 gets $p = k = 2$, 1920x1080 and a 2x 1280x642 window $3$, 2560x1440 $4$,
a 2x 2560x1440 screen $8$.

**Zones.** Top bar; right side panel (the crate's sell card, waiting cards with a count, contracts and debts); a
bottom-left goal tracker; one toast area stacked above it for hints and news; the world. Only ground lies under the
tracker and toasts. Modals (shop, ledger, market board, a card, a hen, a machine, the crate, a certificate, settings) open
one at a time in the world zone over a backdrop that dims the whole window; Escape and the close button dismiss them.

**The tour**, each step done by doing it, with Back, Skip and progress dots, replayable from Settings:

1. Collect an egg: the spotlight follows an egg on the ground.
2. Sell from the crate at today's price.
3. Open the market board: one market shared by every farm and trader.
4. Tap the supply meter: everyone selling at once crashes prices (a glut), scarcity lifts them.
5. Buy a bag of feed at the trough (on the Loyalist's credit when coins are short); the tiers show how they change laying.
6. Answer an offer and counter it: a practice offer from a buyer, whose first counter always gets a counter back.
7. Buy a hen: she is one of a kind, and her card opens. The sentence about NEAR is honest about whether recording is live.
8. See what the conveyor saves.
9. Tap the farms on the board: rivals go bust, their hens go to auction.
10. Open the ledger: each day closes with a receipt.

The goal tracker continues from there.

**Hen certificates.** When a day close mints a player's hen, the server stores the settlement transaction and day on her
and tells her owner (`henMinted`). The game then shows a certificate: her portrait and traits, a stamp, and one line, "SHE
IS NOW PERMANENTLY YOURS ON NEAR", with the receipt in the ledger. Her card shows her token and receipt link. While
`play.coys-game.testnet` is below its 2.05 NEAR threshold (1.301 available, 0.749 short), mints wait and the game says
"certificate pending: recording on NEAR is paused for now".

**Measured live** on 12 November 2026, from fresh headless browsers through the tunnel. Cold load with an empty cache,
median of three runs (range in brackets), to a playable farm (top bar up and farm objects on the canvas):

| Window | Before (brief 4) | After | On the wire by then (the sharp art keeps arriving) |
|---|---|---|---|
| 1280x720 | 7.4 s, 5.4 MB | **5.1 s** (5.0 to 6.0) | 1.6 MB |
| 1920x1080 | | **8.2 s** (4.8 to 11.9); 6.0 to 6.9 s on three further runs | 2.4 to 5.4 MB |
| 2560x1440 | | **5.6 s** (4.5 to 7.9) | 1.6 to 4.4 MB |
| 2560x1440 at 2x | | **8.7 s** (7.2 to 8.8) | 1.6 to 9.5 MB |
| 390x844 | | **8.6 s** (6.5 to 10.9) | 1.6 to 4.4 MB |

The farm comes up with the smallest painted density that divides the screen's zoom (about 1 MB, drawn several device
pixels a texel), then the sharp one; sounds wait until the sharp farm is in. The loading screen is on screen in 0.6 s.

- **Tour, live, by doing:** an automated browser completed all ten steps at 1280x720, 1440x900, 1920x1080, 2560x1440 and
  390x844, on a fresh check farm each, clicking only what the spotlight showed, in 38 to 61 seconds.
- **No overlap:** at each of those sizes, the boxes of the top bar, side panel, tracker, toasts, tour box and modal never
  overlapped at any tour step or with each modal open (shop hens, feed and machines, ledger, board and orders, crate,
  conveyor, settings, a hen, a certificate). Nothing on the farm sat under a UI zone, and no page logged an error.
  `apps/client/test/viewport.test.ts` asserts the same layout rules for eight window sizes.
- **Whole pixels:** in device-pixel crops at 2x 2560x1440, the share of aligned blocks whose pixels are all one colour
  (a fractionally scaled image scores about 73%):

| Crop | Block | Uniform |
|---|---|---|
| top bar (icons, labels, counters) | 8x8 | 100% |
| card art with its terms (a card modal) | 8x8 | 100% |
| the crate's sell card in the side panel | 8x8 | 99.4% (its centred title sits half a UI pixel over: 4 whole device pixels) |
| a hen's portrait (painted, full detail at 2x) | 2x2 | 100% |
| an agent's portrait (painted, full detail at 2x) | 2x2 | 100% |

<details>
<summary><b>The crops</b> (device pixels, 2x 2560x1440)</summary>

<br>

| Top bar | Card art | Hen | Agent |
|---|---|---|---|
| ![Top bar crop: icons and pixel text in 8x8 device-pixel blocks](docs/screenshots/crop-topbar-5k.png) | ![Card art crop: the bulk order card, upright, its pixel text crisp](docs/screenshots/crop-card-5k.png) | ![A hen's portrait at full painted detail](docs/screenshots/crop-hen-5k.png) | ![The Wholesaler's portrait at full painted detail](docs/screenshots/crop-agent-5k.png) |

</details>

The Verify Bot farm from the rescue's checks is gone from season `s1` entirely (`scripts/remove-player.ts`: its hens,
coop, machine, cards and ledger, out of the market, the rankings, demand and the ticker), and so are the five check farms
this pass used.

## Playability rescue (12 November 2026)

A screen recording of the first live build showed a small letterboxed game with blurry pixels, hens
that blinked out, a trough that flickered between full and empty, nothing on the farm that answered
a click, egg counts that disagreed, codes like `WHT X0`, and more than two minutes of loading. Each
had one cause, now fixed:

| What was seen | Cause | Fix |
|---|---|---|
| Over 2 minutes to load (52.8 MB before the farm; now 7.4 s, see below) | 1024 to 4096 px painted sheets, 49 MB of them, decoded and resampled in the browser; 2.7 MB of title music decoded before the title | [`scripts/derive-assets.ts`](scripts/derive-assets.ts) builds true-pixel atlases (1.8 MB in all), loaded by screen; music streams after the first tap; hashed files are cached for a year and sent brotli compressed |
| Hens vanishing between frames | the load-time row masking gave whole hens to the row below: idle frame 4, waddle frames 1 and 4, lay frame 4 and eat frame 3 were blank | frames are cut offline by body ownership at full resolution; a test checks every frame of every animation |
| The trough flickering | every server update forced full or empty from yesterday's feeding, fighting the spill animation | sprites keep a resting row from game state that a play-once animation returns to |
| Nothing clickable | a nested full-size layer took every pointer event over the canvas | layers are click-through; every world object has a hover highlight and a card |
| Eggs on the ground, crate at 0 | only collected eggs counted, and nobody could click to collect | the top bar shows eggs to collect and eggs to sell |
| A small blurry box | a 640x360 stage at the largest whole-number scale that fit | the world is 360 pixels tall and as wide as the window, at device resolution, nearest-neighbour |

**Measured live**, cold, in a fresh headless browser through the tunnel, on the Pier Mac:

| | Before (11 November) | After (12 November) |
|---|---|---|
| Loading screen on screen | after the bundle and WebGL | **0.98 s** (inlined in the page) |
| Title screen | 8.3 s, 3.7 MB, 48 requests | **3.3 s**, 1.3 MB, 34 requests (the farm's art already downloading) |
| Farm playable | about 66 s and 52.8 MB of network alone, then decode | **7.4 s**, 5.4 MB, 143 requests (sounds still arriving in the background) |

A 20-second capture of the live farm checked every hen on every animation frame (1201 frames): 10
hens on every frame, no frame where a hen's drawing shrank to nothing. An automated browser on the
live site clicked every kind of world object (hen, crate, trough, coop, farmhouse, sign, machine),
saw its card open each time, and collected a ground egg: **COLLECT** went down by one and **SELL**
up by one. Before the fix the farm canvas took no clicks at all.

<details>
<summary><b>True sprite sizes</b> of that pass (superseded the same day: painted art now keeps its full detail, see the asset report)</summary>

<br>

Painted sheets have no exact grid, so each one's true grid was measured from outline thickness (a
pixel-art outline is one art pixel wide) and every block takes its majority colour.

| Sheet | Grid (source px per art px) | True cell | World scale |
|---|---|---|---|
| hen and its trait layers | 8 | 32x32 | 1 |
| eggs | 12 | 21x21 | 1 |
| crate, sacks, trough, farm sign | 8 | 32x32, 32x48, 48x32, 48x32 | 1 |
| coops | 8 | 48x48 | 2 (drawn coarser than the farm needs) |
| farmhouse | 4 | 96x96 | 1 |
| machines (grader, sorter, cart, hopper, clerk) | 4 | 64x64 (hopper 64x96) | 0.5 (drawn finer than the hen's grid) |
| character portraits | 4 | 64x64 | 1 |
| tiles, props, UI, icons, particles, stamps | 8 (exact) | 16, 32 | 1 |
| plates, cards, logo, loading and title animation | 2 or 4 (exact) | 640x360 plates | 1 |

</details>

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
- **Founding Hens only** (version 3): ordinary hens are not minted; `settle_day` refuses them and mints Founding Hens up to a hard cap of 777, numbering each ([docs/founding-hens.md](docs/founding-hens.md)).
- **Hen images**: the stacked trait layers are rendered once at mint into a 32x32 PNG (1.3 to 1.8 KB as a data URI) and stored in the token metadata with its `media_hash`. Why: it is the simplest correct storage. The token is self-contained and verifiable from the chain alone, with no image host, pinning service or URL to keep alive. A Founding Hen costs 2,647 bytes of state (measured in the sandbox with a full-size portrait), about 0.026 NEAR. At most 20 mint in one day close, and only as many as the game account's free balance stores above its margin (`CHAIN_MINT_NEAR`, default 0.03 each; `CHAIN_MIN_BALANCE_NEAR`, default 1.25); the rest wait.
- **Agent wallets**: sub-accounts of the game account, funded from it (`AGENT_ACCOUNT_FUNDING_NEAR`, default 0.05), with keys derived from the game key by HMAC so no extra secret is stored.
- **Players**: the Privy wallet holds their hens and eggs. Minting and transfers happen only in the day batch, never per click.
- Testnet only, enforced in code before any key is used: accounts must be `.testnet` (or implicit), RPC hosts must be testnet, and the RPC's `chain_id` must say `testnet` before anything is signed. Without credentials, every day's batch is built the same way and logged as a NO-OP.
- **Deliveries on chain**: a contract delivery is a trade from the player's wallet to the Bakery's sub-account, so the day's batch moves the eggs as NEP-245 tokens between them (then burns them when the Bakery bakes). Proven on testnet (receipt above), in a dedicated test, and in every seed of the simulation.
- Tests: 11 contract unit tests and 6 **sandbox tests** (`contracts/sandbox-tests`, near-workspaces 0.24): a full day settlement, holder transfers, only the game can settle or mint, a new season settling day 1 after an old season ended at day 3, 777 Founding Hens minted then the 778th refused, and the version 2 wasm running on `play.coys-game.testnet` (kept in `contracts/sandbox-tests/res`) upgrading in place. They run in CI (Linux); the wasm CI builds is what gets deployed (`npm run deploy-contract` checks its sha256, testnet only, see [deploy/testnet.md](deploy/testnet.md)).

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

- Whole device pixels everywhere: the UI is laid out in UI pixels drawn at $p$ device pixels each (CSS zoom), the world at $k$ device pixels per world pixel, painted art from the atlas cut for that density (see [Visual quality](#visual-quality-and-the-tour-12-november-2026)). PixiJS draws the farm and the town square; anime.js drives every UI motion, in whole-pixel steps, never rotating text.
- **Card overlay**: one composed modal (portrait and line, the card art upright beside them, answers in one row); the card slides in with an overshoot and a paper swoosh; the portrait talks with its voice babble while the line types out; outcomes play the agent's expression and slam a stamp; a haggle win flips the card to gold with a hitstop, shake, confetti and the win chime; a fail sends the agent walking with the fail sound.
- **Market board**: town square plate with animated bunting and a milling crowd (market murmur loop), split-flap ticker board by grade, farms ranked with their signs, the cast, big trades, the order book.
- **Ledger**: day-by-day profit, contracts, debts, and the on-chain receipt link per day.
- **Shop**: listed hens drawn from their trait layers with laying trait and price (auction hens marked), feed with supplier switching, coops, machines.
- **Rival bust**: the sign tips over, a price wave crosses the ticker, medium shake, falling feathers, the collapse crash and the bust sting. **Glut**: the ticker drops red and the market tension music plays until prices recover.
- **Tour**: ten spotlight steps covering the whole game, each moving on only when the player does it; Back, Skip, progress dots, replayable from Settings. Waiting cards queue in the side panel with a count; an unanswered card closes with its day.
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
| `CHAIN_MINT_NEAR`, `CHAIN_MIN_BALANCE_NEAR`, `AGENT_ACCOUNT_FUNDING_NEAR` | server | 0.03 kept free per Founding Hen mint; 1.25 margin (about a real day of settlements) under which mints and agent wallet links wait; 0.05 |
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

Brief 6 was checked live on 12 November 2026 on `c48d2f2`: the farm at four sizes with no overlap, the first-run tour for brand-new players at three sizes, a 30-second capture of the belt and the coop doors, and live milestone rolls (under [Founding Hens](#founding-hens-machines-at-work-sound-and-a-guide-12-november-2026)). The contracts job builds the version 3 wasm and the sandbox mints 777 Founding Hens and refuses the 778th.

The visual-quality pass was checked live on 12 November 2026: cold load at five sizes, the whole tour completed by an automated browser at five sizes, the no-overlap check with every modal and tour step open, and device-pixel crops (numbers under [Visual quality](#visual-quality-and-the-tour-12-november-2026)).

The playability rescue was checked live on 12 November 2026: cold load, the four window sizes, every world object's card, an egg collected, and a 20-second flicker capture (numbers under [Playability rescue](#playability-rescue-12-november-2026)).

**Not verifiable headlessly:** whether it now looks and feels good to a person, a Render deploy, Privy login on the live domain, NEAR AI decisions without credits, how haggling and cards feel, whether portraits and voices read right, and how the market evolves over weeks of real play.

## Build log

### Brief 6: Founding Hens, machines at work, sound, a guide and BETA (12 November 2026)

- **Coops and layering.** The doors looped because the coop played its idle row, which is the door swinging; it now
  holds the first frame and swings once when a hen passes (and creaks every 25 to 75 s). Animated ground tiles were
  inserted above the sorted layer (`addChildAt(1)`), so a straw tile cut the belt; the world now draws in a fixed order
  (ground, animated ground, floor, things sorted by their feet, labels, effects) with a test.
- **Composition.** `farmLayout(w, h)` places everything for the whole free area: the yard at least half the width,
  hens spread out, one belt along the bottom, one fence the full width with a gate on the path. Tested at four sizes.
- **Machines** at fixed, labelled spots (grader, cart and clerk 48x48, hopper 48x72 world px, the belt in 16 px tiles),
  each arriving with a ring and doing its job on screen and on the server: the belt carries eggs to the crate in 5 s
  and saves breakage (2% for 5%), the grader sorts (+10%, in the sell panel), the cart drives the delivery, the hopper
  refills under a price cap (-10%, in the ledger), the clerk stamps offers (+5%). A daily tally per machine
  (`machine_days`, migration 7) feeds each machine's card and the ledger; a three-day test runs all five.
- **Rival signs** on the board and at the farm's edge (sway, tip over on a bust); the tour's hen talks again.
- **Sound settings**: twelve groups with volume and mute, every sound in exactly one (tested), instant, per browser,
  with a reset.
- **How to play**: eleven sections with pictures, from Settings and the **?** in the top bar.
- **BETA** on the title, the top bar and the page title. The first-run tour starts for every new player on first farm
  entry, once per player (server flag plus browser flag).
- **Founding Hens.** Ordinary hens are no longer minted; 777 Founding Hens, capped on chain by contract version 3, are
  won at seven milestones by farms in good standing, 30% per roll, one roll each, seeded from the previous day's
  settlement tx and logged ([docs/founding-hens.md](docs/founding-hens.md)). Migration 8 adds the founding fields, the
  roll log and the counters. Mints are gated on the real reserve (0.03 NEAR each above a 1.25 NEAR margin) instead of a
  flat 2 NEAR, and agent wallets that exist are linked without the old 2.05 NEAR gate once the margin is there.
- **The testnet upgrade waits for funds.** Measured on 12 November at 15:59 UTC, `play.coys-game.testnet` held 4.8103
  NEAR with 415,245 bytes of state (4.1524 NEAR locked), so **0.6579 NEAR available**. Its own settlements cost 179 bytes
  and 0.0004 NEAR of gas per 3-minute day (measured on chain over 69 minutes), about **1.06 NEAR a real day**. The
  reserve for this brief's chain steps:

  | Step | NEAR |
  |---|---|
  | Upgrade to version 3 in place: +9,384 bytes (sandbox, exact v2 code) and about 27 Tgas | 0.097 |
  | Link the 7 agent wallets: their egg balances, 28 entries of about 106 bytes | 0.030 |
  | Mint 3 Founding Hens in a test season: 3 x 2,647 bytes, two day records, gas | 0.085 |
  | Keep one real day of `s1` settlements free | 1.060 |
  | **Needed** | **1.272** |
  | Available | 0.658 |
  | **Short** | **0.614** |

  So nothing was signed: the contract is built (wasm sha256 `9bc8bfba...`, committed in `contracts/coys-game/res`) and
  tested (11 unit, 6 sandbox), and the server already speaks version 3. The shortfall grows by about 0.044 NEAR an hour
  while `s1` settles, and at that rate the account's free balance runs out around 07:00 UTC on 13 November, after which
  day settlements fail (and catch up once topped up). Topping up about 10 NEAR covers the steps above and a week of
  settlements; then the owner runs the upgrade in [deploy/testnet.md](deploy/testnet.md), and the server links the
  wallets and mints waiting Founding Hens at the next day close on its own.
- [Mainnet checklist](docs/mainnet-checklist.md) written; nothing touched mainnet.
- Live checks found three more things, fixed the same day: a half-empty phone screen and a crash on phones whose world
  zoom is 1 (PR #13), and the guide's section list running over its text (PR #14). Merged as PRs #12, #13 and #14;
  live on `c48d2f2`.

### Brief 5: visual quality, layout and the tour (12 November 2026)

- Every asset at the detail its round trip allows ([asset report](docs/asset-report.md)): exact sheets at their grid, painted art at full resolution, cut per screen density as WebP pages.
- UI at the screen's own resolution (whole device pixels per UI pixel), the world at whole device pixels per world pixel, no rotated text, whole-pixel motion; plates cover the window or mirror their edges.
- Fixed zones that never overlap, one modal at a time over a backdrop, a composed card panel, waiting cards queued with a count; a layout test at eight sizes.
- A ten-step spotlight tour of the whole game, done by doing; a practice offer to haggle on; feed on credit for players.
- Hen certificates: mint receipts on each hen, a `henMinted` event and a certificate moment; honest wording while minting is paused.
- The smallest density first, then sharp, then sound: a playable farm in 5 to 9 seconds cold through the tunnel.
- The Verify Bot farm removed from season `s1` (`scripts/remove-player.ts`).

### Brief 4: playability rescue (12 November 2026)

- True-pixel atlases built offline from the packed sheets (coys-assets stays read only); staged loading by screen; streamed music; immutable caching and brotli.
- Full-window rendering: a 360-pixel-tall world as wide as the window, crisp on Retina, with a usable portrait layout; HUD pinned to the window edges.
- No flicker: frames cut by body ownership, resting rows, persistent hens; a frame test over every animation.
- Everything clickable: hens (with their on-chain status in words), eggs, crate, trough and sack, coops, farmhouse, sign and machines.
- Clarity: plain labels and tooltips, a tour by doing, a goal chain that pays coins, hints when the farm needs something, one plain line on every card.
- Submission field list matched to the form's own contract.

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
