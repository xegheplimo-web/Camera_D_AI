#!/usr/bin/env python3
"""Tests for loop.py v2 — the deterministic gate that prevents self-approval.

Run: python test_loop.py -v   (stdlib unittest, no deps)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOOP = HERE / "loop.py"

# A fake gate suite the tests control. Modes are driven by FAKE_GATE_MODE env.
FAKE_GATES = '''import os, sys
mid = sys.argv[1]
mode = os.environ.get("FAKE_GATE_MODE", "pass")
if mode == "fail":
    print("gate failed for " + mid); sys.exit(1)
if mode == "unverifiable":
    print("cannot verify " + mid); sys.exit(3)
print("gate ok " + mid); sys.exit(0)
'''


def milestone(mid, priority, prereq=(), watch=(), status="todo"):
    return {
        "id": mid, "title": f"title {mid}", "priority": priority,
        "prereq": list(prereq), "gate": f"gate text {mid}",
        "gate_script": f"gates.py {mid}", "watch_files": list(watch),
        "status": status, "attempts": 0, "evidence": "", "evidence_sha": None,
    }


class LoopTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "gates.py").write_text(FAKE_GATES, encoding="utf-8")
        self.watched = self.root / "watched.conf"
        self.watched.write_text("v1\n", encoding="utf-8")
        self.state = {
            "version": 2,
            "cycle": 0,
            "steps_today": 0,
            "steps_today_date": time.strftime("%Y-%m-%d"),
            "max_steps_per_day": 3,
            "max_attempts": 3,
            "stale_after_min": 20,
            "current": None,
            "run": {"id": None, "started_at": None, "status": None},
            "milestones": [
                milestone("A", 1, watch=["watched.conf"]),
                milestone("B", 2, prereq=["A"]),
                milestone("C", 3),
            ],
        }
        self.save()

    def tearDown(self):
        self.tmp.cleanup()

    def save(self):
        (self.root / "state.json").write_text(
            json.dumps(self.state, indent=2, ensure_ascii=False), encoding="utf-8")

    def load(self):
        return json.loads((self.root / "state.json").read_text(encoding="utf-8"))

    def run_loop(self, *args, mode="pass"):
        env = dict(os.environ, LOOP_ROOT=str(self.root), FAKE_GATE_MODE=mode)
        return subprocess.run([sys.executable, str(LOOP), *args], cwd=str(self.root),
                              capture_output=True, text=True, env=env)

    # ---- gate enforcement: the whole point of v2 -------------------------

    def test_done_refused_when_gate_fails(self):
        r = self.run_loop("done", "A", "--note", "trust me bro", mode="fail")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        s = self.load()
        self.assertEqual(s["milestones"][0]["status"], "todo")
        self.assertIsNone(s["milestones"][0].get("verified_at"))

    def test_done_refused_when_gate_unverifiable(self):
        r = self.run_loop("done", "A", "--note", "no token", mode="unverifiable")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.load()["milestones"][0]["status"], "todo")

    def test_done_accepted_when_gate_passes_and_records_evidence_hash(self):
        r = self.run_loop("done", "A", "--note", "anonymous read denied")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        m = self.load()["milestones"][0]
        self.assertEqual(m["status"], "done")
        self.assertTrue(m["evidence_sha"], "evidence hash must be recorded")
        self.assertTrue(m["verified_at"])

    # ---- invalidation: done is not forever ------------------------------

    def test_watched_file_change_marks_done_milestone_stale(self):
        self.run_loop("done", "A", "--note", "ok")
        self.watched.write_text("v2-changed\n", encoding="utf-8")
        r = self.run_loop("next")
        s = self.load()
        m = s["milestones"][0]
        # requirement: the old verification must no longer count as done, and the
        # reason must be recorded. (next may immediately re-open it as `doing`,
        # which is why we assert "not done" + reason rather than the transient label)
        self.assertNotEqual(m["status"], "done",
                            "changed config must invalidate the verification")
        self.assertTrue(m.get("stale_reason"), "stale reason must be recorded")
        self.assertIn("stale", r.stdout.lower())

    def test_stale_prereq_blocks_dependent(self):
        self.run_loop("done", "A", "--note", "ok")
        self.watched.write_text("v2\n", encoding="utf-8")
        r = self.run_loop("next")
        self.assertNotIn("NEXT MILESTONE: B", r.stdout)
        self.assertNotIn("NEXT MILESTONE: C", r.stdout)

    # ---- attempts + budget ----------------------------------------------

    def test_attempts_increment_and_cap_to_blocked(self):
        for _ in range(3):
            r = self.run_loop("next")
            self.assertEqual(r.returncode, 0, r.stdout)
            self.run_loop("block", "A", "failed attempt")  # release the run
        # A is now blocked after max_attempts; next should move on, not re-pick A
        r = self.run_loop("next")
        self.assertNotIn("NEXT MILESTONE: A", r.stdout)
        m = [x for x in self.load()["milestones"] if x["id"] == "A"][0]
        self.assertEqual(m["status"], "blocked")

    def test_block_hard_parks_immediately(self):
        """A credential/permission blocker is a dead end: burning retry
        attempts on it only wastes cycles, so --hard parks it at once."""
        self.run_loop("next")
        self.run_loop("block", "A", "needs SONAR_TOKEN", "--hard")
        m = [x for x in self.load()["milestones"] if x["id"] == "A"][0]
        self.assertEqual(m["status"], "blocked")
        self.assertIn("SONAR_TOKEN", m["blocked_reason"])

    def test_unblock_returns_milestone_to_todo_and_resets_attempts(self):
        """When the credential finally arrives the milestone must become
        workable again; a blocked milestone is never re-picked otherwise."""
        self.run_loop("next")
        self.run_loop("block", "A", "needs SONAR_TOKEN", "--hard")
        r = self.run_loop("unblock", "A")
        self.assertEqual(r.returncode, 0, r.stdout)
        m = [x for x in self.load()["milestones"] if x["id"] == "A"][0]
        self.assertEqual(m["status"], "todo")
        self.assertEqual(m["attempts"], 0)
        r = self.run_loop("next")
        self.assertIn("A", r.stdout)

    def test_budget_reached_stops_loop(self):
        for _ in range(3):
            self.run_loop("next")
            self.run_loop("block", "A", "x")
        r = self.run_loop("next")
        self.assertEqual(r.returncode, 2)
        self.assertIn("BUDGET", r.stdout.upper())

    def test_stop_flag_halts(self):
        (self.root / "STOP").write_text("stop\n", encoding="utf-8")
        r = self.run_loop("next")
        self.assertEqual(r.returncode, 2)
        self.assertIn("STOP", r.stdout.upper())

    # ---- fencing: dead run detection ------------------------------------

    def test_fresh_open_run_refuses_second_runner(self):
        self.run_loop("next")
        r = self.run_loop("next")  # immediate second call = concurrent run
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertIn("RUN IN PROGRESS", r.stdout.upper())

    def test_stale_open_run_marked_interrupted_and_needs_reconcile(self):
        self.run_loop("next")
        s = self.load()
        s["run"]["started_at"] = "2000-01-01T00:00:00"
        self.state = s
        self.save()
        r = self.run_loop("next")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("RECONCILE", r.stdout.upper())
        s = self.load()
        self.assertTrue(s["run"].get("needs_reconcile"), "must require reconcile")

    # ---- watchdog --------------------------------------------------------

    def test_watchdog_alerts_when_run_is_stale(self):
        self.run_loop("next")
        s = self.load()
        s["run"]["started_at"] = "2000-01-01T00:00:00"
        self.state = s
        self.save()
        r = self.run_loop("watchdog")
        self.assertNotEqual(r.returncode, 0, "stale run must raise an alert")
        self.assertIn("ALERT", r.stdout.upper())

    def test_watchdog_clean_when_nothing_wrong(self):
        r = self.run_loop("watchdog")
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
