import unittest, tempfile
from unittest.mock import patch
from pathlib import Path
from datetime import date, datetime
from data_integrity_audit import audit_race_artefacts
class ArtefactTimingTests(unittest.TestCase):
    def test_only_verified_same_day_pending(self):
        with tempfile.TemporaryDirectory() as tmp, patch('data_integrity_audit._pending_deadline', return_value=datetime.fromisoformat('2026-10-28T23:20:00+08:00')):
            result = audit_race_artefacts(Path(tmp), {date(2025,9,24),date(2026,9,20),date(2026,10,28),date(2026,11,1)}, date(2026,10,28))
            self.assertEqual(result.expected,15)
            self.assertEqual(len(result.pending),5)
            self.assertEqual(len(result.missing),10)
            self.assertEqual(result.severity,'critical')
    def test_historical_missing_never_becomes_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = audit_race_artefacts(Path(tmp), {date(2025,9,24),date(2026,9,20)}, date(2026,10,28))
            self.assertEqual(len(result.missing),10)
            self.assertEqual(result.severity,'critical')
if __name__=='__main__': unittest.main()
