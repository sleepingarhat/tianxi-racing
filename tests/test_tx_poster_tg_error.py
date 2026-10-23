import io, os, sys, tempfile, unittest, urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
try:
    import tx_poster
except ImportError as exc:  # Pillow missing in a bare env
    tx_poster = None
    _skip = str(exc)

FAKE_TOKEN = "123456:FAKE-TOKEN-should-never-be-printed"


@unittest.skipIf(tx_poster is None, "tx_poster import failed")
class TgSendDocumentErrorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        self.tmp.write(b"%PDF-1.4 test"); self.tmp.close()
        self.env = mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": FAKE_TOKEN, "TG_CHANNEL": "@old_channel"})
        self.env.start(); os.environ.pop("TX_DRY_RUN", None)

    def tearDown(self):
        self.env.stop(); os.unlink(self.tmp.name)

    def _http_400(self, body: bytes):
        url = "https://api.telegram.org/bot%s/sendDocument" % FAKE_TOKEN
        return urllib.error.HTTPError(url, 400, "Bad Request", {}, io.BytesIO(body))

    def test_http_400_surfaces_description_without_token(self):
        err = self._http_400(b'{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(SystemExit) as cm:
                tx_poster.tg_send_document(Path(self.tmp.name), "TX-ORACLE · 2026-10-21 全日比對")
        msg = str(cm.exception.code)
        self.assertIn("Bad Request: chat not found", msg)
        self.assertIn("HTTP 400", msg)
        self.assertIn("chat_id=@old_channel", msg)
        self.assertIn("sendDocument", msg)
        self.assertNotIn(FAKE_TOKEN, msg)
        self.assertNotIn("FAKE-TOKEN", msg)

    def test_non_json_body(self):
        msg = tx_poster.tg_error_message("sendDocument", 502, b"<html>bad gateway</html>", "@c")
        self.assertIn("HTTP 502", msg); self.assertIn("bad gateway", msg)

    def test_ok_false_response(self):
        msg = tx_poster.tg_error_message("sendDocument", 400, {"ok": False, "description": "Bad Request: file must be non-empty"}, "@c", "x.pdf")
        self.assertIn("file must be non-empty", msg); self.assertIn("file=x.pdf", msg)


if __name__ == "__main__":
    unittest.main()
