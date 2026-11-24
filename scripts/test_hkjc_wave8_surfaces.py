#!/usr/bin/env python3
"""Parsers for the official surfaces still partial after wave 7."""
import unittest

from hkjc_wave8_surfaces import (
    DateMismatch, IdentityError, ParseMiss, parse_directory, parse_person_season, parse_results_all,
    parse_same_sire, parse_wind_meeting, parse_wind_weather, parse_winstat,
)

SCRAPED = '2026-11-24T16:00:00+00:00'
DIGEST = 'abc'


def results_html(date_text='08/11/2026', horse_no='5', dividend_tail=''):
    return f'''
    <span class="f_fl">賽事日期: {date_text}</span>
    <table class="js_racecard"><tr><td><span>沙田:</span></td>
      <td><a href="/localresults?RaceNo=1">1</a></td></tr></table>
    <div class="result_content">
      <div class="bg_green">第 1 場</div>
      <table class="result"><tbody>
        <tr><td>1</td><td>{horse_no}</td><td>竣誠駒</td><td>袁幸堯</td><td>告東尼</td><td>126</td><td>2</td></tr>
      </tbody></table>
      <table class="dividends"><tbody>
        <tr><td>彩池</td><td>勝出組合</td><td>派彩 (HK$)</td></tr>
        <tr><td rowspan="2">位置</td><td>5</td><td>14.00</td></tr>
        <tr><td>2</td><td>1,234.50</td></tr>
        {dividend_tail}
      </tbody></table>
    </div>
    '''


