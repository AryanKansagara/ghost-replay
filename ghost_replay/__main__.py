import argparse
import json
import sys
from pathlib import Path
from .core import ExperimentError, minimize, reproduce, verify
from . import bundles


def main():
    parser = argparse.ArgumentParser(description="Controlled HTTP incident reproduction")
    parser.add_argument("command", choices=["reproduce", "minimize", "verify", "demo", "capture", "inspect-bundle", "export-bundle", "evidence-demo"])
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--mode", choices=["buggy", "fixed"])
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        if args.mode and args.command not in {"capture", "reproduce"}:
            raise ExperimentError("--mode is only supported by capture and reproduce")
        if args.bundle and args.command == "verify":
            raise ExperimentError("verify enumerates its built-in schedules; --bundle is unsupported")
        schedule = ["noise:open-catalog", "A:read", "B:read", "noise:view-help", "A:commit", "B:commit"]
        stock = 1
        imported = bundles.load(args.bundle) if args.bundle else None
        if imported:
            schedule, stock = imported.schedule, imported.stock
        if args.command in {"inspect-bundle", "export-bundle"} and imported is None:
            raise ExperimentError(f"{args.command} requires --bundle")
        if args.command == "export-bundle":
            rendered = bundles.export(imported.document)
            if args.output:
                args.output.write_text(rendered, encoding="utf-8")
            else:
                print(rendered, end="")
            return 0
        if args.command == "inspect-bundle":
            result = bundles.inspect(imported)
        elif args.command == "evidence-demo":
            result = bundles.demo(stock, schedule, repeats=args.repeats)
        elif args.command == "capture":
            result = bundles.capture(stock, schedule, mode=args.mode or "buggy")
        elif args.command == "verify":
            result = verify(repeats=args.repeats)
        elif args.command == "minimize":
            result = minimize(schedule, stock=stock)
        elif args.command == "reproduce":
            result = reproduce(schedule, mode=args.mode or "buggy", stock=stock)
            if imported:
                result["input_bundle"] = bundles.inspect(imported)
        else:
            result = {"before": reproduce(schedule, stock=stock), "minimization": minimize(schedule, stock=stock),
                      "after": reproduce(schedule, mode="fixed", stock=stock), "verification": verify(repeats=args.repeats)}
        rendered = bundles.export(result) if args.command == "capture" else json.dumps(result, indent=2) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            print(rendered, end="")
        if args.command == "verify" and result["fixed_violations"]:
            return 1
        if args.command == "evidence-demo" and (result["fixed_replay_violations"] or
                                                result["corrupted_bundles_rejected"] != args.repeats):
            return 1
        return 0
    except (ExperimentError, OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(f"Experiment error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
