// Sea Scout · system health monitor (r14.15.73).
// Runs inside the existing 30-minute cron (no extra cron trigger). Each run:
//   1. today's usage for the whole Cloudflare account (all Workers + D1) from the GraphQL Analytics API —
//      only if CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN (read-only "Account Analytics" token) are set;
//   2. a light check of the data servers the app depends on (version / health pages, 8 s timeout, in parallel);
//   3. app crash reports of the last hour (counted by /api/crash into crash_counts);
// then stores one snapshot row and updates one row per alert rule. Emails go out only when ALERT_EMAIL and the
// existing Resend settings (RESEND_API_KEY + EMAIL_FROM) are set, and only when an alert starts, gets worse,
// repeats after 12 h, or clears. Never stores secrets or personal data. Free-plan budget per run: ≤ 7 subrequests,
// ≈ 15 D1 rows written, ≈ 100 rows read.

// Free plan limits per UTC day (Workers requests are per account, D1 rows per account).
export const LIMITS = { requests: 100000, d1_reads: 5000000, d1_writes: 100000 };
const WARN = 0.7, CRIT = 0.9, DAY = 86400e3, HOUR = 3600e3;
const REMIND_MS = 12 * HOUR;

// The data servers the app reads (directly or through the seascout-cache Worker). Light endpoints only.
export const PROBES = [
  { id: 'cache_proxy', name: 'Sea Scout data proxy (seascout-cache)', url: 'https://seascout-cache.apisit-chaikham.workers.dev/api/health', expect: '"ok":true' },
  { id: 'noaa_tides', name: 'NOAA Tides & Currents', url: 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290.json', expect: '9414290' },
  { id: 'coastwatch', name: 'NOAA CoastWatch ERDDAP (SST/CHL)', url: 'https://coastwatch.noaa.gov/erddap/version', expect: 'ERDDAP_version' },
  { id: 'oceanwatch', name: 'NOAA OceanWatch ERDDAP', url: 'https://oceanwatch.pifsc.noaa.gov/erddap/version', expect: 'ERDDAP_version' },
  { id: 'pacioos', name: 'PacIOOS ERDDAP (wind/waves)', url: 'https://pae-paha.pacioos.hawaii.edu/erddap/version', expect: 'ERDDAP_version' },
];

const enabled = async (db) => { const f = await db.prepare(`SELECT enabled FROM feature_flags WHERE key = 'monitor'`).first(); return !f || !!f.enabled; };
const pct = (n, lim) => Math.round((n / lim) * 1000) / 10;
const lvlRank = { ok: 0, warn: 1, crit: 2 };
const worst = (a, b) => (lvlRank[b] > lvlRank[a] ? b : a);

// ---------- 1. usage (Cloudflare GraphQL Analytics) ----------
const USAGE_QUERY = `query SeaScoutUsage($a: string!, $s: Time!, $e: Time!, $d: Date!) {
  viewer { accounts(filter: { accountTag: $a }) {
    w: workersInvocationsAdaptive(limit: 200, filter: { datetime_geq: $s, datetime_leq: $e }) {
      sum { requests errors subrequests } quantiles { cpuTimeP99 } dimensions { scriptName status } }
    d: d1AnalyticsAdaptiveGroups(limit: 50, filter: { date_geq: $d, date_leq: $d }) {
      sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }
  } } }`;

export async function fetchUsage(env, now) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return { configured: false };
  const day0 = Math.floor(now / DAY) * DAY;
  const vars = { a: env.CF_ACCOUNT_ID, s: new Date(day0).toISOString(), e: new Date(now).toISOString(), d: new Date(day0).toISOString().slice(0, 10) };
  try {
    const r = await fetch(env.CF_GRAPHQL_URL || 'https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_ANALYTICS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: USAGE_QUERY, variables: vars }), signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || (j.errors && j.errors.length)) {
      const msg = j && j.errors && j.errors[0] ? String(j.errors[0].message).slice(0, 200) : 'HTTP ' + r.status;
      return { configured: true, error: msg };
    }
    const acc = (j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0]) || {};
    const u = { configured: true, day: vars.d, requests: 0, errors: 0, exceeded: 0, threw: 0, cpu_p99_ms: 0, scripts: {}, d1_reads: 0, d1_writes: 0 };
    for (const g of acc.w || []) {
      const n = (g.sum && g.sum.requests) || 0, st = (g.dimensions && g.dimensions.status) || '', sc = (g.dimensions && g.dimensions.scriptName) || '?';
      u.requests += n; u.scripts[sc] = (u.scripts[sc] || 0) + n;
      if (st === 'exceededResources') u.exceeded += n;
      if (st === 'scriptThrewException') u.threw += n;
      u.errors += (g.sum && g.sum.errors) || 0;
      const p = g.quantiles && g.quantiles.cpuTimeP99;                       // microseconds
      if (p && sc === (env.CF_SCRIPT_NAME || 'seascout')) u.cpu_p99_ms = Math.max(u.cpu_p99_ms, Math.round(p / 100) / 10);
    }
    for (const g of acc.d || []) { u.d1_reads += (g.sum && g.sum.rowsRead) || 0; u.d1_writes += (g.sum && g.sum.rowsWritten) || 0; }
    return u;
  } catch (e) { return { configured: true, error: String((e && e.message) || e).slice(0, 200) }; }
}

