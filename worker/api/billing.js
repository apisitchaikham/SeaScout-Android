// Sea Scout API v1 — store purchases → subscriptions (the only way Premium/Pro is granted besides admin grants).
// Google Play: Play Developer API (subscriptionsv2) with a service account; RTDN via Pub/Sub push (OIDC-verified).
// App Store:   App Store Server API (ES256 JWT); Server Notifications V2 are re-checked against the API.
// Nothing here trusts what the app says about a purchase — the store is always asked.
import { ApiError, json, readJson, newId, sha256, country } from './util.js';
import { audit, authenticate } from './store.js';
import { signRS256, signES256, decodeJws, verifyJwt, csv } from './jwt.js';

const offG = (req) => json(req, 503, { error: 'billing_not_configured', store: 'google', message: 'Not configured on the server yet' });
const offA = (req) => json(req, 503, { error: 'billing_not_configured', store: 'apple', message: 'Not configured on the server yet' });
const googleOn = (env) => !!(env.GOOGLE_PLAY_PACKAGE && env.GOOGLE_SERVICE_ACCOUNT_JSON);
const appleOn = (env) => !!(env.APPLE_BUNDLE_ID && env.APPLE_ISSUER_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);

// The app passes these to the store at purchase time so a purchase can only be claimed by the same account.
export async function accountTokens(userId) {
  const h = await sha256('seascout-account:' + userId); // base64url, 43 chars
  const hex = [...atob(h.replace(/-/g, '+').replace(/_/g, '/') + '=')].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { google_obfuscated_account_id: h.slice(0, 64), apple_app_account_token: uuid };
}

