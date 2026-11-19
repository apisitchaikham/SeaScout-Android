// Sea Scout API — sign-in with Google/Apple, email codes, Google Play / App Store billing, commerce and Admin API.
// Runs against `wrangler dev` (local D1) + tests/mock-stores.mjs.
// Usage: node tests/integrations.test.mjs <api-base> <mock-base> <keydir> <d1-cmd-helper>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [BASE, MOCK, KEYDIR] = process.argv.slice(2);
const K = JSON.parse(fs.readFileSync(KEYDIR + '/keys.json', 'utf8'));
let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { c ? pass++ : fail++; results.push({ name: n, ok: !!c }); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 300))); };
async function call(method, path, { body, token, origin, ip, raw, redirect } = {}) {
  const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token; if (origin) h.Origin = origin; if (ip) h['CF-Connecting-IP'] = ip;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)), redirect: redirect || 'follow' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, j, h: r.headers, t };
}
const mock = (p, b) => fetch(MOCK + p, { method: b ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'seascout-db', '--local', '-c', 'wrangler.test.jsonc', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims, { key = K.idPriv, kid = 'test-kid-1' } = {}) {
  const h = b64u({ alg: 'RS256', kid, typ: 'JWT' }), p = b64u(claims);
  return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
}
const now = () => Math.floor(Date.now() / 1000);
const rnd = Math.random().toString(36).slice(2, 7);
const dev = (id, platform = 'android') => ({ install_id: id, platform });
const ip = () => '10.50.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);

// ================= Google / Apple sign-in =================
const gEmail = `g.${rnd}@gmail.com`;
const gClaims = (o = {}) => ({ iss: 'https://accounts.google.com', aud: 'test-google-client', sub: 'g-' + rnd, email: gEmail, email_verified: true, iat: now(), exp: now() + 600, name: 'Google Tester', ...o });
{
  const noC = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims()) }, ip: ip() });
  ok('google: new user without privacy consent → 400', noC.s === 400 && noC.j.error === 'privacy_consent_required', noC.j);
  const r = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims()), privacy_consent: true, device: dev('g-dev-000001') }, ip: ip() });
  ok('google: sign-up 201, verified email, provider listed', r.s === 201 && r.j.created && r.j.user.email_verified && r.j.user.providers.includes('google') && !r.j.user.has_password, r.j);
  const r2 = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims()) }, ip: ip() });
  ok('google: second sign-in 200 same user', r2.s === 200 && r2.j.user.id === r.j.user.id, r2.j);
  const aud = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims({ aud: 'someone-else' })) }, ip: ip() });
  ok('google: wrong audience → 401', aud.s === 401, aud.j);
  const exp = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims({ exp: now() - 3600, iat: now() - 7200 })) }, ip: ip() });
  ok('google: expired token → 401', exp.s === 401, exp.j);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const forged = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims(), { key: other }) }, ip: ip() });
  ok('google: forged signature → 401', forged.s === 401, forged.j);
  const iss = await call('POST', '/api/v1/auth/google', { body: { id_token: idToken(gClaims({ iss: 'https://evil.example' })) }, ip: ip() });
  ok('google: wrong issuer → 401', iss.s === 401, iss.j);
  // Apple links to an existing password account with the same verified email
  const pwEmail = `a.${rnd}@example.com`;
  const reg = await call('POST', '/api/v1/auth/register', { body: { email: pwEmail, password: 'apple-link-password', privacy_consent: true }, ip: ip() });
  const ap = await call('POST', '/api/v1/auth/apple', { body: { id_token: idToken({ iss: 'https://appleid.apple.com', aud: 'app.seascout.marine', sub: 'apple-' + rnd, email: pwEmail, email_verified: 'true', iat: now(), exp: now() + 600 }), device: dev('ios-dev-00001', 'ios') }, ip: ip() });
  ok('apple: links to existing account with same verified email', ap.s === 200 && ap.j.user.id === reg.j.user.id && ap.j.user.providers.includes('apple'), ap.j);
}

