#!/usr/bin/env python3
"""Build the world hazard pack (rocks, reefs, wrecks, obstructions, shoals) from OpenStreetMap via Overpass.

Runs in GitHub Actions. Resumable: each 10x10-degree ocean tile is saved to data/hazards_raw/<id>.json.gz,
so a run that hits its time budget continues next run. When every tile is present it writes data/hazards.zip
(hazards/index.json + hazards/b/<S>_<W>.json.gz, 20-degree blocks) in the format the app reads.
Data: (c) OpenStreetMap contributors, ODbL 1.0.
"""
import gzip, io, json, os, sys, time, urllib.parse, urllib.request, zipfile, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'hazards_raw')
OUT = os.path.join(ROOT, 'data', 'hazards.zip')
BUDGET_S = float(os.environ.get('HAZ_BUDGET_S', 5 * 3600))
MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
           'https://overpass.private.coffee/api/interpreter']
UA = 'SeaScout-hazard-pack-builder/1.0 (GitHub Actions; marine app; monthly)'
KINDS = ['rock', 'reef', 'wreck', 'obstruction', 'shoal']


def tiles():
    with zipfile.ZipFile(os.path.join(ROOT, 'data', 'eot20.zip')) as z:
        return json.loads(z.read('eot20/index.json'))['tiles']


def query(s, w, n, e, t=90, ms=134217728):
    bb = f'({s},{w},{n},{e})'
    return (f'[out:json][timeout:{t}][maxsize:{ms}];(nwr["seamark:type"~"^(rock|wreck|obstruction)$"]{bb};'
            f'nwr["natural"~"^(reef|shoal)$"]{bb};nwr["historic"="wreck"]{bb};);out center tags;')


def kind(t):
    st = t.get('seamark:type', '')
    if st == 'rock': return 'rock'
    if st == 'wreck' or t.get('historic') == 'wreck': return 'wreck'
    if st == 'obstruction': return 'obstruction'
    if t.get('natural') == 'reef': return 'reef'
    if t.get('natural') == 'shoal': return 'shoal'
    return None


def normalise(js):
    out, seen = [], set()
    for el in js.get('elements', []):
        t = el.get('tags') or {}
        k = kind(t)
        c = el.get('center') or {}
        lat, lon = el.get('lat', c.get('lat')), el.get('lon', c.get('lon'))
        oid = (el.get('type') or 'n')[0] + str(el.get('id'))
        if not k or lat is None or lon is None or oid in seen: continue
        seen.add(oid)
        d = t.get(f'seamark:{k}:depth', t.get('depth'))
        try: depth = float(str(d).replace(',', '.')) if d is not None else None
        except ValueError: depth = None
        out.append([oid, KINDS.index(k), round(float(lat), 5), round(float(lon), 5),
                    str(t.get('seamark:name') or t.get('name') or t.get('name:en') or ''), depth,
                    str(t.get(f'seamark:{k}:water_level') or ''), str(t.get(f'seamark:{k}:category') or t.get('reef') or ''),
                    0 if el.get('type') == 'node' else 1])
    return out


def fetch(s, w, n, e, **kw):
    body = urllib.parse.urlencode({'data': query(s, w, n, e, **kw)}).encode()
    last = None
    for rnd in range(3):
        for ep in MIRRORS:
            try:
                req = urllib.request.Request(ep, data=body, headers={'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded'})
                with urllib.request.urlopen(req, timeout=240) as r:
                    js = json.loads(r.read())
                rem = js.get('remark') or ''
                if any(x in rem for x in ('runtime error', 'timed out', 'out of memory')):
                    raise RuntimeError(rem[:120])
                return normalise(js)
            except Exception as ex:  # noqa: BLE001
                last = ex
                time.sleep(5 * (rnd + 1))
    raise RuntimeError(f'all mirrors failed: {last}')


def tile_rows(s, w):
    try:
        return fetch(s, w, s + 10, w + 10)
    except Exception as ex:  # noqa: BLE001
        print(f'  split {s}_{w}: {ex}', flush=True)
        rows = []
        for a, b in ((0, 0), (0, 5), (5, 0), (5, 5)):
            rows += fetch(s + a, w + b, s + a + 5, w + b + 5, t=180, ms=536870912)
            time.sleep(2)
        return rows


def assemble(ids):
    D, groups, missing = 20, {}, 0
    for tid in ids:
        p = os.path.join(RAW, tid + '.json.gz')
        if not os.path.exists(p): missing += 1; continue
        s, w = map(int, tid.split('_'))
        bid = f'{(s // D) * D}_{(w // D) * D}'
        g = groups.setdefault(bid, {})
        for r in json.loads(gzip.decompress(open(p, 'rb').read())):
            g[r[0]] = r
    blocks, count = [], 0
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_STORED) as z:
        for bid, g in sorted(groups.items()):
            if not g: continue
            blocks.append(bid); count += len(g)
            z.writestr(f'hazards/b/{bid}.json.gz', gzip.compress(json.dumps({'rows': list(g.values())}, separators=(',', ':')).encode(), 9))
        z.writestr('hazards/index.json', json.dumps({'schema': 'SeaScout-Hazards-v1', 'built': datetime.date.today().isoformat(),
            'blockDeg': D, 'blocks': blocks, 'count': count, 'missingTiles': missing,
            'source': 'OpenStreetMap / OpenSeaMap via Overpass API', 'license': 'ODbL 1.0 · © OpenStreetMap contributors', 'kinds': KINDS}))
    print(f'hazards.zip: {len(blocks)} blocks, {count} points, missing tiles {missing}', flush=True)


