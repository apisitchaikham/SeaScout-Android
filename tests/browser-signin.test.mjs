// Sea Scout API — sign in with Google / Facebook through the browser (r14.15.64).
// Walks the real redirect chain: app → /auth/<p>/start → provider (mock) → /auth/<p>/callback → app scheme → /auth/handoff.
// Usage: node tests/browser-signin.test.mjs <api-base> <mock-base>
const [BASE, MOCK] = process.argv.slice(2);
let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { c ? pass++ : fail++; results.push({ name: n, ok: !!c }); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 300))); };
const mock = (p, b) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const ip = () => '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);

// Follows redirects by hand, the way the phone's browser would; stops at the app scheme or the site's #ssauth.
async function journey(provider, platform, addr = ip(), extra = '') {
  let url = `${BASE}auth/${provider}/start?platform=${platform}&install_id=inst_${platform}_abcdef12&model=Test&app_version=r14.15.64&locale=th${extra}`;
  const hops = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'CF-Connecting-IP': addr } });
    hops.push(r.status);
    const loc = r.headers.get('location');
    if (r.status === 302 && loc) {
      if (/#ssauth/.test(loc)) return { done: loc, hops };
      url = loc; continue;
    }
    const t = await r.text();
    const m = /href="(app\.seascout\.marine:\/\/auth\?[^"]+)"/.exec(t);
    return { done: m ? m[1].replace(/&amp;/g, '&') : null, html: t, hops, headers: r.headers };
  }
  return { done: null, hops };
}
const qs = (u) => new URLSearchParams(String(u).replace(/^[^?#]*[?#]/, '').replace(/^ssauth&?/, ''));
const handoff = (code, addr = ip()) => fetch(BASE + 'auth/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': addr }, body: JSON.stringify({ code }) })
  .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

const P = await fetch(BASE + 'auth/providers').then((r) => r.json());
ok('providers: google.browser + facebook.browser', P.google.browser === true && P.facebook.browser === true && P.google.enabled && P.facebook.enabled, P);

// --- Google on Android: new account ---
const gEmail = `g.browser.${Date.now()}@example.com`;
await mock('/_next', { google: { sub: 'gsub-' + Date.now(), email: gEmail, name: 'Somchai' } });
let j = await journey('google', 'android');
ok('google/android: ends at app.seascout.marine://auth?h=…', j.done && j.done.startsWith('app.seascout.marine://auth?h='), j);
ok('google/android: return page has no-store + CSP + no tokens', j.headers && j.headers.get('cache-control') === 'no-store' && /default-src 'none'/.test(j.headers.get('content-security-policy') || '') && !/access_token|refresh_token/.test(j.html || ''));
const h1 = qs(j.done).get('h');
let r = await handoff(h1);
ok('handoff → 201 new account with tokens + email', r.s === 201 && r.j.access_token && r.j.refresh_token && r.j.user.email === gEmail && r.j.user.providers.includes('google'), r);
ok('handoff device recorded (android)', r.j && r.j.created === true);
const me = await fetch(BASE + 'me', { headers: { Authorization: 'Bearer ' + r.j.access_token } }).then((x) => x.json());
ok('access token works on /me', me.user && me.user.email === gEmail, me);
const devs = await fetch(BASE + 'me/devices', { headers: { Authorization: 'Bearer ' + r.j.access_token } }).then((x) => x.json());
ok('device from start= query saved (platform android)', JSON.stringify(devs).includes('android'), devs);
r = await handoff(h1);
ok('handoff code works only once', r.s === 401 && r.j.error === 'login_expired', r);

// --- same Google user again on iOS: existing account ---
j = await journey('google', 'ios');
r = await handoff(qs(j.done).get('h'));
ok('google/ios second time → 200 same account', r.s === 200 && r.j.user.email === gEmail && r.j.created === false, r);

// --- web: back to the site with #ssauth ---
j = await journey('google', 'web');
ok('google/web: 302 back to site /#ssauth&h=…', j.done && /\/#ssauth&h=[A-Za-z0-9_-]{40,}/.test(j.done), j);
r = await handoff(qs(j.done).get('h'));
ok('web handoff works', r.s === 200 && r.j.access_token, r);

// --- user cancels at Google ---
await mock('/_next', { google: null });
j = await journey('google', 'android');
ok('cancel → app gets err=cancelled', j.done && qs(j.done).get('err') === 'cancelled', j);

// --- Facebook new account (Android) ---
const fbTok = 'EAAtestbrowserflow' + Date.now();
const fbEmail = `fb.browser.${Date.now()}@example.com`;
await mock('/_fb', { token: fbTok, user: { id: 'fb' + Date.now(), app_id: '1234567890', name: 'Malee', email: fbEmail } });
await mock('/_next', { fb: { token: fbTok } });
j = await journey('facebook', 'android');
r = await handoff(qs(j.done).get('h'));
ok('facebook/android → 201 new account', r.s === 201 && r.j.user.email === fbEmail && r.j.user.providers.includes('facebook'), r);

// --- Facebook with an email that already has an account → must sign in first (no takeover) ---
const fbTok2 = 'EAAtestbrowserflow2' + Date.now();
await mock('/_fb', { token: fbTok2, user: { id: 'fb2' + Date.now(), app_id: '1234567890', name: 'X', email: gEmail } });
await mock('/_next', { fb: { token: fbTok2 } });
j = await journey('facebook', 'ios');
ok('facebook with existing email → err=account_exists_sign_in_first', j.done && qs(j.done).get('err') === 'account_exists_sign_in_first', j);

// --- Facebook without email ---
const fbTok3 = 'EAAtestbrowserflow3' + Date.now();
await mock('/_fb', { token: fbTok3, user: { id: 'fb3' + Date.now(), app_id: '1234567890', name: 'NoMail' } });
await mock('/_next', { fb: { token: fbTok3 } });
j = await journey('facebook', 'android');
ok('facebook without email → err=email_required', j.done && qs(j.done).get('err') === 'email_required', j);

// --- forged / replayed state ---
let x = await fetch(BASE + 'auth/google/callback?code=abc&state=' + 'A'.repeat(32), { redirect: 'manual' });
ok('unknown state → login_expired (web redirect)', x.status === 302 && /err=login_expired/.test(x.headers.get('location')), x.status);
// replay: capture a real callback URL and use it twice
await mock('/_next', { google: { sub: 'gsub-replay', email: `replay.${Date.now()}@example.com`, name: 'R' } });
let s1 = await fetch(`${BASE}auth/google/start?platform=android`, { redirect: 'manual' });
let s2 = await fetch(s1.headers.get('location'), { redirect: 'manual' });
const cb = s2.headers.get('location');
const first = await fetch(cb, { redirect: 'manual' }).then((q) => q.text());
const second = await fetch(cb, { redirect: 'manual' }).then((q) => q.headers.get('location') || '');
ok('callback URL replay refused', /h=/.test(first) && /err=login_expired/.test(second));
ok('start sends PKCE S256 + nonce + state to Google', /code_challenge_method=S256/.test(s1.headers.get('location')) && /nonce=/.test(s1.headers.get('location')) && /state=/.test(s1.headers.get('location')));

// --- bad handoff input ---
r = await handoff('short');
ok('handoff rejects malformed code', r.s === 400, r);

// --- rate limit on start ---
const addr = ip(); let last = 0;
for (let i = 0; i < 32; i++) last = (await fetch(`${BASE}auth/google/start?platform=web`, { redirect: 'manual', headers: { 'CF-Connecting-IP': addr } })).headers.get('location') || '';
ok('start rate-limited per IP (→ err=too_many_requests)', /err=too_many_requests/.test(last), last);

console.log(`\n${pass} passed, ${fail} failed`);
import('node:fs').then((fs) => fs.writeFileSync(`tests/results/browser-signin-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ pass, fail, results }, null, 1)));
process.exitCode = fail ? 1 : 0;
