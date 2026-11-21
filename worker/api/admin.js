// Sea Scout API v1 — Admin API for SeaScout_Admin.html (owner/staff only).
// Sign-in = a normal Sea Scout account whose email is in admin_users. Admin tokens are separate, short-lived
// (2 h), stored hashed, and every change is written to audit_logs. Nothing secret is ever returned.
import { ApiError, json, readJson, newId, randomToken, sha256, hashPassword, safeEqual, cleanEmail, clientIp, country, str } from './util.js';
import { audit, rateLimit } from './store.js';
import { autoShopTick, configured as shopConfigured } from './autoshop.js';
import { monitorTick, healthView } from './monitor.js';
import { settings as spSettings, gadSettings, dropAdsCache, sponsorTick } from './sponsors.js';
import { checkSponsor } from './sponsor_check.js';
import { marketTick, resetMarketLinks, configured as marketConfigured, searchUrl } from './markets.js';

const ROLE = { viewer: 0, support: 1, admin: 2, owner: 3 };
const ADMIN_TTL = 2 * 3600e3;
const need = (a, r) => { if (ROLE[a.role] < ROLE[r]) throw new ApiError(403, 'forbidden'); };
const confirm = (b) => { if (!b || b.confirm !== true) throw new ApiError(400, 'confirmation_required'); };
const J = (v) => JSON.stringify(v);
const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

async function login(req, env) {
  const db = env.DB, b = await readJson(req), email = cleanEmail(b.email);
  if (!(await rateLimit(db, 'adm:ip:' + (await sha256(clientIp(req))), 10, 900e3)) || !(await rateLimit(db, 'adm:em:' + (await sha256(email)), 5, 900e3))) throw new ApiError(429, 'too_many_requests');
  const u = await db.prepare(`SELECT u.id, u.password_hash, u.password_salt, u.password_iter, a.id AS admin_id, a.role, a.disabled
    FROM users u JOIN admin_users a ON a.email = u.email WHERE u.email = ? AND u.status = 'active'`).bind(email).first();
  const c = await hashPassword(String(b.password || 'x'), u && u.password_salt ? u.password_salt : 'AAAAAAAAAAAAAAAAAAAAAA==', u && u.password_iter ? u.password_iter : undefined);
  if (!u || !u.password_hash || !safeEqual(c.hash, u.password_hash) || u.disabled) {
    await audit(db, 'admin', u ? u.admin_id : null, 'admin_login_fail', null, null, country(req));
    throw new ApiError(401, 'invalid_credentials');
  }
  const tok = randomToken(32), now = Date.now();
  await db.prepare('INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, created_at, last_used_at, country) VALUES (?,?,?,?,?,?,?)')
    .bind(newId('ads'), u.admin_id, await sha256(tok), now + ADMIN_TTL, now, now, country(req)).run();
  await audit(db, 'admin', u.admin_id, 'admin_login', null, null, country(req));
  return json(req, 200, { token: tok, expires_at: now + ADMIN_TTL, role: u.role, email });
}
async function authAdmin(db, req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new ApiError(401, 'unauthorized');
  const s = await db.prepare(`SELECT s.id AS sid, s.expires_at, a.id, a.email, a.role, a.disabled FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL`).bind(await sha256(m[1])).first();
  if (!s || s.expires_at < Date.now() || s.disabled) throw new ApiError(401, 'unauthorized');
  await db.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE id = ?').bind(Date.now(), s.sid).run();
  return s;
}

