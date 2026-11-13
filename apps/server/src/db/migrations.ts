// Schema migrations, applied in order and recorded in schema_migrations. Never edit an applied
// migration: add a new one. SQL lives here as strings so the bundled server carries it.
import type { Db } from './db';

export const MIGRATIONS: readonly { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE game_clock (
  id integer PRIMARY KEY CHECK (id = 1),
  day integer NOT NULL,
  day_started_at bigint NOT NULL
);

-- One row per in-game day: the live multiplier set by the previous day's supply, the supply sold
-- into the market today, and the daily settlement batch written to NEAR testnet at the close.
CREATE TABLE market_days (
  day integer PRIMARY KEY,
  multiplier double precision NOT NULL,
  supply integer NOT NULL DEFAULT 0,
  closed_at bigint,
  next_multiplier double precision,
  settlement_status text NOT NULL DEFAULT 'pending'
    CHECK (settlement_status IN ('pending', 'sent', 'noop', 'failed')),
  settlement_tx text,
  settlement_payload jsonb
);

CREATE TABLE players (
  id text PRIMARY KEY,
  auth_provider text NOT NULL CHECK (auth_provider IN ('privy', 'dev')),
  auth_subject text NOT NULL,
  display_name text NOT NULL,
  near_account_id text,
  created_at bigint NOT NULL,
  UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE farms (
  id text PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('player', 'agent')),
  player_id text UNIQUE REFERENCES players(id),
  agent_key text UNIQUE,
  name text NOT NULL,
  cash_milli bigint NOT NULL,
  feed_tier text NOT NULL CHECK (feed_tier IN ('cheap', 'standard', 'premium')),
  feed_cheap_g bigint NOT NULL DEFAULT 0 CHECK (feed_cheap_g >= 0),
  feed_standard_g bigint NOT NULL DEFAULT 0 CHECK (feed_standard_g >= 0),
  feed_premium_g bigint NOT NULL DEFAULT 0 CHECK (feed_premium_g >= 0),
  fed_multiplier double precision NOT NULL DEFAULT 0,
  crate_white integer NOT NULL DEFAULT 0 CHECK (crate_white >= 0),
  crate_cream integer NOT NULL DEFAULT 0 CHECK (crate_cream >= 0),
  crate_brown integer NOT NULL DEFAULT 0 CHECK (crate_brown >= 0),
  crate_golden integer NOT NULL DEFAULT 0 CHECK (crate_golden >= 0),
  bust_day integer,
  created_day integer NOT NULL,
  -- players can never spend below zero; agents can, and go bust
  CHECK (cash_milli >= 0 OR owner_kind = 'agent'),
  CHECK ((owner_kind = 'player') = (player_id IS NOT NULL))
);

CREATE TABLE coops (
  id text PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  kind text NOT NULL CHECK (kind IN ('starter', 'red', 'deluxe')),
  plot integer NOT NULL,
  built_day integer NOT NULL,
  UNIQUE (farm_id, plot)
);

-- Hens carry their traits now; token_id links a hen to its NFT in a later brief.
CREATE TABLE hens (
  id text PRIMARY KEY,
  farm_id text REFERENCES farms(id),
  status text NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'auction')),
  body text NOT NULL,
  eyes text NOT NULL,
  comb text NOT NULL,
  accessory text NOT NULL,
  laying_trait double precision NOT NULL,
  born_day integer NOT NULL,
  lay_progress double precision NOT NULL DEFAULT 0,
  token_id text,
  CHECK ((status = 'alive') = (farm_id IS NOT NULL))
);
CREATE INDEX hens_farm ON hens (farm_id);

CREATE TABLE unlocks (
  farm_id text NOT NULL REFERENCES farms(id),
  unlock_id text NOT NULL,
  bought_day integer NOT NULL,
  PRIMARY KEY (farm_id, unlock_id)
);

