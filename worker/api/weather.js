// r14.15.92: storm / gust / rain / thunder forecast and tropical-cyclone list.
// Sources (free, commercial use allowed with attribution):
//  - MET Norway Locationforecast 2.0 (CC BY 4.0 / NLOD). Requires an identifying User-Agent and at least
//    3 h caching outside the Nordic region, so the app never calls it directly: one cached copy per 0.1° cell.
//  - GDACS (EC-JRC / UN OCHA) tropical-cyclone events. Credit "Global Disaster Alert and Coordination System, GDACS".
import { ApiError, json } from './util.js';

const UA = 'SeaScout/1.0 (+https://seascout.apisit-chaikham.workers.dev; marine app)';
const POINT_TTL = 3 * 3600;      // MET Norway minimum outside the Nordic region
const STORM_TTL = 30 * 60;

const INFLIGHT = new Map();   // coalesce simultaneous misses for the same cell (no cache stampede)
async function cached(key, ttl, fetcher) {
  const cache = caches.default, req = new Request(key);
  const hit = await cache.match(req);
  if (hit) return { body: await hit.json(), hit: true };
  if (INFLIGHT.has(key)) return { body: await INFLIGHT.get(key), hit: true };
  const p = (async () => {
    const body = await fetcher();
    if (body) await cache.put(req, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } }));
    return body;
  })();
  INFLIGHT.set(key, p);
  try { return { body: await p, hit: false }; } finally { INFLIGHT.delete(key); }
}

function num(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; }

export async function wxPoint(request, env = {}) {
  const u = new URL(request.url);
  const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
  if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) throw new ApiError(400, 'invalid_position');
  const la = (Math.round(lat * 10) / 10).toFixed(1), lo = (Math.round(lon * 10) / 10).toFixed(1);
  const { body, hit } = await cached(`https://cache.seascout/wx/point/${la}/${lo}`, POINT_TTL, async () => {
    const r = await fetch(`${env.WX_MET_BASE || 'https://api.met.no'}/weatherapi/locationforecast/2.0/complete?lat=${la}&lon=${lo}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new ApiError(502, 'upstream_' + r.status);
    const d = await r.json(), ts = (d && d.properties && d.properties.timeseries) || [];
    const out = [];
    for (const s of ts) {
      const t = Date.parse(s.time); if (!Number.isFinite(t) || t > Date.now() + 4 * 86400e3) continue;
      const i = (s.data && s.data.instant && s.data.instant.details) || {}, n1 = (s.data && s.data.next_1_hours) || null, n6 = (s.data && s.data.next_6_hours) || null;
      const nx = n1 || n6, h = n1 ? 1 : n6 ? 6 : 0;
      out.push({
        t: t / 1000 | 0, w: num(i.wind_speed), g: num(i.wind_speed_of_gust), d: Number.isFinite(i.wind_from_direction) ? Math.round(i.wind_from_direction) : null,
        p: num(i.air_pressure_at_sea_level), h,
        r: nx && nx.details ? num(nx.details.precipitation_amount) : null,
        pr: nx && nx.details ? num(nx.details.probability_of_precipitation) : null,
        th: nx && nx.details ? num(nx.details.probability_of_thunder) : null,
        s: nx && nx.summary ? String(nx.summary.symbol_code || '').slice(0, 40) : null,
      });
    }
    return { lat: +la, lon: +lo, updated: d && d.properties && d.properties.meta && d.properties.meta.updated_at || null, series: out,
      source: 'MET Norway Locationforecast 2.0', licence: 'CC BY 4.0 · Data from MET Norway' };
  });
  return json(request, 200, { ...body, cached: hit }, { 'Cache-Control': 'public, max-age=1800' });
}

export async function wxStorms(request, env = {}) {
  const { body, hit } = await cached('https://cache.seascout/wx/storms/v1', STORM_TTL, async () => {
    const to = new Date(), from = new Date(Date.now() - 10 * 86400e3), f = (x) => x.toISOString().slice(0, 10);
    const r = await fetch(`${env.WX_GDACS_BASE || 'https://www.gdacs.org'}/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate=${f(from)}&todate=${f(to)}&alertlevel=Green;Orange;Red`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 204) return { storms: [], source: 'GDACS', licence: 'Global Disaster Alert and Coordination System, GDACS' };
    if (!r.ok) throw new ApiError(502, 'upstream_' + r.status);
    const d = await r.json(), feats = (d && d.features) || [];
    const storms = [];
    for (const f2 of feats) {
      const p = f2.properties || {}, g = f2.geometry || {};
      if (g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const to2 = Date.parse(p.todate || ''); if (Number.isFinite(to2) && to2 < Date.now() - 2 * 86400e3) continue;
      storms.push({ id: p.eventid, name: String(p.eventname || p.name || '').slice(0, 60), alert: String(p.alertlevel || '').slice(0, 10),
        lon: g.coordinates[0], lat: g.coordinates[1], from: p.fromdate || null, to: p.todate || null,
        sev: String((p.severitydata && p.severitydata.severitytext) || '').slice(0, 160), kmh: p.severitydata && Number.isFinite(p.severitydata.severity) ? Math.round(p.severitydata.severity) : null,
        url: p.url && p.url.report ? String(p.url.report).slice(0, 300) : null, current: !!p.iscurrent && String(p.iscurrent).toLowerCase() !== 'false' });
    }
    return { storms: storms.slice(0, 40), source: 'GDACS', licence: 'Global Disaster Alert and Coordination System, GDACS' };
  });
  return json(request, 200, { ...body, cached: hit }, { 'Cache-Control': 'public, max-age=600' });
}
