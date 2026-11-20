-- Sea Scout · migration 0006 · products found automatically through affiliate network APIs (r14.15.68).
-- A scheduled job searches each network for the tackle that matches every fishing profile, keeps the best-rated /
-- best-selling items, and stores them with the network's own affiliate link. Admins only block or unblock items.
ALTER TABLE products ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';   -- manual | shopee | aliexpress
ALTER TABLE products ADD COLUMN ext_id TEXT;                              -- item id at the network
ALTER TABLE products ADD COLUMN query_id TEXT;                            -- shop_queries.id that found it
ALTER TABLE products ADD COLUMN rating REAL;                              -- as the network reports it
ALTER TABLE products ADD COLUMN rating_scale REAL;                        -- 5 = stars, 100 = positive-feedback %
ALTER TABLE products ADD COLUMN sales INTEGER;                            -- items sold, as the network reports it
ALTER TABLE products ADD COLUMN off_reason TEXT;                          -- NULL | dropped (fell out of the top list) | admin (blocked)
ALTER TABLE products ADD COLUMN refreshed_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS products_ext ON products(source, ext_id);

CREATE TABLE IF NOT EXISTS shop_queries (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL CHECK (source IN ('shopee','aliexpress')),
  keyword     TEXT NOT NULL,
  tags        TEXT NOT NULL,              -- JSON list of app tackle profiles the results are shown for
  active      INTEGER NOT NULL DEFAULT 1,
  last_run    INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_count  INTEGER
);

INSERT OR IGNORE INTO merchants (id, name, kind, active, created_at) VALUES
  ('mer_auto_shopee_____', 'Shopee', 'shopee', 1, 0),
  ('mer_auto_aliexpress_', 'AliExpress', 'other', 1, 0);

-- one Thai keyword (Shopee Thailand) and one English keyword (AliExpress, worldwide) per tackle profile used by the app
INSERT OR IGNORE INTO shop_queries (id, source, keyword, tags) VALUES
  ('q_sp_squid',     'shopee', 'โยตกหมึก',               '["squid","deepSquid"]'),
  ('q_sp_cuttle',    'shopee', 'โยตกหมึกกระดอง',         '["cuttle"]'),
  ('q_sp_octopus',   'shopee', 'เหยื่อตกหมึกสาย',         '["octopus"]'),
  ('q_sp_bait',      'shopee', 'ซาบิกิ',                  '["bait"]'),
  ('q_sp_pelagic',   'shopee', 'เหยื่อจิ๊กตกปลาทะเล',     '["pelagic","billfish"]'),
  ('q_sp_toothy',    'shopee', 'สายสลิงตกปลา',            '["toothy"]'),
  ('q_sp_reef',      'shopee', 'ตาเบ็ดตกปลาทะเล',         '["reef","bottom","ray"]'),
  ('q_sp_bottom',    'shopee', 'ตะกั่วตกปลาทะเล',         '["bottom","bottomCold","deep"]'),
  ('q_sp_coast',     'shopee', 'เหยื่อยางตกปลาทะเล',      '["coast","mullet"]'),
  ('q_sp_light',     'shopee', 'ไฟล่อปลาใต้น้ำ',          '["light","squid"]'),
  ('q_sp_line',      'shopee', 'สาย PE ตกปลา',           '["all"]'),
  ('q_ae_squid',     'aliexpress', 'squid jig egi',             '["squid","cuttle","deepSquid"]'),
  ('q_ae_octopus',   'aliexpress', 'octopus jig lure',          '["octopus"]'),
  ('q_ae_bait',      'aliexpress', 'sabiki rig',                '["bait"]'),
  ('q_ae_pelagic',   'aliexpress', 'saltwater metal jig',       '["pelagic"]'),
  ('q_ae_billfish',  'aliexpress', 'skirted trolling lure',     '["billfish"]'),
  ('q_ae_toothy',    'aliexpress', 'wire leader fishing',       '["toothy"]'),
  ('q_ae_reef',      'aliexpress', 'saltwater circle hook',     '["reef","bottom","ray"]'),
  ('q_ae_slow',      'aliexpress', 'slow pitch jig',            '["bottomCold","deep"]'),
  ('q_ae_coast',     'aliexpress', 'saltwater soft plastic lure','["coast","mullet"]'),
  ('q_ae_light',     'aliexpress', 'underwater fishing light',  '["light"]'),
  ('q_ae_line',      'aliexpress', 'PE braided fishing line',   '["all"]');

INSERT OR IGNORE INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('auto_shop', 0, 'Scheduled job fills the shop from affiliate network APIs (needs the network API keys)', 0, 'migration');
