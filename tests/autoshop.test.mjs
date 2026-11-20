// Sea Scout — automatic shop (r14.15.68): affiliate network search → ranking → products/offers → catalogue → admin block.
// Usage: node tests/autoshop.test.mjs <api-base e.g. http://127.0.0.1:8788> <mock-base>
// Needs `wrangler dev --test-scheduled` so /__scheduled runs the cron handler.
import { execFileSync } from 'node:child_process';
import { pickTop, stars5 } from '../worker/api/autoshop.js';
const [BASE, MOCK] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || x === undefined ? '' : '  → ' + JSON.stringify(x).slice(0, 400))); };
async function call(method, path, { body, token } = {}) {
  const h = { 'CF-Connecting-IP': '10.77.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) };
  if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, j, h: r.headers };
}
const mock = (p, b) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'seascout-db', '--local', '-c', 'wrangler.test.jsonc', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
let catN = 0;
const catalog = async () => (await call('GET', `/api/v1/commerce/catalog?country=TH&lang=t${++catN}`)).j.items;   // new lang each time → skips the 5-min cache

// ---------- ranking rules (pure) ----------
{
  const L = 'https://s.shopee.co.th/x';
  const t = pickTop([
    { ext_id: 'a', title: 'A', link: L, rating: 4.9, scale: 5, sales: 1200 },
    { ext_id: 'b', title: 'B', link: L, rating: 5, scale: 5, sales: 40 },
    { ext_id: 'c', title: 'C', link: L, rating: 5, scale: 5, sales: 900 },
    { ext_id: 'd', title: 'D', link: L, rating: 4.88, scale: 5, sales: 5000 },
    { ext_id: 'e', title: 'E', link: L, rating: 4.2, scale: 5, sales: 99999 },
    { ext_id: 'f', title: 'F', link: L, rating: 5, scale: 5, sales: 10 },
    { ext_id: 'g', title: 'G', link: null, rating: 5, scale: 5, sales: 999 },
    { ext_id: 'i', title: 'I', link: L, rating: null, scale: 5, sales: 999 },
    { ext_id: 'a', title: 'A again', link: L, rating: 5, scale: 5, sales: 9e9 },
  ]);
  ok('rank: 5★ first, then most sold; 4.9★ next (more sold first)', t.map((x) => x.ext_id).join('') === 'cbda', t.map((x) => x.ext_id));
  ok('rank: drops <4.5★, <30 sold, no link, no rating, duplicates', t.length === 4);
  ok('AliExpress % → stars: 98.6% = 4.9★, 100% = 5.0★', stars5({ rating: 98.6, scale: 100 }) === 4.9 && stars5({ rating: 100, scale: 100 }) === 5);
}

// ---------- admin ----------
const rnd = Math.random().toString(36).slice(2, 7), email = `shop.${rnd}@example.com`, pw = 'shop-owner-pass-123';
await call('POST', '/api/v1/auth/register', { body: { email, password: pw, privacy_consent: true } });
d1(`INSERT INTO admin_users (id, email, role, created_at) VALUES ('adm_s${rnd}', '${email}', 'owner', 0)`);
const A = (await call('POST', '/api/v1/admin/login', { body: { email, password: pw } })).j.token;
ok('admin login', !!A);

// start clean: no auto items, all searches "never run", flag off
d1(`DELETE FROM products WHERE source != 'manual'; UPDATE shop_queries SET last_run = 0, last_status = NULL, last_count = NULL; UPDATE feature_flags SET enabled = 0 WHERE key = 'auto_shop'`);

const SP = (id, name, star, sold, link = `https://s.shopee.co.th/aff${id}`) => ({ itemId: id, productName: name, imageUrl: `https://cf.shopee.co.th/file/${id}`, priceMin: '159.00', ratingStar: star, sales: sold, offerLink: link });
await mock('/_shop', { shopee: [
  SP(101, 'Egi A', '4.9', 1200), SP(102, 'Egi B', '5.0', 40), SP(103, 'Egi C', '5.0', 900), SP(104, 'Egi D', '4.9', 5000),
  SP(105, 'Egi cheap', '4.1', 80000), SP(106, 'Egi new', '5.0', 3), SP(107, 'Egi nolink', '5.0', 500, ''), SP(108, 'Egi http', '5.0', 500, 'http://x.example/a'),
], aliexpress: [
  { product_id: 9001, product_title: 'Squid jig 3.5', product_main_image_url: 'https://ae01.alicdn.com/kf/1.jpg', target_sale_price: '2.99', target_sale_price_currency: 'USD', evaluate_rate: '98.6%', lastest_volume: 3400, promotion_link: 'https://s.click.aliexpress.com/e/_a1' },
  { product_id: 9002, product_title: 'Squid jig glow', product_main_image_url: 'https://ae01.alicdn.com/kf/2.jpg', target_sale_price: '3.49', target_sale_price_currency: 'USD', evaluate_rate: '100.0%', lastest_volume: 150, promotion_link: 'https://s.click.aliexpress.com/e/_a2' },
  { product_id: 9003, product_title: 'Bad jig', target_sale_price: '1', evaluate_rate: '82%', lastest_volume: 9000, promotion_link: 'https://s.click.aliexpress.com/e/_a3' },
] });

// cron with the flag off → nothing happens
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*');
await new Promise((r) => setTimeout(r, 800));
ok('cron: flag off → no search run', d1(`SELECT COUNT(*) n FROM shop_queries WHERE last_run > 0`)[0].n === 0);

