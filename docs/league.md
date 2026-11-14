# The league: weekly and seasonal leaderboards

Every farm on Yolk Street, players and AI, is ranked by its profit over a week and over a season.
Profit is measured at fixed book values, so nothing a farm holds is worth more than the street would
really pay for it, and anything that is not farming is taken out. The code: `packages/shared/src/league.ts`
(book values, windows, the canonical standings), `apps/server/src/game/league.ts` (entries, scoring,
closes, rewards), `apps/server/src/game/fresh.ts` (Fresh Start), migration 19
(`apps/server/src/db/migrations.ts`), and `GET /api/leaderboard` (`apps/server/src/net/server.ts`).

## Scoring

A farm's score in a window is

    score = net worth at the end - net worth at the start - what is taken out

all in whole milli-coins (a thousandth of a coin). The end is the window's close, or the moment the
farm went bust (its score freezes then), or now while the window is open (live ranks).

### Book values (`LEAGUE_BOOK`)

| What the farm holds | Counts for |
| --- | --- |
| Coins | themselves (an AI farm's may be below zero) |
| Eggs, in the crate and left in open sell orders | 0.4 of the base price: white 0.40, cream 0.48, brown 0.60, golden 2.40 |
| Feed, per gram | its bag's list price over 25,000 g: cheap 70, standard 100, premium 140 a bag |
| Hens alive | 4 each (the auction price: 8 times 0.5) |
| Coops | their price: starter 0, red 150, deluxe 450 |
| Machines owned | their price, whatever their condition: conveyor 40, grader 80, cart 35, hopper 60, clerk 60 |
| Land | what the farm paid for it |
| Open debt (due less paid) | taken off |

Eggs are deliberately cheap at book: a farm that sells to the street at the live price earns more
than the eggs counted for, so selling is profit and hoarding is not.

### What is taken out (anti-pumping)

- **Player-to-player trades, both ways.** Two farms could otherwise pump one of them up by trading
  eggs at a silly price (one sells at five times the price, the other pays it). For every trade with
  `via = 'player'` between two player farms (guest farms are player farms) from the entry's start to
  its end, the seller has `total - qty x egg book` taken out and the buyer `qty x egg book - total`
  (signed). The net effect of the trade on either score is zero. This is worked out when the board is
  read, from the trades table, so nothing is stored for it. A player buying an AI farm's eggs, or
  selling to the street, a buyer or a contract, counts as usual.
- **Fresh Start grants** (below): the farm's net worth just after a Fresh Start less just before (the
  coins, the feed and the hens it was given, and the credit written off) is added to
  `excluded_milli` of its open entries.

### Ties

Equal scores go to the higher management score (the one that grades a Feather), then the farm that
started earlier in the window, then the farm id. Every rank is unique.

## Windows

- **Weeks** run from Monday 00:00 UTC to the next Monday 00:00 UTC. Id `w-YYYY-MM-DD` (its Monday).
  Its number counts from the first league week (1): the week starting on the first Monday 00:00 UTC
  at or after `LEAGUE_START`.
- **Warm-up weeks**: weeks that start before `LEAGUE_START` (numbered 0, -1, ...). They are scored and
  shown, and give no rewards.
- **Seasons** are `LEAGUE_SEASON_DAYS` long (default 14, 1 to 90), season n from
  `LEAGUE_START + (n - 1) x days` to `LEAGUE_START + n x days`. Id `s-<n>`. No season runs before
  `LEAGUE_START` (the season board shows none, and when season 1 starts).
- `LEAGUE_START` defaults to 2026-11-16T00:00:00Z (a Monday). Both are server settings (`.env.example`).

When a window opens, every open farm gets an entry at its net worth then. A farm made later (a new
player, a guest, an AI farm entering the street) gets an entry in every open window when it is made,
at its starting net worth, so it starts at zero. Entries hang off the farm, so a guest farm carried
into an account keeps them. A farm that goes bust (an AI farm that broke, an idle guest farm, a farm
its player chose not to keep) has its open entries frozen at its net worth just before its hens go to
auction, tagged bust, and gets no entry in later windows.

At each day close every open entry keeps its rank as `prev_rank` (the arrows: up or down against
yesterday), and a player whose farm moves into the week's top 10 (from below, or new) hears it.

### The close

The game checks once a second (an in-memory time, so it costs nothing) whether an open window has
ended. A close runs in one transaction: it claims the window (`status` open to closed: a second close
of the same window, from a restart or a second server, does nothing), fixes every entry's end net
worth, score, rank and bust count, hashes a season's standings, gives the rewards, and opens the
current windows. At boot the same catch-up closes any window that ended while the server was down
(at what every farm held then: nothing moves while it is down), then opens the current ones. Weeks
the server missed entirely are skipped.

## Rewards

