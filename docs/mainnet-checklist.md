# Mainnet deploy checklist (the Founding Hens)

Nothing in this repository has touched mainnet, and nothing here should be run against it until
the owner decides to. The beta runs the Feathers on testnet; at the mainnet launch they are planned
to be revealed and minted as the 777 Founding Hens ([mainnet-plan.md](mainnet-plan.md): snapshot,
reveal seed, claim, sybil checks). This is the list to work through, in order, when that day comes.
Every step is the owner's.

## 1. Decide, before any code moves

- [ ] The owner (25TH) approves going to mainnet, in writing.
- [ ] Choose the mainnet contract account (for example `founding.<owner>.near`), a fresh account
      that holds nothing else. Testnet accounts and keys are never reused on mainnet.
- [ ] Decide who owns the contract: a separate key held offline, or a multisig, not the server's
      hot key. The server's key only needs `settle_day` (see 4).
- [ ] Decide the day length. Contract version 4 stores nothing per settled day (a fixed-size head
      per season), so the steady cost is gas: about 0.0004 NEAR per settled day measured on
      testnet, about **0.19 NEAR a real day** at 3-minute days (version 2 also stored 179 bytes a
      day: 1.06 NEAR a real day). On mainnet settle less often (longer days, or one settlement
      covering several days) before launch.
- [ ] Announce the snapshot block and the reveal seed block (a future mainnet block) together,
      days ahead ([mainnet-plan.md](mainnet-plan.md), steps 2 and 4).
- [ ] Legal and product review of the wording: the Founding Hens are game items, not investments;
      odds (30% per milestone), the grade weights, the 7/70/200/500 split and the 777 cap are
      published in the game and in this repo, and the reveal is described as planned until it
      happens.

## 2. Build

- [ ] Build reproducibly: `cargo near build reproducible-wasm` (the testnet CI uses
      `non-reproducible-wasm`). Record the wasm sha256 and the commit.
- [ ] Run `cargo test --locked` in `contracts/coys-game` (18 unit tests) and `contracts/founding-hens`
      (10 unit tests, the reveal draw), and the sandbox tests in `contracts/sandbox-tests` against
      those exact wasms (777 Feathers then refuse the 778th; compact days store nothing; the
      upgrade from version 2 and the release of its records; the reveal gives exactly
      7/70/200/500 and the same hens from the same seed).
- [ ] Have both contracts reviewed by someone other than their author: owner checks, the 777
      `require!`, `migrate`, `prune_days`, storage paid from the contract's balance
      (`internal_mint_with_refund`), the reveal's draw and the claim check.
- [ ] Publish founders.json and check it against the provenance committed on testnet
      (`bd2daafd...`, `npm run generate-founders -- --check`).

## 3. Fund

- [ ] Code storage: about 351 KB, about **3.6 NEAR**.
- [ ] The Founding Hens are claimed by their holders, who pay each token's storage; budget a
      relayer if the owner sponsors claims.
- [ ] Settlement runway (if the game itself settles on mainnet): about 0.19 NEAR of gas a real day
      at 3-minute days (see 1), much less with longer days. Keep at least a week of it.
- [ ] Agent wallets: 0.05 NEAR each (`AGENT_ACCOUNT_FUNDING_NEAR`), 7 at first.
- [ ] Set `CHAIN_MIN_BALANCE_NEAR` to the runway you want kept free, and `CHAIN_MINT_NEAR` to the
      measured cost of one mint (0.035 covers the 3,169 bytes a Feather measured).

## 4. Deploy

- [ ] Write a mainnet deploy script on purpose: today's `scripts/deploy-testnet-contract.ts` and
      the server's `assertTestnetConfig` **refuse** any non-testnet account or RPC, by design. Do
      not loosen those checks in place; add a separate mainnet path with its own explicit flag and
      a typed confirmation.
- [ ] Deploy the Founding Hens contract and call `new(owner_id, provenance, reveal_source,
      founder_rarity)` with the owner chosen in 1; `add_snapshot`, `seal_snapshot`, then
      `reveal(seed)` once the seed block exists.
- [ ] Give the server a function-call access key limited to `settle_day` on the contract, with an
      allowance, instead of a full-access key.
- [ ] Point a separate server deployment at mainnet with its own database and season. Never point
      the testnet database at mainnet: its seasons, hens and egg balances belong to testnet.

## 5. Check

- [ ] `status()` shows the provenance, the reveal source, the sealed snapshot count and the seed.
- [ ] `rarity_counts()` is `[7, 70, 200, 500]`; `scripts/lib/reveal.ts` run on the published
      snapshot and seed gives the same hen for every number (`reveals`).
- [ ] `nft_metadata()` names "Yolk Street Founding Hens".
- [ ] A test claim by a snapshot holder mints `hen-NNN`; a stranger's claim and a second claim fail.
- [ ] Logs show `[founding]` lines with seed and anchor for every roll; spot-check one by hand
      (docs/founding-hens.md, "The roll, and how to audit it").
- [ ] The explorer link in the ledger points at the mainnet explorer.

## 6. Afterwards

- [ ] Watch the free balance against `CHAIN_MIN_BALANCE_NEAR`; mints and wallet links wait
      (logged) when it is under the margin, and settlements fail if the account cannot pay for
      its state.
- [ ] Keep the testnet Feathers contract running for the beta; the mainnet Founding Hens are a new
      collection that reads only the published snapshot.
