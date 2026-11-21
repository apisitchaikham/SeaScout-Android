// Sea Scout · automatic check of a sponsor banner (r14.15.75). No human step: a banner is refused if ANY check fails.
//  1. banned words (gambling, adult, illegal loans/drugs, fakes) in the shop name, headline and link
//  2. the linked page itself: must open over https; its title/text must not be a gambling/adult page
//     (big platforms that block robots — Facebook, Shopee, Lazada, LINE, TikTok, Instagram — are accepted unread)
//  3. Google Safe Browsing (malware / phishing), when SAFE_BROWSING_KEY is set
//  4. Cloudflare Workers AI looks at the picture + text (env.AI, model SPONSOR_AI_MODEL)
// Each check's result is stored (check_json) and the reason is shown to the shop in Thai.

// Thai/English terms that only appear on pages we never accept. "Strong" = one hit is enough anywhere.
const STRONG = [
  'casino', 'baccarat', 'sbobet', 'ufabet', 'sportsbook', 'roulette', 'pg ?slot', 'slot ?online', 'slotxo', 'joker ?gaming', 'betflix', 'lsm99',
  'บาคาร่า', 'สล็อต', 'คาสิโน', 'แทงบอล', 'พนันออนไลน์', 'เว็บพนัน', 'ไฮโล', 'รูเล็ต', 'เกมยิงปลา', 'หวยออนไลน์', 'แทงหวย', 'เครดิตฟรี', 'ฝากถอนไม่มีขั้นต่ำ', 'เว็บตรงไม่ผ่านเอเย่นต์',
  'porn', 'xxx', 'onlyfans', 'escort', 'หนังโป๊', 'คลิปหลุด', 'คลิปโป๊', 'เว็บโป๊',
  'เงินกู้นอกระบบ', 'เงินด่วนนอกระบบ', 'ยาบ้า', 'ยาไอซ์', 'ปืนเถื่อน', 'ขายบัญชีม้า', 'บัญชีม้า',
];
// "Weak" = common words that need several different hits on the shop's page to count (avoids refusing a fishing shop
// whose page merely says "bet" or "slot")
const WEAK = ['\\bbet\\b', 'betting', '\\bslots?\\b', 'jackpot', 'lotto', 'lottery', 'poker', 'หวย', 'พนัน', 'แทง', 'เดิมพัน', 'ทุนน้อย', 'โบนัส ?100'];
const STRONG_RE = new RegExp(STRONG.join('|'), 'i');
const weakHits = (t) => WEAK.filter((w) => new RegExp(w, 'i').test(t));
const ROBOT_SHY = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|shopee\.[a-z.]+|lazada\.[a-z.]+|line\.me|lin\.ee|tiktok\.com|vt\.tiktok\.com|s\.shopee\.[a-z.]+|youtube\.com|youtu\.be|google\.com|goo\.gl|maps\.app\.goo\.gl)$/i;

export function textCheck(s) {
  const m = String(s || '').match(STRONG_RE);
  return m ? { ok: false, hit: m[0] } : { ok: true };
}

export function linkShape(link) {
  let u; try { u = new URL(link); } catch (_) { return 'ลิงก์ไม่ถูกต้อง'; }
  if (u.protocol !== 'https:') return 'ลิงก์ต้องขึ้นต้นด้วย https://';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname === 'localhost' || !u.hostname.includes('.')) return 'ลิงก์ต้องเป็นชื่อเว็บไซต์ ไม่ใช่เลข IP';
  if (u.username || u.password) return 'ลิงก์ไม่ถูกต้อง';
  return null;
}

