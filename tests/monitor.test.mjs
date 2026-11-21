// Sea Scout — system health monitor (r14.15.73): usage vs free-plan limits, data-server probes, crash counts,
// alert levels, e-mail de-duplication, admin page data, cron hook and feature flag.
// Usage: node tests/monitor.test.mjs <api-base e.g. http://127.0.0.1:8788> <mock-base>
// Needs `wrangler dev --test-scheduled` and the .dev.vars from tests/gen-test-keys.mjs.
import { execFileSync } from 'node:child_process';
import { evaluate } from '../worker/api/monitor.js';
const [BASE, MOCK] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 500))); };
async function call(method, path, { body, token, raw } = {}) {
  const h = { 'CF-Connecting-IP': '10.78.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) };
  if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, j };
}
const mock = (p, b) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const mstate = async () => (await fetch(MOCK + '/_state')).json();
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'seascout-db', '--local', '-c', 'wrangler.test.jsonc', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (script, status, requests, extra = {}) => ({ sum: { requests, errors: status === 'success' ? 0 : requests, subrequests: 0 }, quantiles: { cpuTimeP99: extra.cpu || 2500 }, dimensions: { scriptName: script, status } });
const D = (reads, writes) => ({ sum: { rowsRead: reads, rowsWritten: writes, readQueries: 1, writeQueries: 1 }, dimensions: { databaseId: 'db1' } });
const opsMail = async () => (await mstate()).emails.filter((e) => (e.to || []).includes('ops@example.com'));
const alert = (h, id) => (h.alerts || []).find((a) => a.id === id) || {};

// ---------- rules (pure) ----------
{
  const base = { day_frac: 0.5, crashes: { last_hour: 0 } };
  const u = (o) => ({ configured: true, requests: 0, d1_reads: 0, d1_writes: 0, exceeded: 0, threw: 0, cpu_p99_ms: 1, ...o });
  const lv = (snap, id) => evaluate({ ...base, ...snap }, {}).find((a) => a.id === id).level;
  ok('rule: 34% requests ok, 70% warn, 90% crit', lv({ usage: u({ requests: 34000 }) }, 'requests_day') === 'ok' && lv({ usage: u({ requests: 70000 }) }, 'requests_day') === 'warn' && lv({ usage: u({ requests: 90000 }) }, 'requests_day') === 'crit');
  ok('rule: projection over the limit → warn (60k by mid-day)', lv({ usage: u({ requests: 60000 }) }, 'requests_day') === 'warn');
  ok('rule: no projection in the first 3 h of the UTC day', evaluate({ ...base, day_frac: 0.1, usage: u({ requests: 30000 }) }, {}).find((a) => a.id === 'requests_day').level === 'ok');
  ok('rule: D1 reads 4.6M crit, writes 75k warn', lv({ usage: u({ d1_reads: 4.6e6 }) }, 'd1_reads') === 'crit' && lv({ usage: u({ d1_writes: 75000 }) }, 'd1_writes') === 'warn');
  ok('rule: CPU limit 1 hit warn, 20 crit', lv({ usage: u({ exceeded: 1 }) }, 'cpu_limit') === 'warn' && lv({ usage: u({ exceeded: 20 }) }, 'cpu_limit') === 'crit');
  const p = { probes: [{ id: 'x', name: 'X', ok: false, status: 503 }] };
  ok('rule: probe down once = warn, twice = crit', evaluate({ ...base, ...p }, {}).find((a) => a.id === 'probe:x').level === 'warn' && evaluate({ ...base, ...p }, { 'probe:x': { level: 'warn' } }).find((a) => a.id === 'probe:x').level === 'crit');
  ok('rule: 30 crashes/h warn, 100 crit', lv({ crashes: { last_hour: 30 } }, 'crashes') === 'warn' && lv({ crashes: { last_hour: 100 } }, 'crashes') === 'crit');
}

