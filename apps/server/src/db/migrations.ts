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
];

export async function migrate(db: Db): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id integer PRIMARY KEY,
    name text NOT NULL,
    applied_at bigint NOT NULL
  )`);
  const done = new Set((await db.query<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => Number(r.id)));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.exec(
      `BEGIN;\n${m.sql}\nINSERT INTO schema_migrations (id, name, applied_at) VALUES (${m.id}, '${m.name.replace(/'/g, "''")}', ${Date.now()});\nCOMMIT;`,
    );
    applied.push(m.id);
  }
  return applied;
}
