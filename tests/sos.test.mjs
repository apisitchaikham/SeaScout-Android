// Sea Scout — SOS between nearby users (r14.15.80).
// Usage: node tests/sos.test.mjs <api-base e.g. http://127.0.0.1:8788>
import { execFileSync } from 'node:child_process';
const [BASE] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 400))); };
const ip = () => '10.82.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
async function call(method, path, { body, token } = {}) {
  const h = { 'CF-Connecting-IP': ip() };
  if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { s: r.status, j };
}
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'seascout-db', '--local', '-c', 'wrangler.test.jsonc', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const rnd = Math.random().toString(36).slice(2, 8);
async function user(tag) {
  const r = await call('POST', '/api/v1/auth/register', { body: { email: `sos.${tag}.${rnd}@example.com`, password: 'sos-test-password-1', privacy_consent: true } });
  return r.j && r.j.access_token;
}
const A = await user('a'), B = await user('b'), C = await user('c'), D = await user('d');
ok('four test accounts', A && B && C && D);
// unique sea area per run so earlier runs' alerts never mix in
const LAT = 5 + Math.random() * 10, LON = 95 + Math.random() * 10;

ok('create needs sign-in', (await call('POST', '/api/v1/sos', { body: { lat: LAT, lon: LON } })).s === 401);
ok('create needs a position', (await call('POST', '/api/v1/sos', { body: { kind: 'piw' }, token: A })).s === 400);
ok('nearby: not a helper → 403', (await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT, lon: LON }, token: B })).s === 403);
ok('helper: switching on needs consent', (await call('PUT', '/api/v1/sos/helper', { body: { enabled: true, lat: LAT + 0.05, lon: LON + 0.05 }, token: B })).s === 400);
const hb = await call('PUT', '/api/v1/sos/helper', { body: { enabled: true, consent: true, lat: LAT + 0.05, lon: LON + 0.05, radius_km: 500 }, token: B });
ok('helper B on (radius capped at 100 km)', hb.s === 200 && hb.j.enabled === true && hb.j.radius_km === 100, hb.j);
ok('helper C on, far away', (await call('PUT', '/api/v1/sos/helper', { body: { enabled: true, consent: true, lat: LAT + 3, lon: LON }, token: C })).s === 200);
ok('helper D on, near', (await call('PUT', '/api/v1/sos/helper', { body: { enabled: true, consent: true, lat: LAT - 0.1, lon: LON }, token: D })).s === 200);

const c1 = await call('POST', '/api/v1/sos', { body: { kind: 'piw', lat: LAT, lon: LON, acc: 8, people: 2 }, token: A });
ok('A sends SOS: person in water', c1.s === 201 && c1.j.alert.kind === 'piw' && c1.j.alert.people === 2 && c1.j.alert.status === 'open', c1.j);
ok('A is told how many helpers are near (B and D, not C)', c1.j && c1.j.helpers_nearby === 2, c1.j && c1.j.helpers_nearby);
const id = c1.j.alert.id;
const c2 = await call('POST', '/api/v1/sos', { body: { kind: 'unknown', lat: LAT + 0.001, lon: LON, acc: 6 }, token: A });
ok('pressing SOS again updates the same alert, keeps the chosen kind', c2.s === 200 && c2.j.alert.id === id && c2.j.again && c2.j.alert.kind === 'piw', c2.j);
const c3 = await call('POST', '/api/v1/sos', { body: { kind: 'boat_drifting', lat: LAT + 0.001, lon: LON }, token: A });
ok('…and a newly chosen kind replaces it', c3.j && c3.j.alert.kind === 'boat_drifting', c3.j);

const nb = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT + 0.05, lon: LON + 0.05 }, token: B });
const seen = nb.j && nb.j.alerts.find((x) => x.id === id);
ok('B sees the alert with distance and kind', nb.s === 200 && seen && seen.kind === 'boat_drifting' && seen.km > 5 && seen.km < 9 && seen.responders === 0 && !seen.accepted, nb.j);
const nc = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT + 3, lon: LON }, token: C });
ok('C (≈330 km away) does not', nc.s === 200 && !nc.j.alerts.find((x) => x.id === id), nc.j);
ok('helpers cannot read the track before accepting', (await call('GET', '/api/v1/sos/' + id, { token: B })).s === 403);
ok('nobody can close someone else’s alert', (await call('POST', `/api/v1/sos/${id}/close`, { body: { reason: 'safe' }, token: B })).s === 404);

