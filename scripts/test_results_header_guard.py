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


if __name__ == "__main__":
    unittest.main()
