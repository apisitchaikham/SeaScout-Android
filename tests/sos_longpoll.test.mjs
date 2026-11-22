// Sea Scout r14.15.83 — /sos/nearby long-poll + 2 new SOS per day.
// Usage: node tests/sos_longpoll.test.mjs <api-base>
const [BASE] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 300))); };
const ip = () => '10.83.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
async function call(method, path, { body, token } = {}) {
  const h = { 'CF-Connecting-IP': ip() }; if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {} return { s: r.status, j };
}
const rnd = Math.random().toString(36).slice(2, 8);
const user = async (t) => (await call('POST', '/api/v1/auth/register', { body: { email: `lp.${t}.${rnd}@example.com`, password: 'sos-test-password-1', privacy_consent: true } })).j.access_token;
const A = await user('a'), B = await user('b');
const LAT = -20 + Math.random() * 10, LON = 150 + Math.random() * 10;
await call('PUT', '/api/v1/sos/helper', { body: { enabled: true, consent: true, lat: LAT, lon: LON }, token: B });
// nothing open: a 6 s wait holds about 6 s and returns no alerts
let t0 = Date.now(), r = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT, lon: LON, wait: 6 }, token: B });
ok('long-poll with nothing new waits (~6 s) and returns empty', r.s === 200 && r.j.alerts.length === 0 && Date.now() - t0 >= 5000, { ms: Date.now() - t0, j: r.j });
// without wait it answers at once
t0 = Date.now(); r = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT, lon: LON }, token: B });
ok('no wait → immediate answer', r.s === 200 && Date.now() - t0 < 3000, Date.now() - t0);
// B waits up to 25 s; A sends SOS after 4 s → B gets it within ~3 s of sending
t0 = Date.now();
const pending = call('POST', '/api/v1/sos/nearby', { body: { lat: LAT, lon: LON, wait: 25, known: [] }, token: B });
await new Promise((res) => setTimeout(res, 4000));
const sentAt = Date.now(), c = await call('POST', '/api/v1/sos', { body: { kind: 'piw', lat: LAT + 0.01, lon: LON, acc: 5 }, token: A });
r = await pending; const lag = Date.now() - sentAt;
ok('new SOS reaches the waiting helper within ~4 s', c.s === 201 && r.j.alerts.some((a) => a.id === c.j.alert.id) && lag < 4500, { lag, n: r.j.alerts.length });
// already known → keeps waiting
t0 = Date.now(); r = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT, lon: LON, wait: 5, known: [c.j.alert.id] }, token: B });
ok('known alert does not end the wait', Date.now() - t0 >= 4000 && r.j.alerts.some((a) => a.id === c.j.alert.id), Date.now() - t0);
// daily limit: close, second new OK, third new refused
await call('POST', `/api/v1/sos/${c.j.alert.id}/close`, { body: { reason: 'safe' }, token: A });
const c2 = await call('POST', '/api/v1/sos', { body: { kind: 'piw', lat: LAT, lon: LON }, token: A });
ok('2nd new SOS of the day allowed', c2.s === 201, c2);
await call('POST', `/api/v1/sos/${c2.j.alert.id}/close`, { body: { reason: 'safe' }, token: A });
const c3 = await call('POST', '/api/v1/sos', { body: { kind: 'piw', lat: LAT, lon: LON }, token: A });
ok('3rd new SOS in 24 h refused (429)', c3.s === 429, c3);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
