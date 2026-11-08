import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent / 'ci'))
import job_ticks  # noqa: E402

FIXTURES = """date,season_year,month,day,weekday,venue,timing,race_count,surface,captured_at
2026-11-01,2026,11,1,Sun,HV,day,10,turf,x
2026-11-04,2026,11,4,Wed,HV,night,9,turf,x
2026-11-08,2026,11,8,Sun,ST,day,11,mixed,x
"""


class MeetingAwareTickTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.fixtures = root / 'fixtures.csv'
        self.fixtures.write_text(FIXTURES, encoding='utf-8')
        self.ticks = root / 'ticks'
        self.ticks.mkdir()
        patches = [
            mock.patch.object(job_ticks, 'FIXTURE_CSV', self.fixtures),
            mock.patch.object(job_ticks, 'TICK_DIR', self.ticks),
            mock.patch.object(job_ticks, 'is_race_day_today', return_value=True),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, meeting, at='2026-11-05T15:32:01Z', status='ok'):
        (self.ticks / 'capy_race_daily.json').write_text(json.dumps(
            {'job': 'capy_race_daily', 'status': status, 'at': at, 'meta': {'date': meeting}}), encoding='utf-8')

    def run_check(self, now):
        with mock.patch.object(job_ticks, '_now', return_value=now):
            return job_ticks.check('capy_race_daily', 36, True)

    def test_race_day_after_gap_is_not_stale_when_previous_meeting_stored(self):
        # 2026-11-08 05:25 UTC: 59h since the Nov 4 results, yet no meeting was missed.
        self.write('2026-11-04')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 2, 25, tzinfo=timezone.utc)), 0)

    def test_missed_previous_meeting_still_fails(self):
        self.write('2026-11-01', at='2026-11-02T15:00:00Z')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 2, 25, tzinfo=timezone.utc)), 1)

    def test_failed_tick_and_missing_meeting_date_fail(self):
        self.write('2026-11-04', status='fail')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 2, 25, tzinfo=timezone.utc)), 1)
        self.write('')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 2, 25, tzinfo=timezone.utc)), 1)

    def test_day_after_meeting_requires_that_meeting(self):
        # 2026-11-09 07:25 HKT: Nov 8 is now the previous meeting.
        self.write('2026-11-04')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 23, 25, tzinfo=timezone.utc)), 1)
        self.write('2026-11-08', at='2026-11-08T15:40:00Z')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 23, 25, tzinfo=timezone.utc)), 0)

    def test_missing_fixtures_falls_back_to_age(self):
        self.fixtures.unlink()
        self.write('2026-11-04')
        self.assertEqual(self.run_check(datetime(2026, 11, 8, 2, 25, tzinfo=timezone.utc)), 1)


if __name__ == '__main__':
    unittest.main()
