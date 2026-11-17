"""2026-11-14 Sha Tin race 6 stays in the results file as cancelled/void."""
import csv
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cancel", ROOT / "results_cancellation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PHRASE = "此場賽事宣佈取消。根據賽馬博彩規例，若此賽事設有單場彩池，有關注項將予以退款。"
RACE6 = (
    "賽事日期: 14/11/2026    沙田\n"
    + PHRASE
    + "\n獨贏 - 退款\n位置 - 退款\n連贏 - 退款\n位置Q - 退款\n四重彩 - 退款\n"
)


class CancellationTests(unittest.TestCase):
    def test_official_phrase_keeps_2026_11_14_st_race_6(self):
        row = module.cancelled_result_row(RACE6, 6, "2026-11-14", "沙田")
        self.assertIsNotNone(row)
        self.assertEqual(row["race_no"], "6")
        self.assertEqual(row["date"], "2026-11-14")
        self.assertEqual(row["venue"], "沙田")
        self.assertEqual(row["race_status"], "cancelled")
        self.assertEqual(row["place"], "取消")
        self.assertEqual(row["horse_no"], "")
        self.assertEqual(row["official_message"], PHRASE)
        self.assertIn("退款", PHRASE)
        self.assertTrue(module.is_void_result_row(row))
        self.assertEqual(module.void_race_numbers([row, {"race_no": "1", "place": "1", "horse_no": "12"}]), {6})
        self.assertEqual(module.accounted_race_numbers([
            {"race_no": "1", "place": "1", "horse_no": "12"},
            row,
            {"race_no": "7", "place": "1", "horse_no": "9"},
        ]), {1, 6, 7})

    def test_other_race_header_is_not_this_cancellation(self):
        stolen = "第 1 場 (187)\n" + RACE6
        self.assertIsNone(module.cancelled_result_row(stolen, 12, "2026-11-14", "沙田"))

    def test_run_race_without_the_phrase_is_not_void(self):
        self.assertIsNone(module.cancelled_result_row(
            "賽事日期: 14/11/2026 沙田\n第 7 場 (193)\n名次 馬號",
            7, "2026-11-14", "沙田",
        ))
        self.assertFalse(module.is_void_result_row({"race_no": "7", "place": "3 平頭馬", "horse_no": "6"}))

    def test_repo_csv_already_holds_race_6(self):
        path = ROOT / "data" / "2026" / "results_2026-11-14.csv"
        with path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        void = [row for row in rows if module.is_void_result_row(row)]
        self.assertEqual([row["race_no"] for row in void], ["6"])
        self.assertEqual(void[0]["official_message"], PHRASE)
        self.assertEqual(void[0]["date"], "2026-11-14")
        numbers = {int(row["race_no"]) for row in rows}
        self.assertEqual(numbers, set(range(1, 12)))


if __name__ == "__main__":
    unittest.main()
