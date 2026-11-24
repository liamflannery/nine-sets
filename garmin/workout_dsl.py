"""Turn a short text description of a run into a Garmin Connect workout.

One step per line (or separated by ";"). Repeats use "4x( ... )".

    warmup 10min
    run 30min @7:15-7:45 hr<150
    4x(run 20s -- strides, fast but relaxed; recover 60s)
    cooldown 5min

Step kinds:   warmup/wu, run/interval/main, recover/recovery/jog/walk, rest, cooldown/cd
Durations:    30min, 90s, 1h, 1:30 (m:ss), 5km, 400m, 2mi, lap (ends on lap button)
Pace target:  @7:15-7:45 (min/km, either order) or @6:30 (+/- 5 s)
HR target:    hr<150, hr 135-150, hr z2 (your Garmin HR zone 2)
Step note:    anything after "--" shows on the watch for that step
"""

from __future__ import annotations

import re

KINDS = {
    "warmup": "warmup", "wu": "warmup", "warm-up": "warmup",
    "run": "interval", "interval": "interval", "main": "interval", "strides": "interval",
    "recover": "recovery", "recovery": "recovery", "jog": "recovery", "walk": "recovery",
    "rest": "rest",
    "cooldown": "cooldown", "cd": "cooldown", "cool-down": "cooldown",
}
STEP_TYPES = {
    "warmup": (1, 1), "cooldown": (2, 2), "interval": (3, 3),
    "recovery": (4, 4), "rest": (5, 5),
}
NO_TARGET = {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1}
DEFAULT_PACE_S = 420  # 7:00/km, only used to estimate how long distance steps take
HR_FLOOR = 80  # Garmin needs a range; "hr<150" becomes 80-150


class WorkoutError(ValueError):
    pass


def _split_top(text: str) -> list[str]:
    """Split on newlines/semicolons that are not inside parentheses."""
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                raise WorkoutError("unbalanced ')'")
        if ch in ";\n" and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if depth:
        raise WorkoutError("missing ')'")
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def _pace_seconds(s: str) -> int:
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", s)
    if not m:
        raise WorkoutError(f"pace '{s}' should look like 7:15")
    return int(m.group(1)) * 60 + int(m.group(2))


def _duration(tok: str) -> tuple[str, float]:
    """Return ("time", seconds) | ("distance", metres) | ("lap", 0)."""
    t = tok.lower()
    if t in ("lap", "open", "lapbutton"):
        return "lap", 0
    m = re.fullmatch(r"(\d{1,3}):(\d{2})", t)
    if m:
        return "time", int(m.group(1)) * 60 + int(m.group(2))
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(h|hr|min|mins|s|sec|secs|km|k|m|mi)", t)
    if not m:
        raise WorkoutError(f"don't understand duration '{tok}' (try 30min, 90s, 5km, 400m, lap)")
    n, unit = float(m.group(1)), m.group(2)
    if unit in ("h", "hr"):
        return "time", n * 3600
    if unit.startswith("min"):
        return "time", n * 60
    if unit.startswith("s"):
        return "time", n
    if unit in ("km", "k"):
        return "distance", n * 1000
    if unit == "mi":
        return "distance", n * 1609.344
    return "distance", n  # m


def parse_step(text: str) -> dict:
    note = None
    if "--" in text:
        text, note = text.split("--", 1)
        note = note.strip() or None
    toks = text.split()
    if not toks:
        raise WorkoutError("empty step")
    kind = KINDS.get(toks[0].lower())
    if not kind:
        raise WorkoutError(f"unknown step '{toks[0]}' (use warmup, run, recover, rest, cooldown)")
    if toks[0].lower() == "strides" and not note:
        note = "strides"
    step = {"kind": kind, "note": note, "pace": None, "hr": None, "end": ("lap", 0)}
    rest = toks[1:]
    # glue "hr" to the following token: "hr 135-150" -> "hr135-150"
    joined: list[str] = []
    for tok in rest:
        if joined and joined[-1].lower() == "hr":
            joined[-1] += tok
        else:
            joined.append(tok)
    for tok in joined:
        low = tok.lower()
        if low.startswith("@"):
            rng = low[1:].split("-")
            if len(rng) == 1:
                p = _pace_seconds(rng[0])
                slow, fast = p + 5, p - 5
            elif len(rng) == 2:
                a, b = _pace_seconds(rng[0]), _pace_seconds(rng[1])
                slow, fast = max(a, b), min(a, b)
            else:
                raise WorkoutError(f"pace '{tok}'")
            step["pace"] = (slow, fast)
        elif low.startswith("hr") or re.fullmatch(r"z[1-5]", low):
            spec = low[2:] if low.startswith("hr") else low
            if m := re.fullmatch(r"<=?(\d{2,3})", spec):
                step["hr"] = ("range", HR_FLOOR, int(m.group(1)))
            elif m := re.fullmatch(r"(\d{2,3})-(\d{2,3})", spec):
                lo, hi = sorted((int(m.group(1)), int(m.group(2))))
                step["hr"] = ("range", lo, hi)
            elif m := re.fullmatch(r"z([1-5])", spec):
                step["hr"] = ("zone", int(m.group(1)))
            else:
                raise WorkoutError(f"heart rate '{tok}' (try hr<150, hr 135-150, hr z2)")
        else:
            step["end"] = _duration(tok)
    return step


