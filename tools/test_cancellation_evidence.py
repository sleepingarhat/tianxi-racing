import unittest,tempfile, shutil
from pathlib import Path
from datetime import date
from data_integrity_audit import audit_race_artefacts
class CancellationTests(unittest.TestCase):
    def test_verified_cancelled_meetings_require_no_result_files(self):
        root=Path(__file__).resolve().parents[1]
        result=audit_race_artefacts(root,{date(2025,9,24),date(2026,9,20)},date(2026,10,27))
        self.assertEqual(result.expected,0)
        self.assertEqual(result.missing,[])
    def test_tampered_raw_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);shutil.copytree(Path(__file__).resolve().parents[1]/'data/cancellations',root/'data/cancellations')
            (root/'data/cancellations/2025-09-24.html').write_text('wrong notice')
            with self.assertRaisesRegex(ValueError,'SHA mismatch'): audit_race_artefacts(root,{date(2025,9,24)},date(2026,10,27))
if __name__=='__main__': unittest.main()