async function pageCheck(env, link) {
  const host = new URL(link).hostname;
  let r;
  try {
    // tests only: SPONSOR_FETCH_PROXY sends the request to a local stand-in (never set in production)
    r = await fetch(env.SPONSOR_FETCH_PROXY ? env.SPONSOR_FETCH_PROXY + encodeURIComponent(link) : link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SeaScoutAdCheck/1.0; +https://seascout.apisit-chaikham.workers.dev/advertise.html)', Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(9000) });
  } catch (e) {
    return ROBOT_SHY.test(host) ? { ok: true, note: 'platform_unreadable' } : { ok: false, reason: 'เปิดลิงก์ร้านไม่ได้ (เว็บไม่ตอบ) กรุณาตรวจลิงก์แล้วส่งใหม่' };
  }
  const finalUrl = env.SPONSOR_FETCH_PROXY ? (r.headers.get('x-final-url') || link) : (r.url || link);
  const finalHost = (() => { try { return new URL(finalUrl).hostname; } catch (_) { return host; } })();
  if (!/^https:/i.test(finalUrl)) return { ok: false, reason: 'ลิงก์พาไปหน้าเว็บที่ไม่ปลอดภัย (ไม่ใช่ https)' };
  const shape = textCheck(finalHost);
  if (!shape.ok) return { ok: false, reason: 'ลิงก์พาไปเว็บไซต์ที่ไม่อนุญาต', hit: shape.hit };
  if (!r.ok) {
    if (ROBOT_SHY.test(host) || ROBOT_SHY.test(finalHost)) return { ok: true, note: 'platform_unreadable', status: r.status };
    return { ok: false, reason: `เปิดลิงก์ร้านไม่ได้ (HTTP ${r.status}) กรุณาตรวจลิงก์แล้วส่งใหม่` };
  }
  const ct = r.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) { try { r.body && r.body.cancel(); } catch (_) {} return { ok: true, note: 'not_html' }; }
  // read at most ~120 KB of the page
  const reader = r.body.getReader(), dec = new TextDecoder(); let html = '', n = 0;
  while (n < 120000) { const { done, value } = await reader.read(); if (done) break; n += value.length; html += dec.decode(value, { stream: true }); }
  try { reader.cancel(); } catch (_) {}
  const title = ((html.match(/<title[^>]*>([^<]{0,200})/i) || [])[1] || '').trim();
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').slice(0, 20000);
  const strong = textCheck(title + ' ' + text);
  if (!strong.ok) return { ok: false, reason: 'หน้าเว็บของลิงก์มีเนื้อหาที่ไม่อนุญาต (เช่น การพนัน/เนื้อหาผู้ใหญ่)', hit: strong.hit, title };
  const weak = weakHits(title + ' ' + text);
  if (weak.length >= 3) return { ok: false, reason: 'หน้าเว็บของลิงก์มีลักษณะเป็นเว็บพนัน', hit: weak.join(','), title };
  return { ok: true, title, excerpt: text.slice(0, 1500) };
}

async function safeBrowsing(env, link) {
  if (!env.SAFE_BROWSING_KEY) return { ok: true, skipped: true };
  try {
    const r = await fetch((env.SAFE_BROWSING_URL || 'https://safebrowsing.googleapis.com/v4/threatMatches:find') + '?key=' + encodeURIComponent(env.SAFE_BROWSING_KEY), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ client: { clientId: 'seascout', clientVersion: '1.0' }, threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: [{ url: link }] } }),
    });
    if (!r.ok) return { ok: true, error: 'HTTP ' + r.status };
    const j = await r.json();
    return j && j.matches && j.matches.length ? { ok: false, reason: 'Google แจ้งว่าลิงก์นี้ไม่ปลอดภัย (มัลแวร์/หลอกลวง)', threat: j.matches[0].threatType } : { ok: true };
  } catch (e) { return { ok: true, error: String(e && e.name || e) }; }
}

const AI_SYSTEM = 'You review advertising banners for a marine navigation and fishing app used in Thailand. ' +
  'Refuse anything that promotes or links to: gambling or betting of any kind (casino, slots, baccarat, football betting, lottery sites), ' +
  'adult or sexual content, illegal drugs, weapons, illegal loans, counterfeit goods, scams, alcohol or tobacco, or anything illegal under Thai law. ' +
  'Ordinary businesses (fishing gear, boats, marine services, resorts, restaurants, shops, apps) are allowed. ' +
  'Reply with ONLY one JSON object: {"allowed":true|false,"category":"<short english category>","reason_th":"<one short Thai sentence when not allowed>"}';