// ---------- read ----------
async function overview(req, env, a) {
  const db = env.DB, now = Date.now(), d = 86400e3;
  const one = async (sql, ...v) => (await db.prepare(sql).bind(...v).first()) || {};
  const users = await one(`SELECT COUNT(*) AS total, SUM(created_at > ?) AS new_7d, SUM(status='disabled') AS disabled FROM users WHERE status <> 'deleted'`, now - 7 * d);
  const active = await one(`SELECT COUNT(DISTINCT user_id) AS d30, COUNT(DISTINCT CASE WHEN last_used_at > ? THEN user_id END) AS d1, COUNT(DISTINCT CASE WHEN last_used_at > ? THEN user_id END) AS online
    FROM sessions WHERE revoked_at IS NULL AND last_used_at > ?`, now - d, now - 5 * 60e3, now - 30 * d);
  const { results: plans } = await db.prepare(`SELECT plan_id, source, COUNT(*) AS n FROM subscriptions WHERE status IN ('active','grace') AND (expires_at IS NULL OR expires_at > ?) GROUP BY plan_id, source`).bind(now).all();
  const { results: devs } = await db.prepare('SELECT platform, COUNT(*) AS n FROM devices GROUP BY platform').all();
  const sec = await one(`SELECT SUM(action='login_fail') AS login_fail, SUM(action='admin_login_fail') AS admin_login_fail, SUM(action='refresh_reuse_detected') AS token_reuse, COUNT(*) AS events FROM audit_logs WHERE at > ?`, now - d);
  const clicks = await one('SELECT COUNT(*) AS n FROM affiliate_clicks WHERE at > ?', now - 7 * d);
  const pay = await one(`SELECT COUNT(*) AS n, SUM(result IN ('revoked','expired','canceled')) AS lost FROM payment_events WHERE received_at > ?`, now - 7 * d);
  const cfg = {
    google_signin: !!env.GOOGLE_CLIENT_IDS, apple_signin: !!env.APPLE_CLIENT_IDS, facebook_signin: !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET), email: !!(env.RESEND_API_KEY && env.EMAIL_FROM),
    google_billing: !!(env.GOOGLE_PLAY_PACKAGE && env.GOOGLE_SERVICE_ACCOUNT_JSON), google_rtdn: !!env.GOOGLE_RTDN_AUDIENCE,
    apple_billing: !!(env.APPLE_BUNDLE_ID && env.APPLE_ISSUER_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
  };
  return json(req, 200, { at: now, users, active, subscriptions: plans, devices: devs, security_24h: sec, affiliate_clicks_7d: clicks.n || 0, payments_7d: pay, config: cfg, you: { email: a.email, role: a.role } });
}
async function listUsers(req, env) {
  const url = new URL(req.url), q = str(url.searchParams.get('q'), 120), limit = int(url.searchParams.get('limit'), 50, 1, 200), before = int(url.searchParams.get('before'), 9e15, 0, 9e15);
  const where = [`u.status <> 'deleted'`, 'u.created_at < ?'], v = [before];
  if (q) { where.push('(u.email LIKE ? OR u.id = ?)'); v.push('%' + q.replace(/[%_]/g, '') + '%', q); }
  const { results } = await env.DB.prepare(`SELECT u.id, u.email, u.email_verified, u.status, u.created_at,
      (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
      (SELECT s.plan_id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = u.id AND s.status IN ('active','grace') AND (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY p.rank DESC LIMIT 1) AS plan
    FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT ?`).bind(Date.now(), ...v, limit).all();
  return json(req, 200, { users: results.map((r) => ({ ...r, plan: r.plan || 'free', email_verified: !!r.email_verified })) });
}
async function getUser(req, env, a, id) {
  const db = env.DB;
  const u = await db.prepare('SELECT id, email, email_verified, status, created_at, updated_at, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?').bind(id).first();
  if (!u) throw new ApiError(404, 'not_found');
  const all = async (sql) => (await db.prepare(sql).bind(id).all()).results;
  return json(req, 200, {
    user: { ...u, email_verified: !!u.email_verified, has_password: !!u.has_password },
    profile: await db.prepare('SELECT display_name, locale, country, units, marketing_consent, privacy_consent_at, privacy_version FROM user_profiles WHERE user_id = ?').bind(id).first(),
    providers: (await all('SELECT provider, created_at FROM identities WHERE user_id = ?')),
    devices: await all('SELECT id, platform, model, app_version, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC'),
    sessions_active: (await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND refresh_exp > ?').bind(id, Date.now()).first()).n,
    subscriptions: await all('SELECT id, plan_id, source, store_product_id, status, started_at, expires_at, auto_renew, updated_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC'),
    entitlements: await all('SELECT key, value, source, expires_at, created_at FROM entitlements WHERE user_id = ?'),
    audit: (await db.prepare('SELECT at, actor_type, action, target, details, country FROM audit_logs WHERE actor_id = ? OR target = ? ORDER BY at DESC LIMIT 50').bind(id, id).all()).results,
  });
}
async function auditList(req, env) {
  const url = new URL(req.url), limit = int(url.searchParams.get('limit'), 100, 1, 500), before = int(url.searchParams.get('before'), 9e15, 0, 9e15);
  const where = ['at < ?'], v = [before];
  const act = str(url.searchParams.get('action'), 40); if (act) { where.push('action = ?'); v.push(act); }
  const actor = str(url.searchParams.get('actor_type'), 10); if (actor) { where.push('actor_type = ?'); v.push(actor); }
  const { results } = await env.DB.prepare(`SELECT id, at, actor_type, actor_id, action, target, details, country FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).bind(...v, limit).all();
  return json(req, 200, { logs: results });
}
async function flagsList(req, env) { return json(req, 200, { flags: (await env.DB.prepare('SELECT * FROM feature_flags ORDER BY key').all()).results }); }
async function plansList(req, env) {
  const db = env.DB;
  return json(req, 200, { plans: (await db.prepare('SELECT * FROM plans ORDER BY rank').all()).results, entitlements: (await db.prepare('SELECT * FROM plan_entitlements ORDER BY plan_id, key').all()).results,
    store_products: (await db.prepare('SELECT * FROM store_products ORDER BY store, product_id').all()).results });
}
async function paymentsList(req, env) {
  const { results } = await env.DB.prepare('SELECT id, store, event_type, store_txn_id, user_id, result, received_at FROM payment_events ORDER BY received_at DESC LIMIT 200').all();
  return json(req, 200, { events: results.map((e) => ({ ...e, store_txn_id: e.store_txn_id ? e.store_txn_id.slice(0, 10) + '…' : null })) });
}

// ---------- write (all audited) ----------
async function grantSub(req, env, a, id) {
  need(a, 'support'); const db = env.DB, b = await readJson(req);
  if (!['premium', 'pro'].includes(b.plan)) throw new ApiError(400, 'invalid_plan');
  const days = int(b.days, 0, 0, 3660), now = Date.now();
  if (!(await db.prepare(`SELECT 1 FROM users WHERE id = ? AND status <> 'deleted'`).bind(id).first())) throw new ApiError(404, 'not_found');
  const sid = newId('sub');
  await db.prepare(`INSERT INTO subscriptions (id, user_id, plan_id, source, store_txn_id, status, started_at, expires_at, auto_renew, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?)`)
    .bind(sid, id, b.plan, 'manual', sid, 'active', now, days ? now + days * 86400e3 : null, now).run();
  await audit(db, 'admin', a.id, 'grant_subscription', id, { plan: b.plan, days: days || null, note: str(b.note, 200) }, country(req));
  return json(req, 200, { ok: true, subscription_id: sid });
}
async function revokeSub(req, env, a, id, sid) {
  need(a, 'support'); const db = env.DB, b = await readJson(req); confirm(b);
  const s = await db.prepare('SELECT source FROM subscriptions WHERE id = ? AND user_id = ?').bind(sid, id).first();
  if (!s) throw new ApiError(404, 'not_found');
  if (s.source !== 'manual' && s.source !== 'tester') throw new ApiError(400, 'store_subscription_change_in_store');
  await db.prepare(`UPDATE subscriptions SET status = 'revoked', updated_at = ? WHERE id = ?`).bind(Date.now(), sid).run();
  await audit(db, 'admin', a.id, 'revoke_subscription', id, { subscription: sid }, country(req));
  return json(req, 200, { ok: true });
}
async function setStatus(req, env, a, id, status) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req); confirm(b); const now = Date.now();
  const ops = [db.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'`).bind(status, now, id)];
  if (status === 'disabled') ops.push(db.prepare(`UPDATE sessions SET revoked_at = ?, revoke_reason = 'admin_disabled' WHERE user_id = ? AND revoked_at IS NULL`).bind(now, id));
  await db.batch(ops);
  await audit(db, 'admin', a.id, status === 'disabled' ? 'disable_user' : 'enable_user', id, { reason: str(b.reason, 200) }, country(req));
  return json(req, 200, { ok: true });
}
async function signoutUser(req, env, a, id) {
  need(a, 'support'); const db = env.DB;
  await db.prepare(`UPDATE sessions SET revoked_at = ?, revoke_reason = 'admin_signout' WHERE user_id = ? AND revoked_at IS NULL`).bind(Date.now(), id).run();
  await audit(db, 'admin', a.id, 'signout_user', id, null, country(req));
  return json(req, 200, { ok: true });
}
async function setEnt(req, env, a, id, key) {
  need(a, 'admin'); const db = env.DB;
  if (!/^[a-z_]{2,40}$/.test(key)) throw new ApiError(400, 'invalid_key');
  if (req.method === 'DELETE') {
    await db.prepare('DELETE FROM entitlements WHERE user_id = ? AND key = ?').bind(id, key).run();
    await audit(db, 'admin', a.id, 'entitlement_remove', id, { key }, country(req));
    return json(req, 200, { ok: true });
  }
  const b = await readJson(req);
  if (!['boolean', 'number', 'string'].includes(typeof b.value)) throw new ApiError(400, 'invalid_value');
  const exp = b.days ? Date.now() + int(b.days, 1, 1, 3660) * 86400e3 : null;
  await db.prepare(`INSERT INTO entitlements (user_id, key, value, source, expires_at, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, source=excluded.source, expires_at=excluded.expires_at`).bind(id, key, J(b.value), 'admin:' + a.id, exp, Date.now()).run();
  await audit(db, 'admin', a.id, 'entitlement_set', id, { key, value: b.value, days: b.days || null }, country(req));
  return json(req, 200, { ok: true });
}
async function patchFlag(req, env, a, key) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  const old = await db.prepare('SELECT * FROM feature_flags WHERE key = ?').bind(key).first();
  if (!old) throw new ApiError(404, 'not_found');
  if (['server_premium', 'accounts'].includes(key)) confirm(b);
  const enabled = typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : old.enabled;
  const pct = b.rollout_pct != null ? int(b.rollout_pct, old.rollout_pct, 0, 100) : old.rollout_pct;
  await db.prepare('UPDATE feature_flags SET enabled = ?, rollout_pct = ?, updated_at = ?, updated_by = ? WHERE key = ?').bind(enabled, pct, Date.now(), a.email, key).run();
  await audit(db, 'admin', a.id, 'flag_change', key, { from: { enabled: old.enabled, rollout_pct: old.rollout_pct }, to: { enabled, rollout_pct: pct } }, country(req));
  return json(req, 200, { ok: true, rollback: { enabled: !!old.enabled, rollout_pct: old.rollout_pct } });
}
async function putPlanEnt(req, env, a, plan, key) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  if (!['free', 'premium', 'pro'].includes(plan) || !/^[a-z_]{2,40}$/.test(key)) throw new ApiError(400, 'invalid_key');
  if (!['boolean', 'number', 'string'].includes(typeof b.value)) throw new ApiError(400, 'invalid_value');
  const old = await db.prepare('SELECT value FROM plan_entitlements WHERE plan_id = ? AND key = ?').bind(plan, key).first();
  await db.prepare('INSERT INTO plan_entitlements (plan_id, key, value) VALUES (?,?,?) ON CONFLICT(plan_id, key) DO UPDATE SET value = excluded.value').bind(plan, key, J(b.value)).run();
  await audit(db, 'admin', a.id, 'plan_entitlement_set', plan + ':' + key, { from: old ? JSON.parse(old.value) : null, to: b.value }, country(req));
  return json(req, 200, { ok: true });
}
async function putStoreProduct(req, env, a) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  if (!['google', 'apple'].includes(b.store) || !['premium', 'pro'].includes(b.plan_id) || !/^[A-Za-z0-9._-]{2,100}$/.test(b.product_id || '')) throw new ApiError(400, 'invalid_product');
  await db.prepare('INSERT INTO store_products (store, product_id, plan_id, period) VALUES (?,?,?,?) ON CONFLICT(store, product_id) DO UPDATE SET plan_id = excluded.plan_id, period = excluded.period')
    .bind(b.store, b.product_id, b.plan_id, str(b.period, 10)).run();
  await audit(db, 'admin', a.id, 'store_product_set', b.store + ':' + b.product_id, { plan: b.plan_id, period: b.period || null }, country(req));
  return json(req, 200, { ok: true });
}

