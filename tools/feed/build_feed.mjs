// Sea Scout r14.15.95 — fill the analysis "shop" strip from the Admitad AliExpress WW product feed.
// Runs in GitHub Actions (free): streams the price-band feeds (millions of rows) without keeping them in memory,
// keeps only products whose title clearly names one gear item the app recommends, and writes a small JSON:
//   www/media/shop_feed.json  { updated, currency, items: { <gear key>: [ {t, img, p, op, u, r, n} ] } }
//   data/shop_feed_report.json  header + counts (no links), so the mapping can be checked
// The feed link is a secret (it carries the account code): ADMITAD_FEED_URL = the "Generated Link" from
// Admitad → Product Feeds → Original (AliExpress WW, csv, USD). The script swaps its feed_id for each price band.
import fs from 'node:fs';

const BASE = process.env.ADMITAD_FEED_URL || '';
const BANDS = (process.env.FEED_IDS || '14107,14267,14280').split(',').map((s) => s.trim()).filter(Boolean); // <10$, 10–25$, 25–40$
const KEEP = 8, MAX_ROWS = +(process.env.FEED_MAX_ROWS || 0) || Infinity;
const OUT = process.env.FEED_OUT || 'www/media/shop_feed.json', REPORT = process.env.FEED_REPORT || 'data/shop_feed_report.json';

// gear key → [must match, must NOT match]; keys are what the app's tackle chips ask for (aff.js GEAR)
const FISH = /\b(fish|fishing|angl|carp|bass|saltwater|sea|squid|octopus|jig|lure|tackle|hook)/;
const NOT = /\b(earring|necklace|pendant|keychain|key chain|sticker|t-?shirt|hoodie|toy|kids|aquarium|tattoo|phone case|wall|poster|decal|cake|mold|mould|jewel)/;
export const RULES = {
  hook:          [/\bfishing hooks?\b|\bhooks? (set|kit|box)\b|\bbarbed hooks?\b|\bjig hooks?\b/, /circle|assist|treble|jig head|squid|swivel|lure\b(?!.*hook)/],
  circle_hook:   [/\bcircle hooks?\b/, /earring/],
  assist_hook:   [/\bassist hooks?\b/, /earring/],
  long_shank:    [/\blong shank\b.*hooks?/, /earring/],
  squid_jig:     [/\bsquid jigs?\b|\begi\b|\bshrimp jig/, /octopus/],
  octopus_jig:   [/\boctopus (jig|lure|skirt)/, /earring/],
  sabiki:        [/\bsabiki\b|\bstring hooks?\b.*(bait|fish)|\bfish skin (rig|hooks?)/, /earring/],
  egg_sinker:    [/\b(egg|olive|bullet|oval) sinkers?\b|\bsinkers?.*\b(egg|olive|oval)\b/, /mold|mould/],
  bank_sinker:   [/\b(bank|bell|pyramid|drop shot) sinkers?\b/, /mold|mould/],
  sinker:        [/\b(fishing )?(lead )?sinkers?\b|\blead weights?\b.*fish/, /mold|mould|egg|olive/],
  split_shot:    [/\bsplit ?shot\b/, /mold|mould/],
  jig_head:      [/\bjig ?heads?\b/, /squid|mold|mould/],
  soft_lure:     [/\bsoft (plastic )?(lures?|baits?)\b|\bpaddle ?tail\b|\bshad\b.*\blures?/, /jig head only/],
  metal_jig:     [/\b(metal|casting|shore|spoon) jigs?\b|\bjigging lures?\b/, /squid|slow/],
  slow_jig:      [/\bslow (pitch )?jigs?\b|\bslow jigging\b/, /squid/],
  pe_line:       [/\b(pe|braided?|braid)\b.*\b(line|lines)\b/, /fluorocarbon leader only/],
  mono_line:     [/\b(monofilament|nylon) (fishing )?line\b/, /braid/],
  fluoro_leader: [/\bfluorocarbon\b.*\b(line|leader)\b|\bshock leader\b/, /braid/],
  wire_leader:   [/\b(wire|steel|titanium) leaders?\b/, /earring/],
  float:         [/\b(fishing )?(floats?|bobbers?)\b/, /pool|swim|boat|tube/],
  light:         [/\b(underwater|submersible) (fishing )?(led )?lights?\b|\bfish(ing)? (attract(ing|or)?|lure) (led )?lights?\b/, /flashlight|headlamp/],
  trolling_lure: [/\btrolling (lures?|skirts?)\b|\boctopus skirt/, /earring/],
  casting_lure:  [/\b(popper|pencil|minnow|stickbait|stick bait)\b.*\blures?/, /earring/],
};

const lower = (s) => String(s || '').toLowerCase();
const num = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
function classify(title) {
  const t = lower(title); if (!FISH.test(t) || NOT.test(t)) return null;
  for (const [k, [yes, no]] of Object.entries(RULES)) if (yes.test(t) && !(no && no.test(t))) return k;
  return null;
}

