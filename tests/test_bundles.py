import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from ghost_replay import bundles


class EvidenceBundleTests(unittest.TestCase):
    schedule = ["noise:catalog", "A:read", "B:read", "A:commit", "B:commit"]

    @classmethod
    def setUpClass(cls):
        cls.captured = bundles.capture(1, cls.schedule)

    def changed(self, mutate):
        value = copy.deepcopy(self.captured)
        mutate(value)
        return value

    def reseal(self, value):
        value["content_sha256"] = bundles.digest({k: v for k, v in value.items() if k != "content_sha256"})
        return value

    def test_real_capture_provenance_and_replay_recipe(self):
        imported = bundles.validate_document(self.captured)
        self.assertEqual((imported.stock, imported.schedule), (1, self.schedule))
        self.assertTrue(self.captured["evidence"]["run"]["result"]["invariant_violated"])
        self.assertEqual(self.captured["fixture"]["provenance"], "fixture")
        self.assertEqual(self.captured["schedule"]["provenance"], "hypothesis")
        self.assertEqual(self.captured["evidence"]["provenance"], "observed")
        self.assertEqual(self.captured["source"]["provenance"], "derived")
        self.assertEqual(bundles.inspect(imported)["authenticity"], "not_established_by_checksums")

    def test_canonical_roundtrip_order_independence_without_execution(self):
        value = dict(reversed(list(self.captured.items())))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"evidence.json"
            path.write_text(bundles.export(value), encoding="utf-8")
            with patch("ghost_replay.bundles.reproduce", side_effect=AssertionError("unexpected execution")):
                restored = bundles.load(path)
                self.assertEqual(bundles.export(restored.document), bundles.export(self.captured))
                self.assertEqual(restored.version, 2)

    def test_missing_and_unknown_fields_fail_closed(self):
        mutations = [lambda v: v.pop("fixture"),
                     lambda v: v["fixture"].pop("stock"),
                     lambda v: v["evidence"].pop("run"),
                     lambda v: v.update(execute="arbitrary-code"),
                     lambda v: v["fixture"].update(database_url="https://example.invalid")]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(bundles.BundleError):
                bundles.validate_document(self.reseal(self.changed(mutation)))

    def test_tamper_and_configuration_hash_are_distinct_checks(self):
        value = self.changed(lambda v: v["fixture"].update(source="tampered metadata"))
        with self.assertRaisesRegex(bundles.BundleError, "content hash mismatch"):
            bundles.validate_document(value)
        value = self.changed(lambda v: v["fixture"].update(stock=2))
        with self.assertRaisesRegex(bundles.BundleError, "configuration hash mismatch"):
            bundles.validate_document(self.reseal(value))

    def test_resealed_engine_mismatch_is_rejected(self):
        value = self.changed(lambda v: v["source"]["files"].update({bundles.ENGINE_PATH: "0"*64}))
        with self.assertRaisesRegex(bundles.BundleError, "engine hash mismatch"):
            bundles.validate_document(self.reseal(value))

    def test_resealed_false_observations_and_missing_events_are_rejected(self):
        mutations = [lambda v: v["evidence"]["run"]["result"].update(invariant_violated=False),
                     lambda v: v["evidence"]["run"]["events"].pop(),
                     lambda v: v["evidence"]["run"]["events"][1].update(inventory=99),
                     lambda v: v["evidence"]["run"]["responses"]["A"].update(accepted=False),
                     lambda v: v["evidence"]["run"].update(mode="fixed"),
                     lambda v: v["evidence"].update(provenance="hypothesis")]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(bundles.BundleError):
                bundles.validate_document(self.reseal(self.changed(mutation)))

    def test_boolean_numbers_and_unsupported_versions_are_rejected(self):
        for version in [True, 0, 3, "2", None]:
            with self.subTest(version=version), self.assertRaises(bundles.BundleError):
                bundles.validate_document({"schema_version": version})
        value = self.changed(lambda v: v["evidence"]["run"].update(schema_version=True))
        with self.assertRaises(bundles.BundleError):
            bundles.validate_document(self.reseal(value))

    def test_malformed_nested_types_return_typed_bundle_error(self):
        paths = [("fixture",), ("schedule",), ("source",), ("source", "files"),
                 ("evidence",), ("evidence", "environment"), ("evidence", "run"),
                 ("evidence", "run", "mode"), ("evidence", "run", "events"),
                 ("evidence", "run", "responses"), ("evidence", "run", "result"),
                 ("fixture", "stock"), ("schedule", "steps")]
        for path in paths:
            for invalid in (None, [], {}, True, 1, "invalid"):
                value = copy.deepcopy(self.captured)
                node = value
                for key in path[:-1]:
                    node = node[key]
                if type(invalid) is type(node[path[-1]]) and invalid == node[path[-1]]:
                    continue  # The original stock=1 is valid, not a malformed mutation.
                node[path[-1]] = invalid
                self.reseal(value)
                with self.subTest(path=path, invalid=invalid), self.assertRaises(bundles.BundleError):
                    bundles.validate_document(value)

    def test_legacy_recipe_remains_supported_but_not_observed_evidence(self):
        recipe = {"schema_version": 1, "stock": 1, "schedule": self.schedule}
        imported = bundles.validate_document(recipe)
        self.assertEqual(bundles.inspect(imported)["content_integrity"], "unsealed_legacy_recipe")
        self.assertIsNone(bundles.inspect(imported)["engine_match"])
        with self.assertRaisesRegex(bundles.BundleError, "use capture"):
            bundles.export(recipe)
        with self.assertRaises(bundles.BundleError):
            bundles.validate_document({"schema_version": 1, "schedule": self.schedule})

    def test_unknown_operations_do_not_execute_imported_instructions(self):
        recipe = {"schema_version": 1, "stock": 1, "schedule": self.schedule+["shell:touch-file"]}
        with patch("ghost_replay.bundles.reproduce", side_effect=AssertionError("unexpected execution")):
            with self.assertRaises(bundles.ExperimentError):
                bundles.validate_document(recipe)

    def test_duplicate_keys_nonfinite_utf8_and_size_limits(self):
        payloads = [b'{"schema_version":1,"schema_version":2}', b'{"schema_version":NaN}',
                    b'{"schema_version":Infinity}', b'\xff', b'['*2000+b']'*2000,
                    b' '*100_001, b'{"schema_version":'+b'9'*5000+b'}']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"invalid.json"
            for payload in payloads:
                path.write_bytes(payload)
                with self.subTest(payload=payload[:60]), self.assertRaises(bundles.BundleError):
                    bundles.load(path)

    def test_export_caps_utf8_bytes_and_accepted_exports_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"capture.json"
            for noise_count in (1, 96):
                schedule = ["noise:"+"😀"*190]*noise_count + ["A:read", "B:read", "A:commit", "B:commit"]
                captured = bundles.capture(1, schedule)
                if noise_count == 96:
                    with self.assertRaisesRegex(bundles.BundleError, "exceeds 100 KB"):
                        bundles.export(captured)
                else:
                    rendered = bundles.export(captured)
                    self.assertLessEqual(len(rendered.encode("utf-8")), bundles.MAX_BUNDLE_BYTES)
                    path.write_text(rendered, encoding="utf-8")
                    self.assertEqual(bundles.load(path).document, captured)

    def test_independent_capture_ids_and_stable_configuration_identity(self):
        second = bundles.capture(1, self.schedule)
        self.assertNotEqual(self.captured["evidence"]["capture_id"], second["evidence"]["capture_id"])
        self.assertEqual(self.captured["config_sha256"], second["config_sha256"])
        self.assertNotEqual(self.captured["content_sha256"], second["content_sha256"])

    def test_negative_controls_capture_clean_runs_without_invented_failures(self):
        for stock, schedule in [(2, self.schedule), (0, self.schedule),
                                 (1, ["A:read", "A:commit", "B:read", "B:commit"])]:
            captured = bundles.capture(stock, schedule)
            self.assertFalse(captured["evidence"]["run"]["result"]["invariant_violated"])
            bundles.validate_document(captured)
        fixed = bundles.capture(1, self.schedule, mode="fixed")
        self.assertFalse(fixed["evidence"]["run"]["result"]["invariant_violated"])

    def test_cli_capture_inspect_export_and_fixed_reproduction(self):
        def cli(*args):
            return subprocess.run([sys.executable, "-m", "ghost_replay", *args], capture_output=True, text=True)
        with tempfile.TemporaryDirectory() as directory:
            evidence, exported = Path(directory)/"capture.json", Path(directory)/"export.json"
            run = cli("capture", "--bundle", "examples/checkout-race.json", "--output", str(evidence))
            self.assertEqual(run.returncode, 0, run.stderr)
            run = cli("inspect-bundle", "--bundle", str(evidence))
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout)["schema_version"], 2)
            run = cli("export-bundle", "--bundle", str(evidence), "--output", str(exported))
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(evidence.read_text()), json.loads(exported.read_text()))
            run = cli("reproduce", "--bundle", str(exported), "--mode", "fixed")
            self.assertEqual(run.returncode, 0, run.stderr)
            report = json.loads(run.stdout)
            self.assertFalse(report["result"]["invariant_violated"])
            self.assertEqual(report["input_bundle"]["content_integrity"], "checksums_and_fixture_consistency_valid")
            run = cli("export-bundle", "--bundle", "examples/checkout-race.json")
            self.assertEqual(run.returncode, 2)
            run = cli("inspect-bundle")
            self.assertEqual(run.returncode, 2)
            run = cli("export-bundle", "--bundle", str(evidence), "--mode", "fixed")
            self.assertEqual(run.returncode, 2)
            run = cli("verify", "--bundle", str(evidence))
            self.assertEqual(run.returncode, 2)

    def test_evidence_demo_measures_paired_runs_and_rejection(self):
        report = bundles.demo(1, self.schedule, repeats=3)
        self.assertEqual(report["http_experiments"], 6)
        self.assertEqual(report["captured_buggy_violations"], 3)
        self.assertEqual(report["fixed_replay_violations"], 0)
        self.assertEqual(report["unique_capture_ids"], 3)
        self.assertEqual(report["unique_configuration_ids"], 1)
        self.assertEqual(report["corrupted_bundles_rejected"], 3)
        self.assertGreater(report["elapsed_seconds"], 0)


if __name__ == "__main__":
    unittest.main()