CREATE TABLE lay_events (
  id text PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  hen_id text NOT NULL,
  day integer NOT NULL,
  at_ms integer NOT NULL,
  grade text NOT NULL,
  broken boolean NOT NULL,
  collected boolean NOT NULL DEFAULT false
);
CREATE INDEX lay_events_farm_day ON lay_events (farm_id, day);

-- Order book. Market sells fill at once at the live price; limit and buy orders arrive with agents.
CREATE TABLE orders (
  id text PRIMARY KEY,
  deal_id text NOT NULL,
  farm_id text NOT NULL REFERENCES farms(id),
  day integer NOT NULL,
  side text NOT NULL CHECK (side IN ('sell', 'buy')),
  kind text NOT NULL CHECK (kind IN ('market', 'limit')),
  grade text NOT NULL,
  qty integer NOT NULL CHECK (qty > 0),
  price_milli bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'filled', 'cancelled')),
  created_at bigint NOT NULL
);
CREATE INDEX orders_day ON orders (day);

-- Every change to a farm's cash, in milli-coins. Sum per farm equals farms.cash_milli.
CREATE TABLE ledger (
  id bigserial PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  day integer NOT NULL,
  kind text NOT NULL,
  amount_milli bigint NOT NULL,
  ref text,
  created_at bigint NOT NULL
);
CREATE INDEX ledger_farm_day ON ledger (farm_id, day);
`,
  },
  {
    id: 2,
    name: 'agents, cards, contracts, order book, chain outbox',
    sql: `
-- the shop sells listed hens: fresh from the breeder (forsale) or from bust farms (auction)
ALTER TABLE hens DROP CONSTRAINT hens_status_check;
ALTER TABLE hens ADD CONSTRAINT hens_status_check CHECK (status IN ('alive', 'auction', 'forsale'));
ALTER TABLE hens ADD COLUMN chain_owner text;

ALTER TABLE farms ADD COLUMN supplier text NOT NULL DEFAULT 'loyalist';
ALTER TABLE farms ADD COLUMN clerk_floor double precision NOT NULL DEFAULT 1.0;
-- share of brown and golden in the farm's recent sales; the market trader watches it
ALTER TABLE farms ADD COLUMN quality double precision NOT NULL DEFAULT 0.35;

-- the cast: rival farms, feed suppliers and egg buyers, each with its own cash and stock
CREATE TABLE agents (
  id text PRIMARY KEY,
  kind text NOT NULL,
  role text NOT NULL CHECK (role IN ('rival', 'supplier', 'buyer')),
  name text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'bust')),
  cash_milli bigint NOT NULL DEFAULT 0,
  farm_id text REFERENCES farms(id),
  stock jsonb NOT NULL DEFAULT '{}',
  opened_day integer NOT NULL,
  bust_day integer,
  last_decided_day integer NOT NULL DEFAULT 0,
  last_brain text,
  near_account_id text,
  UNIQUE (kind, generation)
);

-- what each agent remembers about each farm it has dealt with
CREATE TABLE agent_memory (
  agent_id text NOT NULL REFERENCES agents(id),
  farm_id text NOT NULL REFERENCES farms(id),
  deals integer NOT NULL DEFAULT 0,
  value_milli bigint NOT NULL DEFAULT 0,
  refusals integer NOT NULL DEFAULT 0,
  haggles_won integer NOT NULL DEFAULT 0,
  haggles_lost integer NOT NULL DEFAULT 0,
  misses integer NOT NULL DEFAULT 0,
  sulk_until integer NOT NULL DEFAULT 0,
  last_day integer NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, farm_id)
);

-- decision cards: offers made by agents (or other players), answered by the player
CREATE TABLE cards (
  id text PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  agent_id text REFERENCES agents(id),
  kind text NOT NULL,
  day integer NOT NULL,
  arrive_at_ms integer NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'expired', 'won', 'failed')),
  round integer NOT NULL DEFAULT 0,
  offer_milli bigint NOT NULL,
  -- the agent's walk-away price, never sent to clients
  reserve_milli bigint NOT NULL,
  side text NOT NULL CHECK (side IN ('agent_buys', 'agent_sells', 'none')),
  qty integer NOT NULL DEFAULT 0,
  grade text,
  tier text,
  days integer,
  ref text,
  line text NOT NULL,
  outcome_milli bigint
);
CREATE INDEX cards_farm_day ON cards (farm_id, day);

