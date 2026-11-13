/* Sea Scout service worker (r14.15.44): keeps map tiles so the chart works offline at sea.
   - Map tiles / styles / fonts (OpenFreeMap, Open Waters Seamap, NASA GIBS, GEBCO): stale-while-revalidate into "sea-tiles".
   - The app page and /lib/: network-first, cached copy only when offline (never serves an old app while online).
   Everything else is not touched. */
const TILES='sea-tiles-v1',SHELL='sea-shell-v1',MAX_TILES=8000;
const TILE_HOSTS=['tiles.openfreemap.org','tiles.openwaters.io','gibs.earthdata.nasa.gov','wms.gebco.net'];
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
let puts=0;
async function trim(){try{const c=await caches.open(TILES),k=await c.keys();if(k.length>MAX_TILES)for(const r of k.slice(0,k.length-MAX_TILES+500))await c.delete(r);}catch(_){}}
async function tile(req){
 const c=await caches.open(TILES),hit=await c.match(req);
 const net=fetch(req).then(async r=>{if(r&&(r.ok||r.type==='opaque')){await c.put(req,r.clone());if(++puts%200===0)trim();}return r;}).catch(()=>null);
 if(hit){net;return hit;}
 const r=await net;return r||new Response('',{status:504,statusText:'offline'});
}
async function shell(req){
 const c=await caches.open(SHELL);
 try{const r=await fetch(req);if(r&&r.ok)c.put(req,r.clone());return r;}
 catch(e){const hit=await c.match(req,{ignoreSearch:true});if(hit)return hit;throw e;}
}
self.addEventListener('fetch',e=>{
 const req=e.request;if(req.method!=='GET')return;
 let u;try{u=new URL(req.url);}catch(_){return;}
 if(TILE_HOSTS.includes(u.hostname)){e.respondWith(tile(req));return;}
 if(u.origin===self.location.origin&&(req.mode==='navigate'||u.pathname.startsWith('/lib/'))){e.respondWith(shell(req));return;}
});
self.addEventListener('message',e=>{if(e.data==='sea-tiles-count')caches.open(TILES).then(c=>c.keys()).then(k=>e.source&&e.source.postMessage({seaTiles:k.length}));});
