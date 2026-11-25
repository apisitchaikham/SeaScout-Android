// r14.15.92 · flood / abuse test against `wrangler dev` (never production: free plan quotas are account-wide).
// Checks that floods are refused cheaply (429 in memory, before D1), that cached endpoints stay up and
// that the upstream weather providers are not hammered.  Usage: node tests/ddos.test.mjs http://127.0.0.1:8788
import http from 'node:http';
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
let met = 0; const now = Date.now();
const srv = http.createServer((q, r) => { if (q.url.includes('locationforecast')) { met++; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ properties: { meta: {}, timeseries: [{ time: new Date(now).toISOString(), data: { instant: { details: { wind_speed: 5, wind_speed_of_gust: 8 } } } }] } })); return; }
  if (q.url.includes('gdacsapi')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"features":[]}'); return; } r.writeHead(404); r.end(); }).listen(8791);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
async function flood(n, conc, mk) {
  const codes = {}, lat = []; let i = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { const k = i++; const t = performance.now(); try { const r = await mk(k); await r.arrayBuffer(); codes[r.status] = (codes[r.status] || 0) + 1; } catch (_) { codes.net = (codes.net || 0) + 1; } lat.push(performance.now() - t); } }));
  lat.sort((a, b) => a - b);
  return { codes, rps: Math.round(n / ((performance.now() - t0) / 1000)), p50: Math.round(lat[lat.length >> 1]), p95: Math.round(lat[Math.floor(lat.length * .95)]) };
}
const H = (ip, extra = {}) => ({ 'CF-Connecting-IP': ip, ...extra });
try {
  // 1. one IP hammering login → in-memory 429 after 40/min, no 5xx
  let r = await flood(600, 50, () => fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: H('203.0.113.9', { 'Content-Type': 'application/json' }), body: JSON.stringify({ email: 'x@example.com', password: 'wrong-password-123' }) }));
  console.log('login flood', r);
  ok((r.codes[429] || 0) >= 540 && !r.codes[500] && !r.codes.net, 'login flood from one IP: ≥90% refused with 429, no 5xx');
  // 2. one IP hammering the weather proxy with many distinct cells → capped at 120/min
  r = await flood(800, 50, (k) => fetch(BASE + `/api/v1/wx/point?lat=${(10 + (k % 400) * 0.1).toFixed(1)}&lon=100.5`, { headers: H('203.0.113.10') }));
  console.log('wx distinct-cell flood', r, 'upstream calls', met);
  ok(met <= 120 && (r.codes[429] || 0) >= 600, 'distinct-cell flood: upstream MET calls capped (' + met + ' ≤ 120)');
  // 3. many users (distinct IPs) asking for the same area → served from edge cache
  const m0 = met;
  r = await flood(3000, 100, (k) => fetch(BASE + '/api/v1/wx/point?lat=13.0' + (k % 5) + '&lon=100.9', { headers: H('198.51.' + (k >> 8 & 255) + '.' + (k & 255)) }));
  console.log('wx same-area crowd', r, 'upstream', met - m0);
  ok((r.codes[200] || 0) === 3000 && met - m0 <= 1, '3000 users in one area: all 200, ≤1 upstream call');
  // 4. general GET flood on /boot from one IP → 429 after 900/min, server stays healthy
  r = await flood(1500, 100, () => fetch(BASE + '/api/v1/boot', { headers: H('203.0.113.11') }));
  console.log('boot flood one IP', r);
  ok((r.codes[429] || 0) >= 500 && !r.codes[500], 'boot flood from one IP: refused after the limit, no 5xx');
  // 5. normal users unaffected while the flood IP is blocked
  r = await flood(200, 20, (k) => fetch(BASE + '/api/v1/boot', { headers: H('192.0.2.' + (k % 200)) }));
  ok((r.codes[200] || 0) === 200, 'other users still get 200 during a flood');
  // 6. oversized body and junk
  const big = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: H('192.0.2.250', { 'Content-Type': 'application/json' }), body: 'x'.repeat(200000) });
  ok(big.status === 413 || big.status === 400, 'oversized body refused (' + big.status + ')');
  const junk = await fetch(BASE + '/api/v1/wx/point?lat=1e308&lon=NaN', { headers: H('192.0.2.251') });
  ok(junk.status === 400, 'junk coordinates refused');
  const h = await fetch(BASE + '/api/v1/health'); ok(h.status === 200, 'health OK after all floods');
} finally { srv.close(); }
console.log(`ddos: ${pass}/${pass + fail} pass`); process.exit(fail ? 1 : 0);