CREATE TABLE contracts (
  id text PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  agent_id text NOT NULL REFERENCES agents(id),
  grade text NOT NULL,
  qty_per_day integer NOT NULL CHECK (qty_per_day > 0),
  price_milli bigint NOT NULL,
  start_day integer NOT NULL,
  end_day integer NOT NULL,
  last_delivered_day integer NOT NULL DEFAULT 0,
  misses integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled'))
);

CREATE TABLE debts (
  id text PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  agent_id text NOT NULL REFERENCES agents(id),
  principal_milli bigint NOT NULL,
  due_milli bigint NOT NULL,
  paid_milli bigint NOT NULL DEFAULT 0,
  due_day integer NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'defaulted'))
);

-- the order book now holds resting limit orders from farms and buyer agents
ALTER TABLE orders ALTER COLUMN farm_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN agent_id text REFERENCES agents(id);
ALTER TABLE orders ADD COLUMN filled_qty integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN expires_day integer;
CREATE INDEX orders_open ON orders (status, side, grade);

-- every egg sale, for the market board and the chain batch
CREATE TABLE trades (
  id bigserial PRIMARY KEY,
  day integer NOT NULL,
  at bigint NOT NULL,
  seller text NOT NULL,
  seller_farm text,
  seller_agent text,
  buyer text NOT NULL,
  buyer_farm text,
  buyer_agent text,
  grade text NOT NULL,
  qty integer NOT NULL,
  price_milli bigint NOT NULL,
  total_milli bigint NOT NULL,
  via text NOT NULL
);
CREATE INDEX trades_day ON trades (day);

-- NEAR AI Cloud spend per UTC day, against the hard cap
CREATE TABLE inference_usage (
  utc_day text PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0,
  fallbacks integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  spend_micro_usd bigint NOT NULL DEFAULT 0
);

-- egg token balances as last settled on chain, so each batch only moves the difference
CREATE TABLE chain_balances (
  account text NOT NULL,
  grade text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account, grade)
);

ALTER TABLE market_days ADD COLUMN settlement_error text;
`,
  },
  {
    id: 3,
    name: 'market demand scales with active farms',
    sql: `
-- the reference supply each day closed against: demand per active farm times active farms
ALTER TABLE market_days ADD COLUMN reference integer;
`,
  },
  {
    id: 4,
    name: 'seasons',
    sql: `
-- One database holds one season (GAME_SEASON); settlement is keyed by (season, day) on chain and
-- here. Databases from before seasons carry on as the season 'legacy', matching the contract's
-- migrate, which files version 1 days under that name.
ALTER TABLE game_clock ADD COLUMN season text;
UPDATE game_clock SET season = 'legacy';
ALTER TABLE market_days ADD COLUMN season text NOT NULL DEFAULT 'legacy';
ALTER TABLE market_days DROP CONSTRAINT market_days_pkey;
ALTER TABLE market_days ADD PRIMARY KEY (season, day);
ALTER TABLE ledger ADD COLUMN season text NOT NULL DEFAULT 'legacy';
`,
  },
  {
    id: 5,
    name: 'goal chain',
    sql: `
-- The goal chain (collect, sell, fill the coop, win a haggle, first machine, outlast a rival):
-- JSON text {"done": [...], "claimed": [...]}. Done flags come from actions; claims pay coins.
ALTER TABLE farms ADD COLUMN goals text NOT NULL DEFAULT '{}';
`,
  },
  {
    id: 6,
    name: 'hen certificates',
    sql: `
-- The settlement transaction that minted each hen as an NFT, and the day it closed, so a hen's
-- card can link to her receipt.
ALTER TABLE hens ADD COLUMN mint_tx text;
ALTER TABLE hens ADD COLUMN mint_day integer;
`,
  },
  {
    id: 7,
    name: 'machines at work',
    sql: `