const ac = await call('POST', `/api/v1/sos/${id}/accept`, { body: { lat: LAT + 0.05, lon: LON + 0.05, speed_kn: 15 }, token: B });
ok('B accepts → gets alert + track', ac.s === 200 && ac.j.alert.id === id && ac.j.track.length >= 1 && ac.j.responders === 1, ac.j);
ok('A cannot accept own alert', (await call('POST', `/api/v1/sos/${id}/accept`, { body: {}, token: A })).s === 400);
await new Promise((r) => setTimeout(r, 10500));
const up = await call('POST', `/api/v1/sos/${id}/pos`, { body: { lat: LAT + 0.004, lon: LON + 0.002, acc: 5 }, token: A });
ok('A keeps sending GPS; sees helper 1 with distance and ETA', up.s === 200 && up.j.helpers.length === 1 && up.j.helpers[0].km > 5 && up.j.helpers[0].eta_min > 10 && up.j.helpers[0].eta_min < 30, up.j);
const det = await call('GET', '/api/v1/sos/' + id, { token: B });
ok('B sees the new fix in the track', det.s === 200 && det.j.track.length >= 2 && Math.abs(det.j.alert.lat - (LAT + 0.004)) < 1e-6, det.j && det.j.track);
ok('helper positions are never in the helper view', det.j && !JSON.stringify(det.j).includes('"helpers"'));
const hp = await call('POST', `/api/v1/sos/${id}/hpos`, { body: { lat: LAT + 0.02, lon: LON + 0.02, speed_kn: 20 }, token: B });
ok('B sends own position', hp.s === 200);
const st = await call('GET', `/api/v1/sos/${id}/status`, { token: A });
ok('A sees B closer now', st.s === 200 && st.j.helpers[0].km < 4, st.j && st.j.helpers);
ok('D (not accepted) cannot send helper position', (await call('POST', `/api/v1/sos/${id}/hpos`, { body: { lat: LAT, lon: LON }, token: D })).s === 403);
const dn = await call('POST', `/api/v1/sos/${id}/leave`, { body: {}, token: D });
ok('D declines', dn.s === 200 && dn.j.outcome === 'declined', dn.j);
const nd = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT - 0.1, lon: LON }, token: D });
ok('…and D’s list marks it declined', nd.j && nd.j.alerts.find((x) => x.id === id && x.declined), nd.j);
const mine = await call('GET', '/api/v1/sos/mine', { token: A });
ok('A reopens the app: own open alert comes back', mine.s === 200 && mine.j.alert && mine.j.alert.id === id, mine.j);
const lv = await call('POST', `/api/v1/sos/${id}/leave`, { body: { outcome: 'found' }, token: B });
ok('B leaves after finding them', lv.s === 200 && lv.j.outcome === 'found', lv.j);
ok('A sees no active helper now', (await call('GET', `/api/v1/sos/${id}/status`, { token: A })).j.helpers.length === 0);
ok('A closes: safe', (await call('POST', `/api/v1/sos/${id}/close`, { body: { reason: 'safe' }, token: A })).s === 200);
ok('closed alert takes no more positions', (await call('POST', `/api/v1/sos/${id}/pos`, { body: { lat: LAT, lon: LON }, token: A })).s === 409);
const nb2 = await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT + 0.05, lon: LON + 0.05 }, token: B });
ok('closed alert disappears for helpers', nb2.s === 200 && !nb2.j.alerts.find((x) => x.id === id), nb2.j);

// expiry: an alert with no fix for 12 h expires
const e1 = await call('POST', '/api/v1/sos', { body: { kind: 'boat_anchored', lat: LAT, lon: LON }, token: A });
ok('new alert after closing the old one', e1.s === 201 && e1.j.alert.id !== id && e1.j.alert.kind === 'boat_anchored', e1.j);
d1(`UPDATE sos_alerts SET last_at = last_at - 13*3600000 WHERE id = '${e1.j.alert.id}'`);
ok('silent for 12 h → expired, gone from /mine', (await call('GET', '/api/v1/sos/mine', { token: A })).j.alert === null);
ok('bad kind falls back to unknown', (await call('POST', '/api/v1/sos', { body: { kind: 'zzz', lat: LAT, lon: LON }, token: D })).j.alert.kind === 'unknown');
ok('helper off', (await call('PUT', '/api/v1/sos/helper', { body: { enabled: false }, token: B })).j.enabled === false);
ok('helper off → nearby refused', (await call('POST', '/api/v1/sos/nearby', { body: { lat: LAT, lon: LON }, token: B })).s === 403);
const aud = d1(`SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'sos_%' AND target = '${id}'`);
ok('create/accept/leave/close are in the audit log', aud[0].n >= 4, aud);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