// ---------- commerce CRUD ----------
const httpsUrl = (v) => { const s = String(v || '').trim(); if (!/^https:\/\/[^\s<>"']{4,2000}$/i.test(s)) throw new ApiError(400, 'invalid_url'); return s; };
const tagList = (v) => { const t = Array.isArray(v) ? v.map(String).filter((x) => /^[a-z0-9_]{1,24}$/i.test(x)).slice(0, 40) : ['all']; return t.length ? t : ['all']; };
const i18n = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? J(Object.fromEntries(Object.entries(v).filter(([k, x]) => /^[a-z]{2,3}$/.test(k) && typeof x === 'string').map(([k, x]) => [k, x.slice(0, 2000)]))) : null);
async function commerceList(req, env) {
  const db = env.DB;
  const [p, i, m, o, c] = await Promise.all([
    db.prepare('SELECT * FROM products ORDER BY sort, updated_at DESC').all(), db.prepare('SELECT * FROM product_images ORDER BY product_id, sort').all(),
    db.prepare('SELECT * FROM merchants ORDER BY name').all(), db.prepare('SELECT * FROM offers ORDER BY product_id, sort').all(),
    db.prepare('SELECT offer_id, COUNT(*) AS n, MAX(at) AS last FROM affiliate_clicks WHERE at > ? GROUP BY offer_id').bind(Date.now() - 30 * 86400e3).all(),
  ]);
  return json(req, 200, { products: p.results, images: i.results, merchants: m.results, offers: o.results, clicks_30d: c.results });
}
async function upsertProduct(req, env, a, id) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req, 65536), now = Date.now();
  const title = str(b.title, 200); if (!title) throw new ApiError(400, 'title_required');
  const pid = id || newId('prd');
  await db.prepare(`INSERT INTO products (id, title, title_i18n, description, desc_i18n, brand, tags, active, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, title_i18n=excluded.title_i18n, description=excluded.description, desc_i18n=excluded.desc_i18n, brand=excluded.brand,
      tags=excluded.tags, active=excluded.active, sort=excluded.sort, updated_at=excluded.updated_at`)
    .bind(pid, title, i18n(b.title_i18n), str(b.description, 4000), i18n(b.desc_i18n), str(b.brand, 80), J(tagList(b.tags)), b.active === false ? 0 : 1, int(b.sort, 0, -9999, 9999), now, now).run();
  if (Array.isArray(b.images)) {
    const ops = [db.prepare('DELETE FROM product_images WHERE product_id = ?').bind(pid)];
    b.images.slice(0, 20).forEach((im, k) => ops.push(db.prepare('INSERT INTO product_images (id, product_id, url, alt, sort) VALUES (?,?,?,?,?)').bind(newId('img'), pid, httpsUrl(im.url || im), str(im.alt, 200), k)));
    await db.batch(ops);
  }
  await audit(db, 'admin', a.id, id ? 'product_update' : 'product_create', pid, { title }, country(req));
  return json(req, 200, { ok: true, id: pid });
}
async function upsertMerchant(req, env, a, id) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  const name = str(b.name, 80); if (!name) throw new ApiError(400, 'name_required');
  if (!['shopee', 'lazada', 'amazon', 'awin', 'impact', 'direct', 'other'].includes(b.kind)) throw new ApiError(400, 'invalid_kind');
  const mid = id || newId('mer');
  await db.prepare(`INSERT INTO merchants (id, name, kind, active, created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, active=excluded.active`)
    .bind(mid, name, b.kind, b.active === false ? 0 : 1, Date.now()).run();
  await audit(db, 'admin', a.id, id ? 'merchant_update' : 'merchant_create', mid, { name, kind: b.kind }, country(req));
  return json(req, 200, { ok: true, id: mid });
}
async function upsertOffer(req, env, a, id) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  if (!(await db.prepare('SELECT 1 FROM products WHERE id = ?').bind(String(b.product_id || '')).first())) throw new ApiError(400, 'invalid_product');
  if (!(await db.prepare('SELECT 1 FROM merchants WHERE id = ?').bind(String(b.merchant_id || '')).first())) throw new ApiError(400, 'invalid_merchant');
  const cc = b.country === '*' || /^[A-Z]{2}$/.test(b.country || '') ? b.country : '*';
  const price = b.price == null || b.price === '' ? null : Number(b.price); if (price != null && !(price >= 0 && price < 1e9)) throw new ApiError(400, 'invalid_price');
  const cur = b.currency ? String(b.currency).toUpperCase() : null; if (cur && !/^[A-Z]{3}$/.test(cur)) throw new ApiError(400, 'invalid_currency');
  const oid = id || newId('off');
  await db.prepare(`INSERT INTO offers (id, product_id, merchant_id, country, currency, price, url, active, sort, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id, merchant_id=excluded.merchant_id, country=excluded.country, currency=excluded.currency, price=excluded.price,
      url=excluded.url, active=excluded.active, sort=excluded.sort, updated_at=excluded.updated_at`)
    .bind(oid, b.product_id, b.merchant_id, cc, cur, price, httpsUrl(b.url), b.active === false ? 0 : 1, int(b.sort, 0, -9999, 9999), Date.now()).run();
  await audit(db, 'admin', a.id, id ? 'offer_update' : 'offer_create', oid, { product: b.product_id, merchant: b.merchant_id, country: cc }, country(req));
  return json(req, 200, { ok: true, id: oid });
}
async function deleteRow(req, env, a, table, id) {
  need(a, 'admin'); const b = await readJson(req); confirm(b);
  const T = { products: 'products', offers: 'offers', merchants: 'merchants' }[table];
  if (table === 'merchants' && (await env.DB.prepare('SELECT 1 FROM offers WHERE merchant_id = ?').bind(id).first())) throw new ApiError(409, 'merchant_has_offers');
  const r = await env.DB.prepare(`DELETE FROM ${T} WHERE id = ?`).bind(id).run();
  if (!r.meta || !r.meta.changes) throw new ApiError(404, 'not_found');
  await audit(env.DB, 'admin', a.id, table.slice(0, -1) + '_delete', id, null, country(req));
  return json(req, 200, { ok: true });
}