Players only: AI farms rank but take nothing, and neither does a farm that is bust; the next player
takes the slot. Warm-up weeks give nothing. Each reward is recorded once in `league_rewards`.

- **Week**: the top 3 players win a Feather Ticket each (milestone `league-week`), held, as a
  milestone win is, and only while the 777 have room (featherCount's issuable). Guests win them too;
  minting needs sign-in, as always. A player in the top 10 whose farm has gone bust before (`busts`
  above 0, a Fresh Start say) gets the **COMEBACK** badge.
- **Season**: the top 10 players get a grade step: their next Feather redemption grades one step
  higher than the management score gives (fluff, plume, quill, golden-quill; never past
  golden-quill), then the step is used up. Every player farm that sold eggs in the season (a ledger
  `sale` in it) gets the season's badge `season-<n>`: gold for the first player, silver for the top
  10, bronze for the rest.

## Fresh Start

A player farm (not bust) is at a **dead end** when all of these hold:

- it has no eggs (in the crate or left in open sell orders);
- either it has no hens and fewer coins than the cheapest hen in the shop (8, or 4 at auction), or it
  has hens with no feed in any tier, none eaten today, fewer coins than the cheapest bag it could buy
  (any supplier with the tier in stock, or the mill, less the hopper's discount), and no credit from
  the Loyalist (none open with stock, or one bag would take it past its credit limit);
- no goal is ready to claim.

Then `FarmState.freshStart` is true and the player may take a Fresh Start (action `freshStart`):
open orders are cancelled (eggs back to the crate), contracts cancelled, unpaid credit marked
defaulted (as a bust does), and the farm gets 50 coins (ledger kind `fresh-start`), 25 kg of standard
feed and hens up to 10. It counts as a bust: `busts` goes up by one, shown on the leaderboard, the
market's farms ranking and the public profile. What it was given is taken out of its league profit.

## Bust count

`farms.busts` counts every time a farm went bust: an AI farm that broke (`bustIfBroke`), a guest farm
idle for seven days or one retired when its player kept another farm (`retireFarm`), and every Fresh
Start. Farms already bust when migration 19 ran count one.

## On chain: a season's standings

A closed season's canonical standings are the JSON text

    JSON.stringify({ board: 'season', id, seq, startsAt, endsAt, entries })

where `entries` is every farm by rank, ascending, each `[farmId, scoreMilli, rank, busts]` (its bust
count at the close), and `startsAt` and `endsAt` are the window's milliseconds since the epoch. For
example:

    {"board":"season","id":"s-1","seq":1,"startsAt":1794787200000,"endsAt":1795996800000,"entries":[["f1",15000,1,0],["f2",5000,2,1]]}

`standings_sha256` is the SHA-256 (lowercase hex) of that text. After the close commits, the game
sends one `settle_day` call to the game contract with `{ season: 'league', day: <season number>,
digest: <the hash> }` and nothing else (paced, retried with backoff while the RPC refuses). The call
and its status are kept on the window (`chain_tx`, `chain_status`); a failed call is sent again at
the next boot (and at the next close). The contract's `season_head({"season":"league"})` keeps the
last league season stored and its digest.

### Recomputing the hash

`GET /api/leaderboard?board=season&id=s-<n>` gives the closed season's window (`id`, `seq`,
`startsAt`, `endsAt`, `standingsSha256`, `chainTx`) and its entries (`farmId`, `scoreMilli`, `rank`,
`busts`, among others). Rebuild the text above from them (entries by rank) and hash it.
`scripts/league-hash.ts` does exactly that, read only:

    npx tsx scripts/league-hash.ts --id s-1 [--base https://yolkstreet.25th.dev] [--chain]

It prints the SHA-256, whether it matches the published `standingsSha256`, and with `--chain` the
contract's `season_head` for `league` (a view call through the public testnet RPC; the contract is
the one the server names at `GET /api/feathers`, or `--contract`).

## The API

`GET /api/leaderboard?board=week|season&id=<window id>` (public, no player ids, wallets or coins):

    {
      board: 'week' | 'season',
      window: { id, seq, startsAt, endsAt, warmup, status: 'open' | 'closed', standingsSha256, chainTx } | null,
      entries: [{ rank, farmId, name, kind: 'player' | <AI kind>, guest, bust, busts, scoreMilli, prevRank }],
      next: { weekEndsAt, seasonStartsAt, seasonEndsAt },
      past: [{ id, seq, endsAt, winner: { name, kind } | null, standingsSha256, chainTx, explorerUrl }]
    }

Without `id`: the open window of the board (else the last closed one); `window` is null on the
season board before the first season. Entries are by rank: live ranks while open, the final ones
once closed. `past` is the last ten closed windows of the board, newest first. A board other than
week or season is 400; an id that is no window of that board is 404.
