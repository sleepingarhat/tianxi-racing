import unittest
from datetime import datetime
from results_readiness import pending_until

class TimingTests(unittest.TestCase):
    def setUp(self):
        self.meeting = {'date':'2026-10-28','venue':'ST','totalRaces':9,'races':[
            {'raceNumber':n,'id':f'race_2026-10-28_ST_{n}','startTime':t} for n,t in enumerate(
            ['18:45','19:15','19:45','20:15','20:45','21:15','21:45','22:15','22:50'],1)]}
    def test_thirty_minutes_after_nine_races(self):
        self.assertEqual(pending_until(self.meeting,'2026-10-28',datetime.fromisoformat('2026-10-28T17:32:00+08:00')), datetime.fromisoformat('2026-10-28T23:20:00+08:00'))
        self.assertIsNone(pending_until(self.meeting,'2026-10-28',datetime.fromisoformat('2026-10-28T23:20:00+08:00')))
    def test_missing_time_never_suppresses(self):
        self.meeting['races'][0]['startTime'] = None
        self.assertIsNone(pending_until(self.meeting,'2026-10-28',datetime.fromisoformat('2026-10-28T17:32:00+08:00')))
    def test_wrong_identity_never_suppresses(self):
        self.meeting['venue']='HV'
        self.assertIsNone(pending_until(self.meeting,'2026-10-28',datetime.fromisoformat('2026-10-28T17:32:00+08:00')))
    def test_historical_gaps_remain(self):
        self.assertIsNone(pending_until(self.meeting,'2026-10-28',datetime.fromisoformat('2026-10-29T00:00:00+08:00')))
if __name__=='__main__': unittest.main()
