# Submission form: drafted fields

**One submission per team. It cannot be edited after it is sent. The form closes 14 November 2026 at
23:59 UTC.** The form is at https://nearhackathon.com/#apply. Draft only: nothing has been submitted,
and only 25TH submits.

The field names below are the form's own (its contract). Blanks stay blank in the repo and are filled
in by 25TH on the form itself; no personal data is written here.

| Field | Value | Notes |
|---|---|---|
| `projectName` | Chickens of Yolk Street | |
| `leadName` | _blank_ | 25TH fills in |
| `email` | _blank_ | 25TH fills in |
| `size` | `"1"` | exactly the string 1 |
| `tracks` | `["games", "agents", "nfts"]` | |
| `nearAddress` | _blank_ | the NEAR **mainnet** payout account, created by 25TH only; the game never touches mainnet |
| `projectUrl` | https://github.com/iam25th1/chickens-of-yolk-street | the repo must be made public before submitting |
| `demoUrl` | _blank_ | the X post with the demo video ([x-post.md](x-post.md)) |
| `idea` | see below (1,198 characters; the form takes 20 to 2000) | |
| `consent` | `false` until 25TH agrees | set to true only after 25TH agrees to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |
| `website` | **leave empty** | a spam trap: any value gets the submission dropped |

## Idea

```text
Chickens of Yolk Street is an egg farm in one shared live market with other players and AI: some farms are other players, some are AI farms (marked AI), and the feed suppliers and egg buyers are AI agents, each with its own cash, memory and NEAR wallet. Prices, gluts and bankruptcies come only from what everyone trades: every egg sold by a player or an agent is supply in the same market, so flooding the street crashes the price for all.

Agents decide once a day on NEAR AI Cloud as validated structured JSON (with rule fallbacks and a hard spend cap), pay for their thinking, remember every farm and haggle in character through decision cards: the Squeezer prices your hunger into your feed, the Bakery holds you to standing contracts, the Wholesaler resells into gluts, and the Upstart borrows, overbuilds and goes bust, its hens sold at auction.

On NEAR: players sign in with email through Privy and get a testnet wallet silently. Hens are NEP-171 NFTs with their portrait in the metadata, eggs are NEP-245 tokens, agents hold sub-account wallets, and each in-game day settles in one batched call keyed by season and day. Contract deliveries move egg tokens from the player's wallet to the Bakery's on chain. Built in TypeScript, Rust (near-sdk) and PixiJS, with sandbox tests in CI.
```
