// r14.15.80 · SOS between nearby Sea Scout users.
// Sender: POST /sos (kind + GPS) → keeps sending POST /sos/{id}/pos → POST /sos/{id}/close when safe.
// Helpers who switched on "receive SOS automatically" (PUT /sos/helper, with consent) poll POST /sos/nearby while the
// app is open; they may POST /sos/{id}/accept and then send their own position (POST /sos/{id}/hpos) which only the
// sender sees. Free-plan budget: helper positions are written at most every 2 min, sender fixes at most every 10 s,
// and /nearby answers from a 4 s per-area memory cache; with {wait} it long-polls (≤ 25 s, checks every 3 s).
import { ApiError, json, readJson, newId, country } from './util.js';
import { authenticate, audit, rateLimit } from './store.js';

export const KINDS = ['piw', 'boat_anchored', 'boat_drifting', 'unknown'];
const HOUR = 3600e3, EXPIRE = 12 * HOUR, RADIUS_KM = 50, MAX_RADIUS = 100;

export function distKm(a, b, c, d) {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
  return 6371 * Math.hypot(x, y);
}
function pos(b, req = true) {
  const lat = Number(b && b.lat), lon = Number(b && b.lon), acc = b && b.acc != null ? Number(b.acc) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { if (req) throw new ApiError(400, 'position_required'); return null; }
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, acc: Number.isFinite(acc) && acc >= 0 ? Math.min(acc, 50000) : null };
}
async function flagOn(db) { const f = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'sos'`).first(); return !f || !!f.enabled; }
async function expireOld(db, now) {
  await db.prepare(`UPDATE sos_alerts SET status = 'expired', closed_at = ?, close_reason = 'expired', updated_at = ? WHERE status = 'open' AND last_at < ?`).bind(now, now, now - EXPIRE).run();
}
const pub = (a) => ({ id: a.id, kind: a.kind, status: a.status, people: a.people, lat: a.last_lat, lon: a.last_lon, acc: a.last_acc, last_at: a.last_at,
  first: { lat: a.lat, lon: a.lon, acc: a.acc }, created_at: a.created_at, closed_at: a.closed_at, close_reason: a.close_reason });
async function mine(db, id, userId) {
  const a = await db.prepare('SELECT * FROM sos_alerts WHERE id = ?').bind(id).first();
  if (!a || a.user_id !== userId) throw new ApiError(404, 'not_found');
  return a;
}
let NEAR = new Map();   // per-isolate cache: area key → {at, rows}
export function dropSosCache() { NEAR = new Map(); }

// ---------- sender ----------
export async function create(req, env) {
  const db = env.DB, u = await authenticate(db, req);
  if (!(await flagOn(db))) throw new ApiError(503, 'sos_off');
  const b = await readJson(req), p = pos(b), now = Date.now();
  const kind = KINDS.includes(b.kind) ? b.kind : 'unknown';
  const people = Number.isInteger(b.people) && b.people > 0 && b.people < 100 ? b.people : null;
  await expireOld(db, now);
  const open = await db.prepare(`SELECT * FROM sos_alerts WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`).bind(u.user_id).first();
  if (open) {   // pressing SOS again updates the same alert (new kind/position), never a second one
    await db.prepare(`UPDATE sos_alerts SET kind = CASE WHEN ? = 'unknown' THEN kind ELSE ? END, people = COALESCE(?, people), last_lat = ?, last_lon = ?, last_acc = ?, last_at = ?, updated_at = ? WHERE id = ?`)
      .bind(kind, kind, people, p.lat, p.lon, p.acc, now, now, open.id).run();
    await db.prepare('INSERT OR IGNORE INTO sos_track (alert_id, at, lat, lon, acc) VALUES (?,?,?,?,?)').bind(open.id, now, p.lat, p.lon, p.acc).run();
    dropSosCache();
    return json(req, 200, { alert: pub(await mine(db, open.id, u.user_id)), again: true });
  }
  if (!(await rateLimit(db, 'sos:u:' + u.user_id, 2, 24 * HOUR))) throw new ApiError(429, 'too_many_requests');   // r14.15.83: 2 new SOS per account per 24 h (pressing again updates the open one)
  const id = newId('sos');
  await db.batch([
    db.prepare(`INSERT INTO sos_alerts (id, user_id, kind, people, lat, lon, acc, last_lat, last_lon, last_acc, last_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, u.user_id, kind, people, p.lat, p.lon, p.acc, p.lat, p.lon, p.acc, now, now, now),
    db.prepare('INSERT INTO sos_track (alert_id, at, lat, lon, acc) VALUES (?,?,?,?,?)').bind(id, now, p.lat, p.lon, p.acc),
  ]);
  await audit(db, 'user', u.user_id, 'sos_create', id, { kind }, country(req));
  dropSosCache();
  const helpers = await countHelpers(db, p, now);
  return json(req, 201, { alert: pub(await mine(db, id, u.user_id)), helpers_nearby: helpers });
}
async function countHelpers(db, p, now) {
  const dLat = MAX_RADIUS / 111;
  const { results } = await db.prepare(`SELECT lat, lon, radius_km FROM sos_helpers WHERE enabled = 1 AND lat BETWEEN ? AND ? AND at > ?`).bind(p.lat - dLat, p.lat + dLat, now - 6 * HOUR).all();
  return results.filter((h) => distKm(p.lat, p.lon, h.lat, h.lon) <= (h.radius_km || RADIUS_KM)).length;
}
export async function update(req, env, id) {
  const db = env.DB, u = await authenticate(db, req), a = await mine(db, id, u.user_id);
  if (a.status !== 'open') throw new ApiError(409, 'closed');
  const b = await readJson(req), p = pos(b), now = Date.now();
  const kind = KINDS.includes(b.kind) && b.kind !== 'unknown' ? b.kind : a.kind;
  await db.prepare(`UPDATE sos_alerts SET kind = ?, last_lat = ?, last_lon = ?, last_acc = ?, last_at = ?, updated_at = ? WHERE id = ?`).bind(kind, p.lat, p.lon, p.acc, now, now, id).run();
  const last = await db.prepare('SELECT MAX(at) AS t FROM sos_track WHERE alert_id = ?').bind(id).first();
  if (!last || !last.t || now - last.t >= 10e3) await db.prepare('INSERT OR IGNORE INTO sos_track (alert_id, at, lat, lon, acc) VALUES (?,?,?,?,?)').bind(id, now, p.lat, p.lon, p.acc).run();
  return status(req, env, id, u);
}
export async function close(req, env, id) {
  const db = env.DB, u = await authenticate(db, req), a = await mine(db, id, u.user_id), b = await readJson(req), now = Date.now();
  const reason = ['safe', 'cancel', 'rescued'].includes(b.reason) ? b.reason : 'safe';
  if (a.status === 'open') await db.prepare(`UPDATE sos_alerts SET status = 'closed', closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?`).bind(now, reason, now, id).run();
  await audit(db, 'user', u.user_id, 'sos_close', id, { reason }, country(req));
  dropSosCache();
  return json(req, 200, { ok: true });
}
// sender's own view: helpers who accepted, with their last position and distance
export async function status(req, env, id, auth) {
  const db = env.DB, u = auth || (await authenticate(db, req)), a = await mine(db, id, u.user_id), now = Date.now();
  const { results } = await db.prepare(`SELECT lat, lon, at, speed_kn, accepted_at FROM sos_responses WHERE alert_id = ? AND left_at IS NULL ORDER BY accepted_at`).bind(id).all();
  const helpers = results.map((h, i) => {
    const d = h.lat != null ? distKm(a.last_lat, a.last_lon, h.lat, h.lon) : null, kn = h.speed_kn || null;
    return { n: i + 1, lat: h.lat, lon: h.lon, at: h.at, accepted_at: h.accepted_at, km: d != null ? Math.round(d * 10) / 10 : null,
      eta_min: d != null && kn ? Math.round(d / (kn * 1.852) * 60) : null };
  });
  return json(req, 200, { alert: pub(a), helpers, helpers_nearby: a.status === 'open' ? await countHelpers(db, { lat: a.last_lat, lon: a.last_lon }, now) : 0 });
}
export async function myOpen(req, env) {
  const db = env.DB, u = await authenticate(db, req);
  await expireOld(db, Date.now());
  const a = await db.prepare(`SELECT id FROM sos_alerts WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`).bind(u.user_id).first();
  if (!a) return json(req, 200, { alert: null });
  return status(req, env, a.id, u);
}