def parse(text: str) -> list[dict]:
    items = []
    for part in _split_top(text.replace("\r", "")):
        m = re.fullmatch(r"(\d+)\s*[x×]\s*\((.*)\)", part, re.S)
        if m:
            inner = [s for s in re.split(r"[;,\n]", m.group(2)) if s.strip()]
            # commas only split steps when the next chunk starts with a step kind
            steps, buf = [], ""
            for chunk in inner:
                first = chunk.strip().split()[0].lower() if chunk.strip() else ""
                if buf and first not in KINDS:
                    buf += "," + chunk
                else:
                    if buf:
                        steps.append(buf)
                    buf = chunk
            if buf:
                steps.append(buf)
            reps = int(m.group(1))
            if not 1 <= reps <= 99:
                raise WorkoutError("repeats must be 1-99")
            items.append({"repeat": reps, "steps": [parse_step(s) for s in steps]})
        else:
            items.append(parse_step(part))
    if not items:
        raise WorkoutError("no steps")
    return items


def _target(kind: str, spec, order: int) -> tuple[dict, dict]:
    """Return (targetType dict, value fields) for pace or hr."""
    prefix = "targetValue" if order == 1 else "secondaryTargetValue"
    zone_key = "zoneNumber" if order == 1 else "secondaryZoneNumber"
    if kind == "pace":
        slow, fast = spec
        tt = {"workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone", "displayOrder": order}
        return tt, {prefix + "One": round(1000 / slow, 6), prefix + "Two": round(1000 / fast, 6)}
    tt = {"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone", "displayOrder": order}
    if spec[0] == "zone":
        return tt, {zone_key: spec[1]}
    return tt, {prefix + "One": spec[1], prefix + "Two": spec[2]}


def _step_json(step: dict, order: int) -> tuple[dict, float]:
    sid, sorder = STEP_TYPES[step["kind"]]
    end_kind, val = step["end"]
    cond = {
        "time": {"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2, "displayable": True},
        "distance": {"conditionTypeId": 3, "conditionTypeKey": "distance", "displayOrder": 3, "displayable": True},
        "lap": {"conditionTypeId": 1, "conditionTypeKey": "lap.button", "displayOrder": 1, "displayable": True},
    }[end_kind]
    out = {
        "type": "ExecutableStepDTO",
        "stepOrder": order,
        "stepType": {"stepTypeId": sid, "stepTypeKey": step["kind"], "displayOrder": sorder},
        "endCondition": cond,
        "targetType": NO_TARGET,
    }
    if end_kind != "lap":
        out["endConditionValue"] = float(val)
    if end_kind == "distance":
        out["preferredEndConditionUnit"] = {"unitKey": "kilometer"}
    targets = [(k, step[k]) for k in ("pace", "hr") if step[k]]
    if targets:
        tt, vals = _target(*targets[0], 1)
        out["targetType"] = tt
        out.update(vals)
    if len(targets) > 1:
        tt, vals = _target(*targets[1], 2)
        out["secondaryTargetType"] = tt
        out.update(vals)
    if step["note"]:
        out["description"] = step["note"][:512]
    if end_kind == "time":
        est = val
    elif end_kind == "distance":
        pace = sum(step["pace"]) / 2 if step["pace"] else DEFAULT_PACE_S
        est = val / 1000 * pace
    else:
        est = 0
    return out, est


def build_workout(name: str, steps_text: str, description: str | None = None) -> dict:
    items = parse(steps_text)
    order = 0
    total = 0.0
    out_steps = []
    for item in items:
        if "repeat" in item:
            order += 1
            group_order = order
            children = []
            per = 0.0
            for s in item["steps"]:
                order += 1
                j, est = _step_json(s, order)
                children.append(j)
                per += est
            total += per * item["repeat"]
            out_steps.append({
                "type": "RepeatGroupDTO",
                "stepOrder": group_order,
                "stepType": {"stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6},
                "numberOfIterations": item["repeat"],
                "endCondition": {"conditionTypeId": 7, "conditionTypeKey": "iterations",
                                 "displayOrder": 7, "displayable": False},
                "endConditionValue": float(item["repeat"]),
                "smartRepeat": False,
                "workoutSteps": children,
            })
        else:
            order += 1
            j, est = _step_json(item, order)
            out_steps.append(j)
            total += est
    sport = {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}
    workout = {
        "workoutName": name[:80],
        "sportType": sport,
        "estimatedDurationInSecs": int(total),
        "workoutSegments": [{"segmentOrder": 1, "sportType": sport, "workoutSteps": out_steps}],
    }
    if description:
        workout["description"] = description[:1000]
    return workout
