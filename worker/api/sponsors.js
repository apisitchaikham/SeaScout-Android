// Sea Scout · self-serve sponsor banners (r14.15.75).
// Flow:  shop fills /advertise.html → POST /sponsor/submit (banner + link) → automatic check (sponsor_check.js)
//        → passed: "awaiting_payment" → POST /sponsor/pay → Stripe Checkout (THB) → webhook → "active" for 30 days
//        → the app's bottom strip rotates all active banners (10 s each) → expires unless paid again.
// The shop follows everything on its private status page (token in the link; only its sha256 is stored).
// Settings: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (Secrets) [STRIPE_API_URL]; optional SAFE_BROWSING_KEY;
//           Workers AI binding "AI" [SPONSOR_AI_MODEL]; e-mails through the existing Resend settings.
// Free-plan budget: the app asks for the list once per 30 min per phone (cached), images once ever (immutable),
// impressions are batched (one request per session); clicks go through /sponsor/go.
import { ApiError, json, readJson, cleanEmail, str, randomToken, sha256, clientIp, country } from './util.js';
import { rateLimit, audit } from './store.js';
import { checkSponsor } from './sponsor_check.js';

const DAY = 86400e3, MAX_IMG = 300 * 1024, SITE = 'https://seascout.apisit-chaikham.workers.dev';
const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function settings(db) {
  const { results } = await db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'sponsor_%'`).all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { price: Math.max(1, parseInt(s.sponsor_price_thb || '5000', 10)), days: Math.max(1, parseInt(s.sponsor_days || '30', 10)),
    max: Math.max(0, parseInt(s.sponsor_max || '0', 10)), rotate: Math.max(3, parseInt(s.sponsor_rotate_s || '10', 10)) };
}
// r14.15.77: Google AdMob top banner in the phone app — on/off + ad unit IDs live here so they change without a new app build.
// Empty ID → the app shows Google's own test banner (no money, safe to show while the real IDs are not set).
export async function gadSettings(db) {
  const { results } = await db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'gad_%'`).all();
  const g = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { on: g.gad_on !== '0', android: g.gad_android || null, ios: g.gad_ios || null };
}
// r14.15.88: Admitad affiliate base links (one per joined program, e.g. https://rzekl.com/g/abc123/). Not secret —
// they are the public tracking links Admitad gives after a program approves the ad space. Empty = that shop's buttons stay hidden.
export const AFF_KEYS = ['shopee_th', 'shopee_my', 'shopee_sg', 'shopee_ph', 'shopee_vn', 'shopee_id', 'shopee_tw', 'shopee_br', 'shopee_mx',
  'lazada_my', 'lazada_id', 'walmart_us', 'decathlon_pl', 'allegro_pl', 'tiki_vn', 'aliexpress', 'banggood', 'dhgate', 'vevor'];
export async function affSettings(db) {
  const { results } = await db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'aff_%'`).all();
  const g = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return Object.fromEntries(AFF_KEYS.map((k) => [k, g['aff_' + k] || null]));
}
async function flagOn(db) { const f = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'sponsor_ads'`).first(); return !f || !!f.enabled; }
const siteBase = (env) => (env.SITE_URL || SITE).replace(/\/+$/, '');

function publicStatus(ad, s) {
  return { id: ad.id, status: ad.status, business: ad.business, link: ad.link, headline: ad.headline, reason: ad.reason,
    paid_until: ad.paid_until || null, impressions: ad.impressions, clicks: ad.clicks, created_at: ad.created_at,
    price_thb: s.price, days: s.days, can_pay: ['awaiting_payment', 'active', 'expired'].includes(ad.status),
    image: `data:${ad.image_type};base64,${ad.image_b64}` };
}