// admin "run now" on the squid search (Shopee, signed request checked by the mock)
const r1 = await call('POST', '/api/v1/admin/shop/run', { token: A, body: { query_id: 'q_sp_squid' } });
ok('run Shopee squid search: signed OK, 8 found, 4 kept', r1.s === 200 && r1.j.found === 8 && r1.j.kept === 4, r1.j);
let cat = await catalog();
const sq = cat.filter((p) => p.source === 'shopee');
ok('catalogue order = 5.0★ 900 sold, 5.0★ 40, 4.9★ 5000, 4.9★ 1200', sq.map((p) => p.stars + '/' + p.sales).join(' ') === '5/900 5/40 4.9/5000 4.9/1200', sq.map((p) => p.stars + '/' + p.sales));
ok('catalogue: tags from the search (squid, deepSquid, all)', sq.every((p) => ['all', 'squid', 'deepSquid'].every((t) => p.tags.includes(t))));
ok('catalogue: image + THB price + Shopee merchant', sq[0].images[0].url.startsWith('https://cf.shopee.co.th/') && sq[0].offers[0].currency === 'THB' && sq[0].offers[0].price === 159 && sq[0].offers[0].merchant === 'Shopee');
const go = await call('GET', new URL(sq[0].offers[0].go).pathname + '?src=xsl&p=android');
ok('click → 302 to the network\'s own affiliate link', go.s === 302 && go.h.get('location') === 'https://s.shopee.co.th/aff103', go.h.get('location'));

// AliExpress (signed HMAC checked by the mock), % rating shown as stars
const r2 = await call('POST', '/api/v1/admin/shop/run', { token: A, body: { query_id: 'q_ae_squid' } });
ok('run AliExpress squid search: 3 found, 2 kept', r2.s === 200 && r2.j.found === 3 && r2.j.kept === 2, r2.j);
cat = await catalog();
const ae = cat.filter((p) => p.source === 'aliexpress');
ok('AliExpress: 100% (5.0★, 150 sold) before 98.6% (4.9★, 3400 sold); USD; worldwide', ae.map((p) => p.stars + '/' + p.sales).join(' ') === '5/150 4.9/3400' && ae[0].offers[0].currency === 'USD' && ae[0].offers[0].country === '*', ae.map((p) => [p.stars, p.sales, p.offers[0]]));

// admin blocks the top item; a new run keeps it blocked
const top = (await call('GET', '/api/v1/admin/shop', { token: A })).j.products.find((p) => p.ext_id === '103');
ok('admin list shows networks + products', !!top);
ok('block', (await call('POST', `/api/v1/admin/shop/products/${top.id}/block`, { token: A, body: {} })).s === 200);
await call('POST', '/api/v1/admin/shop/run', { token: A, body: { query_id: 'q_sp_squid' } });
cat = await catalog();
ok('blocked item stays hidden after the next refresh', !cat.some((p) => p.id === top.id) && cat.filter((p) => p.source === 'shopee').length === 3);

// an item that falls out of the network's results is hidden (not deleted)
await mock('/_shop', { shopee: [SP(101, 'Egi A', '4.9', 1300), SP(102, 'Egi B', '5.0', 45), SP(103, 'Egi C', '5.0', 950)], aliexpress: [] });
await call('POST', '/api/v1/admin/shop/run', { token: A, body: { query_id: 'q_sp_squid' } });
const d = d1(`SELECT active, off_reason FROM products WHERE source='shopee' AND ext_id='104'`)[0];
ok('dropped item → hidden with reason "dropped"', d.active === 0 && d.off_reason === 'dropped', d);
const a = d1(`SELECT sales FROM products WHERE source='shopee' AND ext_id='101'`)[0];
ok('sales figure refreshed from the network', a.sales === 1300, a);

ok('unblock', (await call('POST', `/api/v1/admin/shop/products/${top.id}/unblock`, { token: A, body: {} })).s === 200);
cat = await catalog();
ok('unblocked item back on top', cat.filter((p) => p.source === 'shopee')[0].id === top.id);

// edit a search word (admin can steer, never types links)
const e1 = await call('PUT', '/api/v1/admin/shop/queries/q_sp_bait', { token: A, body: { keyword: 'ซาบิกิ ทะเล', tags: ['bait'] } });
ok('edit search word', e1.s === 200 && d1(`SELECT keyword FROM shop_queries WHERE id='q_sp_bait'`)[0].keyword === 'ซาบิกิ ทะเล');
ok('member token cannot use shop admin', (await call('POST', '/api/v1/admin/shop/run', { token: 'x'.repeat(43), body: {} })).s === 401);

// cron with the flag on → runs exactly one search (the oldest)
d1(`UPDATE feature_flags SET enabled = 1 WHERE key = 'auto_shop'`);
const before = d1(`SELECT COUNT(*) n FROM shop_queries WHERE last_run > 0`)[0].n;
await fetch(BASE + '/__scheduled?cron=*/30+*+*+*+*');
await new Promise((r) => setTimeout(r, 1500));
const after = d1(`SELECT COUNT(*) n FROM shop_queries WHERE last_run > 0`)[0].n;
ok('cron: flag on → exactly one more search refreshed', after === before + 1, { before, after });
d1(`UPDATE feature_flags SET enabled = 0 WHERE key = 'auto_shop'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
