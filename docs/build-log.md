# Build log

The dated build history of Chickens of Yolk Street, moved here from the README with its text unchanged (only
relative links re-pointed so they still resolve from `docs/`).

### Brief 10: a clean history, the Market page, profiles, badges and hatching (13 November 2026)

- **History.** Three screenshot files that showed email-derived farm names were removed from every commit; the
  repository moved to a fresh public history with every commit message, author and date unchanged, and the old one is
  archived privately. Pier deploys from the new repository.
- **Fixes.** The stray egg below the crate (a loose piece of the crate sheet cut as a frame of its own), the wording
  about who runs the farms (players and AI; suppliers and buyers are AI), the shop's hen button (`BUY 4`, with a small
  `AUCTION` tag and one line on auction hens), and the mint reserve from measured costs (0.127 NEAR free for a mint,
  was 0.535).
- **Market page.** Seven tabs in place of the market board, a 10-day price chart from the server, one-tap fills,
  ranking with badges and public profiles.
- **Profile and badges.** Eight private tabs and a public profile with a whitelisted set of fields; 73 cosmetic
  badges (153 levels to earn, 7 secret), day records and counters (migration 14), a one-off back-fill, the unlock
  moment.
- **Hatching.** New hens hatch from an egg in a free yard spot, a beat apart, with sound and reduce-motion respected.
- **Art.** Badge frames, badge icons and the hatching egg, made in Spawn by `@gama` and backed up in coys-assets.

### Brief 9, stage 4: agents that reflect, AI farms that enter (13 November 2026)

- **Agents.** Richer observations, personas, one validated schema with a public reason, weekly reflections, model tiers,
  per-agent caps, trend-aware rules (migration 13). A 30-day comparison on a recorded stand-in model and
  the cost of real model use.
- **AI farms.** A registry of entrants, the entry rule and its bounds, the AI tag, a reusable wallet pool.

### Brief 9, stage 3: the Feather Mint (13 November 2026)

- **Numbers.** Random free numbers from a logged SHA-256 seed anchored on the season's last settlement transaction.
- **Mints.** At once on redemption through contract version 6's `mint_feather`, paced, retried with backoff, refunded on
  failure, caught up at day closes (migration 12). Test seasons mint into their own collection.
- **Page and moment.** `/mint` with its seven parts in order; MINT in the title, top bar and board; the press sheet
  (Spawn, coys-assets #5); SENT TO NEAR and CONFIRMED; RETRY. Checked live on testnet with a forced failure.

### Brief 9, stage 2: farm zones and machine wear (13 November 2026)

- **Layout.** Zones in the layout spec; a hen's width between every two things standing on the ground (except designed
  connections), zones apart, labels on hover, tap and arrival only. Tests at 41 window sizes; before and after pictures.
- **Wear.** Condition, effect by condition, breakdowns, repairs (migration 11), worn and broken looks made from the
  machines' own art (Spawn, coys-assets #4), the breakdown and repair moments, card, hints, guide and tour.
- **Tuning.** Config only: cart, hopper and clerk prices, so each machine pays back before its first repair.

### Brief 9, stage 1: farm names, privacy, the new tour (13 November 2026)

- **Recon.** The game never saw a full email, but an email sign-in with no name typed sent the email's local part as the
  player's name; the farm was named after it and that name reached the public board, order book, trades, trade cards,
  the public market and mint page, and the agents' prompts on NEAR AI. Three committed screenshots showed such a name.
  Logs, on-chain data and every committed text file were clean.
- **Fixed.** Generated farm names and NAME YOUR FARM, the email-name hash guard, renames in Settings, the boot-time rename
  of the three `s1` player farms (old names gone from player rows and trades), log redaction, the three screenshots
  replaced. Migration 10.
- **Tour.** A larger box beside its target with a pointer, four controls on every step, NEXT after five seconds.
- **CI.** The browser checks moved to a pull-request workflow that skips docs-only changes.

### Brief 8: scaling, no scrollbars, a clean conveyor and the 777 restored (12 November 2026)

