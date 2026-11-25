"""DairyFlow data generator.

Builds data/data.json for the DairyFlow app from the latest Microfas export ZIP
(Google Drive, or a local --zip) plus the portal history (static_data/*.xlsx).
It reuses generate_data.py (schema 5.x) for every sales, receivables and order
figure, so DairyFlow and the dashboard always agree, then adds customer
locations, contact details and the lists each module needs.

Every total is checked against the dashboard dataset before the file is written;
if one check fails the script stops and nothing is published.

  python scripts/dairyflow_data.py                 # latest ZIP from Drive
  python scripts/dairyflow_data.py --zip export.zip --out data/data.json
"""
import argparse, csv, datetime as D, gzip, io, json, math, os, re, sys, tempfile, zipfile
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEN = HERE / 'generate_data.py'
GROUPS = ['Milk powder', 'Feed', 'Calf housing', 'Calf supplies', 'Perfect Udder', 'Other']
COUNTRY = {'Austria': 'AT', 'Belgium': 'BE', 'Denmark': 'DK', 'France': 'FR', 'Deutschland': 'DE', 'Hungary': 'HU', 'Luxembourgh': 'LU',
           'Poland': 'PL', 'Switzerland': 'CH', 'Nederland': 'NL', 'Tsjechië': 'CZ', 'Spain': 'ES', 'United Kingdom': 'GB', 'Ireland': 'IE',
           'Sweden': 'SE', 'Slovakia': 'SK', 'Romania': 'RO'}
DIAL = {'NL': '31', 'DE': '49', 'BE': '32', 'AT': '43', 'CH': '41', 'DK': '45', 'FR': '33', 'LU': '352', 'PL': '48', 'CZ': '420',
        'HU': '36', 'ES': '34', 'GB': '44', 'IE': '353', 'SE': '46', 'SK': '421', 'RO': '40'}

def load_generator():
    src = GEN.read_text(encoding='utf-8')
    hook = "    CU, PR, VK, CA, MO = Codes(), Codes(), Codes(), Codes(), Codes()\n"
    if hook not in src:
        sys.exit('generate_data.py changed: cannot find the customer code table (CU). Update dairyflow_data.py.')
    src = src.replace(hook, hook + "    global _CU; _CU = CU\n", 1)
    g = {'__name__': 'generate_data', '__file__': str(GEN)}
    exec(compile(src, str(GEN), 'exec'), g)
    return g

_MJ = re.compile('[Â-ô][\u0080-¿€‚ƒ„…†‡ˆ‰Š‹ŒŽ'
                 '‘’“”•–—˜™š›œžŸ]{1,3}')
def fixtxt(s):
    """Repair UTF-8 text that was stored as Windows-1252 (e.g. 'RÃ¡kÃ³czi' -> 'Rákóczi')."""
    def one(m):
        t = m.group(0)
        for k in range(len(t), 1, -1):
            try: return t[:k].encode('cp1252').decode('utf-8') + t[k:]
            except Exception: pass
        return t
    return _MJ.sub(one, s) if s else s

def nul(v): return '' if v in (None, 'NULL') else str(v).strip()

def phone(raw, cc):
    """Normalise to +<country><number>; '' when it is not a phone number."""
    s = nul(raw)
    if len(re.sub(r'\D', '', s)) < 6: return ''
    s = re.sub(r'[^\d+]', '', s)
    if s.startswith('00'): s = '+' + s[2:]
    elif s.startswith('0') and cc in DIAL: s = '+' + DIAL[cc] + s[1:]
    elif not s.startswith('+') and cc in DIAL: s = '+' + DIAL[cc] + s
    return s

EMAIL = re.compile(r'^[^@\s;,]+@[^@\s;,]+\.[A-Za-z]{2,}$')
def email(raw):
    s = nul(raw).replace(' ', '')
    return s if EMAIL.match(s) else ''

