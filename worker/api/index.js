// Sea Scout API v1 — central membership for Android, iOS and the admin dashboard.
// Mounted under /api/v1/ by worker/site.js. Until a D1 database is bound as `DB`, every route except
// /health answers 503 "backend_not_configured" — nothing else on the site changes.
import { ApiError, VERSION, LOCALES, PLATFORMS, json, readJson, corsHeaders, cleanEmail, checkPassword, str,
  hashPassword, safeEqual, newId, clientIp, country, sha256 } from './util.js';
import { audit, rateLimit, upsertDevice, createSession, authenticate, rotateRefresh, entitlementsFor } from './store.js';
import { socialSignIn } from './social.js';
import { forgot, reset, verifyRequest, verifyConfirm } from './email.js';
import { googleVerify, googleNotify, appleVerify, appleNotify, billingTokens } from './billing.js';
import { items as commerceItems, go as commerceGo } from './commerce.js';
import { handleAdmin } from './admin.js';

import { PRIVACY_VERSION_RE, deviceFrom, meBody } from './common.js';

// ---------- handlers ----------
async function register(req, env) {
  const db = env.DB, ip = clientIp(req), b = await readJson(req);
  if (!(await rateLimit(db, 'reg:ip:' + (await sha256(ip)), 10, 3600e3))) throw new ApiError(429, 'too_many_requests');
  const email = cleanEmail(b.email), password = checkPassword(b.password);
  if (b.privacy_consent !== true) throw new ApiError(400, 'privacy_consent_required');
  const pv = str(b.privacy_version, 20) || '1';
  if (!PRIVACY_VERSION_RE.test(pv)) throw new ApiError(400, 'invalid_privacy_version');
  const locale = LOCALES.includes(b.locale) ? b.locale : null;
  const dev = deviceFrom(b);
  const exists = await db.prepare(`SELECT 1 FROM users WHERE email = ? AND status <> 'deleted'`).bind(email).first();
  if (exists) throw new ApiError(409, 'email_taken');
  const now = Date.now(), id = newId('usr'), pw = await hashPassword(password);
  try {
    await db.batch([
      db.prepare('INSERT INTO users (id, email, password_hash, password_salt, password_iter, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, email, pw.hash, pw.salt, pw.iter, now, now),
      db.prepare('INSERT INTO user_profiles (user_id, locale, country, privacy_consent_at, privacy_version, marketing_consent, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, locale, country(req), now, pv, b.marketing_consent === true ? 1 : 0, now),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new ApiError(409, 'email_taken');
    throw e;
  }
  const deviceId = await upsertDevice(db, id, dev);
  const tokens = await createSession(db, id, deviceId, req);
  await audit(db, 'user', id, 'register', null, { platform: dev && dev.platform }, country(req));
  return json(req, 201, { ...tokens, ...(await meBody(db, id)) });
}

async function login(req, env) {
  const db = env.DB, ip = clientIp(req), b = await readJson(req);
  const email = cleanEmail(b.email);
  const password = String(b.password || '');
  const ipKey = 'login:ip:' + (await sha256(ip)), emKey = 'login:em:' + (await sha256(email));
  if (!(await rateLimit(db, ipKey, 30, 900e3)) || !(await rateLimit(db, emKey, 10, 900e3))) throw new ApiError(429, 'too_many_requests');
  const dev = deviceFrom(b);
  const u = await db.prepare(`SELECT id, status, password_hash, password_salt, password_iter FROM users WHERE email = ? AND status <> 'deleted'`).bind(email).first();
  // Same work and the same answer whether or not the account exists.
  const check = await hashPassword(password || 'x', u && u.password_salt ? u.password_salt : 'AAAAAAAAAAAAAAAAAAAAAA==', u && u.password_iter ? u.password_iter : undefined);
  const ok = !!(u && u.password_hash && safeEqual(check.hash, u.password_hash));
  if (!ok) { if (u) await audit(db, 'user', u.id, 'login_fail', null, null, country(req)); throw new ApiError(401, 'invalid_credentials'); }
  if (u.status !== 'active') throw new ApiError(403, 'account_disabled');
  const deviceId = await upsertDevice(db, u.id, dev);
  const tokens = await createSession(db, u.id, deviceId, req);
  await audit(db, 'user', u.id, 'login', null, { platform: dev && dev.platform }, country(req));
  return json(req, 200, { ...tokens, ...(await meBody(db, u.id)) });
}

async function refresh(req, env) {
  const b = await readJson(req);
  const r = await rotateRefresh(env.DB, b.refresh_token, req);
  return json(req, 200, r.tokens);
}

async function logout(req, env) {
  const db = env.DB, a = await authenticate(db, req), now = Date.now();
  const all = new URL(req.url).searchParams.get('all') === '1';
  if (all) await db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='logout_all' WHERE user_id=? AND revoked_at IS NULL`).bind(now, a.user_id).run();
  else await db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='logout' WHERE id=?`).bind(now, a.sid).run();
  if (all) await audit(db, 'user', a.user_id, 'logout_all', null, null, country(req));
  return json(req, 200, { ok: true });
}

async function me(req, env) {
  const a = await authenticate(env.DB, req);
  return json(req, 200, await meBody(env.DB, a.user_id));
}

async function entitlements(req, env) {
  const a = await authenticate(env.DB, req);
  return json(req, 200, await entitlementsFor(env.DB, a.user_id));
}

async function patchProfile(req, env) {
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req), set = [], val = [];
  if ('display_name' in b) { set.push('display_name=?'); val.push(str(b.display_name, 60)); }
  if ('locale' in b) { if (b.locale !== null && !LOCALES.includes(b.locale)) throw new ApiError(400, 'invalid_locale'); set.push('locale=?'); val.push(b.locale); }
  if ('country' in b) { if (b.country !== null && !/^[A-Z]{2}$/.test(b.country)) throw new ApiError(400, 'invalid_country'); set.push('country=?'); val.push(b.country); }
  if ('units' in b) { set.push('units=?'); val.push(str(b.units, 20)); }
  if ('marketing_consent' in b) { if (typeof b.marketing_consent !== 'boolean') throw new ApiError(400, 'invalid_marketing_consent'); set.push('marketing_consent=?'); val.push(b.marketing_consent ? 1 : 0); }
  if (!set.length) throw new ApiError(400, 'nothing_to_update');
  set.push('updated_at=?'); val.push(Date.now());
  await db.prepare(`UPDATE user_profiles SET ${set.join(', ')} WHERE user_id = ?`).bind(...val, a.user_id).run();
  return json(req, 200, await meBody(db, a.user_id));
}

async function changePassword(req, env) {
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req);
  if (!(await rateLimit(db, 'pw:' + a.user_id, 10, 900e3))) throw new ApiError(429, 'too_many_requests');
  const u = await db.prepare('SELECT password_hash, password_salt, password_iter FROM users WHERE id = ?').bind(a.user_id).first();
  if (u.password_hash) {
    const c = await hashPassword(String(b.current_password || ''), u.password_salt, u.password_iter);
    if (!safeEqual(c.hash, u.password_hash)) throw new ApiError(401, 'invalid_credentials');
  }
  const pw = await hashPassword(checkPassword(b.new_password)), now = Date.now();
  await db.batch([
    db.prepare('UPDATE users SET password_hash=?, password_salt=?, password_iter=?, updated_at=? WHERE id=?').bind(pw.hash, pw.salt, pw.iter, now, a.user_id),
    db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='password_change' WHERE user_id=? AND id<>? AND revoked_at IS NULL`).bind(now, a.user_id, a.sid),
  ]);
  await audit(db, 'user', a.user_id, 'password_change', null, null, country(req));
  return json(req, 200, { ok: true, other_sessions_signed_out: true });
}

async function listDevices(req, env) {
  const db = env.DB, a = await authenticate(db, req);
  const { results } = await db.prepare(
    `SELECT d.id, d.platform, d.model, d.app_version, d.created_at, d.last_seen_at,
            EXISTS(SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL) AS signed_in
     FROM devices d WHERE d.user_id = ? ORDER BY d.last_seen_at DESC`).bind(a.user_id).all();
  return json(req, 200, { devices: results.map((d) => ({ ...d, signed_in: !!d.signed_in, current: d.id === a.device_id })) });
}

async function removeDevice(req, env, id) {
  const db = env.DB, a = await authenticate(db, req), now = Date.now();
  const d = await db.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?').bind(id, a.user_id).first();
  if (!d) throw new ApiError(404, 'not_found');
  await db.batch([
    db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='device_removed' WHERE device_id=? AND revoked_at IS NULL`).bind(now, id),
    db.prepare('DELETE FROM devices WHERE id = ?').bind(id),
  ]);
  await audit(db, 'user', a.user_id, 'device_remove', id, null, country(req));
  return json(req, 200, { ok: true });
}