// ---------- admin ----------
const rnd = Math.random().toString(36).slice(2, 7), email = `mon.${rnd}@example.com`, vEmail = `monv.${rnd}@example.com`, pw = 'monitor-owner-123';
await call('POST', '/api/v1/auth/register', { body: { email, password: pw, privacy_consent: true } });
await call('POST', '/api/v1/auth/register', { body: { email: vEmail, password: pw, privacy_consent: true } });
d1(`INSERT INTO admin_users (id, email, role, created_at) VALUES ('adm_m${rnd}', '${email}', 'owner', 0), ('adm_v${rnd}', '${vEmail}', 'viewer', 0)`);
const A = (await call('POST', '/api/v1/admin/login', { body: { email, password: pw } })).j.token;
const V = (await call('POST', '/api/v1/admin/login', { body: { email: vEmail, password: pw } })).j.token;
ok('admin logins (owner + viewer)', !!A && !!V);
d1(`DELETE FROM health_snapshots; DELETE FROM monitor_alerts; DELETE FROM crash_counts; UPDATE feature_flags SET enabled = 1 WHERE key = 'monitor'`);
const run = async () => (await call('POST', '/api/v1/admin/health/run', { body: {}, token: A })).j;

// all quiet
await mock('/_cf', { w: [W('seascout', 'success', 1200), W('seascout-cache', 'success', 800), W('seascout', 'clientDisconnected', 5)], d: [D(20000, 300)] });
await mock('/_probe', { pa: 'ok', pb: 'ok' });
const mail0 = (await opsMail()).length;
let h = await run();
ok('run: level ok, usage read from GraphQL', h && h.run && h.run.level === 'ok' && h.run.usage === 'ok', h && h.run);
ok('usage summed over every Worker in the account', h.last.usage.requests === 2005 && h.last.usage.scripts.seascout === 1205 && h.last.usage.scripts['seascout-cache'] === 800, h.last.usage);
ok('D1 rows + CPU p99 (µs → ms)', h.last.usage.d1_reads === 20000 && h.last.usage.d1_writes === 300 && h.last.usage.cpu_p99_ms === 2.5, h.last.usage);
const st = await mstate();
ok('GraphQL asked for today (UTC) with the account id', st.cfLastVars && st.cfLastVars.a === 'acct-test' && st.cfLastVars.d === new Date().toISOString().slice(0, 10) && st.cfLastVars.s.endsWith('T00:00:00.000Z'), st.cfLastVars);
ok('probes: both ok', h.last.probes.length === 2 && h.last.probes.every((p) => p.ok), h.last.probes);
ok('nothing e-mailed while all is ok', (await opsMail()).length === mail0);
ok('setup flags shown', h.setup.usage === true && h.setup.email === true);
ok('viewer can read health', (await call('GET', '/api/v1/admin/health', { token: V })).s === 200);
ok('viewer cannot force a run', (await call('POST', '/api/v1/admin/health/run', { body: {}, token: V })).s === 403);
ok('no token → 401', (await call('GET', '/api/v1/admin/health')).s === 401);

// crash reports → counted per hour and kind (numbers and URLs folded so one bug is one row)
for (let i = 0; i < 5; i++) await call('POST', '/api/crash', { raw: JSON.stringify({ k: 'err', m: `TypeError: x is null at https://a.example/p?${i} line ${1000 + i}`, src: 'index.html', app: 'r14.15.73', plat: 'android', lang: 'th' }) });
await call('POST', '/api/crash', { raw: JSON.stringify({ k: 'rej', m: 'NetworkError when attempting to fetch resource' }) });
await call('POST', '/api/crash', { raw: 'not json' });
await sleep(400);
h = await run();
const cr = h.crashes_24h;
ok('crashes grouped: 5 + 1', cr.length === 2 && cr[0].n === 5 && cr[1].n === 1, cr);
ok('crash key folds URLs and long numbers', cr[0].key === 'err: TypeError: x is null at <url> line #', cr[0].key);
ok('crash sample keeps app/platform, no IP', /r14\.15\.73/.test(cr[0].sample) && /android/.test(cr[0].sample) && !/10\.78\./.test(cr[0].sample), cr[0].sample);
ok('crash count shown in the alert text', /ชั่วโมงล่าสุด 6 ครั้ง/.test(alert(h, 'crashes').message), alert(h, 'crashes'));

