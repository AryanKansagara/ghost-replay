"""Strict, checksummed evidence for the included checkout fixture only.

Checksums establish internal consistency, not authenticity or a trusted capture.
No imported code, URLs, or selectors are executed.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import platform
import re
import time
import uuid

from .core import ExperimentError, reproduce, validate

MAX_BUNDLE_BYTES = 100_000
ENGINE_PATH = "ghost_replay/core.py"
HEX = re.compile(r"^[0-9a-f]{64}$")


class BundleError(ExperimentError):
    """Missing, unsupported, inconsistent, or integrity-mismatched evidence."""


@dataclass(frozen=True)
class ImportedBundle:
    version: int
    stock: int
    schedule: list[str]
    document: dict


def canonical_bytes(value):
    """Canonicalization contract: sorted keys, compact UTF-8, no NaN/Infinity."""
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise BundleError("bundle is not canonical JSON data") from exc


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def engine_digest():
    return hashlib.sha256(Path(__file__).with_name("core.py").read_bytes()).hexdigest()


def configuration(stock, schedule):
    # Handler mode is intentionally not part of the recipe: replay can compare
    # buggy/fixed handlers against the identical input and scheduling contract.
    return {"fixture": {"kind": "checkout-v1", "stock": stock}, "schedule": schedule}


def _object(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise BundleError(f"{label}: missing or unsupported fields; expected {sorted(keys)}")


def _text(value, label, maximum=200):
    if type(value) is not str or not value.strip() or len(value) > maximum:
        raise BundleError(f"{label}: nonempty string of at most {maximum} characters required")


def _recipe(stock, schedule):
    validate(schedule, stock)
    if any(len(step) > 200 for step in schedule):
        raise BundleError("schedule operation exceeds 200 characters")


def _same(actual, expected, label):
    # bool == int in Python; canonical JSON equality preserves that distinction.
    if canonical_bytes(actual) != canonical_bytes(expected):
        raise BundleError(f"{label}: evidence contradicts the fixture contract")


def _check_run(run, stock, schedule):
    """Check finite-fixture observations without contacting a destination."""
    keys = {"schema_version", "experiment_id", "fixture", "mode", "schedule",
            "transport", "events", "responses", "result"}
    _object(run, keys, "evidence.run")
    if type(run["mode"]) is not str or run["mode"] not in {"buggy", "fixed"}:
        raise BundleError("evidence.run.mode is unsupported")
    _same(run["schema_version"], 1, "evidence.run.schema_version")
    identity = json.dumps({"schema_version": 1, "schedule": schedule,
                           "stock": stock, "mode": run["mode"]}, sort_keys=True)
    _same(run["experiment_id"], hashlib.sha256(identity.encode()).hexdigest()[:16],
          "evidence.run.experiment_id")
    _same(run["fixture"], {"stock": stock, "provenance": "fixture"}, "evidence.run.fixture")
    _same(run["schedule"], {"steps": schedule, "provenance": "hypothesis",
                           "source": "operator-controlled schedule"}, "evidence.run.schedule")
    _same(run["transport"], "real loopback HTTP", "evidence.run.transport")
    if type(run["events"]) is not list or len(run["events"]) != len(schedule):
        raise BundleError("evidence.run.events: complete event sequence required")
    inventory, reads, responses = stock, {}, {}
    for index, operation in enumerate(schedule):
        expected = {"sequence": index, "operation": operation,
                    "provenance": "observed", "source": "local-http-checkout"}
        if operation.startswith("noise:"):
            expected["effect"] = "none"
        else:
            request, phase = operation.split(":")
            if phase == "read":
                reads[request] = inventory
                expected["inventory"] = inventory
            else:
                accepted = (reads[request] if run["mode"] == "buggy" else inventory) >= 1
                result = {"accepted": accepted, "inventory_before": inventory,
                          "inventory_after": inventory - int(accepted)}
                expected.update(result)
                inventory = result["inventory_after"]
                responses[request] = result
        _same(run["events"][index], expected, f"evidence.run.events[{index}]")
    _same(run["responses"], responses, "evidence.run.responses")
    accepted_count = sum(item["accepted"] for item in responses.values())
    _same(run["result"], {"provenance": "derived", "accepted": accepted_count,
                         "final_inventory": inventory,
                         "invariant_violated": inventory < 0 or accepted_count > stock,
                         "complete": True}, "evidence.run.result")


def _validate_document(document):
    if type(document) is not dict or type(document.get("schema_version")) is not int:
        raise BundleError("integer schema_version required")
    version = document["schema_version"]
    if version == 1:
        _object(document, {"schema_version", "stock", "schedule"}, "legacy recipe")
        _recipe(document["stock"], document["schedule"])
        return ImportedBundle(1, document["stock"], list(document["schedule"]), document)
    if version != 2:
        raise BundleError("unsupported schema_version")
    _object(document, {"schema_version", "fixture", "schedule", "source", "evidence",
                       "config_sha256", "content_sha256"}, "v2 bundle")
    fixture, schedule = document["fixture"], document["schedule"]
    _object(fixture, {"kind", "stock", "provenance", "source"}, "fixture")
    _object(schedule, {"steps", "provenance", "source"}, "schedule")
    _same(fixture["kind"], "checkout-v1", "fixture.kind")
    _same(fixture["provenance"], "fixture", "fixture.provenance")
    _same(schedule["provenance"], "hypothesis", "schedule.provenance")
    _text(fixture["source"], "fixture.source")
    _text(schedule["source"], "schedule.source")
    _recipe(fixture["stock"], schedule["steps"])
    for key in ("config_sha256", "content_sha256"):
        if type(document[key]) is not str or not HEX.fullmatch(document[key]):
            raise BundleError(f"{key}: lowercase SHA-256 digest required")
    if document["config_sha256"] != digest(configuration(fixture["stock"], schedule["steps"])):
        raise BundleError("configuration hash mismatch")
    if document["content_sha256"] != digest({k: v for k, v in document.items() if k != "content_sha256"}):
        raise BundleError("content hash mismatch")
    source = document["source"]
    _object(source, {"algorithm", "files", "provenance"}, "source")
    _same(source["algorithm"], "sha256", "source.algorithm")
    _same(source["provenance"], "derived", "source.provenance")
    _object(source["files"], {ENGINE_PATH}, "source.files")
    if source["files"][ENGINE_PATH] != engine_digest():
        raise BundleError("fixture engine hash mismatch; current source cannot verify this bundle")
    evidence = document["evidence"]
    _object(evidence, {"capture_id", "provenance", "source", "environment", "run"}, "evidence")
    if type(evidence["capture_id"]) is not str or not re.fullmatch(r"[0-9a-f]{32}", evidence["capture_id"]):
        raise BundleError("evidence.capture_id: UUID hex required")
    _same(evidence["provenance"], "observed", "evidence.provenance")
    _same(evidence["source"], "controlled-loopback-http", "evidence.source")
    _object(evidence["environment"], {"python", "implementation", "system"}, "evidence.environment")
    for key, value in evidence["environment"].items():
        _text(value, "evidence.environment." + key, 100)
    _check_run(evidence["run"], fixture["stock"], schedule["steps"])
    return ImportedBundle(2, fixture["stock"], list(schedule["steps"]), document)


def validate_document(document):
    """Public boundary: all malformed input is reported as a typed BundleError."""
    try:
        return _validate_document(document)
    except BundleError:
        raise
    except (ExperimentError, TypeError, ValueError, KeyError, AttributeError, RecursionError) as exc:
        raise BundleError(f"malformed or unsupported fixture evidence: {exc}") from exc


def capture(stock, schedule, *, mode="buggy"):
    """Execute the trusted fixture, then seal observations. No imported code."""
    _recipe(stock, schedule)
    run = reproduce(schedule, stock=stock, mode=mode)
    document = {
        "schema_version": 2,
        "fixture": {"kind": "checkout-v1", "stock": stock, "provenance": "fixture",
                    "source": "operator-supplied initial inventory"},
        "schedule": {"steps": list(schedule), "provenance": "hypothesis",
                     "source": "operator-controlled interleaving"},
        "source": {"algorithm": "sha256", "files": {ENGINE_PATH: engine_digest()},
                   "provenance": "derived"},
        "evidence": {"capture_id": uuid.uuid4().hex, "provenance": "observed",
                     "source": "controlled-loopback-http",
                     "environment": {"python": platform.python_version(),
                                     "implementation": platform.python_implementation(),
                                     "system": platform.system()}, "run": run},
        "config_sha256": digest(configuration(stock, schedule)),
    }
    document["content_sha256"] = digest(document)
    validate_document(document)
    return document


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BundleError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _invalid_constant(value):
    raise BundleError(f"non-finite JSON number is unsupported: {value}")


def load(path):
    # Bound the read itself rather than relying on an earlier stat check.
    with Path(path).open("rb") as file:
        raw = file.read(MAX_BUNDLE_BYTES + 1)
    if len(raw) > MAX_BUNDLE_BYTES:
        raise BundleError("bundle exceeds 100 KB")
    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                              parse_constant=_invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise BundleError("invalid UTF-8 JSON bundle") from exc
    return validate_document(document)


def export(document):
    imported = validate_document(document)
    if imported.version != 2:
        raise BundleError("export-bundle requires v2 evidence; use capture for a legacy recipe")
    rendered = canonical_bytes(document) + b"\n"
    if len(rendered) > MAX_BUNDLE_BYTES:
        raise BundleError("export exceeds 100 KB; reduce the capture schedule")
    return rendered.decode("utf-8")


def inspect(imported):
    return {"schema_version": imported.version, "supported_fixture": "checkout-v1",
            "stock": imported.stock, "schedule_steps": len(imported.schedule),
            "configuration_sha256": digest(configuration(imported.stock, imported.schedule)),
            "content_integrity": "checksums_and_fixture_consistency_valid" if imported.version == 2 else "unsealed_legacy_recipe",
            "authenticity": "not_established_by_checksums",
            "engine_match": True if imported.version == 2 else None}


def demo(stock, schedule, *, repeats=5):
    """Actual paired local HTTP runs; timings are fixture evidence, not a benchmark."""
    if type(repeats) is not int or not 1 <= repeats <= 100:
        raise BundleError("repeats must be an integer between 1 and 100")
    start = time.perf_counter()
    captures, violations, fixed_violations, corrupt_rejections = set(), 0, 0, 0
    configuration_ids = set()
    for _ in range(repeats):
        document = capture(stock, schedule)
        imported = validate_document(json.loads(export(document)))
        captures.add(document["evidence"]["capture_id"])
        configuration_ids.add(document["config_sha256"])
        violations += document["evidence"]["run"]["result"]["invariant_violated"]
        fixed_violations += reproduce(imported.schedule, stock=imported.stock,
                                      mode="fixed")["result"]["invariant_violated"]
        document["content_sha256"] = "0" * 64
        try:
            validate_document(document)
        except BundleError:
            corrupt_rejections += 1
    return {"schema_version": 1, "validation": "controlled_local_HTTP_and_bundle_roundtrip",
            "repeats": repeats, "http_experiments": repeats * 2,
            "captured_buggy_violations": violations, "fixed_replay_violations": fixed_violations,
            "unique_capture_ids": len(captures), "unique_configuration_ids": len(configuration_ids),
            "corrupted_bundles_rejected": corrupt_rejections,
            "elapsed_seconds": round(time.perf_counter() - start, 6),
            "engine_sha256": engine_digest(),
            "environment": {"python": platform.python_version(), "system": platform.system()},
            "authenticity": "not_established_by_checksums",
            "claim": "Checksums and consistency checks for an authored fixture; no production reconstruction or performance claim"}
