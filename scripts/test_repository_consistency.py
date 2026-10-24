import copy
import json
from pathlib import Path
import unittest
from audit_repository_consistency import active_text, selected, text_issues, validate_policy, inspect_repo
from unittest.mock import patch


class PolicyAuditTests(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads((Path(__file__).resolve().parents[1] / "docs/repository-policy.json").read_text())

    def assert_drift(self, section, key, expected, wrong):
        self.assertEqual(self.policy[section][key], expected)
        changed = copy.deepcopy(self.policy)
        changed[section][key] = wrong
        self.assertEqual(validate_policy(changed, self.policy), ["policy_manifest_drift"])

    def test_founding_200(self):
        self.assert_drift("membership", "founding_members", 200, 500)

    def test_founding_52_weeks(self):
        self.assert_drift("membership", "founding_pro_weeks", 52, 12)

    def test_gate_not_automatic(self):
        self.assert_drift("membership", "automatic_gate", False, True)

    def test_payment_acceptance_required(self):
        self.assert_drift("membership", "payment_acceptance_required", True, False)

    def test_owner_approval_required(self):
        self.assert_drift("membership", "owner_approval_required", True, False)

    def test_stripe_78_weekly(self):
        self.assert_drift("payments", "stripe_weekly_hkd", 78, 88)

    def test_stripe_renewal(self):
        self.assert_drift("payments", "stripe_auto_renew", True, False)

    def test_crypto_416(self):
        self.assert_drift("payments", "crypto_usd", 416, 520)

    def test_crypto_52_weeks(self):
        self.assert_drift("payments", "crypto_weeks", 52, 1)

    def test_crypto_no_renewal(self):
        self.assert_drift("payments", "crypto_auto_renew", False, True)

    def test_crypto_display(self):
        self.assert_drift("payments", "crypto_display_hkd", 3244.8, 3245)

    def test_weather_archive(self):
        self.assert_drift("schedules", "weather-archive-managed", "*/5 * * * *", "*/10 * * * *")

    def test_weather_sync(self):
        self.assert_drift("schedules", "weather-sync-github-managed", "50 15 * * *", "50 23 * * *")

    def test_dispatch(self):
        self.assert_drift("schedules", "race-results-dispatch-managed", "31 15,17 * * *", "30 15 * * *")

    def test_horse_watch(self):
        self.assert_drift("schedules", "horse-watch", "30 1 * * *", "30 9 * * *")

    def test_raceday(self):
        self.assert_drift("schedules", "raceday-alerts", "*/5 2-15 * * *", "*/5 * * * *")

    def test_sweep(self):
        self.assert_drift("schedules", "telegram-pro-sweep", "7 * * * *", "0 * * * *")

    def test_primary_results(self):
        self.assert_drift("primary_results", "after_verified_final_race_minutes", 30, 60)

    def test_backup_is_not_primary(self):
        self.assert_drift("primary_results", "fixed_dispatch_is_backup_only", True, False)

    def test_original_evidence_excluded(self):
        for path in ["supabase/migrations/0001.sql", "data/2026/results.csv", "legacy-site/index.html", "research/raw.json"]:
            self.assertFalse(selected(path))

    def test_history_scope_ends(self):
        value = active_text("README.md", "## 歷史\nold\n## 現況\nnew")
        self.assertNotIn("old", value)
        self.assertIn("new", value)

    def test_read_failure_never_passes(self):
        with patch("audit_repository_consistency.api", side_effect=RuntimeError("HTTP 403")):
            row = inspect_repo("tianxi-research", self.policy, "")
        self.assertEqual(row["issues"][0]["rule"], "read_failed")


if __name__ == "__main__":
    unittest.main()