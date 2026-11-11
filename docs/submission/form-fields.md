# Submission form: drafted fields

Draft only. Nothing has been submitted. **The submission cannot be edited after it is sent**, so
check every field, and the repo and video links, before pressing submit.

`HACKATHON.md` (the source of the field list) is not on the machine this was drafted on, so the
fields below are the ones the build brief named. Compare them with `HACKATHON.md` and add any field
it lists that is missing here.

No personal data is written in this file: the blanks stay blank in the repo and are filled in only
on the form itself.

| Field | Value |
|---|---|
| Project name | Chickens of Yolk Street |
| Team size | 1 |
| Tracks | games, agents, nfts |
| Description (20 to 2000 characters) | see below (1,198 characters) |
| Email | _blank: fill in on the form_ |
| NEAR mainnet payout account | _blank: fill in on the form (the game itself never touches mainnet)_ |
| Repository URL | _blank: the GitHub URL once the repo is public or shared with the judges_ |
| Demo post URL | _blank: the X post with the demo video ([x-post.md](x-post.md))_ |
| Website | **leave empty** (the form requires it to stay empty) |

## Description

```text
Chickens of Yolk Street is an egg farm in one shared live market where every rival, supplier and buyer is an AI agent with its own cash, memory and NEAR wallet. Prices, gluts and bankruptcies come only from what everyone trades: every egg sold by a player or an agent is supply in the same market, so flooding the street crashes the price for all.

Agents decide once a day on NEAR AI Cloud as validated structured JSON (with rule fallbacks and a hard spend cap), pay for their thinking, remember every farm and haggle in character through decision cards: the Squeezer prices your hunger into your feed, the Bakery holds you to standing contracts, the Wholesaler resells into gluts, and the Upstart borrows, overbuilds and goes bust, its hens sold at auction.

On NEAR: players sign in with email through Privy and get a testnet wallet silently. Hens are NEP-171 NFTs with their portrait in the metadata, eggs are NEP-245 tokens, agents hold sub-account wallets, and each in-game day settles in one batched call keyed by season and day. Contract deliveries move egg tokens from the player's wallet to the Bakery's on chain. Built in TypeScript, Rust (near-sdk) and PixiJS, with sandbox tests in CI.
```
