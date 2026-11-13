// Sea Scout website Worker (r14.15.44). Static files are served by Cloudflare directly (free, not counted);
// this script only runs for paths that are not files: /api/crash (anonymous error reports → Worker logs).
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
    return env.ASSETS.fetch(request);
  },
};