// ---------- 2. data servers ----------
export async function runProbes(env) {
  let list = PROBES;
  if (env.MONITOR_PROBES) { try { list = JSON.parse(env.MONITOR_PROBES); } catch (_) {} }
  return Promise.all(list.map(async (p) => {
    const t = Date.now();
    try {
      const r = await fetch(p.url, { headers: { 'User-Agent': 'SeaScout-Monitor/1 (+https://seascout.apisit-chaikham.workers.dev)' }, signal: AbortSignal.timeout(8000) });
      const body = (await r.text()).slice(0, 4000);
      const ok = r.ok && (!p.expect || body.includes(p.expect));
      return { id: p.id, name: p.name, ok, status: r.status, ms: Date.now() - t };
    } catch (e) { return { id: p.id, name: p.name, ok: false, status: 0, ms: Date.now() - t, error: String((e && e.name) || e).slice(0, 60) }; }
  }));
}

// ---------- 3. crash reports (called from /api/crash) ----------
let isoMin = 0, isoCount = 0;   // per-isolate throttle: a crash loop cannot turn into thousands of D1 writes
export async function countCrash(env, j) {
  if (!env.DB || !j || typeof j !== 'object') return;
  const m = Math.floor(Date.now() / 60e3);
  if (m !== isoMin) { isoMin = m; isoCount = 0; }
  if (++isoCount > 120) return;
  const kind = String(j.k || 'error').replace(/[^\w.-]/g, '').slice(0, 24) || 'error';
  const msg = String(j.m || '').replace(/\s+/g, ' ').replace(/https?:\/\/\S+/g, '<url>').replace(/\d{3,}/g, '#').trim().slice(0, 80);
  const key = kind + ': ' + (msg || '(no message)');
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const sample = JSON.stringify({ m: String(j.m || '').slice(0, 300), src: String(j.src || '').slice(0, 120), app: String(j.app || '').slice(0, 40), plat: String(j.plat || '').slice(0, 20), lang: String(j.lang || '').slice(0, 8) });
  try {
    await env.DB.prepare(`INSERT INTO crash_counts (hour, key, n, sample) VALUES (?, ?, 1, ?)
      ON CONFLICT(hour, key) DO UPDATE SET n = n + 1 WHERE n < 1000`).bind(hour, key, sample).run();
  } catch (_) { /* table not created yet: ignore */ }
}

// ---------- rules ----------
function usageRule(id, label, n, lim, frac) {
  const p = pct(n, lim);
  // projection to the end of the UTC day (only after 3 h, so an early burst does not look like a trend)
  const proj = frac >= 0.125 ? Math.round(n / frac) : null;
  let level = p >= CRIT * 100 ? 'crit' : p >= WARN * 100 ? 'warn' : 'ok';
  if (level === 'ok' && proj != null && proj > lim) level = 'warn';
  const tail = proj != null && level !== 'ok' ? ` · คาดว่าทั้งวัน ≈ ${proj.toLocaleString('en-US')}` : '';
  return { id, level, email: 'warn', message: `${label} วันนี้ ${n.toLocaleString('en-US')} / ${lim.toLocaleString('en-US')} (${p}%)${tail}` };
}

