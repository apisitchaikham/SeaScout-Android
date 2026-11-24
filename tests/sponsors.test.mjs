// Sea Scout — self-serve sponsor banners (r14.15.75): submit → automatic check (words, page, Safe Browsing, AI)
// → Stripe Checkout → signed webhook → live in the rotation → clicks/views → expiry, reminders, re-check, admin.
// Usage: node tests/sponsors.test.mjs <api-base e.g. http://127.0.0.1:8788> <mock-base>
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { textCheck, linkShape, parseVerdict } from '../worker/api/sponsor_check.js';
const [BASE, MOCK] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 500))); };
const ip = () => '10.81.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
async function call(method, path, { body, token, raw, headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': ip(), ...headers };
  if (body !== undefined || raw !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString()); } catch (_) {}
  return { s: r.status, j, h: r.headers, buf };
}
const mock = (p, b) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const mstate = async () => (await fetch(MOCK + '/_state')).json();
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'seascout-db', '--local', '-c', 'wrangler.test.jsonc', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WEBP = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), crypto.randomBytes(64)]).toString('base64');
const HTML = (title, body) => ({ html: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>` });
const ad = (o = {}) => ({ business: 'ร้านอุปกรณ์ตกปลาบางแสน', link: 'https://bangsaen-tackle.test/shop', email: `shop${Math.random().toString(36).slice(2, 7)}@example.com`, image: WEBP, accept_terms: true, ...o });
const submit = (o) => call('POST', '/api/v1/sponsor/submit', { body: ad(o) });
const sign = (payload, secret = 'whsec_test_seascout', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const webhook = (o, type = 'checkout.session.completed', sigOverride) => {
  const raw = JSON.stringify({ id: 'evt_' + Math.random().toString(36).slice(2), type, data: { object: o } });
  return call('POST', '/api/v1/sponsor/stripe', { raw, headers: { 'Stripe-Signature': sigOverride || sign(raw) } });
};
const session = (adId, id, extra = {}) => ({ id, object: 'checkout.session', payment_status: 'paid', amount_total: 500000, currency: 'thb', client_reference_id: adId, metadata: { ad_id: adId, days: '30' }, ...extra });
const adsList = async () => (await call('GET', '/api/v1/sponsor/ads')).j;
const DAY = 86400e3;

// ---------- pure ----------
ok('words: Thai gambling caught', !textCheck('เว็บตรง สล็อต แตกง่าย').ok && !textCheck('UFABET168').ok && !textCheck('บาคาร่าออนไลน์').ok);
ok('words: fishing shop passes', textCheck('ร้านอุปกรณ์ตกปลา เบ็ด รอก เหยื่อ ยิงปลา').ok && textCheck('Pro Fishing Gear · best bait').ok);
ok('link shape: https only, no IP', linkShape('http://a.com') && linkShape('https://1.2.3.4/x') && !linkShape('https://shopee.co.th/abc'));
ok('AI verdict parsed from text or JSON', parseVerdict({ response: 'ok {"allowed":false,"category":"x"}' }).allowed === false && parseVerdict({ choices: [{ message: { content: '{"allowed":true}' } }] }).allowed === true && parseVerdict({ response: 'no json' }) === null);

// ---------- setup ----------
d1(`DELETE FROM sponsor_ads; DELETE FROM sponsor_payments; DELETE FROM rate_limits; UPDATE feature_flags SET enabled = 1 WHERE key = 'sponsor_ads';
    INSERT OR REPLACE INTO app_settings (key, value) VALUES ('sponsor_price_thb','5000'),('sponsor_days','30'),('sponsor_max','0'),('sponsor_rotate_s','10')`);
await mock('/_ai', { mode: 'allow' });
await mock('/_pages', {
  'bangsaen-tackle.test': HTML('ร้านอุปกรณ์ตกปลาบางแสน', 'รอก เบ็ด เหยื่อปลอม สาย PE ส่งทั่วประเทศ ราคาไม่แพง bet on quality'),
  'fish-club.test': HTML('ตกปลา', 'สมัครสมาชิก บาคาร่า ฝากถอนออโต้'),
  'weak.test': HTML('Lucky', 'bet now jackpot poker lottery'),
  'redirect.test': { ...HTML('x', 'ok'), final: 'http://insecure.test/landing' },
  'gone.test': { ...HTML('err', 'error'), status: 500 },
});
let adm = null;
{
  const rnd = Math.random().toString(36).slice(2, 7), em = `sp.${rnd}@example.com`, em2 = `spa.${rnd}@example.com`, pw = 'sponsor-owner-123';
  await call('POST', '/api/v1/auth/register', { body: { email: em, password: pw, privacy_consent: true } });
  await call('POST', '/api/v1/auth/register', { body: { email: em2, password: pw, privacy_consent: true } });
  d1(`INSERT INTO admin_users (id, email, role, created_at) VALUES ('adm_p${rnd}', '${em}', 'owner', 0), ('adm_q${rnd}', '${em2}', 'admin', 0)`);
  adm = { owner: (await call('POST', '/api/v1/admin/login', { body: { email: em, password: pw } })).j.token, admin: (await call('POST', '/api/v1/admin/login', { body: { email: em2, password: pw } })).j.token };
}
ok('admin logins', !!adm.owner && !!adm.admin);
await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_rotate_s: 10 }, token: adm.owner });   // drops the server's 2-min list cache left by an earlier run

// ---------- empty rotation → app shows the "advertise here" card ----------
let L = await adsList();
ok('ads: none yet, price/days/rotation/advertise link given', L.enabled && L.ads.length === 0 && L.price_thb === 5000 && L.days === 30 && L.rotate_s === 10 && L.advertise_url === 'https://seascout.test/advertise.html', L);

// ---------- input validation ----------
ok('terms must be accepted', (await submit({ accept_terms: false })).j.error === 'terms_required');
ok('image must really be an image', (await submit({ image: 'data:image/png;base64,' + Buffer.from('<svg></svg>').toString('base64') })).j.error === 'image_invalid');
ok('image ≤ 300 KB', (await submit({ image: 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(320 * 1024)]).toString('base64') })).s === 413);
ok('SVG / other types refused', (await submit({ image: 'data:image/svg+xml;base64,PHN2Zz4=' })).j.error === 'image_required');

// ---------- checks ----------
let r = await submit();
const good = r.j;
ok('good shop → 201 awaiting_payment + private token + status link', r.s === 201 && good.status === 'awaiting_payment' && /^[A-Za-z0-9_-]{32}$/.test(good.token) && good.manage_url === 'https://seascout.test/advertise.html#t=' + good.token, r.j);
let st = await mstate();
const aiIn = st.aiCalls[st.aiCalls.length - 1];
ok('AI saw the banner image + shop text + page title', aiIn.messages[1].content[1].image_url.url === WEBP && /บางแสน/.test(aiIn.messages[1].content[0].text) && /Linked page title: ร้านอุปกรณ์ตกปลาบางแสน/.test(aiIn.messages[1].content[0].text));
ok('one weak word ("bet") on the page is not enough to refuse', good.status === 'awaiting_payment');
const mail1 = st.emails[st.emails.length - 1];
ok('e-mail to the shop with its status link', mail1.text.includes('#t=' + good.token) && /ผ่านการตรวจ/.test(mail1.subject), mail1 && mail1.subject);

r = await submit({ business: 'UFABET ตกปลา' });
ok('gambling word in the name → rejected', r.j.status === 'rejected' && /คำที่ไม่อนุญาต/.test(r.j.reason), r.j);
r = await submit({ link: 'https://fish-club.test/' });
ok('link page with บาคาร่า → rejected', r.j.status === 'rejected' && /หน้าเว็บของลิงก์/.test(r.j.reason), r.j);
r = await submit({ link: 'https://weak.test/' });
ok('page with 3+ betting words → rejected', r.j.status === 'rejected' && /เว็บพนัน/.test(r.j.reason), r.j);
r = await submit({ link: 'https://redirect.test/' });
ok('link that ends on http:// → rejected', r.j.status === 'rejected' && /https/.test(r.j.reason), r.j);
r = await submit({ link: 'https://gone.test/' });
ok('link that does not open → rejected with reason', r.j.status === 'rejected' && /HTTP 500/.test(r.j.reason), r.j);
r = await submit({ link: 'https://malware-bait.test/' });
ok('Google Safe Browsing hit → rejected', r.j.status === 'rejected' && /Google/.test(r.j.reason), r.j);
r = await submit({ link: 'https://www.facebook.com/bangsaenfishing' });
ok('Facebook page (blocks robots) is accepted unread', r.j.status === 'awaiting_payment', r.j);
await mock('/_ai', { mode: 'deny' });
r = await submit();
ok('AI says gambling banner → rejected with its Thai reason', r.j.status === 'rejected' && /รูปโฆษณาเป็นเว็บพนัน/.test(r.j.reason), r.j);
await mock('/_ai', { mode: 'error' });
r = await submit();
const waiting = r.j;
ok('AI down → stays "checking"', waiting.status === 'checking', r.j);
d1(`UPDATE sponsor_ads SET updated_at = 0 WHERE id = '${waiting.id}'`);
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
ok('cron retries (try 2, still checking)', d1(`SELECT status, check_tries FROM sponsor_ads WHERE id = '${waiting.id}'`)[0].check_tries === 2);
d1(`UPDATE sponsor_ads SET updated_at = 0 WHERE id = '${waiting.id}'`);
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
const w3 = d1(`SELECT status, check_json FROM sponsor_ads WHERE id = '${waiting.id}'`)[0];
ok('after 3 tries the rule checks decide (passed → awaiting_payment, noted)', w3.status === 'awaiting_payment' && /rules_only/.test(w3.check_json), w3);
await mock('/_ai', { mode: 'allow' });

// ---------- status page ----------
r = await call('POST', '/api/v1/sponsor/status', { body: { t: good.token } });
ok('status by token', r.s === 200 && r.j.status === 'awaiting_payment' && r.j.can_pay && r.j.image === WEBP && r.j.price_thb === 5000);
ok('wrong token → 404', (await call('POST', '/api/v1/sponsor/status', { body: { t: 'x'.repeat(32) } })).s === 404);
ok('not live before paying', (await adsList()).ads.length === 0);
ok('banner image not public before paying', (await call('GET', `/api/v1/sponsor/img/${good.id}`)).s === 404);

// ---------- pay ----------
r = await call('POST', '/api/v1/sponsor/pay', { body: { t: good.token } });
st = await mstate();
const cs = st.stripe[st.stripe.length - 1];
ok('pay → Stripe Checkout URL', r.s === 200 && /^https:\/\/checkout\.stripe\.com\//.test(r.j.url), r.j);
ok('Checkout: 5,000 THB (500000 satang), ad id in metadata, back to the status page', cs['line_items[0][price_data][unit_amount]'] === '500000' && cs['line_items[0][price_data][currency]'] === 'thb' && cs['metadata[ad_id]'] === good.id && cs.success_url === good.manage_url + '&paid=1' && cs.mode === 'payment', cs);
ok('rejected ad cannot pay', (await call('POST', '/api/v1/sponsor/pay', { body: { t: (await submit({ business: 'สล็อตเว็บตรง' })).j.token } })).s === 409);

// webhook
ok('webhook: bad signature refused', (await webhook(session(good.id, 'cs_test_1'), undefined, sign('{}'))).s === 400);
ok('webhook: old timestamp refused', (await webhook(session(good.id, 'cs_test_1'), undefined, 't=1,v1=00')).s === 400);
ok('webhook: unpaid session ignored', (await webhook(session(good.id, 'cs_test_x', { payment_status: 'unpaid' }))).j.ignored === 'checkout.session.completed');
r = await webhook(session(good.id, 'cs_test_1'));
let row = d1(`SELECT status, paid_until, paid_total FROM sponsor_ads WHERE id = '${good.id}'`)[0];
ok('paid → active for 30 days', r.s === 200 && row.status === 'active' && Math.abs(row.paid_until - (Date.now() + 30 * DAY)) < 120e3 && row.paid_total === 500000, row);
r = await webhook(session(good.id, 'cs_test_1'));
ok('same payment again (Stripe retry) does not extend', r.j.duplicate === true && d1(`SELECT paid_until FROM sponsor_ads WHERE id = '${good.id}'`)[0].paid_until === row.paid_until);
r = await webhook(session(good.id, 'cs_test_2'), 'checkout.session.async_payment_succeeded');
const row2 = d1(`SELECT paid_until FROM sponsor_ads WHERE id = '${good.id}'`)[0];
ok('renewal (PromptPay async) adds 30 days after the current end', Math.abs(row2.paid_until - row.paid_until - 30 * DAY) < 5e3, [row.paid_until, row2.paid_until]);
st = await mstate();
ok('paid e-mail sent', /ชำระเงินแล้ว/.test(st.emails[st.emails.length - 1].subject));

// second shop goes live too → both rotate
const fb = d1(`SELECT id FROM sponsor_ads WHERE link LIKE 'https://www.facebook.com/%' LIMIT 1`)[0].id;
await webhook(session(fb, 'cs_test_3'));
await sleep(200);
d1(`UPDATE app_settings SET value = '10' WHERE key = 'sponsor_rotate_s'`);   // (cache: 2 min) — use admin to drop it
await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_rotate_s: 10 }, token: adm.owner });
L = await adsList();
ok('both paid banners in the app rotation', L.ads.length === 2 && L.ads.every((a) => /\/api\/v1\/sponsor\/img\/spn_.+\?v=[0-9a-f]{16}$/.test(a.img) && /\/sponsor\/go\/spn_/.test(a.go)), L);
r = await call('GET', new URL(L.ads.find((a) => a.id === good.id).img).pathname + '?v=1');
ok('banner image served with long immutable cache', r.s === 200 && r.h.get('content-type') === 'image/webp' && /immutable/.test(r.h.get('cache-control')) && r.buf.slice(0, 4).toString() === 'RIFF');
r = await call('GET', `/api/v1/sponsor/go/${good.id}?p=android`);
ok('click → 302 to the shop link, counted', r.s === 302 && r.h.get('location') === 'https://bangsaen-tackle.test/shop' && d1(`SELECT clicks FROM sponsor_ads WHERE id = '${good.id}'`)[0].clicks === 1);
r = await call('POST', '/api/v1/sponsor/seen', { body: { [good.id]: 7, [fb]: 9999, junk: 5 } });
row = d1(`SELECT id, impressions FROM sponsor_ads WHERE id IN ('${good.id}','${fb}')`);
ok('views batch: counted, capped at 500 per report, junk ignored', r.s === 200 && row.find((x) => x.id === good.id).impressions === 7 && row.find((x) => x.id === fb).impressions === 500, row);
r = await call('POST', '/api/v1/sponsor/status', { body: { t: good.token } });
ok('shop sees its views/clicks/payments', r.j.impressions === 7 && r.j.clicks === 1 && r.j.payments.length === 2 && r.j.status === 'active', [r.j.impressions, r.j.clicks, r.j.payments, r.j.status]);

// ---------- limit ----------
ok('settings: admin (not owner) cannot change price', (await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_price_thb: 1 }, token: adm.admin })).s === 403);
ok('settings: price out of range refused', (await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_price_thb: 5 }, token: adm.owner })).s === 400);
await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_max: 2 }, token: adm.owner });
const third = (await submit()).j;
ok('max 2 live → third shop told "full"', (await call('POST', '/api/v1/sponsor/pay', { body: { t: third.token } })).j.error === 'full');
ok('…but a live shop can still renew', (await call('POST', '/api/v1/sponsor/pay', { body: { t: good.token } })).s === 200);
await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_max: 0, sponsor_price_thb: 5000 }, token: adm.owner });

// ---------- cron: re-check live links, reminders, expiry ----------
await mock('/_pages', { 'bangsaen-tackle.test': HTML('ตกปลา', 'เว็บตรง สล็อต เครดิตฟรี') });
d1(`UPDATE sponsor_ads SET checked_at = 0 WHERE id = '${good.id}'; UPDATE sponsor_ads SET checked_at = ${Date.now()} WHERE id <> '${good.id}'`);
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
row = d1(`SELECT status, reason FROM sponsor_ads WHERE id = '${good.id}'`)[0];
ok('live shop changed its page to gambling → suspended at once', row.status === 'suspended' && /หน้าเว็บ/.test(row.reason), row);
ok('suspended banner leaves the rotation', !(await adsList()).ads.some((a) => a.id === good.id));
st = await mstate();
ok('shop e-mailed about the suspension', /ระงับ/.test(st.emails[st.emails.length - 1].subject));
d1(`UPDATE sponsor_ads SET paid_until = ${Date.now() + 2 * DAY}, reminded_at = 0 WHERE id = '${fb}'`);
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
st = await mstate();
ok('reminder 3 days before the end (once)', /ใกล้หมดอายุ/.test(st.emails[st.emails.length - 1].subject) && d1(`SELECT reminded_at FROM sponsor_ads WHERE id = '${fb}'`)[0].reminded_at > 0);
d1(`UPDATE sponsor_ads SET paid_until = ${Date.now() - 1000} WHERE id = '${fb}'`);
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
ok('end date passed → expired, out of rotation', d1(`SELECT status FROM sponsor_ads WHERE id = '${fb}'`)[0].status === 'expired' && (await adsList()).ads.length === 0);

// ---------- admin ----------
r = await call('GET', '/api/v1/admin/sponsors', { token: adm.admin });
ok('admin list: ads, revenue, setup flags', r.s === 200 && r.j.ads.length >= 10 && r.j.revenue_30d_thb === 15000 && r.j.setup.stripe && r.j.setup.ai && r.j.setup.safe_browsing, [r.j.revenue_30d_thb, r.j.setup]);
ok('admin list has no image data (light)', !JSON.stringify(r.j).includes('image_b64'));
ok('admin can view a banner', (await call('GET', `/api/v1/admin/sponsors/${good.id}/image`, { token: adm.admin })).j.image === WEBP);
await mock('/_pages', { 'bangsaen-tackle.test': HTML('ร้านอุปกรณ์ตกปลาบางแสน', 'รอก เบ็ด') });
ok('restore suspended (page fixed)', (await call('POST', `/api/v1/admin/sponsors/${good.id}/restore`, { body: {}, token: adm.admin })).s === 200 && d1(`SELECT status FROM sponsor_ads WHERE id = '${good.id}'`)[0].status === 'active');
ok('…back in rotation', (await adsList()).ads.some((a) => a.id === good.id));
ok('remove with reason', (await call('POST', `/api/v1/admin/sponsors/${good.id}/remove`, { body: { reason: 'รูปไม่เหมาะสม' }, token: adm.admin })).s === 200 && !(await adsList()).ads.some((a) => a.id === good.id));
ok('shop sees the reason', (await call('POST', '/api/v1/sponsor/status', { body: { t: good.token } })).j.reason === 'รูปไม่เหมาะสม');
await call('POST', `/api/v1/admin/sponsors/${fb}/extend`, { body: { days: 7 }, token: adm.admin });
ok('extend (compensation) makes it live again for 7 days', d1(`SELECT status FROM sponsor_ads WHERE id = '${fb}'`)[0].status === 'active' && (await adsList()).ads.some((a) => a.id === fb));
ok('recheck runs all checks', (await call('POST', `/api/v1/admin/sponsors/${fb}/recheck`, { body: {}, token: adm.admin })).s === 200);
ok('actions audited', d1(`SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('sponsor_remove','sponsor_restore','sponsor_extend','sponsor_recheck','sponsor_paid','sponsor_submit')`)[0].n >= 15);

// ---------- switch off ----------
d1(`UPDATE feature_flags SET enabled = 0 WHERE key = 'sponsor_ads'`);
await call('PUT', '/api/v1/admin/sponsors/settings', { body: { sponsor_rotate_s: 10 }, token: adm.owner });   // drops the 2-min cache
ok('flag off → app gets enabled:false and no ads', (await adsList()).enabled === false && (await adsList()).ads.length === 0);
ok('flag off → no new submissions', (await submit()).j.error === 'sponsor_closed');
d1(`UPDATE feature_flags SET enabled = 1 WHERE key = 'sponsor_ads'`);

// ---- r14.15.77: Google AdMob settings ride along with /sponsor/ads ----
{
  const put = (b, t = adm.owner) => call('PUT', '/api/v1/admin/sponsors/settings', { body: b, token: t });
  ok('google: admin (not owner) cannot change', (await put({ gad_on: 0 }, adm.admin)).s === 403);
  ok('google: bad ad unit refused', (await put({ gad_android: 'ca-app-pub-123~456' })).s === 400);
  ok('google: app ID (with ~) refused as ad unit', (await put({ gad_ios: 'ca-app-pub-1234567890123456~1234567890' })).s === 400);
  ok('google: bad on/off refused', (await put({ gad_on: 'maybe' })).s === 400);
  ok('google: save', (await put({ gad_on: 1, gad_android: 'ca-app-pub-1234567890123456/1234567890', gad_ios: '' })).s === 200);
  let g = (await call('GET', '/api/v1/sponsor/ads')).j.google;
  ok('google: app sees on + android unit, ios empty → test banner', g && g.on === true && g.android === 'ca-app-pub-1234567890123456/1234567890' && g.ios === null, g);
  ok('google: switch off', (await put({ gad_on: 0 })).s === 200);
  g = (await call('GET', '/api/v1/sponsor/ads')).j.google;
  ok('google: app sees off', g && g.on === false, g);
  const lst = (await call('GET', '/api/v1/admin/sponsors', { token: adm.admin })).j;
  ok('google: admin list shows the settings', lst && lst.google && lst.google.on === false && !!lst.google.android, lst && lst.google);
  await put({ gad_on: 1, gad_android: '', gad_ios: '' });
  g = (await call('GET', '/api/v1/sponsor/ads')).j.google;
  ok('google: back to on + test banner', g && g.on === true && g.android === null, g);
}
// ---- r14.15.88: Admitad affiliate base links ride along with /sponsor/ads ----
{
  const put = (b, t = adm.owner) => call('PUT', '/api/v1/admin/sponsors/settings', { body: b, token: t });
  ok('aff: admin (not owner) cannot change', (await put({ aff_shopee_th: 'https://rzekl.com/g/abc123def/' }, adm.admin)).s === 403);
  ok('aff: http link refused', (await put({ aff_shopee_th: 'http://rzekl.com/g/abc123def/' })).s === 400);
  ok('aff: non-/g/ link refused', (await put({ aff_aliexpress: 'https://evil.example.com/redirect?to=x' })).s === 400);
  ok('aff: save (slash added)', (await put({ aff_shopee_th: 'https://rzekl.com/g/1e8d114494abc', aff_aliexpress: 'https://alitems.site/g/1e8d1144949f1b7a/', aff_banggood: '' })).s === 200);
  const a = (await call('GET', '/api/v1/sponsor/ads')).j.aff;
  ok('aff: app sees links, empty → null', a && a.shopee_th === 'https://rzekl.com/g/1e8d114494abc/' && a.aliexpress === 'https://alitems.site/g/1e8d1144949f1b7a/' && a.banggood === null, a);
  const lst = (await call('GET', '/api/v1/admin/sponsors', { token: adm.admin })).j;
  ok('aff: admin list shows links', lst && lst.aff && lst.aff.shopee_th, lst && lst.aff);
  await put({ aff_shopee_th: '', aff_aliexpress: '' });
  const b = (await call('GET', '/api/v1/sponsor/ads')).j.aff;
  ok('aff: cleared', b && b.shopee_th === null && b.aliexpress === null, b);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
