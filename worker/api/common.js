// Sea Scout API v1 — shared request/response pieces used by several route modules.
import { ApiError, PLATFORMS, str } from './util.js';
import { entitlementsFor } from './store.js';

export const PRIVACY_VERSION_RE = /^[0-9A-Za-z._-]{1,20}$/;

export function deviceFrom(body) {
  const d = body && body.device;
  if (!d || typeof d !== 'object') return null;
  const install_id = str(d.install_id, 64);
  if (!install_id || !/^[A-Za-z0-9_-]{8,64}$/.test(install_id)) throw new ApiError(400, 'invalid_device');
  const platform = PLATFORMS.includes(d.platform) ? d.platform : null;
  if (!platform) throw new ApiError(400, 'invalid_platform');
  return { install_id, platform, model: str(d.model, 80), app_version: str(d.app_version, 40) };
}

export async function meBody(db, userId) {
  const u = await db.prepare('SELECT id, email, email_verified, created_at, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?').bind(userId).first();
  const p = await db.prepare('SELECT display_name, locale, country, units, marketing_consent, privacy_consent_at, privacy_version FROM user_profiles WHERE user_id = ?').bind(userId).first();
  const ids = await db.prepare('SELECT provider FROM identities WHERE user_id = ?').bind(userId).all();
  return {
    user: { id: u.id, email: u.email, email_verified: !!u.email_verified, created_at: u.created_at, has_password: !!u.has_password, providers: ids.results.map((r) => r.provider) },
    profile: p ? { ...p, marketing_consent: !!p.marketing_consent } : null,
    ...(await entitlementsFor(db, userId)),
  };
}

