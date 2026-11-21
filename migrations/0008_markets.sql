-- Sea Scout · migration 0008 · country-aware marketplace links (r14.15.74).
-- The "intermediary": for each country, the shops people there use most (admin-editable, ordered by rank). For each
-- shop and tackle type the cron makes ONE affiliate deeplink to that shop's own search page for the tackle keyword,
-- through the affiliate network that has the shop (Involve Asia, Admitad) or the Amazon Associates tag. The links are
-- stored as products (source = 'market') with one offer for that country, so the catalogue, the click redirect and
-- admin blocking work as before. No ratings or sales are shown for these (the networks give none) — they are labelled
-- as a search in that shop. Inactive until the network keys are set and the flag market_links is on.

CREATE TABLE IF NOT EXISTS marketplaces (
  id          TEXT PRIMARY KEY,                 -- e.g. lazada_th
  name        TEXT NOT NULL,                    -- shown in the app
  country     TEXT NOT NULL,                    -- ISO alpha-2: shown to users in this country
  lang        TEXT NOT NULL,                    -- keyword language for this shop's search
  network     TEXT NOT NULL CHECK (network IN ('involve','admitad','amazon')),
  advertiser  TEXT NOT NULL,                    -- brand to look for at the network (with the country), case-insensitive
  program_id  TEXT,                             -- found automatically (or typed by an admin)
  search_url  TEXT NOT NULL,                    -- https://… with {q} (URL-encoded) or {qh} (words joined by -)
  rank        INTEGER NOT NULL DEFAULT 1,       -- 1 = most used in that country
  active      INTEGER NOT NULL DEFAULT 1,
  merchant_id TEXT NOT NULL,
  status      TEXT,                             -- last result: ok | waiting_keys | program_not_found | error …
  links       INTEGER NOT NULL DEFAULT 0,
  checked_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS marketplaces_country ON marketplaces(country, rank);

CREATE TABLE IF NOT EXISTS market_keywords (
  id       TEXT NOT NULL,                       -- tackle group
  lang     TEXT NOT NULL,
  keyword  TEXT NOT NULL,
  tags     TEXT NOT NULL,                       -- JSON: app tackle profiles this search is shown for
  PRIMARY KEY (id, lang)
);

INSERT OR IGNORE INTO merchants (id, name, kind, active, created_at) VALUES
  ('mer_mk_shopee_th____', 'Shopee TH', 'shopee', 1, 0),
  ('mer_mk_lazada_th____', 'Lazada TH', 'lazada', 1, 0),
  ('mer_mk_shopee_my____', 'Shopee MY', 'shopee', 1, 0),
  ('mer_mk_lazada_my____', 'Lazada MY', 'lazada', 1, 0),
  ('mer_mk_shopee_ph____', 'Shopee PH', 'shopee', 1, 0),
  ('mer_mk_lazada_ph____', 'Lazada PH', 'lazada', 1, 0),
  ('mer_mk_shopee_vn____', 'Shopee VN', 'shopee', 1, 0),
  ('mer_mk_lazada_vn____', 'Lazada VN', 'lazada', 1, 0),
  ('mer_mk_shopee_id____', 'Shopee ID', 'shopee', 1, 0),
  ('mer_mk_lazada_id____', 'Lazada ID', 'lazada', 1, 0),
  ('mer_mk_shopee_sg____', 'Shopee SG', 'shopee', 1, 0),
  ('mer_mk_lazada_sg____', 'Lazada SG', 'lazada', 1, 0),
  ('mer_mk_tokopedia_id_', 'Tokopedia ID', 'other', 1, 0),
  ('mer_mk_amazon_us____', 'Amazon US', 'amazon', 1, 0),
  ('mer_mk_amazon_ca____', 'Amazon CA', 'amazon', 1, 0),
  ('mer_mk_amazon_gb____', 'Amazon GB', 'amazon', 1, 0),
  ('mer_mk_amazon_de____', 'Amazon DE', 'amazon', 1, 0),
  ('mer_mk_amazon_fr____', 'Amazon FR', 'amazon', 1, 0),
  ('mer_mk_amazon_it____', 'Amazon IT', 'amazon', 1, 0),
  ('mer_mk_amazon_es____', 'Amazon ES', 'amazon', 1, 0),
  ('mer_mk_amazon_nl____', 'Amazon NL', 'amazon', 1, 0),
  ('mer_mk_amazon_se____', 'Amazon SE', 'amazon', 1, 0),
  ('mer_mk_amazon_pl____', 'Amazon PL', 'amazon', 1, 0),
  ('mer_mk_amazon_jp____', 'Amazon JP', 'amazon', 1, 0),
  ('mer_mk_amazon_au____', 'Amazon AU', 'amazon', 1, 0),
  ('mer_mk_amazon_sa____', 'Amazon SA', 'amazon', 1, 0),
  ('mer_mk_amazon_ae____', 'Amazon AE', 'amazon', 1, 0),
  ('mer_mk_amazon_in____', 'Amazon IN', 'amazon', 1, 0),
  ('mer_mk_amazon_mx____', 'Amazon MX', 'amazon', 1, 0),
  ('mer_mk_amazon_br____', 'Amazon BR', 'amazon', 1, 0),
  ('mer_mk_meli_mx______', 'Mercado Libre MX', 'other', 1, 0),
  ('mer_mk_meli_ar______', 'Mercado Libre AR', 'other', 1, 0),
  ('mer_mk_meli_co______', 'Mercado Libre CO', 'other', 1, 0),
  ('mer_mk_meli_cl______', 'Mercado Libre CL', 'other', 1, 0),
  ('mer_mk_meli_br______', 'Mercado Livre BR', 'other', 1, 0);

INSERT OR IGNORE INTO marketplaces (id, name, country, lang, network, advertiser, search_url, rank, merchant_id) VALUES
  ('shopee_th', 'Shopee', 'TH', 'th', 'involve', 'Shopee', 'https://shopee.co.th/search?keyword={q}', 1, 'mer_mk_shopee_th____'),
  ('lazada_th', 'Lazada', 'TH', 'th', 'involve', 'Lazada', 'https://www.lazada.co.th/catalog/?q={q}', 2, 'mer_mk_lazada_th____'),
  ('shopee_my', 'Shopee', 'MY', 'en', 'involve', 'Shopee', 'https://shopee.com.my/search?keyword={q}', 1, 'mer_mk_shopee_my____'),
  ('lazada_my', 'Lazada', 'MY', 'en', 'involve', 'Lazada', 'https://www.lazada.com.my/catalog/?q={q}', 2, 'mer_mk_lazada_my____'),
  ('shopee_ph', 'Shopee', 'PH', 'en', 'involve', 'Shopee', 'https://shopee.ph/search?keyword={q}', 1, 'mer_mk_shopee_ph____'),
  ('lazada_ph', 'Lazada', 'PH', 'en', 'involve', 'Lazada', 'https://www.lazada.com.ph/catalog/?q={q}', 2, 'mer_mk_lazada_ph____'),
  ('shopee_vn', 'Shopee', 'VN', 'vi', 'involve', 'Shopee', 'https://shopee.vn/search?keyword={q}', 1, 'mer_mk_shopee_vn____'),
  ('lazada_vn', 'Lazada', 'VN', 'vi', 'involve', 'Lazada', 'https://www.lazada.vn/catalog/?q={q}', 2, 'mer_mk_lazada_vn____'),
  ('shopee_id', 'Shopee', 'ID', 'id', 'involve', 'Shopee', 'https://shopee.co.id/search?keyword={q}', 1, 'mer_mk_shopee_id____'),
  ('lazada_id', 'Lazada', 'ID', 'id', 'involve', 'Lazada', 'https://www.lazada.co.id/catalog/?q={q}', 2, 'mer_mk_lazada_id____'),
  ('shopee_sg', 'Shopee', 'SG', 'en', 'involve', 'Shopee', 'https://shopee.sg/search?keyword={q}', 1, 'mer_mk_shopee_sg____'),
  ('lazada_sg', 'Lazada', 'SG', 'en', 'involve', 'Lazada', 'https://www.lazada.sg/catalog/?q={q}', 2, 'mer_mk_lazada_sg____'),
  ('tokopedia_id', 'Tokopedia', 'ID', 'id', 'involve', 'Tokopedia', 'https://www.tokopedia.com/search?st=product&q={q}', 3, 'mer_mk_tokopedia_id_'),
  ('amazon_us', 'Amazon', 'US', 'en', 'amazon', 'Amazon', 'https://www.amazon.com/s?k={q}', 1, 'mer_mk_amazon_us____'),
  ('amazon_ca', 'Amazon', 'CA', 'en', 'amazon', 'Amazon', 'https://www.amazon.ca/s?k={q}', 1, 'mer_mk_amazon_ca____'),
  ('amazon_gb', 'Amazon', 'GB', 'en', 'amazon', 'Amazon', 'https://www.amazon.co.uk/s?k={q}', 1, 'mer_mk_amazon_gb____'),
  ('amazon_de', 'Amazon', 'DE', 'en', 'amazon', 'Amazon', 'https://www.amazon.de/s?k={q}', 1, 'mer_mk_amazon_de____'),
  ('amazon_fr', 'Amazon', 'FR', 'en', 'amazon', 'Amazon', 'https://www.amazon.fr/s?k={q}', 1, 'mer_mk_amazon_fr____'),
  ('amazon_it', 'Amazon', 'IT', 'en', 'amazon', 'Amazon', 'https://www.amazon.it/s?k={q}', 1, 'mer_mk_amazon_it____'),
  ('amazon_es', 'Amazon', 'ES', 'es', 'amazon', 'Amazon', 'https://www.amazon.es/s?k={q}', 1, 'mer_mk_amazon_es____'),
  ('amazon_nl', 'Amazon', 'NL', 'en', 'amazon', 'Amazon', 'https://www.amazon.nl/s?k={q}', 1, 'mer_mk_amazon_nl____'),
  ('amazon_se', 'Amazon', 'SE', 'en', 'amazon', 'Amazon', 'https://www.amazon.se/s?k={q}', 1, 'mer_mk_amazon_se____'),
  ('amazon_pl', 'Amazon', 'PL', 'en', 'amazon', 'Amazon', 'https://www.amazon.pl/s?k={q}', 1, 'mer_mk_amazon_pl____'),
  ('amazon_jp', 'Amazon', 'JP', 'ja', 'amazon', 'Amazon', 'https://www.amazon.co.jp/s?k={q}', 1, 'mer_mk_amazon_jp____'),
  ('amazon_au', 'Amazon', 'AU', 'en', 'amazon', 'Amazon', 'https://www.amazon.com.au/s?k={q}', 1, 'mer_mk_amazon_au____'),
  ('amazon_sa', 'Amazon', 'SA', 'en', 'amazon', 'Amazon', 'https://www.amazon.sa/s?k={q}', 1, 'mer_mk_amazon_sa____'),
  ('amazon_ae', 'Amazon', 'AE', 'en', 'amazon', 'Amazon', 'https://www.amazon.ae/s?k={q}', 1, 'mer_mk_amazon_ae____'),
  ('amazon_in', 'Amazon', 'IN', 'en', 'amazon', 'Amazon', 'https://www.amazon.in/s?k={q}', 1, 'mer_mk_amazon_in____'),
  ('amazon_mx', 'Amazon', 'MX', 'es', 'amazon', 'Amazon', 'https://www.amazon.com.mx/s?k={q}', 2, 'mer_mk_amazon_mx____'),
  ('amazon_br', 'Amazon', 'BR', 'pt', 'amazon', 'Amazon', 'https://www.amazon.com.br/s?k={q}', 2, 'mer_mk_amazon_br____'),
  ('mercadolibre_mx', 'Mercado Libre', 'MX', 'es', 'admitad', 'Mercado Libre', 'https://listado.mercadolibre.com.mx/{qh}', 1, 'mer_mk_meli_mx______'),
  ('mercadolibre_ar', 'Mercado Libre', 'AR', 'es', 'admitad', 'Mercado Libre', 'https://listado.mercadolibre.com.ar/{qh}', 1, 'mer_mk_meli_ar______'),
  ('mercadolibre_co', 'Mercado Libre', 'CO', 'es', 'admitad', 'Mercado Libre', 'https://listado.mercadolibre.com.co/{qh}', 1, 'mer_mk_meli_co______'),
  ('mercadolibre_cl', 'Mercado Libre', 'CL', 'es', 'admitad', 'Mercado Libre', 'https://listado.mercadolibre.cl/{qh}', 1, 'mer_mk_meli_cl______'),
  ('mercadolibre_br', 'Mercado Livre', 'BR', 'pt', 'admitad', 'Mercado Livre', 'https://lista.mercadolivre.com.br/{qh}', 1, 'mer_mk_meli_br______');

INSERT OR IGNORE INTO market_keywords (id, lang, keyword, tags) VALUES
  ('squid', 'th', 'โยตกหมึก', '["squid","cuttle","deepSquid"]'),
  ('squid', 'en', 'squid jig egi', '["squid","cuttle","deepSquid"]'),
  ('squid', 'vi', 'mồi câu mực', '["squid","cuttle","deepSquid"]'),
  ('squid', 'id', 'umpan cumi egi', '["squid","cuttle","deepSquid"]'),
  ('squid', 'es', 'poteras calamar', '["squid","cuttle","deepSquid"]'),
  ('squid', 'pt', 'zangarelho lula', '["squid","cuttle","deepSquid"]'),
  ('squid', 'ja', 'エギ', '["squid","cuttle","deepSquid"]'),
  ('octopus', 'th', 'เหยื่อตกหมึกสาย', '["octopus"]'),
  ('octopus', 'en', 'octopus jig lure', '["octopus"]'),
  ('octopus', 'vi', 'mồi câu bạch tuộc', '["octopus"]'),
  ('octopus', 'id', 'umpan gurita', '["octopus"]'),
  ('octopus', 'es', 'señuelo pulpo', '["octopus"]'),
  ('octopus', 'pt', 'isca polvo', '["octopus"]'),
  ('octopus', 'ja', 'タコエギ', '["octopus"]'),
  ('bait', 'th', 'ซาบิกิ', '["bait"]'),
  ('bait', 'en', 'sabiki rig', '["bait"]'),
  ('bait', 'vi', 'lưỡi câu chùm sabiki', '["bait"]'),
  ('bait', 'id', 'pancing sabiki', '["bait"]'),
  ('bait', 'es', 'sabiki pesca', '["bait"]'),
  ('bait', 'pt', 'sabiki pesca', '["bait"]'),
  ('bait', 'ja', 'サビキ仕掛け', '["bait"]'),
  ('pelagic', 'th', 'เหยื่อจิ๊กตกปลาทะเล', '["pelagic","billfish"]'),
  ('pelagic', 'en', 'saltwater metal jig', '["pelagic","billfish"]'),
  ('pelagic', 'vi', 'mồi jig kim loại câu biển', '["pelagic","billfish"]'),
  ('pelagic', 'id', 'metal jig laut', '["pelagic","billfish"]'),
  ('pelagic', 'es', 'jig metálico pesca mar', '["pelagic","billfish"]'),
  ('pelagic', 'pt', 'jig metálico pesca', '["pelagic","billfish"]'),
  ('pelagic', 'ja', 'メタルジグ', '["pelagic","billfish"]'),
  ('toothy', 'th', 'สายสลิงตกปลา', '["toothy"]'),
  ('toothy', 'en', 'wire leader fishing', '["toothy"]'),
  ('toothy', 'vi', 'dây cáp thép câu cá', '["toothy"]'),
  ('toothy', 'id', 'kawat leader pancing', '["toothy"]'),
  ('toothy', 'es', 'cable de acero pesca', '["toothy"]'),
  ('toothy', 'pt', 'cabo de aço pesca', '["toothy"]'),
  ('toothy', 'ja', 'ワイヤーリーダー', '["toothy"]'),
  ('reef', 'th', 'ตาเบ็ดตกปลาทะเล', '["reef","bottom","ray"]'),
  ('reef', 'en', 'saltwater circle hook', '["reef","bottom","ray"]'),
  ('reef', 'vi', 'lưỡi câu biển', '["reef","bottom","ray"]'),
  ('reef', 'id', 'kail pancing laut', '["reef","bottom","ray"]'),
  ('reef', 'es', 'anzuelo circular mar', '["reef","bottom","ray"]'),
  ('reef', 'pt', 'anzol circular', '["reef","bottom","ray"]'),
  ('reef', 'ja', 'サークルフック', '["reef","bottom","ray"]'),
  ('bottom', 'th', 'ตะกั่วตกปลาทะเล', '["bottom","bottomCold","deep"]'),
  ('bottom', 'en', 'fishing sinker weight', '["bottom","bottomCold","deep"]'),
  ('bottom', 'vi', 'chì câu cá biển', '["bottom","bottomCold","deep"]'),
  ('bottom', 'id', 'timah pancing laut', '["bottom","bottomCold","deep"]'),
  ('bottom', 'es', 'plomo pesca mar', '["bottom","bottomCold","deep"]'),
  ('bottom', 'pt', 'chumbada pesca', '["bottom","bottomCold","deep"]'),
  ('bottom', 'ja', '釣り オモリ', '["bottom","bottomCold","deep"]'),
  ('coast', 'th', 'เหยื่อยางตกปลาทะเล', '["coast","mullet"]'),
  ('coast', 'en', 'saltwater soft plastic lure', '["coast","mullet"]'),
  ('coast', 'vi', 'mồi mềm câu biển', '["coast","mullet"]'),
  ('coast', 'id', 'soft lure laut', '["coast","mullet"]'),
  ('coast', 'es', 'vinilo pesca mar', '["coast","mullet"]'),
  ('coast', 'pt', 'isca soft pesca', '["coast","mullet"]'),
  ('coast', 'ja', 'ソルトワーム', '["coast","mullet"]'),
  ('light', 'th', 'ไฟล่อปลาใต้น้ำ', '["light"]'),
  ('light', 'en', 'underwater fishing light', '["light"]'),
  ('light', 'vi', 'đèn câu mực dưới nước', '["light"]'),
  ('light', 'id', 'lampu celup pancing', '["light"]'),
  ('light', 'es', 'luz sumergible pesca', '["light"]'),
  ('light', 'pt', 'luz subaquática pesca', '["light"]'),
  ('light', 'ja', '水中集魚灯', '["light"]'),
  ('line', 'th', 'สาย PE ตกปลา', '["all"]'),
  ('line', 'en', 'PE braided fishing line', '["all"]'),
  ('line', 'vi', 'dây dù PE câu cá', '["all"]'),
  ('line', 'id', 'senar PE pancing', '["all"]'),
  ('line', 'es', 'línea trenzada PE pesca', '["all"]'),
  ('line', 'pt', 'linha multifilamento PE', '["all"]'),
  ('line', 'ja', 'PEライン', '["all"]');

INSERT OR IGNORE INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('market_links', 0, 'Country-aware shop search links via Involve Asia / Admitad / Amazon (needs network keys)', 0, 'migration');
