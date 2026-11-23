#!/usr/bin/env python3
"""Build Fuel's offline food database.

Writes two compact JSON files that the app downloads once and searches on the phone:
  fuel/data/common.json  generic foods from USDA FoodData Central (SR Legacy + Foundation), with household portions
  fuel/data/au.json      packaged products sold in Australia, from the Open Food Facts export

Both sources are open data (USDA: public domain; Open Food Facts: ODbL).
Run by .github/workflows/fuel-foods.yml every week. Needs only the Python standard library.
"""
import csv, gzip, io, json, os, re, sys, time, urllib.request, zipfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
UA = {'User-Agent': 'Fuel food log data build (github.com/liamflannery/nine-sets)'}
csv.field_size_limit(1 << 30)


def fetch(url, dest):
    print('download', url, flush=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    print('  ->', os.path.getsize(dest) // (1 << 20), 'MB', flush=True)
    return dest


def num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x and abs(x) < 1e6 else None


def r1(x):
    if x is None:
        return None
    x = round(x, 1)
    return int(x) if x == int(x) else x


# ---------------------------------------------------------------- USDA
USDA_SR = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip'
USDA_PAGE = 'https://fdc.nal.usda.gov/download-datasets'
SKIP_CATS = {'Beef Products', 'Pork Products', 'Lamb, Veal, and Game Products', 'Poultry Products',
             'Finfish and Shellfish Products', 'Sausages and Luncheon Meats', 'Baby Foods', 'Dairy and Egg Products',
             'American Indian/Alaska Native Foods'}
NUTR = {'1008': 'kcal', '2047': 'kcal2', '2048': 'kcal3', '1003': 'p', '1004': 'f', '1005': 'c', '1050': 'c2',
        '1079': 'fib', '2000': 'sug', '1063': 'sug2', '1258': 'sat', '1093': 'na'}
LIQUID = re.compile(r'(milk\b|juice|beverage|drink|soda\b|\bwater\b|\btea\b|coffee|broth|\bstock\b|\boil\b|syrup|wine\b|beer\b|vinegar|smoothie)', re.I)


def read_zip_csv(z, base):
    name = next((n for n in z.namelist() if n.endswith('/' + base) or n == base), None)
    if not name:
        return []
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, 'utf-8', errors='replace')))


def usda_from_zip(path, foods):
    z = zipfile.ZipFile(path)
    cats = {r['id']: r['description'] for r in read_zip_csv(z, 'food_category.csv')}
    units = {r['id']: r['name'] for r in read_zip_csv(z, 'measure_unit.csv')}
    keep = {}
    for r in read_zip_csv(z, 'food.csv'):
        if r.get('data_type') not in ('sr_legacy_food', 'foundation_food'):
            continue
        cat = cats.get(r.get('food_category_id', ''), '')
        if cat in SKIP_CATS:
            continue
        keep[r['fdc_id']] = {'name': r['description'].strip(), 'cat': cat, 'n': {}, 'por': []}
    name = next(n for n in z.namelist() if n.endswith('food_nutrient.csv'))
    with z.open(name) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8', errors='replace')):
            fd = keep.get(r['fdc_id'])
            k = NUTR.get(r.get('nutrient_id'))
            if fd and k:
                v = num(r.get('amount'))
                if v is not None:
                    fd['n'][k] = v
    for r in read_zip_csv(z, 'food_portion.csv'):
        fd = keep.get(r['fdc_id'])
        g = num(r.get('gram_weight'))
        if not fd or not g or g <= 0:
            continue
        amt = num(r.get('amount')) or 1
        unit = units.get(r.get('measure_unit_id', ''), '')
        if unit in ('undetermined', ''):
            unit = ''
        desc = (r.get('portion_description') or '').strip()
        mod = (r.get('modifier') or '').strip()
        if desc and desc.lower() != 'quantity not specified':
            label = desc
        else:
            label = ' '.join(x for x in [('%g' % amt), unit, mod] if x).strip()
        if not label or re.match(r'^\d+(\.\d+)?$', label):
            continue
        fd['por'].append([label[:60], r1(g)])
    for fid, fd in keep.items():
        n = fd['n']
        kcal = n.get('kcal', n.get('kcal2', n.get('kcal3')))
        if kcal is None:
            continue
        c = n.get('c', n.get('c2'))
        sug = n.get('sug', n.get('sug2'))
        seen, por = set(), []
        for l, g in fd['por']:
            if l.lower() not in seen:
                seen.add(l.lower()); por.append([l, g])
        liquid = 1 if LIQUID.search(fd['name']) and 'powder' not in fd['name'].lower() else 0
        key = fd['name'].lower()
        foods[key] = [fd['name'], r1(kcal), r1(n.get('p')), r1(n.get('f')), r1(c), r1(n.get('fib')), r1(sug),
                      r1(n.get('sat')), r1(n.get('na')), por[:8], liquid]


