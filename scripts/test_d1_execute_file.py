"""d1-execute-file.sh retries only Cloudflare's single-import lock. No network: wrangler is faked."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "d1-execute-file.sh"


def run(outputs):
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "n"
        state.write_text("0")
        fake = Path(tmp) / "wrangler"
        lines = ["#!/usr/bin/env bash", f'n=$(cat {state}); echo $((n+1)) > {state}', 'case "$n" in']
        for index, (code, text) in enumerate(outputs):
            lines.append(f'  {index}) echo "{text}"; exit {code};;')
        lines += ['  *) echo ok; exit 0;;', 'esac']
        fake.write_text("\n".join(lines) + "\n")
        fake.chmod(0o755)
        env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}", D1_IMPORT_DELAY_SECONDS="0")
        proc = subprocess.run(["bash", str(SCRIPT), "x.sql"], env=env, capture_output=True, text=True)
        return proc.returncode, int(state.read_text())


class D1ExecuteFile(unittest.TestCase):
    def test_retries_import_lock_then_succeeds(self):
        code, calls = run([(1, "Currently processing a long-running import. Cannot start another import")])
        self.assertEqual((code, calls), (0, 2))

    def test_other_errors_fail_immediately(self):
        code, calls = run([(1, "SQLITE_CONSTRAINT: UNIQUE constraint failed")])
        self.assertEqual((code, calls), (1, 1))

    def test_gives_up_after_attempts(self):
        code, calls = run([(1, "long-running import")] * 20)
        self.assertEqual((code, calls), (1, 8))


if __name__ == "__main__":
    unittest.main()
