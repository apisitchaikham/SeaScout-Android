// Sea Scout API v1 — the shop fills itself (r14.15.68).
// A Cron Trigger runs autoShopTick() every 30 minutes. Each tick handles ONE search (shop_queries row with the oldest
// last_run) so it stays inside the free plan: 1 network call + a few D1 batches, a few ms of CPU.
// For that search it asks the affiliate network for matching items, keeps only items with real ratings and sales,
// ranks them — highest rating first, then most sold — and stores the top ones with the network's OWN affiliate link.
// Nothing is guessed: an item without a rating, a sales count or an https affiliate link from the network is skipped.
//
// Settings (Cloudflare → Worker → Variables; *_SECRET as Secrets):
//   Shopee Affiliate Open API:  SHOPEE_AFF_APP_ID, SHOPEE_AFF_SECRET, SHOPEE_AFF_ENDPOINT (country endpoint, e.g. Thailand),
//                               SHOPEE_AFF_COUNTRY (ISO, e.g. TH), SHOPEE_AFF_CURRENCY (e.g. THB)
//   AliExpress Affiliate API:   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID, [ALIEXPRESS_API_URL]
// Field names follow the networks' published API docs; the "auto_shop" flag stays off until a live response from each
// network has been checked against this mapping (see docs/AUTO_SHOP_TH.md).
import { newId } from './util.js';

export const RULES = { keep: 8, minStars: 4.5, minPositivePct: 90, minSales: 30 };
const MER = { shopee: 'mer_auto_shopee_____', aliexpress: 'mer_auto_aliexpress_' };
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[%,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const https = (u) => typeof u === 'string' && /^https:\/\//i.test(u) && u.length < 2048 ? u : null;

export const configured = {
  shopee: (env) => !!(env.SHOPEE_AFF_APP_ID && env.SHOPEE_AFF_SECRET && env.SHOPEE_AFF_ENDPOINT),
  aliexpress: (env) => !!(env.ALIEXPRESS_APP_KEY && env.ALIEXPRESS_APP_SECRET && env.ALIEXPRESS_TRACKING_ID),
};

// ---------- network adapters: keyword → [{ext_id,title,image,price,currency,rating,scale,sales,link,country}] ----------
async function shopee(env, keyword) {
  const q = `{productOfferV2(keyword:${JSON.stringify(keyword)},page:1,limit:50){nodes{itemId productName imageUrl priceMin ratingStar sales offerLink}}}`;
  const payload = JSON.stringify({ query: q });
  const ts = Math.floor(Date.now() / 1000);
  const sig = hex(await crypto.subtle.digest('SHA-256', enc.encode(env.SHOPEE_AFF_APP_ID + ts + payload + env.SHOPEE_AFF_SECRET)));
  const r = await fetch(env.SHOPEE_AFF_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `SHA256 Credential=${env.SHOPEE_AFF_APP_ID}, Timestamp=${ts}, Signature=${sig}` }, body: payload });
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j || j.errors || !j.data || !j.data.productOfferV2) throw new Error('shopee_' + (r.status || 'bad') + (j && j.errors ? ':' + String(j.errors[0] && j.errors[0].message).slice(0, 80) : ''));
  const cc = /^[A-Z]{2}$/.test(env.SHOPEE_AFF_COUNTRY || '') ? env.SHOPEE_AFF_COUNTRY : '*';
  return (j.data.productOfferV2.nodes || []).map((n) => ({ ext_id: String(n.itemId || ''), title: String(n.productName || '').slice(0, 200), image: https(n.imageUrl),
    price: num(n.priceMin), currency: env.SHOPEE_AFF_CURRENCY || null, rating: num(n.ratingStar), scale: 5, sales: num(n.sales), link: https(n.offerLink), country: cc }));
}

async function aliexpress(env, keyword) {
  const p = { app_key: env.ALIEXPRESS_APP_KEY, method: 'aliexpress.affiliate.product.query', timestamp: String(Date.now()), sign_method: 'sha256',
    keywords: keyword, page_no: '1', page_size: '50', sort: 'LAST_VOLUME_DESC', target_currency: 'USD', target_language: 'EN', tracking_id: env.ALIEXPRESS_TRACKING_ID,
    fields: 'product_id,product_title,product_main_image_url,target_sale_price,target_sale_price_currency,evaluate_rate,lastest_volume,promotion_link' };
  const base = Object.keys(p).sort().map((k) => k + p[k]).join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(env.ALIEXPRESS_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  p.sign = hex(await crypto.subtle.sign('HMAC', key, enc.encode(base))).toUpperCase();
  const r = await fetch(env.ALIEXPRESS_API_URL || 'https://api-sg.aliexpress.com/sync', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(p) });
  const j = r.ok ? await r.json().catch(() => null) : null;
  const rr = j && j.aliexpress_affiliate_product_query_response && j.aliexpress_affiliate_product_query_response.resp_result;
  if (!rr || Number(rr.resp_code) !== 200) throw new Error('aliexpress_' + (rr ? rr.resp_code + ':' + String(rr.resp_msg || '').slice(0, 80) : (r.status || 'bad')));
  const list = (rr.result && rr.result.products && (rr.result.products.product || rr.result.products)) || [];
  return (Array.isArray(list) ? list : []).map((n) => ({ ext_id: String(n.product_id || ''), title: String(n.product_title || '').slice(0, 200), image: https(n.product_main_image_url),
    price: num(n.target_sale_price), currency: n.target_sale_price_currency || 'USD', rating: num(n.evaluate_rate), scale: 100, sales: num(n.lastest_volume), link: https(n.promotion_link), country: '*' }));
}
export const ADAPTERS = { shopee, aliexpress };

