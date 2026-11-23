// Fuel -> Google Sheet sync.
// Paste this into a new project at script.google.com (or Extensions > Apps Script in the sheet),
// then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
// Open the app with  .../fuel/#sync=<the web app URL>  once to connect it.

var SHEET_ID = '1EXggFFu-K0uL8xKfqaYBLNlOfWV6bKCRWDQOUcD_IZg'; // Fuel log

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.openById(SHEET_ID);

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
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Coach');
    var last = sh.getLastRow(), coach = null;
    if (last > 1) {
      var rows = sh.getRange(2, 1, last - 1, 6).getValues().filter(function (r) { return r[0] && r[1]; });
      rows.sort(function (a, b) { return normDate(a[0]) < normDate(b[0]) ? -1 : 1; });
      var r = rows[rows.length - 1];
      if (r) coach = {start: normDate(r[0]), kcal: +r[1], p: +r[2], f: +r[3], c: +r[4], note: String(r[5] || '')};
    }
    return ContentService.createTextOutput(JSON.stringify({coach: coach})).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput('Fuel sync is running.');
}

function normDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}
function normTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  return String(v);
}
