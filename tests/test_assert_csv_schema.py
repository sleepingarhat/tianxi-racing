"""Unit tests for scripts/ci/assert_csv_schema.py (no pytest required)."""
from __future__ import annotations

import csv
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "assert_csv_schema", ROOT / "scripts" / "ci" / "assert_csv_schema.py"
)
mod = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mod)


def _write(path: Path, headers, rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow(r)


class AssertCsvSchemaTests(unittest.TestCase):
    def test_results_ok(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "r.csv"
            headers = ["date", "venue", "race_no", "horse_no", "place", "win_odds"]
            rows = [
                {
                    "date": "2026-10-19",
                    "venue": "ST",
                    "race_no": str((i % 10) + 1),
                    "horse_no": str((i % 12) + 1),
                    "place": str((i % 12) + 1),
                    "win_odds": "5.5",
                }
                for i in range(50)
            ]
            _write(p, headers, rows)
            self.assertEqual(mod.validate(p, "results"), [])

    def test_missing_column(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "r.csv"
            _write(
                p,
                ["date", "venue", "race_no", "horse_no"],
                [{"date": "2026-10-19", "venue": "ST", "race_no": "1", "horse_no": "1"}]
                * 50,
            )
            errs = mod.validate(p, "results", min_rows=40)
            self.assertTrue(any("missing required columns" in e for e in errs))

    def test_too_few_rows(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "r.csv"
            headers = ["date", "venue", "race_no", "horse_no", "place"]
            _write(
                p,
                headers,
                [
                    {
                        "date": "2026-10-19",
                        "venue": "ST",
                        "race_no": "1",
                        "horse_no": "1",
                        "place": "1",
                    }
                ],
            )
            errs = mod.validate(p, "results", min_rows=40)
            self.assertTrue(any("row count" in e for e in errs))

    def test_dividends_kind(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "d.csv"
            headers = ["date", "venue", "race_no", "pool", "combination", "dividend_hkd"]
            rows = [
                {
                    "date": "2026-10-19",
                    "venue": "HV",
                    "race_no": "1",
                    "pool": "WIN",
                    "combination": "3",
                    "dividend_hkd": "12.5",
                }
                for _ in range(25)
            ]
            _write(p, headers, rows)
            self.assertEqual(mod.validate(p, "dividends", min_rows=20), [])


if __name__ == "__main__":
    unittest.main()
