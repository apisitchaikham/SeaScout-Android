// Sea Scout API v1 — sign in with Google / Facebook through the browser (no app plugin needed).
// Same code for Android, iPhone/iPad and the website:
//   1. app opens  GET /api/v1/auth/<provider>/start?platform=…&install_id=…   (system browser)
//   2. provider → GET /api/v1/auth/<provider>/callback?code=…&state=…  (server swaps the code with the provider,
//      using the client secret that only the server has, then finds/creates the account)
//   3. server → app.seascout.marine://auth?h=<one-time code>   (website: /#ssauth=<code>)
//   4. app    → POST /api/v1/auth/handoff { code }  → session tokens (code works once, for 3 minutes)
// Settings: Google = GOOGLE_WEB_CLIENT_ID + GOOGLE_WEB_CLIENT_SECRET, Facebook = FACEBOOK_APP_ID + FACEBOOK_APP_SECRET.
// Redirect URIs to register with the provider: <site>/api/v1/auth/google/callback, <site>/api/v1/auth/facebook/callback
import { ApiError, json, readJson, randomToken, sha256, clientIp, LOCALES, PLATFORMS, str, country } from './util.js';
import { rateLimit, createSession, audit } from './store.js';
import { verifyJwt } from './jwt.js';
import { meBody } from './common.js';
import { signInIdentity, facebookIdentity, fbConfigured, googleWebFlowOn } from './social.js';

export const APP_SCHEME = 'app.seascout.marine';
const STATE_TTL = 10 * 60e3, HANDOFF_TTL = 3 * 60e3;
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const on = { google: googleWebFlowOn, facebook: fbConfigured };
const redirectUri = (url, p) => `${url.origin}/api/v1/auth/${p}/callback`;

