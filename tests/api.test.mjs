// Sea Scout API v1 — integration & security tests against `wrangler dev` (local D1).
// Usage: node tests/api.test.mjs <base-with-db> <base-without-db>
// e.g.   node tests/api.test.mjs http://127.0.0.1:8788 http://127.0.0.1:8789
const [BASE, BASE_NODB] = process.argv.slice(2);
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) { (cond ? pass++ : fail++); results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === undefined ? '' : '  → ' + JSON.stringify(extra).slice(0, 300))); }
async function call(method, path, { body, token, origin, base = BASE, raw, ip } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  if (origin) h.Origin = origin;
  if (ip) h['CF-Connecting-IP'] = ip;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, j, h: r.headers, t };
}
const rnd = Math.random().toString(36).slice(2, 8);
const EMAIL = `tester.${rnd}@example.com`, PW = 'correct-horse-battery', PW2 = 'another-long-password';
const dev = (id, platform) => ({ install_id: id, platform, model: 'Test', app_version: '1.0.58' });

// ---- 0) existing site behaviour must not change (deployment without a database) ----
{
  const r = await call('GET', '/', { base: BASE_NODB });
  ok('existing: / still serves the app page', r.s === 200 && /Sea Scout/.test(r.t), r.s);
  const c = await call('POST', '/api/crash', { base: BASE_NODB, body: { k: 'test', m: 'hello' } });
  ok('existing: /api/crash still 204', c.s === 204, c.s);
  const c2 = await call('GET', '/api/crash', { base: BASE_NODB });
  ok('existing: /api/crash GET still 405', c2.s === 405, c2.s);
  const h = await call('GET', '/api/v1/health', { base: BASE_NODB });
  ok('no DB: health says db=false', h.s === 200 && h.j.db === false, h.j);
  const m = await call('GET', '/api/v1/me', { base: BASE_NODB });
  ok('no DB: other routes 503 backend_not_configured', m.s === 503 && m.j.error === 'backend_not_configured', m.j);
}

// ---- 1) register ----
let A;
{
  const bad = await call('POST', '/api/v1/auth/register', { body: { email: 'not-an-email', password: PW, privacy_consent: true } });
  ok('register: invalid email → 400', bad.s === 400 && bad.j.error === 'invalid_email', bad.j);
  const short = await call('POST', '/api/v1/auth/register', { body: { email: EMAIL, password: 'short', privacy_consent: true } });
  ok('register: short password → 400', short.s === 400 && short.j.error === 'password_too_short', short.j);
  const noc = await call('POST', '/api/v1/auth/register', { body: { email: EMAIL, password: PW } });
  ok('register: no privacy consent → 400', noc.s === 400 && noc.j.error === 'privacy_consent_required', noc.j);
  const r = await call('POST', '/api/v1/auth/register', { body: { email: EMAIL.toUpperCase(), password: PW, privacy_consent: true, privacy_version: '2026-11', locale: 'th', device: dev('install-android-01', 'android') }, origin: 'https://localhost' });
  A = r.j;
  ok('register: 201 with tokens', r.s === 201 && A.access_token && A.refresh_token, r.j);
  ok('register: email stored lower-case', A.user.email === EMAIL, A.user);
  ok('register: starts on free plan, heatmap locked', A.plan === 'free' && A.entitlements.heatmap === false, A.entitlements);
  ok('register: no password data in response', !/password_hash|password_salt/.test(r.t));
  ok('CORS: Android origin allowed', r.h.get('access-control-allow-origin') === 'https://localhost');
  const dup = await call('POST', '/api/v1/auth/register', { body: { email: EMAIL, password: PW, privacy_consent: true } });
  ok('register: duplicate email → 409', dup.s === 409 && dup.j.error === 'email_taken', dup.j);
}

// ---- 2) login / me / CORS ----
let B;
{
  const wrong = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: 'wrong-password-123' } });
  ok('login: wrong password → 401 invalid_credentials', wrong.s === 401 && wrong.j.error === 'invalid_credentials', wrong.j);
  const ghost = await call('POST', '/api/v1/auth/login', { body: { email: 'nobody.' + rnd + '@example.com', password: 'whatever-123456' } });
  ok('login: unknown email gives the same answer', ghost.s === 401 && ghost.j.error === 'invalid_credentials', ghost.j);
  const r = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW, device: dev('install-iphone-0001', 'ios') }, origin: 'capacitor://localhost' });
  B = r.j;
  ok('login: 200 with new tokens', r.s === 200 && B.access_token && B.access_token !== A.access_token, r.j);
  ok('CORS: iOS origin allowed', r.h.get('access-control-allow-origin') === 'capacitor://localhost');
  const evil = await call('GET', '/api/v1/me', { token: B.access_token, origin: 'https://evil.example' });
  ok('CORS: unknown origin gets no allow-origin header', evil.s === 200 && !evil.h.get('access-control-allow-origin'));
  const me = await call('GET', '/api/v1/me', { token: B.access_token });
  ok('me: returns user + entitlements', me.s === 200 && me.j.user.email === EMAIL && me.j.plan === 'free', me.j);
  const noTok = await call('GET', '/api/v1/me');
  ok('me: no token → 401', noTok.s === 401);
  const junk = await call('GET', '/api/v1/me', { token: 'x'.repeat(43) });
  ok('me: forged token → 401', junk.s === 401);
}

