-- Sea Scout · migration 0002 · global commerce (products, images, merchants, offers, clicks) + admin sessions.
-- Additive only. Images belong to a product; each offer (shop + country + price) has its own affiliate URL,
-- so a carousel slide can never open another product's link.

CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  title_i18n   TEXT,                 -- JSON {"en":"…","zh":"…"}
  description  TEXT,
  desc_i18n    TEXT,                 -- JSON
  brand        TEXT,
  tags         TEXT NOT NULL DEFAULT '["all"]',  -- JSON list: species ids (xsl, u…), tackle profiles (squid, light…), cat (reef…), squid/fish, all
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX products_active ON products(active, sort);

CREATE TABLE product_images (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  alt         TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX product_images_product ON product_images(product_id, sort);

CREATE TABLE merchants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('shopee','lazada','amazon','awin','impact','direct','other')),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE offers (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  country      TEXT NOT NULL DEFAULT '*',   -- ISO alpha-2, or * for everywhere
  currency     TEXT,
  price        REAL,
  url          TEXT NOT NULL,               -- affiliate URL of THIS offer
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX offers_product ON offers(product_id, active, country);

CREATE TABLE affiliate_clicks (
  id          TEXT PRIMARY KEY,
  offer_id    TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  merchant_id TEXT,
  at          INTEGER NOT NULL,
  country     TEXT,
  platform    TEXT,
  source      TEXT                          -- where in the app (species id / screen)
);
CREATE INDEX affiliate_clicks_at ON affiliate_clicks(at);
CREATE INDEX affiliate_clicks_offer ON affiliate_clicks(offer_id, at);

CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at  INTEGER,
  country     TEXT
);
CREATE INDEX admin_sessions_admin ON admin_sessions(admin_id);

INSERT INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('commerce_api', 1, 'App reads products/offers from the API (falls back to media/analysis.json)', 0, 'migration');
