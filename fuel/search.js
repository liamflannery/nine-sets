// Fuel food search worker.
// Loads the offline food database (data/common.json + data/au.json), keeps it in the Cache API,
// and answers fuzzy searches in a few milliseconds so typing feels instant.
'use strict';

const DATA_CACHE = 'fueldata-v1';
const FILES = {common: 'data/common.json', au: 'data/au.json'};
const MAX_AGE = 7 * 864e5;

// Australian and US names for the same thing, plus common spellings. Each group is treated as one word.
const SYN = [
  ['chickpea', 'garbanzo', 'chana'], ['capsicum', 'bell pepper', 'sweet pepper', 'peppers sweet', 'pepper sweet'], ['zucchini', 'courgette'], ['eggplant', 'aubergine'],
  ['coriander', 'cilantro'], ['rockmelon', 'cantaloupe'], ['prawn', 'shrimp'], ['biscuit', 'cookie'], ['lolly', 'lollies', 'candy'],
  ['mince', 'ground'], ['spring onion', 'scallion', 'green onion'], ['silverbeet', 'chard'], ['soy', 'soya', 'soybean'],
  ['yoghurt', 'yogurt'], ['flavour', 'flavor'], ['fibre', 'fiber'], ['chip', 'fries', 'crisp'], ['tomato sauce', 'ketchup'],
  ['icing sugar', 'powdered sugar'], ['cornflour', 'cornstarch'], ['wholemeal', 'whole wheat', 'wholewheat'], ['sultana', 'raisin'],
  ['snow pea', 'mangetout'], ['beetroot', 'beet'], ['rocket', 'arugula'], ['cos', 'romaine'], ['porridge', 'oatmeal'], ['oat', 'oats', 'rolled oat'],
  ['muesli', 'granola'], ['soymilk', 'soy milk'], ['oatmilk', 'oat milk'], ['almondmilk', 'almond milk'], ['bun', 'roll'],
  ['pb', 'peanut butter'], ['tofu', 'beancurd', 'bean curd'], ['edamame', 'soybean green'], ['spud', 'potato'], ['kumara', 'sweet potato'],
  ['bicarb', 'baking soda'], ['eggplant', 'brinjal'], ['passionfruit', 'passion fruit'], ['wrap', 'tortilla'],
  ['vego', 'vegetarian'], ['veg', 'vegetable'], ['choc', 'chocolate'], ['bbq', 'barbecue'], ['protien', 'protein']
];

let common = null, au = null, docs = [], vocab = new Map(), vocabByLen = [], ready = false, loading = null;

// ---------------- text helpers ----------------
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9%.]+/g, ' ').replace(/\s\.|\.\s|^\.|\.$/g, ' ').trim();
function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('oes')) return w.slice(0, -2);
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}
const STOP = new Set(['and', 'with', 'the', 'of', 'in', 'a', 'by', 'for', 'or', 'raw', 'nfs', 'ns', 'as', 'to']);
const SYNMAP = new Map(); // phrase -> canonical token
SYN.forEach(g => { const canon = '§' + stem(norm(g[0]).replace(/ /g, '')); g.forEach(x => SYNMAP.set(norm(x), canon)); });
function tokens(text) {
  let t = ' ' + norm(text) + ' ';
  // multi-word synonyms first (longest first)
  for (const [ph, canon] of [...SYNMAP].filter(([p]) => p.includes(' ')).sort((a, b) => b[0].length - a[0].length)) {
    if (t.includes(' ' + ph + ' ')) t = t.split(' ' + ph + ' ').join(' ' + canon + ' ');
  }
  return t.trim().split(/\s+/).filter(Boolean).map(w => w[0] === '§' ? w : (SYNMAP.get(w) || SYNMAP.get(stem(w)) || stem(w)));
}

