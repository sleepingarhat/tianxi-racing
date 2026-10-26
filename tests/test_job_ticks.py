"""Unit tests for scripts/ci/job_ticks.py."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "job_ticks", ROOT / "scripts" / "ci" / "job_ticks.py"
)
mod = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mod)


class JobTicksTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tick_dir = Path(self._td.name)
        self.patcher = mock.patch.object(mod, "TICK_DIR", self.tick_dir)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_record_and_load(self):
        path = mod.record("capy_odds", "ok", {"rows": "12"})
        self.assertTrue(path.is_file())
        tick = mod.load("capy_odds")
        self.assertEqual(tick["job"], "capy_odds")
        self.assertEqual(tick["status"], "ok")
        self.assertEqual(tick["meta"]["rows"], "12")

    def test_check_fresh_ok(self):
        mod.record("capy_race_daily", "ok")
        with mock.patch.object(mod, "is_race_day_today", return_value=True):
            self.assertEqual(mod.check("capy_race_daily", max_age_hours=24, race_day_only=True), 0)

    def test_check_stale_fails(self):
        path = mod.tick_path("capy_race_daily")
        path.parent.mkdir(parents=True, exist_ok=True)
        old = datetime.now(timezone.utc) - timedelta(hours=30)
        path.write_text(
            json.dumps({"job": "capy_race_daily", "status": "ok", "at": old.strftime("%Y-%m-%dT%H:%M:%SZ")}),
            encoding="utf-8",
        )
        with mock.patch.object(mod, "is_race_day_today", return_value=True):
            self.assertEqual(mod.check("capy_race_daily", max_age_hours=24, race_day_only=True), 1)

    def test_check_skipped_non_race_day(self):
        with mock.patch.object(mod, "is_race_day_today", return_value=False):
            self.assertEqual(mod.check("missing_job", max_age_hours=1, race_day_only=True), 0)

    def test_check_missing_fails_on_race_day(self):
        with mock.patch.object(mod, "is_race_day_today", return_value=True):
            self.assertEqual(mod.check("nope", max_age_hours=1, race_day_only=True), 1)

    def test_fail_status(self):
        mod.record("capy_odds", "fail")
        with mock.patch.object(mod, "is_race_day_today", return_value=True):
            self.assertEqual(mod.check("capy_odds", max_age_hours=24, race_day_only=False), 1)


if __name__ == "__main__":
    unittest.main()
