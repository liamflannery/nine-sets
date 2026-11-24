// Fuel -> Google Sheet sync.
// Paste this into a new project at script.google.com (or Extensions > Apps Script in the sheet),
// then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
// Open the app with  .../fuel/#sync=<the web app URL>  once to connect it.

var SHEET_ID = '1ZYCNVAW1ABN6MWTwnGWX-a_kE48JKSxtUJok_kgGaXg'; // Fuel log

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.push) { handlePush(data.push); return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON); }
    var ss = setup();

    // Entries: for each changed day, replace that day's rows.
    if (data.days && data.days.length) {
      var sh = ss.getSheetByName('Entries');
      var width = 16;
      var last = sh.getLastRow();
      var rows = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
      var changed = {};
      data.days.forEach(function (d) { changed[d.date] = true; });
      rows = rows.filter(function (r) { return !changed[normDate(r[0])]; });
      rows.forEach(function (r) { r[0] = normDate(r[0]); r[1] = normTime(r[1]); });
      data.days.forEach(function (d) { (d.rows || []).forEach(function (r) { rows.push(r); }); });
      rows.sort(function (a, b) { return (a[0] + ' ' + a[1]) < (b[0] + ' ' + b[1]) ? -1 : 1; });
      if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
      if (rows.length) {
        var rng = sh.getRange(2, 1, rows.length, width);
        sh.getRange(2, 1, rows.length, 2).setNumberFormat('@'); // keep dates and times as text
        rng.setValues(rows);
      }
    }

    // Full lists: the app sends the whole table each time.
    replaceTab(ss.getSheetByName('Daily'), data.daily);
    replaceTab(ss.getSheetByName('Weight'), data.weight);
    replaceTab(ss.getSheetByName('Targets'), data.targets);
    replaceTab(ss.getSheetByName('Foods'), data.foods);
    replaceTab(ss.getSheetByName('Settings'), data.settings);

    return ContentService.createTextOutput(JSON.stringify({ok: true}));
  } finally {
    lock.releaseLock();
  }
}

function replaceTab(sheet, rows) {
  if (!rows || !sheet) return;
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, Math.max(1, sheet.getLastColumn())).clearContent();
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

// GET ?coach=1 returns the newest row of the Coach tab, which the app applies as targets.
function doGet(e) {
  if (e && e.parameter && e.parameter.vapid) {
    var st = remindState();
    return ContentService.createTextOutput(JSON.stringify({key: vapidKeys().pub, on: st.on, time: st.time, subs: st.subs.length})).setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.coach) {
    var sh = setup().getSheetByName('Coach');
    var last = sh.getLastRow(), coach = null;
    if (last > 1) {
      var rows = sh.getRange(2, 1, last - 1, 6).getValues().filter(function (r) { return r[0] && r[1]; });
      rows.sort(function (a, b) { return normDate(a[0]) < normDate(b[0]) ? -1 : 1; });
      var r = rows[rows.length - 1];
      if (r) coach = {start: normDate(r[0]), kcal: +r[1], p: +r[2], f: +r[3], c: +r[4], note: String(r[5] || '')};
    }
    // Inbox: foods Claude logs for Liam. The app imports each row once (by id) when it opens.
    var ib = setup().getSheetByName('Inbox'), inbox = [], il = ib.getLastRow();
    if (il > 1) ib.getRange(2, 1, il - 1, 11).getValues().forEach(function (r) {
      if (!r[0] || !r[1]) return;
      inbox.push({id: String(r[0]), date: normDate(r[1]), time: normTime(r[2]), name: String(r[3]), kcal: r[4], p: r[5], f: r[6], c: r[7], fibre: r[8], sodium: r[9], label: String(r[10] || '')});
    });
    return ContentService.createTextOutput(JSON.stringify({coach: coach, inbox: inbox.slice(-200)})).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput('Fuel sync is running.');
}

// Creates any missing tabs with their header rows. Safe to run any time.
var TABS = {
  Entries: ['date', 'time', 'food', 'brand', 'amount', 'grams', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'fibre_g', 'sugar_g', 'satfat_g', 'sodium_mg', 'food_id', 'entry_id'],
  Daily: ['date', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'fibre_g', 'sodium_mg', 'target_kcal', 'target_p', 'target_f', 'target_c', 'scale_kg', 'trend_kg'],
  Weight: ['date', 'scale_kg', 'trend_kg'],
  Targets: ['start', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'source', 'note'],
  Inbox: ['id (any unique text)', 'date (YYYY-MM-DD)', 'time (HH:MM)', 'food', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'fibre_g', 'sodium_mg', 'amount label'],
  Coach: ['start (YYYY-MM-DD)', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'note (add a row here to override targets; the newest row wins)'],
  Foods: ['food_id', 'name', 'brand', 'barcode', 'serving', 'serving_g', 'kcal_100g', 'protein_100g', 'fat_100g', 'carbs_100g'],
  Settings: ['setting', 'value']
};
function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(TABS).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var first = ss.getSheets()[0];
    var sh = (ss.getSheets().length === 1 && first.getLastRow() === 0 && !TABS[first.getName()]) ? first.setName(name) : ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  return ss;
}

function normDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}
function normTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  return String(v);
}

// ================= Weigh-in reminder (Web Push) =================
// The app subscribes to push and posts {push: {...}} here. remindTick runs every 5 minutes
// (created by setupReminders) and sends a payload-free push at the chosen time. The service
// worker shows "Time to weigh in". VAPID keys are made here and the private key never leaves
// this script's properties.
var PUSH_SUBJECT = 'https://liamflannery.github.io/nine-sets/fuel/';

// ---- Minimal P-256 ECDSA for VAPID (pure JS, BigInt) ----
// Apps Script cannot parse BigInt literals (3n), so the small constants are made once here.
var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B3 = BigInt(3), B4 = BigInt(4), B8 = BigInt(8);
var EC_P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
var EC_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
var EC_A = EC_P - B3;
var EC_G = [BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'), BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')];
function ecMod(a, m) { var r = a % m; return r < B0 ? r + m : r; }
function ecInv(a, m) { var lm = B1, hm = B0, low = ecMod(a, m), high = m; while (low > B1) { var q = high / low; var nm = hm - lm * q, nw = high - low * q; hm = lm; high = low; lm = nm; low = nw; } return ecMod(lm, m); }
// Jacobian coordinates
function ecDbl(P) { if (!P || P[1] === B0) return null; var X = P[0], Y = P[1], Z = P[2], p = EC_P;
  var YY = Y * Y % p, S = B4 * X % p * YY % p, ZZ = Z * Z % p, M = (B3 * X % p * X % p + EC_A * ZZ % p * ZZ) % p;
  var X3 = ecMod(M * M - B2 * S, p), Y3 = ecMod(M * (S - X3) - B8 * YY % p * YY, p), Z3 = B2 * Y % p * Z % p; return [X3, Y3, Z3]; }
function ecAdd(P, Q) { if (!P) return Q; if (!Q) return P; var p = EC_P;
  var Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p, U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p, S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
  if (U1 === U2) return S1 === S2 ? ecDbl(P) : null;
  var H = ecMod(U2 - U1, p), R = ecMod(S2 - S1, p), HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
  var X3 = ecMod(R * R - HHH - B2 * V, p), Y3 = ecMod(R * (V - X3) - S1 * HHH, p), Z3 = P[2] * Q[2] % p * H % p; return [X3, Y3, Z3]; }
