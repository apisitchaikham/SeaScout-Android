// Sea Scout · country-aware marketplace links — "the intermediary" (r14.15.74).
// Users in each country are sent to the shops people there actually use (table marketplaces, admin-editable):
//   TH/MY/PH/VN/SG → Shopee, Lazada · ID → Shopee, Lazada, Tokopedia (Involve Asia)
//   US/CA/EU/JP/AU/… → Amazon (Associates tag) · MX/AR/CO/CL/BR → Mercado Libre (Admitad) · elsewhere → AliExpress products.
// Involve Asia and Admitad have no product-search API, so for every shop × tackle type the cron makes ONE affiliate
// deeplink to that shop's own search page for the tackle keyword (in the shop's language). These are stored as products
// with source = 'market' and one offer for that country; the app labels them "search in <shop>" — no ratings or
// sales are shown for them because the networks provide none.
//
// Settings (Cloudflare → Worker → Variables; secrets as Secret):
//   Involve Asia:  INVOLVE_API_KEY, INVOLVE_API_SECRET            [INVOLVE_API_URL]
//   Admitad:       ADMITAD_CLIENT_ID, ADMITAD_CLIENT_SECRET, ADMITAD_WEBSITE_ID (ad space id)   [ADMITAD_API_URL]
//   Amazon:        AMAZON_TAGS = {"US":"yourtag-20","GB":"yourtag-21",…}  (Associates tracking id per store)
// Budget per cron run: one marketplace, ≤ 8 network calls, ≈ 30 D1 rows written. Off until flag market_links is on.
import { newId } from './util.js';