-- What each machine did each day (eggs carried and saved, eggs graded, deliveries, bags poured,
-- offers taken), for the machine cards and the ledger. Eggs a conveyor kept from cracking are
-- flagged when the day is planned. The feed hopper buys only at or under the farm's price cap
-- (0: the list price).
CREATE TABLE machine_days (
  farm_id text NOT NULL REFERENCES farms(id),
  day integer NOT NULL,
  machine text NOT NULL,
  units integer NOT NULL DEFAULT 0,
  saved integer NOT NULL DEFAULT 0,
  milli bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (farm_id, day, machine)
);
ALTER TABLE lay_events ADD COLUMN saved boolean NOT NULL DEFAULT false;
ALTER TABLE farms ADD COLUMN hopper_cap_milli bigint NOT NULL DEFAULT 0;
`,
  },
  {
    id: 8,
    name: 'founding hens',
    sql: `
-- The Founding Hens: only hens won at milestones are minted on NEAR, 777 ever. A founding hen
-- records the milestone she was won at and the day, and her number of 777 once minted.
ALTER TABLE hens ADD COLUMN founding_milestone text;
ALTER TABLE hens ADD COLUMN founding_day integer;
ALTER TABLE hens ADD COLUMN founding_no integer;
-- Every milestone roll, once per farm and milestone, with the inputs that make it auditable:
-- seed = sha256 of the season, day, farm, milestone and the previous day's settlement tx (anchor).
CREATE TABLE milestone_rolls (
  farm_id text NOT NULL REFERENCES farms(id),
  milestone text NOT NULL,
  season text NOT NULL,
  day integer NOT NULL,
  anchor text NOT NULL,
  seed text NOT NULL,
  roll double precision NOT NULL,
  odds double precision NOT NULL,
  won boolean NOT NULL,
  hen_id text,
  PRIMARY KEY (farm_id, milestone)
);
-- Good standing and the counters milestones read.
ALTER TABLE farms ADD COLUMN good_since_day integer;
ALTER TABLE farms ADD COLUMN last_missed_day integer;
ALTER TABLE farms ADD COLUMN eggs_sold integer NOT NULL DEFAULT 0;
ALTER TABLE farms ADD COLUMN haggles_won integer NOT NULL DEFAULT 0;
UPDATE farms SET eggs_sold = COALESCE((SELECT SUM(t.qty) FROM trades t WHERE t.seller_farm = farms.id), 0);
UPDATE farms SET haggles_won = (SELECT count(*) FROM cards c WHERE c.farm_id = farms.id AND c.status = 'won');
`,
  },
  {
    id: 9,
    name: 'feathers beta',
    sql: `
-- The Feathers (beta): a milestone win is a Feather Ticket, not a hen. A ticket is held until the
-- player redeems it (grade from the management score, coin fee), then queued, then minted at a day
-- close as Feather #n of 777.
CREATE TABLE feather_tickets (
  id text PRIMARY KEY,
  farm_id text NOT NULL REFERENCES farms(id),
  milestone text NOT NULL,
  season text NOT NULL,
  day integer NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'queued', 'minted')),
  grade text CHECK (grade IN ('fluff', 'plume', 'quill', 'golden-quill')),
  score double precision,
  fee_milli bigint,
  redeemed_day integer,
  -- redemption order: Feathers mint in the order their tickets were redeemed
  redeemed_seq integer,
  owner_account text,
  number integer UNIQUE,
  token_id text,
  media_sha256 text,
  mint_tx text,
  mint_day integer,
  created_at bigint NOT NULL
);
CREATE INDEX feather_tickets_farm ON feather_tickets (farm_id);
CREATE INDEX feather_tickets_status ON feather_tickets (status);
ALTER TABLE milestone_rolls ADD COLUMN ticket_id text;
-- a Founding Hen won but never minted becomes a Feather Ticket for her farm; she stays on the farm
-- as an ordinary hen
INSERT INTO feather_tickets (id, farm_id, milestone, season, day, status, created_at)
  SELECT 'ticket-' || h.id, h.farm_id, h.founding_milestone, COALESCE(r.season, 'legacy'), COALESCE(h.founding_day, 0), 'held', 0
  FROM hens h LEFT JOIN milestone_rolls r ON r.hen_id = h.id
  WHERE h.founding_milestone IS NOT NULL AND h.mint_tx IS NULL;
