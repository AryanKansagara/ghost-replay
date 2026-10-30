import argparse
import json
import sys
from pathlib import Path
from .core import ExperimentError, minimize, reproduce, verify


def main():
    parser = argparse.ArgumentParser(description="Controlled HTTP incident reproduction")
    parser.add_argument("command", choices=["reproduce", "minimize", "verify", "demo"])
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--mode", choices=["buggy", "fixed"], default="buggy")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        schedule = ["noise:open-catalog", "A:read", "B:read", "noise:view-help", "A:commit", "B:commit"]
        stock = 1
        if args.bundle:
            if args.bundle.stat().st_size > 100_000:
                raise ExperimentError("bundle exceeds 100 KB")
            bundle = json.loads(args.bundle.read_text())
            if bundle.get("schema_version") != 1:
                raise ExperimentError("unsupported schema_version")
            schedule, stock = bundle["schedule"], bundle["stock"]
        if args.command == "verify":
            result = verify(repeats=args.repeats)
        elif args.command == "minimize":
            result = minimize(schedule, stock=stock)
        elif args.command == "reproduce":
            result = reproduce(schedule, mode=args.mode, stock=stock)
        else:
            result = {"before": reproduce(schedule, stock=stock), "minimization": minimize(schedule, stock=stock),
                      "after": reproduce(schedule, mode="fixed", stock=stock), "verification": verify(repeats=args.repeats)}
        rendered = json.dumps(result, indent=2) + "\n"
        if args.output:
            args.output.write_text(rendered)
        else:
            print(rendered, end="")
        if args.command == "verify" and result["fixed_violations"]:
            return 1
        return 0
    except (ExperimentError, OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(f"Experiment error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
