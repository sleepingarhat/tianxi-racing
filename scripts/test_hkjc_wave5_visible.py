#!/usr/bin/env python3
"""Identity rules for the visible official surfaces collected after the fixture wave."""
import csv
import json
import tempfile
import unittest
from pathlib import Path

from hkjc_wave5_visible import (
    IdentityError, ParseMiss, content_url, emit_sql, parse_combo_rows, parse_conghua_text,
    parse_odds, parse_ove_database, parse_ove_record, parse_ppo, unique_fixture,
)

SCRAPED = '2026-11-10T00:00:00+00:00'


def ove_html() -> bytes:
    return '''<table><tr><td>傷患紀錄 [過去12個月] (截至 2026年11月10日 星期二)</td></tr>
<tr><td>烙印編號</td><td>馬名</td><td>日期</td><td>詳情</td><td>通過日期</td></tr>
<tr><td>D241</td><td>香港精神</td><td>19/01/2026</td><td>食慾不振</td><td>03/02/2026</td></tr>
<tr><td></td><td></td><td>11/08/2026</td><td>於季終時年屆八歲或以上</td><td>-</td></tr>
<tr><td>M222</td><td></td><td>02/10/2026</td><td>一對前腿跗關節骨及韌帶受傷</td><td>-</td></tr>
</table>'''.encode()


def record_html() -> bytes:
    return '''<a class="blueBtn1">11月11日 - 跑馬地</a>
<table class="list"><tr><td>2026年11月11日 星期三 宣佈出賽馬匹傷患紀錄</td></tr>
<tr><td></td></tr>
<tr><td>場次</td><td>馬號</td><td>馬名</td><td>烙印編號</td><td>日期</td><td>詳情</td><td>通過日期</td></tr>
<tr><td>第 1 場</td></tr>
<tr><td></td><td>1</td><td><a href="/horse?horseid=HK_2024_K308">電路一百</a></td><td>K308</td><td>01/10/2026</td><td>賽後內窺鏡檢查發現氣管內有大量血液</td><td>03/11/2026</td></tr>
<tr><td></td><td>後備 1</td><td>良駒好友</td><td>H454</td><td>11/10/2026</td><td>表現令人失望</td><td>29/10/2026</td></tr>
<tr><td></td><td></td><td></td><td></td><td>06/03/2026</td><td>接受喉部手術</td><td>-</td></tr>
</table>'''.encode()


def ppo_html() -> str:
    payload = '"dataList":' + json.dumps([{
        'name': '2026-2027',
        'enable': {'boolValue': True},
        'children': [{
            'brandNo': {'value': 'J313'}, 'hKName': {'value': ''},
            'formerName': {'value': 'Bear Champ (AUS) '}, 'notes': {'value': ''},
            'showPlayUrl': {'boolValue': False},
        }],
    }])
    return '<script>self.__next_f.push([1,' + json.dumps(payload) + '])</script>'


