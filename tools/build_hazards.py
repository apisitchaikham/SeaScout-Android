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


def main():
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
