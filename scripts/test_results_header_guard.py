import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).resolve().parents[1] / "results_header_guard.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HeaderGuardTests(unittest.TestCase):
    def test_visible_surface_without_course_fails(self):
        reason = module.official_header_miss(
            {"course": "", "distance_m": "1650", "rating_range": "40-0"},
            "全天候跑道, 1650米, 好地 評分: 40-0",
        )
        self.assertIn("course", reason)

    def test_parsed_awt_and_rating_pass(self):
        self.assertIsNone(module.official_header_miss(
            {"course": "全天候跑道", "distance_m": "1650", "rating_range": "40-0"},
            "全天候跑道 1650米 40-0",
        ))

    def test_visible_rating_left_blank_fails(self):
        reason = module.official_header_miss(
            {"course": '草地 - "A" 賽道', "distance_m": "1200", "rating_range": ""},
            '草地 - "A" 賽道 1200米 (60-40)',
        )
        self.assertIn("rating", reason)

    def test_no_surface_word_is_not_a_miss(self):
        self.assertIsNone(module.official_header_miss(
            {"course": "", "distance_m": "", "rating_range": ""},
            "第 1 場",
        ))

    def test_group_race_without_rating_band_keeps_distance(self):
        # 2026-11-08 ST R8 莎莎婦女銀袋: "三級賽 - 1800米" has no rating band.
        self.assertEqual(module.parse_class_distance("三級賽 - 1800米 場地狀況 : 好地"), ("三級賽", "1800", ""))
        self.assertEqual(module.parse_class_distance("第四班 - 1200米 - (60-40) 場地狀況 : 好地"), ("第四班", "1200", "60-40"))
        self.assertIsNone(module.parse_class_distance("三級賽 場地狀況 : 好地"))
        self.assertIsNone(module.official_header_miss(
            {"course": '草地 - "C+3" 賽道', "distance_m": "1800", "rating_range": ""},
            '第 8 場 (174) 三級賽 - 1800米 場地狀況 : 好地 莎莎婦女銀袋（讓賽） 賽道 : 草地 - "C+3" 賽道 HK$ 4,200,000',
        ))


if __name__ == "__main__":
    unittest.main()
