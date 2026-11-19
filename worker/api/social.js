// Sea Scout API v1 — Google Sign-In, Sign in with Apple and Facebook Login.
// The app gets a token from the provider; the server verifies it with the provider (never trusts the app).
// Google/Apple: ID token (JWT) checked against the provider's public keys.
// Facebook: access token checked with Graph API debug_token (classic login), or the Limited Login ID token (iOS).
// Each provider turns on when its settings exist: GOOGLE_CLIENT_IDS / APPLE_CLIENT_IDS / FACEBOOK_APP_ID + FACEBOOK_APP_SECRET.
import { ApiError, json, readJson, newId, country, LOCALES, str, sha256, clientIp } from './util.js';
import { audit, upsertDevice, createSession, rateLimit } from './store.js';
import { verifyJwt, csv } from './jwt.js';
import { deviceFrom, meBody, PRIVACY_VERSION_RE } from './common.js';

const fbOn = (env) => !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET);
const PROVIDERS = {
  google: { on: (env) => csv(env.GOOGLE_CLIENT_IDS).length > 0, off: 'google_signin_not_configured', trustEmail: true,
    async identity(env, b) {
      if (typeof b.id_token !== 'string' || b.id_token.length > 4096) throw new ApiError(400, 'id_token_required');
      const c = await verifyJwt(b.id_token, { jwksUrl: env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['accounts.google.com', 'https://accounts.google.com'], audiences: csv(env.GOOGLE_CLIENT_IDS) });
      return { sub: c.sub, email: c.email, verified: c.email_verified === true || c.email_verified === 'true', name: c.name, nonce: c.nonce };
    } },
  apple: { on: (env) => csv(env.APPLE_CLIENT_IDS).length > 0, off: 'apple_signin_not_configured', trustEmail: true,
    async identity(env, b) {
      if (typeof b.id_token !== 'string' || b.id_token.length > 4096) throw new ApiError(400, 'id_token_required');
      const c = await verifyJwt(b.id_token, { jwksUrl: env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'], audiences: csv(env.APPLE_CLIENT_IDS) });
      return { sub: c.sub, email: c.email, verified: c.email_verified === true || c.email_verified === 'true', name: b.display_name, nonce: c.nonce };
    } },
  facebook: { on: fbOn, off: 'facebook_signin_not_configured', trustEmail: false,
    async identity(env, b) {
      if (typeof b.id_token === 'string' && b.id_token.length < 8192) { // iOS Limited Login
        const c = await verifyJwt(b.id_token, { jwksUrl: env.FACEBOOK_JWKS_URL || 'https://limited.facebook.com/.well-known/oauth/openid/jwks/', issuers: ['https://www.facebook.com', 'https://facebook.com'], audiences: [env.FACEBOOK_APP_ID] });
        return { sub: c.sub, email: c.email, verified: false, name: c.name, nonce: c.nonce };
      }
      if (typeof b.access_token !== 'string' || b.access_token.length < 20 || b.access_token.length > 1024) throw new ApiError(400, 'access_token_required');
      const g = env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v21.0';
      const dbg = await fetch(`${g}/debug_token?input_token=${encodeURIComponent(b.access_token)}&access_token=${encodeURIComponent(env.FACEBOOK_APP_ID + '|' + env.FACEBOOK_APP_SECRET)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
      const d = dbg && dbg.data;
      if (!d || d.is_valid !== true || String(d.app_id) !== String(env.FACEBOOK_APP_ID) || !d.user_id) throw new ApiError(401, 'invalid_token');
      const me = await fetch(`${g}/me?fields=id,name,email&access_token=${encodeURIComponent(b.access_token)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
      if (!me || String(me.id) !== String(d.user_id)) throw new ApiError(401, 'invalid_token');
      return { sub: String(me.id), email: me.email, verified: false, name: me.name };
    } },
};

export const socialSignIn = (provider) => async (req, env) => {
  const P = PROVIDERS[provider];
  if (!P.on(env)) return json(req, 503, { error: P.off, message: 'Not configured on the server yet' });
  const db = env.DB, b = await readJson(req);
  if (!(await rateLimit(db, 'social:ip:' + (await sha256(clientIp(req))), 30, 900e3))) throw new ApiError(429, 'too_many_requests');
  const c = await P.identity(env, b);
  if (typeof b.nonce === 'string' && c.nonce && c.nonce !== b.nonce && c.nonce !== (await sha256(b.nonce))) throw new ApiError(401, 'invalid_nonce');
  const sub = String(c.sub || ''); if (!sub) throw new ApiError(401, 'invalid_token');
  const email = c.email ? String(c.email).toLowerCase().slice(0, 254) : null;
  const dev = deviceFrom(b), now = Date.now();
  let userId = (await db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(provider, sub).first())?.user_id;
  let created = false;
  if (!userId) {
    const existing = email ? (await db.prepare(`SELECT id FROM users WHERE email = ? AND status <> 'deleted'`).bind(email).first())?.id : null;
    if (existing) {
      // Google/Apple vouch for the email → link. Facebook does not → the owner must sign in the usual way first.
      if (!(P.trustEmail && c.verified)) throw new ApiError(409, 'account_exists_sign_in_first');
      userId = existing;
      await db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').bind(now, userId).run();
    } else {
      if (!email) throw new ApiError(400, 'email_required'); // Apple sends it only the first time; Facebook only with the email permission
      if (b.privacy_consent !== true) throw new ApiError(400, 'privacy_consent_required');
      const pv = str(b.privacy_version, 20) || '1';
      if (!PRIVACY_VERSION_RE.test(pv)) throw new ApiError(400, 'invalid_privacy_version');
      userId = newId('usr'); created = true;
      await db.batch([
        db.prepare('INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?)').bind(userId, email, P.trustEmail && c.verified ? 1 : 0, now, now),
        db.prepare('INSERT INTO user_profiles (user_id, display_name, locale, country, privacy_consent_at, privacy_version, marketing_consent, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(userId, str(c.name || b.display_name, 60), LOCALES.includes(b.locale) ? b.locale : null, country(req), now, pv, b.marketing_consent === true ? 1 : 0, now),
      ]);
    }
    await db.prepare('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?,?,?,?,?)').bind(provider, sub, userId, email, now).run();
  }
  const u = await db.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first();
  if (!u || u.status !== 'active') throw new ApiError(403, 'account_disabled');
  const deviceId = await upsertDevice(db, userId, dev);
  const tokens = await createSession(db, userId, deviceId, req);
  await audit(db, 'user', userId, created ? 'register_' + provider : 'login_' + provider, null, { platform: dev && dev.platform }, country(req));
  return json(req, created ? 201 : 200, { ...tokens, created, ...(await meBody(db, userId)) });
};

// GET /auth/providers — which sign-in buttons work, plus the PUBLIC ids the app needs to start each SDK.
export async function providers(req, env) {
  const g = csv(env.GOOGLE_CLIENT_IDS);
  return json(req, 200, {
    email: true,
    email_codes: !!(env.RESEND_API_KEY && env.EMAIL_FROM),
    google: { enabled: g.length > 0, web_client_id: env.GOOGLE_WEB_CLIENT_ID || g[0] || null },
    apple: { enabled: csv(env.APPLE_CLIENT_IDS).length > 0, service_id: env.APPLE_SERVICE_ID || null },
    facebook: { enabled: fbOn(env), app_id: fbOn(env) ? env.FACEBOOK_APP_ID : null },
  }, { 'Cache-Control': 'public, max-age=300' });
}
