import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('incidents', Path(__file__).with_name('IncidentReport_Scraper.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def fixture(date='2026/10/21', venue='跑馬地', number='1', hid='HK_2024_K577', code='K577', note='賽後立即接受獸醫檢查，發現此駒流鼻血。'):
    return f'''<select id="selects"><option selected value="{date}">21/10/2026</option></select>
    <div>賽事日期: 21/10/2026 (星期三)</div><a href="/zh-hk/local/page/racing-course">{venue} - 草地B賽道</a>
    <div><p><span>第 1 場 (119)</span></p><table class="rirr"><thead><tr>
    {''.join('<td>'+h+'</td>' for h in ['名次','馬號','綵衣','馬名','檔位','騎師','競賽事件'])}</tr></thead><tbody><tr>
    <td>WV</td><td data-seq="13">{number}</td><td></td><td><a href="/horse?horseid={hid}">妙算強人</a> ({code})</td>
    <td>4</td><td>蔡明紹</td><td>{note}</td></tr></tbody></table></div>'''.encode()

class IncidentTests(unittest.TestCase):
    def parse(self, raw=None):
        return module.parse_report(raw or fixture(), '2026-10-21', 'HV', '2026-10-24T22:00:00+00:00', {1})

    def test_explicit_identity_and_veterinary_quote(self):
        row = self.parse()[0][0]
        self.assertEqual(row['horse_id'], 'HK_2024_K577')
        self.assertEqual(row['race_no'], 1)
        self.assertEqual(row['horse_no'], '1')
        self.assertEqual(row['veterinary_note'], '賽後立即接受獸醫檢查，發現此駒流鼻血。')

    def test_unknown_number_not_data_seq_slot(self):
        row = self.parse(fixture(number=''))[0][0]
        self.assertEqual(row['horse_no'], '')
        self.assertEqual(row['placing_raw'], 'WV')

    def test_normal_vet_not_invented_illness(self):
        note = '賽後立即接受獸醫檢查，並無發現任何明顯異常之處。'
        self.assertEqual(self.parse(fixture(note=note))[0][0]['veterinary_note'], note)

    def test_no_report_is_explicit_not_empty(self):
        row = self.parse(fixture(note='無特別報告。'))[0][0]
        self.assertEqual(row['incident_text'], '無特別報告。')
        self.assertEqual(row['veterinary_note'], '')

    def test_link_code_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            self.parse(fixture(code='K319'))

    def test_venue_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            self.parse(fixture(venue='沙田'))

    def test_future_fallback_not_report(self):
        with self.assertRaises(module.ReportUnavailable):
            module.parse_report(fixture(), '2026-10-25', 'ST', 'x')

    def test_report_heading_not_dropdown_only(self):
        with self.assertRaises(ValueError):
            self.parse(fixture().replace(b'21/10/2026 (', b'19/10/2026 ('))

    def test_partial_races_rejected(self):
        with self.assertRaises(ValueError):
            module.parse_report(fixture(), '2026-10-21', 'HV', 'x', {1,2})

    def test_append_versions_not_rewrite(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            module.archive(base, fixture(), '2026-10-21', 'HV', '2026-10-24T22:00:00+00:00', {1})
            original = (base/'manifest.jsonl').read_bytes()
            self.assertEqual(module.archive(base, fixture(), '2026-10-21', 'HV', '2026-10-24T22:01:00+00:00')['saved'], 0)
            output = module.archive(base, fixture(note='賽後接受獸醫檢查，發現心律不整。'), '2026-10-21', 'HV', '2026-10-24T22:02:00+00:00')
            self.assertTrue(output['narrative_changed'])
            self.assertTrue((base/'manifest.jsonl').read_bytes().startswith(original))
            self.assertEqual(len(module.read_manifest(base)), 2)

    def test_sha_corruption_blocks_read(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            module.archive(base, fixture(), '2026-10-21', 'HV', '2026-10-24T22:00:00+00:00')
            entry = module.read_manifest(base)[0]
            (base/entry['files'][0]['path']).write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                module.read_manifest(base)

    def test_same_race_and_later_capture_excluded(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            module.archive(base, fixture(), '2026-10-21', 'HV', '2026-10-24T22:00:00+00:00')
            self.assertEqual(module.research_as_of(base, 'HK_2024_K577', '2026-10-21', '2026-10-25T00:00:00Z'), [])
            self.assertEqual(module.research_as_of(base, 'HK_2024_K577', '2026-10-25', '2026-10-24T21:00:00Z'), [])
            self.assertEqual(len(module.research_as_of(base, 'HK_2024_K577', '2026-10-25', '2026-10-25T00:00:00Z')), 1)

    def test_additional_text_no_name_guess(self):
        rows, extra = self.parse(fixture() + '<h3>補充獸醫報告</h3><p>妙算強人須再檢驗。</p>'.encode())
        self.assertEqual(extra[0]['report_text'], '妙算強人須再檢驗。')
        self.assertEqual(extra[0]['horse_id'], '')

    def test_general_prior_race_addendum_not_current_identity(self):
        raw = fixture() + '<div class="other"><p>一般事項</p><div><p>十月十九日沙田賽事競賽事件報告增補</p><p>第十場（117）<br/>包裝戰仕受碰撞。</p></div></div>'.encode()
        rows, extra = self.parse(raw)
        self.assertEqual(extra[0]['horse_id'], '')
        self.assertEqual(extra[0]['identity_status'], 'unassigned_source_section')
        self.assertIn('第十場（117）', extra[0]['report_text'])
        self.assertEqual(len(rows), 1)

    def test_navigation_course_link_not_venue(self):
        rows, extra = self.parse(fixture() + '<a href="/zh-hk/local/page/racing-course">跑道資料</a>'.encode())
        self.assertEqual(rows[0]['venue'], 'HV')

    def test_official_unavailable_not_no_incidents(self):
        with self.assertRaises(module.ReportUnavailable):
            self.parse('<html>沒有相關資料。</html>'.encode())

    def test_empty_page_is_failure_not_pending(self):
        with self.assertRaises(ValueError) as ctx:
            self.parse(b'<html></html>')
        self.assertNotIsInstance(ctx.exception, module.ReportUnavailable)

if __name__ == '__main__':
    unittest.main()