async function planFor(db, store, productId) {
  const r = await db.prepare('SELECT plan_id FROM store_products WHERE store = ? AND product_id = ?').bind(store, productId).first();
  if (!r) throw new ApiError(400, 'unknown_product');
  return r.plan_id;
}
async function logEvent(db, store, type, txn, userId, payload, result) {
  await db.prepare('INSERT INTO payment_events (id, store, event_type, store_txn_id, user_id, payload, received_at, processed_at, result) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(newId('pay'), store, type, txn || null, userId || null, payload ? JSON.stringify(payload).slice(0, 8000) : null, Date.now(), Date.now(), result || null).run();
}
async function upsertSub(db, s) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO subscriptions (id, user_id, plan_id, source, store_product_id, store_txn_id, status, started_at, expires_at, auto_renew, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, store_txn_id) DO UPDATE SET plan_id=excluded.plan_id, store_product_id=excluded.store_product_id, status=excluded.status,
       expires_at=excluded.expires_at, auto_renew=excluded.auto_renew, updated_at=excluded.updated_at`)
    .bind(newId('sub'), s.user_id, s.plan_id, s.source, s.product_id, s.txn, s.status, s.started_at || now, s.expires_at, s.auto_renew ? 1 : 0, now).run();
}
async function ownerOf(db, source, txn) {
  return (await db.prepare('SELECT user_id FROM subscriptions WHERE source = ? AND store_txn_id = ?').bind(source, txn).first())?.user_id || null;
}

// ---------------- Google Play ----------------
let gTok = null;
async function googleAccessToken(env) {
  if (gTok && gTok.exp > Date.now() + 60e3) return gTok.token;
  let sa; try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch (_) { throw new ApiError(500, 'billing_config_invalid'); }
  const now = Math.floor(Date.now() / 1000), tokenUrl = env.GOOGLE_TOKEN_URL || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = await signRS256(sa.private_key, { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: tokenUrl, iat: now, exp: now + 3600 }, sa.private_key_id ? { kid: sa.private_key_id } : {});
  const r = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + assertion });
  if (!r.ok) throw new ApiError(502, 'google_auth_failed');
  const j = await r.json(); gTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gTok.token;
}
const G_STATUS = { SUBSCRIPTION_STATE_ACTIVE: 'active', SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace', SUBSCRIPTION_STATE_ON_HOLD: 'paused', SUBSCRIPTION_STATE_PAUSED: 'paused', SUBSCRIPTION_STATE_CANCELED: 'canceled', SUBSCRIPTION_STATE_EXPIRED: 'expired', SUBSCRIPTION_STATE_PENDING: 'paused', SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired' };
async function googleFetchSub(env, token) {
  const base = env.GOOGLE_API_BASE || 'https://androidpublisher.googleapis.com';
  const r = await fetch(`${base}/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`, { headers: { Authorization: 'Bearer ' + (await googleAccessToken(env)) } });
  if (r.status === 404 || r.status === 410) throw new ApiError(400, 'purchase_not_found');
  if (!r.ok) throw new ApiError(502, 'google_api_error');
  return r.json();
}
async function googleAck(env, productId, token) {
  const base = env.GOOGLE_API_BASE || 'https://androidpublisher.googleapis.com';
  await fetch(`${base}/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + (await googleAccessToken(env)), 'Content-Type': 'application/json' }, body: '{}' });
}
async function applyGoogle(db, env, token, userId, req) {
  const g = await googleFetchSub(env, token);
  const li = (g.lineItems || []).slice().sort((a, b) => Date.parse(b.expiryTime || 0) - Date.parse(a.expiryTime || 0))[0];
  if (!li) throw new ApiError(400, 'purchase_not_found');
  const plan = await planFor(db, 'google', li.productId);
  const status = G_STATUS[g.subscriptionState] || 'expired';
  const owner = await ownerOf(db, 'google', token);
  const ext = g.externalAccountIdentifiers && g.externalAccountIdentifiers.obfuscatedExternalAccountId;
  if (userId) {
    const want = (await accountTokens(userId)).google_obfuscated_account_id;
    if ((ext && ext !== want) || (owner && owner !== userId)) throw new ApiError(409, 'purchase_belongs_to_another_account');
  }
  const uid = userId || owner;
  if (!uid) { await logEvent(db, 'google', 'unclaimed', token, null, { state: g.subscriptionState, productId: li.productId }, 'no_owner'); return null; }
  const s = { user_id: uid, plan_id: plan, source: 'google', product_id: li.productId, txn: token, status, started_at: Date.parse(g.startTime || '') || Date.now(),
    expires_at: Date.parse(li.expiryTime || '') || null, auto_renew: !!(li.autoRenewingPlan && li.autoRenewingPlan.autoRenewEnabled) };
  await upsertSub(db, s);
  if (g.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && (status === 'active' || status === 'grace')) { try { await googleAck(env, li.productId, token); } catch (_) {} }
  await logEvent(db, 'google', userId ? 'verify' : 'notify', token, uid, { state: g.subscriptionState, productId: li.productId, expiry: li.expiryTime }, status);
  await audit(db, userId ? 'user' : 'store', userId || null, 'subscription_' + status, uid, { store: 'google', plan, product: li.productId }, req && country(req));
  return s;
}
// POST /billing/google/verify {purchase_token} (signed in)
export async function googleVerify(req, env) {
  if (!googleOn(env)) return offG(req);
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req);
  if (typeof b.purchase_token !== 'string' || b.purchase_token.length < 10 || b.purchase_token.length > 1000) throw new ApiError(400, 'purchase_token_required');
  const s = await applyGoogle(db, env, b.purchase_token, a.user_id, req);
  return json(req, 200, { ok: true, plan: s.plan_id, status: s.status, expires_at: s.expires_at });
}
// POST /billing/google/notify — Pub/Sub push (Authorization: Bearer <Google-signed OIDC token>)
export async function googleNotify(req, env) {
  if (!googleOn(env) || !env.GOOGLE_RTDN_AUDIENCE) return offG(req);
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new ApiError(401, 'unauthorized');
  const c = await verifyJwt(m[1], { jwksUrl: env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['accounts.google.com', 'https://accounts.google.com'], audiences: [env.GOOGLE_RTDN_AUDIENCE] });
  if (env.GOOGLE_RTDN_SA_EMAIL && c.email !== env.GOOGLE_RTDN_SA_EMAIL) throw new ApiError(401, 'unauthorized');
  const b = await readJson(req, 65536);
  let data = null; try { data = JSON.parse(atob(b.message && b.message.data || '')); } catch (_) {}
  const n = data && data.subscriptionNotification;
  if (data && data.packageName && data.packageName !== env.GOOGLE_PLAY_PACKAGE) return json(req, 200, { ok: true, ignored: 'package' });
  if (!n || !n.purchaseToken) { await logEvent(env.DB, 'google', 'notify_other', null, null, data, 'ignored'); return json(req, 200, { ok: true }); }
  await applyGoogle(env.DB, env, n.purchaseToken, null, req);
  return json(req, 200, { ok: true });
}

