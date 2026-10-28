import unittest, tempfile, os
from unittest.mock import patch
from datetime import datetime,date
from assert_results_candidates import candidate_days, main
class CandidateTests(unittest.TestCase):
    def test_daily_keeps_yesterday(self):
        with patch('assert_results_candidates.is_race_day',return_value=True):
            self.assertEqual(candidate_days('',datetime.fromisoformat('2026-10-28T18:00:00+08:00')),[date(2026,10,28),date(2026,10,27)])
    def test_today_pending_does_not_hide_yesterday(self):
        with patch('assert_results_candidates.candidate_days',return_value=[date(2026,10,28),date(2026,10,27)]), patch('assert_results_candidates.read_pending',side_effect=[datetime.fromisoformat('2026-10-28T23:20:00+08:00'),None]), tempfile.TemporaryDirectory() as tmp:
            old=os.getcwd()
            try:
                os.chdir(tmp)
                with self.assertRaisesRegex(RuntimeError,'2026-10-27'): main('')
            finally: os.chdir(old)
if __name__=='__main__': unittest.main()