UPDATE milestone_rolls SET ticket_id = 'ticket-' || hen_id
  WHERE won AND hen_id IS NOT NULL AND EXISTS (SELECT 1 FROM feather_tickets t WHERE t.id = 'ticket-' || milestone_rolls.hen_id);
UPDATE hens SET founding_milestone = NULL, founding_day = NULL, founding_no = NULL
  WHERE founding_milestone IS NOT NULL AND mint_tx IS NULL;
-- days in good standing (the management score), counted at each day close
ALTER TABLE farms ADD COLUMN good_days integer NOT NULL DEFAULT 0;
-- the day's full settlement, exactly as hashed: its SHA-256 is the digest the chain stores
ALTER TABLE market_days ADD COLUMN settlement_json text;
ALTER TABLE market_days ADD COLUMN settlement_digest text;
-- version 2's per-day records, copied here before the contract released them (scripts/release-chain-days.ts)
CREATE TABLE chain_archive (
  season text NOT NULL,
  day integer NOT NULL,
  -- exactly as day_record returned it: the archive hash folds this text
  record text NOT NULL,
  released_at bigint NOT NULL,
  PRIMARY KEY (season, day)
);
`,
  },
  {
    id: 10,
    name: 'farm names',
    sql: `
-- Farm names are chosen by players (or generated), never taken from sign-in. name_source: legacy
-- (named before this, renamed at boot), generated, chosen, or agent. needs_name: ask the owner to
-- pick one on their next visit. renamed_day: the last rename in Settings (once an in-game week).
ALTER TABLE farms ADD COLUMN name_source text NOT NULL DEFAULT 'legacy' CHECK (name_source IN ('legacy', 'generated', 'chosen', 'agent'));
ALTER TABLE farms ADD COLUMN needs_name boolean NOT NULL DEFAULT false;
ALTER TABLE farms ADD COLUMN renamed_day integer;
UPDATE farms SET name_source = 'agent' WHERE owner_kind = 'agent';
-- the player's email name, kept only as its SHA-256 (letters and digits, lower case) and length, so
-- a farm name that contains it can be refused without the server ever holding it
ALTER TABLE players ADD COLUMN name_guard_sha256 text;
ALTER TABLE players ADD COLUMN name_guard_len integer;
`,
  },
  {
    id: 11,
    name: 'machine wear',
    sql: `
-- Machines wear: condition 1 (new) to 0, falling each in-game day a machine works (the cart: each
-- delivery). Below a threshold a day close may break it; a broken machine stops until repaired.
ALTER TABLE unlocks ADD COLUMN condition double precision NOT NULL DEFAULT 1 CHECK (condition >= 0 AND condition <= 1);
ALTER TABLE unlocks ADD COLUMN broken boolean NOT NULL DEFAULT false;
`,
  },
  {
    id: 12,
    name: 'instant mints',
    sql: `
