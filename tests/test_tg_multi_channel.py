import io, json, os, sys, tempfile, unittest, urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import tg_notify
try:
    import tx_poster
except ImportError:  # Pillow missing in a bare env
    tx_poster = None

FAKE_TOKEN = "123456:FAKE-TOKEN-should-never-be-printed"
CHAT_NOT_FOUND = b'{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'


class _Resp:
    def __init__(self, payload): self._b = json.dumps(payload).encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _chat_of(req):
    data = req.data
    if data.startswith(b"{"):
        return json.loads(data)["chat_id"]
    marker = b'name="chat_id"\r\n\r\n'
    i = data.index(marker) + len(marker)
    return data[i:data.index(b"\r\n", i)].decode()


def fake_urlopen(bad_chats, seen):
    def _open(req, timeout=None):
        chat = _chat_of(req); seen.append(chat)
        if chat in bad_chats:
            raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(CHAT_NOT_FOUND))
        return _Resp({"ok": True, "result": {"message_id": 42}})
    return _open


class ParseChannelsTest(unittest.TestCase):
    def test_parse(self):
        for fn in [tg_notify.tg_channels] + ([tx_poster.tg_channels] if tx_poster else []):
            self.assertEqual(fn("@a, @b ,,@a"), ["@a", "@b"])
            self.assertEqual(fn("-1001234"), ["-1001234"])
            self.assertEqual(fn(""), ["@tianxi_racing_pro", "@tianxi_racing"])

    def test_default_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TG_CHANNEL", None)
            self.assertEqual(tg_notify.tg_channels(), ["@tianxi_racing_pro", "@tianxi_racing"])
            if tx_poster:
                self.assertEqual(tx_poster.tg_channels(), ["@tianxi_racing_pro", "@tianxi_racing"])


class TgNotifyMultiTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": FAKE_TOKEN, "TG_CHANNEL": "@pro,@free"})
        self.env.start(); os.environ.pop("TX_DRY_RUN", None)

    def tearDown(self): self.env.stop()

    def _run(self, bad):
        seen, out, err = [], io.StringIO(), io.StringIO()
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen(bad, seen)), redirect_stdout(out), redirect_stderr(err):
            try:
                tg_notify.tg_send("hi"); code = None
            except SystemExit as e:
                code = e.code
        return seen, out.getvalue(), err.getvalue(), code

    def test_one_fails_other_still_sent(self):
        seen, out, err, code = self._run({"@pro"})
        self.assertEqual(seen, ["@pro", "@free"]); self.assertIsNone(code)
        self.assertIn("chat not found", err); self.assertIn("chat_id=@pro", err)
        self.assertIn("chat_id=@free", out)
        self.assertNotIn("FAKE-TOKEN", out + err)

    def test_all_fail_exits(self):
        seen, out, err, code = self._run({"@pro", "@free"})
        self.assertEqual(code, 3); self.assertEqual(seen, ["@pro", "@free"])
        self.assertNotIn("FAKE-TOKEN", out + err)


@unittest.skipIf(tx_poster is None, "tx_poster import failed")
class TxPosterMultiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        self.tmp.write(b"%PDF-1.4 test"); self.tmp.close()
        self.env = mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": FAKE_TOKEN, "TG_CHANNEL": "@pro,@free"})
        self.env.start(); os.environ.pop("TX_DRY_RUN", None)

    def tearDown(self):
        self.env.stop(); os.unlink(self.tmp.name)

    def test_one_fails_other_still_sent(self):
        seen, out, err = [], io.StringIO(), io.StringIO()
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen({"@pro"}, seen)), redirect_stdout(out), redirect_stderr(err):
            tx_poster.tg_send_document(Path(self.tmp.name), "cap")
        self.assertEqual(seen, ["@pro", "@free"])
        self.assertIn("chat not found", err.getvalue()); self.assertIn("posted @free 42", out.getvalue())
        self.assertNotIn("FAKE-TOKEN", out.getvalue() + err.getvalue())

    def test_all_fail_raises(self):
        seen = []
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen({"@pro", "@free"}, seen)), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                tx_poster.tg_send_document(Path(self.tmp.name), "cap")
        msg = str(cm.exception.code)
        self.assertIn("all 2 chat(s)", msg); self.assertIn("chat_id=@pro", msg); self.assertIn("chat_id=@free", msg)
        self.assertNotIn("FAKE-TOKEN", msg)


if __name__ == "__main__":
    unittest.main()
