"""Fixed, disposable worker for the web service. Never executes submitted code."""
import json
import re
import sys

from .core import ExperimentError, minimize, reproduce, validate

MAX_BODY = 16_384
RACE = ["A:read", "B:read", "A:commit", "B:commit"]
OPERATIONS = frozenset(RACE)
NOISE = re.compile(r"noise:[A-Za-z0-9_-]{1,48}\Z")


def validate_request(data):
    if type(data) is not dict or set(data) != {"schedule", "stock"}:
        raise ExperimentError("unsupported request fields")
    schedule, stock = data["schedule"], data["stock"]
    if type(schedule) is not list or not 4 <= len(schedule) <= 12:
        raise ExperimentError("schedule needs 4..12 operations")
    if any(type(step) is not str or (step not in OPERATIONS and not NOISE.fullmatch(step))
           for step in schedule):
        raise ExperimentError("unsupported operation")
    validate(schedule, stock)
    return schedule, stock


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ExperimentError("duplicate request field")
        result[key] = value
    return result


def run(data):
    schedule, stock = validate_request(data)
    buggy = reproduce(schedule, stock=stock, timeout=0.8)
    fixed = reproduce(schedule, stock=stock, mode="fixed", timeout=0.8)
    reduction = minimize(schedule, stock=stock) if buggy["result"]["invariant_violated"] else None
    return {"buggy": buggy, "fixed": fixed, "minimization": reduction}


def main():
    try:
        if sys.argv[1:] == ["--check"]:
            result = run({"schedule": RACE, "stock": 1})
            if not result["buggy"]["result"]["invariant_violated"] or result["fixed"]["result"]["invariant_violated"]:
                raise ExperimentError("fixture self-check failed")
            print('{"ready":true}')
            return 0
        if sys.argv[1:]:
            raise ExperimentError("unsupported worker arguments")
        raw = sys.stdin.buffer.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise ExperimentError("request too large")
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ExperimentError("nonfinite JSON")))
        print(json.dumps(run(data), allow_nan=False, separators=(",", ":")))
        return 0
    except Exception:
        # Do not emit submitted data, paths, stack traces, or upstream exception strings.
        print('{"error":"worker_failed"}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
