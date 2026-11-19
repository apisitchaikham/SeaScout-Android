// Sea Scout API v1 — Google Sign-In and Sign in with Apple (ID token from the app → verified here against the
// provider's public keys). Turned on by setting GOOGLE_CLIENT_IDS / APPLE_CLIENT_IDS (comma-separated audiences).
import { ApiError, json, readJson, newId, country, LOCALES, str } from './util.js';
import { audit, upsertDevice, createSession, rateLimit } from './store.js';
import { verifyJwt, csv } from './jwt.js';
import { deviceFrom, meBody, PRIVACY_VERSION_RE } from './common.js';
import { sha256, clientIp } from './util.js';

const PROVIDERS = {
  google: { jwks: (env) => env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs', iss: ['accounts.google.com', 'https://accounts.google.com'], aud: (env) => csv(env.GOOGLE_CLIENT_IDS), off: 'google_signin_not_configured' },
  apple: { jwks: (env) => env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys', iss: ['https://appleid.apple.com'], aud: (env) => csv(env.APPLE_CLIENT_IDS), off: 'apple_signin_not_configured' },
};

export const socialSignIn = (provider) => async (req, env) => {
  const P = PROVIDERS[provider], aud = P.aud(env);
  if (!aud.length) return json(req, 503, { error: P.off, message: 'Not configured on the server yet' });
  const db = env.DB, b = await readJson(req);
  if (!(await rateLimit(db, 'social:ip:' + (await sha256(clientIp(req))), 30, 900e3))) throw new ApiError(429, 'too_many_requests');
  if (typeof b.id_token !== 'string' || b.id_token.length > 4096) throw new ApiError(400, 'id_token_required');
  const c = await verifyJwt(b.id_token, { jwksUrl: P.jwks(env), issuers: P.iss, audiences: aud });
  if (typeof b.nonce === 'string' && c.nonce && c.nonce !== b.nonce && c.nonce !== (await sha256(b.nonce))) throw new ApiError(401, 'invalid_nonce');
  const sub = String(c.sub || ''); if (!sub) throw new ApiError(401, 'invalid_token');
  const email = c.email ? String(c.email).toLowerCase() : null;
  const verified = c.email_verified === true || c.email_verified === 'true';
  const dev = deviceFrom(b), now = Date.now();
  let userId = (await db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(provider, sub).first())?.user_id;
  let created = false;
  if (!userId) {
    // Link to an existing account only when the provider says the email is verified.
    if (email && verified) userId = (await db.prepare(`SELECT id FROM users WHERE email = ? AND status <> 'deleted'`).bind(email).first())?.id;
    if (!userId) {
      if (!email) throw new ApiError(400, 'email_required'); // Apple sends the email only on first sign-in
      if (b.privacy_consent !== true) throw new ApiError(400, 'privacy_consent_required');
      const pv = str(b.privacy_version, 20) || '1';
      if (!PRIVACY_VERSION_RE.test(pv)) throw new ApiError(400, 'invalid_privacy_version');
      userId = newId('usr'); created = true;
      await db.batch([
        db.prepare('INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?)').bind(userId, email, verified ? 1 : 0, now, now),
        db.prepare('INSERT INTO user_profiles (user_id, display_name, locale, country, privacy_consent_at, privacy_version, marketing_consent, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(userId, str(c.name || b.display_name, 60), LOCALES.includes(b.locale) ? b.locale : null, country(req), now, pv, b.marketing_consent === true ? 1 : 0, now),
      ]);
    } else if (verified) await db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').bind(now, userId).run();
    await db.prepare('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?,?,?,?,?)').bind(provider, sub, userId, email, now).run();
  }
  const u = await db.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first();
  if (!u || u.status !== 'active') throw new ApiError(403, 'account_disabled');
  const deviceId = await upsertDevice(db, userId, dev);
  const tokens = await createSession(db, userId, deviceId, req);
  await audit(db, 'user', userId, created ? 'register_' + provider : 'login_' + provider, null, { platform: dev && dev.platform }, country(req));
  return json(req, created ? 201 : 200, { ...tokens, created, ...(await meBody(db, userId)) });
};
