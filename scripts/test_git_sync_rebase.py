"""Pool-a push retries must rebase even when a side report is still dirty."""

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("git_sync", ROOT / "git_sync.py")
module = importlib.util.module_from_spec(spec)
sys.modules["git_sync"] = module
spec.loader.exec_module(module)


class GitSyncRebaseTests(unittest.TestCase):
    def test_rebase_autostash_and_coverage_report_are_committed(self):
        self.assertIn("--autostash", module.REBASE_COMMAND)
        self.assertIn("audit_reports/horse_profile_coverage_latest.json", module.EXTRA_COMMIT_FILES)
        paths = module.files_to_commit(["horses"])
        self.assertEqual(paths[0], "horses")
        self.assertTrue(any(path.endswith("horse_profile_coverage_latest.json") for path in paths))

    def test_actions_repository_overrides_legacy_slug(self):
        import os
        previous = os.environ.get("GITHUB_REPOSITORY")
        os.environ["GITHUB_REPOSITORY"] = "sleepingarhat/tianxi-racing"
        try:
            self.assertEqual(module.repo_path(), "sleepingarhat/tianxi-racing")
        finally:
            if previous is None:
                os.environ.pop("GITHUB_REPOSITORY", None)
            else:
                os.environ["GITHUB_REPOSITORY"] = previous


if __name__ == "__main__":
    unittest.main()