class Wave5Tests(unittest.TestCase):
    def test_injury_database_keeps_blank_name_and_continuation(self):
        rows = parse_ove_database(ove_html(), 'abc', SCRAPED)
        self.assertEqual(rows[0]['as_of_date'], '2026-11-10')
        self.assertEqual(rows[1]['horse_code'], 'D241')
        self.assertIsNone(rows[1]['passed_date'])
        self.assertIsNone(rows[2]['horse_name'])
        self.assertEqual(rows[2]['horse_code'], 'M222')
        self.assertEqual(rows[2]['not_race_result'], 1)

    def test_injury_database_rejects_a_wrong_weekday(self):
        raw = ove_html().replace('星期二'.encode(), '星期一'.encode())
        with self.assertRaises(IdentityError):
            parse_ove_database(raw, 'abc', SCRAPED)

    def test_declared_veterinary_rollup_keeps_reserve_and_follow_on_detail(self):
        root = Path(tempfile.mkdtemp())
        (root / 'data' / 'fixtures').mkdir(parents=True)
        with (root / 'data' / 'fixtures' / 'fixtures.csv').open('w', encoding='utf-8', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=['date', 'venue', 'race_count'])
            writer.writeheader()
            writer.writerow({'date': '2026-11-11', 'venue': 'HV', 'race_count': '9'})
        rows = parse_ove_record(record_html(), root, 'abc', SCRAPED)
        self.assertEqual(rows[0]['venue'], 'HV')
        self.assertEqual(rows[0]['horse_code'], 'K308')
        self.assertEqual(rows[1]['is_reserve'], 1)
        self.assertEqual(rows[2]['horse_code'], 'H454')
        self.assertEqual(rows[2]['injury_date'], '2026-03-06')
        self.assertIsNone(rows[2]['passed_date'])

    def test_pre_import_former_name_is_kept_verbatim_without_a_hong_kong_result(self):
        rows = parse_ppo(ppo_html(), 'abc', SCRAPED)
        self.assertEqual(rows[0]['former_name'], 'Bear Champ (AUS)')
        self.assertIsNone(rows[0]['horse_name_ch'])
        self.assertIsNone(rows[0]['notes'])
        self.assertEqual(rows[0]['not_race_result'], 1)

    def test_odds_chart_keeps_opening_price_dash_and_a_joint_winner(self):
        payload = {'data': {'UpdateTime': '08/11/2026 18:03', 'WinnerList': [
            {'MeetingDate': '08/11/2026', 'Venue': 'ST', 'Point': 40,
             'Winner': {'Id': 'AA', 'Name': '艾兆禮', 'Code': 'AA'},
             'OddsTrend': [{'RaceNo': 0, 'Odds': 3}, {'RaceNo': 1, 'Odds': 1.4}, {'RaceNo': 2, 'Odds': -1}, None]},
            {'MeetingDate': '04/10/2026', 'Venue': 'ST', 'Point': 30,
             'Winner': {'Id': 'LFC', 'Name': '羅富全', 'Code': 'LFC'},
             'OddsTrend': [{'RaceNo': 0, 'Odds': 11}]},
            {'MeetingDate': '04/10/2026', 'Venue': 'ST', 'Point': 30,
             'Winner': {'Id': 'CCW', 'Name': '鄭俊偉', 'Code': 'CCW'},
             'OddsTrend': [{'RaceNo': 0, 'Odds': 65}]},
        ]}}
        rows = parse_odds(payload, 'tnc', 'abc', SCRAPED)
        self.assertEqual([row['odds_text'] for row in rows[:3]], ['3.00', '1.40', '-'])
        self.assertEqual(rows[0]['race_no'], 0)
        self.assertEqual(len({row['winner_code'] for row in rows if row['meeting_date'] == '2026-10-04'}), 2)
        with self.assertRaises(ParseMiss):
            broken = json.loads(json.dumps(payload))
            broken['data']['WinnerList'][0]['OddsTrend'] = [{'RaceNo': 1, 'Odds': 3}]
            parse_odds(broken, 'jkc', 'abc', SCRAPED)

    def test_combo_workbook_follows_the_fixture_race_count(self):
        header = ['馬號', '勝出率 ', '上名率 ', '勝出率 ', '上名率 ']
        rows = [
            ['騎練配對成績 (2025/26- 8/11/2026)'],
            ['', '第一場', '', '第二場'],
            header,
            ['1', '0', '0.09', '7.0000000000000007E-2', '0.34'],
            ['最後更新 : 10/11/2026 12:00'],
            ['練馬師在港初出馬成績 (2025/26 - 8/11/2026)'],
            ['場次', '馬號', '馬名', '', '進口類別', '', '練馬師', '', '勝出率', '上名率'],
            ['2', '4', '翠湖烈風', '', '自購馬', '', '呂健威', '', '0.14', '0.14'],
            ['最後更新 : 10/11/2026 12:00'],
        ]
        parsed = parse_combo_rows(rows, '2026-11-11', 'HV', 2, 'abc', SCRAPED)
        combo = [row for row in parsed if row['section'] == 'combo']
        self.assertEqual(combo[0]['win_rate'], '0.0000')
        self.assertEqual(combo[1]['win_rate'], '0.0700')
        debut = [row for row in parsed if row['section'] == 'debut'][0]
        self.assertEqual(debut['horse_name'], '翠湖烈風')
        self.assertEqual(debut['not_race_result'], 1)
        with self.assertRaises(IdentityError):
            parse_combo_rows(rows, '2026-11-11', 'HV', 9, 'abc', SCRAPED)

    def test_conghua_text_uses_the_heading_date_and_does_not_invent_a_brand(self):
        text = '''二〇二六年十一月十一日星期三賽事
HORSES STABLED IN CONGHUA SINCE LAST START
WEDNESDAY 11 NOVEMBER 2026 RACE MEETING
1 1 電路一百 CIRCUIT CENTURY 08/10/2026 05/11/2026
 2 猶有心得 AMO ERGO SUM 19/10/2026 05/11/2026
 Standby 1 良駒好友 JOLLY COMPANION 14/10/2026 31/10/2026
'''
        rows = parse_conghua_text(text, '2026-11-11', 'HV', 9, 'abc', SCRAPED)
        self.assertEqual(rows[1]['race_no'], 1)
        self.assertEqual(rows[1]['horse_name_en'], 'AMO ERGO SUM')
        self.assertEqual(rows[2]['is_reserve'], 1)
        self.assertNotIn('horse_code', rows[0])
        with self.assertRaises(IdentityError):
            parse_conghua_text(text, '2026-11-08', 'ST', 11, 'abc', SCRAPED)

    def test_content_file_must_stay_on_the_official_host(self):
        flight = '"jTExcelFile":{"url":"https://example.com/file.xlsx"}'
        with self.assertRaises(IdentityError):
            content_url(flight, 'jTExcelFile', '.xlsx')

    def test_window_must_cover_one_local_fixture(self):
        root = Path(tempfile.mkdtemp())
        folder = root / 'data' / 'fixtures'
        folder.mkdir(parents=True)
        with (folder / 'fixtures.csv').open('w', encoding='utf-8', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=['date', 'venue', 'race_count'])
            writer.writeheader()
            writer.writerow({'date': '2026-11-11', 'venue': 'HV', 'race_count': '9'})
            writer.writerow({'date': '2026-11-11', 'venue': 'ST', 'race_count': '10'})
        with self.assertRaises(IdentityError):
            unique_fixture(root, 1794285000000, 1794416400000)

    def test_sql_replaces_the_rolling_board_and_keeps_blank_names_null(self):
        root = Path(tempfile.mkdtemp())
        target = root / 'data' / 'official_wave5'
        target.mkdir(parents=True)
        header = ','.join([
            'as_of_date', 'line_no', 'horse_code', 'horse_name', 'injury_date', 'detail', 'passed_date',
            'not_race_result', 'source_sha256', 'scraped_at',
        ])
        (target / 'ove_database.csv').write_text(
            header + '\n2026-11-10,1,M222,,2026-10-02,受傷,,1,abc,2026-11-10T00:00:00+00:00\n',
            encoding='utf-8',
        )
        sql = emit_sql(root)
        self.assertIn('DELETE FROM official_ove_database;', sql)
        self.assertIn('NULL', sql)
        self.assertNotIn("'M222','',", sql)


if __name__ == '__main__':
    unittest.main()
