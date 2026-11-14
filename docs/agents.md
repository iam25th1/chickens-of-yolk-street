# Agents: what they see, how they decide, what it costs

Stage 4 of the brief: agent upgrades (observations, personas, one validated action schema, public
reasons, weekly reflections, model tiers, per-agent caps, better rules) and new AI farms entering the
street (registry, entry rule, the AI tag, a reusable wallet pool). Then the provider chain and cost
control. Agent decisions run on a provider chain: NEAR AI Cloud is the primary model, SERV Reasoning is the fallback, and rule-based strategies are the last resort, all under a hard daily spend cap. Every agent has its own wallet, memory and personality.
To see which one is deciding right now, hover the AI tag on any AI farm in the game (its tooltip names the live mode), or read the server's startup log. This page also holds the 30-day
model-against-rules comparison and what a model would cost at the live pace.

## What an agent sees

`AgentContext` in `apps/server/src/agents/decision.ts`, built by `buildContext` in
`apps/server/src/game/cast-runtime.ts`. The rules read all of it. A model gets it trimmed (`observe` in
`apps/server/src/agents/brain.ts`) as the user message: the six farms most relevant to the agent (player
farms first, then those with a contract, a debt, sell orders for a buyer, short feed for a supplier),
four sell orders each, five days of history, its last two reasons and three busts, numbers rounded:

- **Itself**: cash, stock, whether it is struggling, its entrant key (AI farms that entered later),
  its latest **weekly reflection** and its **last three public reasons**.
- **The market**: the live multiplier and prices, demand (the reference supply), today's supply,
  seven days of history, crash flag, auction hens, and new:
  - `trend`: supply over demand for each of the last three closed days (above 1 a glut, below 1
    scarcity) and the multiplier's change per day across them;
  - `busts`: farms and agents that went bust in the last five days (name, AI or not, day);
  - `open`: open AI farms and open player farms (guest farms count as player farms).
- **Its own farm** (rivals) and **the other farms**: hens, coop room, crate, daily lay, days of
  feed, cash, quality, open sell orders, and its memory of each farm.

A decision prompt measured in the simulation is about 4,400 characters (the system prompt about
1,950, the trimmed observation the rest), plus the response schema (about 6,400 characters): about
2,700 tokens at 4 characters a token. A live SERV call on such a prompt counted 2,381.

## Who they are

Each kind has a persona in `apps/server/src/agents/cast.ts` (goals, temperament, how it talks, what
it never does), and each entering AI farm its own in `apps/server/src/agents/entrants.ts`. The
system prompt (`SYSTEM` in `apps/server/src/agents/brain.ts`) carries it with the haggling numbers,
the market rules and what each role may do. Card lines and reasons stay in character; an agent too
broke to pay for a decision sits the day out and says so in its own voice.

## One schema, one validation

`decisionSchema` (zod) is the only action schema: a model gets it as its strict `json_schema`
response format (`decisionFormat`: `oneOf` becomes `anyOf` and `$schema` is dropped, which strict modes
need; the branches never overlap, so nothing else changes), and it now has `reason`, one public line
under 80 characters. Every decision, from
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
  and what it will change. It is the week's strategy call: a provider's main model writes it when one
  answers and the caps allow; otherwise `ruleReflection` writes it from the agent's own numbers (cash at the start and end of the week, deals, refusals,
  busts seen, the multiplier's range and glut days), in character. It is stored on the agent, logged
  (`[agents] <name> reflects on its week (<model or rules>): ...`), and in the next observations.

## Provider chain and cost control

**The chain** (`apps/server/src/ai/`): every provider implements one small interface
(`InferenceProvider` in `provider.ts`: a name, a main and a cheap model, `chat` returning the content
and the token usage, its prices, its pacing gap and its own prompt overhead). `ProviderChain`
(`chain.ts`) tries them in order: **NEAR AI Cloud** (`nearai.ts`), then **SERV Reasoning**
(`serv.ts`, OpenServ's OpenAI-compatible API at `https://inference-api.openserv.ai/v1`: a system
message always present, `max_completion_tokens`, `reasoning_effort: none`, the same strict schema),
then the rules. A provider without its key is not in the chain. Each has a breaker held in memory:

| Failure | Skipped for |
|---|---|
| 401, 402, 403 (a bad key or no credits) | 30 minutes, then tried once more |
| 429 | 30 seconds, doubling each time, at most 10 minutes |
| 5xx, a timeout, no connection, another 4xx | 2 minutes, doubling, at most 30 minutes |
| an answer with no message in it | not skipped (that one request falls back) |

