-- Sea Scout · migration 0001 · central membership (shared by Android, iOS and the admin dashboard)
-- Times are Unix epoch milliseconds (INTEGER). IDs are random text IDs made by the API.
-- Additive only: nothing here touches existing data (there was no database before).


-- ---------- users & identity ----------
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL COLLATE NOCASE,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  password_hash   TEXT,                 -- base64 PBKDF2-SHA256; NULL for Google/Apple-only accounts
  password_salt   TEXT,
  password_iter   INTEGER,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE UNIQUE INDEX users_email_live ON users(email) WHERE status <> 'deleted';

CREATE TABLE user_profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name       TEXT,
  locale             TEXT,              -- th, en, zh, vi, my, km, ms, id, fil
  country            TEXT,              -- ISO 3166-1 alpha-2
  units              TEXT,
  privacy_consent_at INTEGER,           -- when the user accepted the privacy policy
  privacy_version    TEXT,
  marketing_consent  INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

-- Google / Apple sign-in (provider subject -> user)
CREATE TABLE identities (
  provider    TEXT NOT NULL CHECK (provider IN ('google','apple')),
  subject     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- ---------- devices & sessions ----------
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  install_id    TEXT NOT NULL,          -- random ID the app keeps per install
  platform      TEXT NOT NULL CHECK (platform IN ('android','ios','web')),
  model         TEXT,
  app_version   TEXT,
  push_token    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (user_id, install_id)
);

-- Opaque tokens; only SHA-256 hashes are stored. Refresh tokens rotate; re-use of an old one revokes the family.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT REFERENCES devices(id) ON DELETE SET NULL,
  family_id     TEXT NOT NULL,
  access_hash   TEXT NOT NULL UNIQUE,
  access_exp    INTEGER NOT NULL,
  refresh_hash  TEXT NOT NULL UNIQUE,
  refresh_exp   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  revoke_reason TEXT,
  user_agent    TEXT,
  country       TEXT
);
CREATE INDEX sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX sessions_family ON sessions(family_id);

-- Refresh tokens already rotated away (to detect theft / re-use)
CREATE TABLE used_refresh (
  refresh_hash TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL,
  used_at      INTEGER NOT NULL
);

-- Email verification / password reset (hash of the token only)
CREATE TABLE email_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);

-- ---------- plans, subscriptions, entitlements ----------
CREATE TABLE plans (
  id          TEXT PRIMARY KEY CHECK (id IN ('free','premium','pro')),
  name        TEXT NOT NULL,
  rank        INTEGER NOT NULL,          -- higher wins when a user has several
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE plan_entitlements (
  plan_id  TEXT NOT NULL REFERENCES plans(id),
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,                -- JSON value
  PRIMARY KEY (plan_id, key)
);

-- Store product -> plan (set when products exist in Google Play / App Store)
CREATE TABLE store_products (
  store       TEXT NOT NULL CHECK (store IN ('google','apple')),
  product_id  TEXT NOT NULL,
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  period      TEXT,                      -- P1M, P1Y …
  PRIMARY KEY (store, product_id)
);

CREATE TABLE subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id          TEXT NOT NULL REFERENCES plans(id),
  source           TEXT NOT NULL CHECK (source IN ('google','apple','manual','tester')),
  store_product_id TEXT,
  store_txn_id     TEXT,                 -- purchaseToken / originalTransactionId
  status           TEXT NOT NULL CHECK (status IN ('active','grace','paused','canceled','expired','revoked')),
  started_at       INTEGER NOT NULL,
  expires_at       INTEGER,              -- NULL = no expiry (manual grants)
  auto_renew       INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  UNIQUE (source, store_txn_id)
);
CREATE INDEX subscriptions_user ON subscriptions(user_id, status);

-- Per-user overrides on top of the plan (e.g. extra AI quota, a trial feature)
CREATE TABLE entitlements (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,             -- JSON value
  source      TEXT NOT NULL,             -- admin, promo, support …
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Raw store notifications / verifications, kept for audit and replay
CREATE TABLE payment_events (
  id            TEXT PRIMARY KEY,
  store         TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  store_txn_id  TEXT,
  user_id       TEXT,
  payload       TEXT,
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  result        TEXT
);
CREATE INDEX payment_events_txn ON payment_events(store, store_txn_id);

-- ---------- operations ----------
CREATE TABLE feature_flags (
  key          TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  rollout_pct  INTEGER NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT
);

CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','admin','system','store')),
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  details     TEXT,                      -- JSON, never secrets or passwords
  country     TEXT
);
CREATE INDEX audit_logs_at ON audit_logs(at);
CREATE INDEX audit_logs_actor ON audit_logs(actor_type, actor_id, at);

CREATE TABLE admin_users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','support','viewer')),
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Fixed-window counters for login/register throttling
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- ---------- seed: plans & entitlements (mirrors what the app gates today) ----------
INSERT INTO plans (id, name, rank) VALUES ('free','Free',0), ('premium','Premium',1), ('pro','Pro',2);

INSERT INTO plan_entitlements (plan_id, key, value) VALUES
  ('free','heatmap',             'false'),
  ('free','heatmap_forecast',    'false'),
  ('free','species_tackle',      'false'),
  ('free','pattern_memory',      'false'),
  ('free','advanced_forecast',   'false'),
  ('free','offline_regions',     '1'),
  ('free','ai_quota_daily',      '0'),
  ('free','navigation',          '"basic"'),
  ('free','ocean_data',          '"basic"'),
  ('premium','heatmap',          'true'),
  ('premium','heatmap_forecast', 'true'),
  ('premium','species_tackle',   'true'),
  ('premium','pattern_memory',   'true'),
  ('premium','advanced_forecast','true'),
  ('premium','offline_regions',  '5'),
  ('premium','ai_quota_daily',   '20'),
  ('premium','navigation',       '"full"'),
  ('premium','ocean_data',       '"full"'),
  ('pro','heatmap',              'true'),
  ('pro','heatmap_forecast',     'true'),
  ('pro','species_tackle',       'true'),
  ('pro','pattern_memory',       'true'),
  ('pro','advanced_forecast',    'true'),
  ('pro','offline_regions',      '20'),
  ('pro','ai_quota_daily',       '200'),
  ('pro','navigation',           '"full"'),
  ('pro','ocean_data',           '"full"');

INSERT INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('accounts',        1, 'Sign up / sign in in the app', 0, 'migration'),
  ('server_premium',  0, 'App trusts server entitlements instead of the local unlock', 0, 'migration'),
  ('tester_unlock',   1, 'Keep the existing tester code unlock (local)', 0, 'migration');
