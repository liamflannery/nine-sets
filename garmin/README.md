# Garmin sync

A GitHub Action (`.github/workflows/garmin-sync.yml`) logs in to Garmin Connect and does the two things below.
It runs only when started by hand: Claude starts it at each check-in, or use **Actions → Garmin sync → Run workflow**.

1. **Runs → Sheet.** Copies the last 14 days of runs into the "Garmin log" Google Sheet:
   the **Runs** tab (distance, time, pace, HR, minutes in each HR zone, training effect, load,
   elevation, cadence, which planned workout was on that day) and the **Splits** tab (every lap).
2. **Plan → watch.** Reads the **Plan** tab and puts each workout for the next 21 days on the
   Garmin Connect calendar, so it syncs to the watch.

It uses the unofficial [python-garminconnect](https://github.com/cyberjunky/python-garminconnect)
library. Garmin can break it at any time; when that happens the Action fails (GitHub emails you)
and the Sheet's **Status** tab shows `last_error`.

## One-time setup

1. Create a blank Google Sheet called **Garmin log** on your personal Google account.
2. In it: **Extensions → Apps Script**, replace the code with [`sheet-sync.gs`](sheet-sync.gs), save.
3. **Deploy → New deployment →** type **Web app**, Execute as **Me**, Who has access **Anyone** →
   Deploy, allow access, copy the web app URL.
4. Share the Sheet (Editor) with the account Claude's Google connector uses, so check-ins can read
   runs and write the Plan.
5. In GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `GARMIN_EMAIL`: your Garmin login email
   - `GARMIN_PASSWORD`: your Garmin password
   - `GARMIN_SHEET_URL`: the web app URL from step 3
6. **Actions → Garmin sync → Run workflow**, with `lookback_days` = 120 the first time to backfill.

If Garmin asks for a two-factor code, the run stops with a message saying so. Then run
[`make_tokens.py`](make_tokens.py) on your computer and save what it prints as a fourth secret,
`GARMIN_TOKENS`.

Nothing secret is stored in this (public) repo. The Garmin session the Action reuses between runs
is encrypted with a key made from your password before it goes in the Actions cache.

## Plan tab

| date | name | steps | notes | status | (filled in by the sync) |
|---|---|---|---|---|---|
| 2026-11-25 | 1 - Easy run | `warmup 5min; run 30min @7:15-7:45 hr<150; 4x(run 20s -- strides; recover 60s); cooldown 5min` | Conversational. | | garmin ids, pushed_spec, message |

- **date** as `YYYY-MM-DD`. **notes** become the workout description on the watch.
- **status**: leave blank to push. The sync writes `on watch`, `removed` or `error` (see **message**).
  Write `skip` to take a workout off the calendar. Delete rows only after they are removed or past.
- Edit a row's name, steps or notes and the next sync replaces the workout on Garmin.

**Steps**, one per line or separated by `;`:

| | |
|---|---|
| Kinds | `warmup`, `run`, `recover` (or `jog`, `walk`), `rest`, `cooldown` |
| Length | `30min`, `90s`, `1:30`, `1h`, `5km`, `400m`, `lap` (ends when you press lap) |
| Pace | `@7:15-7:45` per km, or `@6:30` (±5 s) |
| Heart rate | `hr<150`, `hr 135-150`, `hr z2` (your Garmin zone 2) |
| Repeats | `4x(run 20s; recover 60s)` |
| Step note | text after `--`, e.g. `run 20s -- strides, relaxed` |

With both pace and HR on a step, pace is the main target and HR the second (newer watches show both).

## Local test

```
cd garmin && python -m unittest test_workout_dsl
```