// ---------- automatic shop (r14.15.68): admins never type links; they only see, block/unblock, or edit search words ----------
async function shopList(req, env, a) {
  need(a, 'admin'); const db = env.DB;
  const [q, p] = await Promise.all([db.prepare('SELECT * FROM shop_queries ORDER BY source, id').all(),
    db.prepare(`SELECT id, title, source, ext_id, query_id, rating, rating_scale, sales, active, off_reason, sort, refreshed_at FROM products WHERE source != 'manual' ORDER BY query_id, active DESC, sort`).all()]);
  return json(req, 200, { networks: { shopee: shopConfigured.shopee(env), aliexpress: shopConfigured.aliexpress(env) }, queries: q.results, products: p.results });
}
async function shopBlock(req, env, a, id, block) {
  need(a, 'admin'); const now = Date.now();
  const r = await env.DB.prepare(block ? `UPDATE products SET active = 0, off_reason = 'admin', updated_at = ? WHERE id = ? AND source != 'manual'`
    : `UPDATE products SET active = 1, off_reason = NULL, updated_at = ? WHERE id = ? AND source != 'manual' AND off_reason = 'admin'`).bind(now, id).run();
  if (!r.meta || !r.meta.changes) throw new ApiError(404, 'not_found');
  await audit(env.DB, 'admin', a.id, block ? 'shop_block' : 'shop_unblock', id, null, country(req));
  return json(req, 200, { ok: true });
}
async function shopQuery(req, env, a, id) {
  need(a, 'admin'); const b = await readJson(req);
  const kw = str(b.keyword, 80); if (!kw) throw new ApiError(400, 'keyword_required');
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(String).filter((t) => /^[A-Za-z]{2,20}$/.test(t)).slice(0, 10);
  if (!tags.length) throw new ApiError(400, 'tags_required');
  const r = await env.DB.prepare('UPDATE shop_queries SET keyword = ?, tags = ?, active = ?, last_run = 0 WHERE id = ?').bind(kw, JSON.stringify(tags), b.active === false ? 0 : 1, id).run();
  if (!r.meta || !r.meta.changes) throw new ApiError(404, 'not_found');
  await audit(env.DB, 'admin', a.id, 'shop_query', id, { keyword: kw, tags }, country(req));
  return json(req, 200, { ok: true });
}
async function shopRun(req, env, a) {
  need(a, 'admin'); const b = await readJson(req);
  const out = await autoShopTick(env, { force: true, queryId: b.query_id ? String(b.query_id).slice(0, 40) : null });
  await audit(env.DB, 'admin', a.id, 'shop_run', b.query_id || '', out, country(req));
  return json(req, 200, out);
}

