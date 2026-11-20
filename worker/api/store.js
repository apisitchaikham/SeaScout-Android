// Sea Scout API v1 — database access (D1). Every query is parameterised (no string-built SQL with user input).
import { ApiError, newId, sha256, randomToken, ACCESS_TTL, REFRESH_TTL } from './util.js';

export async function audit(db, actorType, actorId, action, target, details, country) {
  try {
    await db.prepare('INSERT INTO audit_logs (id, at, actor_type, actor_id, action, target, details, country) VALUES (?,?,?,?,?,?,?,?)')
      .bind(newId('aud'), Date.now(), actorType, actorId || null, action, target || null, details ? JSON.stringify(details) : null, country || null).run();
  } catch (e) { console.log(JSON.stringify({ seascout: 'audit_fail', action, err: String(e) })); }
}

// Fixed-window counter. Returns true when the call is allowed.
export async function rateLimit(db, key, limit, windowMs) {
  const now = Date.now(), start = now - (now % windowMs);
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END, window_start = ?2
     RETURNING count`).bind(key, start).first();
  return (row ? row.count : 1) <= limit;
}

export async function upsertDevice(db, userId, d) {
  if (!d || !d.install_id) return null;
  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO devices (id, user_id, install_id, platform, model, app_version, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, install_id) DO UPDATE SET platform=excluded.platform, model=excluded.model, app_version=excluded.app_version, last_seen_at=excluded.last_seen_at
     RETURNING id`).bind(newId('dev'), userId, d.install_id, d.platform, d.model, d.app_version, now, now).first();
  return row ? row.id : null;
}

export async function createSession(db, userId, deviceId, request, familyId) {
  const now = Date.now(), access = randomToken(32), refresh = randomToken(32), id = newId('ses');
  await db.prepare(
    `INSERT INTO sessions (id, user_id, device_id, family_id, access_hash, access_exp, refresh_hash, refresh_exp, created_at, last_used_at, user_agent, country)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, userId, deviceId || null, familyId || newId('fam'), await sha256(access), now + ACCESS_TTL, await sha256(refresh), now + REFRESH_TTL,
    now, now, (request.headers.get('User-Agent') || '').slice(0, 200), (request.cf && request.cf.country) || null).run();
  return { session_id: id, access_token: access, access_expires_at: now + ACCESS_TTL, refresh_token: refresh, refresh_expires_at: now + REFRESH_TTL, token_type: 'Bearer' };
}

// Bearer access token -> { session, user }
export async function authenticate(db, request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h);
  if (!m) throw new ApiError(401, 'unauthorized');
  const row = await db.prepare(
    `SELECT s.id AS sid, s.user_id, s.device_id, s.family_id, s.access_exp, s.last_used_at, u.email, u.email_verified, u.status, u.created_at, u.password_hash
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.access_hash = ? AND s.revoked_at IS NULL`).bind(await sha256(m[1])).first();
  if (!row || row.access_exp < Date.now()) throw new ApiError(401, 'unauthorized');
  if (row.status !== 'active') throw new ApiError(403, 'account_disabled');
  // r14.15.67: write "last used" at most once an hour per session (D1 free plan: 100k row writes/day)
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 3600e3) await db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').bind(now, row.sid).run();
  return row;
}

export async function rotateRefresh(db, refreshToken, request) {
  if (typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(refreshToken)) throw new ApiError(401, 'invalid_refresh');
  const h = await sha256(refreshToken), now = Date.now();
  const s = await db.prepare(
    `SELECT s.*, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash = ?`).bind(h).first();
  if (!s) {
    // A refresh token that was already rotated away is being used again: treat the whole family as stolen.
    const used = await db.prepare('SELECT family_id FROM used_refresh WHERE refresh_hash = ?').bind(h).first();
    if (used) {
      await db.prepare(`UPDATE sessions SET revoked_at = ?, revoke_reason = 'refresh_reuse' WHERE family_id = ? AND revoked_at IS NULL`).bind(now, used.family_id).run();
      await audit(db, 'system', null, 'refresh_reuse_detected', used.family_id, null, request.cf && request.cf.country);
    }
    throw new ApiError(401, 'invalid_refresh');
  }
  if (s.revoked_at || s.refresh_exp < now || s.status !== 'active') throw new ApiError(401, 'invalid_refresh');
  const access = randomToken(32), refresh = randomToken(32);
  await db.batch([
    db.prepare('INSERT INTO used_refresh (refresh_hash, family_id, used_at) VALUES (?,?,?)').bind(h, s.family_id, now),
    db.prepare('UPDATE sessions SET access_hash=?, access_exp=?, refresh_hash=?, refresh_exp=?, last_used_at=? WHERE id=?')
      .bind(await sha256(access), now + ACCESS_TTL, await sha256(refresh), now + REFRESH_TTL, now, s.id),
  ]);
  return { user_id: s.user_id, tokens: { session_id: s.id, access_token: access, access_expires_at: now + ACCESS_TTL, refresh_token: refresh, refresh_expires_at: now + REFRESH_TTL, token_type: 'Bearer' } };
}

// Plan + entitlements the server grants (the app must not decide this on its own).
export async function entitlementsFor(db, userId) {
  const now = Date.now();
  const sub = await db.prepare(
    `SELECT s.plan_id, s.source, s.status, s.expires_at, s.auto_renew, p.rank FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.status IN ('active','grace') AND (s.expires_at IS NULL OR s.expires_at > ?)
     ORDER BY p.rank DESC, s.expires_at DESC LIMIT 1`).bind(userId, now).first();
  const plan = sub ? sub.plan_id : 'free';
  const { results } = await db.prepare('SELECT key, value FROM plan_entitlements WHERE plan_id = ?').bind(plan).all();
  const ent = {};
  for (const r of results) ent[r.key] = JSON.parse(r.value);
  const over = await db.prepare('SELECT key, value FROM entitlements WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').bind(userId, now).all();
  for (const r of over.results) ent[r.key] = JSON.parse(r.value);
  return {
    plan,
    subscription: sub ? { source: sub.source, status: sub.status, expires_at: sub.expires_at, auto_renew: !!sub.auto_renew } : null,
    entitlements: ent,
    checked_at: now,
  };
}
