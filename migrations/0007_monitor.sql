-- Sea Scout · migration 0007 · system health monitor (r14.15.73).
-- The existing 30-minute cron also takes a health snapshot: today's Worker requests / errors / CPU-limit hits and
-- D1 rows (Cloudflare GraphQL Analytics, read-only token), a quick check of the data servers the app depends on,
-- and the app crash reports counted per hour. Alerts are shown in the admin page and, if set up, emailed.

CREATE TABLE IF NOT EXISTS health_snapshots (
  at    INTEGER PRIMARY KEY,           -- ms
  level TEXT NOT NULL,                 -- ok | warn | crit
  data  TEXT NOT NULL                  -- JSON (numbers only, never secrets or personal data)
);

-- one row per alert rule; tracks when it started and when it was last emailed (no repeat spam)
CREATE TABLE IF NOT EXISTS monitor_alerts (
  id          TEXT PRIMARY KEY,        -- e.g. requests_day, d1_reads, cpu_limit, probe:noaa_tides, crashes
  level       TEXT NOT NULL,           -- ok | warn | crit
  message     TEXT NOT NULL,
  since       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  notified_at INTEGER,
  notified_level TEXT
);

-- app crash reports from /api/crash, counted per UTC hour and error kind (capped so a crash loop cannot burn D1 writes)
CREATE TABLE IF NOT EXISTS crash_counts (
  hour   INTEGER NOT NULL,             -- ms, start of the UTC hour
  key    TEXT NOT NULL,                -- kind + start of the message
  n      INTEGER NOT NULL DEFAULT 0,
  sample TEXT,                         -- first report of the hour: message, source, app version, platform (no user data)
  PRIMARY KEY (hour, key)
);

INSERT OR IGNORE INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('monitor', 1, 'Health snapshot every 30 minutes (usage, data servers, crashes) + alerts', 0, 'migration');
