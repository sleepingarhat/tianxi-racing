"""Fail-closed freeze refusals stop TG posts without retries or a red job.
Run: python3 -m unittest discover -s tools -p test_tg_frozen_refusal.py (no network; urlopen is replaced)."""
import io
import json
import sys
import types
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
if "tx_poster" not in sys.modules:
    stub = types.ModuleType("tx_poster")
    for name in ("render_meeting", "render_post", "render_pre", "tg_send_document"):
        setattr(stub, name, lambda *a, **k: None)
    stub.tg_channels = lambda: ["@test"]
    sys.modules["tx_poster"] = stub

import tg_notify  # noqa: E402


def http_error(code, body):
    return urllib.error.HTTPError("https://x/api", code, "err", {}, io.BytesIO(json.dumps(body).encode()))


class FrozenRefusal(unittest.TestCase):
    def test_today_picks_503_freeze_error_is_refusal_without_retry(self):
        calls = []
        def boom(*a, **k):
            calls.append(1)
            raise http_error(503, {"error": "x", "freezeSource": "frozen-read-error", "frozen": False})
        with mock.patch("urllib.request.urlopen", boom), mock.patch("time.sleep"):
            with self.assertRaises(tg_notify.FrozenUnverified):
                tg_notify.api_get("/api/analyze/today-picks")
        self.assertEqual(len(calls), 1)

    def test_hit_rate_409_is_refusal(self):
        def boom(*a, **k):
            raise http_error(409, {"error": "frozen-evidence-unverified", "reason": "fixture-original-incomplete"})
        with mock.patch("urllib.request.urlopen", boom), mock.patch("time.sleep"):
            with self.assertRaises(tg_notify.FrozenUnverified) as ctx:
                tg_notify.api_get("/api/analyze/hit-rate?date=2026-11-22")
        self.assertIn("fixture-original-incomplete", str(ctx.exception))

    def test_plain_500_still_fails_after_retries(self):
        calls = []
        def boom(*a, **k):
            calls.append(1)
            raise http_error(500, {"error": "hit-rate failed"})
        with mock.patch("urllib.request.urlopen", boom), mock.patch("time.sleep"):
            with self.assertRaises(urllib.error.HTTPError):
                tg_notify.api_get("/api/analyze/hit-rate?date=2026-11-22")
        self.assertEqual(len(calls), 4)

    def test_prerace_skips_post_on_refusal(self):
        sent = []
        with mock.patch.object(tg_notify, "api_get", side_effect=tg_notify.FrozenUnverified("frozen-read-error")), \
             mock.patch.object(tg_notify, "_tg_send_one", lambda *a: sent.append(a) or (1, None), create=True):
            tg_notify.cmd_prerace(types.SimpleNamespace(force=False, date=None, dry_run=False))
        self.assertEqual(sent, [])


if __name__ == "__main__":
    unittest.main()