def build_usda(tmp):
    foods = {}
    try:
        usda_from_zip(fetch(USDA_SR, os.path.join(tmp, 'sr.zip')), foods)
    except Exception as e:
        print('SR Legacy failed:', e, file=sys.stderr)
    try:  # Foundation foods are updated twice a year; find the current CSV on the downloads page.
        html = urllib.request.urlopen(urllib.request.Request(USDA_PAGE, headers=UA), timeout=60).read().decode('utf-8', 'replace')
        m = re.findall(r'(?:https://fdc\.nal\.usda\.gov)?/fdc-datasets/FoodData_Central_foundation_food_csv_[\d-]+\.zip', html)
        if m:
            url = sorted(set(m))[-1]
            if url.startswith('/'):
                url = 'https://fdc.nal.usda.gov' + url
            usda_from_zip(fetch(url, os.path.join(tmp, 'fd.zip')), foods)
        else:
            print('No Foundation link found', file=sys.stderr)
    except Exception as e:
        print('Foundation failed:', e, file=sys.stderr)
    rows = sorted(foods.values(), key=lambda r: r[0].lower())
    print('common foods:', len(rows), flush=True)
    return rows


# ---------------------------------------------------------------- Open Food Facts (Australia)
OFF_CSV = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'


def tidy_name(s):
    s = re.sub(r'\s+', ' ', (s or '').strip())
    if len(s) > 3 and s.upper() == s:
        s = s.title()
    return s[:90]


def build_off(tmp):
    path = fetch(OFF_CSV, os.path.join(tmp, 'off.csv.gz'))
    rows, seen = [], set()
    with gzip.open(path, 'rt', encoding='utf-8', errors='replace', newline='') as f:
        rd = csv.DictReader(f, delimiter='\t', quoting=csv.QUOTE_NONE)
        for i, r in enumerate(rd):
            if i % 500000 == 0:
                print('  off rows', i, len(rows), flush=True)
            if 'en:australia' not in (r.get('countries_tags') or ''):
                continue
            code = (r.get('code') or '').strip()
            name = tidy_name(r.get('product_name'))
            if not code or not name or code in seen:
                continue
            kcal = num(r.get('energy-kcal_100g'))
            if kcal is None and num(r.get('energy_100g')) is not None:
                kcal = num(r.get('energy_100g')) / 4.184
            if kcal is None or kcal > 950:
                continue
            seen.add(code)
            brand = tidy_name((r.get('brands') or '').split(',')[0])[:40]
            na = num(r.get('sodium_100g'))
            if na is None and num(r.get('salt_100g')) is not None:
                na = num(r.get('salt_100g')) / 2.5
            sq = num(r.get('serving_quantity'))
            sl = (r.get('serving_size') or '').strip()[:30]
            qty = (r.get('quantity') or '').lower()
            liquid = 1 if re.search(r'\d\s*(ml|l|litre|liter|cl)\b', qty) or re.search(r'\bml\b', sl.lower()) else 0
            al = (r.get('allergens') or '') + ' ' + (r.get('allergens_tags') or '')
            tr = (r.get('traces_tags') or '') + ' ' + (r.get('traces') or '')
            ia = r.get('ingredients_analysis_tags') or ''
            flags = (1 if 'peanut' in al else 0) | (2 if 'peanut' in tr else 0) | \
                    (4 if 'en:non-vegan' in ia else 0) | (8 if 'en:vegan' in ia.replace('en:vegan-status', '') and 'en:non-vegan' not in ia else 0)
            scans = int(num(r.get('unique_scans_n')) or 0)
            rows.append([code, name, brand, r1(kcal), r1(num(r.get('proteins_100g'))), r1(num(r.get('fat_100g'))),
                         r1(num(r.get('carbohydrates_100g'))), r1(num(r.get('fiber_100g'))), r1(num(r.get('sugars_100g'))),
                         r1(num(r.get('saturated-fat_100g'))), r1(na * 1000) if na is not None else None,
                         r1(sq) if sq and 0 < sq < 3000 else None, sl if sq else '', liquid, flags, scans])
    rows.sort(key=lambda r: -r[15])
    print('au products:', len(rows), flush=True)
    return rows


def write(name, cols, rows, source):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump({'v': 1, 'built': time.strftime('%Y-%m-%d'), 'source': source, 'cols': cols, 'rows': rows},
                  f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', p, os.path.getsize(p) // 1024, 'KB', flush=True)


def main():
    tmp = os.environ.get('RUNNER_TEMP') or '/tmp'
    what = sys.argv[1:] or ['usda', 'off']
    if 'usda' in what:
        rows = build_usda(tmp)
        if len(rows) > 1000:
            write('common.json', ['name', 'kcal', 'p', 'f', 'c', 'fibre', 'sugar', 'satfat', 'sodium_mg', 'portions', 'liquid'],
                  rows, 'USDA FoodData Central (public domain), per 100 g')
        else:
            sys.exit('USDA build looks wrong; not writing')
    if 'off' in what:
        rows = build_off(tmp)
        if len(rows) > 5000:
            write('au.json', ['code', 'name', 'brand', 'kcal', 'p', 'f', 'c', 'fibre', 'sugar', 'satfat', 'sodium_mg',
                              'serving_g', 'serving_label', 'liquid', 'flags', 'scans'],
                  rows, 'Open Food Facts (ODbL), products sold in Australia, per 100 g. flags: 1 peanut, 2 peanut traces, 4 not vegan, 8 vegan')
        else:
            sys.exit('Open Food Facts build looks wrong; not writing')


if __name__ == '__main__':
    main()