- **Recon first.** No PR was open. Four causes found: a frame cache keyed by atlas downloads, not by the density each
  sprite is drawn at (hens changed size after a resize); straight random walks in a yard box that holds the trough,
  props and machines, with arrivals crossing the belt row and resizes leaving stale targets; eggs painted on all 20
  frames of the belt; scroll boxes in the modal body, the side desk, the ledger and settings (the mint page ran up to
  821 pixels past the window). On chain, the three test Feathers (#001 to #003, held by the game account) counted
  against 777, and `s1` days 509 and 510 had failed with 429s and never settled.
- **Scaling and movement.** The cache key carries the density; movement areas and keep-outs come from the layout spec,
  walks are routed round standing objects, and every hen and egg is carried relative to the yard on a resize. Tests for
  both.
- **Clean conveyor.** Created as a new asset in Spawn `@25th/game-11` with the Spawn agent account (the in-world builder
  is not open to agent accounts, so the sheet was made from the existing belt, pixel for pixel, and uploaded through the
  world's asset door; easel 28 and every other asset are untouched), pulled byte for byte, backed up in coys-assets
  (PR #3), drawn on the farm and in the shop, with a test.
- **No scrollbars.** A pager that measures what it draws and fits each panel; tabs for the ledger, the board (a new FARMS
  tab) and the mint page; the guide one section at a time; the top bar on two rows under 640 UI pixels; toasts that wrap.
  The browser check runs in CI.
- **Contract version 5** (sandbox-tested against the exact version 4 code, then upgraded in place): `burn_test_feathers`,
  `set_live_season`, mints only for the live season and only of its own season, and `settle_late_days`. The burn and
  the late days are recorded above; the server now records missed days at each day close and never sends mints for a
  season that is not the live one.

### Brief 7: the Feathers beta, compact settlement and the layout spec (12 November 2026)

- **Recon first.** No PRs were open; main CI was red on a docs-only merge because the five-seed simulation is not fully
  deterministic (a Founding Hen win added a hen; farm ids are random). A win is now a ticket, not a hen; the simulation
  passed three local runs in a row. Of the items the last report left out, sound settings, rival signs and the tour's hen
  portrait were present and working; the Spawn pull, the layout spec, the debug overlay and the mint page were missing,
  and the guide still spoke of Founding Hens.
- **Settlement cost.** Each day close stored a 179-byte record (85,920 bytes and about 0.86 NEAR a real day), and 478
  records already held about 85.6 KB of `play.coys-game.testnet`'s 429 KB (the rest is the contract code). Version 4
  stores a fixed-size head per season instead: 0 bytes a day (sandbox: 30 days, 355,102 to 355,102 bytes), so storage
  growth per real day went from 85,920 bytes to 0, and the projected cost from about 1.06 to about 0.19 NEAR a real day
  (gas only). `prune_days` and `scripts/release-chain-days.ts` release version 2's records into an archive hash after
  copying them to `chain_archive`.
- **The upgrade.** Measured at 20:29 UTC: 0.470 NEAR available, against the upgrade's +11,490 bytes (about 0.115
  NEAR) plus a buffer, so it went ahead: version 4 deployed with `migrate` in one transaction,
  [9jsFd4EA...](https://testnet.nearblocks.io/txns/9jsFd4EAZc3nkE4v11x4poVTMhLyYzPpuZKrsCud9J4s). The running server
  (still on the previous build) settled the next day against it at once, compactly. Then the founders provenance,
  [JBoKNVa6...](https://testnet.nearblocks.io/txns/JBoKNVa6Pi5jAb2BA4chAh8K43GGpWgw8AtHJy26b5AB).
- **Feathers.** Tickets at milestones (30%, logged, auditable), a coin fee to redeem, grades from the management score,
  mints at the day close to the player's wallet, 777 on chain, the reveal moment and the mint page. Migration 9 adds the
  tickets, the archive and the exact settlement text, and turned the one Founding Hen won live (but never minted) into a
  Feather Ticket for her farm; she stays on it as an ordinary hen. The board shows Feathers left of 777.
- **Founding Hens committed now.** `scripts/generate-founders.ts` writes the 777 (7/70/200/500), unique looks from
  recolours of existing layers, Legendary and Epic palettes theirs alone, a sparkle on every Legendary; the hash is
  public, the file stays on the server.
- **Reveal, sandbox only.** `contracts/founding-hens` (snapshot, seal, reveal once, claim) and the draw in Rust and
  TypeScript with one pinned vector; 111 Tgas for 777, exactly 7/70/200/500, the same hens from the same seed.
- **Assets.** The four feathers and five card frames were pulled from Spawn and backed up in coys-assets (PR #2, merged);
  nothing else needed new art, so nothing was created or changed in Spawn.
- **Layout spec and sizes.** One size table relative to the hen drives the art ratios; the layout places every object
  with its anchor, bounds, footprint and connection points; `?debug=layout` draws them; tests check connections within a
  world pixel, sizes within 3.5% and no overlapping footprints. Two sizes differ from the brief because their art is
  exact pixel art (belt 0.59, hay bale 0.96).
- **Docs**: [docs/founding-hens.md](founding-hens.md) rewritten for the Feathers, [docs/mainnet-plan.md](mainnet-plan.md)
  (snapshot, claim, reveal seed, the mainnet contract, sybil checks) and the checklist updated. No mainnet action.
- **Live** (checked under [the Feathers beta](../README.md#the-feathers-beta-compact-settlement-and-the-layout-spec-12-november-2026)):
  the release of 489 records (three transactions, archive `cfe525e7...`, checked against the live database), three test
  Feathers minted in a test season, six agent wallets linked, and the layout at five sizes with no overlap. Running it
  found three more things, fixed in PRs #17 and #18: the mint page drew only this season's Feathers (it reads the contract
  now), the release script needed paced reads (the public RPC answered 429, and two `s1` days failed to settle for those
  six minutes; the next day caught their eggs up), and each bust rival's successor got a newly funded wallet (it now takes
  over its predecessor's). Merged as PRs #16 and #17 (live on `4471029`), docs and fixes in #18.

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
  settlement tx and logged ([docs/founding-hens.md](founding-hens.md)). Migration 8 adds the founding fields, the
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
  settlements; then the owner runs the upgrade in [deploy/testnet.md](../deploy/testnet.md), and the server links the
  wallets and mints waiting Founding Hens at the next day close on its own.
- [Mainnet checklist](mainnet-checklist.md) written; nothing touched mainnet.
- Live checks found three more things, fixed the same day: a half-empty phone screen and a crash on phones whose world
  zoom is 1 (PR #13), and the guide's section list running over its text (PR #14). Merged as PRs #12, #13 and #14;
  live on `c48d2f2`.

### Brief 5: visual quality, layout and the tour (12 November 2026)

- Every asset at the detail its round trip allows ([asset report](asset-report.md)): exact sheets at their grid, painted art at full resolution, cut per screen density as WebP pages.
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

- Seven agents with personalities, memory, cash and wallets on rule strategies; model decisions wired for NEAR AI Cloud (structured JSON) with rule fallbacks, a hard daily spend cap, struggling agents sitting out every other day, busts and replacements.
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