-- Instant mints: redeeming a ticket draws its Feather's number at once (a random free number, from a
-- seed anyone can check, kept here with the transaction it came from) and sends its mint at once,
-- game-paid. A test season's Feathers have their own collection (token ids "test-..."), so a number
-- is unique within its collection: the token id is the unique key now.
ALTER TABLE feather_tickets DROP CONSTRAINT IF EXISTS feather_tickets_number_key;
CREATE UNIQUE INDEX feather_tickets_token ON feather_tickets (token_id);
ALTER TABLE feather_tickets ADD COLUMN number_seed text;
ALTER TABLE feather_tickets ADD COLUMN number_anchor text;
-- where a queued ticket's mint stands: waiting (for a wallet, the chain or a day close), sending
ALTER TABLE feather_tickets ADD COLUMN mint_state text CHECK (mint_state IN ('waiting', 'sending'));
ALTER TABLE feather_tickets ADD COLUMN mint_note text;
ALTER TABLE feather_tickets ADD COLUMN mint_tries integer NOT NULL DEFAULT 0;
`,
  },
  {
    id: 13,
    name: 'agent upgrades and ai farm entry',
    sql: `
-- What an agent keeps between decisions: its weekly reflection (under 400 characters) and the day it
-- was written, the numbers its week started from (day, cash, deals, refusals), and its last few
-- public one-line reasons (newest last), which players see on the market board.
ALTER TABLE agents ADD COLUMN reflection text;
ALTER TABLE agents ADD COLUMN reflection_day integer;
ALTER TABLE agents ADD COLUMN week_start jsonb;
ALTER TABLE agents ADD COLUMN reasons jsonb NOT NULL DEFAULT '[]';
-- AI farms that enter the street (the entrant registry, agents/entrants.ts) are rivals keyed by their
-- registry entry. Base cast members have none and stay one agent per kind and generation; an
-- entrant numbers its own generations.
ALTER TABLE agents ADD COLUMN entrant_key text;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_generation_key;
CREATE UNIQUE INDEX agents_base_generation ON agents (kind, generation) WHERE entrant_key IS NULL;
CREATE UNIQUE INDEX agents_entrant_generation ON agents (entrant_key, generation) WHERE entrant_key IS NOT NULL;

-- NEAR AI Cloud calls and spend per agent per UTC day, against the per-agent cap
CREATE TABLE agent_inference_usage (
  agent_id text NOT NULL,
  utc_day text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  fallbacks integer NOT NULL DEFAULT 0,
  spend_micro_usd bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, utc_day)
);

-- Agent wallets: a pool. Every sub-account the game created (or linked) for an agent, with the key
-- seed it was made from and the NEAR it was funded with. A wallet whose agents are all bust is free
-- for the next agent of any kind. Wallets made before the pool are listed with unknown funding.
CREATE TABLE agent_wallets (
  account text PRIMARY KEY,
  key_seed text NOT NULL,
  key_generation integer NOT NULL,
  funded_near double precision,
  created_for text,
  created_at bigint NOT NULL
);
INSERT INTO agent_wallets (account, key_seed, key_generation, funded_near, created_for, created_at)
SELECT DISTINCT ON (near_account_id) near_account_id, kind, generation, NULL, id, 0
FROM agents WHERE near_account_id IS NOT NULL ORDER BY near_account_id, generation;
`,
  },
  {
    id: 14,
    name: 'profiles and badges',
    sql: `
-- The player profile: one row per farm per closed day, written at each day close (game/profile.ts).
-- Net worth is coins plus hens at the hen price, coops at their price and machines at their price
-- times their condition. Rank is the farm's place among the open farms by coins (1 the richest),
-- null when it was not open. laid, collected (by hand or belt before midnight), broken and sold are
-- egg counts by grade (JSON objects); share is the farm's share of all the eggs the street sold that
-- day (0 to 1); fed is the laying multiplier its feed gave that day; good is its standing at the close.
CREATE TABLE farm_days (
  farm_id text NOT NULL REFERENCES farms(id),
  day integer NOT NULL,
  cash_milli bigint NOT NULL,
  net_worth_milli bigint NOT NULL,
  rank integer,
  open_farms integer NOT NULL DEFAULT 0,
  hens integer,
  profit_milli bigint NOT NULL DEFAULT 0,
  laid jsonb,
  collected jsonb,
  broken jsonb,
  laid_n integer,
  sold jsonb NOT NULL DEFAULT '{}',
  sold_n integer NOT NULL DEFAULT 0,
  share double precision NOT NULL DEFAULT 0,
  fed double precision,
  good boolean,
  -- made from history when this migration first ran, not written at the day's close
  estimated boolean NOT NULL DEFAULT false,
  PRIMARY KEY (farm_id, day)
);

