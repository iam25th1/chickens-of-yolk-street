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