async function mail(env, to, subject, lines) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  try {
    const r = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text: lines.join('\n'),
        html: `<div style="font-family:system-ui,sans-serif;max-width:520px"><h2 style="color:#0b84a5">Sea Scout · โฆษณาสปอนเซอร์</h2>${lines.map((l) => `<p>${l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join('')}</div>` }) });
    return r.ok;
  } catch (_) { return false; }
}
const manageUrl = (env, token) => `${siteBase(env)}/advertise.html#t=${token}`;

async function applyCheck(env, ad, res) {
  const now = Date.now(), db = env.DB;
  const status = res.verdict === 'pass' ? 'awaiting_payment' : res.verdict === 'fail' ? 'rejected' : 'checking';
  await db.prepare('UPDATE sponsor_ads SET status = ?, reason = ?, check_json = ?, check_tries = check_tries + 1, checked_at = ?, updated_at = ? WHERE id = ?')
    .bind(status, res.verdict === 'fail' ? res.reason : null, JSON.stringify(res.detail || {}), now, now, ad.id).run();
  return status;
}

// ---------- POST /sponsor/submit ----------
export async function submit(req, env) {
  const db = env.DB;
  if (!(await flagOn(db))) throw new ApiError(503, 'sponsor_closed');
  const ipKey = await sha256(clientIp(req));
  if (!(await rateLimit(db, 'spn:ip:' + ipKey, 6, 3600e3))) throw new ApiError(429, 'too_many_requests');
  const b = await readJson(req, 520 * 1024);
  if (b.accept_terms !== true) throw new ApiError(400, 'terms_required');
  const email = cleanEmail(b.email);
  if (!(await rateLimit(db, 'spn:em:' + (await sha256(email)), 10, DAY))) throw new ApiError(429, 'too_many_requests');
  const business = str(b.business, 80), link = str(b.link, 500), headline = str(b.headline, 120);
  if (!business) throw new ApiError(400, 'business_required');
  if (!link) throw new ApiError(400, 'link_required');
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
  if (!m) throw new ApiError(400, 'image_required');
  const bytes = b64ToBytes(m[2]);
  if (bytes.length > MAX_IMG) throw new ApiError(413, 'image_too_large');
  if (!MAGIC[m[1]].every((v, i) => bytes[i] === v)) throw new ApiError(400, 'image_invalid');
  const id = 'spn_' + randomToken(12), token = randomToken(24), now = Date.now();
  const ad = { id, business, email, link, headline, image_type: m[1], image_b64: m[2] };
  await db.prepare(`INSERT INTO sponsor_ads (id, status, business, email, link, headline, image_type, image_b64, image_hash, manage_hash, created_at, updated_at, country, ip_hash)
    VALUES (?, 'checking', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, business, email, link, headline, m[1], m[2], hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16), await sha256(token), now, now, country(req), ipKey).run();
  const res = await checkSponsor(env, ad, { tries: 0 });
  const status = await applyCheck(env, ad, res);
  await audit(db, 'system', null, 'sponsor_submit', id, { status, reason: res.reason || null }, country(req));
  const s = await settings(db);
  await mail(env, email, status === 'awaiting_payment' ? 'Sea Scout: โฆษณาผ่านการตรวจแล้ว รอชำระเงิน' : status === 'rejected' ? 'Sea Scout: โฆษณาไม่ผ่านการตรวจ' : 'Sea Scout: ได้รับโฆษณาแล้ว กำลังตรวจ',
    [status === 'awaiting_payment' ? `โฆษณาของ ${business} ผ่านการตรวจแล้ว ชำระ ${s.price.toLocaleString('en-US')} บาท เพื่อเริ่มแสดง ${s.days} วัน` :
      status === 'rejected' ? `โฆษณาของ ${business} ไม่ผ่านการตรวจ: ${res.reason}` : `ได้รับโฆษณาของ ${business} แล้ว ระบบกำลังตรวจ`,
    'หน้าสถานะโฆษณาของคุณ (เก็บลิงก์นี้ไว้): ' + manageUrl(env, token)]);
  return json(req, 201, { token, manage_url: manageUrl(env, token), ...publicStatus({ ...ad, status, reason: res.verdict === 'fail' ? res.reason : null, paid_until: 0, impressions: 0, clicks: 0, created_at: now }, s) });
}

async function byToken(db, t) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(t || ''))) throw new ApiError(404, 'not_found');
  const ad = await db.prepare('SELECT * FROM sponsor_ads WHERE manage_hash = ?').bind(await sha256(t)).first();
  if (!ad) throw new ApiError(404, 'not_found');
  return ad;
}

// ---------- POST /sponsor/status {t} ----------
export async function status(req, env) {
  const b = await readJson(req), ad = await byToken(env.DB, b.t), s = await settings(env.DB);
  const { results: pays } = await env.DB.prepare(`SELECT amount, currency, paid_at FROM sponsor_payments WHERE ad_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 24`).bind(ad.id).all();
  return json(req, 200, { ...publicStatus(ad, s), payments: pays });
}

// ---------- POST /sponsor/pay {t} → Stripe Checkout ----------
export async function pay(req, env) {
  const db = env.DB, b = await readJson(req), ad = await byToken(db, b.t), s = await settings(db);
  if (!['awaiting_payment', 'active', 'expired'].includes(ad.status)) throw new ApiError(409, 'not_payable', ad.status);
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, 'payments_not_configured');
  if (s.max && ad.status !== 'active') {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM sponsor_ads WHERE status = 'active' AND paid_until > ?`).bind(Date.now()).first()).n;
    if (n >= s.max) throw new ApiError(409, 'full', 'All sponsor places are taken');
  }
  const back = manageUrl(env, b.t);
  const f = new URLSearchParams({
    mode: 'payment', client_reference_id: ad.id, customer_email: ad.email, locale: 'th',
    success_url: back + '&paid=1', cancel_url: back,
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'thb', 'line_items[0][price_data][unit_amount]': String(s.price * 100),
    'line_items[0][price_data][product_data][name]': `Sea Scout sponsor banner · ${s.days} days`,
    'line_items[0][price_data][product_data][description]': ad.business.slice(0, 200),
    'metadata[ad_id]': ad.id, 'metadata[days]': String(s.days), 'payment_intent_data[metadata][ad_id]': ad.id,
  });
  const r = await fetch((env.STRIPE_API_URL || 'https://api.stripe.com') + '/v1/checkout/sessions', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': ad.id + ':' + Math.floor(Date.now() / 600e3) }, body: f.toString() });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id || !/^https:\/\//.test(j.url || '')) {
    console.log(JSON.stringify({ seascout: 'stripe_error', status: r.status, err: j && j.error && j.error.message }));
    throw new ApiError(502, 'payment_start_failed');
  }
  await db.prepare(`INSERT OR IGNORE INTO sponsor_payments (session_id, ad_id, amount, currency, status, created_at) VALUES (?,?,?,?,'created',?)`).bind(j.id, ad.id, s.price * 100, 'thb', Date.now()).run();
  return json(req, 200, { url: j.url });
}

