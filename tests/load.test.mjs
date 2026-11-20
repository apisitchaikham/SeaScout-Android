// Sea Scout — burst load test (r14.15.67). Simulates N users opening the app at the same moment.
// Each simulated user does what the app now does at launch: GET /boot; signed-in users with a stale profile also GET /me.
// Usage: node tests/load.test.mjs <api-base> <users> <concurrency>
// NOTE: run it against `wrangler dev` or a separate test Worker — never against production on the free plan
// (100k requests/day for the whole account).
const [BASE, USERS = '10000', CONC = '500'] = process.argv.slice(2);
const N = +USERS, C = +CONC;
const lat = { boot: [], me: [], catalog: [] }; let err = 0, codes = {};
async function hit(kind, path, token) {
  const t = performance.now();
  try {
    const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    await r.arrayBuffer(); codes[r.status] = (codes[r.status] || 0) + 1; if (!r.ok) err++;
  } catch (_) { err++; codes.net = (codes.net || 0) + 1; }
  lat[kind].push(performance.now() - t);
}
// a handful of real accounts so /me is authenticated
const tokens = [];
for (let i = 0; i < 5; i++) {
  const r = await fetch(BASE + 'auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.77.0.' + i },
    body: JSON.stringify({ email: `load${i}.${Date.now()}@example.com`, password: 'load-test-password-1', privacy_consent: true }) }).then((x) => x.json());
  if (r.access_token) tokens.push(r.access_token);
}
let next = 0;
const t0 = performance.now();
async function worker() {
  while (next < N) {
    const i = next++;
    await hit('boot', 'boot');
    if (i % 4 === 0 && tokens.length) await hit('me', 'me', tokens[i % tokens.length]);   // ~1 in 4 has a profile older than 12h
    if (i % 10 === 0) await hit('catalog', 'commerce/catalog?lang=th');                   // ~1 in 10 opens the analysis tab with no cached catalogue
  }
}
await Promise.all(Array.from({ length: C }, worker));
const secs = (performance.now() - t0) / 1000;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(0) : '-'; };
const total = lat.boot.length + lat.me.length + lat.catalog.length;
const out = { users: N, concurrency: C, requests: total, seconds: +secs.toFixed(1), rps: +(total / secs).toFixed(0), errors: err, codes,
  p50_ms: { boot: pct(lat.boot, .5), me: pct(lat.me, .5), catalog: pct(lat.catalog, .5) },
  p95_ms: { boot: pct(lat.boot, .95), me: pct(lat.me, .95), catalog: pct(lat.catalog, .95) },
  p99_ms: { boot: pct(lat.boot, .99), me: pct(lat.me, .99), catalog: pct(lat.catalog, .99) } };
console.log(JSON.stringify(out, null, 1));
import('node:fs').then((fs) => fs.writeFileSync(`tests/results/load-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 1)));
process.exitCode = err ? 1 : 0;
