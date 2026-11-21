// Sea Scout — country-aware marketplace links (r14.15.74): Involve Asia / Admitad / Amazon deeplinks to each
// country's top shops, stored as per-country catalogue items; admin control; click redirect; cron + flag.
// Usage: node tests/markets.test.mjs <api-base e.g. http://127.0.0.1:8788> <mock-base>
import { execFileSync } from 'node:child_process';
import { searchUrl, pickProgram } from '../worker/api/markets.js';
const [BASE, MOCK] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 500))); };
async function call(method, path, { body, token } = {}) {
  const h = { 'CF-Connecting-IP': '10.79.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) };
  if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, j, h: r.headers };
}
const mstate = async () => (await fetch(MOCK + '/_state')).json();
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'seascout-db', '--local', '-c', 'wrangler.test.jsonc', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let catN = 0;
const CK = Math.random().toString(36).slice(2, 5);
const catalog = async (cc) => (await call('GET', `/api/v1/commerce/catalog?country=${cc}&lang=${CK}${++catN}`)).j.items;   // fresh lang each time → skips the 5-min cache
const mk = (items, id) => items.filter((it) => it.source === 'market' && it.offers.some((o) => o.merchant && o.merchant.toLowerCase().includes(id)));

// ---------- pure ----------
ok('searchUrl {q} encodes Thai', searchUrl('https://shopee.co.th/search?keyword={q}', 'โยตกหมึก') === 'https://shopee.co.th/search?keyword=' + encodeURIComponent('โยตกหมึก'));
ok('searchUrl {qh} joins words with -', searchUrl('https://listado.mercadolibre.com.mx/{qh}', 'Poteras calamar') === 'https://listado.mercadolibre.com.mx/poteras-calamar');
ok('searchUrl refuses non-https', searchUrl('http://x.example/{q}', 'a') === null);
ok('pickProgram prefers the country (name)', pickProgram([{ id: '1', name: 'Lazada Malaysia' }, { id: '2', name: 'Lazada (Thailand)' }], 'Lazada', 'TH').id === '2');
ok('pickProgram prefers the country (region)', pickProgram([{ id: '1', name: 'Mercado Libre', regions: ['AR'] }, { id: '2', name: 'Mercado Libre', regions: ['MX'] }], 'Mercado Libre', 'MX').id === '2');
ok('pickProgram: one program for the brand → it', pickProgram([{ id: '9', name: 'Tokopedia' }], 'Tokopedia', 'ID').id === '9');
ok('pickProgram: several and none names the country → no guess', pickProgram([{ id: '1', name: 'Shopee A' }, { id: '2', name: 'Shopee B' }], 'Shopee', 'TH') === null);
ok('pickProgram: brand missing → null', pickProgram([{ id: '1', name: 'Amazon' }], 'Lazada', 'TH') === null);

// ---------- admin ----------
const rnd = Math.random().toString(36).slice(2, 7), email = `mk.${rnd}@example.com`, pw = 'market-owner-123';
await call('POST', '/api/v1/auth/register', { body: { email, password: pw, privacy_consent: true } });
d1(`INSERT INTO admin_users (id, email, role, created_at) VALUES ('adm_k${rnd}', '${email}', 'owner', 0)`);
const A = (await call('POST', '/api/v1/admin/login', { body: { email, password: pw } })).j.token;
ok('admin login', !!A);
d1(`DELETE FROM offers WHERE product_id IN (SELECT id FROM products WHERE source = 'market'); DELETE FROM products WHERE source = 'market';
    UPDATE marketplaces SET program_id = NULL, status = NULL, links = 0, checked_at = 0, active = 1; UPDATE marketplaces SET rank = 2 WHERE id LIKE 'lazada_%'; UPDATE marketplaces SET rank = 1 WHERE id LIKE 'shopee_%';
    UPDATE market_keywords SET keyword = 'โยตกหมึก' WHERE id = 'squid' AND lang = 'th'; UPDATE feature_flags SET enabled = 0 WHERE key = 'market_links'`);
const run = async (id) => (await call('POST', '/api/v1/admin/markets/run', { body: id ? { market_id: id } : {}, token: A })).j;

let L = (await call('GET', '/api/v1/admin/markets', { token: A })).j;
ok('35 marketplaces seeded, 10 tackle keywords', L.markets.length === 35 && new Set(L.keywords.map((k) => k.id)).size === 10, [L.markets.length]);
ok('networks shown as configured', L.networks.involve && L.networks.admitad && L.networks.amazon, L.networks);
ok('TH order: Shopee 1, Lazada 2', L.markets.filter((m) => m.country === 'TH').map((m) => m.name + m.rank).join() === 'Shopee1,Lazada2');

