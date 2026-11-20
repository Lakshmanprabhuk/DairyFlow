"""One-off: build the fixed reference files DairyFlow needs (postcode centroids, borders).
Sources (download once, not needed at runtime):
  postcodes: GeoNames postal codes via github.com/zauberware/postal-codes-json-xml-csv (data/<CC>.zip), CC BY 4.0
  borders:   Natural Earth 10m admin 0 + admin 1 (github.com/nvkelso/natural-earth-vector), public domain
Usage: python build_static.py <dir with <CC>/zipcodes.<cc>.csv> <natural-earth geojson dir>"""
import csv, gzip, json, math, sys
from collections import defaultdict
from pathlib import Path
CCS=['NL','DE','BE','CZ','AT','LU','DK','PL','FR','CH','HU','ES','GB','IE','SE','SK','RO']
pcdir, nedir = Path(sys.argv[1]), Path(sys.argv[2]); out = Path(__file__).parent / 'static'
pcs, places = {}, {}
for c in CCS:
    acc, bp = defaultdict(list), {}
    for r in csv.DictReader(open(pcdir / c / f'zipcodes.{c.lower()}.csv', encoding='utf-8')):
        try: la, lo = float(r['latitude']), float(r['longitude'])
        except ValueError: continue
        acc[r['zipcode'].replace(' ', '')].append((la, lo)); bp.setdefault(r['place'].lower(), (round(la, 4), round(lo, 4)))
    pcs[c] = {k: [round(sum(a for a, _ in v) / len(v), 4), round(sum(b for _, b in v) / len(v), 4)] for k, v in acc.items()}
    places[c] = bp
with gzip.open(out / 'postcodes.json.gz', 'wt', encoding='utf-8') as f: json.dump({'pc': pcs, 'place': places}, f, separators=(',', ':'))
def dp(pts, tol):
    if len(pts) < 3: return pts
    (ax, ay), (bx, by) = pts[0], pts[-1]; L = math.hypot(bx - ax, by - ay) or 1e-12; dmax = idx = 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]; d = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L
        if d > dmax: dmax, idx = d, i
    return dp(pts[:idx + 1], tol)[:-1] + dp(pts[idx:], tol) if dmax > tol else [pts[0], pts[-1]]
def simp(geom, tol):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]; res = []
    for poly in polys:
        ring = [tuple(p) for p in poly[0]]; x0, y0 = ring[0]
        k = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
        r = dp(ring[:k + 1], tol)[:-1] + dp(ring[k:], tol)
        if len(r) >= 4: res.append([[round(x, 3), round(y, 3)] for x, y in r])
    return res
BB = (-11, 35, 30, 61); inbb = lambda rings: any(BB[0] <= x <= BB[2] and BB[1] <= y <= BB[3] for r in rings for x, y in r)
countries = []
for f in json.load(open(nedir / 'ne_10m_admin_0_countries.geojson'))['features']:
    p = f['properties']
    if p.get('CONTINENT') != 'Europe': continue
    rings = simp(f['geometry'], 0.03)
    if rings and inbb(rings): countries.append(dict(n=p['NAME'], cc=p.get('ISO_A2_EH') or p.get('ISO_A2'), r=rings))
regions = []
for f in json.load(open(nedir / 'ne_10m_admin_1_states_provinces.geojson'))['features']:
    p = f['properties']; cc = p.get('iso_a2')
    if cc not in CCS: continue
    rings = simp(f['geometry'], 0.015)
    if rings and inbb(rings): regions.append(dict(n=p.get('name_nl') if cc in ('NL', 'BE') and p.get('name_nl') else p.get('name'), cc=cc, r=rings))
json.dump(dict(countries=countries, regions=regions), open(out / 'geo.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(sum(len(v) for v in pcs.values()), 'postcodes,', len(countries), 'countries,', len(regions), 'regions')
