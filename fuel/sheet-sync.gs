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