// ---------------- App Store ----------------
async function appleJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  return signES256(env.APPLE_PRIVATE_KEY, { iss: env.APPLE_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1', bid: env.APPLE_BUNDLE_ID }, { kid: env.APPLE_KEY_ID });
}
const A_STATUS = { 1: 'active', 2: 'expired', 3: 'paused', 4: 'grace', 5: 'revoked' };
async function appleStatuses(env, originalTxn) {
  const base = env.APPLE_API_BASE || (env.APPLE_ENV === 'Sandbox' ? 'https://api.storekit-sandbox.itunes.apple.com' : 'https://api.storekit.itunes.apple.com');
  const r = await fetch(`${base}/inApps/v1/subscriptions/${encodeURIComponent(originalTxn)}`, { headers: { Authorization: 'Bearer ' + (await appleJwt(env)) } });
  if (r.status === 404) throw new ApiError(400, 'purchase_not_found');
  if (!r.ok) throw new ApiError(502, 'apple_api_error');
  return r.json();
}
async function applyApple(db, env, originalTxn, userId, req) {
  const j = await appleStatuses(env, originalTxn);
  if (j.bundleId && j.bundleId !== env.APPLE_BUNDLE_ID) throw new ApiError(400, 'wrong_app');
  let best = null;
  for (const g of j.data || []) for (const t of g.lastTransactions || []) {
    if (t.originalTransactionId !== originalTxn) continue;
    const info = decodeJws(t.signedTransactionInfo).payload; // fetched from Apple over TLS
    const renew = t.signedRenewalInfo ? decodeJws(t.signedRenewalInfo).payload : {};
    if (!best || (info.expiresDate || 0) > (best.info.expiresDate || 0)) best = { t, info, renew };
  }
  if (!best) throw new ApiError(400, 'purchase_not_found');
  const plan = await planFor(db, 'apple', best.info.productId);
  const owner = await ownerOf(db, 'apple', originalTxn);
  if (userId) {
    const want = (await accountTokens(userId)).apple_app_account_token;
    if ((best.info.appAccountToken && best.info.appAccountToken.toLowerCase() !== want) || (owner && owner !== userId)) throw new ApiError(409, 'purchase_belongs_to_another_account');
  }
  const uid = userId || owner;
  const status = A_STATUS[best.t.status] || 'expired';
  if (!uid) { await logEvent(db, 'apple', 'unclaimed', originalTxn, null, { status, productId: best.info.productId }, 'no_owner'); return null; }
  const s = { user_id: uid, plan_id: plan, source: 'apple', product_id: best.info.productId, txn: originalTxn, status, started_at: best.info.originalPurchaseDate || Date.now(),
    expires_at: best.info.expiresDate || null, auto_renew: best.renew.autoRenewStatus === 1 };
  await upsertSub(db, s);
  await logEvent(db, 'apple', userId ? 'verify' : 'notify', originalTxn, uid, { status, productId: best.info.productId, expires: best.info.expiresDate }, status);
  await audit(db, userId ? 'user' : 'store', userId || null, 'subscription_' + status, uid, { store: 'apple', plan, product: best.info.productId }, req && country(req));
  return s;
}
// POST /billing/apple/verify {original_transaction_id} (signed in)
export async function appleVerify(req, env) {
  if (!appleOn(env)) return offA(req);
  const db = env.DB, a = await authenticate(db, req), b = await readJson(req);
  const id = String(b.original_transaction_id || '');
  if (!/^[0-9]{5,30}$/.test(id)) throw new ApiError(400, 'original_transaction_id_required');
  const s = await applyApple(db, env, id, a.user_id, req);
  return json(req, 200, { ok: true, plan: s.plan_id, status: s.status, expires_at: s.expires_at });
}
// POST /billing/apple/notify {signedPayload} — App Store Server Notifications V2.
// The payload is only used to find the transaction; its state is always re-read from the App Store Server API.
export async function appleNotify(req, env) {
  if (!appleOn(env)) return offA(req);
  const b = await readJson(req, 262144);
  const p = decodeJws(b.signedPayload).payload;
  const d = p.data || {};
  if (d.bundleId && d.bundleId !== env.APPLE_BUNDLE_ID) return json(req, 200, { ok: true, ignored: 'bundle' });
  const tx = d.signedTransactionInfo ? decodeJws(d.signedTransactionInfo).payload : null;
  if (!tx || !tx.originalTransactionId) { await logEvent(env.DB, 'apple', 'notify_other', null, null, { type: p.notificationType }, 'ignored'); return json(req, 200, { ok: true }); }
  await applyApple(env.DB, env, String(tx.originalTransactionId), null, req);
  return json(req, 200, { ok: true });
}
// GET /billing/account-tokens (signed in) — values the app passes to the store when buying
export async function billingTokens(req, env) {
  const a = await authenticate(env.DB, req);
  const { results } = await env.DB.prepare('SELECT store, product_id, plan_id, period FROM store_products ORDER BY store, plan_id').all();
  return json(req, 200, { ...(await accountTokens(a.user_id)), products: results, google: googleOn(env), apple: appleOn(env) });
}
export const _test = { csv };