// ---------- ranking: highest rating first (stars or % shown as /5, one decimal), then most sold ----------
export const stars5 = (it) => it.rating == null || !it.scale ? null : Math.round((it.rating / it.scale) * 5 * 10) / 10;
export function pickTop(items, keep = RULES.keep) {
  const seen = new Set();
  return items.filter((it) => {
    if (!it.ext_id || seen.has(it.ext_id)) return false; seen.add(it.ext_id);
    if (!it.link || !it.title || it.rating == null || it.sales == null) return false;
    if (it.scale === 5 ? it.rating < RULES.minStars : it.rating < RULES.minPositivePct) return false;
    return it.sales >= RULES.minSales;
  }).sort((a, b) => (stars5(b) - stars5(a)) || (b.sales - a.sales)).slice(0, keep);
}

// ---------- one tick ----------
export async function autoShopTick(env, { force = false, queryId = null } = {}) {
  const db = env.DB;
  if (!force) {
    const f = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'auto_shop'`).first();
    if (!f || !f.enabled) return { skipped: 'flag_off' };
  }
  const ready = Object.keys(ADAPTERS).filter((s) => configured[s](env));
  if (!ready.length) return { skipped: 'no_network_keys' };
  const q = queryId
    ? await db.prepare('SELECT * FROM shop_queries WHERE id = ?').bind(queryId).first()
    : await db.prepare(`SELECT * FROM shop_queries WHERE active = 1 AND source IN (${ready.map(() => '?').join(',')}) ORDER BY last_run LIMIT 1`).bind(...ready).first();
  if (!q) return { skipped: 'no_query' };
  if (!ready.includes(q.source)) return { skipped: 'network_not_configured', query: q.id };
  const now = Date.now();
  let items;
  try { items = await ADAPTERS[q.source](env, q.keyword); }
  catch (e) {
    await db.prepare('UPDATE shop_queries SET last_run = ?, last_status = ? WHERE id = ?').bind(now, String(e.message || e).slice(0, 120), q.id).run();
    return { query: q.id, error: String(e.message || e) };
  }
  const top = pickTop(items);
  const tags = JSON.stringify([...new Set(['all', ...JSON.parse(q.tags || '[]')])]);
  const ops = [];
  for (const [k, it] of top.entries()) {
    const ex = await db.prepare('SELECT id, off_reason FROM products WHERE source = ? AND ext_id = ?').bind(q.source, it.ext_id).first();
    const pid = ex ? ex.id : newId('prd');
    const active = ex && ex.off_reason === 'admin' ? 0 : 1;      // an item an admin blocked stays blocked
    ops.push(db.prepare(`INSERT INTO products (id, title, tags, active, sort, created_at, updated_at, source, ext_id, query_id, rating, rating_scale, sales, off_reason, refreshed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, tags=excluded.tags, active=excluded.active, sort=excluded.sort, updated_at=excluded.updated_at, query_id=excluded.query_id,
        rating=excluded.rating, rating_scale=excluded.rating_scale, sales=excluded.sales, off_reason=excluded.off_reason, refreshed_at=excluded.refreshed_at`)
      .bind(pid, it.title, tags, active, k, now, now, q.source, it.ext_id, q.id, it.rating, it.scale, Math.round(it.sales), active ? null : 'admin', now));
    ops.push(db.prepare('DELETE FROM product_images WHERE product_id = ?').bind(pid));
    if (it.image) ops.push(db.prepare('INSERT INTO product_images (id, product_id, url, alt, sort) VALUES (?,?,?,?,0)').bind(newId('img'), pid, it.image, it.title.slice(0, 120)));
    ops.push(db.prepare('DELETE FROM offers WHERE product_id = ? AND merchant_id = ?').bind(pid, MER[q.source]));
    ops.push(db.prepare('INSERT INTO offers (id, product_id, merchant_id, country, currency, price, url, active, sort, updated_at) VALUES (?,?,?,?,?,?,?,1,0,?)')
      .bind(newId('off'), pid, MER[q.source], it.country, it.currency, it.price, it.link, now));
  }
  // items this search found before but that are no longer in its top list → hidden (not deleted; clicks history stays)
  const keepIds = top.map((t) => t.ext_id);
  ops.push(db.prepare(`UPDATE products SET active = 0, off_reason = 'dropped', updated_at = ? WHERE query_id = ? AND source = ? AND (off_reason IS NULL OR off_reason = 'dropped')
    ${keepIds.length ? `AND ext_id NOT IN (${keepIds.map(() => '?').join(',')})` : ''}`).bind(now, q.id, q.source, ...keepIds));
  ops.push(db.prepare('UPDATE shop_queries SET last_run = ?, last_status = ?, last_count = ? WHERE id = ?').bind(now, 'ok', top.length, q.id));
  await db.batch(ops);
  return { query: q.id, source: q.source, found: items.length, kept: top.length };
}