// Damerau-Levenshtein with an early exit once the distance passes max.
function dist(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i; let best = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev2 || new Array(lb + 1); prev2 = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

// ---------------- loading ----------------
async function getJson(name, url) {
  let cache = null;
  try { cache = await caches.open(DATA_CACHE); } catch (e) {}
  let res = cache && await cache.match(url);
  const stale = res && (Date.now() - (+res.headers.get('x-fuel-saved') || 0) > MAX_AGE);
  if (!res) {
    post({type: 'progress', name, state: 'downloading'});
    res = await fetchAndStore(cache, url);
  } else if (stale) {
    fetchAndStore(cache, url).catch(() => {}); // refresh in the background for next time
  }
  return res.json();
}
async function fetchAndStore(cache, url) {
  const r = await fetch(url, {cache: 'no-cache'});
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const body = await r.blob();
  if (cache) {
    const h = new Headers({'content-type': 'application/json', 'x-fuel-saved': String(Date.now())});
    try { await cache.put(url, new Response(body, {headers: h})); } catch (e) {}
  }
  return new Response(body);
}

function addDoc(d, text, brandText) {
  const id = docs.length; docs.push(d);
  const seen = new Set();
  const add = (w, field) => {
    if (STOP.has(w) && field === 1) return;
    const key = w + (field === 2 ? '' : '');
    if (seen.has(w)) return; seen.add(w);
    let p = vocab.get(w); if (!p) { p = []; vocab.set(w, p); }
    p.push(field === 2 ? -(id + 1) : id + 1); // negative = matched in brand only
  };
  tokens(text).forEach(w => add(w, 1));
  const joined = String(text).match(/[A-Za-z]+(?:[-'’][A-Za-z]+)+/g); // Weet-Bix -> weetbix, Uncle Toby's -> tobys
  if (joined) joined.forEach(j => tokens(j.replace(/[-'’]/g, '')).forEach(w => add(w, 1)));
  if (brandText) tokens(brandText).forEach(w => { if (!seen.has(w)) add(w, 2); });
}

async function load() {
  if (loading) return loading;
  loading = (async () => {
    const [c, a] = await Promise.allSettled([getJson('common', FILES.common), getJson('au', FILES.au)]);
    if (c.status === 'fulfilled') common = c.value;
    if (a.status === 'fulfilled') au = a.value;
    docs = []; vocab = new Map();
    if (common) common.rows.forEach((r, i) => addDoc({t: 'c', i, pop: 0}, r[0]));
    if (au) au.rows.forEach((r, i) => addDoc({t: 'a', i, pop: r[15] || 0}, r[1], r[2]));
    vocabByLen = [];
    for (const w of vocab.keys()) { const plain = w[0] === '§' ? w.slice(1) : w; const l = Math.min(plain.length, 40); (vocabByLen[l] || (vocabByLen[l] = [])).push([plain, w]); }
    ready = true;
    post({type: 'ready', common: common ? common.rows.length : 0, au: au ? au.rows.length : 0, built: (au || common || {}).built || null,
      failed: [c.status === 'rejected' ? 'common' : null, a.status === 'rejected' ? 'au' : null].filter(Boolean)});
  })().catch(e => { loading = null; post({type: 'error', message: String(e && e.message || e)}); });
  return loading;
}

// ---------------- search ----------------
function matchWords(tok, isLast) {
  // returns Map word -> weight
  const out = new Map();
  if (vocab.has(tok)) out.set(tok, 1);
  if (tok[0] === '§') { if (out.size) return out; tok = tok.slice(1); }
  const L = tok.length;
  const put = (w, v) => { if (v > (out.get(w) || 0)) out.set(w, v); };
  if (L >= 2 && (isLast || L >= 3)) { // prefix matches ("tof" -> tofu)
    for (let l = L + 1; l < vocabByLen.length; l++) { const ws = vocabByLen[l]; if (ws) for (const [p, w] of ws) if (p.startsWith(tok)) put(w, L >= 4 ? 0.85 : 0.7); }
  }
  const max = L >= 8 ? 2 : L >= 4 ? 1 : 0;
  if (max) for (let l = L - max; l <= L + max; l++) { const ws = vocabByLen[l]; if (!ws) continue; for (const [p, w] of ws) { if (out.has(w)) continue; const d = dist(tok, p, max); if (d <= max) put(w, d === 0 ? 1 : d === 1 ? 0.62 : 0.45); } }
  // a typo inside a word that is still being typed ("chikp" -> chickpea)
  if (isLast && L >= 4 && out.size < 3) for (let l = L + 1; l < vocabByLen.length && l <= L + 8; l++) { const ws = vocabByLen[l]; if (ws) for (const [p, w] of ws) if (!out.has(w) && (dist(tok, p.slice(0, L), 1) <= 1 || dist(tok, p.slice(0, L + 1), 1) <= 1)) put(w, 0.5); }
  return out;
}

function search(q, limit) {
  const qt = tokens(q).filter(w => !STOP.has(w));
  if (!qt.length) return {q, common: [], au: [], total: 0};
  const scores = new Map(), hits = new Map(), mask = new Map();
  const N = docs.length || 1; let idfSum = 0, rareIdf = -1, rareBit = 0;
  qt.forEach((tok, ti) => {
    const words = matchWords(tok, ti === qt.length - 1);
    const best = new Map();
    for (const [w, wt] of words) for (const p of vocab.get(w)) {
      const id = Math.abs(p) - 1; const v = p < 0 ? wt * 0.8 : wt;
      if (v > (best.get(id) || 0)) best.set(id, v);
    }
    const idf = Math.log(1 + N / (1 + best.size)); idfSum += idf; // rare words (brands) count for more
    if (idf > rareIdf) { rareIdf = idf; rareBit = 1 << ti; }
    for (const [id, v] of best) { scores.set(id, (scores.get(id) || 0) + v * idf); hits.set(id, (hits.get(id) || 0) + 1); mask.set(id, (mask.get(id) || 0) | (1 << ti)); }
  });
  const need = qt.length;
  let ids = [...hits].filter(([, n]) => n === need).map(([id]) => id);
  let partial = false;
  if (ids.length < 12 && need > 1) { partial = true; ids = [...hits].filter(([id, n]) => n === need || (n >= need - 1 && (mask.get(id) & rareBit))).map(([id]) => id); } // a near miss must still contain the rarest word
  const qn = norm(q);
  const ranked = ids.map(id => {
    const d = docs[id]; const name = d.t === 'c' ? common.rows[d.i][0] : au.rows[d.i][1];
    const nn = norm(name);
    let s = scores.get(id) / idfSum;
    if (hits.get(id) === need) s += 0.6;                     // every word matched
    if (nn.startsWith(qn)) s += 0.35; else if (nn.includes(qn)) s += 0.2;
    s -= Math.min(0.25, nn.length / 400);                 // shorter, simpler names first
    if (d.t === 'a') s += Math.min(0.3, Math.log10(1 + d.pop) / 10); // popular products first
    if (d.t === 'c' && nn.split(' ').length <= 4) s += 0.05;
    return [id, s];
  }).sort((a, b) => b[1] - a[1]);
  const c = [], a = []; let topC = null, topA = null;
  const fullCount = partial ? ids.filter(id => hits.get(id) === need).length : ids.length;
  for (const [id, sc] of ranked) {
    const d = docs[id];
    if (d.t === 'c') { if (fullCount && hits.get(id) < need) continue; if (topC == null) topC = sc; if (c.length < limit) c.push(food(d)); }
    else { if (topA == null) topA = sc; if (a.length < limit) a.push(food(d)); }
    if (c.length >= limit && a.length >= limit) break;
  }
  return {q, common: c, au: a, total: ranked.length, partial, terms: qt, brandedFirst: false};
}

function food(d) {
  if (d.t === 'c') {
    const r = common.rows[d.i];
    return {id: 'u-' + slug(r[0]), name: r[0], brand: '', source: 'usda', liquid: !!r[10],
      per100: {kcal: r[1], p: r[2] || 0, f: r[3] || 0, c: r[4] || 0, fibre: r[5], sugar: r[6], satfat: r[7], sodium: r[8]},
      servings: (r[9] || []).map(([label, g]) => ({label, g}))};
  }
  const r = au.rows[d.i];
  const warn = [];
  if (r[14] & 1) warn.push('Contains peanut'); else if (r[14] & 2) warn.push('May contain traces of peanut');
  if (r[14] & 4) warn.push('Flagged as not vegan');
  return {id: 'off-' + r[0], barcode: r[0], name: r[1], brand: r[2], source: 'off', liquid: !!r[13] || (LIQ.test(r[1]) && !SOLID.test(r[1])), warn, vegan: !!(r[14] & 8), scans: r[15],
    per100: {kcal: r[3], p: r[4] || 0, f: r[5] || 0, c: r[6] || 0, fibre: r[7], sugar: r[8], satfat: r[9], sodium: r[10]},
    servings: r[11] ? [{label: r[12] || (r[11] + (r[13] ? ' ml' : ' g')), g: r[11]}] : []};
}
const LIQ = /\b(milk|milky|drink|juice|water|beverage|smoothie|kombucha|soda|cola|lemonade|cordial|coffee|latte|tea|nectar|shake|broth|stock|oil|vinegar|syrup|sauce|beer|wine|cider|up ?& ?go|up and go)\b/i;
const SOLID = /\b(chocolate|choc bar|powder|biscuit|cookie|cereal|bar|block|cheese|chips?)\b/i;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);

function byBarcode(code) {
  if (!au) return null;
  const i = au.rows.findIndex(r => r[0] === code || r[0] === code.replace(/^0+/, '') || ('0' + r[0]) === code);
  return i < 0 ? null : food({t: 'a', i});
}

const post = m => self.postMessage(m);
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'load') return load();
  if (m.type === 'search') {
    if (!ready) await load();
    const t0 = performance.now();
    const r = ready ? search(m.q, m.limit || 25) : {q: m.q, common: [], au: [], total: 0};
    r.ms = Math.round(performance.now() - t0);
    post(Object.assign({type: 'results', seq: m.seq}, r));
  }
  if (m.type === 'barcode') { if (!ready) await load(); post({type: 'barcode', seq: m.seq, food: byBarcode(m.code)}); }
};
