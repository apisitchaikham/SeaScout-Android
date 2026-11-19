// Sea Scout API v1 — email verification and password reset with 8-character codes typed in the app
// (no web pages needed). Sending uses Resend's HTTP API when RESEND_API_KEY + EMAIL_FROM are set.
import { ApiError, json, readJson, cleanEmail, checkPassword, hashPassword, sha256, clientIp, country } from './util.js';
import { audit, rateLimit, authenticate } from './store.js';

const CODE_TTL = 30 * 60 * 1000, ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const configured = (env) => !!(env.RESEND_API_KEY && env.EMAIL_FROM);
const off = (req) => json(req, 503, { error: 'email_not_configured', message: 'Not configured on the server yet' });
function newCode() { const a = crypto.getRandomValues(new Uint8Array(8)); return [...a].map((x) => ALPH[x % ALPH.length]).join(''); }
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

const TEXT = {
  th: { verify: ['ยืนยันอีเมล Sea Scout', 'รหัสยืนยันอีเมลของคุณ'], reset: ['รีเซ็ตรหัสผ่าน Sea Scout', 'รหัสสำหรับตั้งรหัสผ่านใหม่'], tail: 'รหัสใช้ได้ 30 นาที · ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร' },
  en: { verify: ['Confirm your Sea Scout email', 'Your email confirmation code'], reset: ['Reset your Sea Scout password', 'Your password reset code'], tail: 'The code works for 30 minutes. If you did not ask for it, ignore this email.' },
};
async function send(env, to, purpose, code, lang) {
  const t = TEXT[lang === 'th' ? 'th' : 'en'], [subject, lead] = t[purpose];
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px"><h2 style="color:#0b84a5">Sea Scout</h2><p>${lead}</p><p style="font-size:28px;letter-spacing:4px;font-weight:700">${code.slice(0, 4)}-${code.slice(4)}</p><p style="color:#666">${t.tail}</p></div>`;
  const r = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text: `${lead}: ${code}\n${t.tail}` }),
  });
  if (!r.ok) { console.log(JSON.stringify({ seascout: 'email_send_fail', status: r.status })); throw new ApiError(502, 'email_send_failed'); }
}
async function issue(db, env, userId, email, purpose, lang) {
  const code = newCode(), now = Date.now();
  await db.batch([
    db.prepare('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(now, userId, purpose),
    db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?,?,?,?,?)').bind(await sha256(purpose + ':' + userId + ':' + code), userId, purpose, now + CODE_TTL, now),
  ]);
  await send(env, email, purpose, code, lang);
}
async function consume(db, userId, purpose, code) {
  const h = await sha256(purpose + ':' + userId + ':' + normCode(code)), now = Date.now();
  const row = await db.prepare('SELECT token_hash FROM email_tokens WHERE token_hash = ? AND user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?').bind(h, userId, purpose, now).first();
  if (!row) return false;
  await db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').bind(now, h).run();
  return true;
}

// POST /auth/password/forgot {email, lang?} — always 202 so nobody can probe which emails have accounts
export async function forgot(req, env) {
  if (!configured(env)) return off(req);
  const db = env.DB, b = await readJson(req), email = cleanEmail(b.email);
  const okIp = await rateLimit(db, 'forgot:ip:' + (await sha256(clientIp(req))), 10, 3600e3);
  const okEm = await rateLimit(db, 'forgot:em:' + (await sha256(email)), 3, 3600e3);
  if (okIp && okEm) {
    const u = await db.prepare(`SELECT u.id, p.locale FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.email = ? AND u.status = 'active'`).bind(email).first();
    if (u) { await issue(db, env, u.id, email, 'reset', b.lang || u.locale); await audit(db, 'user', u.id, 'password_reset_requested', null, null, country(req)); }
  }
  return json(req, 202, { ok: true });
}
// POST /auth/password/reset {email, code, new_password}
export async function reset(req, env) {
  if (!configured(env)) return off(req);
  const db = env.DB, b = await readJson(req), email = cleanEmail(b.email);
  if (!(await rateLimit(db, 'reset:em:' + (await sha256(email)), 10, 3600e3))) throw new ApiError(429, 'too_many_requests');
  const pw = checkPassword(b.new_password);
  const u = await db.prepare(`SELECT id FROM users WHERE email = ? AND status = 'active'`).bind(email).first();
  if (!u || !(await consume(db, u.id, 'reset', b.code))) throw new ApiError(400, 'invalid_code');
  const h = await hashPassword(pw), now = Date.now();
  await db.batch([
    db.prepare('UPDATE users SET password_hash=?, password_salt=?, password_iter=?, email_verified=1, updated_at=? WHERE id=?').bind(h.hash, h.salt, h.iter, now, u.id),
    db.prepare(`UPDATE sessions SET revoked_at=?, revoke_reason='password_reset' WHERE user_id=? AND revoked_at IS NULL`).bind(now, u.id),
  ]);
  await audit(db, 'user', u.id, 'password_reset', null, null, country(req));
  return json(req, 200, { ok: true, signed_out_everywhere: true });
}
// POST /auth/email/verify/request (signed in) → sends a code
export async function verifyRequest(req, env) {
  if (!configured(env)) return off(req);
  const db = env.DB, a = await authenticate(db, req);
  if (a.email_verified) return json(req, 200, { ok: true, already_verified: true });
  if (!(await rateLimit(db, 'verify:' + a.user_id, 5, 3600e3))) throw new ApiError(429, 'too_many_requests');
  const p = await db.prepare('SELECT locale FROM user_profiles WHERE user_id = ?').bind(a.user_id).first();
  await issue(db, env, a.user_id, a.email, 'verify', p && p.locale);
  return json(req, 202, { ok: true });
}
// POST /auth/email/verify {code} (signed in)
export async function verifyConfirm(req, env) {
  if (!configured(env)) return off(req);
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req);
  if (!(await rateLimit(db, 'verifyc:' + a.user_id, 10, 3600e3))) throw new ApiError(429, 'too_many_requests');
  if (!(await consume(db, a.user_id, 'verify', b.code))) throw new ApiError(400, 'invalid_code');
  await db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').bind(Date.now(), a.user_id).run();
  await audit(db, 'user', a.user_id, 'email_verified', null, null, country(req));
  return json(req, 200, { ok: true, email_verified: true });
}
