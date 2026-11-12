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
| Contract code storage (version 3: 351,309 bytes) | about 3.5 |
| Settlements: 179 bytes of state and 0.0004 NEAR of gas per settled day (measured on `s1`), 480 days a real day at 3-minute days | about 1.06 a real day |
| Founding Hens (2,647 bytes of state each with portrait and indexes, measured; 777 ever, at most 20 a day close) | about 0.026 each, about 20.6 for all 777 |
| Agent wallets: 7 at first, one more per bust (`AGENT_ACCOUNT_FUNDING_NEAR`, default 0.05 each) | about 0.35 |
| Margin under which Founding Hen mints and agent wallet links wait (`CHAIN_MIN_BALANCE_NEAR`, default 1.25) | 1.25 |

The settlements are the steady cost: at 3-minute days the game account spends about 1.06 NEAR a real day, so keep a
week of it on hand. Each Founding Hen mint keeps `CHAIN_MINT_NEAR` (default 0.03) free above the margin; hens that cannot
be minted yet wait for a later day close and nothing is lost. If the account cannot pay for a day's state, that day's
settlement fails and the next one catches it up once topped up.

## Agent wallets

At the first day close the server creates one funded sub-account per open agent under the signing
account: `bakery1.play.coys-game.testnet`, `loyalist1...`, `oldmoney1...`, `squeezer1...`,
`trader1...`, `upstart1...`, `wholesaler1...`. A successor after a bust gets the next generation
(`upstart2...`). Their keys are derived from the game key with HMAC-SHA256, so nothing new is
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

## Upgrading version 2 to version 3 (the Founding Hens)

Version 3 mints only Founding Hens, 777 ever, and refuses ordinary hen mints. Its `migrate` reads
version 2 state (the code running on `play.coys-game.testnet` and `coys-game.testnet`, kept byte for
byte in `contracts/sandbox-tests/res/coys_game_v2.wasm` and upgraded in the sandbox tests). After the
game account is topped up:

```powershell
npm run deploy-contract -- --wasm contracts/coys-game/res/coys_game.wasm --account play.coys-game.testnet --migrate
```

Tokens, egg balances, days and the owner stay. `play.coys-game.testnet` minted no ordinary hens
(`nft_total_supply` is 0: mints waited for funds), so every token it ever holds is a Founding Hen;
on `coys-game.testnet` the 86 ordinary hens version 2 minted keep their `hen-<id>` tokens outside the 777. Check `founding_supply()`. The server reads it at every day close
and starts minting waiting Founding Hens on its own. Details: [docs/founding-hens.md](../docs/founding-hens.md).

## Upgrading a version 1 contract (done, 11 November 2026)

Version 1 settled days without seasons. The version 2 wasm was deployed over it with `migrate` in the
same transaction (version 3's `migrate` reads version 2, so a version 1 contract now goes through
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
- `day_record({ "season": "s1", "day": 1 })`
- `nft_total_supply()`, `nft_tokens_for_owner({ "account_id": "..." })`
- `founding_supply()` (version 3): `{ "minted": n, "max": 777, "remaining": 777 - n }`
- `mt_batch_balance_of({ "account_id": "...", "token_ids": ["egg-white", "egg-cream", "egg-brown", "egg-golden"] })`