// ---------- admin users (owner) ----------
async function adminsList(req, env, a) { need(a, 'owner'); return json(req, 200, { admins: (await env.DB.prepare('SELECT id, email, role, disabled, created_at FROM admin_users ORDER BY created_at').all()).results }); }
async function adminUpsert(req, env, a) {
  need(a, 'owner'); const db = env.DB, b = await readJson(req); confirm(b);
  const email = cleanEmail(b.email); if (!ROLE.hasOwnProperty(b.role)) throw new ApiError(400, 'invalid_role');
  if (email === a.email && b.role !== 'owner') throw new ApiError(400, 'cannot_demote_yourself');
  await db.prepare(`INSERT INTO admin_users (id, email, role, disabled, created_at) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET role = excluded.role, disabled = excluded.disabled`)
    .bind(newId('adm'), email, b.role, b.disabled ? 1 : 0, Date.now()).run();
  if (b.disabled) await db.prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = (SELECT id FROM admin_users WHERE email = ?) AND revoked_at IS NULL`).bind(Date.now(), email).run();
  await audit(db, 'admin', a.id, 'admin_user_set', email, { role: b.role, disabled: !!b.disabled }, country(req));
  return json(req, 200, { ok: true });
}
async function logout(req, env, a) {
  await env.DB.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id = ?').bind(Date.now(), a.sid).run();
  return json(req, 200, { ok: true });
}

// r14.15.73: system health (usage vs free-plan limits, data servers, app crashes, alerts)
async function health(req, env) { return json(req, 200, await healthView(env)); }
async function healthRun(req, env, a) {
  need(a, 'admin');
  const r = await monitorTick(env, { force: true });
  await audit(env.DB, 'admin', a.id, 'health_run', null, { level: r.level }, country(req));
  return json(req, 200, { run: r, ...(await healthView(env)) });
}

// r14.15.74: country → marketplaces (the intermediary)
async function marketsList(req, env) {
  const db = env.DB;
  const { results: markets } = await db.prepare('SELECT * FROM marketplaces ORDER BY country, rank, id').all();
  const { results: keywords } = await db.prepare('SELECT * FROM market_keywords ORDER BY id, lang').all();
  const { results: clicks } = await db.prepare(`SELECT p.query_id AS market, COUNT(*) AS n FROM affiliate_clicks c JOIN products p ON p.id = c.product_id
    WHERE p.source = 'market' AND c.at > ? GROUP BY p.query_id`).bind(Date.now() - 30 * 86400e3).all();
  const flag = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'market_links'`).first();
  return json(req, 200, { markets, keywords, clicks_30d: clicks, enabled: !!(flag && flag.enabled),
    networks: Object.fromEntries(Object.keys(marketConfigured).map((n) => [n, marketConfigured[n](env)])) });
}
async function marketPut(req, env, a, id) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  const m = await db.prepare('SELECT * FROM marketplaces WHERE id = ?').bind(id).first();
  if (!m) throw new ApiError(404, 'not_found');
  const v = {
    active: b.active === undefined ? m.active : b.active ? 1 : 0,
    rank: b.rank === undefined ? m.rank : Math.max(1, Math.min(9, parseInt(b.rank, 10) || 1)),
    search_url: b.search_url === undefined ? m.search_url : (str(b.search_url, 300) || ''),
    advertiser: b.advertiser === undefined ? m.advertiser : str(b.advertiser, 60),
    program_id: b.program_id === undefined ? m.program_id : (str(b.program_id, 60) || null),
    lang: b.lang === undefined ? m.lang : (/^[a-z]{2,5}$/.test(String(b.lang)) ? String(b.lang) : m.lang),
  };
  if (!/^https:\/\/[^\s]+$/.test(v.search_url) || !/\{qh?\}/.test(v.search_url) || !searchUrl(v.search_url, 'test')) throw new ApiError(400, 'invalid_url', 'https://… with {q} or {qh}');
  if (!v.advertiser) throw new ApiError(400, 'advertiser_required');
  await db.prepare('UPDATE marketplaces SET active=?, rank=?, search_url=?, advertiser=?, program_id=?, lang=? WHERE id=?').bind(v.active, v.rank, v.search_url, v.advertiser, v.program_id, v.lang, id).run();
  // switching a shop off hides its links at once; on again shows them again (admin-blocked items stay blocked)
  if (v.active !== m.active) await db.prepare(v.active
    ? `UPDATE products SET active = 1, off_reason = NULL WHERE source = 'market' AND query_id = ? AND off_reason = 'market_off'`
    : `UPDATE products SET active = 0, off_reason = 'market_off' WHERE source = 'market' AND query_id = ? AND off_reason IS NULL`).bind(id).run();
  if (v.rank !== m.rank) await db.prepare(`UPDATE products SET sort = ? WHERE source = 'market' AND query_id = ?`).bind(1000 + v.rank, id).run();
  if (v.search_url !== m.search_url || v.program_id !== m.program_id || v.advertiser !== m.advertiser || v.lang !== m.lang) {
    if (v.advertiser !== m.advertiser && b.program_id === undefined) await db.prepare('UPDATE marketplaces SET program_id = NULL WHERE id = ?').bind(id).run();
    await resetMarketLinks(db, id);
  }
  await audit(db, 'admin', a.id, 'market_update', id, v, country(req));
  return json(req, 200, { ok: true });
}
async function keywordPut(req, env, a, id, lang) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req);
  const kw = str(b.keyword, 80);
  if (!kw) throw new ApiError(400, 'keyword_required');
  const row = await db.prepare('SELECT tags FROM market_keywords WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) throw new ApiError(404, 'not_found');
  await db.prepare('INSERT INTO market_keywords (id, lang, keyword, tags) VALUES (?,?,?,?) ON CONFLICT(id, lang) DO UPDATE SET keyword = excluded.keyword').bind(id, lang, kw, row.tags).run();
  // every shop searching in this language makes that link again
  await db.prepare(`UPDATE products SET refreshed_at = 0 WHERE source = 'market' AND ext_id LIKE ? AND query_id IN (SELECT id FROM marketplaces WHERE lang = ? OR ? = 'en')`).bind('%:' + id, lang, lang).run();
  await audit(db, 'admin', a.id, 'market_keyword', id + '/' + lang, { keyword: kw }, country(req));
  return json(req, 200, { ok: true });
}
async function marketRun(req, env, a) {
  need(a, 'admin'); const b = await readJson(req);
  const out = await marketTick(env, { force: true, marketId: b.market_id ? str(b.market_id, 40) : null });
  await audit(env.DB, 'admin', a.id, 'market_run', b.market_id || '', out, country(req));
  return json(req, 200, out);
}