// flag off → cron does nothing
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(1500);
ok('flag off → no links made by cron', d1(`SELECT COUNT(*) AS n FROM products WHERE source = 'market'`)[0].n === 0);

// Involve Asia — Shopee Thailand
let r = await run('shopee_th');
ok('shopee_th first run: 6 links (cap per run)', r.made === 6 && r.links === 6, r);
let st = await mstate();
const iv = st.ivLinks.slice(-6);
ok('deeplinks asked for offer 101 (Shopee TH) on shopee.co.th search', iv.every((x) => x.offer_id === '101' && x.url.startsWith('https://shopee.co.th/search?keyword=')), iv[0]);
ok('Thai keywords used', iv.every((x) => /[\u0E00-\u0E7F]/.test(decodeURIComponent(x.url))), iv.map((x) => decodeURIComponent(x.url)));
r = await run('shopee_th');
ok('second run finishes the rest (10)', r.made === 4 && r.links === 10, r);
r = await run('shopee_th');
ok('third run: nothing to do', r.made === 0 && r.links === 10, r);
const prog = d1(`SELECT program_id, status FROM marketplaces WHERE id = 'shopee_th'`)[0];
ok('program found and kept', prog.program_id === '101' && prog.status === 'ok', prog);

// Lazada: picks the Thailand program, not Malaysia
r = await run('lazada_th'); await run('lazada_th');
ok('lazada_th → program 102 (Thailand)', d1(`SELECT program_id FROM marketplaces WHERE id = 'lazada_th'`)[0].program_id === '102');
r = await run('lazada_my');
ok('lazada_my → program 103 (Malaysia), English keywords', d1(`SELECT program_id FROM marketplaces WHERE id = 'lazada_my'`)[0].program_id === '103' && (await mstate()).ivLinks.slice(-1)[0].url.includes('lazada.com.my/catalog/?q=') , (await mstate()).ivLinks.slice(-1)[0]);
r = await run('shopee_vn');
ok('shopee_vn picks "Shopee Vietnam" over "Shopee VN CPS"', d1(`SELECT program_id FROM marketplaces WHERE id = 'shopee_vn'`)[0].program_id === '106' && decodeURIComponent((await mstate()).ivLinks.slice(-1)[0].url).match(/[ăâđêôơư]/i), (await mstate()).ivLinks.slice(-1)[0]);
r = await run('tokopedia_id');
ok('tokopedia_id: not joined → program_not_found, no links', r.error === 'program_not_found' && d1(`SELECT status FROM marketplaces WHERE id = 'tokopedia_id'`)[0].status === 'program_not_found', r);

// Admitad — Mercado Libre Mexico, one batched deeplink call per run
const ad0 = (await mstate()).adCalls || 0;
r = await run('mercadolibre_mx');
st = await mstate();
ok('mercadolibre_mx: 6 links in ONE Admitad call', r.made === 6 && st.adCalls === ad0 + 1, r);
const ml = d1(`SELECT o.url, o.country FROM offers o JOIN products p ON p.id = o.product_id WHERE p.query_id = 'mercadolibre_mx' LIMIT 20`);
ok('ML links: admitad goto, Spanish hyphen search, country MX', ml.every((x) => x.country === 'MX' && x.url.startsWith('https://ad.admitad.com/g/501/')) && ml.some((x) => decodeURIComponent(x.url).includes('listado.mercadolibre.com.mx/plomo-pesca-mar')), ml.slice(0, 2));

// Amazon — tag appended, no network call; GB has no tag
r = await run('amazon_us'); await run('amazon_us');
const az = d1(`SELECT o.url FROM offers o JOIN products p ON p.id = o.product_id WHERE p.query_id = 'amazon_us'`);
ok('amazon_us: 10 links with tag=seascout-20', az.length === 10 && az.every((x) => /^https:\/\/www\.amazon\.com\/s\?k=.+&tag=seascout-20$/.test(x.url)), az[0]);
r = await run('amazon_gb');
ok('amazon_gb: no tag for the country → no_tag_for_country', r.error === 'program_not_found' && d1(`SELECT status FROM marketplaces WHERE id = 'amazon_gb'`)[0].status === 'no_tag_for_country', r);