// ---- 3) devices across platforms (one account, Android + iPhone) ----
{
  const d = await call('GET', '/api/v1/me/devices', { token: B.access_token });
  const plats = (d.j.devices || []).map((x) => x.platform).sort().join(',');
  ok('devices: same account on android + ios', d.s === 200 && plats === 'android,ios', d.j);
  ok('devices: current device marked', d.j.devices.filter((x) => x.current).length === 1, d.j.devices);
}

// ---- 4) refresh rotation & theft detection ----
{
  const r1 = await call('POST', '/api/v1/auth/refresh', { body: { refresh_token: A.refresh_token } });
  ok('refresh: rotates tokens', r1.s === 200 && r1.j.refresh_token && r1.j.refresh_token !== A.refresh_token, r1.j);
  const oldAccess = await call('GET', '/api/v1/me', { token: A.access_token });
  ok('refresh: old access token stops working', oldAccess.s === 401);
  const newAccess = await call('GET', '/api/v1/me', { token: r1.j.access_token });
  ok('refresh: new access token works', newAccess.s === 200);
  const reuse = await call('POST', '/api/v1/auth/refresh', { body: { refresh_token: A.refresh_token } });
  ok('refresh: re-using an old refresh token → 401', reuse.s === 401);
  const after = await call('GET', '/api/v1/me', { token: r1.j.access_token });
  ok('refresh: re-use revokes the whole session family', after.s === 401);
  const other = await call('GET', '/api/v1/me', { token: B.access_token });
  ok('refresh: other device session unaffected', other.s === 200);
}

// ---- 5) profile & validation & injection ----
{
  const p = await call('PATCH', '/api/v1/me/profile', { token: B.access_token, body: { display_name: "Robert'); DROP TABLE users;--", locale: 'en', country: 'TH', marketing_consent: false } });
  ok('profile: update ok, SQL text stored as plain text', p.s === 200 && p.j.profile.display_name.startsWith('Robert'), p.j);
  const still = await call('GET', '/api/v1/me', { token: B.access_token });
  ok('profile: users table still there', still.s === 200);
  const badLoc = await call('PATCH', '/api/v1/me/profile', { token: B.access_token, body: { locale: 'xx' } });
  ok('profile: invalid locale → 400', badLoc.s === 400, badLoc.j);
  const inj = await call('POST', '/api/v1/auth/login', { body: { email: "a' OR '1'='1@x.com", password: PW } });
  ok('login: SQL-ish email rejected/failed safely', inj.s === 400 || inj.s === 401, inj.j);
  const notJson = await call('POST', '/api/v1/auth/login', { body: 'email=a', raw: true });
  ok('body: malformed JSON → 400', notJson.s === 400, notJson.j);
  const big = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: 'x'.repeat(20000) } });
  ok('body: oversize → 413', big.s === 413, big.j);
}

// ---- 6) entitlements come from the server (premium via subscription row) ----
{
  const e = await call('GET', '/api/v1/me/entitlements', { token: B.access_token });
  ok('entitlements: free plan from server', e.s === 200 && e.j.plan === 'free' && e.j.entitlements.ai_quota_daily === 0, e.j);
}

// ---- 7) password change signs out other sessions ----
let C;
{
  const wrongCur = await call('POST', '/api/v1/me/password', { token: B.access_token, body: { current_password: 'nope-nope-nope', new_password: PW2 } });
  ok('password: wrong current → 401', wrongCur.s === 401, wrongCur.j);
  const l2 = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW, device: dev('install-tablet-0001', 'android') } });
  const ch = await call('POST', '/api/v1/me/password', { token: B.access_token, body: { current_password: PW, new_password: PW2 } });
  ok('password: change ok', ch.s === 200, ch.j);
  const other = await call('GET', '/api/v1/me', { token: l2.j.access_token });
  ok('password: other sessions signed out', other.s === 401);
  const mine = await call('GET', '/api/v1/me', { token: B.access_token });
  ok('password: current session kept', mine.s === 200);
  const oldPw = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW } });
  ok('password: old password no longer works', oldPw.s === 401);
  const l3 = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW2, device: dev('install-iphone-0001', 'ios') } });
  C = l3.j;
  ok('password: new password works', l3.s === 200);
}

