"""Garmin Connect <-> "Garmin log" Google Sheet.

1. Pulls recent runs (summary, HR zones, per-lap splits) into the Runs and Splits tabs.
2. Reads the Plan tab and puts each upcoming workout on the Garmin Connect calendar,
   so it syncs to the watch. Edited rows are replaced; status "skip" removes them.

Runs in GitHub Actions (.github/workflows/garmin-sync.yml). Environment:
  GARMIN_EMAIL, GARMIN_PASSWORD   Garmin login (GitHub secrets)
  GARMIN_TOKENS                   optional: token JSON from a local login, used if no saved session
  GARMIN_SHEET_URL                the Apps Script web app URL (GitHub secret)
  TOKEN_FILE                      where the encrypted session is kept between runs
  LOOKBACK_DAYS                   how many days of runs to (re)sync, default 14
  DRY_RUN=1                       print what would happen, change nothing
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from workout_dsl import WorkoutError, build_workout

TZ = ZoneInfo("Australia/Sydney")
RUN_TYPES = {"running", "trail_running", "treadmill_running", "track_running",
             "indoor_running", "street_running", "virtual_run", "obstacle_run", "ultra_run"}
REMOVE_WORDS = {"skip", "skipped", "cancel", "cancelled", "remove", "delete"}
PLAN_DAYS_AHEAD = 21
DRY = os.getenv("DRY_RUN") == "1"


def log(*a):
    print(*a, flush=True)


# ---------- session storage (encrypted, because Actions caches are not secret) ----------

def _fernet():
    from cryptography.fernet import Fernet
    material = os.getenv("GARMIN_PASSWORD") or os.getenv("GARMIN_TOKENS") or ""
    if not material:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(b"nine-sets-garmin:" + material.encode()).digest())
    return Fernet(key)


def load_saved_tokens(path: Path) -> str | None:
    f = _fernet()
    if not f or not path.exists():
        return None
    try:
        return f.decrypt(path.read_bytes()).decode()
    except Exception:
        log("Saved Garmin session could not be read (password changed?); logging in again.")
        return None


def save_tokens(path: Path, token_json: str) -> None:
    f = _fernet()
    if not f or DRY:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(f.encrypt(token_json.encode()))


def garmin_login():
    from garminconnect import Garmin
    token_file = Path(os.getenv("TOKEN_FILE", ".garmin/tokens.enc"))
    email, password = os.getenv("GARMIN_EMAIL"), os.getenv("GARMIN_PASSWORD")
    for source, tokens in (("saved session", load_saved_tokens(token_file)),
                           ("GARMIN_TOKENS secret", os.getenv("GARMIN_TOKENS"))):
        if not tokens:
            continue
        try:
            g = Garmin(email, password)
            g.login(tokenstore=tokens)
            log(f"Logged in to Garmin with the {source}.")
            save_tokens(token_file, g.client.dumps())
            return g
        except Exception as e:
            log(f"The {source} didn't work ({type(e).__name__}); trying the next option.")
    if not (email and password):
        raise SystemExit("No working Garmin session and GARMIN_EMAIL / GARMIN_PASSWORD are not set.")
    g = Garmin(email, password, return_on_mfa=True)
    status, _ = g.login()
    if status == "needs_mfa":
        raise SystemExit("Garmin asked for a two-factor code. Turn MFA off for this account, or create "
                         "GARMIN_TOKENS from a local login (see garmin/README.md).")
    log("Logged in to Garmin with email and password.")
    save_tokens(token_file, g.client.dumps())
    return g


# ---------- formatting helpers ----------

def hms(sec) -> str:
    if sec in (None, ""):
        return ""
    sec = int(round(float(sec)))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def pace(mps) -> str:
    if not mps:
        return ""
    return hms(1000 / float(mps))


def num(v, nd=1):
    return "" if v in (None, "") else round(float(v), nd)


# ---------- runs ----------

def zone_minutes(g, act) -> list:
    secs = [act.get(f"hrTimeInZone_{z}") for z in range(1, 6)]
    if all(s is None for s in secs):
        try:
            zones = g.get_activity_hr_in_timezones(str(act["activityId"])) or []
            by = {z.get("zoneNumber"): z.get("secsInZone") for z in zones}
            secs = [by.get(z) for z in range(1, 6)]
        except Exception as e:
            log(f"  no HR zones for {act['activityId']}: {e}")
    return [num((s or 0) / 60) if s is not None else "" for s in secs]


def collect_runs(g, start: date, end: date, plan_names: dict) -> tuple[list, dict]:
    acts = g.get_activities_by_date(start.isoformat(), end.isoformat()) or []
    runs, splits = [], {}
    for a in acts:
        typ = (a.get("activityType") or {}).get("typeKey", "")
        if typ not in RUN_TYPES and "run" not in typ:
            continue
        aid = str(a["activityId"])
        started = a.get("startTimeLocal") or ""
        day = started[:10]
        dist = a.get("distance") or 0
        runs.append([
            aid, day, started[:16], a.get("activityName") or "", typ,
            num(dist / 1000, 2), hms(a.get("duration")), hms(a.get("movingDuration")),
            pace(a.get("averageSpeed")), num(a.get("averageHR"), 0), num(a.get("maxHR"), 0),
            num(a.get("elevationGain"), 0), num(a.get("averageRunningCadenceInStepsPerMinute"), 0),
            num(a.get("aerobicTrainingEffect")), num(a.get("anaerobicTrainingEffect")),
            num(a.get("activityTrainingLoad"), 0), num(a.get("vO2MaxValue"), 0), num(a.get("calories"), 0),
            *zone_minutes(g, a),
            plan_names.get(day, ""), f"https://connect.garmin.com/modern/activity/{aid}",
        ])
        try:
            laps = (g.get_activity_splits(aid) or {}).get("lapDTOs") or []
        except Exception as e:
            log(f"  no splits for {aid}: {e}")
            laps = []
        splits[aid] = [[
            aid, day, i + 1, num((l.get("distance") or 0) / 1000, 2), hms(l.get("duration")),
            pace(l.get("averageSpeed")), num(l.get("averageHR"), 0), num(l.get("maxHR"), 0),
            num(l.get("elevationGain"), 0), num(l.get("averageRunCadence"), 0),
        ] for i, l in enumerate(laps)]
        log(f"Run {day} {a.get('activityName')}: {num(dist / 1000, 2)} km, {len(laps)} laps")
    return runs, splits


# ---------- plan -> Garmin calendar ----------

def spec_of(row) -> str:
    raw = "|".join([row["date"], row["name"], row["steps"], row["notes"]])
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def remove_from_garmin(g, row):
    if row.get("schedule_id"):
        try:
            g.unschedule_workout(row["schedule_id"])
        except Exception as e:
            log(f"  unschedule {row['schedule_id']}: {e}")
    if row.get("workout_id"):
        try:
            g.delete_workout(row["workout_id"])
        except Exception as e:
            log(f"  delete workout {row['workout_id']}: {e}")


def push_plan(g, plan: list, today: date) -> list:
    updates = []
    horizon = today + timedelta(days=PLAN_DAYS_AHEAD)
    for row in plan:
        try:
            d = date.fromisoformat(row["date"])
        except ValueError:
            updates.append({**row, "status": "error", "message": "date should be YYYY-MM-DD"})
            continue
        if d < today or d > horizon:
            continue
        status = row["status"].strip().lower()
        base = {"row": row["row"], "date": row["date"], "name": row["name"]}
        if status in REMOVE_WORDS:
            if row["workout_id"]:
                log(f"Removing {row['date']} {row['name']} from Garmin")
                if not DRY:
                    remove_from_garmin(g, row)
                updates.append({**base, "status": "removed", "workout_id": "", "schedule_id": "",
                                "pushed_spec": "", "message": f"removed {now_str()}"})
            continue
        spec = spec_of(row)
        if row["workout_id"] and row["pushed_spec"] == spec:
            continue  # already on the calendar and unchanged
        try:
            workout = build_workout(row["name"], row["steps"], row["notes"] or None)
        except WorkoutError as e:
            updates.append({**base, "status": "error", "workout_id": row["workout_id"],
                            "schedule_id": row["schedule_id"], "pushed_spec": row["pushed_spec"],
                            "message": f"steps: {e}"})
            continue
        log(f"Pushing {row['date']} {row['name']} ({workout['estimatedDurationInSecs'] // 60} min)")
        if DRY:
            log(json.dumps(workout, indent=1))
            continue
        if row["workout_id"]:
            remove_from_garmin(g, row)  # it changed: replace it
        try:
            created = g.upload_workout(workout)
            wid = created.get("workoutId")
            sched = g.schedule_workout(wid, row["date"]) or {}
            sid = sched.get("workoutScheduleId") or sched.get("scheduledWorkoutId") or sched.get("id") or ""
            updates.append({**base, "status": "on watch", "workout_id": str(wid), "schedule_id": str(sid),
                            "pushed_spec": spec, "message": f"pushed {now_str()}"})
        except Exception as e:
            updates.append({**base, "status": "error", "workout_id": "", "schedule_id": "",
                            "pushed_spec": "", "message": f"Garmin: {str(e)[:200]}"})
    return updates


# ---------- sheet ----------

def now_str() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M")


def sheet_get(url: str) -> list:
    r = requests.get(url, params={"plan": "1"}, timeout=60)
    r.raise_for_status()
    return r.json().get("plan", [])


def sheet_post(url: str, payload: dict) -> None:
    if DRY:
        log("DRY_RUN: would post", {k: (len(v) if hasattr(v, "__len__") else v) for k, v in payload.items()})
        return
    r = requests.post(url, data=json.dumps(payload), headers={"Content-Type": "application/json"}, timeout=120)
    r.raise_for_status()
    if not r.json().get("ok"):
        raise RuntimeError(f"Sheet said: {r.text[:200]}")


def main() -> int:
    url = (os.getenv("GARMIN_SHEET_URL") or "").strip()
    if not url:
        raise SystemExit("GARMIN_SHEET_URL is not set.")
    if "/exec" in url:
        url = url.split("/exec")[0] + "/exec"  # drop anything pasted after /exec
    if not url.startswith("https://script.google.com/macros/"):
        log("GARMIN_SHEET_URL doesn't look like an Apps Script web app link (https://script.google.com/macros/s/.../exec).")
    today = datetime.now(TZ).date()
    lookback = int(os.getenv("LOOKBACK_DAYS") or 14)
    plan = sheet_get(url)
    log(f"Plan tab has {len(plan)} rows.")
    try:
        g = garmin_login()
        plan_updates = push_plan(g, plan, today)
        names = {}
        for row in plan:
            if row["status"].strip().lower() not in REMOVE_WORDS:
                names[row["date"]] = (names.get(row["date"], "") + " / " + row["name"]).strip(" /")
        runs, splits = collect_runs(g, today - timedelta(days=lookback), today, names)
        sheet_post(url, {"runs": runs, "splits": splits, "plan": plan_updates,
                         "status": {"last_sync": now_str(), "last_error": "",
                                    "runs_in_window": f"{len(runs)} runs in the last {lookback} days"}})
        log(f"Done: {len(runs)} runs, {len(plan_updates)} plan updates.")
        return 0
    except BaseException as e:
        msg = str(e) if isinstance(e, SystemExit) else f"{type(e).__name__}: {e}"
        traceback.print_exc()
        try:
            sheet_post(url, {"status": {"last_error": f"{now_str()} {msg[:300]}"}})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