// ---------- catalogue by country ----------
const th = await catalog('TH'), mx = await catalog('MX'), us = await catalog('US'), fr = await catalog('FR');
ok('TH sees Shopee + Lazada TH links, not MX/US', mk(th, 'shopee th').length === 10 && mk(th, 'lazada th').length === 10 && !mk(th, 'mercado').length && !mk(th, 'amazon').length, [mk(th, 'shopee th').length, mk(th, 'lazada th').length]);
ok('MX sees Mercado Libre, US sees Amazon', mk(mx, 'mercado').length === 6 && mk(us, 'amazon us').length === 10 && !mk(us, 'shopee').length);
ok('FR (no links made) sees none', !fr.some((it) => it.source === 'market'));
const one = mk(th, 'shopee th').find((it) => it.desc === 'โยตกหมึก');
ok('market item: shop name, keyword, tags, no stars/sales', one && one.title === 'Shopee' && one.tags.includes('squid') && one.stars == null && one.sales == null && one.offers[0].country === 'TH', one);
ok('Shopee ranks before Lazada (sort)', mk(th, 'shopee th')[0].sort < mk(th, 'lazada th')[0].sort);

// click redirect + count
const go = await call('GET', new URL(one.offers[0].go).pathname + '?src=sq&p=android');
ok('go → 302 to the Involve tracking link', go.s === 302 && go.h.get('location').startsWith('https://invol.co/cl'), go.s);
L = (await call('GET', '/api/v1/admin/markets', { token: A })).j;
ok('click counted for shopee_th', (L.clicks_30d.find((c) => c.market === 'shopee_th') || {}).n === 1, L.clicks_30d);

// ---------- admin control ----------
ok('switch off Lazada TH', (await call('PUT', '/api/v1/admin/markets/lazada_th', { body: { active: false }, token: A })).s === 200);
ok('… its links disappear from TH', !mk(await catalog('TH'), 'lazada th').length);
await call('PUT', '/api/v1/admin/markets/lazada_th', { body: { active: true }, token: A });
ok('… and come back when on again', mk(await catalog('TH'), 'lazada th').length === 10);
await call('PUT', '/api/v1/admin/markets/lazada_th', { body: { rank: 1 }, token: A });
await call('PUT', '/api/v1/admin/markets/shopee_th', { body: { rank: 2 }, token: A });
const th2 = await catalog('TH');
ok('rank change re-orders (Lazada first now)', mk(th2, 'lazada th')[0].sort < mk(th2, 'shopee th')[0].sort);
ok('bad search url refused', (await call('PUT', '/api/v1/admin/markets/shopee_th', { body: { search_url: 'http://shopee.co.th/?k=x' }, token: A })).s === 400);
const blk = one.id;
ok('block one market item (shop/products/…/block)', (await call('POST', `/api/v1/admin/shop/products/${blk}/block`, { body: {}, token: A })).s === 200 && !mk(await catalog('TH'), 'shopee th').some((it) => it.id === blk));
// edit Thai keyword → that link is made again, still blocked
ok('edit keyword squid/th', (await call('PUT', '/api/v1/admin/market-keywords/squid/th', { body: { keyword: 'โยตกหมึก egi' }, token: A })).s === 200);
r = await run('shopee_th');
const re = d1(`SELECT description, active, off_reason FROM products WHERE id = '${blk}'`)[0];
ok('keyword change → link made again with new keyword; block kept', r.made >= 1 && re.description === 'โยตกหมึก egi' && re.active === 0 && re.off_reason === 'admin', [r, re]);
ok('changing the program id remakes links', (await call('PUT', '/api/v1/admin/markets/shopee_th', { body: { program_id: '999' }, token: A })).s === 200 && d1(`SELECT checked_at FROM marketplaces WHERE id = 'shopee_th'`)[0].checked_at === 0 && d1(`SELECT MAX(refreshed_at) AS m FROM products WHERE query_id = 'shopee_th'`)[0].m === 0);
await call('PUT', '/api/v1/admin/markets/shopee_th', { body: { program_id: '101' }, token: A });

// ---------- cron + flag ----------
d1(`UPDATE feature_flags SET enabled = 1 WHERE key = 'market_links'`);
const before = d1(`SELECT COUNT(*) AS n FROM products WHERE source = 'market'`)[0].n;
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*'); await sleep(2500);
const oldest = d1(`SELECT COUNT(*) AS n FROM marketplaces WHERE checked_at > 0`)[0].n;
ok('flag on → cron handles one more marketplace', oldest > 0 && d1(`SELECT COUNT(*) AS n FROM products WHERE source = 'market'`)[0].n >= before, [before, oldest]);
d1(`UPDATE feature_flags SET enabled = 0 WHERE key = 'market_links'`);
ok('runs audited', d1(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'market_run'`)[0].n >= 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