// ---- 8) device removal revokes its session ----
{
  const d = await call('GET', '/api/v1/me/devices', { token: B.access_token });
  const tablet = d.j.devices.find((x) => x.platform === 'android' && !x.current && x.model === 'Test' && x.signed_in === false) || d.j.devices.find((x) => !x.current);
  const ip = d.j.devices.find((x) => x.platform === 'ios');
  const rm = await call('DELETE', '/api/v1/me/devices/' + ip.id, { token: B.access_token });
  ok('devices: remove ok', rm.s === 200, rm.j);
  const gone = await call('GET', '/api/v1/me', { token: B.access_token });
  ok('devices: removing the device signs it out', gone.s === 401);
  const bad = await call('DELETE', '/api/v1/me/devices/dev_AAAAAAAAAAAAAAAA', { token: C.access_token });
  ok('devices: other/unknown id → 401/404', bad.s === 404 || bad.s === 401, bad.j);
  void tablet;
}

// ---- 9) logout ----
let D;
{
  const l = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW2 } });
  D = l.j;
  const lo = await call('POST', '/api/v1/auth/logout', { token: D.access_token });
  ok('logout: ok', lo.s === 200);
  const after = await call('GET', '/api/v1/me', { token: D.access_token });
  ok('logout: token dead', after.s === 401);
  const rf = await call('POST', '/api/v1/auth/refresh', { body: { refresh_token: D.refresh_token } });
  ok('logout: refresh dead', rf.s === 401);
}

// ---- 10) not-yet-configured features answer honestly ----
{
  const g = await call('POST', '/api/v1/auth/google', { body: {} });
  ok('google sign-in: 503 not configured', g.s === 503 && g.j.error === 'google_signin_not_configured', g.j);
  const f = await call('POST', '/api/v1/auth/password/forgot', { body: { email: EMAIL } });
  ok('forgot password: 503 email not configured', f.s === 503, f.j);
  const fl = await call('GET', '/api/v1/flags');
  ok('flags: readable', fl.s === 200 && fl.j.flags.accounts.enabled === true && fl.j.flags.server_premium.enabled === false, fl.j);
  const nf = await call('GET', '/api/v1/nope');
  ok('unknown route → 404', nf.s === 404);
  const mm = await call('GET', '/api/v1/auth/login');
  ok('wrong method → 405', mm.s === 405);
}

// ---- 11) account deletion ----
{
  const l = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW2 } });
  const bad = await call('DELETE', '/api/v1/me', { token: l.j.access_token, body: { password: 'wrong-password-xx' } });
  ok('delete: wrong password → 401', bad.s === 401);
  const del = await call('DELETE', '/api/v1/me', { token: l.j.access_token, body: { password: PW2 } });
  ok('delete: ok', del.s === 200 && del.j.deleted === true, del.j);
  const me = await call('GET', '/api/v1/me', { token: l.j.access_token });
  ok('delete: sessions revoked', me.s === 401);
  const relog = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PW2 } });
  ok('delete: cannot sign in again', relog.s === 401);
  const again = await call('POST', '/api/v1/auth/register', { body: { email: EMAIL, password: PW, privacy_consent: true }, ip: '10.9.9.9' });
  ok('delete: email can be registered again', again.s === 201, again.j);
}

// ---- 12) brute-force throttling ----
{
  const victim = `bf.${rnd}@example.com`;
  let last;
  for (let i = 0; i < 12; i++) last = await call('POST', '/api/v1/auth/login', { body: { email: victim, password: 'guess-' + i + '-xxxxxx' }, ip: '10.1.1.' + i });
  ok('throttle: 11th+ attempt on one email → 429', last.s === 429, last.j);
  let reg;
  for (let i = 0; i < 11; i++) reg = await call('POST', '/api/v1/auth/register', { body: { email: `flood${i}.${rnd}@example.com`, password: PW, privacy_consent: true }, ip: '10.2.2.2' });
  ok('throttle: 11th registration from one IP in an hour → 429', reg.s === 429, reg.j);
}

console.log(`\n${pass} passed, ${fail} failed`);
import('node:fs').then((fs) => fs.writeFileSync(process.env.OUT || 'api-test-results.json', JSON.stringify({ pass, fail, results, at: new Date().toISOString() }, null, 2)));
process.exitCode = fail ? 1 : 0;
