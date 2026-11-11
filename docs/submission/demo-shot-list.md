# Demo video shot list (about 110 seconds)

Draft. Nothing here has been recorded or posted.

## Setup

- Run a local server for the recording with short days, a fresh database and its own season, so
  nothing touches the live season:

  ```powershell
  $env:DEMO_DAY_SECONDS = "30"; $env:GAME_SEASON = "demo-rec-1"; $env:DATABASE_URL = "pglite://.data/demo-rec-1"; npm run dev
  ```

  `DEMO_DAY_SECONDS=30` closes a day every 30 seconds (normally 180), so a price swing, a glut and
  the next day's cards all happen inside a take. On a production server it only works with
  `DEMO_MODE=1`, and only for a recording session.
- Browser window at 1920x1080 (the game is 640x360 scaled by 3, pixel perfect). Sound on: the
  card voices, stamps and music carry the demo.
- Let the season run about 12 minutes before the bust shot: the Upstart borrows on a good week and
  usually goes bust between day 15 and day 27 of a season, which is 8 to 14 minutes at 30-second
  days. Record the other shots meanwhile.
- Testnet credentials in `.env` give real receipts in the ledger. Keep the explorer tab ready.

## Shots

| # | Time | Shot | On screen | Caption or voice-over |
|---|---|---|---|---|
| 1 | 0:00 to 0:07 | Title | The logo stamps in, the price ticker scrolls | "An egg farm in one shared live market." |
| 2 | 0:07 to 0:14 | Sign in | PLAY, Privy email sign-in, the farm loads | "Sign in with email. A NEAR wallet is made for you, silently." |
| 3 | 0:14 to 0:22 | Your hen | First onboarding card, then SKIP | "Collect, sell, and answer the cards." |
| 4 | 0:22 to 0:34 | Collect and sell | Click eggs into the crate, SELL: the stamp slams, coins arc | "Every egg anyone sells is supply in the same market." |
| 5 | 0:34 to 0:50 | Haggle win | The Squeezer's feed deal slides in and talks; lower the price, COUNTER: the card flips gold, confetti | "Every rival, supplier and buyer is an AI agent with its own cash and memory." |
| 6 | 0:50 to 0:58 | Haggle fail | Ask far too much from a proud agent: it walks off | "Push too hard and they walk." |
| 7 | 0:58 to 1:12 | Glut | Market board: the ticker, today's supply against demand; the next day the ticker turns red and the tension music starts | "Flood the street and the price crashes, for everyone." |
| 8 | 1:12 to 1:26 | Rival bust | The Upstart's sign tips over, feathers fall, its hens show up at auction in the shop | "Rivals borrow, overbuild and go bust. Their hens go to auction." |
| 9 | 1:26 to 1:42 | On chain | Ledger: ON-CHAIN RECEIPT opens the testnet explorer: `settle_day`, NEP-171 hens, NEP-245 eggs moving to the Bakery's wallet | "Each day settles on NEAR: hen NFTs, egg tokens, agent wallets." |
| 10 | 1:42 to 1:50 | End card | The share image (logo, hen, Upstart, Old Money), "Built at NEAR HACKATHON", repo link | "Chickens of Yolk Street." |

## After recording

- Upload the video straight into the README's video slot on GitHub (drag it into the editor), and
  use the same file for the post drafts in [x-post.md](x-post.md).
- Stop the recording server; its database (`.data/demo-rec-1`) and season are not used again.