// ================= Facebook =================
{
  const pr = await call('GET', '/api/v1/auth/providers');
  ok('providers: google/apple/facebook enabled with public ids only', pr.s === 200 && pr.j.google.enabled && pr.j.apple.enabled && pr.j.facebook.enabled && pr.j.facebook.app_id === K.fbAppId && !/secret/i.test(pr.t), pr.j);
  const fEmail = `fb.${rnd}@example.com`;
  await mock('/_fb', { token: 'EAAfbtoken-' + rnd + '-xxxxxxxxxxxx', user: { id: '9000' + rnd.length + Math.floor(Math.random() * 1e6), app_id: K.fbAppId, name: 'FB Tester', email: fEmail } });
  const st = await mock('/_state'); const fbUser = st.fb['EAAfbtoken-' + rnd + '-xxxxxxxxxxxx'];
  const r = await call('POST', '/api/v1/auth/facebook', { body: { access_token: 'EAAfbtoken-' + rnd + '-xxxxxxxxxxxx', privacy_consent: true, device: dev('fb-dev-000001') }, ip: ip() });
  ok('facebook: sign-up 201 (email not marked verified)', r.s === 201 && r.j.user.providers.includes('facebook') && r.j.user.email_verified === false, r.j);
  const r2 = await call('POST', '/api/v1/auth/facebook', { body: { access_token: 'EAAfbtoken-' + rnd + '-xxxxxxxxxxxx' }, ip: ip() });
  ok('facebook: second sign-in same user', r2.s === 200 && r2.j.user.id === r.j.user.id, r2.j);
  const bad = await call('POST', '/api/v1/auth/facebook', { body: { access_token: 'EAAunknown-token-xyz' }, ip: ip() });
  ok('facebook: invalid token → 401', bad.s === 401, bad.j);
  await mock('/_fb', { token: 'EAAotherapp-' + rnd + '-xxxxxxxxxxxx', user: { id: '777', app_id: '999999', name: 'X', email: 'x@example.com' } });
  const other = await call('POST', '/api/v1/auth/facebook', { body: { access_token: 'EAAotherapp-' + rnd + '-xxxxxxxxxxxx' }, ip: ip() });
  ok('facebook: token from another app → 401', other.s === 401, other.j);
  const exEmail = `exists.${rnd}@example.com`;
  await call('POST', '/api/v1/auth/register', { body: { email: exEmail, password: 'exists-password-1', privacy_consent: true }, ip: ip() });
  await mock('/_fb', { token: 'EAAtakeover-' + rnd + '-xxxxxxxxxxxx', user: { id: '555' + rnd.length, app_id: K.fbAppId, name: 'Y', email: exEmail } });
  const take = await call('POST', '/api/v1/auth/facebook', { body: { access_token: 'EAAtakeover-' + rnd + '-xxxxxxxxxxxx', privacy_consent: true }, ip: ip() });
  ok('facebook: email of an existing account is NOT auto-linked → 409', take.s === 409 && take.j.error === 'account_exists_sign_in_first', take.j);
  await mock('/_fb', { token: 'EAAnoemail-' + rnd + '-xxxxxxxxxxxx', user: { id: '444' + rnd.length, app_id: K.fbAppId, name: 'Z' } });
  const ne = await call('POST', '/api/v1/auth/facebook', { body: { access_token: 'EAAnoemail-' + rnd + '-xxxxxxxxxxxx', privacy_consent: true }, ip: ip() });
  ok('facebook: no email permission → 400 email_required', ne.s === 400 && ne.j.error === 'email_required', ne.j);
  const lim = await call('POST', '/api/v1/auth/facebook', { body: { id_token: idToken({ iss: 'https://www.facebook.com', aud: K.fbAppId, sub: String(fbUser.id), email: fEmail, iat: now(), exp: now() + 600 }) }, ip: ip() });
  ok('facebook: iOS Limited Login ID token → same user', lim.s === 200 && lim.j.user.id === r.j.user.id, lim.j);
  const limBad = await call('POST', '/api/v1/auth/facebook', { body: { id_token: idToken({ iss: 'https://www.facebook.com', aud: 'another-app', sub: '1', iat: now(), exp: now() + 600 }) }, ip: ip() });
  ok('facebook: Limited Login wrong audience → 401', limBad.s === 401, limBad.j);
}

