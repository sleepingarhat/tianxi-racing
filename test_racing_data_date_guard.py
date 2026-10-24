"""Date-guard tests: HKJC fallback pages must never be stamped as the requested date."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('rds', Path(__file__).with_name('RacingData_Scraper.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class MeetDateGuardTests(unittest.TestCase):
    def test_heading_date_extracted(self):
        text = '賽事日期: 21/10/2026 \xa0\xa0 跑馬地\n第 1 場 (119)'
        self.assertEqual(module.extract_meet_date_text(text), '21/10/2026')

    def test_nav_strip_dates_ignored(self):
        # 導航條列出多個日期（包括目標日期），只有標題嘅先係頁面真正日期
        text = '09/10/2026 11/10/2026 25/10/2026\n賽事日期: 21/10/2026 \xa0 跑馬地'
        self.assertEqual(module.extract_meet_date_text(text), '21/10/2026')

    def test_fallback_page_mismatch_detected(self):
        # 2026-10-25 事件重現：要求25/10但頁面顯示21/10 → 唔准寫檔
        page_date = module.extract_meet_date_text('賽事日期: 21/10/2026 \xa0\xa0 跑馬地')
        self.assertNotEqual(page_date, '25/10/2026')

    def test_fullwidth_colon_accepted(self):
        self.assertEqual(module.extract_meet_date_text('賽事日期：25/10/2026 沙田'), '25/10/2026')

    def test_missing_heading_returns_none(self):
        self.assertIsNone(module.extract_meet_date_text(''))
        self.assertIsNone(module.extract_meet_date_text(None))
        self.assertIsNone(module.extract_meet_date_text('沒有相關資料。'))

    def test_pending_treated_as_no_write(self):
        # worker／單日流程必須將 pending 當跳過（唔當成功、唔當失敗中止）
        src = Path(__file__).with_name('RacingData_Scraper.py').read_text()
        self.assertIn('("skip", "norace", "pending")', src)
        self.assertIn('return "pending"', src)

if __name__ == '__main__':
    unittest.main()
