-- Sea Scout · migration 0005 · stay inside Cloudflare's free plan (r14.15.67).
-- data_proxy: route ERDDAP requests through the shared-cache Worker. Off by default, because on the free plan its
-- requests share the account's 100k Worker requests/day with sign-in. Turn on after moving to Workers Paid.
INSERT OR IGNORE INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('data_proxy', 0, 'Use the shared-cache Worker for ocean data (needs Workers Paid at scale; off = devices fetch NOAA directly)', 0, 'migration');
