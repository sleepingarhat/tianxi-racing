import copy
import gzip
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hkjc_raceday_pools as pl  # noqa: E402
from hkjc_raceday_companions import IdentityError, ParseMiss  # noqa: E402

FIX = Path(__file__).with_name('fixtures') / 'pools' / 'summary_2026-11-01.json.gz'
PAYLOAD = json.loads(gzip.decompress(FIX.read_bytes()).decode('utf-8'))
TODAY = date(2026, 11, 3)


def hv(payload):
    return next(m for m in payload['data']['commonMeetings'] if m['venueCode'] == 'HV')


class Parse(unittest.TestCase):
    def test_2026_11_01_happy_valley(self):
        out = pl.parse_pools(PAYLOAD, '2026-11-01', 'HV', 'a' * 64, 'now')
        self.assertEqual(len(out['pool_status']), 109)
        tt = [r for r in out['pool_status'] if r['odds_type'] == 'TT']
        self.assertEqual((tt[0]['race_nos'], tt[0]['jackpot_hkd'], tt[0]['estimated_dividend_hkd']), ('4,5,6', '4000000.00', '8000000'))
        fct10 = [r for r in out['pool_dividend'] if r['odds_type'] == 'FCT' and r['leg_no'] == 10]
        self.assertEqual([(r['win_comb'], r['dividend_hkd']) for r in fct10], [('5,4', '1943')])
        dt3 = [r for r in out['pool_dividend'] if r['odds_type'] == 'DT' and r['leg_no'] == 3]
        self.assertEqual(dt3[0]['dividend_hkd'], '786410')
        self.assertTrue(all(r['post_race_only'] == 1 for r in out['pool_dividend']))
        self.assertEqual([(r['instrument'], r['reading']) for r in out['track_probe']], [('penetrometer', '2.72')] * 2)

    def test_overseas_meeting_is_refused(self):
        with self.assertRaises(IdentityError):
            pl.parse_pools(PAYLOAD, '2026-11-01', 'ST', 'a' * 64, 'now')

    def test_bad_amount_fails_closed(self):
        bad = copy.deepcopy(PAYLOAD)
        hv(bad)['pmPools'][0]['dividends'][0]['div'] = '12a'
        with self.assertRaises(ParseMiss):
            pl.parse_pools(bad, '2026-11-01', 'HV', 'a' * 64, 'now')

    def test_leg_off_card_fails_closed(self):
        bad = copy.deepcopy(PAYLOAD)
        hv(bad)['pmPools'][0]['leg']['races'] = [10, 11]
        with self.assertRaises(ParseMiss):
            pl.parse_pools(bad, '2026-11-01', 'HV', 'a' * 64, 'now')

    def test_probe_from_another_day_is_refused(self):
        bad = copy.deepcopy(PAYLOAD)
        hv(bad)['penetrometerReadings'][0]['readingTime'] = '2026-10-20T08:00:00+08:00'
        with self.assertRaises(IdentityError):
            pl.parse_pools(bad, '2026-11-01', 'HV', 'a' * 64, 'now')


class Store(unittest.TestCase):
    def test_official_dividend_cannot_change_and_refusal_writes_nothing(self):
        root = Path(tempfile.mkdtemp())
        pl.run(root, '2026-11-01', 'HV', TODAY, PAYLOAD, 'a' * 64)
        path = root / 'data' / 'official_raceday' / 'pool_dividend.csv'
        before = path.read_bytes()
        bad = copy.deepcopy(PAYLOAD)
        fct = next(p for p in hv(bad)['pmPools'] if p['oddsType'] == 'FCT')
        fct['dividends'][0]['div'] = '1'
        with self.assertRaises(IdentityError):
            pl.run(root, '2026-11-01', 'HV', TODAY, bad, 'b' * 64)
        self.assertEqual(path.read_bytes(), before)
        missing = copy.deepcopy(PAYLOAD)
        next(p for p in hv(missing)['pmPools'] if p['oddsType'] == 'FCT')['dividends'] = []
        with self.assertRaises(IdentityError):
            pl.run(root, '2026-11-01', 'HV', TODAY, missing, 'c' * 64)

    def test_rerun_is_stable_and_sql_applies(self):
        root = Path(tempfile.mkdtemp())
        pl.run(root, '2026-11-01', 'HV', TODAY, PAYLOAD, 'a' * 64)
        pl.run(root, '2026-11-01', 'HV', TODAY, PAYLOAD, 'a' * 64)
        db = root / 't.db'
        pl.apply_sql(db, pl.emit_sql(root))
        pl.apply_sql(db, pl.emit_sql(root))
        con = sqlite3.connect(db)
        self.assertEqual(con.execute('SELECT COUNT(*) FROM official_pool_status').fetchone()[0], 109)
        self.assertEqual(con.execute("SELECT dividend_hkd FROM official_pool_dividend WHERE odds_type='TT'").fetchone()[0],
                         next(r for r in pl.parse_pools(PAYLOAD, '2026-11-01', 'HV', 'x', 'y')['pool_dividend'] if r['odds_type'] == 'TT')['dividend_hkd'])
        manifest = (root / 'data' / 'official_raceday' / 'manifest.jsonl').read_text().splitlines()
        self.assertEqual(len(manifest), 2)

    def test_requires_explicit_meeting(self):
        with self.assertRaises(IdentityError):
            pl.run(Path(tempfile.mkdtemp()), '', '', TODAY, PAYLOAD, 'a' * 64)


if __name__ == '__main__':
    unittest.main()
