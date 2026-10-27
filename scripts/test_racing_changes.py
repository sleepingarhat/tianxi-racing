import importlib.util
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("changes", Path(__file__).with_name("RacingChanges_Scraper.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ROOT = Path(__file__).resolve().parents[1]


def board(heading, rows, overseas=""):
    body = "".join(
        f'<tr><td class="f_tac">第 {race} 場</td><td style="padding-left: 10px;">{cell}</td></tr>'
        for race, cell in rows
    )
    extra = ""
    if overseas:
        extra = (
            '<div class="margin_top10 f_fs13 font_wb">25/10/2026 <span>海外賽事 (S2 日本)</span></div>'
            '<div class="margin_top10"><table class="change_detail"><tr><td class="f_tac">第 1 場</td>'
            "<td>1 號馬 海外馬 退出競賽。 (25/10 01:00)</td></tr></table></div>"
        )
    return f'''<html><title>更易事項</title>
        <div class="margin_top10 f_fs13 font_wb">{heading}</div>
        <div class="margin_top10"><table class="change_detail">{body}</table></div>
        {extra}</html>'''


class ChangesTests(unittest.TestCase):
    def test_real_snapshot_scratches_and_ignores_overseas(self):
        path = ROOT / "data/racing-changes/2026-10-25/ST-3dd90e764ec51961c7dc7f81930bf064dc07b8e88ebadbf78f072f01680b0d44.html"
        meetings = module.parse_changes_html(path.read_text(encoding="utf-8"))
        self.assertEqual([(m["date"], m["venue"]) for m in meetings], [("2026-10-25", "ST")])
        scratches = [e for e in meetings[0]["events"] if e["change_type"] == "scratch"]
        self.assertEqual([(e["race_number"], e["horse_number"], e["horse_name"]) for e in scratches], [(1, 4, "星月峰雲"), (4, 11, "奇異果")])
        self.assertTrue(all(e["change_type"] != "unparsed" for e in meetings[0]["events"]))

    def test_weight_jockey_reserve_and_before_after(self):
        html = board("19/10/2026 沙田", [
            (8, "<b> 3 </b>號馬<b> 活力拍檔 </b>退出競賽,由後備馬 <b>風將</b> 補上。 (18/10 10:03)<br />"
                "<b> 3 </b>號馬<b> 風將 </b>由騎師 <b>何澤堯</b> 策騎。 (18/10 10:03)<br />"
                "<b> 3 </b>號馬<b> 風將 </b>將負 <b>122</b> 磅。 (18/10 10:03)<br />"),
            (2, "1 號馬 測試 的騎師由 潘頓 改為 莫雷拉。 (19/10 09:00)<br />"
                "1 號馬 測試 的負磅由 130 磅改為 128 磅。 (19/10 09:01)<br />"),
            (3, "&nbsp;--"),
        ], overseas=True)
        meeting = module.parse_changes_html(html)[0]
        kinds = [(e["race_number"], e["change_type"], e["horse_name"], e["before_value"], e["after_value"]) for e in meeting["events"]]
        self.assertIn((8, "scratch", "活力拍檔", "活力拍檔", "退出"), kinds)
        self.assertIn((8, "reserve", "風將", "活力拍檔", "風將"), kinds)
        self.assertIn((8, "jockey", "風將", "", "何澤堯"), kinds)
        self.assertIn((8, "weight", "風將", "", "122"), kinds)
        self.assertIn((2, "jockey", "測試", "潘頓", "莫雷拉"), kinds)
        self.assertIn((2, "weight", "測試", "130", "128"), kinds)
        self.assertNotIn("海外馬", [e["horse_name"] for e in meeting["events"]])

    def test_date_mismatch_does_not_stamp_request(self):
        html = board("21/10/2026 跑馬地", [(1, "1 號馬 創科群英 退出競賽。 (20/10 09:06)")])
        meetings = module.parse_changes_html(html)
        with self.assertRaises(module.IdentityError):
            module.select_meetings(meetings, "2026-10-25", "ST")

    def test_visible_unknown_clause_is_unparsed(self):
        html = board("28/10/2026 沙田", [(1, "臨時改跑道但沒有馬號。")])
        event = module.parse_changes_html(html)[0]["events"][0]
        self.assertEqual(event["change_type"], "unparsed")
        self.assertIn("臨時改跑道", event["raw_text"])

    def test_existing_snapshots_parse(self):
        for path in (ROOT / "data/racing-changes").rglob("*.html"):
            meetings = module.parse_changes_html(path.read_text(encoding="utf-8", errors="replace"))
            self.assertTrue(meetings, path)
            for meeting in meetings:
                self.assertNotIn("unparsed", [e["change_type"] for e in meeting["events"]], path)

    def test_manifest_append_keeps_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root / "data/racing-changes/manifest.json"
            manifest.parent.mkdir(parents=True)
            original = '{\n  "snapshots": [\n    {\n      "path": "data/racing-changes/2026-10-19/ST-aaa.html",\n      "sha256": "aaa"\n    }\n  ]\n}\n'
            manifest.write_text(original, encoding="utf-8")
            added = module.append_manifest(manifest, {
                "path": "data/racing-changes/2026-10-28/ST-bbb.html",
                "sha256": "bbb",
                "sourceUrl": module.SOURCE_URL,
                "date": "2026-10-28",
                "kind": "racing-changes",
                "venue": "ST",
            })
            text = manifest.read_text(encoding="utf-8")
            self.assertTrue(added)
            self.assertTrue(text.startswith(original[:original.rfind("\n  ]")]))
            self.assertIn('"sha256": "aaa"', text)
            saved = json.loads(text)
            self.assertEqual([s["sha256"] for s in saved["snapshots"]], ["aaa", "bbb"])
            self.assertFalse(module.append_manifest(manifest, {
                "path": "data/racing-changes/2026-10-28/ST-bbb.html",
                "sha256": "bbb",
            }))

    def test_writeback_matches_name_and_prelock(self):
        html = board("28/10/2026 沙田", [
            (1, "4 號馬 星月峰雲 退出競賽。 (27/10 09:00)<br />5 號馬 幸運同行 將負 117 磅。 (27/10 09:01)<br />"
                "6 號馬 其他人 由騎師 潘頓 策騎。 (27/10 09:02)"),
        ])
        meeting = module.parse_changes_html(html)[0]
        rows = module.rows_from_meeting(meeting, "abc", "data/racing-changes/x.html")
        sql = module.projection_sql(rows, "2026-10-27T00:00:00Z")
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE horses (id TEXT, code TEXT, name_ch TEXT);
            CREATE TABLE entries_upcoming (
              race_date TEXT, venue TEXT, race_number INT, horse_number INT,
              horse_code TEXT, horse_id TEXT, jockey_name TEXT, actual_weight REAL,
              priority_order TEXT, post_time TEXT, gear TEXT, draw INT);
            CREATE TABLE racing_changes (
              id TEXT, race_date TEXT, venue TEXT, race_number INT, horse_number INT,
              horse_name TEXT, change_type TEXT, before_value TEXT, after_value TEXT,
              announced_at TEXT, raw_text TEXT, source_sha256 TEXT, snapshot_path TEXT, captured_at TEXT);
        """)
        db.executemany(
            "INSERT INTO horses VALUES (?,?,?)",
            [("horse_A", "A", "星月峰雲"), ("horse_B", "B", "幸運同行"), ("horse_C", "C", "其他人")],
        )
        future = "2099-01-01T18:00:00+08:00"
        past = "2000-01-01T18:00:00+08:00"
        db.executemany(
            "INSERT INTO entries_upcoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                ("2026-10-28", "ST", 1, 4, "A", "A", "舊騎", 120, "正選", future, None, None),
                ("2026-10-28", "ST", 1, 5, "B", "B", "某騎", 130, "正選", future, None, None),
                ("2026-10-28", "ST", 1, 9, "Z", "Z", "舊騎", 120, "正選", future, None, None),
                ("2026-10-28", "ST", 1, 6, "NO", "NO", "舊騎", 120, "正選", future, None, None),
            ],
        )
        db.executescript(sql)
        scratched = db.execute("SELECT priority_order FROM entries_upcoming WHERE horse_number=4").fetchone()[0]
        weight = db.execute("SELECT actual_weight FROM entries_upcoming WHERE horse_number=5").fetchone()[0]
        untouched = db.execute("SELECT jockey_name, priority_order FROM entries_upcoming WHERE horse_number=9").fetchone()
        wrong_name = db.execute("SELECT jockey_name FROM entries_upcoming WHERE horse_number=6").fetchone()[0]
        self.assertEqual(scratched, "退出")
        self.assertEqual(weight, 117)
        self.assertEqual(untouched, ("舊騎", "正選"))
        self.assertEqual(wrong_name, "舊騎")
        db.execute("UPDATE entries_upcoming SET post_time=?, priority_order='正選'", (past,))
        db.executescript(sql)
        after_lock = db.execute("SELECT priority_order FROM entries_upcoming WHERE horse_number=4").fetchone()[0]
        self.assertEqual(after_lock, "正選")
        stored = db.execute("SELECT change_type, raw_text FROM racing_changes WHERE horse_number=6").fetchone()
        self.assertEqual(stored[0], "jockey")
        self.assertIn("其他人", stored[1])


if __name__ == "__main__":
    unittest.main()
