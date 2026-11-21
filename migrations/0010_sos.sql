-- r14.15.80 · SOS between Sea Scout users (signed-in accounts only).
-- A user in trouble sends an alert (kind + GPS); users who switched on "receive SOS automatically" and are within
-- range see it, may accept, and their app predicts where the person / boat drifts before they arrive.
-- This is help between nearby boats, not an official rescue service — the app always shows official numbers too.

CREATE TABLE IF NOT EXISTS sos_alerts (
  id TEXT PRIMARY KEY,                 -- sos_<16>
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- piw | boat_anchored | boat_drifting | unknown
  status TEXT NOT NULL DEFAULT 'open', -- open | closed | expired
  people INTEGER,                      -- persons involved, if given
  lat REAL NOT NULL, lon REAL NOT NULL, acc REAL,          -- first fix
  last_lat REAL NOT NULL, last_lon REAL NOT NULL, last_acc REAL, last_at INTEGER NOT NULL, -- latest fix from the sender's phone
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  closed_at INTEGER, close_reason TEXT  -- safe | cancel | rescued | expired
);
CREATE INDEX IF NOT EXISTS idx_sos_open ON sos_alerts (status, last_lat);
CREATE INDEX IF NOT EXISTS idx_sos_user ON sos_alerts (user_id, created_at);

-- positions sent by the person in trouble (at most one every 10 s; kept while the alert lives + 7 days)
CREATE TABLE IF NOT EXISTS sos_track (
  alert_id TEXT NOT NULL, at INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, acc REAL,
  PRIMARY KEY (alert_id, at)
);

-- people who agreed to be alerted automatically; last known position (written at most every 2 min)
CREATE TABLE IF NOT EXISTS sos_helpers (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER,                  -- when they agreed (kept even after switching off)
  radius_km REAL NOT NULL DEFAULT 50,
  lat REAL, lon REAL, at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sos_helpers_pos ON sos_helpers (enabled, lat);

-- who accepted which alert; their position is shown only to the person in trouble
CREATE TABLE IF NOT EXISTS sos_responses (
  alert_id TEXT NOT NULL, user_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL, left_at INTEGER, outcome TEXT,  -- found | gave_up
  lat REAL, lon REAL, at INTEGER, speed_kn REAL,
  PRIMARY KEY (alert_id, user_id)
);

INSERT OR IGNORE INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('sos', 1, 'SOS between nearby Sea Scout users (r14.15.80)', 0, 'migration');
