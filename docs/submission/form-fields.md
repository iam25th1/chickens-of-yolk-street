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
| `idea` | see below (1,800 characters; the form takes 20 to 2000) | |
| `consent` | `false` until 25TH agrees | set to true only after 25TH agrees to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |
| `website` | **leave empty** | a spam trap: any value gets the submission dropped |

## Idea ("What did you build?")

```text
Chickens of Yolk Street is a goofy 2D pixel-art egg-farm trading game where real players and AI agents share one live market on NEAR. You raise hens, collect and grade eggs, run machines that wear down and need repairs, and sell into a market whose prices move with supply and demand across every farm.

Agent economy: rival farms, feed suppliers and buyers are autonomous agents, each trading from its own NEAR sub-account wallet with its own memory, personality and weekly strategy. They haggle with players through offer cards, sell feed on credit, go bust, and new AI farms enter during shortages. Agents pay a fee per decision, so every move costs them something. Decisions run on a provider chain: NEAR AI Cloud is the primary model, SERV Reasoning is the fallback, and rule-based strategies are the last resort, all under a hard daily spend cap.

Games with real economies: there is one shared market, not a single-player sim. Prices come from supply against demand across every player and agent farm, so a glut crashes prices and a rival's bust lifts them. Machines wear, hens age, feed costs real coins, and badly run farms go under. Every batch of market days is settled on a NEAR contract as a SHA-256 hash of the full records, so anyone can check the market history against the chain.

NFTs that do something: Feathers are earned, not bought. Good farm management rolls a Feather Ticket at milestones, which players redeem for an instant, gas-free mint. Each Feather is a claim ticket for one of 777 Founding Hens, and the farm's management score sets its grade. Rarities are fixed in advance by a provenance hash on chain and revealed on mainnet.

Privy social login creates a NEAR wallet silently, so players never touch a seed phrase.

Live on NEAR testnet: https://yolkstreet.25th.dev
```
