"""Entries list parser: dated grid, no invented barrier draw, wrong date fails."""

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hkjc_entries", ROOT / "scripts" / "hkjc_entries.py")
module = importlib.util.module_from_spec(spec)
sys.modules["hkjc_entries"] = module
spec.loader.exec_module(module)


def page(date_line, races, rows, extra=""):
    links = []
    class_cells = ["賽事班次"]
    rating_cells = ["評分幅度"]
    distance_cells = ["途程"]
    section_cells = ["組別"]
    track_cells = ["賽道"]
    for index, race in enumerate(races, start=1):
        links.append(
            f'<a href="javascript:ajaxNav(\'/entries?ProvRaceNo=P{index}0\')">{race["label"]}</a>'
        )
        class_cells.append(race["short"])
        rating_cells.append(f'({race["rating"]})')
        distance_cells.append(f'{race["distance"]}米')
        section_cells.append(race["section"])
        track_cells.append(race["track"])
    def tr(cells):
        return "<tr>" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"
    body = []
    for trainer, horses in rows:
        cells = [f'<a href="/trainer?trainerid=X">{trainer}</a>']
        for horse in horses:
            if horse is None:
                cells.append("")
            else:
                code, name = horse
                cells.append(
                    f'<div><a href="/horse?horseid=HK_2024_{code}">{name}</a></div>'
                )
        body.append(tr(cells))
    return f"""
    <html><body>
    <div>賽事日期: {date_line}</div>
    {''.join(links)}
    <table id="trainersInfo">
      <thead>
        <tr><th>練馬師</th></tr>
        {tr(class_cells)}
        {tr(rating_cells)}
        {tr(distance_cells)}
        {tr(section_cells)}
        {tr(track_cells)}
      </thead>
      <tbody>{''.join(body)}</tbody>
    </table>
    {extra}
    </body></html>
    """


RACES = [
    {
        "label": "第二班 1200米 組別1 樂聲盃（讓賽） (評分 100-80)",
        "short": "2", "rating": "100-80", "distance": "1200", "section": "1", "track": "草地",
    },
    {
        "label": "第三班 1650米 組別1 丙讓賽 (評分 80-60)",
        "short": "3", "rating": "80-60", "distance": "1650", "section": "1", "track": "全天候",
    },
]


class EntriesParserTests(unittest.TestCase):
    def test_entries_only_grid_has_no_draw_or_horse_number(self):
        html = page(
            "14/11/2026 沙田 - 混合賽道",
            RACES,
            [("伍鵬志", [("K014", "玩笑"), None]), ("呂健威", [None, ("J267", "奮鬥心")])],
        )
        rows = module.parse_entries_html(html, "2026-11-14", "ST", "2026-11-10T10:00:00Z")
        self.assertEqual(len(rows), 2)
        first = rows[0]
        self.assertEqual(first["race_name"], "樂聲盃（讓賽）")
        self.assertEqual(first["race_class"], "第二班")
        self.assertEqual(first["distance"], 1200)
        self.assertEqual(first["track"], "草地")
        self.assertEqual(first["rating_range"], "100-80")
        self.assertEqual(first["horse_code"], "K014")
        self.assertEqual(first["card_stage"], "entries")
        self.assertEqual(first["draw_status"], "unavailable")
        self.assertNotIn("draw", first)
        self.assertNotIn("horse_number", first)
        self.assertEqual(rows[1]["race_number"], 2)
        self.assertEqual(rows[1]["track"], "全天候")
        self.assertEqual(rows[1]["race_class"], "第三班")

    def test_wrong_date_fails_closed(self):
        html = page("11/11/2026 跑馬地", RACES[:1], [("伍鵬志", [("K014", "玩笑")])])
        with self.assertRaises(module.EntriesParseError):
            module.parse_entries_html(html, "2026-11-14", "ST", "2026-11-10T10:00:00Z")

    def test_unpublished_page_is_empty_not_an_error(self):
        html = "<html><body>沒有相關資料</body></html>"
        self.assertEqual(module.parse_entries_html(html, "2026-11-18", "HV", "2026-11-10T10:00:00Z"), [])

    def test_column_mismatch_fails_closed(self):
        html = page(
            "14/11/2026 沙田",
            RACES,
            [("伍鵬志", [("K014", "玩笑")])],
        )
        html = html.replace("(100-80)", "(90-70)")
        with self.assertRaises(module.EntriesParseError):
            module.parse_entries_html(html, "2026-11-14", "ST", "2026-11-10T10:00:00Z")

    def test_sql_replaces_only_parsed_meetings(self):
        rows = module.parse_entries_html(
            page("14/11/2026 沙田", RACES[:1], [("伍鵬志", [("K014", "玩笑")])]),
            "2026-11-14", "ST", "2026-11-10T10:00:00Z",
        )
        sql = module.emit_replace_sql(rows)
        self.assertIn("DELETE FROM official_race_entries WHERE race_date = '2026-11-14' AND venue = 'ST';", sql)
        self.assertIn("'entries'", sql)
        self.assertIn("'unavailable'", sql)
        self.assertNotIn("2026-11-18", sql)


class FixtureWindowTests(unittest.TestCase):
    def test_horizon_uses_official_csv(self):
        targets = module.fixture_targets(14, today=__import__("datetime").date(2026, 11, 10))
        dates = [day for day, _venue in targets]
        self.assertIn(("2026-11-14", "ST"), targets)
        self.assertIn(("2026-11-11", "HV"), targets)
        self.assertNotIn("2026-11-01", dates)
        self.assertTrue(all(day <= "2026-11-24" for day in dates))


if __name__ == "__main__":
    unittest.main()