MULTI_REP = 'Multiple representatives'   # label the generator gives a customer that has more than one verkoper

def crm_refs(keys, vk_of_cust, links, rel):
    """CRM support, added without touching any existing figure.
    ref:  position in the customer list -> Microfas customer id (stable; the position can shift between runs)
    reps: only for customers with several verkopers, position -> the names of those verkopers (as text).
    Never raises on odd source rows: a missing name is simply left out."""
    ref = [str(k) for k in keys]
    roles = defaultdict(set)
    for r in links:
        roles[str(r.get('id_rel'))].add(str(r.get('id_rel__vert')))
    reps = {}
    for ci, k in enumerate(ref):
        if vk_of_cust[ci] != MULTI_REP: continue
        names = sorted({fixtxt(nul(rel[v].get('naam_volledig'))) for v in roles.get(k, ()) if v in rel and nul(rel[v].get('naam_volledig'))})
        if names: reps[ci] = names
    return ref, reps

def read_tables(archive, names):
    out = {}
    with zipfile.ZipFile(archive) as z:
        for n in z.namelist():
            k = re.sub(r'_\d{4}-\d\d-\d\d$', '', Path(n).stem)
            if k in names:
                with io.TextIOWrapper(z.open(n), encoding='utf-8-sig', newline='') as s:
                    out[k] = list(csv.DictReader(s))
    missing = set(names) - set(out)
    if missing: sys.exit(f'Export is missing tables: {sorted(missing)}')
    return out

def pip(x, y, ring):
    ins, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi: ins = not ins
        j = i
    return ins