const KEEP_DAYS = 60, DAY = 86400e3, MAX_LINKS_PER_RUN = 6;
const CC_NAME = { TH: 'Thailand', MY: 'Malaysia', PH: 'Philippines', VN: 'Vietnam', ID: 'Indonesia', SG: 'Singapore', MX: 'Mexico', AR: 'Argentina', CO: 'Colombia', CL: 'Chile', BR: 'Brazil' };
const httpsOk = (u) => typeof u === 'string' && /^https:\/\//i.test(u) && u.length < 2048;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export const configured = {
  involve: (env) => !!(env.INVOLVE_API_KEY && env.INVOLVE_API_SECRET),
  admitad: (env) => !!(env.ADMITAD_CLIENT_ID && env.ADMITAD_CLIENT_SECRET && env.ADMITAD_WEBSITE_ID),
  amazon: (env) => Object.keys(amazonTags(env)).length > 0,
};
function amazonTags(env) { try { const o = JSON.parse(env.AMAZON_TAGS || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }

export function searchUrl(tpl, kw) {
  const q = encodeURIComponent(kw), qh = String(kw).trim().toLowerCase().split(/\s+/).map(encodeURIComponent).join('-');
  const u = String(tpl).replace('{q}', q).replace('{qh}', qh);
  return httpsOk(u) ? u : null;
}

// choose the network program for a shop: name must contain the brand; prefer the one that names the country
export function pickProgram(list, brand, cc) {
  const b = norm(brand), c = norm(CC_NAME[cc] || ''), code = cc.toLowerCase();
  const hits = list.filter((p) => norm(p.name).includes(b));
  if (!hits.length) return null;
  const score = (p) => {
    const n = norm(p.name), regs = (p.regions || []).map((r) => String(r).toLowerCase());
    return (c && n.includes(c) ? 2 : 0) + (regs.includes(code) ? 2 : 0) + (new RegExp(`(^|[^a-z])${code}([^a-z]|$)`, 'i').test(p.name) ? 1 : 0);
  };
  const best = hits.map((p) => [score(p), p]).sort((x, y) => y[0] - x[0]);
  if (best[0][0] === 0 && hits.length > 1) return null;   // several programs and none names the country: do not guess
  return best[0][1];
}

// ---------- networks ----------
const form = (o) => new URLSearchParams(o).toString();
async function jfetch(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) throw new Error(`HTTP ${r.status}` + (j && (j.message || j.error) ? ' ' + String(j.message || j.error).slice(0, 80) : ''));
  return j;
}
const firstHttps = (o) => { if (!o || typeof o !== 'object') return null; for (const k of ['tracking_link', 'deeplink', 'link', 'url', 'aff_link']) if (httpsOk(o[k])) return o[k]; return null; };

const NET = {
  involve: {
    async session(env) {
      const base = (env.INVOLVE_API_URL || 'https://api.involve.asia/api').replace(/\/+$/, '');
      const j = await jfetch(base + '/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ key: env.INVOLVE_API_KEY, secret: env.INVOLVE_API_SECRET }) });
      const token = j && ((j.data && j.data.token) || j.token);
      if (!token) throw new Error('auth: no token');
      return { base, h: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' } };
    },
    async program(env, s, m) {
      const j = await jfetch(s.base + '/offers/all', { method: 'POST', headers: s.h, body: form({ page: '1', limit: '100', 'filters[offer_name]': m.advertiser, 'filters[application_status]': 'Approved' }) });
      const list = ((j && j.data && (j.data.data || j.data)) || []).filter((o) => o && typeof o === 'object')
        .map((o) => ({ id: String(o.offer_id ?? o.id ?? ''), name: String(o.offer_name ?? o.name ?? ''), regions: [].concat(o.countries || o.offer_country || []).map(String) }));
      const p = pickProgram(list.filter((x) => x.id), m.advertiser, m.country);
      return p && p.id;
    },
    async links(env, s, m, urls) {
      const out = [];
      for (const u of urls) {
        const j = await jfetch(s.base + '/deeplink/generate', { method: 'POST', headers: s.h, body: form({ offer_id: m.program_id, url: u, aff_sub: 'seascout' }) });
        out.push(firstHttps(j && j.data) || firstHttps(j));
      }
      return out;
    },
  },
  admitad: {
    async session(env) {
      const base = (env.ADMITAD_API_URL || 'https://api.admitad.com').replace(/\/+$/, '');
      const j = await jfetch(base + '/token/', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(env.ADMITAD_CLIENT_ID + ':' + env.ADMITAD_CLIENT_SECRET) },
        body: form({ grant_type: 'client_credentials', client_id: env.ADMITAD_CLIENT_ID, scope: 'advcampaigns_for_website deeplink_generator' }) });
      if (!j || !j.access_token) throw new Error('auth: no token');
      return { base, w: String(env.ADMITAD_WEBSITE_ID).replace(/\D/g, ''), h: { Authorization: 'Bearer ' + j.access_token } };
    },
    async program(env, s, m) {
      const j = await jfetch(`${s.base}/advcampaigns/website/${s.w}/?connection_status=active&limit=500`, { headers: s.h });
      const list = ((j && j.results) || []).map((o) => ({ id: String(o.id || ''), name: String(o.name || ''), regions: (o.regions || []).map((r) => (r && (r.region || r)) || '') }));
      const p = pickProgram(list.filter((x) => x.id), m.advertiser, m.country);
      return p && p.id;
    },
    async links(env, s, m, urls) {
      const qs = new URLSearchParams({ subid: 'seascout' }); for (const u of urls) qs.append('ulp', u);
      const j = await jfetch(`${s.base}/deeplink/${s.w}/advcampaign/${encodeURIComponent(m.program_id)}/?${qs}`, { headers: s.h });
      return urls.map((_, i) => firstHttps(Array.isArray(j) ? j[i] : null));
    },
  },
  amazon: {
    async session(env) { return { tags: amazonTags(env) }; },
    async program(env, s, m) { const t = s.tags[m.country]; return t && /^[\w-]{3,40}$/.test(t) ? t : null; },
    async links(env, s, m, urls) { return urls.map((u) => { const x = new URL(u); x.searchParams.set('tag', m.program_id); return x.href; }); },
  },
};

// ---------- one cron run: one marketplace ----------
export async function marketTick(env, { force = false, marketId = null } = {}) {
  const db = env.DB, now = Date.now();
  if (!force) {
    const f = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'market_links'`).first();
    if (!f || !f.enabled) return { skipped: 'flag_off' };
  }
  const ready = Object.keys(NET).filter((n) => configured[n](env));
  if (!ready.length && !marketId) return { skipped: 'no_network_keys' };
  const m = marketId
    ? await db.prepare('SELECT * FROM marketplaces WHERE id = ?').bind(marketId).first()
    : await db.prepare(`SELECT * FROM marketplaces WHERE active = 1 AND network IN (${ready.map(() => '?').join(',')}) ORDER BY checked_at LIMIT 1`).bind(...ready).first();
  if (!m) return { skipped: 'no_market' };
  const setStatus = (st, extra = {}) => db.prepare('UPDATE marketplaces SET status = ?, checked_at = ?, program_id = COALESCE(?, program_id), links = COALESCE(?, links) WHERE id = ?')
    .bind(String(st).slice(0, 120), now, extra.program ?? null, extra.links ?? null, m.id).run();
  if (!configured[m.network](env)) { await setStatus('waiting_keys'); return { market: m.id, skipped: 'waiting_keys' }; }

  // keywords in the shop's language (English when that language has none)
  const { results: kws0 } = await db.prepare('SELECT id, lang, keyword, tags FROM market_keywords WHERE lang IN (?, \'en\') ORDER BY id').bind(m.lang).all();
  const kws = Object.values(kws0.reduce((a, k) => { if (!a[k.id] || k.lang === m.lang) a[k.id] = k; return a; }, {}));
  const { results: have } = await db.prepare(`SELECT ext_id, refreshed_at FROM products WHERE source = 'market' AND query_id = ?`).bind(m.id).all();
  const fresh = new Set(have.filter((h) => now - (h.refreshed_at || 0) < KEEP_DAYS * DAY).map((h) => h.ext_id));
  const todo = kws.filter((k) => !fresh.has(m.id + ':' + k.id)).slice(0, MAX_LINKS_PER_RUN);
  if (!todo.length) { await setStatus('ok', { links: have.length }); return { market: m.id, made: 0, links: have.length }; }

  let s, made = 0;
  try {
    s = await NET[m.network].session(env);
    let pid = m.program_id;
    if (!pid) {
      pid = await NET[m.network].program(env, s, m);
      if (!pid) { await setStatus(m.network === 'amazon' ? 'no_tag_for_country' : 'program_not_found'); return { market: m.id, error: 'program_not_found' }; }
      m.program_id = pid;
    }
    const urls = todo.map((k) => searchUrl(m.search_url, k.keyword));
    const links = await NET[m.network].links(env, s, m, urls.filter(Boolean));
    const ops = [];
    let li = 0;
    for (const [i, k] of todo.entries()) {
      if (!urls[i]) continue;
      const link = links[li++];
      if (!httpsOk(link)) continue;
      const ext = m.id + ':' + k.id;
      const ex = await db.prepare(`SELECT id, off_reason FROM products WHERE source = 'market' AND ext_id = ?`).bind(ext).first();
      const pid2 = ex ? ex.id : newId('prd'), active = ex && ex.off_reason === 'admin' ? 0 : 1;
      const tags = JSON.stringify([...new Set(['all', ...JSON.parse(k.tags || '[]')])]);
      ops.push(db.prepare(`INSERT INTO products (id, title, description, tags, active, sort, created_at, updated_at, source, ext_id, query_id, off_reason, refreshed_at)
        VALUES (?,?,?,?,?,?,?,?,'market',?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, tags=excluded.tags, active=excluded.active, sort=excluded.sort,
          updated_at=excluded.updated_at, query_id=excluded.query_id, off_reason=excluded.off_reason, refreshed_at=excluded.refreshed_at`)
        .bind(pid2, m.name, k.keyword, tags, active, 1000 + m.rank, now, now, ext, m.id, active ? null : 'admin', now));
      ops.push(db.prepare('DELETE FROM offers WHERE product_id = ?').bind(pid2));
      ops.push(db.prepare('INSERT INTO offers (id, product_id, merchant_id, country, url, active, sort, updated_at) VALUES (?,?,?,?,?,1,?,?)')
        .bind(newId('off'), pid2, m.merchant_id, m.country, link, m.rank, now));
      made++;
    }
    if (ops.length) await db.batch(ops);
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM products WHERE source = 'market' AND query_id = ?`).bind(m.id).first()).n;
    await setStatus(made ? 'ok' : 'no_links_returned', { program: m.program_id, links: n });
    return { market: m.id, network: m.network, made, links: n };
  } catch (e) {
    await setStatus('error: ' + String((e && e.message) || e));
    return { market: m.id, error: String((e && e.message) || e).slice(0, 120) };
  }
}

// admin: changing where a shop points makes its links be made again on the next run
export async function resetMarketLinks(db, marketId) {
  await db.batch([
    db.prepare(`UPDATE products SET refreshed_at = 0 WHERE source = 'market' AND query_id = ?`).bind(marketId),
    db.prepare(`UPDATE marketplaces SET checked_at = 0 WHERE id = ?`).bind(marketId),
  ]);
}
