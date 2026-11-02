import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hkjc_challenge_boards as ch  # noqa: E402

FIX = Path(__file__).with_name('fixtures') / 'challenge'


def load(name):
    return json.loads((FIX / name).read_text(encoding='utf-8'))


class ChallengeBoards(unittest.TestCase):
    def test_queries_are_page_bundles(self):
        queries = ch.load_queries()
        self.assertEqual(set(queries), {'rw_JKCScheduledRides', 'rw_TNCTRAINERSENTRIES'})

    def test_jockey_challenge_2026_11_01(self):
        rows = ch.parse_challenge(load('jkc_2026-11-01_HV.json'), 'JKC', '2026-11-01', 'HV', 'a' * 64, 'now')
        winner = [r for r in rows['challenge_selection'] if r['final_order'] == 1]
        self.assertEqual(len(winner), 1)
        self.assertEqual(winner[0]['person_code'], 'HCY')
        self.assertEqual(winner[0]['person_name_ch'], '何澤堯')
        self.assertEqual(winner[0]['accumulated_points'], '44.0')
        self.assertEqual(winner[0]['odds_text'], '1.08')
        self.assertEqual(len(rows['challenge_ride']), 42)
        self.assertTrue(all(r['not_race_result'] == 1 for r in rows['challenge_selection']))

    def test_other_selection_keeps_its_own_order(self):
        rows = ch.parse_challenge(load('jkc_2026-11-01_HV.json'), 'JKC', '2026-11-01', 'HV', 'a' * 64, 'now')
        other = [r for r in rows['challenge_selection'] if r['person_code'] == 'MHT']
        self.assertEqual(other[0]['is_other'], 1)
        self.assertIsNone(other[0]['final_order'])
        self.assertEqual(other[0]['other_order'], 1)

    def test_trainer_challenge_2026_11_01(self):
        rows = ch.parse_challenge(load('tnc_2026-11-01_HV.json'), 'TNC', '2026-11-01', 'HV', 'a' * 64, 'now')
        winner = [r for r in rows['challenge_selection'] if r['final_order'] == 1][0]
        self.assertEqual((winner['person_code'], winner['accumulated_points'], winner['scheduled_rides']), ('LKW', '30.0', 4))

    def test_unpublished_pool_is_pending(self):
        payload = load('jkc_2026-11-01_HV.json')
        payload['data']['commonMeetings'][0]['foPools'] = []
        self.assertIsNone(ch.parse_challenge(payload, 'JKC', '2026-11-01', 'HV', 'a' * 64, 'now'))

    def test_wrong_venue_refused(self):
        with self.assertRaises(ch.IdentityError):
            ch.parse_challenge(load('jkc_2026-11-01_HV.json'), 'JKC', '2026-11-01', 'ST', 'a' * 64, 'now')

    def test_result_code_mismatch_refused(self):
        payload = load('tnc_2026-11-01_HV.json')
        pool = payload['data']['commonMeetings'][0]['foPools'][0]
        pool['selections'][0]['code'] = 'ZZZ'
        with self.assertRaises(ch.IdentityError):
            ch.parse_challenge(payload, 'TNC', '2026-11-01', 'HV', 'a' * 64, 'now')

    def test_horse_outside_meeting_refused(self):
        payload = load('jkc_2026-11-01_HV.json')
        sheet = payload['data']['commonMeetings'][0]['foPools'][0]['resultSheet'][0]['result'][0]
        sheet['raIncidents'][0]['horseId'] = 'HK_2099_Z999'
        with self.assertRaises(ch.IdentityError):
            ch.parse_challenge(payload, 'JKC', '2026-11-01', 'HV', 'a' * 64, 'now')

    def test_unknown_odds_text_refused(self):
        payload = load('jkc_2026-11-01_HV.json')
        payload['data']['commonMeetings'][0]['foPools'][0]['selections'][0]['currentOdds'] = 'abc'
        with self.assertRaises(ch.ParseMiss):
            ch.parse_challenge(payload, 'JKC', '2026-11-01', 'HV', 'a' * 64, 'now')

    def test_run_requires_fixture_date(self):
        with self.assertRaises(ch.IdentityError):
            ch.run(Path('.'), None, '', '')

    def test_sql_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, kind in (('jkc_2026-11-01_HV.json', 'JKC'), ('tnc_2026-11-01_HV.json', 'TNC')):
                rows = ch.parse_challenge(load(name), kind, '2026-11-01', 'HV', 'a' * 64, 'now')
                for table, items in rows.items():
                    filename, columns = ch.FILES[table]
                    path = root / 'data' / 'official_raceday' / filename
                    ch.write_csv(path, columns, ch.read_csv(path, columns) + items)
            db = root / 'x.db'
            sql = ch.emit_sql(root)
            ch.apply_sql(db, sql)
            ch.apply_sql(db, sql)  # rerun replaces, never duplicates
            con = sqlite3.connect(db)
            self.assertEqual(con.execute('select count(*) from official_challenge_ride').fetchone()[0], 84)
            self.assertEqual(con.execute('select count(*) from official_challenge_pool').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
