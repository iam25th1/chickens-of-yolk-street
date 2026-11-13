# Game contract on NEAR testnet

Testnet only. Every script here refuses mainnet account ids, non-testnet names and non-testnet RPC
endpoints before a key is used.

## The artifact

CI builds the contract on every push (`cargo near build`, Rust 1.99.1) and uploads it as the
`coys-game-wasm` artifact. The build that is meant to be deployed is committed at
`contracts/coys-game/res/coys_game.wasm` with its sha256 in `coys_game.wasm.sha256`; the deploy
script refuses a wasm whose hash does not match.

## Production gets its own contract account

Production writes to its own account so its seasons, hens and egg tokens never mix with the demo
contract on `coys-game.testnet`. The example below uses `play.coys-game.testnet`, a sub-account
created with the same public key as `coys-game.testnet`, so the existing
`NEAR_TESTNET_PRIVATE_KEY` signs for it and no new secret is made.

1. Top up `coys-game.testnet` from a NEAR testnet faucet. Creating the account needs the funding
   below plus a little gas; `coys-game.testnet` itself holds about 4.2 NEAR for its own storage.
2. Create the account, deploy the committed wasm and initialise it (PowerShell, from the repo root;
   `.env` supplies `NEAR_TESTNET_ACCOUNT_ID=coys-game.testnet` and its key):

   ```powershell
   npm run deploy-contract -- --wasm contracts/coys-game/res/coys_game.wasm --account play.coys-game.testnet --create --fund 12
   ```

   The script prints the transaction and its explorer link. The contract's owner is
   `play.coys-game.testnet` itself.
3. Point the production server at it:

   | Variable | Value |
   |---|---|
   | `NEAR_TESTNET_ACCOUNT_ID` | `play.coys-game.testnet` |
   | `NEAR_TESTNET_PRIVATE_KEY` | the same `ed25519:...` key as `coys-game.testnet` |
   | `NEAR_GAME_CONTRACT_ID` | leave empty (defaults to the account above) |
   | `GAME_SEASON` | `s1` |

### What the funding pays for

| Item | NEAR |
|---|---|
| Contract code storage (version 4: 353,408 bytes) | about 3.5 |
| Settlements since version 4: no storage (one fixed-size head per season) and 0.00081 to 0.00087 NEAR of gas per settled day (measured 13 November 2026), 480 days a real day at 3-minute days | about 0.40 a real day |
| Settlements with version 2 (before 12 November): 179 bytes of state and 0.0004 NEAR of gas per settled day | about 1.06 a real day |
| Feathers (1,913 to 2,075 bytes each with the card image and 0.0004 to 0.0005 NEAR of gas, measured on testnet; 777 ever) | about 0.021 each, about 16.5 for all 777 |
| Agent wallets: 7 at first, then one only when no wallet in the pool is free (`AGENT_ACCOUNT_FUNDING_NEAR`, default 0.01 each) | 0.01 each |
| Margin kept for settlements, under which Feather mints and agent wallet links wait (`CHAIN_MIN_BALANCE_NEAR`, default 0.1: about 120 day closes) | 0.1 |

Gas is the only steady cost now: about 0.40 NEAR a real day at 3-minute days. Each Feather mint keeps
`CHAIN_MINT_NEAR` (default 0.027, its measured cost and a quarter more) free above the margin, so a mint goes out at
0.127 NEAR free (it used to wait for 0.535) and a new agent wallet is made at 0.11 (it used to wait for 0.55); a mint
that cannot go out yet waits for a later chance and nothing is lost. If the account cannot pay for a day's gas or a mint's storage, that day's settlement fails and
the next one catches it up once topped up.

## Agent wallets

At the first day close the server creates one funded sub-account per open agent under the signing
account: `bakery1.play.coys-game.testnet`, `loyalist1...`, `oldmoney1...`, `squeezer1...`,
`trader1...`, `upstart1...`, `wholesaler1...`. A successor after a bust gets the next generation
(`upstart2...`) only when no earlier agent of its kind has a wallet: a successor after a bust takes over its
predecessor's wallet, since rivals go bust often (about 30 times a real day on `s1`) and a funded account each time would
cost about 0.057 NEAR. Their keys are derived from the game key with HMAC-SHA256, so nothing new is
stored. Only the parent can create its sub-accounts, which is why the signing account and the
contract account are the same.