// r14.15.75: sponsor banners
async function sponsorsList(req, env) {
  const db = env.DB, now = Date.now();
  const { results } = await db.prepare(`SELECT id, status, business, email, link, headline, reason, check_json, paid_until, paid_total, impressions, clicks, created_at, updated_at, country, image_hash
    FROM sponsor_ads ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'awaiting_payment' THEN 1 WHEN 'checking' THEN 2 ELSE 3 END, updated_at DESC LIMIT 300`).all();
  const rev = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS a, COUNT(*) AS n FROM sponsor_payments WHERE status = 'paid' AND paid_at > ?`).bind(now - 30 * 86400e3).first();
  const flag = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'sponsor_ads'`).first();
  return json(req, 200, { ads: results, settings: await spSettings(db), google: await gadSettings(db), revenue_30d_thb: Math.round(rev.a / 100), payments_30d: rev.n, enabled: !flag || !!flag.enabled,
    setup: { stripe: !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET), ai: !!(env.AI || env.SPONSOR_AI_URL), safe_browsing: !!env.SAFE_BROWSING_KEY, email: !!(env.RESEND_API_KEY && env.EMAIL_FROM) } });
}
async function sponsorImg(req, env, a, id) {
  const r = await env.DB.prepare('SELECT image_type, image_b64 FROM sponsor_ads WHERE id = ?').bind(id).first();
  if (!r) throw new ApiError(404, 'not_found');
  return json(req, 200, { image: `data:${r.image_type};base64,${r.image_b64}` });
}
async function sponsorSet(req, env, a, id, action) {
  need(a, 'admin'); const db = env.DB, b = await readJson(req), now = Date.now();
  const ad = await db.prepare('SELECT * FROM sponsor_ads WHERE id = ?').bind(id).first();
  if (!ad) throw new ApiError(404, 'not_found');
  if (action === 'remove') await db.prepare(`UPDATE sponsor_ads SET status = 'removed', reason = ?, updated_at = ? WHERE id = ?`).bind(str(b.reason, 200) || 'ผู้ดูแลระบบนำโฆษณาออก', now, id).run();
  else if (action === 'restore') {
    if (!['removed', 'suspended', 'rejected'].includes(ad.status)) throw new ApiError(409, 'not_removed');
    const st = ad.paid_until > now ? 'active' : ad.paid_total > 0 ? 'expired' : 'awaiting_payment';
    await db.prepare('UPDATE sponsor_ads SET status = ?, reason = NULL, checked_at = ?, updated_at = ? WHERE id = ?').bind(st, now, now, id).run();
  } else if (action === 'recheck') {
    const r = await checkSponsor(env, ad, { tries: 0 });
    const st = r.verdict === 'fail' ? (ad.status === 'active' ? 'suspended' : 'rejected') : ad.status === 'checking' || ad.status === 'rejected' ? (r.verdict === 'pass' ? 'awaiting_payment' : 'checking') : ad.status;
    await db.prepare('UPDATE sponsor_ads SET status = ?, reason = ?, check_json = ?, checked_at = ?, updated_at = ? WHERE id = ?').bind(st, r.verdict === 'fail' ? r.reason : null, JSON.stringify(r.detail || {}), now, now, id).run();
  } else if (action === 'extend') {
    const days = Math.max(1, Math.min(366, parseInt(b.days, 10) || 0));
    if (!days) throw new ApiError(400, 'days_required');
    await db.prepare(`UPDATE sponsor_ads SET status = 'active', paid_until = ?, updated_at = ? WHERE id = ?`).bind(Math.max(now, ad.paid_until) + days * 86400e3, now, id).run();
  }
  dropAdsCache();
  await audit(db, 'admin', a.id, 'sponsor_' + action, id, b && b.reason ? { reason: str(b.reason, 200) } : b && b.days ? { days: b.days } : null, country(req));
  return json(req, 200, { ok: true });
}
async function sponsorSettings(req, env, a) {
  need(a, 'owner'); const db = env.DB, b = await readJson(req), out = {};
  const lim = { sponsor_price_thb: [100, 1000000], sponsor_days: [1, 366], sponsor_max: [0, 100], sponsor_rotate_s: [3, 60] };
  for (const [k, [lo, hi]] of Object.entries(lim)) {
    if (b[k] === undefined) continue;
    const v = parseInt(b[k], 10);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new ApiError(400, 'invalid_' + k);
    await db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v)).run(); out[k] = v;
  }
  // Google AdMob (top banner in the phone app): gad_on 0/1, ad unit IDs ca-app-pub-<16 digits>/<10 digits> or '' (= Google test banner)
  if (b.gad_on !== undefined) {
    const v = b.gad_on === true || b.gad_on === 1 || b.gad_on === '1' ? '1' : b.gad_on === false || b.gad_on === 0 || b.gad_on === '0' ? '0' : null;
    if (!v) throw new ApiError(400, 'invalid_gad_on');
    await db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('gad_on', v).run(); out.gad_on = v;
  }
  for (const k of ['gad_android', 'gad_ios']) {
    if (b[k] === undefined) continue;
    const v = String(b[k] == null ? '' : b[k]).trim();
    if (v && !/^ca-app-pub-\d{16}\/\d{10}$/.test(v)) throw new ApiError(400, 'invalid_' + k);
    await db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v).run(); out[k] = v;
  }
  dropAdsCache();
  await audit(db, 'admin', a.id, 'sponsor_settings', null, out, country(req));
  return json(req, 200, { ok: true, settings: await spSettings(db) });
}
async function sponsorRun(req, env, a) { need(a, 'admin'); return json(req, 200, await sponsorTick(env)); }

