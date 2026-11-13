# Agents: what they see, how they decide, what it costs

Stage 4 of the brief: agent upgrades (observations, personas, one validated action schema, public
reasons, weekly reflections, model tiers, per-agent caps, better rules) and new AI farms entering the
street (registry, entry rule, the AI tag, a reusable wallet pool). This page also holds the 30-day
model-against-rules comparison and the NEAR AI credits the live server would need.

## What an agent sees

`AgentContext` in `apps/server/src/agents/decision.ts`, built by `buildContext` in
`apps/server/src/game/cast-runtime.ts`, sent whole to the model as the user message on every call
(numbers rounded to keep it small):

- **Itself**: cash, stock, whether it is struggling, its entrant key (AI farms that entered later),
  its latest **weekly reflection** and its **last three public reasons**.
- **The market**: the live multiplier and prices, demand (the reference supply), today's supply,
  seven days of history, crash flag, auction hens, and new:
  - `trend`: supply over demand for each of the last three closed days (above 1 a glut, below 1
    scarcity) and the multiplier's change per day across them;
  - `busts`: farms and agents that went bust in the last five days (name, AI or not, day);
  - `open`: open AI farms and open player farms.
- **Its own farm** (rivals) and **every other farm**: hens, coop room, crate, daily lay, days of
  feed, cash, quality, open sell orders, and its memory of each farm.

A decision prompt measured in the simulation is about 1,600 tokens: the system prompt about 640,
the observation the rest.

## Who they are

Each kind has a persona in `apps/server/src/agents/cast.ts` (goals, temperament, how it talks, what
it never does), and each entering AI farm its own in `apps/server/src/agents/entrants.ts`. The
system prompt (`SYSTEM` in `apps/server/src/agents/brain.ts`) carries it with the haggling numbers,
the market rules and what each role may do. Card lines and reasons stay in character; an agent too
broke to think says so in its own voice.

## One schema, one validation

`decisionSchema` (zod) is the only action schema: the model gets it as its strict `json_schema`
response format, and it now has `reason`, one public line under 80 characters. Every decision, from
the model or the rules, goes through `validateDecision(raw, ctx)`:

- free text is cleaned (no control characters, long dashes become commas, one line) and cut to its
  length without splitting a character (note 240, reason 80, card lines 160), then the schema is
  checked; a reply that does not match (or has a number out of range) falls back to the rules;