// ---------- POST /sponsor/stripe (webhook) ----------
async function stripeVerify(secret, header, raw) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + raw)));
  return sigs.some((s) => s.length === mac.length && [...s].reduce((a, c, i) => a | (c.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0);
}
export async function stripeWebhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'payments_not_configured');
  const raw = await req.text();
  if (raw.length > 200000 || !(await stripeVerify(env.STRIPE_WEBHOOK_SECRET, req.headers.get('Stripe-Signature'), raw))) throw new ApiError(400, 'bad_signature');
  const ev = JSON.parse(raw), o = ev && ev.data && ev.data.object;
  const types = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!o || !types.includes(ev.type) || o.payment_status !== 'paid') return json(req, 200, { ok: true, ignored: ev && ev.type });
  const db = env.DB, adId = (o.metadata && o.metadata.ad_id) || o.client_reference_id, now = Date.now();
  const ad = adId && await db.prepare('SELECT * FROM sponsor_ads WHERE id = ?').bind(adId).first();
  if (!ad) return json(req, 200, { ok: true, ignored: 'unknown_ad' });
  if (String(o.currency).toLowerCase() !== 'thb') return json(req, 200, { ok: true, ignored: 'currency' });
  // one activation per Checkout Session, however many times Stripe retries
  const ins = await db.prepare(`INSERT INTO sponsor_payments (session_id, ad_id, amount, currency, status, created_at, paid_at) VALUES (?,?,?,?,'paid',?,?)
    ON CONFLICT(session_id) DO UPDATE SET status = 'paid', paid_at = excluded.paid_at, amount = excluded.amount WHERE sponsor_payments.status <> 'paid'`)
    .bind(o.id, ad.id, o.amount_total | 0, 'thb', now, now).run();
  if (!ins.meta || !ins.meta.changes) return json(req, 200, { ok: true, duplicate: true });
  const days = Math.max(1, parseInt((o.metadata && o.metadata.days) || (await settings(db)).days, 10));
  const until = Math.max(now, ad.paid_until || 0) + days * DAY;
  const active = ['awaiting_payment', 'active', 'expired'].includes(ad.status);
  await db.prepare(`UPDATE sponsor_ads SET status = ?, paid_until = ?, paid_total = paid_total + ?, reminded_at = 0, updated_at = ? WHERE id = ?`)
    .bind(active ? 'active' : ad.status, until, o.amount_total | 0, now, ad.id).run();
  dropAdsCache();
  await audit(db, 'store', null, 'sponsor_paid', ad.id, { amount: o.amount_total, until }, null);
  await mail(env, ad.email, 'Sea Scout: ชำระเงินแล้ว โฆษณาเริ่มแสดง', [`ได้รับชำระ ${(o.amount_total / 100).toLocaleString('en-US')} บาทแล้ว โฆษณาของ ${ad.business} แสดงในแอปถึง ${new Date(until).toISOString().slice(0, 10)}`]);
  return json(req, 200, { ok: true, active, until });
}