export function evaluate(snap, prevAlerts) {
  const out = [];
  const u = snap.usage || {};
  if (u.configured && !u.error) {
    out.push(usageRule('requests_day', 'คำขอ Worker ทั้งบัญชี', u.requests, LIMITS.requests, snap.day_frac));
    out.push(usageRule('d1_reads', 'D1 แถวที่อ่าน', u.d1_reads, LIMITS.d1_reads, snap.day_frac));
    out.push(usageRule('d1_writes', 'D1 แถวที่เขียน', u.d1_writes, LIMITS.d1_writes, snap.day_frac));
    out.push({ id: 'cpu_limit', email: 'warn', level: u.exceeded >= 20 ? 'crit' : u.exceeded >= 1 ? 'warn' : 'ok',
      message: `คำขอที่ใช้ CPU เกินโควตา (Error 1102) วันนี้ ${u.exceeded} ครั้ง · CPU p99 ของเว็บ ${u.cpu_p99_ms} ms (โควตาฟรี 10 ms)` });
    out.push({ id: 'script_errors', email: 'crit', level: u.threw >= 50 ? 'crit' : u.threw >= 10 ? 'warn' : 'ok', message: `โค้ดเซิร์ฟเวอร์ผิดพลาด (Error 1101) วันนี้ ${u.threw} ครั้ง` });
  } else if (u.configured && u.error) {
    out.push({ id: 'usage_api', email: 'crit', level: 'warn', message: 'อ่านสถิติการใช้งานจาก Cloudflare ไม่ได้: ' + u.error });
  } else {
    out.push({ id: 'usage_api', email: 'crit', level: 'ok', message: 'ยังไม่ได้ตั้ง CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN (ไม่มีตัวเลขการใช้งาน)' });
  }
  for (const p of snap.probes || []) {
    const id = 'probe:' + p.id, prev = prevAlerts[id];
    // one failed check = warn (admin page only); failing twice in a row (≥ 30 min) = crit (email)
    const level = p.ok ? 'ok' : prev && prev.level !== 'ok' ? 'crit' : 'warn';
    out.push({ id, email: 'crit', level, message: p.ok ? `${p.name} ปกติ (${p.ms} ms)` : `${p.name} ใช้ไม่ได้ (HTTP ${p.status || p.error || '—'})` });
  }
  const c = snap.crashes || { last_hour: 0 };
  out.push({ id: 'crashes', email: 'crit', level: c.last_hour >= 100 ? 'crit' : c.last_hour >= 30 ? 'warn' : 'ok',
    message: `แอปแครช/ผิดพลาดชั่วโมงล่าสุด ${c.last_hour} ครั้ง` + (c.top ? ` · มากสุด: ${c.top}` : '') });
  return out;
}