const R = [
  ['GET', /^overview$/, overview], ['GET', /^users$/, listUsers], ['GET', /^users\/(usr_[\w-]{16})$/, getUser],
  ['POST', /^users\/(usr_[\w-]{16})\/subscriptions$/, grantSub], ['POST', /^users\/(usr_[\w-]{16})\/subscriptions\/(sub_[\w-]{16})\/revoke$/, revokeSub],
  ['POST', /^users\/(usr_[\w-]{16})\/disable$/, (q, e, a, id) => setStatus(q, e, a, id, 'disabled')], ['POST', /^users\/(usr_[\w-]{16})\/enable$/, (q, e, a, id) => setStatus(q, e, a, id, 'active')],
  ['POST', /^users\/(usr_[\w-]{16})\/signout$/, signoutUser],
  ['PUT', /^users\/(usr_[\w-]{16})\/entitlements\/([a-z_]{2,40})$/, setEnt], ['DELETE', /^users\/(usr_[\w-]{16})\/entitlements\/([a-z_]{2,40})$/, setEnt],
  ['GET', /^flags$/, flagsList], ['PATCH', /^flags\/([a-z_]{2,40})$/, patchFlag],
  ['GET', /^plans$/, plansList], ['PUT', /^plans\/(free|premium|pro)\/entitlements\/([a-z_]{2,40})$/, putPlanEnt], ['PUT', /^store-products$/, putStoreProduct],
  ['GET', /^audit$/, auditList], ['GET', /^payments$/, paymentsList],
  ['GET', /^commerce$/, commerceList],
  ['POST', /^products$/, (q, e, a) => upsertProduct(q, e, a, null)], ['PUT', /^products\/(prd_[\w-]{16})$/, upsertProduct], ['DELETE', /^products\/(prd_[\w-]{16})$/, (q, e, a, id) => deleteRow(q, e, a, 'products', id)],
  ['POST', /^merchants$/, (q, e, a) => upsertMerchant(q, e, a, null)], ['PUT', /^merchants\/(mer_[\w-]{16})$/, upsertMerchant], ['DELETE', /^merchants\/(mer_[\w-]{16})$/, (q, e, a, id) => deleteRow(q, e, a, 'merchants', id)],
  ['POST', /^offers$/, (q, e, a) => upsertOffer(q, e, a, null)], ['PUT', /^offers\/(off_[\w-]{16})$/, upsertOffer], ['DELETE', /^offers\/(off_[\w-]{16})$/, (q, e, a, id) => deleteRow(q, e, a, 'offers', id)],
  ['GET', /^shop$/, shopList], ['POST', /^shop\/run$/, shopRun], ['PUT', /^shop\/queries\/(q_[a-z_]{2,30})$/, shopQuery],
  ['POST', /^shop\/products\/(prd_[\w-]{16})\/block$/, (q, e, a, id) => shopBlock(q, e, a, id, true)], ['POST', /^shop\/products\/(prd_[\w-]{16})\/unblock$/, (q, e, a, id) => shopBlock(q, e, a, id, false)],
  ['GET', /^markets$/, marketsList], ['POST', /^markets\/run$/, marketRun], ['PUT', /^markets\/([a-z0-9_]{2,30})$/, marketPut], ['PUT', /^market-keywords\/([a-z0-9_]{2,24})\/([a-z]{2,5})$/, keywordPut],
  ['GET', /^sponsors$/, sponsorsList], ['PUT', /^sponsors\/settings$/, sponsorSettings], ['POST', /^sponsors\/run$/, sponsorRun],
  ['GET', /^sponsors\/(spn_[\w-]{16})\/image$/, sponsorImg],
  ['POST', /^sponsors\/(spn_[\w-]{16})\/(remove|restore|recheck|extend)$/, sponsorSet],
  ['GET', /^health$/, health], ['POST', /^health\/run$/, healthRun],
  ['GET', /^admins$/, adminsList], ['PUT', /^admins$/, adminUpsert], ['POST', /^logout$/, logout],
];
export async function handleAdmin(req, env, sub) {
  if (sub === 'login' && req.method === 'POST') return login(req, env);
  const a = await authAdmin(env.DB, req);
  let mm = false;
  for (const [m, re, fn] of R) {
    const hit = re.exec(sub); if (!hit) continue;
    if (m !== req.method) { mm = true; continue; }
    return fn(req, env, a, hit[1], hit[2]);
  }
  throw new ApiError(mm ? 405 : 404, mm ? 'method_not_allowed' : 'not_found');
}
