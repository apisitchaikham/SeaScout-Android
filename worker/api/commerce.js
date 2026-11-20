// Sea Scout API v1 — global commerce (public part): products for a species/gear with their images and the best
// offer for the user's country, and a click-tracking redirect that only ever goes to a stored offer URL.
import { ApiError, json, newId, country, str } from './util.js';

const TAG_RE = /^[a-z0-9_]{1,24}$/i;
function tagsFrom(url) {
  const t = new Set(['all']);
  for (const k of ['species', 'gear', 'cat', 'group']) { const v = url.searchParams.get(k); if (v && TAG_RE.test(v)) t.add(v); }
  return [...t];
}
const pick = (i18n, lang, base) => { try { const o = JSON.parse(i18n || 'null'); return (o && lang && o[lang]) || base; } catch (_) { return base; } };

// GET /commerce/items?species=xsl&gear=light&cat=coast&group=fish&lang=th&country=TH&limit=12
export async function items(req, env) {
  const url = new URL(req.url), db = env.DB;
  const tags = tagsFrom(url), lang = str(url.searchParams.get('lang'), 5);
  const cc = (/^[A-Z]{2}$/.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : country(req)) || '*';
  const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
  const ph = tags.map(() => '?').join(',');
  const { results: prods } = await db.prepare(
    `SELECT p.id, p.title, p.title_i18n, p.description, p.desc_i18n, p.brand, p.tags, p.sort
     FROM products p WHERE p.active = 1 AND EXISTS (SELECT 1 FROM json_each(p.tags) j WHERE j.value IN (${ph}))
     ORDER BY p.sort, p.updated_at DESC LIMIT 200`).bind(...tags).all();
  if (!prods.length) return json(req, 200, { items: [], country: cc }, { 'Cache-Control': 'public, max-age=300' });
  const ids = prods.map((p) => p.id), ph2 = ids.map(() => '?').join(',');
  const { results: imgs } = await db.prepare(`SELECT product_id, url, alt FROM product_images WHERE product_id IN (${ph2}) ORDER BY sort`).bind(...ids).all();
  const { results: offs } = await db.prepare(
    `SELECT o.id, o.product_id, o.country, o.currency, o.price, m.name AS merchant, m.kind FROM offers o JOIN merchants m ON m.id = o.merchant_id
     WHERE o.active = 1 AND m.active = 1 AND o.product_id IN (${ph2}) AND (o.country = ? OR o.country = '*') ORDER BY (o.country = '*'), o.sort`).bind(...ids, cc).all();
  const rank = (p) => { const t = JSON.parse(p.tags || '[]'); return tags.includes(url.searchParams.get('species')) && t.includes(url.searchParams.get('species')) ? 0 : t.includes(url.searchParams.get('gear')) ? 1 : t.includes(url.searchParams.get('cat')) ? 2 : t.includes(url.searchParams.get('group')) ? 3 : 4; };
  const base = new URL('/api/v1/go/', req.url).href;
  const out = prods.map((p) => {
    const offers = offs.filter((o) => o.product_id === p.id).map((o) => ({ id: o.id, merchant: o.merchant, kind: o.kind, country: o.country, currency: o.currency, price: o.price, go: base + o.id }));
    return { id: p.id, title: pick(p.title_i18n, lang, p.title), desc: pick(p.desc_i18n, lang, p.description), brand: p.brand, tags: JSON.parse(p.tags || '[]'),
      images: imgs.filter((i) => i.product_id === p.id).map((i) => ({ url: i.url, alt: i.alt })), offers, rank: rank(p), sort: p.sort };
  }).filter((p) => p.offers.length).sort((a, b) => a.rank - b.rank || a.sort - b.sort).slice(0, limit);
  return json(req, 200, { items: out, country: cc }, { 'Cache-Control': 'public, max-age=300' });
}

// r14.15.67: GET /commerce/catalog?lang=th&country=TH — every active product with its images and offers for that country,
// so the app downloads the catalogue about twice a day and matches species/gear itself (was 1 request per species
// per analysis). Kept in Worker memory for 5 minutes per country+language.
const CAT_CACHE = new Map();
export async function catalog(req, env) {
  const url = new URL(req.url), db = env.DB, lang = str(url.searchParams.get('lang'), 5);
  const cc = (/^[A-Z]{2}$/.test(url.searchParams.get('country') || '') ? url.searchParams.get('country') : country(req)) || '*';
  const key = cc + '|' + (lang || ''), hit = CAT_CACHE.get(key);
  if (hit && Date.now() - hit.at < 300e3) return json(req, 200, hit.body, { 'Cache-Control': 'public, max-age=300' });
  const { results: prods } = await db.prepare(
    `SELECT id, title, title_i18n, description, desc_i18n, brand, tags, sort FROM products WHERE active = 1 ORDER BY sort, updated_at DESC LIMIT 500`).all();
  let items = [];
  if (prods.length) {
    const { results: imgs } = await db.prepare(`SELECT i.product_id, i.url, i.alt FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.active = 1 ORDER BY i.sort`).all();
    const { results: offs } = await db.prepare(
      `SELECT o.id, o.product_id, o.country, o.currency, o.price, m.name AS merchant, m.kind FROM offers o JOIN merchants m ON m.id = o.merchant_id
       WHERE o.active = 1 AND m.active = 1 AND (o.country = ? OR o.country = '*') ORDER BY (o.country = '*'), o.sort`).bind(cc).all();
    const base = new URL('/api/v1/go/', req.url).href;
    items = prods.map((p) => ({ id: p.id, title: pick(p.title_i18n, lang, p.title), desc: pick(p.desc_i18n, lang, p.description), brand: p.brand,
      tags: JSON.parse(p.tags || '[]'), sort: p.sort,
      images: imgs.filter((i) => i.product_id === p.id).map((i) => ({ url: i.url, alt: i.alt })),
      offers: offs.filter((o) => o.product_id === p.id).map((o) => ({ id: o.id, merchant: o.merchant, kind: o.kind, country: o.country, currency: o.currency, price: o.price, go: base + o.id })) }))
      .filter((p) => p.offers.length);
  }
  const body = { items, country: cc, at: Date.now() };
  CAT_CACHE.set(key, { at: Date.now(), body });
  return json(req, 200, body, { 'Cache-Control': 'public, max-age=300' });
}

// GET /go/{offer_id}?src=xsl&p=android → 302 to that offer's own URL (never to a URL from the request)
export async function go(req, env, offerId) {
  const db = env.DB, url = new URL(req.url);
  const o = await db.prepare(`SELECT o.id, o.product_id, o.merchant_id, o.url FROM offers o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = ? AND o.active = 1 AND m.active = 1`).bind(offerId).first();
  if (!o || !/^https:\/\//i.test(o.url)) throw new ApiError(404, 'not_found');
  const plat = ['android', 'ios', 'web'].includes(url.searchParams.get('p')) ? url.searchParams.get('p') : null;
  const src = (url.searchParams.get('src') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || null;
  try {
    await db.prepare('INSERT INTO affiliate_clicks (id, offer_id, product_id, merchant_id, at, country, platform, source) VALUES (?,?,?,?,?,?,?,?)')
      .bind(newId('clk'), o.id, o.product_id, o.merchant_id, Date.now(), country(req), plat, src).run();
  } catch (_) {}
  return new Response(null, { status: 302, headers: { Location: o.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