// requests at 75% → warn + one e-mail; repeat → no second e-mail; 95% → crit e-mail (escalation)
await mock('/_cf', { w: [W('seascout', 'success', 60000), W('seascout-cache', 'success', 15000)], d: [D(20000, 300)] });
h = await run();
let m = await opsMail();
ok('75% requests → warn', alert(h, 'requests_day').level === 'warn' && h.run.level === 'warn', alert(h, 'requests_day'));
ok('warn e-mailed once', m.length === mail0 + 1 && /🟠/.test(m[m.length - 1].subject) && /75,000 \/ 100,000/.test(m[m.length - 1].text), m[m.length - 1]);
await run();
ok('same warn again → no repeat e-mail', (await opsMail()).length === mail0 + 1);
await mock('/_cf', { w: [W('seascout', 'success', 80000), W('seascout-cache', 'success', 15000)], d: [D(20000, 300)] });
h = await run(); m = await opsMail();
ok('95% → crit and e-mailed again', alert(h, 'requests_day').level === 'crit' && m.length === mail0 + 2 && /🔴/.test(m[m.length - 1].subject), alert(h, 'requests_day'));

// CPU limit hits (Error 1102) are counted from the exceededResources status
await mock('/_cf', { w: [W('seascout', 'success', 3000), W('seascout', 'exceededResources', 3, { cpu: 14800 })], d: [D(20000, 300)] });
h = await run(); m = await opsMail();
ok('exceededResources → cpu_limit warn with count', alert(h, 'cpu_limit').level === 'warn' && /วันนี้ 3 ครั้ง/.test(alert(h, 'cpu_limit').message), alert(h, 'cpu_limit'));
ok('requests back to normal → "cleared" e-mail', /หายแล้ว/.test(m[m.length - 1].text) && /คำขอ Worker/.test(m[m.length - 1].text), m[m.length - 1] && m[m.length - 1].text);

// a data server goes down: first check warn (no mail), second crit (mail), back up → cleared
await mock('/_cf', { w: [W('seascout', 'success', 3000)], d: [D(20000, 300)] });
await run();   // settle cpu_limit back to ok
let before = (await opsMail()).length;
await mock('/_probe', { pb: 'down' });
h = await run();
ok('probe down once → warn, not e-mailed', alert(h, 'probe:pb').level === 'warn' && (await opsMail()).length === before, alert(h, 'probe:pb'));
h = await run(); m = await opsMail();
ok('probe down twice → crit + e-mail names the server', alert(h, 'probe:pb').level === 'crit' && m.length === before + 1 && /Probe B ใช้ไม่ได้ \(HTTP 503\)/.test(m[m.length - 1].text), m[m.length - 1] && m[m.length - 1].text);
await mock('/_probe', { pb: 'wrong' });
h = await run();
ok('wrong page content counts as down (still crit, no repeat mail)', alert(h, 'probe:pb').level === 'crit' && (await opsMail()).length === before + 1);
await mock('/_probe', { pb: 'ok' });
h = await run(); m = await opsMail();
ok('probe back → ok + cleared e-mail', alert(h, 'probe:pb').level === 'ok' && m.length === before + 2 && /หายแล้ว: Probe B ปกติ/.test(m[m.length - 1].text), m[m.length - 1] && m[m.length - 1].text);

// GraphQL failure is reported, not hidden
await mock('/_cf', { error: 'authentication error' });
h = await run();
ok('usage API error → usage_api warn with message', alert(h, 'usage_api').level === 'warn' && /authentication error/.test(alert(h, 'usage_api').message) && h.last.usage.error === 'authentication error', alert(h, 'usage_api'));
await mock('/_cf', { w: [W('seascout', 'success', 3000)], d: [D(20000, 300)] });

// trend + snapshot storage
h = (await call('GET', '/api/v1/admin/health', { token: A })).j;
ok('24 h trend has every run', h.trend.length >= 12, h.trend.length);
ok('snapshot JSON has no secrets', !JSON.stringify(h.last).includes('cf-analytics-test') && !JSON.stringify(h.last).includes('re_test'));

// cron hook + feature flag
d1(`UPDATE feature_flags SET enabled = 0 WHERE key = 'monitor'`);
let n0 = d1('SELECT COUNT(*) AS n FROM health_snapshots')[0].n;
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(1500);
ok('flag off → cron takes no snapshot', d1('SELECT COUNT(*) AS n FROM health_snapshots')[0].n === n0);
d1(`UPDATE feature_flags SET enabled = 1 WHERE key = 'monitor'`);
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
ok('flag on → cron takes a snapshot', d1('SELECT COUNT(*) AS n FROM health_snapshots')[0].n === n0 + 1);
const aud = d1(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'health_run'`)[0].n;
ok('manual runs are audited', aud >= 10, aud);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