// GET /auth/<provider>/start
export async function oauthStart(req, env, provider) {
  const url = new URL(req.url), q = url.searchParams;
  const platform = PLATFORMS.includes(q.get('platform')) ? q.get('platform') : 'web';
  if (!on[provider] || !on[provider](env)) return finish(url, platform, null, provider + '_signin_not_configured');
  const db = env.DB;
  if (!(await rateLimit(db, 'oauth:ip:' + (await sha256(clientIp(req))), 30, 900e3))) return finish(url, platform, null, 'too_many_requests');
  const install = str(q.get('install_id'), 64);
  const device = install && /^[A-Za-z0-9_-]{8,64}$/.test(install)
    ? { install_id: install, platform, model: str(q.get('model'), 80), app_version: str(q.get('app_version'), 40) } : null;
  const locale = LOCALES.includes(q.get('locale')) ? q.get('locale') : null;
  const state = randomToken(24), verifier = randomToken(48), nonce = randomToken(16), now = Date.now();
  await db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now).run();
  await db.prepare('INSERT INTO oauth_states (state_hash, provider, platform, device, locale, verifier, nonce, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(await sha256(state), provider, platform, device ? JSON.stringify(device) : null, locale, verifier, nonce, now, now + STATE_TTL).run();
  let to;
  if (provider === 'google') {
    const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
    to = new URL(env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth');
    Object.entries({ client_id: env.GOOGLE_WEB_CLIENT_ID, redirect_uri: redirectUri(url, provider), response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).forEach(([k, v]) => to.searchParams.set(k, v));
  } else {
    to = new URL(env.FACEBOOK_DIALOG_URL || 'https://www.facebook.com/v21.0/dialog/oauth');
    Object.entries({ client_id: env.FACEBOOK_APP_ID, redirect_uri: redirectUri(url, provider), response_type: 'code', scope: 'email,public_profile', state })
      .forEach(([k, v]) => to.searchParams.set(k, v));
  }
  return new Response(null, { status: 302, headers: { Location: to.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// GET /auth/<provider>/callback
export async function oauthCallback(req, env, provider) {
  const url = new URL(req.url), q = url.searchParams, db = env.DB, now = Date.now();
  const state = q.get('state') || '';
  const st = /^[A-Za-z0-9_-]{20,64}$/.test(state)
    ? await db.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND provider = ? RETURNING *').bind(await sha256(state), provider).first() : null;
  if (!st || st.expires_at < now) return finish(url, 'web', null, 'login_expired');
  const platform = st.platform;
  if (q.get('error')) return finish(url, platform, null, /denied|cancel/i.test(q.get('error') + ' ' + (q.get('error_reason') || '')) ? 'cancelled' : 'provider_error');
  const code = q.get('code');
  if (!code || code.length > 2048) return finish(url, platform, null, 'provider_error');
  if (!on[provider](env)) return finish(url, platform, null, provider + '_signin_not_configured');
  try {
    let c;
    if (provider === 'google') {
      const r = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_WEB_CLIENT_ID, client_secret: env.GOOGLE_WEB_CLIENT_SECRET, redirect_uri: redirectUri(url, provider),
          grant_type: 'authorization_code', code_verifier: st.verifier }) });
      const t = r.ok ? await r.json() : null;
      if (!t || typeof t.id_token !== 'string') throw new ApiError(401, 'provider_error');
      const v = await verifyJwt(t.id_token, { jwksUrl: env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['accounts.google.com', 'https://accounts.google.com'], audiences: [env.GOOGLE_WEB_CLIENT_ID] });
      if (v.nonce !== st.nonce) throw new ApiError(401, 'invalid_nonce');
      c = { sub: v.sub, email: v.email, verified: v.email_verified === true || v.email_verified === 'true', name: v.name };
    } else {
      const g = env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v21.0';
      const t = await fetch(`${g}/oauth/access_token?` + new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri: redirectUri(url, provider), code }))
        .then((r) => r.ok ? r.json() : null).catch(() => null);
      if (!t || typeof t.access_token !== 'string') throw new ApiError(401, 'provider_error');
      c = await facebookIdentity(env, t.access_token);
    }
    // Tapping "Continue with …" on the sign-in screen states acceptance of the privacy policy (shown under the buttons).
    const b = { privacy_consent: true, privacy_version: '1', locale: st.locale, flow: 'browser' };
    const r = await signInIdentity(req, env, provider, c, b, st.device ? JSON.parse(st.device) : null);
    const h = randomToken(32);
    await db.prepare('DELETE FROM auth_handoffs WHERE expires_at < ?').bind(now).run();
    await db.prepare('INSERT INTO auth_handoffs (code_hash, user_id, device_id, provider, created, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind(await sha256(h), r.userId, r.deviceId || null, provider, r.created ? 1 : 0, now, now + HANDOFF_TTL).run();
    return finish(url, platform, h, null);
  } catch (e) {
    const codeOut = e instanceof ApiError ? e.code : 'server_error';
    if (!(e instanceof ApiError)) console.log(JSON.stringify({ seascout: 'oauth_error', provider, err: String(e && e.stack || e).slice(0, 600) }));
    return finish(url, platform, null, codeOut);
  }
}

// POST /auth/handoff { code } → tokens
export async function oauthHandoff(req, env) {
  const db = env.DB, b = await readJson(req);
  if (!(await rateLimit(db, 'handoff:ip:' + (await sha256(clientIp(req))), 30, 900e3))) throw new ApiError(429, 'too_many_requests');
  if (typeof b.code !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(b.code)) throw new ApiError(400, 'invalid_code');
  const row = await db.prepare('DELETE FROM auth_handoffs WHERE code_hash = ? RETURNING *').bind(await sha256(b.code)).first();
  if (!row || row.expires_at < Date.now()) throw new ApiError(401, 'login_expired');
  const u = await db.prepare('SELECT status FROM users WHERE id = ?').bind(row.user_id).first();
  if (!u || u.status !== 'active') throw new ApiError(403, 'account_disabled');
  const tokens = await createSession(db, row.user_id, row.device_id, req);
  await audit(db, 'user', row.user_id, 'handoff_' + row.provider, null, null, country(req));
  return json(req, row.created ? 201 : 200, { ...tokens, created: !!row.created, ...(await meBody(db, row.user_id)) });
}

// Back to the app (custom scheme) or the website, carrying only a one-time code or an error code.
function finish(url, platform, code, err) {
  const qs = code ? 'h=' + encodeURIComponent(code) : 'err=' + encodeURIComponent(err || 'server_error');
  if (platform === 'web') {
    return new Response(null, { status: 302, headers: { Location: `${url.origin}/#ssauth&${qs}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  const target = `${APP_SCHEME}://auth?${qs}`;
  const ok = !!code;
  const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sea Scout</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;
background:#06263a;color:#e8f4f8;text-align:center;padding:24px;box-sizing:border-box}a{display:block;margin:22px auto 0;max-width:320px;padding:15px;border-radius:14px;
background:#1877f2;color:#fff;font-weight:600;text-decoration:none;font-size:17px}p{color:#a9cbd8}</style></head><body><div>
<div style="font-size:48px">${ok ? '✅' : '⚠️'}</div><h2>${ok ? 'เข้าสู่ระบบสำเร็จ' : 'เข้าสู่ระบบไม่สำเร็จ'}</h2>
<p>${ok ? 'กำลังกลับไปที่แอป Sea Scout…' : 'กลับไปที่แอปแล้วลองใหม่อีกครั้ง'}</p><a href="${target}" id="go">เปิดแอป Sea Scout</a></div>
<script>setTimeout(function(){location.href=document.getElementById('go').href},150)</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'X-Frame-Options': 'DENY' } });
}
