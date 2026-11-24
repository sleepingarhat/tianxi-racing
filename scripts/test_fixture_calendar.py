import importlib.util
import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fixture", ROOT / "FixtureCalendar_Scraper.py")
module = importlib.util.module_from_spec(spec)
sys.modules["fixture"] = module
spec.loader.exec_module(module)


def cell(day, venue, timing, surface, lines):
    body = "".join(
        f'<p><span class="font_wb">{distance}({count})</span><span>{rating}</span></p>'
        for distance, count, rating in lines
    )
    return f'''<td class="calendar">
        <p class="f_clear"><span class="f_fl f_fs14">{day}</span>
        <span class="f_fr">
            <img alt="{venue}"/><img alt="{timing}"/><img alt="{surface}"/>
        </span></p>
        {body}
    </td>'''


def month(title, cells):
    return f'<table><tr><td colspan="7">{title}</td></tr>{"".join(cells)}</table>'


class FixtureTests(unittest.TestCase):
    def test_sha_tin_night_awt_race_count(self):
        html = month("二0二六年十月", [
            cell(28, "ST", "N", "AWT", [
                ("1200", 1, "85-60"), ("1650", 1, "85-60"), ("1200", 2, "60-40"),
                ("1650", 1, "60-40"), ("1800", 1, "60-40"), ("1200", 1, "40-0"),
                ("1650", 2, "40-0"),
            ]),
        ])
        rows = module.parse_month_html(html, 2026, 10)
        self.assertEqual(rows, [{
            "day": 28, "venue": "ST", "timing": "night", "surface": "awt", "race_count": "9",
        }])

    def test_twilight_icon_is_a_session(self):
        html = month("二0二五年六月", [
            cell(8, "ST", "T", "TURF", [("1400", 1, "100-80"), ("1200", 8, "80-60")]),
        ])
        rows = module.parse_month_html(html, 2025, 6)
        self.assertEqual(rows[0]["timing"], "twilight")
        self.assertEqual(rows[0]["surface"], "turf")
        self.assertEqual(rows[0]["race_count"], "9")

    def test_empty_month_guard_keeps_other_month_out(self):
        html = month("二0二六年九月", [cell(7, "HV", "N", "TURF", [("1200", 8, "60-40")])])
        self.assertEqual(module.parse_month_html(html, 2026, 10), [])

    def test_icon_only_cell_keeps_blank_race_count(self):
        html = month("二0二七年一月", [cell(1, "ST", "D", "MIXED", [])])
        rows = module.parse_month_html(html, 2027, 1)
        self.assertEqual(rows[0]["venue"], "ST")
        self.assertEqual(rows[0]["timing"], "day")
        self.assertEqual(rows[0]["surface"], "mixed")
        self.assertEqual(rows[0]["race_count"], "")

    def test_visible_distance_without_count_fails(self):
        broken = '''<td class="calendar"><p class="f_clear"><span class="f_fl f_fs14">24</span>
            <span class="f_fr"><img alt="HV"/><img alt="N"/><img alt="TURF"/></span></p>
            <span class="font_wb">1200</span></td>'''
        with self.assertRaises(module.FixtureParseError):
            module.parse_month_html(month("二0二五年九月", [broken]), 2025, 9)

    def test_blank_new_count_does_not_erase_a_stored_count(self):
        old = [{"date": "2026-09-20", "race_count": "9", "venue": "ST"}]
        new = [{"date": "2026-09-20", "race_count": "", "venue": "ST", "timing": "day", "surface": "mixed"}]
        merged = module.merge_fixture_rows(old, new)
        self.assertEqual(merged[0]["race_count"], "9")
        self.assertEqual(merged[0]["timing"], "day")

    def test_missing_surface_fails_closed(self):
        broken = '''<td class="calendar"><p class="f_clear"><span class="f_fs14">28</span>
            <span class="f_fr"><img alt="ST"/><img alt="N"/></span></p>
            <span class="font_wb">1650(9)</span></td>'''
        with self.assertRaises(module.FixtureParseError):
            module.parse_month_html(month("二0二六年十月", [broken]), 2026, 10)

    def test_class_lines_keep_grade_distance_and_course(self):
        body = '''
            <p><span><img src="/fixture/class_2.gif" alt="2"/></span>
                <span class="font_wb">1200(1) -C</span><span>100-80</span></p>
            <p><span><img src="/fixture/class_G3.gif" alt="G3"/></span>
                <span class="font_wb">1400(1)</span><span>105-80</span></p>
            <p><span><img src="/fixture/class_4R.gif" alt="4R"/></span>
                <span class="font_wb">1650(2)</span><span>60-40</span></p>
        '''
        html = month("二0二六年十一月", [f'''<td class="calendar">
            <p class="f_clear"><span class="f_fl f_fs14">1</span>
            <span class="f_fr"><img alt="HV"/><img alt="D"/><img alt="TURF"/></span></p>
            {body}</td>'''])
        lines = module.parse_month_lines(html, 2026, 11)
        self.assertEqual([row["class_code"] for row in lines], ["2", "G3", "4R"])
        self.assertEqual(lines[0]["course_text"], "-C")
        self.assertEqual(lines[0]["distance"], 1200)
        self.assertEqual(lines[0]["rating_band"], "100-80")
        self.assertEqual(lines[1]["course_text"], None)
        self.assertEqual(sum(row["race_count"] for row in lines), 4)
        self.assertEqual(lines[0]["meeting_date"], "2026-11-01")

    def test_distance_lines_that_do_not_add_up_fail(self):
        html = month("二0二六年十一月", [f'''<td class="calendar">
            <p class="f_clear"><span class="f_fl f_fs14">1</span>
            <span class="f_fr"><img alt="HV"/><img alt="D"/><img alt="TURF"/></span></p>
            <p><img src="/fixture/class_5.gif" alt="5"/>
            <span class="font_wb">1200(1)</span><span>40-0</span></p></td>'''])
        # Meeting count reads 1 from 1200(1), and the line count is 1. A second
        # distance printed outside a class line is the existing meeting failure.
        broken = month("二0二六年十一月", [f'''<td class="calendar">
            <p class="f_clear"><span class="f_fl f_fs14">1</span>
            <span class="f_fr"><img alt="HV"/><img alt="D"/><img alt="TURF"/></span></p>
            <p><img src="/fixture/class_5.gif" alt="5"/>
            <span class="font_wb">1200(1)</span><span>40-0</span></p>
            <p><span class="font_wb">1650(1)</span><span>40-0</span></p></td>'''])
        with self.assertRaises(module.FixtureParseError):
            module.parse_month_lines(broken, 2026, 11)
        self.assertEqual(module.parse_month_lines(html, 2026, 11)[0]["class_code"], "5")

    def test_merge_keeps_dates_absent_from_the_new_scrape(self):
        old = [{"date": "2025-01-01", "season_year": 2025, "weekday": "Wed"}]
        new = [{"date": "2026-10-28", "season_year": 2026, "venue": "ST", "timing": "night", "surface": "awt", "race_count": "9"}]
        merged = module.merge_fixture_rows(old, new)
        self.assertEqual([row["date"] for row in merged], ["2025-01-01", "2026-10-28"])
        self.assertEqual(merged[0]["weekday"], "Wed")
        self.assertEqual(merged[1]["venue"], "ST")


if __name__ == "__main__":
    unittest.main()