A breaker logs its change once (`[ai] NEAR AI Cloud refused (a bad key or no credits) (HTTP 402):
skipped for 30 min ...`, `[ai] SERV Reasoning is answering again`), never each skipped call; NEAR AI's
402 used to cost about 4,400 failed requests and log lines a real day, now at most 48. SERV calls are
at least a second apart. All model calls of one day close share `LLM_CLOSE_BUDGET_SECONDS` (60); no
call starts with less than 5 seconds of it left, and the agents still waiting use their rules that
day.

**The days that matter** (`modelMoment` in `brain.ts`). A routine day runs on the rule strategy and
makes no call. A model is asked for:

| Moment | Model | Default |
|---|---|---|
| The agent's first look (no model decision yet: a new AI farm's first day, or the first day after this change) | cheap | |
| A hard day: a crash or glut day (multiplier at or under 0.80, or today's supply past 1.1 x demand), or cash under the struggle line (40) | cheap (NEAR AI: main) | at most once in `LLM_DECISION_GAP_DAYS` (3) in-game days |
| A price move: the multiplier moved `LLM_PRICE_MOVE` (15%) or more since its last model decision | cheap | at most once in 3 in-game days |
| The weekly strategy: its reflection, every 7 in-game days | main | |

| Provider | Cheap model (decisions) | Main model (reflections) | USD per million tokens, in / out |
|---|---|---|---|
| NEAR AI Cloud | `NEARAI_CHEAP_MODEL`, `z-ai/glm-5.3-flash` | `NEARAI_MODEL`, `Qwen/Qwen3.6-35B-A3B-FP8` | assumed 0.10 / 0.40 and 0.20 / 0.80 (`NEARAI_*_PRICE`, else `/v1/models`) |
| SERV Reasoning | `SERV_CHEAP_MODEL`, `gpt-6-luna` | `SERV_MODEL`, `gpt-5.4-mini` | published 0.13 / 0.65 and 1.00 / 6.00 (`SERV_*_PRICE`; confirm in the OpenServ console, Usage) |

SERV's hard days stay on `gpt-6-luna`: `gpt-5.4-mini` costs about eight times as much, and hard days are
about half of the model decisions. A struggling agent still sits out every other day (it saves the
0.50-coin decision fee), before any of this.

**Short prompts, capped replies.** The trimmed observation (above), replies capped at 400 tokens a
decision (a live SERV decision took 258) and 200 a reflection, and the prompt asks for a note under
ten words. The same prompt to the same model within a UTC day (a day close run again, say) reuses its
validated decision or reflection: no second call.

**One shared cap.** Per UTC day:

| Cap | Variable | Default |
|---|---|---|
| Every provider and agent together, USD | `LLM_DAILY_CAP_USD` (old name `NEARAI_DAILY_SPEND_CAP_USD`, still read when the new one is unset) | 1.50 |
| One agent, USD | `LLM_AGENT_DAILY_CAP_USD` (or `NEARAI_AGENT_DAILY_CAP_USD`) | a quarter of the shared cap |
| One agent, calls, failed ones included | `LLM_AGENT_DAILY_CALLS` (or `NEARAI_AGENT_DAILY_CALLS`) | 240 (the days that matter allow about 230) |

Each call first reserves its cost: the prompt (messages and response schema at 4 characters a token,
plus the provider's own overhead, 200 tokens for SERV) at 1.5 times that, and a full reply. A call that
would cross a cap is not made, so the shared cap is a hard stop until 00:00 UTC (logged once:
`[ai] today's AI spend cap (1.50 USD) is reached ...`). An answer is charged from the tokens the
provider counted; a timed-out call is charged its prompt, since it may have run.

**What is logged and kept.** Every call: `[ai] serv gpt-6-luna Yolk Street Bakery decision (price
move): 2381+258 tokens, 0.000477 USD, answered` (or `failed (...)`). Per provider per UTC day in
`provider_usage` (migration 15: calls, failures, tokens, estimated spend), and failures in
`inference_usage` and `agent_inference_usage` too. Once a real hour, after a day close: `[ai] today:
nearai 0 calls (1 failed) 0.0000 USD, serv 41 calls 0.0198 USD; cap 1.50 USD; mode serv`. `/healthz`
carries `ai: { mode, providers: { nearai: { state }, serv: { state } }, todayUsd, capUsd, calls,
failures }`, with each state `off`, `ready`, `answering` or `paused` (and the last HTTP status and
seconds left while paused); never a key.

**The mode.** `nearai`, `serv` or `rules`: the provider whose answer is the latest within the last 7
in-game days (each agent's latest model answer is kept on the agent: provider, day, multiplier),
unless that provider has been refused since or today's cap is spent; else `rules`. It goes out as
`MarketState.aiMode` and, per agent, `AgentView.brain` (the rules unless that agent's own latest
answer is recent). The client's words follow it: the AI tag's tooltip ("Run by an AI agent: rule-based
strategy with its own wallet, memory and personality" on the rules; "decides with SERV Reasoning on the
days that matter" when SERV answered), the How to play guide and an AI farm's public profile. Haggle
replies stay on the rules (no model chatter).

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

The model's side replays recorded decisions, so every run repeats exactly.
`scripts/record-agent-decisions.ts` writes `apps/server/test/fixtures/agent-replies.json`: for each
kind and situation (glut, scarcity, normal) a few in-character decisions with reasons that differ
from the rules (price shares, holding, expansion timing), plus unusable replies and reflections.
Offline these are authored stand-ins (`apps/server/test/recorded-model.ts`); `--live` records them
from the main model with the real prompt (77 calls). The fake client
replays them by kind and situation, maps the sample ids to the live ones and keeps a reply's intent
on the live farm (share of the crate sold, days of feed, coop fill, share of cash on hens, stock
targets), and answers every 12th call with an unusable reply.

`apps/server/test/agent-compare.test.ts` runs seeds 1 to 5 for 30 days twice, on the recorded model
and on the rules, with the same two headless players. With the provider chain the model is asked only
on the days that matter (above), so on the model side about 30% of decisions are the model's and the
rest are the rules'. One run:

| Seed | Brain | Median | Lowest | Glut days | Rival busts | Entrants | Fallbacks | Calls (hard-day decisions on the main model, cheap decisions, reflections) |
|---|---|---|---|---|---|---|---|---|
| 1 | model | 0.99x | 0.53x | 10 | 1 | 2 | 5 | 96 (27, 38, 31) |
| 1 | rules | 1.17x | 0.46x | 9 | 2 | 2 | 0 | 0 |
| 2 | model | 1.24x | 0.61x | 11 | 1 | 2 | 4 | 91 (27, 36, 28) |
| 2 | rules | 1.13x | 0.51x | 9 | 1 | 2 | 0 | 0 |
| 3 | model | 0.96x | 0.40x | 9 | 1 | 2 | 5 | 95 (31, 34, 30) |
| 3 | rules | 1.09x | 0.41x | 7 | 1 | 2 | 0 | 0 |
| 4 | model | 1.42x | 0.58x | 12 | 1 | 1 | 3 | 84 (29, 28, 27) |
| 4 | rules | 1.20x | 0.47x | 8 | 2 | 1 | 0 | 0 |
| 5 | model | 1.16x | 0.56x | 12 | 0 | 0 | 4 | 90 (30, 32, 28) |
| 5 | rules | 1.09x | 0.41x | 7 | 1 | 2 | 0 | 0 |

Final cash, seed 1 (coins): on the recorded model Old Money Farms 4,782, the Loyalist 1,922, the
Trader 600, the Squeezer 485, the Wholesaler 927, the Bakery 764, Cluck Collective 212, Gilded Roost
Estates 160, Hatch and Dash 62; bust: Upstart Eggs (day 20). On the rules Old Money Farms 4,708, the
Loyalist 1,699, the Trader 596, the Squeezer 485, the Wholesaler 971, the Bakery 724, Pennywise Poultry
181, Early Bird Eggs 21; bust: Upstart Eggs (14), Hatch and Dash (30). The test prints every seed's.

Over two runs (ids are random, so runs differ a little):

| | Recorded model, days that matter | Rules |
|---|---|---|
| Median of the seeds' medians | 1.16x to 1.21x | 1.07x to 1.13x |
| Lowest day | 0.40x | 0.40x to 0.41x |
| Glut days (5 seeds) | 54 | 40 to 41 |
| Rival busts (5 seeds) | 4 to 6 | 5 to 7 |
| Fallbacks | 20 to 21 (every 12th reply unusable) | 0 |
| Calls | 456 to 468 | 0 |

What it shows: with a model only on the days that matter, the stand-in moves the market less than
when it made every decision (before the chain, one call every agent day: 1,350 to 1,379 calls, 18 to
37 glut days, 11 to 20 rival busts). Its hard-day replies hold eggs back and bid deeper, but the rules
decide the routine days between, and the mix runs a little hotter (higher medians, more glut days)
with about as many busts as the rules. The fallbacks work: every unusable reply became the rule
decision. These are authored stand-ins, not measured model behaviour; re-record with `--live` once a
provider answers and run the comparison again.

## What a model costs

From the recorded-model runs above, at the live pace, as the test's credits report prints it
(`creditsReport` in `agent-compare.test.ts`; tokens as the server estimates them, at 4 characters a
token with the response schema, SERV's 200 tokens of its own on each call; replies at least 260
tokens a decision, as SERV's `gpt-6-luna` answered live, and 100 a reflection):

| | Value |
|---|---|
| Calls under the days-that-matter rule | 0.28 decisions and 0.13 reflections per agent per in-game day (46% of decisions on hard days) |
| Calls at full use (a model on every agent day) | 0.97 decisions and 0.13 reflections per agent per in-game day |
| Agents open | 7.4 a day on average (7 base, plus entrants, less busts) |
| Live pace | 480 in-game days per real day (3-minute days): about 1,460 calls a real day (about 1,000 decisions, 460 reflections); 3,930 at full use |
| Decision call | 2,688 tokens in (the response schema 1,593 of them) + 260 out |
| Reflection call | 265 in + 100 out |

| Provider (default models) | A decision | A reflection | Days that matter: a day, a week | Full use: a day, a week | At the default cap (1.50 USD a day) |
|---|---|---|---|---|---|
| NEAR AI Cloud, assumed prices (`z-ai/glm-5.3-flash` 0.10 / 0.40, `Qwen/Qwen3.6-35B-A3B-FP8` 0.20 / 0.80; hard days on the main model) | 0.00055 USD | 0.00013 USD | 0.61 USD, 4.24 USD | 1.95 USD, 13.65 USD | 0.61 a day (4.24 a week) as is; full use held at 1.50 a day (10.50 a week) |
| SERV Reasoning, published prices (`gpt-6-luna` 0.13 / 0.65 for decisions, `gpt-5.4-mini` 1.00 / 6.00 for reflections) | 0.00054 USD | 0.00107 USD | 1.03 USD, 7.24 USD | 2.38 USD, 16.64 USD | 1.03 a day (7.24 a week) as is; full use held at 1.50 a day (10.50 a week) |

The live check (one SERV decision and one reflection, a real observation from a memory game with
three other farms): `gpt-6-luna` 200, 2,381 tokens in and 258 out, 0.000477 USD, valid; `gpt-5.4-mini`
200, 564 in and 55 out, 0.000894 USD. The decision's prompt came in under the estimate (2,748); the
reflection's over it (447), so SERV's own overhead is larger on `gpt-5.4-mini` than 200 tokens: the
reserve's 1.5 margin covers it, and spend is always recorded from the counted tokens.

SERV's reflections cost about half of its day: half the 1.03 USD is `gpt-5.4-mini` writing 460
reflections. Setting `SERV_MODEL=gpt-6-luna` would bring a SERV day to about 0.60 USD. The cost grows
with the number of agents: the cap on AI farms grows with players (6 players: up to 9 AI farms, about
14 agents, about 2 USD a SERV day under the days-that-matter rule), and past the shared cap every
agent runs on its rules until 00:00 UTC. NEAR AI's prices here are assumed; set
`NEARAI_MAIN_PRICE` and `NEARAI_CHEAP_PRICE` (or let `/v1/models` say). Confirm SERV's in the OpenServ
console (Usage) and set `SERV_MAIN_PRICE` and `SERV_CHEAP_PRICE` if they differ.

## Files

- `apps/server/src/agents/decision.ts`: observation, schema, `validateDecision`, `hardDay`.
- `apps/server/src/agents/brain.ts`: prompts, the trimmed observation, the days that matter, caps,
  cache, `decide`, `reflect`, prices, the spend line and the mode.
- `apps/server/src/ai/provider.ts`, `nearai.ts`, `serv.ts`, `chain.ts`: the provider interface, NEAR
  AI Cloud, SERV Reasoning, the chain with its breakers, pacing and time budget.
- `apps/server/src/agents/cast.ts`, `entrants.ts`: personas, the entrant registry.
- `apps/server/src/agents/rules.ts`: rule policies, reasons, `ruleReflection`.
- `apps/server/src/game/cast-runtime.ts`: context, entry rule, reasons, weeks.
- `apps/server/src/chain/chain.ts`: the wallet pool.
- `apps/server/src/db/migrations.ts`: migration 13; migration 15 (`provider_usage`, failures, each
  agent's latest model answer).
- Tests: `agents.test.ts`, `entrants.test.ts`, `reflections.test.ts`, `chain.test.ts` (wallet pool),
  `sim.test.ts` (five seeds with entrants), `agent-compare.test.ts` (model against rules, costs),
  `providers.test.ts` (the chain, breakers, caps, cache, mode, with fakes only).