- only the agent's own role's parts are kept (farm actions and sell orders for rivals, buy orders and
  fills for buyers, restock and markup for suppliers, and each role's own offer kinds);
- offers go only to player farms the agent can see; fills only to sell orders it can see, no more
  than they hold; a rival sells no more eggs than it saw in its crate. Whatever is dropped is logged.

The game still bounds every number when it applies a decision (price bands, stock, cash).

## Reasons and reflections

- **Reasons**: every decision's `reason` (the rules write one too) is kept with the agent, the last
  five, and the newest is in `MarketState.agents[].reason`. The Market page's PRICES tab shows it
  under each agent in WHAT THE AI TRADERS SAY, upper case, wrapping inside the row of the paged list.
- **Weekly reflections**: every 7 in-game days per agent (`ECONOMY.agents.reflectEveryDays`), before
  its decision that day, the agent writes a reflection under 400 characters: what went well or badly
  and what it will change. The main model writes it when the caps allow; otherwise `ruleReflection`
  writes it from the agent's own numbers (cash at the start and end of the week, deals, refusals,
  busts seen, the multiplier's range and glut days), in character. It is stored on the agent, logged
  (`[agents] <name> reflects on its week (<model or rules>): ...`), and in the next observations.

## Model tiers and caps

| Call | Model | Default |
|---|---|---|
| Routine decision | cheap | `NEARAI_CHEAP_MODEL`, `z-ai/glm-5.3-flash` |
| Hard day: a crash or glut day (multiplier at or under 0.80, or today's supply past 1.1 x demand), or the agent's cash under its struggle line (40) | main | `NEARAI_MODEL`, `Qwen/Qwen3.6-35B-A3B-FP8` |
| Weekly reflection | main | as above |

A struggling agent still thinks only every other day. Caps, per UTC day:

| Cap | Variable | Default |
|---|---|---|
| Every agent together, USD | `NEARAI_DAILY_SPEND_CAP_USD` | 1 |
| One agent, USD | `NEARAI_AGENT_DAILY_CAP_USD` | a quarter of the global cap |
| One agent, calls | `NEARAI_AGENT_DAILY_CALLS` | 40 |

Past any cap the agent uses its rules, counted as a fallback (globally and for the agent, in
`agent_inference_usage`). Each call first reserves its most expensive cost (the prompt at 2
characters a token plus 64, and a full reply: 1,500 tokens for a decision, 200 for a reflection), so a
cap is never crossed. Prices come from `NEARAI_MAIN_PRICE` and `NEARAI_CHEAP_PRICE` ("input,output"
USD per million tokens) first, then `/v1/models`, then `ASSUMED_PRICING` in `brain.ts`; a model with
no known price is priced at 1 in, 5 out.

## Better rules

`apps/server/src/agents/rules.ts` keeps each character and reads the last three days, not only today:

- **Rivals** grow into lasting scarcity (their coop fill target rises) and stop buying hens and coops
  into a building glut; a holder (Old Money, Pennywise, the Cluck Collective) holds a little more
  while a glut builds. The Upstart still borrows and over-expands on a good week and still dumps in
  a glut: it is still the one that busts.
- **Suppliers** restock to the street's demand (five days of their half of what the farms eat, never
  under the old floor of 30 bags). The Squeezer still prices desperation in and adds 5% when its barn
  is thin; the Loyalist takes 3% off the list in a glut and offers credit first to a regular too short
  to pay for a bag now.
- **Buyers** bid deeper in a glut and lighter in scarcity: the Bakery and the Trader half as much
  again or half as much, on the trend; the Wholesaler twice as much or half, on the trend or the
  day's glut.

## AI farms that enter

- **Registry** (`apps/server/src/agents/entrants.ts`): Early Bird Eggs and the Cluck Collective look
  and sound like the Upstart, Gilded Roost Estates and Pennywise Poultry like Old Money (their
  portraits, signs and voices; no new art). Each has three names, a persona, its own haggling
  personality, a smaller starting farm and a few rule settings of its own. They are rival agents with
  `entrant_key` set; base cast members keep behaving as before (one per kind, replaced three days
  after a bust). A bust entrant is never replaced by the cast; only the entry rule brings new ones.
- **Entry rule** (`enterAiFarms` in `cast-runtime.ts`, at each day close, numbers in
  `ECONOMY.agents.entry`): while the AI farms (open, plus base rivals about to reopen) are under the
  cap of `max(4, floor(1.5 x open player farms))`, one enters with a 25% chance (the game's seeded
  rng) when supply stayed under demand for the last 3 closed days or a rival went bust in the last 5;
  under 2 open AI farms they enter whatever the chance until there are 2. Announced with `agentOpened`.
- **The AI tag** (`apps/client/src/ui/AiBadge.tsx`, `.ai-badge`): on AI farms in the farms ranking,
  every agent in the cast, AI owners in the order book, AI sellers and buyers in the big trades, and
  the ticker's farms item with the number of AI farms. Inline, 8 pixels high, no wrap.
- **Wallet pool** (`apps/server/src/chain/chain.ts`): any wallet whose agents are all bust (any kind)
  is free; a new agent takes a free one before a sub-account is created and funded. Every wallet is
  recorded in `agent_wallets` with its key seed and funding; `walletPool()` gives
  `{ poolSize, free, inUse, created, nearSpent }`, logged at each creation.

### Five seeds with entrants

`apps/server/test/sim.test.ts` (the existing 30-day simulation, entrants on), one run:

| Seed | Median | Lowest | Glut days | Rival busts | Entrants | Open AI farms after each day close |
|---|---|---|---|---|---|---|
| 1 | 1.16x | 0.48x | 8 | Upstart Eggs (day 14) | Early Bird Eggs (day 15), Gilded Roost Estates (day 19) | 2 x15, 3 3, 4 x13 |
| 2 | 1.11x | 0.46x | 8 | Upstart Eggs (12), Hatch and Dash (29) | Pennywise Poultry (13), Cluck Collective (15) | 2 x13, 4 x15, 3 3 |
| 3 | 1.16x | 0.49x | 10 | Upstart Eggs (15) | Cluck Collective (16) | 2 x16, 3 x14 |
| 4 | 1.10x | 0.46x | 7 | Upstart Eggs (21) | Pennywise Poultry (14), Gilded Roost Estates (24) | 2 x12, 3 x8, 2 2, 4 x8 |
| 5 | 0.97x | 0.40x | 7 | Upstart Eggs (14) | Pennywise Poultry (4), Early Bird Eggs (16) | 2 2, 3 x11, 2, 3, 4 x15 |

Checked on every run: the median over seeds of each seed's median between 0.80 and 1.30 (here
1.11x), glut days and a rival bust across the seeds (here 40 and 6), AI farms entered, and the count
always in [2, cap] (with two players the cap is 4). The per-seed checks from before (median in
range, a glut in every seed, rival busts in at least three seeds) still hold.

