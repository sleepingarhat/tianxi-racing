"""TG 腳本 TG_READER_TOKEN header 測試。執行：python3 -m unittest discover -s tools -p test_tg_reader_auth.py
測試值即場隨機產生，唔會寫入檔案；唔會發出任何網絡請求（urlopen 已替換）。"""
import io
import importlib
import json
import os
import sys
import types
import unittest
import uuid
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# tg_race_cards 會 import tx_poster（要 Pillow）；測試只需要 api_get，所以放一個空殼。
if "tx_poster" not in sys.modules:
    stub = types.ModuleType("tx_poster")
    for name in ("render_meeting", "render_post", "render_pre", "tg_send_document"):
        setattr(stub, name, lambda *a, **k: None)
    stub.tg_channels = lambda: ["@test"]
    sys.modules["tx_poster"] = stub

import tx_reader_auth  # noqa: E402


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _capture():
    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append({k.lower(): v for k, v in req.header_items()})
        return _Resp(json.dumps({"date": None}).encode())

    return seen, fake_urlopen


class ReaderHeaderTests(unittest.TestCase):
    def setUp(self):
        tx_reader_auth._warned.clear()
        self.value = "t-" + uuid.uuid4().hex

    def test_header_added_for_today_picks(self):
        with mock.patch.dict(os.environ, {"TG_READER_TOKEN": self.value}):
            h = tx_reader_auth.reader_headers("https://w.example", "/api/analyze/today-picks", {"A": "1"})
        self.assertEqual(h["X-TG-Reader-Token"], self.value)
        self.assertEqual(h["A"], "1")

    def test_header_added_for_hit_rate(self):
        with mock.patch.dict(os.environ, {"TG_READER_TOKEN": self.value}):
            h = tx_reader_auth.reader_headers("https://w.example", "/api/analyze/hit-rate?date=2026-10-25")
        self.assertEqual(h["X-TG-Reader-Token"], self.value)

    def test_not_sent_to_other_paths(self):
        with mock.patch.dict(os.environ, {"TG_READER_TOKEN": self.value}):
            for path in ("/api/analyze/hit-rate-rollup?days=30", "/api/meetings", "/api/analyze/today-picksX", "/api/analyze/hit-rateX"):
                self.assertNotIn("X-TG-Reader-Token", tx_reader_auth.reader_headers("https://w.example", path))

    def test_not_sent_over_http(self):
        err = io.StringIO()
        with mock.patch.dict(os.environ, {"TG_READER_TOKEN": self.value}), redirect_stderr(err):
            h = tx_reader_auth.reader_headers("http://w.example", "/api/analyze/today-picks")
        self.assertNotIn("X-TG-Reader-Token", h)
        self.assertIn("https", err.getvalue())
        self.assertNotIn(self.value, err.getvalue())

    def test_missing_env_warns_once_and_stays_anonymous(self):
        env = {k: v for k, v in os.environ.items() if k != "TG_READER_TOKEN"}
        err = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), redirect_stderr(err):
            h1 = tx_reader_auth.reader_headers("https://w.example", "/api/analyze/today-picks")
            h2 = tx_reader_auth.reader_headers("https://w.example", "/api/analyze/today-picks")
        self.assertNotIn("X-TG-Reader-Token", h1)
        self.assertNotIn("X-TG-Reader-Token", h2)
        self.assertEqual(err.getvalue().count("TG_READER_TOKEN 未設定"), 1)

    def _scripts(self):
        for name in ("tg_notify", "tg_race_cards"):
            mod = importlib.import_module(name)
            yield name, mod

    def test_scripts_send_header_when_env_present(self):
        with mock.patch.dict(os.environ, {"TG_READER_TOKEN": self.value}):
            for name, mod in self._scripts():
                seen, fake = _capture()
                with mock.patch.object(mod, "API_BASE", "https://w.example"), \
                        mock.patch("urllib.request.urlopen", fake):
                    mod.api_get("/api/analyze/today-picks")
                    mod.api_get("/api/meetings")
                    mod.api_get("/api/analyze/hit-rate?date=2026-10-25")
                self.assertEqual(seen[0].get("x-tg-reader-token"), self.value, name)
                self.assertNotIn("x-tg-reader-token", seen[1], name)
                self.assertEqual(seen[2].get("x-tg-reader-token"), self.value, name + " postrace hit-rate")

    def test_scripts_work_without_env(self):
        env = {k: v for k, v in os.environ.items() if k != "TG_READER_TOKEN"}
        with mock.patch.dict(os.environ, env, clear=True):
            for name, mod in self._scripts():
                tx_reader_auth._warned.clear()
                seen, fake = _capture()
                err = io.StringIO()
                with mock.patch.object(mod, "API_BASE", "https://w.example"), \
                        mock.patch("urllib.request.urlopen", fake), redirect_stderr(err):
                    data = mod.api_get("/api/analyze/today-picks")
                    data2 = mod.api_get("/api/analyze/hit-rate?date=2026-10-25")
                self.assertEqual(data, {"date": None}, name)
                self.assertEqual(data2, {"date": None}, name)
                self.assertNotIn("x-tg-reader-token", seen[0], name)
                self.assertNotIn("x-tg-reader-token", seen[1], name)
                self.assertIn("TG_READER_TOKEN 未設定", err.getvalue(), name)


if __name__ == "__main__":
    unittest.main()
