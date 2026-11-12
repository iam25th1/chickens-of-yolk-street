# Mainnet deploy checklist (Founding Hens contract)

Nothing in this repository has touched mainnet, and nothing here should be run against it until
the owner decides to. The contract and the server are written to be mainnet-ready; this is the
list to work through, in order, when that day comes. Every step is the owner's.

## 1. Decide, before any code moves

- [ ] The owner (25TH) approves going to mainnet, in writing.
- [ ] Choose the mainnet contract account (for example `founding.<owner>.near`), a fresh account
      that holds nothing else. Testnet accounts and keys are never reused on mainnet.
- [ ] Decide who owns the contract: a separate key held offline, or a multisig, not the server's
      hot key. The server's key only needs `settle_day` (see 4).
- [ ] Decide the day length. At 3-minute days the game settles 480 times a real day: measured on
      testnet, 179 bytes of state and 0.0004 NEAR of gas per settled day, about **1.06 NEAR a
      real day**. On mainnet settle less often (longer days, or one settlement covering several
      days) before launch.
- [ ] Legal and product review of the wording: the Founding Hens are game items, not investments;
      odds (30% per milestone) and the 777 cap are published in the game and in this repo.

## 2. Build

- [ ] Build reproducibly: `cargo near build reproducible-wasm` (the testnet CI uses
      `non-reproducible-wasm`). Record the wasm sha256 and the commit.
- [ ] Run `cargo test --locked` in `contracts/coys-game` (11 unit tests) and the sandbox tests in
      `contracts/sandbox-tests` against that exact wasm (mint 777, refuse the 778th; upgrade from
      version 2; access control).
- [ ] Have the contract reviewed by someone other than its author: owner checks, the 777 `require!`,
      `migrate`, storage paid from the contract's balance (`internal_mint_with_refund`).

## 3. Fund

- [ ] Code storage: about 351 KB, about **3.6 NEAR**.
- [ ] All 777 Founding Hens: 2,647 bytes each with a full portrait (measured in the sandbox), about **20.6 NEAR** for the lot.
- [ ] Settlement runway: about 1.06 NEAR a real day at 3-minute days (see 1), much less with
      longer days. Keep at least a week of it.
- [ ] Agent wallets: 0.05 NEAR each (`AGENT_ACCOUNT_FUNDING_NEAR`), 7 at first.
- [ ] Set `CHAIN_MIN_BALANCE_NEAR` to the runway you want kept free, and `CHAIN_MINT_NEAR` to the
      measured cost of one mint (0.03 covers the 2,647 bytes measured).

## 4. Deploy

- [ ] Write a mainnet deploy script on purpose: today's `scripts/deploy-testnet-contract.ts` and
      the server's `assertTestnetConfig` **refuse** any non-testnet account or RPC, by design. Do
      not loosen those checks in place; add a separate mainnet path with its own explicit flag and
      a typed confirmation.
- [ ] Deploy and call `new(owner_id)` with the owner chosen in 1.
- [ ] Give the server a function-call access key limited to `settle_day` on the contract, with an
      allowance, instead of a full-access key.
- [ ] Point a separate server deployment at mainnet with its own database and season. Never point
      the testnet database at mainnet: its seasons, hens and egg balances belong to testnet.

## 5. Check

- [ ] `founding_supply()` returns `{"minted":0,"max":777,"remaining":777}`.
- [ ] `nft_metadata()` names "Yolk Street Founding Hens".
- [ ] One settled day from the server lands (`last_settled_day`), with no ordinary hen minted.
- [ ] Logs show `[founding]` lines with seed and anchor for every roll; spot-check one by hand
      (docs/founding-hens.md, "The roll, and how to audit it").
- [ ] The explorer link in the ledger points at the mainnet explorer.

## 6. Afterwards

- [ ] Watch the free balance against `CHAIN_MIN_BALANCE_NEAR`; mints and wallet links wait
      (logged) when it is under the margin, and settlements fail if the account cannot pay for
      its state.
- [ ] Keep the testnet contract running for the beta; mainnet is a new collection that starts at
      #1 of 777.
