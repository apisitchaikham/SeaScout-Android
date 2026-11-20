import { handleApi } from './api/index.js';
import { autoShopTick } from './api/autoshop.js';

// Sea Scout website Worker (r14.15.44). Static files are served by Cloudflare directly (free, not counted);
// this script only runs for paths that are not files: /api/crash (anonymous error reports → Worker logs).
// r14.15.59: + /api/v1/* central membership API (worker/api/). Inert (503) until a D1 database is bound as DB.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/crash') {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
      const text = (await request.text()).slice(0, 8000);
      let j = null;
      try { j = JSON.parse(text); } catch (_) {}
      if (j && typeof j === 'object') {
        const keep = {};
        for (const k of ['k', 'm', 's', 'src', 'b', 'app', 'lang', 'plat', 'chrome', 'd']) if (k in j) keep[k] = String(j[k]).slice(0, k === 's' ? 2000 : 500);
        console.log(JSON.stringify({ seascout: 'diag', country: (request.cf && request.cf.country) || '', ...keep }));
      }
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname.startsWith('/api/v1/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
  // r14.15.68: every 30 min, refresh ONE shop search from the affiliate networks (inert while flag auto_shop = 0 or no keys)
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(autoShopTick(env).then((r) => console.log(JSON.stringify({ seascout: 'auto_shop', ...r }))).catch((e) => console.log(JSON.stringify({ seascout: 'auto_shop', error: String(e) }))));
  },
};
