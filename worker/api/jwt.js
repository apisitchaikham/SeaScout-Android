// Sea Scout API — JWT helpers on WebCrypto: verify RS256/ES256 tokens against a JWKS (Google, Apple),
// sign RS256 (Google service account) and ES256 (App Store Server API). No third-party libraries.
import { ApiError } from './util.js';

const enc = new TextEncoder(), dec = new TextDecoder();
export const b64urlToBytes = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
export const bytesToB64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jsonB64url = (o) => bytesToB64url(enc.encode(JSON.stringify(o)));

export function decodeJws(token) {
  const p = String(token || '').split('.');
  if (p.length !== 3) throw new ApiError(400, 'invalid_token');
  try { return { header: JSON.parse(dec.decode(b64urlToBytes(p[0]))), payload: JSON.parse(dec.decode(b64urlToBytes(p[1]))), signed: enc.encode(p[0] + '.' + p[1]), sig: b64urlToBytes(p[2]) }; }
  catch (_) { throw new ApiError(400, 'invalid_token'); }
}

// JWKS cache per isolate (keys rotate rarely; refetch on unknown kid)
const JWKS = new Map();
async function getJwks(url, force) {
  const c = JWKS.get(url);
  if (c && !force && Date.now() - c.at < 6 * 3600e3) return c.keys;
  const r = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new ApiError(502, 'jwks_unavailable');
  const j = await r.json();
  JWKS.set(url, { at: Date.now(), keys: j.keys || [] });
  return j.keys || [];
}

export async function verifyJwt(token, { jwksUrl, issuers, audiences, maxAgeSec = 0 }) {
  const t = decodeJws(token);
  const alg = t.header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') throw new ApiError(401, 'invalid_token');
  let keys = await getJwks(jwksUrl);
  let jwk = keys.find((k) => k.kid === t.header.kid);
  if (!jwk) { keys = await getJwks(jwksUrl, true); jwk = keys.find((k) => k.kid === t.header.kid); }
  if (!jwk) throw new ApiError(401, 'invalid_token');
  const algo = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' };
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, crv: jwk.crv, x: jwk.x, y: jwk.y, alg, ext: true }, algo, false, ['verify']);
  const ok = await crypto.subtle.verify(alg === 'RS256' ? algo : { name: 'ECDSA', hash: 'SHA-256' }, key, t.sig, t.signed);
  if (!ok) throw new ApiError(401, 'invalid_token');
  const p = t.payload, now = Math.floor(Date.now() / 1000);
  if (issuers && !issuers.includes(p.iss)) throw new ApiError(401, 'invalid_token_issuer');
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (audiences && !aud.some((a) => audiences.includes(a))) throw new ApiError(401, 'invalid_token_audience');
  if (typeof p.exp !== 'number' || p.exp < now - 60) throw new ApiError(401, 'token_expired');
  if (typeof p.iat === 'number' && p.iat > now + 300) throw new ApiError(401, 'invalid_token');
  if (maxAgeSec && typeof p.iat === 'number' && now - p.iat > maxAgeSec) throw new ApiError(401, 'token_expired');
  return p;
}

function pemToDer(pem) {
  const b = String(pem).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}
export async function signRS256(pemPkcs8, claims, header = {}) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pemPkcs8), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const data = jsonB64url({ alg: 'RS256', typ: 'JWT', ...header }) + '.' + jsonB64url(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  return data + '.' + bytesToB64url(sig);
}
export async function signES256(pemPkcs8, claims, header = {}) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pemPkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const data = jsonB64url({ alg: 'ES256', typ: 'JWT', ...header }) + '.' + jsonB64url(claims);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data)); // raw r||s = JWS format
  return data + '.' + bytesToB64url(sig);
}
export const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
