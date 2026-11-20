// Sea Scout API v1 — shared helpers (HTTP, crypto, validation). No secrets live in this code.
export const VERSION = 'api-v1.0.0';
export const ACCESS_TTL = 24 * 60 * 60 * 1000;       // 24 hours (r14.15.67: fewer refresh calls; revocation is still checked on every request)
export const REFRESH_TTL = 60 * 24 * 60 * 60 * 1000;  // 60 days
export const PBKDF2_ITER = 100000;                    // Workers WebCrypto maximum
export const LOCALES = ['th', 'en', 'zh', 'vi', 'my', 'km', 'ms', 'id', 'fil'];
export const PLATFORMS = ['android', 'ios', 'web'];

// App origins: Android WebView (https://localhost), iOS WKWebView (capacitor://localhost), the website, local dev.
const ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost', 'https://seascout.apisit-chaikham.workers.dev']);

export class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export function corsHeaders(request) {
  const o = request.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  // SeaScout_Admin.html is opened from disk (file:// → Origin "null"); allowed for /api/v1/admin/* only (Bearer admin token, no cookies).
  const path = new URL(request.url).pathname;
  const adminFromFile = o === 'null' && (path.startsWith('/api/v1/admin/') || path === '/api/v1/health');
  if (o && (ORIGINS.has(o) || adminFromFile)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

export function json(request, status, body, extra = {}) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(request), ...extra },
  });
}

export async function readJson(request, max = 16384) {
  const ct = request.headers.get('Content-Type') || '';
  if (!/^application\/json\b/i.test(ct)) throw new ApiError(415, 'json_required');
  const text = await request.text();
  if (text.length > max) throw new ApiError(413, 'body_too_large');
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch (_) { throw new ApiError(400, 'invalid_json'); }
}

// ---------- crypto ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const newId = (prefix) => prefix + '_' + randomToken(12);
export async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

export async function hashPassword(password, saltB64, iter = PBKDF2_ITER) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { hash: b64(bits), salt: b64(salt), iter };
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- validation ----------
export function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length < 6 || e.length > 254 || !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e)) throw new ApiError(400, 'invalid_email');
  return e;
}
export function checkPassword(v) {
  const p = String(v || '');
  if (p.length < 10) throw new ApiError(400, 'password_too_short', 'Use at least 10 characters');
  if (p.length > 256) throw new ApiError(400, 'password_too_long');
  return p;
}
export function str(v, max) { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }
export function clientIp(request) { return request.headers.get('CF-Connecting-IP') || '0.0.0.0'; }
export function country(request) { return (request.cf && request.cf.country) || null; }