// ---------- email ----------
async function email(env, subject, lines) {
  if (!env.ALERT_EMAIL || !env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="color:#0b84a5">Sea Scout · สุขภาพระบบ</h2><ul>${lines.map((l) => `<li>${l.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</li>`).join('')}</ul><p style="color:#678">ดูรายละเอียดในหน้าแอดมิน → แท็บ “สุขภาพระบบ”</p></div>`;
  try {
    const r = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: String(env.ALERT_EMAIL).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3), subject, html, text: lines.join('\n') }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch (_) { return false; }
}

// ---------- the tick ----------
export async function monitorTick(env, { force = false } = {}) {
  const db = env.DB, now = Date.now();
  if (!db) return { skipped: 'no_db' };
  if (!force && !(await enabled(db))) return { skipped: 'flag_off' };
  const hour = Math.floor(now / HOUR) * HOUR;
  const [usage, probes, crashRows] = await Promise.all([
    fetchUsage(env, now),
    runProbes(env),
    db.prepare('SELECT key, SUM(n) AS n FROM crash_counts WHERE hour >= ? GROUP BY key ORDER BY n DESC LIMIT 5').bind(hour - HOUR).all().then((r) => r.results || []).catch(() => []),
  ]);
  const crashes = { last_hour: crashRows.reduce((s, r) => s + (r.n || 0), 0), top: crashRows[0] ? `${crashRows[0].key} (${crashRows[0].n})` : null };
  const snap = { at: now, day_frac: (now % DAY) / DAY, usage, probes, crashes };

  const { results: prevRows } = await db.prepare('SELECT * FROM monitor_alerts').all();
  const prev = Object.fromEntries((prevRows || []).map((r) => [r.id, r]));
  const alerts = evaluate(snap, prev);
  let level = 'ok';
  const rows = [], mail = [];
  for (const a of alerts) {
    level = worst(level, a.level);
    const p = prev[a.id] || null;
    const row = { a, p, since: p && p.level === a.level ? p.since : now, nAt: p ? p.notified_at : null, nLvl: p ? p.notified_level : null, mailed: false };
    const mailable = lvlRank[a.level] >= lvlRank[a.email];
    if (mailable && (!row.nLvl || lvlRank[a.level] > lvlRank[row.nLvl] || now - (row.nAt || 0) >= REMIND_MS)) {
      mail.push((a.level === 'crit' ? '🔴 ' : '🟠 ') + a.message); row.nAt = now; row.nLvl = a.level; row.mailed = true;
    } else if (a.level === 'ok' && row.nLvl) {
      mail.push('🟢 หายแล้ว: ' + a.message); row.nAt = null; row.nLvl = null; row.mailed = true;
    }
    rows.push(row);
  }
  let emailed = false;
  if (mail.length) emailed = await email(env, `Sea Scout ${level === 'crit' ? '🔴 แจ้งเตือนด่วน' : level === 'warn' ? '🟠 แจ้งเตือน' : '🟢 ระบบกลับมาปกติ'}`, mail);
  const stmts = [];
  for (const r of rows) {
    // no e-mail set up (or the send failed): keep the old notified state, so it is sent once e-mail works
    if (r.mailed && !emailed) { r.nAt = r.p ? r.p.notified_at : null; r.nLvl = r.p ? r.p.notified_level : null; }
    const p = r.p, a = r.a;
    if (p && p.level === a.level && p.message === a.message && p.notified_at === r.nAt && p.notified_level === r.nLvl) continue;   // unchanged: no write
    stmts.push(db.prepare(`INSERT INTO monitor_alerts (id, level, message, since, updated_at, notified_at, notified_level) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET level=excluded.level, message=excluded.message, since=excluded.since, updated_at=excluded.updated_at,
      notified_at=excluded.notified_at, notified_level=excluded.notified_level`).bind(a.id, a.level, a.message, r.since, now, r.nAt, r.nLvl));
  }
  stmts.push(db.prepare('INSERT OR REPLACE INTO health_snapshots (at, level, data) VALUES (?,?,?)').bind(now, level, JSON.stringify({ ...snap, alerts: alerts.map(({ id, level: l, message }) => ({ id, level: l, message })) })));
  // housekeeping once an hour: 7 days of snapshots, 14 days of crash counts
  if (now - hour < 30 * 60e3) {
    stmts.push(db.prepare('DELETE FROM health_snapshots WHERE at < ?').bind(now - 7 * DAY));
    stmts.push(db.prepare('DELETE FROM crash_counts WHERE hour < ?').bind(now - 14 * DAY));
  }
  await db.batch(stmts);
  return { level, alerts: alerts.filter((a) => a.level !== 'ok').length, emailed, probes_down: probes.filter((p) => !p.ok).map((p) => p.id), usage: usage.configured ? (usage.error ? 'error' : 'ok') : 'not_configured' };
}

// ---------- admin read ----------
export async function healthView(env) {
  const db = env.DB, now = Date.now();
  const last = await db.prepare('SELECT at, level, data FROM health_snapshots ORDER BY at DESC LIMIT 1').first();
  const { results: trend } = await db.prepare('SELECT at, level FROM health_snapshots WHERE at > ? ORDER BY at').bind(now - DAY).all();
  const { results: alerts } = await db.prepare('SELECT id, level, message, since, updated_at, notified_at FROM monitor_alerts ORDER BY CASE level WHEN \'crit\' THEN 0 WHEN \'warn\' THEN 1 ELSE 2 END, id').all();
  const { results: crashes } = await db.prepare('SELECT key, SUM(n) AS n, MAX(hour) AS last_hour, MAX(sample) AS sample FROM crash_counts WHERE hour >= ? GROUP BY key ORDER BY n DESC LIMIT 20').bind(now - DAY).all();
  return {
    at: now, limits: LIMITS,
    setup: { usage: !!(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN), email: !!(env.ALERT_EMAIL && env.RESEND_API_KEY && env.EMAIL_FROM) },
    last: last ? { at: last.at, level: last.level, ...JSON.parse(last.data) } : null,
    trend: trend || [], alerts: alerts || [], crashes_24h: crashes || [],
  };
}