-- Counters a profile and its badges need that nothing kept before: eggs into the crate (by hand, by
-- the conveyor or at midnight), eggs picked up by hand, laid and broken, golden eggs collected, buyer
-- orders filled, haggles lost, contract days delivered (and in a row since the last miss), hens bought
-- at auction, repairs paid (and in a row before any breakdown), breakdowns, actions at night, the
-- rooster crow streak (an action at dawn on days in a row), and every hen look the farm has kept.
CREATE TABLE farm_stats (
  farm_id text PRIMARY KEY REFERENCES farms(id),
  eggs_laid integer NOT NULL DEFAULT 0,
  eggs_collected integer NOT NULL DEFAULT 0,
  eggs_picked integer NOT NULL DEFAULT 0,
  eggs_broken integer NOT NULL DEFAULT 0,
  golden_collected integer NOT NULL DEFAULT 0,
  orders_filled integer NOT NULL DEFAULT 0,
  haggles_lost integer NOT NULL DEFAULT 0,
  deliveries integer NOT NULL DEFAULT 0,
  delivery_streak integer NOT NULL DEFAULT 0,
  best_delivery_streak integer NOT NULL DEFAULT 0,
  auction_hens integer NOT NULL DEFAULT 0,
  repairs integer NOT NULL DEFAULT 0,
  repair_streak integer NOT NULL DEFAULT 0,
  best_repair_streak integer NOT NULL DEFAULT 0,
  breakdowns integer NOT NULL DEFAULT 0,
  last_breakdown_day integer,
  night_actions integer NOT NULL DEFAULT 0,
  crow_streak integer NOT NULL DEFAULT 0,
  best_crow_streak integer NOT NULL DEFAULT 0,
  last_crow_day integer,
  traits_seen jsonb NOT NULL DEFAULT '[]',
  -- made from history at the first boot after this migration (see below)
  backfilled boolean NOT NULL DEFAULT false
);

-- Badges (cosmetic): one row per farm and badge, with the tier held (bronze, silver, gold, or plain
-- for a badge without levels; null while locked), the day it was earned, and the badge's count now.
CREATE TABLE badges (
  farm_id text NOT NULL REFERENCES farms(id),
  badge text NOT NULL,
  tier text CHECK (tier IN ('bronze', 'silver', 'gold', 'plain')),
  earned_day integer,
  progress bigint NOT NULL DEFAULT 0,
  backfilled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (farm_id, badge)
);
CREATE INDEX badges_earned ON badges (farm_id) WHERE tier IS NOT NULL;
CREATE INDEX trades_seller ON trades (seller_farm);
CREATE INDEX orders_farm ON orders (farm_id);

-- Farms from before this migration are filled in from their history at the next boot, once (an
-- idempotent step: game/profile.ts backfillProfiles, for every farm without a farm_stats row). From
-- the ledger: coins, profit and rank on every closed day, and repairs paid. From the trades: eggs sold
-- by grade and share each day, buyer orders filled, contract days delivered and the streak since the
-- last miss. From agent_memory: haggles lost. From the crate and the trades: eggs into the crate and
-- golden eggs (estimates). From hens, coops and unlocks: net worth each day (estimated with today's
-- hens and machine condition) and the hen looks kept. From the two days lay_events still holds: laid,
-- collected and broken on those days. What cannot be filled in, and starts at zero (or null) from
-- this migration: eggs laid, collected and broken on older days, eggs picked up by hand, hens bought
-- at auction (estimated from single auction purchases only), repairs in a row before a breakdown, past
-- breakdowns (only machines broken now count), actions at night, the rooster crow streak, feed and
-- standing on older days. Badges are then earned from what is known, quietly, as of the boot day.
`,
  },
  {
    id: 15,
    name: 'inference providers',
    sql: `
