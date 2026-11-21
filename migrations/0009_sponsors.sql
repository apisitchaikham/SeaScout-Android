-- Sea Scout · migration 0009 · self-serve sponsor banners (r14.15.75).
-- A shop uploads a banner + its shop link on the website (/advertise.html). The server checks it automatically
-- (banned words such as gambling, the linked page, Google Safe Browsing, Cloudflare AI on the picture and text).
-- If it passes, the shop pays through Stripe; once paid the banner goes live in the app's bottom strip for 30 days,
-- rotating with the other paid banners (10 s each). Banners keep being re-checked while live.

CREATE TABLE IF NOT EXISTS sponsor_ads (
  id            TEXT PRIMARY KEY,                -- spn_…
  status        TEXT NOT NULL CHECK (status IN ('checking','rejected','awaiting_payment','active','expired','suspended','removed')),
  business      TEXT NOT NULL,
  email         TEXT NOT NULL,
  link          TEXT NOT NULL,                   -- the shop's https link
  headline      TEXT,
  image_type    TEXT NOT NULL,                   -- image/webp | image/jpeg | image/png
  image_b64     TEXT NOT NULL,                   -- the banner (≤ 300 KB)
  image_hash    TEXT NOT NULL,
  manage_hash   TEXT NOT NULL,                   -- sha256 of the shop's private status-page token
  check_json    TEXT,                            -- what each check found
  reason        TEXT,                            -- why it was rejected / suspended (shown to the shop)
  check_tries   INTEGER NOT NULL DEFAULT 0,
  checked_at    INTEGER NOT NULL DEFAULT 0,
  paid_until    INTEGER NOT NULL DEFAULT 0,
  paid_total    INTEGER NOT NULL DEFAULT 0,      -- satang
  impressions   INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  reminded_at   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  country       TEXT,
  ip_hash       TEXT
);
CREATE INDEX IF NOT EXISTS sponsor_ads_status ON sponsor_ads(status, paid_until);
CREATE INDEX IF NOT EXISTS sponsor_ads_manage ON sponsor_ads(manage_hash);

CREATE TABLE IF NOT EXISTS sponsor_payments (
  session_id  TEXT PRIMARY KEY,                  -- Stripe Checkout Session id (one activation per payment)
  ad_id       TEXT NOT NULL,
  amount      INTEGER NOT NULL,                  -- smallest unit (satang)
  currency    TEXT NOT NULL,
  status      TEXT NOT NULL,                     -- created | paid
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER
);
CREATE INDEX IF NOT EXISTS sponsor_payments_ad ON sponsor_payments(ad_id, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('sponsor_price_thb', '5000'),   -- price for one period
  ('sponsor_days', '30'),          -- length of one period
  ('sponsor_max', '0'),            -- most banners live at once; 0 = no limit
  ('sponsor_rotate_s', '10');      -- seconds each banner stays on screen

INSERT OR IGNORE INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('sponsor_ads', 1, 'Bottom sponsor banner strip in the app + self-serve advertiser page', 0, 'migration');
