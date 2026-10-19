import ast
import unittest
from pathlib import Path


def load_function(filename, name):
    tree = ast.parse(Path(__file__).with_name(filename).read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    namespace = {}
    exec(compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec'), namespace)
    return namespace[name]


class CalendarEvidenceTests(unittest.TestCase):
    def test_missing_calendar_date_is_not_a_cancellation(self):
        merge = load_function('FixtureCalendar_Scraper.py', 'merge_fixture_rows')
        rows = merge([{'date': '2026-09-20', 'captured_at': 'original'}], [{'date': '2026-10-21', 'captured_at': 'new'}])
        self.assertEqual([r['date'] for r in rows], ['2026-09-20', '2026-10-21'])
        self.assertEqual(rows[0]['captured_at'], 'original')

    def test_refresh_updates_present_date_without_duplicates(self):
        merge = load_function('FixtureCalendar_Scraper.py', 'merge_fixture_rows')
        rows = merge([{'date': '2026-10-21', 'captured_at': 'old'}], [{'date': '2026-10-21', 'captured_at': 'new'}])
        self.assertEqual(rows, [{'date': '2026-10-21', 'captured_at': 'new'}])


class TrainerRefreshTests(unittest.TestCase):
    def test_existing_history_preserved_and_new_race_added(self):
        import pandas as pd
        merge = load_function('TrainerData_Scraper.py', 'merge_verified_records')
        old = {'trainer_code': 'CJA', 'date': '19/10/2026', 'race_index': '100', 'horse_name': '原馬', 'place': '3'}
        new = {**old, 'date': '21/10/2026', 'race_index': '101', 'place': '1'}
        rows = merge(pd.DataFrame([old]), pd.DataFrame([{**old, 'place': '9'}, new])).to_dict('records')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['place'], '3')
        self.assertEqual(rows[1]['race_index'], '101')


class JockeyRetryTests(unittest.TestCase):
    def test_known_profile_without_records_retries(self):
        import tempfile
        retry = load_function('JockeyData_Scraper.py', 'needs_records_retry')
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(retry('BEP', {'BEP'}, Path(directory) / 'jockey_BEP.csv'))

    def test_header_only_records_retries(self):
        import tempfile
        retry = load_function('JockeyData_Scraper.py', 'needs_records_retry')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'jockey_CJR.csv'
            path.write_text('jockey_code,date,place\n')
            self.assertTrue(retry('CJR', {'CJR'}, path))


if __name__ == '__main__':
    unittest.main()