import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from ghost_replay.core import ExperimentError, Scheduler, minimize, reproduce, schedules, validate, verify


class ReproductionTests(unittest.TestCase):
    race = ["A:read", "B:read", "A:commit", "B:commit"]

    def test_real_http_before_after_and_provenance(self):
        bad = reproduce(self.race)
        good = reproduce(self.race, mode="fixed")
        self.assertEqual(bad["result"]["accepted"], 2)
        self.assertEqual(bad["result"]["final_inventory"], -1)
        self.assertTrue(bad["result"]["invariant_violated"])
        self.assertEqual(good["result"]["accepted"], 1)
        self.assertEqual(good["result"]["final_inventory"], 0)
        self.assertFalse(good["result"]["invariant_violated"])
        self.assertEqual([e["operation"] for e in bad["events"]], self.race)
        self.assertTrue(all(e["provenance"] == "observed" for e in bad["events"]))
        self.assertEqual(bad["schedule"]["provenance"], "hypothesis")
        self.assertEqual(bad["fixture"]["provenance"], "fixture")
        self.assertEqual(bad["transport"], "real loopback HTTP")

    def test_negative_controls(self):
        sequential = ["A:read", "A:commit", "B:read", "B:commit"]
        for schedule, stock in [(sequential, 1), (self.race, 2), (self.race, 0)]:
            for mode in ("buggy", "fixed"):
                self.assertFalse(reproduce(schedule, mode=mode, stock=stock)["result"]["invariant_violated"])

    def test_all_bounded_schedules_and_repeatability(self):
        report = verify(repeats=3)
        self.assertEqual(len(schedules()), 6)
        self.assertEqual(report["total_runs"], 36)
        self.assertEqual(report["fixed_violations"], 0)
        self.assertEqual(sum(r["buggy_violations"] for r in report["rows"]), 12)

    def test_minimize_removes_only_valid_irrelevant_actions(self):
        schedule = ["noise:catalog", *self.race[:2], "noise:help", *self.race[2:]]
        result = minimize(schedule)
        self.assertEqual(result["schedule"], self.race)
        self.assertEqual((result["original_steps"], result["minimal_steps"]), (6, 4))
        with self.assertRaises(ExperimentError):
            minimize(["A:read", "A:commit", "B:read", "B:commit"])

    def test_reject_missing_duplicate_unknown_and_reversed_inputs(self):
        invalid = [self.race[:-1], self.race + ["A:read"], self.race + ["eval:evil"],
                   ["A:commit", "A:read", "B:read", "B:commit"], None, "not-a-list"]
        for schedule in invalid:
            with self.subTest(schedule=schedule), self.assertRaises(ExperimentError):
                validate(schedule, 1)
        for stock in [-1, True, "1"]:
            with self.assertRaises(ExperimentError):
                validate(self.race, stock)

    def test_timeout_aborts_explicitly(self):
        scheduler = Scheduler(self.race, 0.01)
        with self.assertRaisesRegex(ExperimentError, "timeout"):
            scheduler.step("B:read", lambda: {})
        with self.assertRaisesRegex(ExperimentError, "aborted"):
            scheduler.step("A:read", lambda: {})

    def test_cli_exports_and_rejects_incomplete_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            run = subprocess.run([sys.executable, "-m", "ghost_replay", "reproduce", "--output", str(output)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertTrue(json.loads(output.read_text())["result"]["complete"])
            bundle = Path(directory) / "incomplete.json"
            bundle.write_text('{"schema_version": 1, "schedule": []}')
            run = subprocess.run([sys.executable, "-m", "ghost_replay", "reproduce", "--bundle", str(bundle)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 2)
            self.assertIn("Experiment error", run.stderr)


if __name__ == "__main__":
    unittest.main()