## Model against rules, 30 days

NEAR AI Cloud answers 402 (no credits), so the model's side replays recorded decisions.
`scripts/record-agent-decisions.ts` writes `apps/server/test/fixtures/agent-replies.json`: for each
kind and situation (glut, scarcity, normal) a few in-character decisions with reasons that differ
from the rules (price shares, holding, expansion timing), plus unusable replies and reflections.
Offline these are authored stand-ins (`apps/server/test/recorded-model.ts`); `--live` records them
from the main model with the real prompt once the account has credits (77 calls). The fake client
replays them by kind and situation, maps the sample ids to the live ones and keeps a reply's intent
on the live farm (share of the crate sold, days of feed, coop fill, share of cash on hens, stock
targets), and answers every 12th call with an unusable reply.

`apps/server/test/agent-compare.test.ts` runs seeds 1 to 5 for 30 days twice, on the recorded model
and on the rules, with the same two headless players. One run:

| Seed | Brain | Median | Lowest | Glut days | Rival busts | Entrants | Fallbacks | Calls (main, cheap decisions) | Reflections |
|---|---|---|---|---|---|---|---|---|---|
| 1 | model | 1.47x | 0.68x | 2 | 5 | 3 | 18 | 265 (52, 195) | 29 |
| 1 | rules | 1.10x | 0.53x | 12 | 1 | 1 | 0 | 0 | 28 |
| 2 | model | 1.02x | 0.59x | 12 | 2 | 2 | 18 | 287 (132, 137) | 32 |
| 2 | rules | 1.16x | 0.40x | 8 | 2 | 1 | 0 | 0 | 28 |
| 3 | model | 1.04x | 0.70x | 4 | 4 | 3 | 19 | 269 (65, 185) | 30 |
| 3 | rules | 1.11x | 0.49x | 7 | 1 | 2 | 0 | 0 | 30 |
| 4 | model | 1.26x | 1.00x | 0 | 5 | 4 | 20 | 284 (43, 221) | 31 |
| 4 | rules | 1.10x | 0.49x | 7 | 1 | 2 | 0 | 0 | 30 |
| 5 | model | 1.45x | 1.00x | 0 | 4 | 3 | 18 | 274 (37, 219) | 30 |
| 5 | rules | 1.04x | 0.40x | 8 | 1 | 2 | 0 | 0 | 30 |

Final cash, seed 1 (coins): on the recorded model Old Money Farms 1,274, the Loyalist 1,398, the
Trader 596, the Squeezer 631, the Wholesaler 906, the Bakery 864, Pennywise Poultry 579; bust: Upstart
Eggs (day 7), Early Bird Eggs (13), Hatch and Dash (17), Dawn Patrol Poultry (25), Sunny Side Startup
(29). On the rules Old Money Farms 5,709, the Loyalist 1,363, the Trader 590, the Squeezer 485, the
Wholesaler 1,032, the Bakery 772, Cluck Collective 175, Hatch and Dash 117; bust: Upstart Eggs (14).
The test prints every seed's.

Over three runs (ids are random, so runs differ a little):

| | Recorded model | Rules |
|---|---|---|
| Median of the seeds' medians | 1.10x to 1.26x | 1.09x to 1.11x |
| Lowest day | 0.46x to 0.59x | 0.40x |
| Glut days (5 seeds) | 18 to 37 | 40 to 48 |
| Rival busts (5 seeds) | 11 to 20 | 5 to 6 |
| Fallbacks | 93 to 103 (every 12th reply unusable) | 0 |
| Calls | 1,350 to 1,379 | 0 |