// ================= Email codes =================
const eEmail = `mail.${rnd}@example.com`, ePw = 'first-password-xyz';
let U; // { user, tokens }
{
  const r = await call('POST', '/api/v1/auth/register', { body: { email: eEmail, password: ePw, privacy_consent: true, locale: 'th' }, ip: ip() });
  U = r.j;
  const before = (await mock('/_state')).emails.length;
  const vr = await call('POST', '/api/v1/auth/email/verify/request', { token: U.access_token, body: {} });
  const st = await mock('/_state'), m = st.emails[st.emails.length - 1];
  ok('email verify: code sent in Thai via provider', vr.s === 202 && st.emails.length === before + 1 && m.to[0] === eEmail && /ยืนยันอีเมล/.test(m.subject), { vr: vr.j, m });
  const code = (m.text.match(/: ([A-Z0-9]{8})/) || [])[1];
  const bad = await call('POST', '/api/v1/auth/email/verify', { token: U.access_token, body: { code: 'AAAAAAAA' } });
  ok('email verify: wrong code → 400', bad.s === 400 && bad.j.error === 'invalid_code', bad.j);
  const good = await call('POST', '/api/v1/auth/email/verify', { token: U.access_token, body: { code: code.slice(0, 4) + '-' + code.slice(4) } });
  ok('email verify: right code (with dash) → verified', good.s === 200 && good.j.email_verified, good.j);
  const n0 = (await mock('/_state')).emails.length;
  const ghost = await call('POST', '/api/v1/auth/password/forgot', { body: { email: 'nobody.' + rnd + '@example.com' }, ip: ip() });
  ok('forgot: unknown email still 202 and sends nothing', ghost.s === 202 && (await mock('/_state')).emails.length === n0, ghost.j);
  const fg = await call('POST', '/api/v1/auth/password/forgot', { body: { email: eEmail }, ip: ip() });
  const em = (await mock('/_state')).emails.slice(-1)[0], rcode = (em.text.match(/: ([A-Z0-9]{8})/) || [])[1];
  ok('forgot: reset code emailed', fg.s === 202 && em.to[0] === eEmail && rcode, em);
  const rb = await call('POST', '/api/v1/auth/password/reset', { body: { email: eEmail, code: 'ZZZZZZZZ', new_password: 'second-password-xyz' }, ip: ip() });
  ok('reset: wrong code → 400', rb.s === 400, rb.j);
  const rs = await call('POST', '/api/v1/auth/password/reset', { body: { email: eEmail, code: rcode, new_password: 'second-password-xyz' }, ip: ip() });
  ok('reset: ok', rs.s === 200 && rs.j.signed_out_everywhere, rs.j);
  const oldTok = await call('GET', '/api/v1/me', { token: U.access_token });
  ok('reset: all sessions signed out', oldTok.s === 401);
  const again = await call('POST', '/api/v1/auth/password/reset', { body: { email: eEmail, code: rcode, new_password: 'third-password-xyz' }, ip: ip() });
  ok('reset: code cannot be reused', again.s === 400, again.j);
  const li = await call('POST', '/api/v1/auth/login', { body: { email: eEmail, password: 'second-password-xyz' }, ip: ip() });
  ok('reset: new password works', li.s === 200, li.j);
  U = li.j;
}

