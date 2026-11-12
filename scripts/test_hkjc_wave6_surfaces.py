#!/usr/bin/env python3
"""Identity rules for the official surfaces still out after wave 5."""
import csv
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from hkjc_wave6_surfaces import (
    FORMER_COLUMNS, IdentityError, ParseMiss, parse_finish_race, parse_former, parse_fwb,
    parse_special_index, season_code,
)

SCRAPED = '2026-11-10T00:00:00+00:00'


def former_payload():
    return {'data': {'horses': [{
        'id': 'HK_2024_K444', 'code': 'K444', 'name_en': 'AMAZING GAZE', 'name_ch': '凝妙星',
        'formerName': 'Wrote Amazingly', 'sire': 'Wrote', 'dam': 'Trissie', 'importType': 'PPG',
        'importTypeNm': {'english': 'PPG', 'chinese': '自購新馬', 'code': 'PPG'},
        'cntyOfOrg': {'code': 'NZ', 'chinese': '紐西蘭', 'english': 'NEW ZEALAND'},
        'age': '5', 'foalingDate': '2021-10-05+08:00',
    }, {
        'id': 'HK_2025_L100', 'code': 'L100', 'name_en': 'NEW NAME', 'name_ch': '',
        'formerName': '', 'sire': 'Sire', 'dam': 'Dam', 'importType': 'PP',
        'importTypeNm': {'english': 'PP', 'chinese': '自購馬', 'code': 'PP'},
        'cntyOfOrg': {'code': 'AUS', 'chinese': '澳洲', 'english': 'AUSTRALIA'},
        'age': '3', 'foalingDate': '2023-09-01+08:00',
    }]}}


def fwb_flight() -> str:
    value = (
        '11/11/2026\r\n'
        '07,8,MASK WARRIOR,假面勇士,L518,PP Bonus of HK$1.5M,「自購曾出賽馬匹特別獎金」一百五十萬港元\r\n'
        '08,STBY-2,JIN SHENG,金聖,L399,PP Bonus of HK$1.5M,「自購曾出賽馬匹特別獎金」一百五十萬港元\r\n'
    )
    return '"pP_PPG_and_ISG_Bonuses":{"value":' + json.dumps(value) + '}'


def photo_html(day='08/11/2026', venue='沙田', race='01', code='P3', season='26_27') -> str:
    path = f'//consvc.hkjc.com/-/media/Sites/JCRW/FinishPhotos/{season}/20261108/20261108R{race}_{code}.jpg'
    return f'''<span class="f_fl f_fs13">賽事日期: {day} &nbsp;&nbsp; {venue}</span>
<div class="finish_photos"><a href="//racing.hkjc.com/zh-hk/local/info/finishphoto?path={path}"></a></div>'''


def index_html(extra: str = '') -> str:
    rows = [
        ('DISQ', '取消資格'), ('DNF', '未有跑畢全程'), ('FE', '馬匹在賽事中跌倒'), ('ML', '多個馬位'),
        ('PU', '拉停'), ('TNP', '并無參賽競逐'), ('TO', '遙遙落後'), ('UR', '騎師墮馬'),
        ('VOID', '賽事無效'), ('WR', '司閘員著令退出'), ('WV', '因健康理由宣佈退出'),
        ('WV-A', '因健康理由於騎師過磅后宣佈退出'), ('WX', '競賽董事小組著令退出'),
        ('WX-A', '於騎師過磅後被競賽董事小組著令退出'), ('WXNR', '競賽董事小組著令退出，視作無出賽馬匹'),
    ]
    if extra:
        rows.append(('XX', extra))
    body = ''.join(f'<tr><td>{code}</td><td>{note}</td></tr>' for code, note in rows)
    return (
        '<table><tr><td>賽事特別情況索引</td></tr>'
        '<tr><td>英文縮寫</td><td>註釋</td></tr>' + body + '</table>\n16:next'
    )