def build(archive, portal):
    G = load_generator()
    ds = G['build'](archive, portal)
    X = G['build_dashboard'](ds)
    keys = G['_CU'].items
    if len(keys) != len(X['customers']): sys.exit('Customer code table does not match the dashboard customers.')
    T = read_tables(archive, {'rel', 'alg_land', 'rel_k_rel__vert'})
    rel = {r['id']: r for r in T['rel']}
    land = {r['id']: COUNTRY.get(r['naam'], '') for r in T['alg_land']}
    with gzip.open(HERE / 'static' / 'postcodes.json.gz', 'rt', encoding='utf-8') as f: P = json.load(f)
    geo = json.load(open(HERE / 'static' / 'geo.json', encoding='utf-8'))

    F, M, cust, n = X['facts'], X['months'], X['customers'], len(X['facts']['r'])
    lt = D.date.fromisoformat(X['meta']['ledgerThrough'])
    names = [fixtxt(c[0]) for c in cust]
    gidx = [GROUPS.index(c[1]) if c[1] in GROUPS else 5 for c in X['categories']]
    ym = lambda m: tuple(map(int, M[m].split('-')))
    # rolling windows
    y_last, m_last = ym(len(M) - 1)
    last12 = {f'{y}-{m:02}' for y, m in [((y_last * 12 + m_last - 1 - k) // 12, (y_last * 12 + m_last - 1 - k) % 12 + 1) for k in range(12)]}
    lastfull = m_last - 1 if lt.day < 28 else m_last           # Jan..last complete month, this year vs last year
    ytd = {f'{y_last}-{m:02}' for m in range(1, lastfull + 1)}; pytd = {f'{y_last - 1}-{m:02}' for m in range(1, lastfull + 1)}

    rev12, kg12, grp = defaultdict(int), defaultdict(int), defaultdict(lambda: [0] * 6)
    ytdR, pytdR, last, first = defaultdict(int), defaultdict(int), {}, {}
    for i in range(n):
        c, m, r = F['c'][i], M[F['m'][i]], F['r'][i]
        y, mm = ym(F['m'][i]); dt = D.date(y, mm, F['d'][i]).isoformat() if F['d'][i] else f'{y}-{mm:02}'   # portal months: month only
        if m in last12: rev12[c] += r; kg12[c] += F['k'][i]; grp[c][gidx[F['g'][i]]] += r
        if m in ytd: ytdR[c] += r
        if m in pytd: pytdR[c] += r
        if r > 0:
            if c not in last or dt > last[c]: last[c] = dt
            if c not in first or dt < first[c]: first[c] = dt

    # locations, regions, contacts
    regions = geo['regions']
    def region_of(cc, lo, la):
        best = None
        for k, rg in enumerate(regions):
            if rg['cc'] == cc and any(pip(lo, la, r) for r in rg['r']): return k
        cands = [(k, rg) for k, rg in enumerate(regions) if rg['cc'] == cc]
        if not cands: return -1
        cen = lambda rg: (lambda r: (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)))(max(rg['r'], key=len))
        return min(cands, key=lambda kr: (cen(kr[1])[0] - lo) ** 2 + (cen(kr[1])[1] - la) ** 2)[0]
    rows, unmapped, contacts = [], [], {}
    for ci, key in enumerate(keys):
        r = rel.get(str(key))
        cc = land.get(r['id_alg_land__aflever'], '') if r else ''
        if r:
            ph = [p for p in dict.fromkeys(phone(r.get(f), cc) for f in ('tel1', 'mob1', 'tel2')) if p]
            em = [e for e in dict.fromkeys(email(r.get(f)) for f in ('email1', 'email2')) if e]
            if ph or em: contacts[ci] = [ph, em]
        loc = None
        if r and cc in P['pc']:
            raw = re.sub(r'^[A-Z]{1,3}\s*-\s*', '', nul(r['aflever_postcode']).upper())
            z, bp = P['pc'][cc], P['place'][cc]; p = raw.replace(' ', '')
            for q in ([raw.split()[0]] if cc == 'GB' and raw else []) + [p[:4] if cc == 'NL' else p, re.sub(r'\D', '', p)]:
                if q in z: loc = z[q]; break
            if not loc:
                pl = nul(r['aflever_plaats']).lower()
                for q in (pl, re.split(r'[/,(]| ot | gt ', pl)[0].strip()):
                    if q in bp: loc = bp[q]; break
        if not loc: unmapped.append([ci, names[ci], cust[ci][2]]); continue
        place = fixtxt(nul(r['aflever_plaats'])); place = place.title() if place.isupper() or place.islower() else place
        rows.append([ci, names[ci], cust[ci][2], cust[ci][3], cc, nul(r['aflever_postcode']), place, loc[0], loc[1],
                     region_of(cc, loc[1], loc[0]), rev12[ci], kg12[ci], grp[ci], ytdR[ci], pytdR[ci], str(last.get(ci, '')), str(first.get(ci, ''))])
    used = {r[9] for r in rows}
    keep = [k for k, rg in enumerate(regions) if rg['cc'] in ('NL', 'DE', 'BE') or k in used]
    remap = {k: j for j, k in enumerate(keep)}
    for r in rows: r[9] = remap.get(r[9], -1)
    regions = [regions[k] for k in keep]
    want = {r[4] for r in rows} | {'NL', 'DE', 'BE'}
    countries = geo['countries']

    # work email of each verkoper (their own Microfas record); used only by the API to send sign-up codes
    staff = {}
    for vid in {r['id_rel__vert'] for r in T['rel_k_rel__vert']}:
        r = rel.get(vid)
        if r and nul(r['naam_volledig']) and email(r.get('email1')): staff[nul(r['naam_volledig'])] = email(r.get('email1'))
    staff = {k: v for k, v in staff.items() if k in set(X['verkopers'])}
    crm_ref, crm_reps = crm_refs(keys, [c[2] for c in cust], T['rel_k_rel__vert'], rel)
    # orders and their value (same rule as the dashboard)
    ov, ok, items, priced = defaultdict(int), defaultdict(lambda: [0, 0]), defaultdict(list), set()
    for l in X['openLines']:
        nm = X['products'][l[3]][0] if l[3] is not None and l[3] < len(X['products']) else ''
        if l[5] and nm and nm.lower() != 'tekst' and nm not in items[l[0]]: items[l[0]].append(nm)
        if l[11]: ov[l[0]] += l[10] + max(0, l[9] - l[10]); priced.add(l[0])
        if l[4] == 'kg': ok[l[0]][0] += l[5]; ok[l[0]][1] += l[6]
    orders = []
    for o in X['orders']:
        if not o[5]: continue
        orders.append(dict(no=o[0], od=o[1], c=o[2], v=o[3], st=o[4], due=o[6], rel=o[7], stage=o[12], lines=o[8],
                           val=ov.get(o[0], 0) if o[12] in ('toDeliver', 'deliveredNotInvoiced') else 0,
                           kgOrd=round(ok[o[0]][0] / 1e6, 3), kgDel=round(ok[o[0]][1] / 1e6, 3),
                           items=items.get(o[0], []), priced=o[0] in priced))
    open_ord = defaultdict(int)
    for o in orders:
        if o['stage'] in ('toDeliver', 'deliveredNotInvoiced'): open_ord[o['c']] += o['val']

    # receivables per customer (Microfas open items, incl. VAT), payment behaviour, VAT ratio
    inv, late, gr = defaultdict(list), defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for a in X['ar']:
        c, terms = a[0], cust[a[0]][3]
        if a[11] != 0:
            inv[c].append(dict(no=a[1], d=a[2], due=a[3], incl=a[11], ex=a[6], late=(lt - D.date.fromisoformat(a[3])).days if a[3] else None))
        if a[11] == 0 and a[8] is not None and a[4] > 0 and terms is not None: late[c][0] += (a[8] - terms) * a[4]; late[c][1] += a[4]
        if a[4] > 0: gr[c][0] += a[4]; gr[c][1] += a[10]
    coll = []
    for c, L in inv.items():
        pos = [x for x in L if x['incl'] > 0]
        b = late.get(c)
        coll.append(dict(c=c, inv=sorted(L, key=lambda x: x['d']), oo=open_ord.get(c, 0),
                         open=sum(x['incl'] for x in pos), cred=sum(x['incl'] for x in L if x['incl'] < 0),
                         over=sum(x['incl'] for x in pos if (x['late'] or 0) > 0), over30=sum(x['incl'] for x in pos if (x['late'] or 0) > 30),
                         oldest=max([x['late'] or 0 for x in pos] + [0]), late=round(b[0] / b[1], 1) if b and b[1] else None))
    # customer x product (daily data), weekly and monthly per group, monthly per customer
    cp, wk, mg, cm = defaultdict(lambda: [0, 0, 0, 0, '']), defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0]), defaultdict(int)
    pk, pg = defaultdict(int), defaultdict(lambda: defaultdict(int))
    for i in range(n):
        c, p, g, m = F['c'][i], F['p'][i], gidx[F['g'][i]], F['m'][i]
        pk[p] += F['k'][i]; pg[p][g] += abs(F['r'][i]); cm[(c, m)] += F['r'][i]
        x = mg[(m, g)]; x[0] += F['k'][i]; x[1] += F['r'][i]
        if F['d'][i]:
            x = cp[(c, p)]; x[0] += F['r'][i]; x[1] += F['k'][i]; x[2] += F['q'][i]; x[3] += 1
            y, mm = ym(m); t = (D.date(y, mm, F['d'][i]) - D.date(1970, 1, 1)).days
            if F['r'][i] > 0: x[4] = max(x[4], D.date(y, mm, F['d'][i]).isoformat())   # last day this product was ordered
            x = wk[(t, g)]; x[0] += F['k'][i]; x[1] += F['r'][i]

    # last order per customer (daily data since 7 April 2026): date, value and products of that day
    CHG = re.compile(r'kosten|diversen|korting|toeslag|vracht|freight|statiegeld|emballage', re.I)
    byday = defaultdict(lambda: defaultdict(lambda: [0, set()]))
    for i in range(n):
        if not F['d'][i]: continue
        y, mm = ym(F['m'][i]); day = D.date(y, mm, F['d'][i]).isoformat()
        x = byday[F['c'][i]][day]; x[0] += F['r'][i]
        if F['r'][i] > 0 and not CHG.search(X['products'][F['p'][i]][0] or ''): x[1].add(F['p'][i])
    quiet = []
    for c, days in byday.items():
        od = [d for d, v in days.items() if v[0] > 0 and v[1]]          # order days: positive value, at least one real product
        if not od: continue
        last = max(od); v = days[last]
        quiet.append(dict(c=c, last=last, rev=v[0], items=sorted(X['products'][p][0] for p in v[1]), orders=len(od),
                          since=(lt - D.date.fromisoformat(last)).days))
    quiet.sort(key=lambda q: -q['since'])

    # product totals (all customers) and, per main product group, how many customers buy each product
    ptot = defaultdict(lambda: [0, 0, 0]); cust_g = defaultdict(lambda: [0] * 6); buys = defaultdict(set)
    prodgrp = {i: (max(pg[i], key=pg[i].get) if pg[i] else 5) for i in range(len(X['products']))}
    for (c, p), v in cp.items():
        t = ptot[p]; t[0] += v[0]; t[1] += v[1]; t[2] += v[2]
        if v[0] > 0: cust_g[c][prodgrp[p]] += v[0]; buys[c].add(p)
    pen = {}
    for c, g in cust_g.items():
        m = g.index(max(g)); x = pen.setdefault(m, {'peers': 0, 'p': defaultdict(int)}); x['peers'] += 1
        for p in buys[c]: x['p'][p] += 1
    data = dict(
        meta=dict(lt=X['meta']['ledgerThrough'], snap=X['meta']['snapshot'], lostCut=(lt - D.timedelta(days=180)).isoformat(), months=M,
                  qScale=X['qScale'], arStart=X['meta']['arStart'], portal=X['meta']['portalMonths'], schema=X['meta']['schemaVersion'],
                  ytd=sorted(ytd)[0] + '/' + sorted(ytd)[-1] if ytd else '', generated=D.datetime.now(D.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')),
        cols=['i', 'n', 'v', 't', 'cc', 'pc', 'pl', 'la', 'lo', 'rg', 'r12', 'k12', 'g', 'y', 'py', 'ls', 'fs'],
        customers=rows, unmapped=unmapped, names=names, vkOfCust=[c[2] for c in cust], verkopers=X['verkopers'],
        terms=[c[3] for c in cust], market=[c[1] for c in cust], contacts=contacts,
        regions=regions, countries=countries, groups=GROUPS,
        quiet=quiet, calls=[], cadence=[],   # calls/cadence kept empty so an older API script still runs
        collections=coll, orders=orders,
        products=[[p[0], 1 if pk[i] > 0 else 0, max(pg[i], key=pg[i].get) if pg[i] else 5] for i, p in enumerate(X['products'])],
        cp=[[c, p, *v] for (c, p), v in cp.items()],
        dayGroup=[[t, g, *v] for (t, g), v in sorted(wk.items())], monthGroup=[[m, g, *v] for (m, g), v in sorted(mg.items())],
        cm=[[c, m, v] for (c, m), v in cm.items() if v],
        vatRatio={c: round(v[1] / v[0], 4) for c, v in gr.items() if v[0] > 0},
        lateness={c: round(v[0] / v[1], 1) for c, v in late.items() if v[1] > 0},
        staff=staff, prodTot={p: v for p, v in ptot.items()}, pen={g: {'peers': x['peers'], 'p': dict(x['p'])} for g, x in pen.items()},
        margin=X['margin'], costs=X['costs'], contracts=X['contracts'],
        ref=crm_ref, reps=crm_reps)   # CRM: Microfas id per customer position, rep names of multi-rep customers
    check(data, X, rev12)
    return data

def check(d, X, rev12):
    F = X['facts']; n = len(F['r']); daily = [i for i in range(n) if F['d'][i]]
    tests = {
        'customers on the map + not on the map = all customers': len(d['customers']) + len(d['unmapped']) == len(X['customers']),
        '12-month revenue per customer = facts': all(c[10] == rev12[c[0]] for c in d['customers']),
        'last order value = that day in daily facts': all(q['rev'] == sum(F['r'][i] for i in daily if F['c'][i] == q['c'] and '%s-%02d' % (d['meta']['months'][F['m'][i]], F['d'][i]) == q['last']) for q in d['quiet'][:40]),
        'days without an order >= 0': all(q['since'] >= 0 for q in d['quiet']),
        'open items incl. VAT = receivables': sum(x['incl'] for c in d['collections'] for x in c['inv']) == sum(a[11] for a in X['ar']),
        'open items excl. VAT = cohort balance': sum(x['ex'] for c in d['collections'] for x in c['inv']) == X['recon']['cohortBalanceCents'],
        'collection totals = their invoices': all(c['open'] == sum(x['incl'] for x in c['inv'] if x['incl'] > 0) and c['cred'] == sum(x['incl'] for x in c['inv'] if x['incl'] < 0) for c in d['collections']),
        'customer x product = daily facts': (sum(r[2] for r in d['cp']), sum(r[3] for r in d['cp']), sum(r[4] for r in d['cp'])) == (sum(F['r'][i] for i in daily), sum(F['k'][i] for i in daily), sum(F['q'][i] for i in daily)),
        'weekly group totals = daily facts': (sum(r[2] for r in d['dayGroup']), sum(r[3] for r in d['dayGroup'])) == (sum(F['k'][i] for i in daily), sum(F['r'][i] for i in daily)),
        'monthly group totals = all facts': (sum(r[2] for r in d['monthGroup']), sum(r[3] for r in d['monthGroup'])) == (sum(F['k']), sum(F['r'])),
        'customer-month revenue = all facts': sum(r[2] for r in d['cm']) == sum(F['r']),
        'region index valid': all(-1 <= c[9] < len(d['regions']) for c in d['customers']),
        'CRM: one unique Microfas id per customer': len(d['ref']) == len(d['names']) and len(set(d['ref'])) == len(d['ref']) and all(d['ref']),
        'CRM: rep names only on multi-rep customers': all(d['vkOfCust'][int(i)] == MULTI_REP and n for i, n in d['reps'].items()),
        'product totals = customer x product': [sum(v[k] for v in d['prodTot'].values()) for k in range(3)] == [sum(r[k] for r in d['cp']) for k in (2, 3, 4)],
    }
    bad = [k for k, v in tests.items() if not v]
    for k, v in tests.items(): print(('PASS ' if v else 'FAIL ') + k)
    if bad: sys.exit('Checks failed, data.json not written: ' + '; '.join(bad))

if __name__ == '__main__':
    try:
        from dotenv import load_dotenv; load_dotenv()
    except ImportError: pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--zip', default=os.getenv('LOCAL_ZIP_PATH'))
    ap.add_argument('--portal', nargs='*', default=[HERE / 'static_data' / f for f in ('DT_Portal_Export_2025.xlsx', 'DT_Portal_Export_Q1_2026.xlsx')])
    ap.add_argument('--out', default=HERE.parent / 'data' / 'data.json')
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        archive = a.zip
        if not archive:
            archive = load_generator()['download_latest_zip'](tmp)
            print('Downloaded', Path(archive).name)
        data = build(archive, a.portal)
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    tmpf = out.with_suffix('.tmp'); tmpf.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8'); os.replace(tmpf, out)
    print(f"Wrote {out} · data through {data['meta']['lt']} · {len(data['customers'])} customers on the map · {len(data['contacts'])} with contact details")