UKHO_WFS = 'https://ows.emodnet-humanactivities.eu/wfs'


def ukho_wrecks():
    """UK Hydrographic Office worldwide wreck locations, published via EMODnet Human Activities.
    Open Government Licence v3.0 (commercial use allowed with attribution)."""
    rows, start, page = [], 0, 10000
    while True:
        q = urllib.parse.urlencode({'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'emodnet:wwshipwrecks',
                                    'outputFormat': 'application/json', 'count': page, 'startIndex': start, 'sortBy': 'wreck_id'})
        req = urllib.request.Request(UKHO_WFS + '?' + q, headers={'User-Agent': UA})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    js = json.loads(r.read()); break
            except Exception as ex:  # noqa: BLE001
                if attempt == 3: raise
                print(f'  retry page {start}: {ex}', flush=True); time.sleep(10 * (attempt + 1))
        feats = js.get('features') or []
        for f in feats:
            g, p = f.get('geometry') or {}, f.get('properties') or {}
            c = g.get('coordinates') or []
            if g.get('type') != 'Point' or len(c) < 2: continue
            lon, lat = float(c[0]), float(c[1])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180): continue
            try: depth = float(str(p.get('depth')).replace(',', '.'))
            except (TypeError, ValueError): depth = None
            wl = str(p.get('water_leve') or '').lower()
            wl = 'covers' if 'cover' in wl else 'awash' if 'awash' in wl else 'dry' if 'dry' in wl else 'submerged' if 'submerg' in wl or 'under water' in wl else ''
            name = str(p.get('name') or '')
            name = '' if name.lower() in ('n/a', 'unknown', 'none') else name
            cat = str(p.get('wreck_cate') or '')
            rows.append(['u' + str(p.get('wreck_id') or f.get('id')), KINDS.index('wreck'), round(lat, 5), round(lon, 5), name,
                         depth, wl, '' if cat == 'n/a' else cat, 0])
        print(f'UKHO page {start}: {len(feats)} (total {len(rows)})', flush=True)
        if len(feats) < page: break
        start += page
        time.sleep(2)
    return rows


def assemble_rows(rows, source, licence):
    D, groups = 20, {}
    for r in rows:
        bid = f'{int((r[2] // D) * D)}_{int((r[3] // D) * D)}'
        groups.setdefault(bid, {})[r[0]] = r
    blocks, count = [], 0
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_STORED) as z:
        for bid, g in sorted(groups.items()):
            blocks.append(bid); count += len(g)
            z.writestr(f'hazards/b/{bid}.json.gz', gzip.compress(json.dumps({'rows': list(g.values())}, separators=(',', ':')).encode(), 9))
        z.writestr('hazards/index.json', json.dumps({'schema': 'SeaScout-Hazards-v1', 'built': datetime.date.today().isoformat(),
            'blockDeg': D, 'blocks': blocks, 'count': count, 'missingTiles': 0, 'source': source, 'license': licence, 'kinds': KINDS}))
    print(f'hazards.zip: {len(blocks)} blocks, {count} points', flush=True)


def main():
    # r14.15.42b: the public Overpass servers are not meant for bulk downloads (502 "at capacity"),
    # so the pack is built from a published bulk dataset instead. Rocks/reefs from OpenStreetMap stay live per scan
    # (Open Waters Seamap tiles, then a small Overpass query for the scanned box only).
    if '--overpass' in sys.argv:
        return main_overpass()
    rows = ukho_wrecks()
    if len(rows) < 1000:
        raise SystemExit(f'too few wrecks ({len(rows)}), keeping the previous pack')
    assemble_rows(rows, 'UK Hydrographic Office worldwide wreck locations via EMODnet Human Activities (emodnet:wwshipwrecks)',
                  'Contains public sector information licensed under the Open Government Licence v3.0 · © UK Hydrographic Office')


def main_overpass():
    os.makedirs(RAW, exist_ok=True)
    ids, t0 = tiles(), time.time()
    if '--refresh' in sys.argv:  # monthly: start over
        for f in os.listdir(RAW): os.remove(os.path.join(RAW, f))
    todo = [i for i in ids if not os.path.exists(os.path.join(RAW, i + '.json.gz'))]
    print(f'{len(ids)} tiles, {len(todo)} to fetch', flush=True)
    for n, tid in enumerate(todo):
        if time.time() - t0 > BUDGET_S:
            print('time budget reached, continue next run', flush=True); break
        s, w = map(int, tid.split('_'))
        try:
            rows = tile_rows(s, w)
        except Exception as ex:  # noqa: BLE001
            print(f'{tid}: failed ({ex}), retry next run', flush=True); time.sleep(10); continue
        open(os.path.join(RAW, tid + '.json.gz'), 'wb').write(gzip.compress(json.dumps(rows, separators=(',', ':')).encode(), 9))
        print(f'[{n + 1}/{len(todo)}] {tid}: {len(rows)}', flush=True)
        time.sleep(2)
    left = [i for i in ids if not os.path.exists(os.path.join(RAW, i + '.json.gz'))]
    if not left or '--assemble' in sys.argv or len(left) < len(ids) * 0.02:
        assemble(ids)
    print(f'left: {len(left)}', flush=True)


if __name__ == '__main__':
    main()