-- Model calls per provider (nearai, serv) per UTC day: answered and failed calls, the tokens the
-- provider counted and the estimated spend. The shared cap still reads inference_usage, which every
-- provider's calls add to.
CREATE TABLE provider_usage (
  utc_day text NOT NULL,
  provider text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  spend_micro_usd bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, provider)
);

-- failed calls: they count toward an agent's daily call cap
ALTER TABLE inference_usage ADD COLUMN failures integer NOT NULL DEFAULT 0;
ALTER TABLE agent_inference_usage ADD COLUMN failures integer NOT NULL DEFAULT 0;

-- each agent's latest model answer: the provider, the in-game day, and the multiplier it decided at
-- (a price move past LLM_PRICE_MOVE from it makes the next decision a model one)
ALTER TABLE agents ADD COLUMN model_provider text;
ALTER TABLE agents ADD COLUMN model_day integer;
ALTER TABLE agents ADD COLUMN model_multiplier double precision;
`,
  },
  {
    id: 16,
    name: 'land plots',
    sql: `
-- Land: the plots a farm has bought around its home plot (east, west, north, south), the day each
-- was bought and what it cost. A plot adds coop plots numbered after the home plot's four (0 to 3),
-- in the fixed order of ECONOMY.land, so coops already built keep their numbers and stay valid.
CREATE TABLE farm_land (
  farm_id text NOT NULL REFERENCES farms(id),
  plot text NOT NULL CHECK (plot IN ('east', 'west', 'north', 'south')),
  bought_day integer NOT NULL,
  price_milli bigint NOT NULL,
  PRIMARY KEY (farm_id, plot)
);
`,
  },
  {
    id: 17,
    name: 'settlement ranges',
    sql: `
-- Days settle on the chain in ranges (SETTLE_EVERY_DAYS, default 10): a closed day waits as
-- 'batched' until its range is sent, then every day of the range is 'sent' with the range's one
-- transaction, its digest and its first and last day. The range's full record (each day's own
-- record, as the database holds it, and the range's egg moves) is kept on its last day.
ALTER TABLE market_days DROP CONSTRAINT IF EXISTS market_days_settlement_status_check;
ALTER TABLE market_days ADD CONSTRAINT market_days_settlement_status_check
  CHECK (settlement_status IN ('pending', 'batched', 'sent', 'noop', 'failed'));
ALTER TABLE market_days ADD COLUMN settlement_first integer;
ALTER TABLE market_days ADD COLUMN settlement_last integer;
`,
  },
];

/** Key for the Postgres advisory lock that serialises migrations across server instances. */
const MIGRATION_LOCK = 727_274_001;

const record = (m: { id: number; name: string }): string =>
  `INSERT INTO schema_migrations (id, name, applied_at) VALUES (${m.id}, '${m.name.replace(/'/g, "''")}', ${Date.now()})`;

/**
 * Applies pending migrations on boot; safe to run again and again. On Postgres everything runs in
 * one transaction under an advisory lock, so two instances booting at once cannot race and a
 * failed migration leaves nothing half applied. PGlite is one process, one migration at a time.
 */
export async function migrate(db: Db): Promise<number[]> {
  const table = `CREATE TABLE IF NOT EXISTS schema_migrations (
    id integer PRIMARY KEY,
    name text NOT NULL,
    applied_at bigint NOT NULL
  )`;
  const applied: number[] = [];
  if (db.kind === 'postgres') {
    await db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
      await q.query(table);
      const done = new Set((await q.query<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => Number(r.id)));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        // no parameters: the simple protocol runs every statement of the migration
        await q.query(m.sql);
        await q.query(record(m));
        applied.push(m.id);
      }
    });
    return applied;
  }
  await db.exec(table);
  const done = new Set((await db.query<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => Number(r.id)));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.exec(`BEGIN;\n${m.sql}\n${record(m)};\nCOMMIT;`);
    applied.push(m.id);
  }
  return applied;
}
