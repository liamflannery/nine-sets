// Nine Sets -> Google Sheet sync.
// Paste this into a new project at script.google.com (or Extensions > Apps Script in the sheet),
// then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).

var SHEET_ID = '1kXnHY0hhDxa8HMmf52zunQyWdrQoBP-kJHxJ1QyUc4c'; // Nine Sets log

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.openById(SHEET_ID);

    // Sessions: replace all rows for each session id, then append the new rows.
    var sets = ss.getSheetByName('Sets');
    (data.sessions || []).forEach(function (s) {
      var last = sets.getLastRow();
      if (last > 1) {
        var ids = sets.getRange(2, 1, last - 1, 1).getValues();
        for (var i = ids.length - 1; i >= 0; i--) {
          if (String(ids[i][0]) === String(s.id)) sets.deleteRow(i + 2);
        }
      }
      if (s.rows && s.rows.length) {
        sets.getRange(sets.getLastRow() + 1, 1, s.rows.length, s.rows[0].length).setValues(s.rows);
      }
    });

    // Training maxes and bodyweight: the app sends the full list each time.
    replaceTab(ss.getSheetByName('Training Maxes'), data.tms);
    replaceTab(ss.getSheetByName('Bodyweight'), data.bw);

    return ContentService.createTextOutput(JSON.stringify({ok: true}));
  } finally {
    lock.releaseLock();
  }
}

function replaceTab(sheet, rows) {
  if (!rows) return;
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function doGet() {
  return ContentService.createTextOutput('Nine Sets sync is running.');
}