## Seasons

A season is one game world from day 1. The contract keys every settled day by (season, day), so a
new season starts again at day 1 on the same contract while each day of a season still lands once.

- One database holds one season. A fresh database takes `GAME_SEASON` (or makes a unique
  `dev-...` season when it is unset, outside production).
- A server pointed at a database from another season refuses to start and says which season the
  database holds.
- To start season 2: a fresh `DATABASE_URL` and `GAME_SEASON=s2`, same contract.
- Egg tokens and hens from earlier seasons stay with their holders.

## Upgrading version 2 to version 4 (the Feathers, compact settlement): done 12 November 2026

Version 4 settles a day by storing only a fixed-size head per season (last day, its settlement digest and a running
hash chain), mints the Feathers (777 ever, capped on chain) and refuses ordinary hens. Its `migrate` reads version 2
state (the code running on `play.coys-game.testnet`, kept byte for byte in
`contracts/sandbox-tests/res/coys_game_v2.wasm` and upgraded in the sandbox tests). Version 3 (the Founding Hens) was
never deployed. On `play.coys-game.testnet`:

```powershell
npm run deploy-contract -- --wasm contracts/coys-game/res/coys_game.wasm --account play.coys-game.testnet --migrate
```

Done on 12 November 2026 at 20:30 UTC:
[9jsFd4EA...](https://testnet.nearblocks.io/txns/9jsFd4EAZc3nkE4v11x4poVTMhLyYzPpuZKrsCud9J4s) (wasm sha256
`e57cda66...`). Egg balances, days and the owner stay. `migrate` refuses a version 2 contract that still holds hen
tokens: `play.coys-game.testnet` held none, while `coys-game.testnet` keeps its 86 ordinary version 2 hens and stays on
version 2. The running server kept settling through the upgrade (version 4 accepts version 2's batch shape).

Then, once, the founders provenance (the SHA-256 of `apps/server/data/founders.json`):

```powershell
npm run commit-provenance -- --account play.coys-game.testnet
```

Done: [JBoKNVa6...](https://testnet.nearblocks.io/txns/JBoKNVa6Pi5jAb2BA4chAh8K43GGpWgw8AtHJy26b5AB), hash `bd2daafd...`.

### Releasing version 2's day records

Version 2 stored a record per settled day (179 bytes each). Version 4 can release them, folding each record into the
season's archive hash so the history stays verifiable. The script copies every record exactly as `day_record` returns it
into the game database (`chain_archive`, migration 9) and a backup file first, then releases them in chunks and checks
the contract's archive hash after each one:

```powershell
npm run release-chain-days -- --account play.coys-game.testnet --season s1 --backup <backup file>
```

It needs `DATABASE_URL` (the live game database) as well as the signing key. Done on 12 November 2026 for `s1` days 1 to
489 in three transactions ([F6VE65CK...](https://testnet.nearblocks.io/txns/F6VE65CKSg3bGsau1P9u9MZGyEjxWPu8XXG2SH4yohxq),
[7RHumWmX...](https://testnet.nearblocks.io/txns/7RHumWmXks3QS9YmfnqLCewaqKGcQVzdoDTb1aPoZxtf),
[3Wva5eNt...](https://testnet.nearblocks.io/txns/3Wva5eNte8hmPsb6CEh7Unk1nr1WVmET36px94ysjZuC)): about 87,600 bytes back,
archive `cfe525e7...`, equal to the fold over `chain_archive`. To check it later: fold the rows of
`chain_archive` for the season in day order, $a_d = \mathrm{SHA256}(a_{d-1} \,|\, d \,|\, \text{record}_d)$ from 64
zeros, and compare with `season_head({ "season": "s1" }).archive`.

### Version 5: test Feathers burnt, a live season, missed days recorded late

Version 5 (`contracts/coys-game`, CI build `7fa2c060...abbfa2d`) adds, all owner only:

- `set_live_season(season)`: from then on only that season's day closes mint Feathers, and a Feather belongs to the
  season that mints it, so a test season can never mint against the real 777 (the server also sends no mints for a
  season that is not the live one);
- `burn_test_feathers(token_ids)`: burns Feathers of any season but the live one and returns their numbers to the
  supply (reused smallest first; `feather_supply().minted` counts only Feathers that exist);
- `settle_late_days(season, days)`: records closed days whose day close failed, once the season has moved past them,
  by each day's settlement digest, folded into `late_days(season).hash`
  ($h_i = \mathrm{SHA256}(h_{i-1} \,|\, \text{season} \,|\, \text{day}_i \,|\, \text{digest}_i)$ from 64 zeros).

Its `migrate` reads version 4 (kept byte for byte in `contracts/sandbox-tests/res/coys_game_v4.wasm` and upgraded in the
sandbox tests); `migrate_v2` reads version 2. Done on `play.coys-game.testnet` on 12 November 2026, each right after a
day close so the server's own call never met these:

| Step | Transaction |
|---|---|
| `npm run deploy-contract -- --wasm contracts/coys-game/res/coys_game.wasm --account play.coys-game.testnet --migrate` | [4h7ZEQkP...](https://testnet.nearblocks.io/txns/4h7ZEQkPG66zVmNrNvLr8W3b9dyBYmQoFibEBFCWuN92) |
| `set_live_season({"season": "s1"})` | [6WTTxYay...](https://testnet.nearblocks.io/txns/6WTTxYaySdGt8DggxzAgGCzYJb5AUg1VxUV1QS3SVGxF) |
| `burn_test_feathers({"token_ids": ["001", "002", "003"]})` (the test season `verify-feathers-1`): 0 minted, 777 remaining | [2uVuUnQ5...](https://testnet.nearblocks.io/txns/2uVuUnQ52oEQGrgfozpL83PhKw3duat69eB1HZzkdzVo) |
| `npm run settle-late-days -- --season s1`: days 509 and 510, late hash `5f5dbd6d...` | [ANKGbgth...](https://testnet.nearblocks.io/txns/ANKGbgthoMpqTw6M6CmZQRz87NKWYqBhyjebMdYjaM8g) |

The upgrade took about 34,900 bytes more (the larger code; about 0.35 NEAR held for storage); the burn gave back the
three Feathers' storage. `settle-late-days` needs `DATABASE_URL` as well as the signing key, and `--dry-run` lists the
missed days and their digests without signing. The server does the same at each day close that settles (one paced call),
unless the contract's count of settled days disagrees with the database.

## Upgrading a version 1 contract (done, 11 November 2026)

Version 1 settled days without seasons. The version 2 wasm was deployed over it with `migrate` in the
same transaction (a version 1 contract now goes through version 2 first; version 5's `migrate_v2` reads version 2):

```powershell
npm run deploy-contract -- --wasm contracts/coys-game/res/coys_game.wasm --account coys-game.testnet --migrate
```

Hens, egg balances and the owner stay; the version 1 days become the season `legacy`, and a
database from before seasons carries on as `legacy` too. `coys-game.testnet` was upgraded this way
on 11 November 2026:
[HXYRgKDn...](https://testnet.nearblocks.io/txns/HXYRgKDnKS7TveYSwDHQp31nsNtzx2jnw64F2hUA39Cf).

## Checking it on chain

View calls on the contract account:

- `last_settled_day({ "season": "s1" })`
- `season_head({ "season": "s1" })` (version 4): last day, its digest, the hash chain of every day settled since the
  upgrade, and the archive hash of the released version 2 records
- `day_record({ "season": "s1", "day": 1 })` (version 2 records, until released)
- `feather_supply()` (version 4): `{ "minted": n, "max": 777, "remaining": 777 - n, "provenance": "..." }`
- `nft_total_supply()`, `nft_tokens_for_owner({ "account_id": "..." })`, `nft_token({ "token_id": "001" })`
- `mt_batch_balance_of({ "account_id": "...", "token_ids": ["egg-white", "egg-cream", "egg-brown", "egg-golden"] })`

A day's digest is the SHA-256 of `market_days.settlement_json` in the game database; the hash chain is
$c_d = \mathrm{SHA256}(c_{d-1} \,|\, \text{season} \,|\, d \,|\, \text{digest}_d)$ from 64 zeros at the first version 4 day.