export function parseVerdict(out) {
  const txt = typeof out === 'string' ? out : out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) ?? out.result?.response);
  if (txt && typeof txt === 'object' && typeof txt.allowed === 'boolean') return txt;
  // models differ in where they put the text (response / choices / content parts / reasoning): find the verdict object anywhere
  const all = typeof out === 'string' ? out : JSON.stringify(out == null ? '' : out);
  const cands = [String(typeof txt === 'string' ? txt : ''), all.replace(/\\"/g, '"')];
  for (const c of cands) {
    const ms = c.match(/\{[^{}]*"allowed"\s*:\s*(true|false)[^{}]*\}/g);
    if (!ms) continue;
    for (const m of ms.reverse()) { try { const j = JSON.parse(m); if (typeof j.allowed === 'boolean') return j; } catch (_) {} }
  }
  return null;
}

async function aiCheck(env, ad, page) {
  const user = `Shop name: ${ad.business}\nHeadline: ${ad.headline || '-'}\nLink: ${ad.link}\nLinked page title: ${page.title || '-'}\nLinked page text (start): ${(page.excerpt || '').slice(0, 1200)}\nThe banner image is attached.`;
  const input = { messages: [{ role: 'system', content: AI_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:${ad.image_type};base64,${ad.image_b64}` } }] }], max_tokens: 600, temperature: 0 };
  let out;
  if (env.SPONSOR_AI_URL) {   // tests: an HTTP stand-in for env.AI
    const r = await fetch(env.SPONSOR_AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('ai HTTP ' + r.status);
    out = await r.json();
  } else if (env.AI) {
    out = await env.AI.run(env.SPONSOR_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it', input);
  } else return { ok: true, skipped: 'no_ai' };
  const v = parseVerdict(out);
  if (!v) throw new Error('ai: no verdict: ' + JSON.stringify(out).slice(0, 260));
  return v.allowed ? { ok: true, category: v.category || '' } : { ok: false, reason: 'ระบบ AI พบว่าโฆษณาไม่เป็นไปตามกฎ' + (v.reason_th ? `: ${String(v.reason_th).slice(0, 140)}` : ''), category: v.category || '' };
}

// Full check. Returns { verdict: 'pass' | 'fail' | 'retry', reason, detail }.
// 'retry' only when the AI could not answer — the cron tries again; after 3 tries the rule checks alone decide.
export async function checkSponsor(env, ad, { tries = 0, withAi = true } = {}) {
  const detail = { at: Date.now() };
  const shape = linkShape(ad.link);
  if (shape) return { verdict: 'fail', reason: shape, detail };
  for (const [k, v] of [['business', ad.business], ['headline', ad.headline], ['link', ad.link]]) {
    const t = textCheck(v);
    if (!t.ok) return { verdict: 'fail', reason: 'ชื่อร้าน ข้อความ หรือลิงก์มีคำที่ไม่อนุญาต (เช่น เกี่ยวกับการพนัน)', detail: { ...detail, words: { field: k, hit: t.hit } } };
  }
  const [page, sb] = await Promise.all([pageCheck(env, ad.link), safeBrowsing(env, ad.link)]);
  detail.page = { ok: page.ok, note: page.note, title: page.title, hit: page.hit, status: page.status };
  detail.safe_browsing = sb;
  if (!sb.ok) return { verdict: 'fail', reason: sb.reason, detail };
  if (!page.ok) return { verdict: 'fail', reason: page.reason, detail };
  if (!withAi) return { verdict: 'pass', detail };
  try {
    const ai = await aiCheck(env, ad, page);
    detail.ai = ai;
    if (!ai.ok) return { verdict: 'fail', reason: ai.reason, detail };
    return { verdict: 'pass', detail };
  } catch (e) {
    detail.ai = { error: String(e && e.message || e).slice(0, 120) };
    if (tries + 1 >= 3) { detail.ai.fallback = 'rules_only'; return { verdict: 'pass', detail }; }
    return { verdict: 'retry', detail };
  }
}
