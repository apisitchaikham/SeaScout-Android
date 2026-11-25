// r14.15.92: /api/v1/wx/point and /api/v1/wx/storms against a local mock of MET Norway and GDACS.
import http from 'node:http';
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
let metHits = 0, gdHits = 0, lastUA = '';
const now = Date.now();
const srv = http.createServer((req, res) => {
  lastUA = req.headers['user-agent'] || '';
  if (req.url.startsWith('/weatherapi/locationforecast/2.0/complete')) {
    metHits++;
    const ts = [];
    for (let h = 0; h < 80; h++) ts.push({ time: new Date(now + h * 3600e3).toISOString(), data: { instant: { details: { wind_speed: 6 + h % 10, wind_speed_of_gust: 9 + h % 14, wind_from_direction: 200, air_pressure_at_sea_level: 1008.4 } }, next_1_hours: { summary: { symbol_code: h === 5 ? 'heavyrainandthunder' : 'cloudy' }, details: { precipitation_amount: h === 5 ? 18.2 : 0.1, probability_of_thunder: h === 5 ? 60 : 2, probability_of_precipitation: 40 } } } });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ properties: { meta: { updated_at: new Date(now).toISOString() }, timeseries: ts } })); return;
  }
  if (req.url.startsWith('/gdacsapi/api/events/geteventlist/SEARCH')) {
    gdHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ features: [{ geometry: { type: 'Point', coordinates: [125.1, 14.2] }, properties: { eventid: 1001300, eventname: 'TESTSTORM-26', alertlevel: 'Orange', fromdate: new Date(now - 2 * 86400e3).toISOString(), todate: new Date(now).toISOString(), iscurrent: 'true', severitydata: { severity: 150, severitytext: 'Typhoon (maximum wind speed of 150 km/h)' }, url: { report: 'https://www.gdacs.org/report.aspx?eventid=1001300' } } }] })); return;
  }
  res.writeHead(404); res.end();
}).listen(8791);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const get = async (p) => { const r = await fetch(BASE + p); return { s: r.status, b: await r.json().catch(() => null) }; };
try {
  let r = await get('/api/v1/wx/point?lat=12.93&lon=100.84');
  ok(r.s === 200, 'point 200 ' + r.s + JSON.stringify(r.b));
  ok(r.b && r.b.lat === 12.9 && r.b.lon === 100.8, 'rounded to 0.1');
  ok(r.b && r.b.series.length >= 70 && r.b.series[5].th === 60 && r.b.series[5].r === 18.2 && /thunder/.test(r.b.series[5].s), 'fields');
  ok(r.b && r.b.series[0].g === 9 && r.b.series[0].d === 200, 'gust/dir');
  ok(/SeaScout/.test(lastUA), 'identifying UA');
  ok(/MET Norway/.test(r.b.source) && /CC BY/.test(r.b.licence), 'attribution');
  const before = metHits;
  r = await get('/api/v1/wx/point?lat=12.94&lon=100.76'); ok(r.s === 200 && metHits === before && r.b.cached === true, 'same cell is served from cache');
  for (let i = 0; i < 50; i++) await get('/api/v1/wx/point?lat=12.9' + (i % 5) + '&lon=100.8');
  ok(metHits === before, 'burst of 50 requests in one cell = 0 upstream calls (' + (metHits - before) + ')');
  r = await get('/api/v1/wx/point?lat=99&lon=0'); ok(r.s === 400, 'bad lat 400');
  r = await get('/api/v1/wx/point?lat=abc&lon=0'); ok(r.s === 400, 'NaN 400');
  r = await get('/api/v1/wx/storms'); ok(r.s === 200 && r.b.storms.length === 1 && r.b.storms[0].name === 'TESTSTORM-26' && r.b.storms[0].kmh === 150 && r.b.storms[0].lat === 14.2, 'storms ' + JSON.stringify(r.b));
  ok(/GDACS/.test(r.b.licence), 'gdacs credit');
  const g0 = gdHits; await get('/api/v1/wx/storms'); await get('/api/v1/wx/storms'); ok(gdHits === g0, 'storms cached');
} finally { srv.close(); }
console.log(`weather: ${pass}/${pass + fail} pass`); process.exit(fail ? 1 : 0);