class Wave8Tests(unittest.TestCase):
    def test_results_keep_the_condensed_row_and_carried_pool(self):
        parsed = parse_results_all(results_html(), '2026-11-08', DIGEST, SCRAPED)
        runner = parsed['results_all_runner'][0]
        self.assertEqual(runner['horse_name'], '竣誠駒')
        self.assertEqual(runner['venue'], 'ST')
        self.assertEqual(runner['actual_weight'], 126)
        self.assertEqual(runner['not_race_result'], 1)
        dividends = parsed['results_all_dividend']
        self.assertEqual(dividends[1]['pool_name'], '位置')
        self.assertEqual(dividends[1]['dividend_text'], '1234.50')

    def test_results_date_must_match_the_heading(self):
        with self.assertRaises(DateMismatch):
            parse_results_all(results_html('22/11/2026'), '2026-11-08', DIGEST, SCRAPED)

    def test_cancelled_race_keeps_refund_dividends_without_inventing_runners(self):
        html = '''
        <span>賽事日期: 14/11/2026</span>
        <table class="js_racecard"><tr><td><span>沙田:</span></td>
          <td><a href="/localresults?Racecourse=ST&RaceNo=1">1</a></td></tr></table>
        <div class="margin_top15"><div class="bg_blue">第 1 場</div>
          <p>此場賽事宣佈無效。</p>
          <table class="dividends"><tbody>
            <tr><td>獨贏</td><td>-</td><td>退款</td></tr>
          </tbody></table>
        </div>
        '''
        parsed = parse_results_all(html, '2026-11-14', DIGEST, SCRAPED)
        self.assertEqual(parsed['results_all_runner'], [])
        self.assertEqual(parsed['results_all_dividend'][0]['dividend_text'], '退款')
        self.assertEqual(parsed['results_all_dividend'][0]['combination'], '-')

    def test_simulcast_is_not_stored_as_sha_tin(self):
        html = results_html().replace('沙田:', 'S2 日本:').replace('localresults?RaceNo=1', 'localresults?Racecourse=S2&RaceNo=1')
        parsed = parse_results_all(html, '2026-11-08', DIGEST, SCRAPED)
        self.assertEqual(parsed['results_all_runner'][0]['venue'], 'S2')
        self.assertEqual(parsed['results_all_runner'][0]['section'], 'simulcast')

    def test_same_sire_keeps_retired_names_and_blank_distance(self):
        html = '''
        <div class="htable_text"><b>同父系馬賽績紀錄 - Zoustar</b></div>
        <select id="ddlSelect"><option value="All" selected="selected">顯示全部</option></select>
        <table class="samesire"><thead><tr><th></th><th>冠</th><th>亞</th><th>季</th><th>出賽</th><th>曾勝路程</th></tr></thead>
        <tbody>
          <tr><td>手機錶霸</td><td>7</td><td>6</td><td>6</td><td>32</td><td>1400米-1600米</td></tr>
          <tr><td>好友精神 (已退役)</td><td>0</td><td>0</td><td>0</td><td>13</td><td>-</td></tr>
        </tbody></table>
        '''
        page, rows = parse_same_sire(html, 'Zoustar', DIGEST, SCRAPED)
        self.assertEqual(page['horse_count'], 2)
        self.assertEqual(rows[1]['retired'], 1)
        self.assertEqual(rows[1]['horse_name'], '好友精神 (已退役)')
        self.assertIsNone(rows[1]['winning_distance'])
        self.assertEqual(rows[0]['winning_distance'], '1400米-1600米')

    def test_same_sire_with_no_other_horses_is_an_empty_table(self):
        html = '''
        <div class="htable_text">同父系馬賽績紀錄 - A Shin Forward</div>
        <div>沒有其他同父系馬</div>
        '''
        page, rows = parse_same_sire(html, 'A Shin Forward', DIGEST, SCRAPED)
        self.assertEqual(page['horse_count'], 0)
        self.assertEqual(rows, [])

    def test_same_sire_top_ten_is_not_the_full_table(self):
        html = '''
        <div class="htable_text">同父系馬賽績紀錄 - Zoustar</div>
        <select id="ddlSelect"><option value="Top10" selected="selected">顯示首十名</option></select>
        <table class="samesire"><thead><tr><th></th><th>冠</th><th>亞</th><th>季</th><th>出賽</th><th>曾勝路程</th></tr></thead>
        <tbody><tr><td>手機錶霸</td><td>7</td><td>6</td><td>6</td><td>32</td><td>1400米</td></tr></tbody></table>
        '''
        with self.assertRaises(ParseMiss):
            parse_same_sire(html, 'Zoustar', DIGEST, SCRAPED)

    def test_directory_rating_and_stable_count(self):
        html = '''
        <table class="bigborder"><tr><td>以練馬師分類 - 大衛希斯 (總數: 1)</td></tr>
        <tr><td><table><tr>
          <td><a href="/horse?horseid=HK_2023_J062">嘉應高昇</a></td><td>(145)</td>
        </tr></table></td></tr></table>
        '''
        _title, rows = parse_directory(html, 'stable', 'HDA', '大衛希斯', DIGEST, SCRAPED)
        self.assertEqual(rows[0]['horse_id'], 'HK_2023_J062')
        self.assertEqual(rows[0]['rating'], 145)
        self.assertEqual(rows[0]['list_key'], 'HDA')

    def test_profile_and_winstat_copy_the_official_numbers(self):
        profile = '''
        <table><tr><td>希威森</td></tr></table>
        <table>
          <tr><td>26/27 馬季 截至賽事日: 22/11/2026</td></tr>
          <tr><td>國籍</td><td>: 南非</td><td>冠</td><td>: 1</td><td>總出賽次數</td><td>: 2</td></tr>
          <tr><td>所贏獎金</td><td>: $5,422,000</td><td>亞</td><td>: 1</td><td>勝出率</td><td>: 50.00%</td></tr>
          <tr><td>過去10個賽馬日獲勝次數</td><td>: 0</td><td>季</td><td>: 0</td></tr>
          <tr><td>殿</td><td>: 0</td></tr>
        </table>
        '''
        season = parse_person_season(profile, 'jockey', 'HEL', DIGEST, SCRAPED)
        self.assertEqual(season['person_name'], '希威森')
        self.assertEqual(season['nationality'], '南非')
        self.assertEqual(season['stakes_hkd'], 5422000)
        self.assertEqual(season['as_of_date'], '2026-11-22')
        self.assertEqual(season['win_rate'], '50.00%')
        grid = '''
        <p class="tit">希威森</p>
        <table>
          <tr><td>26/27 馬季 截至賽事日: 22/11/2026</td></tr>
          <tr><td>國籍</td><td>: 南非</td><td>冠</td><td>: 1</td></tr>
          <tr><td>所贏獎金</td><td>: $ 5,422,000</td><td>亞</td><td>: 1</td></tr>
          <tr><td>過去10個賽馬日 獲勝次數</td><td>: 0</td><td>季</td><td>: 0</td></tr>
          <tr><td>殿</td><td>: 0</td></tr>
          <tr><td>總出賽次數</td><td>: 2</td></tr>
          <tr><td>勝出率</td><td>: 50.00%</td></tr>
        </table>
        <table><tr><td></td><td></td><td>途程</td><td>冠</td><td>亞</td><td>季</td><td>總出賽次數</td></tr>
          <tr><td colspan="2">跑馬地</td><td>1200</td><td>1</td><td>0</td><td>0</td><td>1</td></tr>
          <tr><td>沙田</td><td>草地跑道</td><td>1400</td><td>0</td><td>1</td><td>0</td><td>1</td></tr>
          <tr><td>合計</td><td>1</td><td>1</td><td>0</td><td>2</td></tr>
        </table>
        '''
        _season, lines = parse_winstat(grid, 'jockey', 'HEL', DIGEST, SCRAPED)
        self.assertEqual(lines[0]['venue_code'], 'HV')
        self.assertIsNone(lines[0]['surface_code'])
        self.assertEqual(lines[1]['surface_code'], 'turf')
        self.assertEqual(sum(row['starts'] for row in lines), 2)

    def test_penetrometer_dash_stays_blank_and_going_is_not_the_reading(self):
        payload = {'data': {'commonMeetings': [{
            'date': '2026-11-25', 'venueCode': 'HV', 'status': 'DEFINED', 'totalNumberOfRace': 1,
            'meetingTrack_ch': '草地',
            'races': [{'no': 1, 'go_ch': '好地', 'raceTrack': {'code': 'TURF'}}],
            'penetrometerReadings': [{'sequenceNumber': 1, 'readingTime': '2026-11-25 12:00', 'reading': '--'}],
            'hammerReadings': [],
        }]}}
        parsed = parse_wind_meeting(payload, DIGEST, SCRAPED)
        self.assertEqual(parsed['wind_going'][0]['going_ch'], '好地')
        self.assertIsNone(parsed['wind_probe'][0]['reading'])
        self.assertEqual(parsed['wind_probe'][0]['instrument'], 'penetrometer')

    def test_wind_station_keeps_official_text(self):
        payload = {'data': {'weather': [{
            'racecourse': 'HV',
            'weatherStation': {
                'location': 'E', 'date': '2026-11-25', 'time': '00:02:58.7',
                'avgCorrectedWindDirection': 'S14W', 'avgCorrectedWindSpeed': '4',
                'correctedGustDirection': 'S6W', 'correctedGustSpeed': '6',
                'relativeHumidity': '70', 'temperature': '22.5',
                'rainFallPrecipitation1Min': '0', 'rainPrecipitationDailyTotal': '--',
                'soilVolumeticWaterContent': '12.5', 'soilMoistureLossDailyTotal': None,
                'status': 'GPSNotification', 'isValid': True,
            },
            'sectional': [{
                'location': 'A', 'date': '2026-11-25', 'time': '00:04:22.2',
                'avgCorrectedWindDirection': 'S', 'avgCorrectedWindSpeed': '4',
                'correctedGustDirection': 'S', 'correctedGustSpeed': '6',
                'status': 'GPSNotification', 'isValid': True,
            }],
        }]}}
        parsed = parse_wind_weather(payload, DIGEST, SCRAPED)
        station = parsed['wind_station'][0]
        self.assertEqual(station['racecourse'], 'HV')
        self.assertEqual(station['wind_direction'], 'S14W')
        self.assertEqual(station['temperature'], '22.5')
        self.assertIsNone(station['rain_daily'])
        self.assertEqual(parsed['wind_section'][0]['location'], 'A')

    def test_wrong_sire_heading_is_rejected(self):
        html = '''
        <div class="htable_text">同父系馬賽績紀錄 - Other</div>
        <select id="ddlSelect"><option value="All" selected="selected">全部</option></select>
        <table class="samesire"><thead><tr><th></th><th>冠</th><th>亞</th><th>季</th><th>出賽</th><th>曾勝路程</th></tr></thead>
        <tbody></tbody></table>
        '''
        with self.assertRaises(IdentityError):
            parse_same_sire(html, 'Zoustar', DIGEST, SCRAPED)


if __name__ == '__main__':
    unittest.main()