What it shows: the recorded replies hold eggs back and bid deeper in gluts, so there are fewer and
milder gluts, but they also grow into scarcity harder and buy hens through a glut now and then, so
the Upstart and the entrants that look like it bust more and earlier (day 7 instead of day 14 or so),
Old Money ends far poorer, and more AI farms enter to replace them. The fallbacks work: every
unusable reply became the rule decision. These are authored stand-ins, not measured model behaviour;
re-record with `--live` once there are credits and run the comparison again.

## Credits needed

From the recorded-model runs above (tokens at 3 characters a token, the usual rate for JSON-heavy
prompts; the server counts the model's own `usage` when it answers):

| | Value |
|---|---|
| Decision call | 1,611 tokens in (system prompt 636, observation the rest), 156 out |
| Reflection call | 347 in, 38 out |
| Calls | 1.10 per agent per in-game day: a decision on 98% of agent days (a struggling agent skips every other day) and a reflection every 7th day |
| Tiers | 15% of decisions on the main model (hard days), 85% on the cheap one; reflections on the main one |
| Agents open | 8.3 on average (7 base, plus entrants) |
| Live pace | 480 in-game days per real day (3-minute days) |

Prices: NEAR AI Cloud did not answer while this was written, so these are **assumed** (USD per
million tokens): main `Qwen/Qwen3.6-35B-A3B-FP8` 0.20 in, 0.80 out; cheap `z-ai/glm-5.3-flash` 0.10
in, 0.40 out (`ASSUMED_PRICING` in `apps/server/src/agents/brain.ts`; set the real ones with
`NEARAI_MAIN_PRICE` and `NEARAI_CHEAP_PRICE`, or let `/v1/models` say). An average call is then about
0.00024 USD.

| | Per real day | Per 30 real days |
|---|---|---|
| Without caps (about 4,400 calls a day, 0.13 USD per agent a day) | 1.07 USD | 32 USD |
| At the default caps (1 USD a day; each agent 40 calls, 0.25 USD) | 0.08 USD | 2.41 USD |
| Without caps, if both models cost 1 in, 5 out | 9.65 USD | 290 USD |
| At the default caps, if both models cost 1 in, 5 out | 0.73 USD | 22 USD |

Over three runs: 1.07 to 1.14 USD a real day without caps, 0.080 to 0.086 with them.

At the default caps the binding one is the 40 calls per agent: an agent would make about 530 calls a
real day, so the model makes about 8% of its decisions (the first 40 each UTC day) and the rules the
rest; the 1 USD global cap is not reached at the assumed prices. To let the model make every
decision for this street, set `NEARAI_AGENT_DAILY_CALLS` to about 600 and
`NEARAI_DAILY_SPEND_CAP_USD` to about 1.5 at the assumed prices (about 10 if both models cost 1 in, 5
out). The cost grows with the number of agents: each AI farm the entry rule opens adds about 0.13 USD
a day uncapped, and the cap on AI farms grows with players (6 players: up to 9 AI farms, about 14
agents, about 1.8 USD a day uncapped, a little more since every farm also lengthens each
observation).

## Files

- `apps/server/src/agents/decision.ts`: observation, schema, `validateDecision`, `hardDay`.
- `apps/server/src/agents/brain.ts`: prompts, tiers, caps, `decide`, `reflect`, prices.
- `apps/server/src/agents/cast.ts`, `entrants.ts`: personas, the entrant registry.
- `apps/server/src/agents/rules.ts`: rule policies, reasons, `ruleReflection`.
- `apps/server/src/game/cast-runtime.ts`: context, entry rule, reasons, weeks.
- `apps/server/src/chain/chain.ts`: the wallet pool.
- `apps/server/src/db/migrations.ts`: migration 13.
- Tests: `agents.test.ts`, `entrants.test.ts`, `reflections.test.ts`, `chain.test.ts` (wallet pool),
  `sim.test.ts` (five seeds with entrants), `agent-compare.test.ts` (model against rules, credits).