// streaming CSV: delimiter from the header (; or , or tab), RFC-4180 quotes, rows may span lines
async function* rows(res) {
  const dec = new TextDecoder(); let buf = '', delim = null, row = [], field = '', q = false;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    if (!delim) { const nl = buf.indexOf('\n'); if (nl < 0) continue; const h = buf.slice(0, nl); delim = [';', '\t', ','].sort((a, b) => h.split(b).length - h.split(a).length)[0]; }
    let i = 0;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (q) { if (c === '"') { if (buf[i + 1] === '"') { field += '"'; i++; } else if (i + 1 >= buf.length) break; else q = false; } else field += c; continue; }
      if (c === '"') { q = true; continue; }
      if (c === delim) { row.push(field); field = ''; continue; }
      if (c === '\n') { row.push(field.replace(/\r$/, '')); yield row; row = []; field = ''; continue; }
      field += c;
    }
    buf = buf.slice(i);
  }
  if (field || row.length) { row.push(field); yield row; }
}

const col = (H, ...names) => { for (const n of names) { const i = H.findIndex((h) => h === n); if (i >= 0) return i; } for (const n of names) { const i = H.findIndex((h) => h.includes(n)); if (i >= 0) return i; } return -1; };

export async function run() {
  if (!/^https?:\/\//.test(BASE)) throw new Error('ADMITAD_FEED_URL secret is missing');
  const best = {}, report = { updated: new Date().toISOString(), bands: [] };
  const multi = new URL(BASE).searchParams.has('feed_id');
  for (const id of multi ? BANDS : ['link']) {   // a link without feed_id is used as-is (one band)
    const u = new URL(BASE); if (multi) u.searchParams.set('feed_id', id);
    const res = await fetch(u, { headers: { 'User-Agent': 'SeaScout-feed/1.0 (+https://seascout.apisit-chaikham.workers.dev)' } });
    const band = { feed_id: id, status: res.status, rows: 0, matched: 0, header: null };
    report.bands.push(band);
    if (!res.ok) continue;
    let H = null, I = null;
    for await (const r of rows(res)) {
      if (!H) { H = r.map((h) => lower(h).trim()); band.header = H;
        I = { name: col(H, 'name', 'title', 'model'), url: col(H, 'url', 'link'), img: col(H, 'picture', 'image_link', 'image', 'picture_orig'), price: col(H, 'price', 'sale_price'),
          old: col(H, 'oldprice', 'old_price', 'original_price'), cur: col(H, 'currencyid', 'currency'), id: col(H, 'id', 'offer_id'), avail: col(H, 'available', 'availability'),
          rating: col(H, 'rating', 'evaluate', 'rate'), orders: col(H, 'orders', 'sales', 'volume', 'sold') };
        band.cols = I; continue; }
      if (++band.rows > MAX_ROWS) break;
      const name = r[I.name]; const k = classify(name); if (!k) continue;
      const url = r[I.url] || '', img = (r[I.img] || '').split(/[,|\s]+/)[0];
      if (!/^https:\/\//.test(url) || !/^https?:\/\//.test(img)) continue;
      if (I.avail >= 0 && /^(false|0|out)/i.test(r[I.avail] || '')) continue;
      const p = num(r[I.price]); if (!p || p <= 0) continue;
      band.matched++;
      const rating = I.rating >= 0 ? num(r[I.rating]) : null, orders = I.orders >= 0 ? num(r[I.orders]) : null;
      const op = I.old >= 0 ? num(r[I.old]) : null;
      // score: real popularity when the feed has it, else a shorter, cleaner title that names the item first
      const score = (orders || 0) * 10 + (rating || 0) * 100 - name.length * 0.5 + (op && op > p ? 20 : 0);
      const list = (best[k] ||= []);
      if (list.length < KEEP * 4 || score > list[list.length - 1].s) {
        const id = I.id >= 0 ? r[I.id] : url;
        if (!list.some((x) => x.id === id)) { list.push({ s: score, id, t: name.slice(0, 120), img: img.replace(/^http:/, 'https:'), p, op: op && op > p ? op : null, u: url, r: rating, n: orders }); list.sort((a, b) => b.s - a.s); list.length = Math.min(list.length, KEEP * 4); }
      }
    }
  }
  const items = {};
  for (const [k, list] of Object.entries(best)) items[k] = list.slice(0, KEEP).map(({ s, id, ...x }) => x);
  report.counts = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length]));
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true }); fs.mkdirSync(REPORT.replace(/\/[^/]+$/, ''), { recursive: true });
  if (Object.keys(items).length) fs.writeFileSync(OUT, JSON.stringify({ updated: report.updated, currency: 'USD', source: 'AliExpress via Admitad', items }));
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ bands: report.bands.map((b) => ({ id: b.feed_id, status: b.status, rows: b.rows, matched: b.matched })), counts: report.counts }));
}
if (process.argv[1] && process.argv[1].endsWith('build_feed.mjs')) run().catch((e) => { console.error(e.message); process.exit(1); });
