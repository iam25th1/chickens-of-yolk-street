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
| Settlements with version 4: no storage (one fixed-size head per season) and about 0.0004 NEAR of gas per settled day, 480 days a real day at 3-minute days | about 0.19 a real day |
| Settlements with version 2 (before 12 November): 179 bytes of state and 0.0004 NEAR of gas per settled day | about 1.06 a real day |
| Feathers (3,169 bytes each with the card image, measured in the sandbox; 777 ever, at most 20 a day close) | about 0.032 each, about 24.6 for all 777 |
| Agent wallets: 7 at first, one more per bust (`AGENT_ACCOUNT_FUNDING_NEAR`, default 0.05 each) | about 0.35 |
| Margin under which Feather mints and agent wallet links wait (`CHAIN_MIN_BALANCE_NEAR`, default 0.5) | 0.5 |

Gas is the only steady cost now: about 0.19 NEAR a real day at 3-minute days. Each Feather mint keeps
`CHAIN_MINT_NEAR` (default 0.035) free above the margin; redeemed tickets that cannot be minted yet wait for a later day
close and nothing is lost. If the account cannot pay for a day's gas or a mint's storage, that day's settlement fails and
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

## Upgrading a version 1 contract (done, 11 November 2026)

Version 1 settled days without seasons. The version 2 wasm was deployed over it with `migrate` in the
same transaction (version 4's `migrate` reads version 2, so a version 1 contract now goes through
version 2 first):

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