// ---------- helpers ----------
export async function helper(req, env) {
  const db = env.DB, u = await authenticate(db, req), b = await readJson(req), now = Date.now();
  const on = b.enabled === true;
  if (on && b.consent !== true) throw new ApiError(400, 'consent_required');
  const p = pos(b, false), radius = Math.max(5, Math.min(MAX_RADIUS, Number(b.radius_km) || RADIUS_KM));
  await db.prepare(`INSERT INTO sos_helpers (user_id, enabled, consent_at, radius_km, lat, lon, at, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, consent_at = COALESCE(excluded.consent_at, sos_helpers.consent_at), radius_km = excluded.radius_km,
      lat = COALESCE(excluded.lat, sos_helpers.lat), lon = COALESCE(excluded.lon, sos_helpers.lon), at = COALESCE(excluded.at, sos_helpers.at), updated_at = excluded.updated_at`)
    .bind(u.user_id, on ? 1 : 0, on ? now : null, radius, p ? p.lat : null, p ? p.lon : null, p ? now : null, now).run();
  await audit(db, 'user', u.user_id, on ? 'sos_helper_on' : 'sos_helper_off', null, { radius }, country(req));
  return json(req, 200, { enabled: on, radius_km: radius });
}
// helper heartbeat: open alerts near me (my own excluded); also stores my position (throttled)
export async function nearby(req, env) {
  const db = env.DB, u = await authenticate(db, req), b = await readJson(req), p = pos(b), now = Date.now();
  if (!(await flagOn(db))) return json(req, 200, { alerts: [], off: true });
  const h = await db.prepare('SELECT enabled, radius_km, at, lat, lon FROM sos_helpers WHERE user_id = ?').bind(u.user_id).first();
  if (!h || !h.enabled) throw new ApiError(403, 'not_helper');
  if (!h.at || now - h.at > 120e3 || distKm(h.lat || 0, h.lon || 0, p.lat, p.lon) > 1) {
    await db.prepare('UPDATE sos_helpers SET lat = ?, lon = ?, at = ?, updated_at = ? WHERE user_id = ?').bind(p.lat, p.lon, now, now, u.user_id).run();
  }
  const key = Math.round(p.lat) + ',' + Math.round(p.lon), radius = h.radius_km || RADIUS_KM, dLat = MAX_RADIUS / 111 + 1;
  // r14.15.83: long-poll — with {wait} (≤ 25 s) and {known: ids the app already has}, the request stays open and checks
  // the open alerts every 3 s (indexed, usually 0 rows) and answers at once when something new appears. One request per
  // ~25 s instead of one every 8 s, and a new SOS still arrives within ~3 s.
  const wait = Math.max(0, Math.min(25, Number(b.wait) || 0)) * 1000, known = new Set(Array.isArray(b.known) ? b.known.slice(0, 50).map(String) : []);
  const near = (list) => list.filter((a) => a.user_id !== u.user_id && distKm(p.lat, p.lon, a.last_lat, a.last_lon) <= radius);
  const load = async () => { const { results } = await db.prepare(`SELECT * FROM sos_alerts WHERE status = 'open' AND last_lat BETWEEN ? AND ?`).bind(p.lat - dLat, p.lat + dLat).all(); const c = { at: Date.now(), rows: results }; NEAR.set(key, c); if (NEAR.size > 200) NEAR.delete(NEAR.keys().next().value); return c; };
  let hit = NEAR.get(key);
  if (!hit || now - hit.at > 4e3) { await expireOld(db, now); hit = await load(); }   // 4 s per-area cache
  let rows = near(hit.rows);
  if (wait && !rows.some((a) => !known.has(a.id))) {
    const until = now + wait;
    while (Date.now() < until - 500) {
      await new Promise((r) => setTimeout(r, Math.min(3000, until - Date.now())));
      const c = NEAR.get(key);
      rows = near(c && Date.now() - c.at <= 3e3 ? c.rows : (await load()).rows);
      if (rows.some((a) => !known.has(a.id))) break;
    }
  }
  const mineAcc = rows.length ? (await db.prepare(`SELECT alert_id, left_at FROM sos_responses WHERE user_id = ? AND alert_id IN (${rows.map(() => '?').join(',')})`).bind(u.user_id, ...rows.map((a) => a.id)).all()).results : [];
  const acc = new Map(mineAcc.map((r) => [r.alert_id, r]));
  const counts = rows.length ? (await db.prepare(`SELECT alert_id, COUNT(*) AS n FROM sos_responses WHERE left_at IS NULL AND alert_id IN (${rows.map(() => '?').join(',')}) GROUP BY alert_id`).bind(...rows.map((a) => a.id)).all()).results : [];
  const cnt = new Map(counts.map((r) => [r.alert_id, r.n]));
  const alerts = rows.map((a) => ({ ...pub(a), km: Math.round(distKm(p.lat, p.lon, a.last_lat, a.last_lon) * 10) / 10, responders: cnt.get(a.id) || 0,
    accepted: acc.has(a.id) && !acc.get(a.id).left_at, declined: acc.has(a.id) && !!acc.get(a.id).left_at })).sort((x, y) => x.km - y.km);
  return json(req, 200, { alerts, radius_km: radius, at: now });
}
async function openAlert(db, id) {
  const a = await db.prepare('SELECT * FROM sos_alerts WHERE id = ?').bind(id).first();
  if (!a) throw new ApiError(404, 'not_found');
  return a;
}
export async function accept(req, env, id) {
  const db = env.DB, u = await authenticate(db, req), a = await openAlert(db, id), b = await readJson(req), now = Date.now();
  if (a.status !== 'open') throw new ApiError(409, 'closed');
  if (a.user_id === u.user_id) throw new ApiError(400, 'own_alert');
  const h = await db.prepare('SELECT enabled FROM sos_helpers WHERE user_id = ?').bind(u.user_id).first();
  if (!h || !h.enabled) throw new ApiError(403, 'not_helper');
  const p = pos(b, false), kn = Number(b.speed_kn) > 0 && Number(b.speed_kn) < 80 ? Number(b.speed_kn) : null;
  await db.prepare(`INSERT INTO sos_responses (alert_id, user_id, accepted_at, lat, lon, at, speed_kn) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(alert_id, user_id) DO UPDATE SET left_at = NULL, outcome = NULL, accepted_at = excluded.accepted_at, lat = COALESCE(excluded.lat, sos_responses.lat), lon = COALESCE(excluded.lon, sos_responses.lon), at = COALESCE(excluded.at, sos_responses.at), speed_kn = COALESCE(excluded.speed_kn, sos_responses.speed_kn)`)
    .bind(id, u.user_id, now, p ? p.lat : null, p ? p.lon : null, p ? now : null, kn).run();
  await audit(db, 'user', u.user_id, 'sos_accept', id, null, country(req));
  return detail(req, env, id, u);
}
export async function decline(req, env, id) {
  const db = env.DB, u = await authenticate(db, req), b = await readJson(req), now = Date.now();
  await openAlert(db, id);
  const r = await db.prepare('SELECT left_at FROM sos_responses WHERE alert_id = ? AND user_id = ?').bind(id, u.user_id).first();
  const outcome = r && !r.left_at ? (b.outcome === 'found' ? 'found' : 'gave_up') : 'declined';
  await db.prepare(`INSERT INTO sos_responses (alert_id, user_id, accepted_at, left_at, outcome) VALUES (?,?,?,?,?)
    ON CONFLICT(alert_id, user_id) DO UPDATE SET left_at = excluded.left_at, outcome = excluded.outcome`).bind(id, u.user_id, now, now, outcome).run();
  if (outcome !== 'declined') await audit(db, 'user', u.user_id, 'sos_leave', id, { outcome }, country(req));
  return json(req, 200, { ok: true, outcome });
}
export async function helperPos(req, env, id) {
  const db = env.DB, u = await authenticate(db, req), b = await readJson(req), p = pos(b), now = Date.now();
  const r = await db.prepare('SELECT at, lat, lon FROM sos_responses WHERE alert_id = ? AND user_id = ? AND left_at IS NULL').bind(id, u.user_id).first();
  if (!r) throw new ApiError(403, 'not_accepted');
  const kn = Number(b.speed_kn) > 0 && Number(b.speed_kn) < 80 ? Number(b.speed_kn) : null;
  if (!r.at || now - r.at >= 20e3 || (kn != null)) await db.prepare('UPDATE sos_responses SET lat = ?, lon = ?, at = ?, speed_kn = COALESCE(?, speed_kn) WHERE alert_id = ? AND user_id = ?').bind(p.lat, p.lon, now, kn, id, u.user_id).run();
  return detail(req, env, id, u);
}
// accepted helper's view: alert + the sender's recent track (to predict drift); no other helper positions
export async function detail(req, env, id, auth) {
  const db = env.DB, u = auth || (await authenticate(db, req)), a = await openAlert(db, id);
  if (a.user_id !== u.user_id) {
    const r = await db.prepare('SELECT left_at FROM sos_responses WHERE alert_id = ? AND user_id = ?').bind(id, u.user_id).first();
    if (!r || r.left_at) throw new ApiError(403, 'not_accepted');
  }
  const { results } = await db.prepare('SELECT at, lat, lon, acc FROM sos_track WHERE alert_id = ? ORDER BY at DESC LIMIT 120').bind(id).all();
  const n = await db.prepare('SELECT COUNT(*) AS n FROM sos_responses WHERE alert_id = ? AND left_at IS NULL').bind(id).first();
  return json(req, 200, { alert: pub(a), track: results.reverse(), responders: n ? n.n : 0, now: Date.now() });
}

// cron: expire old alerts, drop tracks of alerts closed more than 7 days ago
export async function sosTick(env) {
  const db = env.DB, now = Date.now();
  await expireOld(db, now);
  const r = await db.prepare(`DELETE FROM sos_track WHERE alert_id IN (SELECT id FROM sos_alerts WHERE status <> 'open' AND closed_at < ?)`).bind(now - 7 * 24 * HOUR).run();
  return { pruned: r.meta ? r.meta.changes : 0 };
}
