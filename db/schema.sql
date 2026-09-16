-- Star Citizen org inventory bot - database schema.
-- Safe to run repeatedly: every statement is "IF NOT EXISTS".

-- ---------------------------------------------------------------------------
-- Catalog & lookup tables (seeded from db/seed-data.json)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
  category_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT
);

CREATE TABLE IF NOT EXISTS subcategories (
  subcategory_id      TEXT PRIMARY KEY,
  parent_category_id  TEXT NOT NULL REFERENCES categories (category_id),
  name                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  item_id         TEXT PRIMARY KEY,
  subcategory_id  TEXT NOT NULL REFERENCES subcategories (subcategory_id),
  name            TEXT NOT NULL,
  manufacturer    TEXT,
  unit            TEXT NOT NULL DEFAULT 'each',
  grade           TEXT,   -- A/B/C/D, ship components only
  class           TEXT,   -- Military/Civilian/Industrial/Stealth/Competition, ship components only
  notes           TEXT
);

-- Per-material ore/mineral quality thresholds (minimum reading for each tier).
CREATE TABLE IF NOT EXISTS ore_mineral_quality (
  item_id        TEXT PRIMARY KEY REFERENCES items (item_id),
  material_type  TEXT,
  tier_f_min     INTEGER,
  tier_e_min     INTEGER,
  tier_d_min     INTEGER,
  tier_c_min     INTEGER,
  tier_b_min     INTEGER,
  tier_a_min     INTEGER,
  tier_s_min     INTEGER,
  tier_perfect   INTEGER NOT NULL DEFAULT 1000,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS systems (
  system_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,
  notes      TEXT
);

CREATE TABLE IF NOT EXISTS planets (
  planet_id         TEXT PRIMARY KEY,
  parent_system_id  TEXT REFERENCES systems (system_id),  -- NULL only for PLNONE ("No Planet")
  name              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS location_types (
  location_type_id  TEXT PRIMARY KEY,
  parent_system_id  TEXT NOT NULL REFERENCES systems (system_id),
  name              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  location_id              TEXT PRIMARY KEY,
  parent_location_type_id  TEXT NOT NULL REFERENCES location_types (location_type_id),
  parent_planet_id         TEXT NOT NULL REFERENCES planets (planet_id),
  name                     TEXT NOT NULL,
  planet_or_body           TEXT,
  notes                    TEXT
);

-- Crafting blueprints (patch 4.10 pool). Blueprints are permanent per character and
-- can't be traded, so they're tracked as a "who knows what" registry, not as inventory.
CREATE TABLE IF NOT EXISTS blueprint_categories (
  category_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS blueprint_subcategories (
  subcategory_id      TEXT PRIMARY KEY,
  parent_category_id  TEXT NOT NULL REFERENCES blueprint_categories (category_id),
  name                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blueprints (
  blueprint_id      TEXT PRIMARY KEY,
  subcategory_id    TEXT NOT NULL REFERENCES blueprint_subcategories (subcategory_id),
  name              TEXT NOT NULL,
  game_key          TEXT NOT NULL UNIQUE,
  game_type         TEXT,
  grade             TEXT,
  size              TEXT,
  craft_minutes     INTEGER,
  default_unlocked  BOOLEAN NOT NULL DEFAULT false,
  materials         TEXT,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS blueprints_subcategory_idx ON blueprints (subcategory_id);

-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS members (
  member_id         BIGINT PRIMARY KEY,           -- Discord user ID
  rsi_handle        TEXT,
  discord_username  TEXT,
  org_rank          TEXT,
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  active            BOOLEAN NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which member has unlocked which blueprint (self-service registry).
CREATE TABLE IF NOT EXISTS member_blueprints (
  member_id     BIGINT NOT NULL REFERENCES members (member_id),
  blueprint_id  TEXT NOT NULL REFERENCES blueprints (blueprint_id),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, blueprint_id)
);

CREATE INDEX IF NOT EXISTS member_blueprints_blueprint_idx ON member_blueprints (blueprint_id);

-- ---------------------------------------------------------------------------
-- Inventory & audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory (
  id               BIGSERIAL PRIMARY KEY,
  item_id          TEXT NOT NULL REFERENCES items (item_id),
  owner_member_id  BIGINT NOT NULL REFERENCES members (member_id),
  designation      TEXT NOT NULL CHECK (designation IN ('personal', 'org')),
  quantity         NUMERIC NOT NULL CHECK (quantity > 0),
  location_id      TEXT NOT NULL REFERENCES locations (location_id),
  quality_reading  INTEGER CHECK (quality_reading BETWEEN 1 AND 1000),
  quality_tier     TEXT,
  logged_by        BIGINT NOT NULL REFERENCES members (member_id),
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One record per (item, owner, designation, location, quality). Adding more of the
-- same thing merges into the existing record instead of creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_merge_key
  ON inventory (item_id, owner_member_id, designation, location_id, (COALESCE(quality_reading, -1)));

CREATE INDEX IF NOT EXISTS inventory_owner_idx    ON inventory (owner_member_id);
CREATE INDEX IF NOT EXISTS inventory_location_idx ON inventory (location_id);
CREATE INDEX IF NOT EXISTS inventory_item_idx     ON inventory (item_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                 BIGSERIAL PRIMARY KEY,
  "timestamp"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id           BIGINT NOT NULL REFERENCES members (member_id),
  action_type        TEXT NOT NULL CHECK (action_type IN ('add', 'remove', 'transfer_out', 'transfer_in', 'adjust', 'wipe', 'wipe_revert')),
  item_id            TEXT NOT NULL REFERENCES items (item_id),
  owner_member_id    BIGINT NOT NULL REFERENCES members (member_id),
  designation        TEXT NOT NULL,
  location_id        TEXT NOT NULL REFERENCES locations (location_id),
  quantity_delta     NUMERIC NOT NULL,
  quality_reading    INTEGER,
  quality_tier       TEXT,
  transfer_group_id  UUID,
  request_id         BIGINT,          -- set when the change came from an approved ticket (Phase 5)
  note               TEXT
);

-- 'wipe' rows record stock cleared by a partial /wipe-inventory (e.g. only ores);
-- 'wipe_revert' rows record that stock coming back through /wipe-revert.
-- Re-applied on every start so databases created before 'wipe' existed pick it up.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_action_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_action_type_check
  CHECK (action_type IN ('add', 'remove', 'transfer_out', 'transfer_in', 'adjust', 'wipe', 'wipe_revert'));

CREATE INDEX IF NOT EXISTS transactions_item_idx     ON transactions (item_id);
CREATE INDEX IF NOT EXISTS transactions_owner_idx    ON transactions (owner_member_id);
CREATE INDEX IF NOT EXISTS transactions_actor_idx    ON transactions (actor_id);
CREATE INDEX IF NOT EXISTS transactions_location_idx ON transactions (location_id);
CREATE INDEX IF NOT EXISTS transactions_time_idx     ON transactions ("timestamp");
CREATE INDEX IF NOT EXISTS transactions_group_idx    ON transactions (transfer_group_id);

-- ---------------------------------------------------------------------------
-- Member tickets (used in Phase 5; created now so no migration is needed later)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS requests (
  id                           BIGSERIAL PRIMARY KEY,
  requester_member_id          BIGINT NOT NULL REFERENCES members (member_id),
  request_type                 TEXT NOT NULL CHECK (request_type IN ('add', 'remove', 'transfer')),
  item_id                      TEXT NOT NULL REFERENCES items (item_id),
  quantity                     NUMERIC NOT NULL CHECK (quantity > 0),
  quality_reading              INTEGER,
  source_inventory_id          BIGINT,
  source_owner_member_id       BIGINT REFERENCES members (member_id),
  source_location_id           TEXT REFERENCES locations (location_id),
  source_designation           TEXT,
  destination_owner_member_id  BIGINT REFERENCES members (member_id),
  destination_location_id      TEXT REFERENCES locations (location_id),
  destination_designation      TEXT,
  note                         TEXT,
  status                       TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'approved_edited', 'rejected', 'cancelled')),
  reviewed_by                  BIGINT REFERENCES members (member_id),
  reviewed_at                  TIMESTAMPTZ,
  rejection_reason             TEXT,
  transfer_group_id            UUID,
  message_id                   BIGINT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_pending_idx ON requests (requester_member_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Game-wipe resets (/wipe-inventory) and their archives (/wipe-revert)
-- A wipe moves rows into the archived_* tables instead of deleting them, so it can be undone.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wipes (
  wipe_id                  BIGSERIAL PRIMARY KEY,
  wipe_type                TEXT NOT NULL,                 -- ores, components, ..., full, full_blueprints, blueprints
  wiped_by                 BIGINT NOT NULL REFERENCES members (member_id),
  wiped_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  counts                   JSONB NOT NULL DEFAULT '{}',   -- what was removed, e.g. {"inventory": 12}
  logs_archive_channel_id  TEXT,                          -- full wipes: the old #logs, renamed and hidden
  reverted_by              BIGINT REFERENCES members (member_id),
  reverted_at              TIMESTAMPTZ,
  revert_logs_channel_id   TEXT                           -- full-wipe reverts: the #logs used between wipe and revert
);

CREATE TABLE IF NOT EXISTS archived_inventory (
  wipe_id  BIGINT NOT NULL REFERENCES wipes (wipe_id),
  LIKE inventory
);
CREATE TABLE IF NOT EXISTS archived_transactions (
  wipe_id  BIGINT NOT NULL REFERENCES wipes (wipe_id),
  LIKE transactions
);
CREATE TABLE IF NOT EXISTS archived_requests (
  wipe_id  BIGINT NOT NULL REFERENCES wipes (wipe_id),
  LIKE requests
);
CREATE TABLE IF NOT EXISTS archived_member_blueprints (
  wipe_id  BIGINT NOT NULL REFERENCES wipes (wipe_id),
  LIKE member_blueprints
);

CREATE INDEX IF NOT EXISTS archived_inventory_wipe_idx         ON archived_inventory (wipe_id);
CREATE INDEX IF NOT EXISTS archived_transactions_wipe_idx      ON archived_transactions (wipe_id);
CREATE INDEX IF NOT EXISTS archived_requests_wipe_idx          ON archived_requests (wipe_id);
CREATE INDEX IF NOT EXISTS archived_member_blueprints_wipe_idx ON archived_member_blueprints (wipe_id);

-- ---------------------------------------------------------------------------
-- Bot settings (channel IDs saved by /setup-server)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bot_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