// ================= Admin API (bootstrap an owner the way the docs say: a row in admin_users) =================
const admEmail = `owner.${rnd}@example.com`, admPw = 'owner-password-123';
let A;
{
  await call('POST', '/api/v1/auth/register', { body: { email: admEmail, password: admPw, privacy_consent: true }, ip: ip() });
  d1(`INSERT INTO admin_users (id, email, role, created_at) VALUES ('adm_${rnd}', '${admEmail}', 'owner', 0)`);
  const bad = await call('POST', '/api/v1/admin/login', { body: { email: admEmail, password: 'wrong-wrong-wrong' }, ip: ip() });
  ok('admin: wrong password → 401', bad.s === 401, bad.j);
  const notAdm = await call('POST', '/api/v1/admin/login', { body: { email: eEmail, password: 'second-password-xyz' }, ip: ip() });
  ok('admin: normal member cannot sign in to admin', notAdm.s === 401, notAdm.j);
  const r = await call('POST', '/api/v1/admin/login', { body: { email: admEmail, password: admPw }, origin: 'null', ip: ip() });
  A = r.j;
  ok('admin: owner login + file:// (null origin) CORS allowed', r.s === 200 && A.role === 'owner' && r.h.get('access-control-allow-origin') === 'null', r.j);
  const meNull = await call('GET', '/api/v1/me', { token: U.access_token, origin: 'null' });
  ok('admin CORS: null origin NOT allowed on member API', !meNull.h.get('access-control-allow-origin'));
  const userTokOnAdmin = await call('GET', '/api/v1/admin/overview', { token: U.access_token });
  ok('admin: member token rejected on admin API', userTokOnAdmin.s === 401);
  const ov = await call('GET', '/api/v1/admin/overview', { token: A.token });
  ok('admin: overview has users/security/config', ov.s === 200 && ov.j.users.total >= 3 && ov.j.config.google_signin === true && 'security_24h' in ov.j, ov.j);
  const ul = await call('GET', '/api/v1/admin/users?q=' + encodeURIComponent('mail.' + rnd), { token: A.token });
  ok('admin: search members', ul.s === 200 && ul.j.users.length === 1 && ul.j.users[0].email === eEmail, ul.j);
  const ud = await call('GET', '/api/v1/admin/users/' + U.user.id, { token: A.token });
  ok('admin: member detail without secrets', ud.s === 200 && ud.j.user.email === eEmail && !/password_hash|password_salt|access_hash|refresh_hash/.test(ud.t), ud.j);
  const sp = await call('PUT', '/api/v1/admin/store-products', { token: A.token, body: { store: 'google', product_id: 'seascout_premium_monthly', plan_id: 'premium', period: 'P1M' } });
  const sp2 = await call('PUT', '/api/v1/admin/store-products', { token: A.token, body: { store: 'apple', product_id: 'app.seascout.pro.yearly', plan_id: 'pro', period: 'P1Y' } });
  ok('admin: map store products to plans', sp.s === 200 && sp2.s === 200, [sp.j, sp2.j]);
  const fNo = await call('PATCH', '/api/v1/admin/flags/server_premium', { token: A.token, body: { enabled: true } });
  ok('admin: risky flag needs confirm', fNo.s === 400 && fNo.j.error === 'confirmation_required', fNo.j);
  const fOk = await call('PATCH', '/api/v1/admin/flags/commerce_api', { token: A.token, body: { enabled: true, rollout_pct: 50 } });
  ok('admin: flag change returns rollback values', fOk.s === 200 && fOk.j.rollback && fOk.j.rollback.rollout_pct === 100, fOk.j);
  await call('PATCH', '/api/v1/admin/flags/commerce_api', { token: A.token, body: { rollout_pct: 100 } });
}