async function registerDevice(req, env) {
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req);
  const dev = deviceFrom({ device: b });
  const id = await upsertDevice(db, a.user_id, dev);
  await db.prepare('UPDATE sessions SET device_id = ? WHERE id = ?').bind(id, a.sid).run();
  return json(req, 200, { device_id: id });
}

// Account deletion (store policies require it in-app). Personal data is removed; billing records stay for accounting.
async function deleteAccount(req, env) {
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req);
  if (a.password_hash) {
    const u = await db.prepare('SELECT password_hash, password_salt, password_iter FROM users WHERE id = ?').bind(a.user_id).first();
    const c = await hashPassword(String(b.password || ''), u.password_salt, u.password_iter);
    if (!safeEqual(c.hash, u.password_hash)) throw new ApiError(401, 'invalid_credentials');
  } else if (b.confirm !== 'DELETE') throw new ApiError(400, 'confirmation_required');
  const now = Date.now(), uid = a.user_id;
  await db.batch([
    db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='account_deleted' WHERE user_id=? AND revoked_at IS NULL`).bind(now, uid),
    db.prepare(`UPDATE users SET email=?, email_verified=0, password_hash=NULL, password_salt=NULL, password_iter=NULL, status='deleted', deleted_at=?, updated_at=? WHERE id=?`)
      .bind('deleted+' + uid + '@invalid', now, now, uid),
    db.prepare('DELETE FROM user_profiles WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM identities WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM devices WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM entitlements WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(uid),
  ]);
  await audit(db, 'user', uid, 'account_delete', null, null, country(req));
  return json(req, 200, { ok: true, deleted: true });
}

async function flags(req, env) {
  const { results } = await env.DB.prepare('SELECT key, enabled, rollout_pct FROM feature_flags').all();
  const out = {};
  for (const f of results) out[f.key] = { enabled: !!f.enabled, rollout_pct: f.rollout_pct };
  return json(req, 200, { flags: out }, { 'Cache-Control': 'public, max-age=60' });
}


// ---------- router ----------
const ROUTES = [
  ['POST', /^\/api\/v1\/auth\/register$/, register],
  ['POST', /^\/api\/v1\/auth\/login$/, login],
  ['POST', /^\/api\/v1\/auth\/refresh$/, refresh],
  ['POST', /^\/api\/v1\/auth\/logout$/, logout],
  ['POST', /^\/api\/v1\/auth\/google$/, socialSignIn('google')],
  ['POST', /^\/api\/v1\/auth\/apple$/, socialSignIn('apple')],
  ['POST', /^\/api\/v1\/auth\/password\/forgot$/, forgot],
  ['POST', /^\/api\/v1\/auth\/password\/reset$/, reset],
  ['POST', /^\/api\/v1\/auth\/email\/verify\/request$/, verifyRequest],
  ['POST', /^\/api\/v1\/auth\/email\/verify$/, verifyConfirm],
  ['GET', /^\/api\/v1\/me$/, me],
  ['PATCH', /^\/api\/v1\/me\/profile$/, patchProfile],
  ['POST', /^\/api\/v1\/me\/password$/, changePassword],
  ['GET', /^\/api\/v1\/me\/entitlements$/, entitlements],
  ['GET', /^\/api\/v1\/me\/devices$/, listDevices],
  ['POST', /^\/api\/v1\/me\/devices$/, registerDevice],
  ['DELETE', /^\/api\/v1\/me\/devices\/(dev_[A-Za-z0-9_-]{16})$/, removeDevice],
  ['DELETE', /^\/api\/v1\/me$/, deleteAccount],
  ['POST', /^\/api\/v1\/billing\/google\/verify$/, googleVerify],
  ['POST', /^\/api\/v1\/billing\/google\/notify$/, googleNotify],
  ['POST', /^\/api\/v1\/billing\/apple\/verify$/, appleVerify],
  ['POST', /^\/api\/v1\/billing\/apple\/notify$/, appleNotify],
  ['GET', /^\/api\/v1\/billing\/account-tokens$/, billingTokens],
  ['GET', /^\/api\/v1\/commerce\/items$/, commerceItems],
  ['GET', /^\/api\/v1\/go\/(off_[A-Za-z0-9_-]{16})$/, commerceGo],
  ['GET', /^\/api\/v1\/flags$/, flags],
];

function errorResponse(request, url, e) {
  if (e instanceof ApiError) return json(request, e.status, { error: e.code, ...(e.message !== e.code ? { message: e.message } : {}) });
  console.log(JSON.stringify({ seascout: 'api_error', path: url.pathname, err: String(e && e.stack || e).slice(0, 800) }));
  return json(request, 500, { error: 'server_error' });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (url.pathname === '/api/v1/health') return json(request, 200, { ok: true, version: VERSION, db: !!env.DB, time: Date.now() });
  if (!env.DB) return json(request, 503, { error: 'backend_not_configured' });
  if (url.pathname.startsWith('/api/v1/admin/')) {
    try { return await handleAdmin(request, env, url.pathname.slice('/api/v1/admin/'.length)); }
    catch (e) { return errorResponse(request, url, e); }
  }
  let methodMismatch = false;
  for (const [m, re, fn] of ROUTES) {
    const hit = re.exec(url.pathname);
    if (!hit) continue;
    if (m !== request.method) { methodMismatch = true; continue; }
    try { return await fn(request, env, hit[1]); }
    catch (e) { return errorResponse(request, url, e); }
  }
  return json(request, methodMismatch ? 405 : 404, { error: methodMismatch ? 'method_not_allowed' : 'not_found' });
}