// ---------- GET /sponsor/ads (the app) ----------
let ADS_CACHE = null, ADS_AT = 0;
export function dropAdsCache() { ADS_CACHE = null; ADS_AT = 0; }
export async function ads(req, env) {
  const db = env.DB;
  if (!ADS_CACHE || Date.now() - ADS_AT > 120e3) {
    const s = await settings(db), on = await flagOn(db);
    const { results } = on ? await db.prepare(`SELECT id, business, headline, image_hash FROM sponsor_ads WHERE status = 'active' AND paid_until > ? ORDER BY paid_until DESC, created_at`).bind(Date.now()).all() : { results: [] };
    const base = new URL('/api/v1/sponsor/', req.url).href;
    ADS_CACHE = { enabled: on, google: await gadSettings(db), aff: await affSettings(db), rotate_s: s.rotate, price_thb: s.price, days: s.days, advertise_url: siteBase(env) + '/advertise.html',
      ads: results.map((a) => ({ id: a.id, business: a.business, headline: a.headline, img: `${base}img/${a.id}?v=${a.image_hash}`, go: base + 'go/' + a.id })) };
    ADS_AT = Date.now();
  }
  return json(req, 200, ADS_CACHE, { 'Cache-Control': 'public, max-age=120' });
}
// GET /sponsor/img/{id} — the banner; never changes for a given ?v= (new upload = new id)
export async function img(req, env, id) {
  const a = await env.DB.prepare(`SELECT image_type, image_b64, status FROM sponsor_ads WHERE id = ?`).bind(id).first();
  if (!a || !['active', 'expired'].includes(a.status)) throw new ApiError(404, 'not_found');
  return new Response(b64ToBytes(a.image_b64), { headers: { 'Content-Type': a.image_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } });
}
// GET /sponsor/go/{id} — click → the shop's own stored link
export async function go(req, env, id) {
  const a = await env.DB.prepare(`SELECT link FROM sponsor_ads WHERE id = ? AND status = 'active'`).bind(id).first();
  if (!a || !/^https:\/\//.test(a.link)) throw new ApiError(404, 'not_found');
  try { await env.DB.prepare('UPDATE sponsor_ads SET clicks = clicks + 1 WHERE id = ?').bind(id).run(); } catch (_) {}
  return new Response(null, { status: 302, headers: { Location: a.link, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
// POST /sponsor/seen {"spn_…": n, …} — impressions counted on the phone and sent once per session
export async function seen(req, env) {
  const db = env.DB;
  if (!(await rateLimit(db, 'spn:seen:' + (await sha256(clientIp(req))), 30, 3600e3))) return json(req, 202, { ok: false });
  const b = await readJson(req, 4096), ops = [];
  for (const [id, n] of Object.entries(b).slice(0, 50)) {
    const k = Math.min(500, Math.max(0, parseInt(n, 10) || 0));
    if (k && /^spn_[A-Za-z0-9_-]{16}$/.test(id)) ops.push(db.prepare(`UPDATE sponsor_ads SET impressions = impressions + ? WHERE id = ? AND status = 'active'`).bind(k, id));
  }
  if (ops.length) await db.batch(ops);
  return json(req, 200, { ok: true });
}

// ---------- cron: finish waiting checks, expire, remind, re-check live banners ----------
export async function sponsorTick(env) {
  const db = env.DB, now = Date.now(), out = {};
  const exp = await db.prepare(`UPDATE sponsor_ads SET status = 'expired', updated_at = ? WHERE status = 'active' AND paid_until <= ?`).bind(now, now).run();
  out.expired = (exp.meta && exp.meta.changes) || 0;
  if (out.expired) dropAdsCache();
  const w = await db.prepare(`SELECT * FROM sponsor_ads WHERE status = 'checking' AND updated_at < ? ORDER BY updated_at LIMIT 1`).bind(now - 60e3).first();
  if (w) { const r = await checkSponsor(env, w, { tries: w.check_tries }); out.check = { id: w.id, status: await applyCheck(env, w, r) }; }
  // a live banner's link is checked again every 7 days (words, page, Safe Browsing); failing → taken down at once
  const live = await db.prepare(`SELECT * FROM sponsor_ads WHERE status = 'active' AND checked_at < ? ORDER BY checked_at LIMIT 1`).bind(now - 7 * DAY).first();
  if (live) {
    const r = await checkSponsor(env, live, { withAi: false });
    if (r.verdict === 'fail') {
      await db.prepare(`UPDATE sponsor_ads SET status = 'suspended', reason = ?, check_json = ?, checked_at = ?, updated_at = ? WHERE id = ?`).bind(r.reason, JSON.stringify(r.detail), now, now, live.id).run();
      dropAdsCache();
      await audit(db, 'system', null, 'sponsor_suspended', live.id, { reason: r.reason }, null);
      await mail(env, live.email, 'Sea Scout: โฆษณาถูกระงับ', [`โฆษณาของ ${live.business} ถูกระงับ: ${r.reason}`]);
      out.suspended = live.id;
    } else await db.prepare('UPDATE sponsor_ads SET checked_at = ? WHERE id = ?').bind(now, live.id).run();
  }
  // 3 days before the end: one reminder e-mail
  const due = await db.prepare(`SELECT id, email, business, paid_until FROM sponsor_ads WHERE status = 'active' AND paid_until < ? AND reminded_at = 0 LIMIT 3`).bind(now + 3 * DAY).all();
  for (const a of due.results) {
    await mail(env, a.email, 'Sea Scout: โฆษณาใกล้หมดอายุ', [`โฆษณาของ ${a.business} จะหยุดแสดงวันที่ ${new Date(a.paid_until).toISOString().slice(0, 10)} ต่ออายุได้ที่หน้าสถานะโฆษณา (ลิงก์ในอีเมลแรก)`]);
    await db.prepare('UPDATE sponsor_ads SET reminded_at = ? WHERE id = ?').bind(now, a.id).run();
  }
  return out;
}