// ================= Google Play billing =================
{
  const tk = await call('GET', '/api/v1/billing/account-tokens', { token: U.access_token });
  ok('billing: account tokens for the store', tk.s === 200 && tk.j.google_obfuscated_account_id && /^[0-9a-f-]{36}$/.test(tk.j.apple_app_account_token) && tk.j.google && tk.j.apple, tk.j);
  const ptoken = 'gp-token-' + rnd + '-xxxxxxxx';
  const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
  await mock('/_google', { token: ptoken, sub: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', startTime: new Date().toISOString(),
    externalAccountIdentifiers: { obfuscatedExternalAccountId: tk.j.google_obfuscated_account_id }, lineItems: [{ productId: 'seascout_premium_monthly', expiryTime: exp, autoRenewingPlan: { autoRenewEnabled: true } }] } });
  const v = await call('POST', '/api/v1/billing/google/verify', { token: U.access_token, body: { purchase_token: ptoken } });
  ok('google play: verified → premium', v.s === 200 && v.j.plan === 'premium' && v.j.status === 'active', v.j);
  const e = await call('GET', '/api/v1/me/entitlements', { token: U.access_token });
  ok('google play: entitlements now premium from server', e.j.plan === 'premium' && e.j.entitlements.heatmap === true && e.j.subscription.source === 'google', e.j);
  ok('google play: purchase acknowledged', (await mock('/_state')).acks.some((p) => p.includes(encodeURIComponent(ptoken))));
  const thief = await call('POST', '/api/v1/auth/login', { body: { email: admEmail, password: admPw }, ip: ip() });
  const steal = await call('POST', '/api/v1/billing/google/verify', { token: thief.j.access_token, body: { purchase_token: ptoken } });
  ok('google play: another account cannot claim the purchase → 409', steal.s === 409, steal.j);
  const unk = 'gp-unknown-' + rnd + '-xxxx';
  await mock('/_google', { token: unk, sub: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{ productId: 'not_in_catalog', expiryTime: exp }] } });
  const u2 = await call('POST', '/api/v1/billing/google/verify', { token: U.access_token, body: { purchase_token: unk } });
  ok('google play: unknown product → 400', u2.s === 400 && u2.j.error === 'unknown_product', u2.j);
  // RTDN: subscription expired → user back to free
  await mock('/_google', { token: ptoken, sub: { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', lineItems: [{ productId: 'seascout_premium_monthly', expiryTime: new Date(Date.now() - 1000).toISOString() }] } });
  const msg = { message: { data: Buffer.from(JSON.stringify({ packageName: 'app.seascout.marine', subscriptionNotification: { notificationType: 13, purchaseToken: ptoken, subscriptionId: 'seascout_premium_monthly' } })).toString('base64') } };
  const oidc = (o = {}) => idToken({ iss: 'https://accounts.google.com', aud: 'https://seascout.test/rtdn', email: 'pubsub@test.iam.gserviceaccount.com', email_verified: true, sub: 'x', iat: now(), exp: now() + 600, ...o });
  const badN = await call('POST', '/api/v1/billing/google/notify', { token: oidc({ aud: 'https://other' }), body: msg });
  ok('google RTDN: wrong audience → 401', badN.s === 401, badN.j);
  const badE = await call('POST', '/api/v1/billing/google/notify', { token: oidc({ email: 'attacker@evil.example' }), body: msg });
  ok('google RTDN: wrong service account → 401', badE.s === 401, badE.j);
  const n = await call('POST', '/api/v1/billing/google/notify', { token: oidc(), body: msg });
  const e2 = await call('GET', '/api/v1/me/entitlements', { token: U.access_token });
  ok('google RTDN: expiry applied → free', n.s === 200 && e2.j.plan === 'free', [n.j, e2.j]);
}

// ================= App Store billing =================
{
  const tk = await call('GET', '/api/v1/billing/account-tokens', { token: U.access_token });
  const otx = '2000000' + Math.floor(Math.random() * 1e9);
  await mock('/_apple', { id: otx, sub: { status: 1, productId: 'app.seascout.pro.yearly', expiresDate: Date.now() + 365 * 86400e3, appAccountToken: tk.j.apple_app_account_token, autoRenew: true } });
  const v = await call('POST', '/api/v1/billing/apple/verify', { token: U.access_token, body: { original_transaction_id: otx } });
  ok('app store: verified → pro', v.s === 200 && v.j.plan === 'pro' && v.j.status === 'active', v.j);
  const other = '2000001' + Math.floor(Math.random() * 1e9);
  await mock('/_apple', { id: other, sub: { status: 1, productId: 'app.seascout.pro.yearly', expiresDate: Date.now() + 86400e3, appAccountToken: crypto.randomUUID() } });
  const mis = await call('POST', '/api/v1/billing/apple/verify', { token: U.access_token, body: { original_transaction_id: other } });
  ok('app store: purchase made by another account → 409', mis.s === 409, mis.j);
  await mock('/_apple', { id: otx, sub: { status: 5, productId: 'app.seascout.pro.yearly', expiresDate: Date.now() + 365 * 86400e3, appAccountToken: tk.j.apple_app_account_token } });
  const H = b64u({ alg: 'ES256', x5c: ['test'] });
  const sp = H + '.' + b64u({ notificationType: 'REFUND', data: { bundleId: 'app.seascout.marine', signedTransactionInfo: H + '.' + b64u({ originalTransactionId: otx }) + '.sig' } }) + '.sig';
  const n = await call('POST', '/api/v1/billing/apple/notify', { body: { signedPayload: sp } });
  const e = await call('GET', '/api/v1/me/entitlements', { token: U.access_token });
  ok('app store notification: refund re-checked with Apple → free', n.s === 200 && e.j.plan === 'free', [n.j, e.j]);
  const pe = await call('GET', '/api/v1/admin/payments', { token: A.token });
  ok('admin: payment events listed, txn ids shortened', pe.s === 200 && pe.j.events.length >= 4 && pe.j.events.every((x) => !x.store_txn_id || x.store_txn_id.endsWith('…')), pe.j);
}

// ================= Admin grants, roles, disable =================
{
  const g = await call('POST', `/api/v1/admin/users/${U.user.id}/subscriptions`, { token: A.token, body: { plan: 'premium', days: 30, note: 'support goodwill' } });
  const e = await call('GET', '/api/v1/me/entitlements', { token: U.access_token });
  ok('admin: manual premium grant (30 days) applies', g.s === 200 && e.j.plan === 'premium' && e.j.subscription.source === 'manual', [g.j, e.j]);
  const rvNo = await call('POST', `/api/v1/admin/users/${U.user.id}/subscriptions/${g.j.subscription_id}/revoke`, { token: A.token, body: {} });
  ok('admin: revoke needs confirm', rvNo.s === 400, rvNo.j);
  const rv = await call('POST', `/api/v1/admin/users/${U.user.id}/subscriptions/${g.j.subscription_id}/revoke`, { token: A.token, body: { confirm: true } });
  const e2 = await call('GET', '/api/v1/me/entitlements', { token: U.access_token });
  ok('admin: revoke → free', rv.s === 200 && e2.j.plan === 'free', [rv.j, e2.j]);
  const ent = await call('PUT', `/api/v1/admin/users/${U.user.id}/entitlements/ai_quota_daily`, { token: A.token, body: { value: 99, days: 7 } });
  const e3 = await call('GET', '/api/v1/me/entitlements', { token: U.access_token });
  ok('admin: per-user entitlement override', ent.s === 200 && e3.j.entitlements.ai_quota_daily === 99, e3.j);
  const pe = await call('PUT', '/api/v1/admin/plans/premium/entitlements/offline_regions', { token: A.token, body: { value: 6 } });
  ok('admin: plan entitlement change', pe.s === 200, pe.j);
  // viewer role cannot change anything
  const vEmail = `viewer.${rnd}@example.com`;
  await call('POST', '/api/v1/auth/register', { body: { email: vEmail, password: 'viewer-password-123', privacy_consent: true }, ip: ip() });
  const addV = await call('PUT', '/api/v1/admin/admins', { token: A.token, body: { email: vEmail, role: 'viewer', confirm: true } });
  const vl = await call('POST', '/api/v1/admin/login', { body: { email: vEmail, password: 'viewer-password-123' }, ip: ip() });
  const vg = await call('POST', `/api/v1/admin/users/${U.user.id}/subscriptions`, { token: vl.j.token, body: { plan: 'pro' } });
  const vr = await call('GET', '/api/v1/admin/overview', { token: vl.j.token });
  ok('admin roles: viewer can read but not grant', addV.s === 200 && vl.s === 200 && vg.s === 403 && vr.s === 200, [addV.j, vg.j]);
  const va = await call('GET', '/api/v1/admin/admins', { token: vl.j.token });
  ok('admin roles: only owner manages admins', va.s === 403);
  const dis = await call('POST', `/api/v1/admin/users/${U.user.id}/disable`, { token: A.token, body: { confirm: true, reason: 'test' } });
  const me = await call('GET', '/api/v1/me', { token: U.access_token });
  const li = await call('POST', '/api/v1/auth/login', { body: { email: eEmail, password: 'second-password-xyz' }, ip: ip() });
  ok('admin: disable signs member out and blocks login', dis.s === 200 && me.s === 401 && li.s === 403, [me.j, li.j]);
  await call('POST', `/api/v1/admin/users/${U.user.id}/enable`, { token: A.token, body: { confirm: true } });
  const li2 = await call('POST', '/api/v1/auth/login', { body: { email: eEmail, password: 'second-password-xyz' }, ip: ip() });
  ok('admin: enable restores login', li2.s === 200);
}

// ================= Commerce =================
{
  const m = await call('POST', '/api/v1/admin/merchants', { token: A.token, body: { name: 'Shopee TH', kind: 'shopee' } });
  const p = await call('POST', '/api/v1/admin/products', { token: A.token, body: { title: 'เบ็ดก้านยาว #6 สำหรับปลาเห็ดโคน', title_i18n: { en: 'Long-shank hook #6 for whiting' }, description: 'ชุด 20 ตัว', tags: ['xsl', 'light'], images: [{ url: 'https://example.com/a.jpg' }, { url: 'https://example.com/b.jpg' }] } });
  const p2 = await call('POST', '/api/v1/admin/products', { token: A.token, body: { title: 'โยตกหมึก 3.0', tags: ['squid', 'u'], images: ['https://example.com/egi.jpg'] } });
  const httpBad = await call('POST', '/api/v1/admin/offers', { token: A.token, body: { product_id: p.j.id, merchant_id: m.j.id, url: 'http://insecure.example/x', country: 'TH' } });
  ok('commerce: offer URL must be https', httpBad.s === 400 && httpBad.j.error === 'invalid_url', httpBad.j);
  const o1 = await call('POST', '/api/v1/admin/offers', { token: A.token, body: { product_id: p.j.id, merchant_id: m.j.id, url: 'https://s.shopee.co.th/aff-hook6', country: 'TH', currency: 'thb', price: 89 } });
  const o2 = await call('POST', '/api/v1/admin/offers', { token: A.token, body: { product_id: p2.j.id, merchant_id: m.j.id, url: 'https://s.shopee.co.th/aff-egi', country: '*', currency: 'THB', price: 250 } });
  ok('commerce: merchant/products/offers created', m.s === 200 && p.s === 200 && o1.s === 200 && o2.s === 200, [m.j, p.j, o1.j]);
  const it = await call('GET', '/api/v1/commerce/items?species=xsl&gear=light&cat=coast&group=fish&lang=en&country=TH');
  const first = it.j.items[0];
  ok('commerce: whiting query returns the whiting hook first, English title, 2 images, own offer link', it.s === 200 && first.id === p.j.id && first.title.startsWith('Long-shank') && first.images.length === 2 && first.offers[0].go.endsWith('/api/v1/go/' + o1.j.id), it.j);
  ok('commerce: squid jig not shown for whiting', !it.j.items.some((x) => x.id === p2.j.id), it.j.items.map((x) => x.id));
  const us = await call('GET', '/api/v1/commerce/items?species=xsl&gear=light&country=US');
  ok('commerce: TH-only offer hidden in another country', us.s === 200 && !us.j.items.some((x) => x.id === p.j.id), us.j);
  const go = await call('GET', '/api/v1/go/' + o1.j.id + '?src=xsl&p=android', { redirect: 'manual' });
  ok('commerce: click redirect goes to that offer URL', go.s === 302 && go.h.get('location') === 'https://s.shopee.co.th/aff-hook6', go.s);
  const cl = await call('GET', '/api/v1/admin/commerce', { token: A.token });
  ok('commerce: click counted for that offer', cl.j.clicks_30d.some((c) => c.offer_id === o1.j.id && c.n >= 1), cl.j.clicks_30d);
  const nf = await call('GET', '/api/v1/go/off_AAAAAAAAAAAAAAAA', { redirect: 'manual' });
  ok('commerce: unknown offer → 404 (no open redirect)', nf.s === 404);
  const dm = await call('DELETE', '/api/v1/admin/merchants/' + m.j.id, { token: A.token, body: { confirm: true } });
  ok('commerce: merchant with offers cannot be deleted', dm.s === 409, dm.j);
  const au = await call('GET', '/api/v1/admin/audit?limit=200', { token: A.token });
  const acts = new Set(au.j.logs.map((l) => l.action));
  ok('audit: admin actions recorded', ['grant_subscription', 'revoke_subscription', 'flag_change', 'product_create', 'offer_create', 'disable_user', 'admin_user_set', 'subscription_active'].every((x) => acts.has(x)), [...acts]);
  ok('audit: no secrets in audit details', !/second-password|owner-password|viewer-password|gp-token|PRIVATE KEY|re_test|gtok/.test(JSON.stringify(au.j.logs)));
  const lo = await call('POST', '/api/v1/admin/logout', { token: A.token, body: {} });
  const after = await call('GET', '/api/v1/admin/overview', { token: A.token });
  ok('admin: logout kills the admin token', lo.s === 200 && after.s === 401);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(process.env.OUT || 'integrations-results.json', JSON.stringify({ pass, fail, results, at: new Date().toISOString() }, null, 2));
process.exitCode = fail ? 1 : 0;
