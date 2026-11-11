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
| Contract code storage (about 342 KB) | about 3.5 |
| Hen NFTs (about 2.5 KB of state each with their portrait and indexes; at most `CHAIN_HEN_MINTS_PER_DAY`, default 12, a day) | about 0.3 a day at the cap |
| Agent wallets: 7 at first, one more per bust (`AGENT_ACCOUNT_FUNDING_NEAR`, default 0.05 each) | about 0.35 |
| Reserve below which hen mints and new agent wallets wait (`CHAIN_MIN_BALANCE_NEAR`, default 2) | 2 |

12 NEAR runs about three weeks at the mint cap (measured on `coys-game.testnet`: 36 hens and three days of balances took about 92 KB). When the balance falls under the reserve the
server keeps settling eggs and logs that hen mints wait; top up and they catch up.

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

## Upgrading a version 1 contract

Version 1 settled days without seasons. Deploy the current wasm over it and run `migrate` in the same
transaction:

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
- `mt_batch_balance_of({ "account_id": "...", "token_ids": ["egg-white", "egg-cream", "egg-brown", "egg-golden"] })`
