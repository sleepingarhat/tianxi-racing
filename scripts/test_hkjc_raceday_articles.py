import gzip
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hkjc_raceday_articles as ar  # noqa: E402
from hkjc_raceday_companions import IdentityError, ParseMiss  # noqa: E402

FIX = Path(__file__).with_name('fixtures') / 'articles'
FOCUS = gzip.decompress((FIX / 'raceday-focus_2026-11-03.html.gz').read_bytes()).decode('utf-8')
LASTRUN = gzip.decompress((FIX / 'last-run-reminder_2026-11-03.html.gz').read_bytes()).decode('utf-8')


def root_with_runners():
    tmp = Path(tempfile.mkdtemp())
    (tmp / 'data' / 'official_raceday').mkdir(parents=True)
    shutil.copy(FIX / 'ride_assignment_2026-11-04_HV.csv', tmp / 'data' / 'official_raceday' / 'ride_assignment.csv')
    return tmp


def fetch_real(path):
    return (FOCUS if 'focus' in path else LASTRUN).encode('utf-8')


class Focus(unittest.TestCase):
    def test_2026_11_04_article(self):
        row = ar.parse_focus(FOCUS, '2026-11-04', 'HV', 'a' * 64, 'now')
        self.assertEqual(row['title_ch'], '猛男複製輝煌戰績')
        self.assertEqual(row['version'], 2)
        self.assertTrue(row['highlight_ch'].startswith('姚本輝今季首次梅開二度'))
        self.assertEqual(len(row['body_sha256']), 64)
        self.assertGreater(row['body_chars'], 500)
        self.assertNotIn('body_ch', row)  # editorial body text is never stored

    def test_unpublished_meeting_is_pending(self):
        self.assertIsNone(ar.parse_focus(FOCUS, '2026-11-08', 'ST', 'a' * 64, 'now'))

    def test_missing_payload_fails_closed(self):
        with self.assertRaises(ParseMiss):
            ar.parse_focus('<html></html>', '2026-11-04', 'HV', 'a' * 64, 'now')


class LastRun(unittest.TestCase):
    def runners(self):
        return ar.meeting_runners(root_with_runners(), '2026-11-04', 'HV')

    def test_2026_11_04_rows_match_declared_runners(self):
        rows = ar.parse_lastrun(LASTRUN, '2026-11-04', 'HV', self.runners(), 'a' * 64, 'now')
        self.assertEqual(len(rows), 15)
        first = rows[0]
        self.assertEqual((first['race_no'], first['horse_no'], first['horse_code']), (1, 2, 'L067'))
        self.assertEqual(first['horse_id'], 'HK_2025_L067')
        self.assertEqual(first['last_date'], '2026-09-27')
        self.assertEqual(first['last_venue'], 'ST')
        self.assertEqual(first['last_distance_m'], 1000)
        self.assertEqual(first['page_updated_at'], '2026-11-03T12:00:00+08:00')
        self.assertTrue(all(r['last_date'] < '2026-11-04' for r in rows))

    def test_other_meeting_is_pending(self):
        self.assertIsNone(ar.parse_lastrun(LASTRUN, '2026-11-01', 'HV', self.runners(), 'a' * 64, 'now'))

    def test_wrong_brand_fails_closed(self):
        runners = self.runners()
        runners[(1, 2)] = {**runners[(1, 2)], 'horse_code': 'Z999'}
        with self.assertRaises(IdentityError):
            ar.parse_lastrun(LASTRUN, '2026-11-04', 'HV', runners, 'a' * 64, 'now')

    def test_no_declared_runners_fails_closed(self):
        with self.assertRaises(IdentityError):
            ar.parse_lastrun(LASTRUN, '2026-11-04', 'HV', {}, 'a' * 64, 'now')

    def test_wrong_venue_has_no_runners(self):
        with self.assertRaises(IdentityError):
            ar.parse_lastrun(LASTRUN, '2026-11-04', 'ST', ar.meeting_runners(root_with_runners(), '2026-11-04', 'ST'),
                             'a' * 64, 'now')


class Pipeline(unittest.TestCase):
    def test_run_and_sql_round_trip(self):
        root = root_with_runners()
        summary = ar.run(root, date(2026, 11, 3), '2026-11-04', 'HV', ['focus', 'lastrun'], fetch=fetch_real)
        self.assertEqual(summary, {'focus': 1, 'lastrun': 15})
        db = root / 'd1.sqlite'
        ar.apply_sql(db, ar.emit_sql(root))
        ar.apply_sql(db, ar.emit_sql(root))  # idempotent
        con = sqlite3.connect(db)
        self.assertEqual(con.execute('select count(*) from official_last_run_reminder').fetchone()[0], 15)
        self.assertEqual(con.execute('select title_ch from official_raceday_focus').fetchone()[0], '猛男複製輝煌戰績')
        manifest = (root / 'data' / 'official_raceday' / 'manifest.jsonl').read_text(encoding='utf-8')
        self.assertEqual(manifest.count('\n'), 2)


if __name__ == '__main__':
    unittest.main()
