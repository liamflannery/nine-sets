// Garmin sync -> Google Sheet ("Garmin log").
// Setup: in a blank Google Sheet, Extensions > Apps Script, paste this file, save,
// then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
// The tabs (Runs, Splits, Plan, Status) are created on the first call.
// The web app URL is a secret: it goes in the GitHub secret GARMIN_SHEET_URL only.

var TABS = {
  Runs: ['activity_id', 'date', 'start', 'name', 'type', 'distance_km', 'time', 'moving_time',
         'avg_pace', 'avg_hr', 'max_hr', 'elev_gain_m', 'cadence_spm', 'aerobic_te', 'anaerobic_te',
         'training_load', 'vo2max', 'calories', 'z1_min', 'z2_min', 'z3_min', 'z4_min', 'z5_min',
         'planned_workout', 'garmin_link'],
  Splits: ['activity_id', 'date', 'lap', 'distance_km', 'time', 'pace', 'avg_hr', 'max_hr',
           'elev_gain_m', 'cadence_spm'],
  Plan: ['date', 'name', 'steps', 'notes', 'status', 'garmin_workout_id', 'garmin_schedule_id',
         'pushed_spec', 'message'],
  Status: ['key', 'value']
};

function setupTabs_(ss) {
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      // Plain text, so Sheets doesn't turn "7:15" paces into times of day.
      var text = {Plan: ['A:A', 'F:H'], Runs: ['A:C', 'G:I'], Splits: ['A:B', 'E:F']}[name] || [];
      text.forEach(function (a1) { sh.getRange(a1).setNumberFormat('@'); });
    }
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
}

function cellDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  setupTabs_(ss);
  var sh = ss.getSheetByName('Plan');
  var last = sh.getLastRow();
  var plan = [];
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 9).getValues().forEach(function (r, i) {
      if (!r[0] && !r[1] && !r[2]) return;
      plan.push({row: i + 2, date: cellDate_(r[0]), name: String(r[1]), steps: String(r[2]),
                 notes: String(r[3]), status: String(r[4]), workout_id: String(r[5]),
                 schedule_id: String(r[6]), pushed_spec: String(r[7])});
    });
  }
  return json_({ok: true, plan: plan});
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    setupTabs_(ss);

    // Runs: upsert by activity id, newest first.
    var runs = ss.getSheetByName('Runs');
    if (data.runs && data.runs.length) {
      var width = TABS.Runs.length;
      var last = runs.getLastRow();
      var ids = last > 1 ? runs.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
      data.runs.forEach(function (row) {
        var at = ids.indexOf(String(row[0]));
        if (at >= 0) {
          runs.getRange(at + 2, 1, 1, width).setValues([row]);
        } else {
          runs.getRange(runs.getLastRow() + 1, 1, 1, width).setValues([row]);
          ids.push(String(row[0]));
        }
      });
      if (runs.getLastRow() > 2) {
        runs.getRange(2, 1, runs.getLastRow() - 1, width).sort([{column: 3, ascending: false}]);
      }
    }

    // Splits: replace each activity's laps.
    var splits = ss.getSheetByName('Splits');
    Object.keys(data.splits || {}).forEach(function (id) {
      var last = splits.getLastRow();
      if (last > 1) {
        var col = splits.getRange(2, 1, last - 1, 1).getValues();
        for (var i = col.length - 1; i >= 0; i--) {
          if (String(col[i][0]) === String(id)) splits.deleteRow(i + 2);
        }
      }
      var rows = data.splits[id];
      if (rows.length) splits.getRange(splits.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    });
    if (splits.getLastRow() > 2) {
      splits.getRange(2, 1, splits.getLastRow() - 1, TABS.Splits.length)
        .sort([{column: 2, ascending: false}, {column: 1, ascending: false}, {column: 3, ascending: true}]);
    }

    // Plan: write back what happened to each row (columns E:I).
    var plan = ss.getSheetByName('Plan');
    (data.plan || []).forEach(function (u) {
      var row = u.row;
      var cur = plan.getRange(row, 1, 1, 2).getValues()[0];
      if (cellDate_(cur[0]) !== u.date || String(cur[1]) !== u.name) {
        row = 0;  // rows moved since the read: find it again
        var all = plan.getRange(2, 1, Math.max(plan.getLastRow() - 1, 1), 2).getValues();
        for (var i = 0; i < all.length; i++) {
          if (cellDate_(all[i][0]) === u.date && String(all[i][1]) === u.name) { row = i + 2; break; }
        }
      }
      if (row) plan.getRange(row, 5, 1, 5).setValues([[u.status, u.workout_id, u.schedule_id, u.pushed_spec, u.message]]);
    });

    // Status: key/value pairs.
    var st = ss.getSheetByName('Status');
    Object.keys(data.status || {}).forEach(function (k) {
      var last = st.getLastRow();
      var keys = last > 1 ? st.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
      var at = keys.indexOf(k);
      var r = at >= 0 ? at + 2 : last + 1;
      st.getRange(r, 1, 1, 2).setValues([[k, data.status[k]]]);
    });

    return json_({ok: true});
  } finally {
    lock.releaseLock();
  }
}