function ecMul(k, G) { var R = null, A = [G[0], G[1], B1]; while (k > B0) { if (k & B1) R = ecAdd(R, A); A = ecDbl(A); k >>= B1; } if (!R) return null; var zi = ecInv(R[2], EC_P), zi2 = zi * zi % EC_P; return [R[0] * zi2 % EC_P, R[1] * zi2 % EC_P * zi % EC_P]; }
function bytesToBig(b) { var h = '0x'; for (var i = 0; i < b.length; i++) h += ((b[i] + 256) % 256).toString(16).padStart(2, '0'); return BigInt(h); }
function bigToBytes(x, len) { var h = x.toString(16).padStart(len * 2, '0'), out = []; for (var i = 0; i < len; i++) { var v = parseInt(h.substr(i * 2, 2), 16); out.push(v > 127 ? v - 256 : v); } return out; }
function b64url(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function sha256(bytes) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes); }
function vapidKeys() {
  var props = PropertiesService.getScriptProperties();
  var d = props.getProperty('VAPID_D');
  if (!d) {
    var seed = Utilities.newBlob(Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random()).getBytes();
    var dn = ecMod(bytesToBig(sha256(seed)), EC_N - B1) + B1;
    var Q = ecMul(dn, EC_G);
    props.setProperties({VAPID_D: dn.toString(16), VAPID_PUB: b64url([4].concat(bigToBytes(Q[0], 32), bigToBytes(Q[1], 32)))});
    d = props.getProperty('VAPID_D');
  }
  return {d: BigInt('0x' + d), pub: props.getProperty('VAPID_PUB')};
}
function es256(input, d) {
  var msg = Utilities.newBlob(input).getBytes();
  var hb = sha256(msg), e = bytesToBig(hb);
  for (var i = 0; i < 64; i++) {
    var k = ecMod(bytesToBig(sha256(bigToBytes(d, 32).concat(hb, [i]))), EC_N);
    if (k === B0) continue;
    var R = ecMul(k, EC_G), r = ecMod(R[0], EC_N); if (r === B0) continue;
    var s = ecMod(ecInv(k, EC_N) * ecMod(e + r * d, EC_N), EC_N); if (s === B0) continue;
    return bigToBytes(r, 32).concat(bigToBytes(s, 32));
  }
  throw new Error('could not sign');
}
function vapidHeader(endpoint) {
  var keys = vapidKeys(), m = endpoint.match(/^https:\/\/[^\/]+/);
  var enc = function (o) { return b64url(Utilities.newBlob(JSON.stringify(o)).getBytes()); };
  var input = enc({typ: 'JWT', alg: 'ES256'}) + '.' + enc({aud: m[0], exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT});
  return 'vapid t=' + input + '.' + b64url(es256(input, keys.d)) + ', k=' + keys.pub;
}
function sendPush(sub) {
  var res = UrlFetchApp.fetch(sub.endpoint, {method: 'post', headers: {Authorization: vapidHeader(sub.endpoint), TTL: '14400', Urgency: 'high'}, payload: '', muteHttpExceptions: true});
  return res.getResponseCode();
}
function remindState() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('REMIND') || '{"on":false,"time":"07:00","tz":"Australia/Sydney","subs":[],"last":""}'); }
function saveRemind(st) { PropertiesService.getScriptProperties().setProperty('REMIND', JSON.stringify(st)); }
function handlePush(p) {
  var st = remindState();
  if (p.time && /^\d\d:\d\d$/.test(p.time)) st.time = p.time;
  if (p.tz) st.tz = String(p.tz);
  if (p.on != null) st.on = !!p.on;
  if (p.sub && p.sub.endpoint && /^https:\/\//.test(p.sub.endpoint)) {
    st.subs = st.subs.filter(function (s) { return s.endpoint !== p.sub.endpoint; });
    st.subs.push({endpoint: p.sub.endpoint});
    st.subs = st.subs.slice(-5);
  }
  if (p.sub && p.time && st.time !== st.lastTime) { st.last = ''; st.lastTime = st.time; }
  saveRemind(st);
  if (p.test) st.subs.forEach(function (s) { try { sendPush(s); } catch (e) {} });
  try { ensureTrigger(); } catch (e) {}
}
function ensureTrigger() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'remindTick'; });
  if (!has) ScriptApp.newTrigger('remindTick').timeBased().everyMinutes(5).create();
}
function remindTick() {
  var st = remindState(); if (!st.on || !st.subs.length) return;
  var now = new Date(), day = Utilities.formatDate(now, st.tz, 'yyyy-MM-dd'), hm = Utilities.formatDate(now, st.tz, 'HH:mm');
  if (st.last === day) return;
  var toM = function (t) { return +t.slice(0, 2) * 60 + +t.slice(3, 5); };
  var late = toM(hm) - toM(st.time);
  if (late < 0 || late > 180) return;
  var keep = [];
  st.subs.forEach(function (s) { var code = 0; try { code = sendPush(s); } catch (e) {} if (code !== 404 && code !== 410) keep.push(s); });
  st.subs = keep; st.last = day; saveRemind(st);
}
// Run this once from the editor to approve the permissions and start the 5-minute check.
function setupReminders() { vapidKeys(); ensureTrigger(); Logger.log('Public key: ' + vapidKeys().pub); }
