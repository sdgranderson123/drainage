# Rebuild crs-us.json: every US projected coordinate system (state plane NAD27/NAD83/HARN/2011, UTM, Iowa
# regional) with its area of use and proj4 string, from epsg.io. Takes a few minutes.
# Usage: python tools/build_crs_table.py crs-us.json
import json, sys, urllib.request, concurrent.futures as cf, ssl, os
ranges = [(2222,2290),(2759,2971),(3088,3092),(3358,3364),(3403,3421),(3433,3457),(3479,3481),(3560,3567),(3568,3575),(3580,3583),
          (3734,3761),(26729,26800),(26847,26871),(26901,26924),(26929,26999),(32001,32062),(32099,32167),(6330,6349),(6350,6631),(7057,7071),(8826,8827)]
codes = [c for a,b in ranges for c in range(a,b)]
ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE')) if os.environ.get('SSL_CERT_FILE') else ssl.create_default_context()
def get(url):
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; FieldGrade-build)'})
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r: return r.read().decode()
        except Exception as e: err=e
    return None
def one(c):
    j = get(f'https://epsg.io/{c}.json')
    if not j: return None
    try: d = json.loads(j)
    except Exception: return None
    if d.get('type') != 'ProjectedCRS': return None
    area = d.get('area') or ''
    if 'United States' not in area and 'USA' not in area: return None
    p4 = (get(f'https://epsg.io/{c}.proj4') or '').strip()
    if not p4.startswith('+proj'): return None
    bb = d.get('bbox') or {}
    return {'c': c, 'n': d.get('name'), 'b': [bb.get('south_latitude'), bb.get('west_longitude'), bb.get('north_latitude'), bb.get('east_longitude')],
            'a': area.replace('United States (USA) - ', ''), 'p': p4.replace(' +type=crs','').replace(' +no_defs','')}
out = []
with cf.ThreadPoolExecutor(16) as ex:
    for r in ex.map(one, codes):
        if r: out.append(r)
out.sort(key=lambda r: r['c'])
json.dump(out, open(sys.argv[1], 'w'), separators=(',',':'))
print(len(out), 'systems', os.path.getsize(sys.argv[1]), 'bytes')