class Wave6Tests(unittest.TestCase):
    def test_former_directory_keeps_a_blank_former_name(self):
        rows = parse_former(former_payload(), 'abc', SCRAPED, date(2026, 11, 10))
        self.assertEqual(rows[0]['horse_id'], 'HK_2024_K444')
        self.assertEqual(rows[0]['former_name'], 'Wrote Amazingly')
        self.assertEqual(rows[0]['foaling_date'], '2021-10-05')
        self.assertIsNone(rows[1]['former_name'])
        self.assertIsNone(rows[1]['name_ch'])
        self.assertEqual(rows[1]['not_race_result'], 1)

    def test_former_directory_rejects_a_brand_that_disagrees(self):
        payload = former_payload()
        payload['data']['horses'][0]['code'] = 'K445'
        with self.assertRaises(IdentityError):
            parse_former(payload, 'abc', SCRAPED, date(2026, 11, 10))

    def test_bonus_list_keeps_a_reserve_and_the_fixture_venue(self):
        root = Path(tempfile.mkdtemp())
        (root / 'data' / 'fixtures').mkdir(parents=True)
        with (root / 'data' / 'fixtures' / 'fixtures.csv').open('w', encoding='utf-8', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=['date', 'venue', 'race_count'])
            writer.writeheader()
            writer.writerow({'date': '2026-11-11', 'venue': 'HV', 'race_count': '9'})
        rows = parse_fwb(fwb_flight(), root, 'abc', SCRAPED)
        self.assertEqual(rows[0]['venue'], 'HV')
        self.assertEqual(rows[0]['race_no'], 7)
        self.assertEqual(rows[0]['horse_no'], 8)
        self.assertEqual(rows[0]['is_reserve'], 0)
        self.assertEqual(rows[1]['is_reserve'], 1)
        self.assertEqual(rows[1]['horse_no'], 2)
        self.assertEqual(rows[1]['brand_no'], 'L399')

    def _bonus_root(self, day='2026-11-11', venue='HV'):
        root = Path(tempfile.mkdtemp())
        (root / 'data' / 'fixtures').mkdir(parents=True)
        with (root / 'data' / 'fixtures' / 'fixtures.csv').open('w', encoding='utf-8', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=['date', 'venue', 'race_count'])
            writer.writeheader()
            writer.writerow({'date': day, 'venue': venue, 'race_count': '9'})
        return root

    def test_bonus_list_follows_a_flight_text_row(self):
        # 2026-11-12: Next.js moved the list into a "$2c" text row (2c:T<bytes>,...).
        value = (
            '11/11/2026\r\n'
            '07,8,MASK WARRIOR,假面勇士,L518,PP Bonus of HK$1.5M,「自購曾出賽馬匹特別獎金」一百五十萬港元\r\n'
        )
        size = format(len(value.encode('utf-8')), 'x')
        flight = f'1f:["$","div",null]\n2c:T{size},{value}2d:["$","p",null]\n' + '"pP_PPG_and_ISG_Bonuses":{"value":"$2c"}'
        rows = parse_fwb(flight, self._bonus_root(), 'abc', SCRAPED)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['brand_no'], 'L518')
        self.assertEqual(rows[0]['horse_name_ch'], '假面勇士')

    def test_bonus_list_reference_without_its_row_fails(self):
        flight = '"pP_PPG_and_ISG_Bonuses":{"value":"$2c"}'
        with self.assertRaises(ParseMiss):
            parse_fwb(flight, self._bonus_root(), 'abc', SCRAPED)

    def test_bonus_list_truncated_row_fails(self):
        flight = '2c:Tfff,11/11/2026\r\n' + '"pP_PPG_and_ISG_Bonuses":{"value":"$2c"}'
        with self.assertRaises(ParseMiss):
            parse_fwb(flight, self._bonus_root(), 'abc', SCRAPED)

    def test_finish_photo_path_must_match_the_results_heading(self):
        rows = parse_finish_race(photo_html(), '2026-11-08', 'ST', 1, 'abc', SCRAPED)
        self.assertEqual(rows[0]['photo_code'], 'P3')
        self.assertEqual(rows[0]['season_code'], '26_27')
        self.assertTrue(rows[0]['image_path'].startswith('https://consvc.hkjc.com/'))
        with self.assertRaises(IdentityError):
            parse_finish_race(photo_html(race='02'), '2026-11-08', 'ST', 1, 'abc', SCRAPED)
        self.assertIsNone(parse_finish_race(
            '<span>賽事日期: 08/11/2026 &nbsp;&nbsp; 沙田</span><div>no photos</div>',
            '2026-11-08', 'ST', 1, 'abc', SCRAPED,
        ))

    def test_finish_photo_season_follows_september(self):
        self.assertEqual(season_code(date(2026, 11, 8)), '26_27')
        self.assertEqual(season_code(date(2026, 1, 1)), '25_26')

    def test_special_index_requires_the_published_codes(self):
        rows = parse_special_index(index_html(), 'abc', SCRAPED)
        self.assertEqual(rows[0]['code'], 'DISQ')
        self.assertEqual(rows[-1]['code'], 'WXNR')
        self.assertEqual(rows[0]['not_race_result'], 1)
        broken = index_html().replace('<td>DISQ</td>', '<td>GONE</td>')
        with self.assertRaises(ParseMiss):
            parse_special_index(broken, 'abc', SCRAPED)

    def test_former_columns_stay_stable(self):
        self.assertIn('former_name', FORMER_COLUMNS)
        self.assertNotIn('source_sha256', FORMER_COLUMNS[:13])


if __name__ == '__main__':
    unittest.main()
