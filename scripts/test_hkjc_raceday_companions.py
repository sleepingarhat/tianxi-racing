import importlib.util
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location('companions', Path(__file__).with_name('hkjc_raceday_companions.py'))
companions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(companions)

TODAY = date(2026, 10, 27)
SCRAPED = '2026-10-27T05:00:00+00:00'


def shell(body: str, race: int = 1, track: str = '全天候跑道, 1650米, 好地') -> bytes:
    tabs = ''.join(
        f'<td><img src="//racing.hkjc.com/racing/info/StaticFile/Images/Racing/racecard_rt_{race}_o.gif"/></td>'
        if number == race else
        f'<td><a href="?racedate=2026/10/28&amp;Racecourse=ST&amp;RaceNo={number}">'
        f'<img src="//racing.hkjc.com/racing/info/StaticFile/Images/Racing/racecard_rt_{number}.gif"/></a></td>'
        for number in range(1, 3)
    )
    html = f'''
    <div class="date_title"><a class="blueBtn1">10月28日 - 沙田</a></div>
    <div class="racingNum"><table class="js_racecard"><tr>{tabs}</tr></table></div>
    <div class="f_fs13 margin_top10">第 {race} 場 - 畫眉山讓賽<br/>2026年10月28日, 星期三, 沙田, 18:45<br/>{track}<br/>獎金: $875,000, 評分: 40-0, 第五班</div>
    {body}
    '''
    return html.encode()


def stat(code, wins, starts, ven='ALL', trk='ALL', seconds=1, thirds=0):
    return {
        'code': code, 'name_ch': '潘頓' if code == 'PZ' else '巫偉傑', 'name_en': 'Z Purton' if code == 'PZ' else 'W K Mo',
        'ssnStat': [{
            'ven': ven, 'trk': trk, 'numFirst': wins, 'numSecond': seconds, 'numThird': thirds,
            'numFourth': 0, 'numFifth': 0, 'numStarts': starts, 'stakeWon': '10', 'dist': 'ALL',
        }],
    }


class ReportTests(unittest.TestCase):
    def page(self, description='報告入面寫 01/01/2020，唔係今場。', link_date='2026/04/12', cell_date='12/04/2026'):
        body = f'''
        <table id="PastRacingIncidentExt">
          <tr><td>馬號</td><td>烙號</td><td>馬名</td><td>日期</td><td>場次</td><td>描述</td></tr>
          <tr>
            <td>1</td><td>L073</td><td><a href="/zh-hk/local/information/horse?horseid=HK_2025_L073">幸運勝利</a></td>
            <td>{cell_date}</td>
            <td><a href="/zh-hk/local/information/localresults?racedate={link_date}&amp;Racecourse=ST&amp;RaceNo=7">600</a></td>
            <td>{description}</td>
          </tr>
          <tr>
            <td>3</td><td>J508</td><td><a href="/zh-hk/local/information/horse?horseid=HK_2023_J508">光輝歲月</a></td>
            <td>04/10/2026</td>
            <td><a href="/zh-hk/local/information/localresults?racedate=2026/10/04&amp;Racecourse=ST&amp;RaceNo=1">68</a></td>
            <td>--</td>
          </tr>
        </table>
        '''
        return shell(body)

    def test_previous_run_date_stays_off_the_meeting(self):
        rows = companions.parse_report(self.page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        self.assertEqual(rows[0]['meeting_date'], '2026-10-28')
        self.assertEqual(rows[0]['previous_run_date'], '2026-04-12')
        self.assertEqual(rows[0]['previous_race_label'], '600')
        self.assertEqual(rows[0]['previous_race_no'], 7)
        self.assertEqual(rows[0]['previous_venue'], 'ST')
        self.assertIn('01/01/2020', rows[0]['description'])
        self.assertEqual(rows[0]['not_race_result'], 1)
        self.assertEqual(rows[0]['runner_section'], 'declared')
        self.assertEqual(rows[1]['description'], '--')
        self.assertNotEqual(rows[1]['previous_run_date'], rows[1]['meeting_date'])

    def test_standby_keeps_the_same_saddle_cloth_in_its_own_section(self):
        body = '''
        <table id="PastRacingIncidentExt">
          <tr><td>馬號</td><td>烙號</td><td>馬名</td><td>日期</td><td>場次</td><td>描述</td></tr>
          <tr>
            <td>1</td><td>L073</td><td><a href="/horse?horseid=HK_2025_L073">幸運勝利</a></td>
            <td>12/04/2026</td>
            <td><a href="/localresults?racedate=2026/04/12&amp;Racecourse=ST&amp;RaceNo=7">600</a></td>
            <td>正選報告</td>
          </tr>
          <tr><td colspan="6">後備馬匹</td></tr>
          <tr>
            <td>1</td><td>K532</td><td><a href="/horse?horseid=HK_2024_K532">勝在當下</a></td>
            <td>04/10/2026</td>
            <td><a href="/localresults?racedate=2026/10/04&amp;Racecourse=ST&amp;RaceNo=2">70</a></td>
            <td>後備報告</td>
          </tr>
        </table>
        '''
        rows = companions.parse_report(shell(body), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        self.assertEqual([(row['runner_section'], row['horse_no'], row['horse_code']) for row in rows], [
            ('declared', 1, 'L073'), ('standby', 1, 'K532'),
        ])
        self.assertEqual(rows[1]['previous_run_date'], '2026-10-04')

    def test_link_date_must_match_the_cell(self):
        with self.assertRaises(companions.IdentityError):
            companions.parse_report(self.page(link_date='2026/04/11'), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)

    def test_brand_must_match_the_horse_link(self):
        raw = self.page().replace(b'HK_2025_L073', b'HK_2025_L999')
        with self.assertRaises(companions.IdentityError):
            companions.parse_report(raw, '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)

    def test_requested_date_and_unparsed_track_fail(self):
        with self.assertRaises(companions.IdentityError):
            companions.parse_report(self.page(), '2026-10-25', 'ST', TODAY, 'abc', SCRAPED)
        broken = shell('<table id="PastRacingIncidentExt"></table>', track='全天候跑道, 好地')
        with self.assertRaises(companions.ParseMiss):
            companions.parse_report(broken, '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)


class FormlineTests(unittest.TestCase):
    def page(self):
        body = '''
        <table id="formlinelist">
          <tr class="bg_blue color_w font_wb">
            <td><a href="/zh-hk/local/information/localresults?racedate=2026/10/04&amp;Racecourse=ST&amp;RaceNo=1">04/10/2026 (68)</a></td>
            <td colspan="2">沙田</td><td colspan="2">1650米</td><td colspan="2">第五班</td>
            <td colspan="3"></td><td colspan="2">封地</td>
          </tr>
          <tr><td>馬名</td><td>負磅</td><td>評分</td><td>檔位</td><td>騎師</td><td>上賽騎師</td><td>名次</td><td>完成時間</td><td>距離</td><td>賠率</td><td>相對負磅差異</td><td>相對評分差異</td></tr>
          <tr>
            <td>一鹿歡騰</td><td>113(113)</td><td>25(23)</td><td>1(1)</td><td>黃寶妮</td><td>黃寶妮</td>
            <td>2/14</td><td>1.39.90</td><td>N</td><td>3.1</td><td></td><td></td>
          </tr>
          <tr>
            <td>光輝歲月</td><td>128(134)</td><td>35(37)</td><td>6(5)</td><td>周俊樂</td><td>霍宏聲</td>
            <td>6/14</td><td>1.40.80</td><td>4-1/4</td><td>6.8</td><td>+6</td><td>+4</td>
          </tr>
        </table>
        '''
        return shell(body)

    def test_prior_meeting_is_not_today_and_blank_diff_is_null(self):
        rows = companions.parse_formline(self.page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        self.assertEqual(rows[0]['meeting_date'], '2026-10-28')
        self.assertEqual(rows[0]['prior_date'], '2026-10-04')
        self.assertEqual(rows[0]['prior_race_label'], '68')
        self.assertEqual(rows[0]['prior_race_no'], 1)
        self.assertIsNone(rows[0]['prior_rail'])
        self.assertIsNone(rows[0]['weight_diff'])
        self.assertIsNone(rows[0]['rating_diff'])
        self.assertEqual(rows[0]['not_race_result'], 1)
        self.assertEqual(rows[1]['margin'], '4-1/4')
        self.assertEqual(rows[1]['weight_diff'], '+6')
        self.assertEqual(rows[1]['rating_diff'], '+4')
        self.assertNotEqual(rows[1]['weight_diff'], '0')


class ExceptionalTests(unittest.TestCase):
    def page(self):
        body = '''
        <table id="ExceptionList">
          <tr><td>馬號</td><td>馬名</td><td>蝕磅</td><td>分齡讓磅</td><td>配備</td><td>綁繫舌帶</td><td>上賽口銜鐵</td><td>今賽口銜鐵</td><td>評分</td><td>途程</td><td>上賽距今日數</td><td>轉投練馬師</td><td>從化回港日期</td></tr>
          <tr><td>01</td><td>幸運勝利</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td>199</td><td>YES</td><td>24/10/2026</td></tr>
          <tr><td>05</td><td>怡昌奇兵</td><td></td><td></td><td>XB-/B2</td><td></td><td></td><td></td><td></td><td>+450</td><td></td><td></td><td></td></tr>
          <tr><td>07</td><td>德心知遇</td><td></td><td></td><td>H-</td><td></td><td></td><td></td><td></td><td>-450</td><td>123</td><td></td><td>24/10/2026</td></tr>
          <tr><td>11</td><td>戰騎飛</td><td>2</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
        </table>
        '''
        return shell(body)

    def test_conghua_date_and_blanks_stay_on_the_horse(self):
        rows = companions.parse_exceptional(self.page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        first = rows[0]
        self.assertEqual(first['meeting_date'], '2026-10-28')
        self.assertEqual(first['conghua_return_date'], '2026-10-24')
        self.assertNotEqual(first['conghua_return_date'], first['meeting_date'])
        self.assertEqual(first['trainer_change'], 'YES')
        self.assertEqual(first['days_since'], 199)
        self.assertIsNone(first['gear'])
        self.assertIsNone(first['weight_loss'])
        self.assertEqual(rows[1]['gear'], 'XB-/B2')
        self.assertEqual(rows[1]['distance_change'], '+450')
        self.assertEqual(rows[2]['distance_change'], '-450')
        self.assertEqual(rows[2]['gear'], 'H-')
        self.assertEqual(rows[3]['weight_loss'], 2)
        self.assertTrue(all(row['not_race_result'] == 1 for row in rows))

    def test_non_numeric_weight_loss_fails(self):
        raw = self.page().replace('<td>2</td>'.encode(), '<td>兩磅</td>'.encode())
        with self.assertRaises(companions.ParseMiss):
            companions.parse_exceptional(raw, '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)


class VeterinaryTests(unittest.TestCase):
    def page(self):
        body = '''
        <table id="OVR1">
          <tr><td>馬號</td><td>馬名</td><td>日期</td><td>詳情</td><td>通過日期</td></tr>
          <tr><td>1</td><td><a href="/horse?horseid=HK_2025_L073">幸運勝利</a></td><td>12/04/2026</td><td>表現難以接受</td><td>15/05/2026</td></tr>
          <tr><td>3</td><td><a href="/horse?horseid=HK_2023_J508">光輝歲月</a></td><td>31/10/2024</td><td>右前腿不良於行</td><td>15/11/2024</td></tr>
          <tr><td></td><td></td><td>06/02/2025</td><td>左肩受傷</td><td></td></tr>
        </table>
        '''
        return shell(body)

    def test_continuation_keeps_the_horse_and_blank_pass_date(self):
        rows = companions.parse_veterinary(self.page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        self.assertEqual(rows[1]['horse_name'], '光輝歲月')
        self.assertEqual(rows[2]['horse_no'], 3)
        self.assertEqual(rows[2]['horse_id'], 'HK_2023_J508')
        self.assertEqual(rows[2]['injury_date'], '2025-02-06')
        self.assertNotEqual(rows[2]['injury_date'], rows[2]['meeting_date'])
        self.assertIsNone(rows[2]['passed_date'])
        self.assertEqual(rows[0]['passed_date'], '2026-05-15')


class TrackworkTests(unittest.TestCase):
    def page(self, gallop='<b>25/10:</b> 沙田 全天候 30.0 (54.1)'):
        body = f'''
        <table class="table_bd">
          <tr><td>編號</td><td>馬名/ 練馬師/ 6次近績</td><td>試閘</td><td>快操</td><td>踱步</td><td>游泳</td><td>馬匹 跑步機</td><td>馬匹水中 步行機</td><td>休歇</td><td>所有晨操紀錄</td></tr>
          <tr>
            <td>1</td>
            <td><a href="/horse?horseid=HK_2025_L073">幸運勝利</a><br/>
                <a href="/trainerprofile?trainerid=MWK">巫偉傑</a><br/><span>14/14/11/10/12</span></td>
            <td class="BarrierTrial"></td>
            <td class="Gallop">{gallop}</td>
            <td class="Trotting"><b>27/10:</b> 沙田 內圈</td>
            <td class="Swimming"></td>
            <td class="Treadmill"></td>
            <td class="AquaWalker"></td>
            <td class="Spelling"></td>
            <td><a href="/trackwork">詳情</a></td>
          </tr>
        </table>
        '''
        return shell(body)

    def test_lines_keep_the_meeting_and_the_work_date(self):
        rows = companions.parse_trackwork(self.page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        gallop = [row for row in rows if row['category'] == 'gallop']
        trot = [row for row in rows if row['category'] == 'trot']
        self.assertEqual(gallop[0]['meeting_date'], '2026-10-28')
        self.assertEqual(gallop[0]['work_date'], '2026-10-25')
        self.assertEqual(gallop[0]['horse_id'], 'HK_2025_L073')
        self.assertEqual(trot[0]['work_date'], '2026-10-27')
        self.assertEqual(gallop[0]['not_race_result'], 1)
        self.assertEqual(gallop[0]['runner_section'], 'declared')
        self.assertFalse(any(row['category'] == 'declared' for row in rows))

    def test_standby_table_and_nested_trial_date(self):
        body = '''
        <table class="table_bd">
          <tr><td>編號</td><td>馬名/ 練馬師/ 6次近績</td><td>試閘</td><td>快操</td><td>踱步</td><td>游泳</td><td>馬匹 跑步機</td><td>馬匹水中 步行機</td><td>休歇</td><td>所有晨操紀錄</td></tr>
          <tr>
            <td>1</td>
            <td><a href="/horse?horseid=HK_2025_L073">幸運勝利</a><br/>
                <a href="/trainerprofile?trainerid=MWK">巫偉傑</a><br/><span></span></td>
            <td class="BarrierTrial"></td><td class="Gallop"></td><td class="Trotting"></td>
            <td class="Swimming"></td><td class="Treadmill"></td><td class="AquaWalker"></td><td class="Spelling"></td>
            <td><a href="/trackwork">詳情</a></td>
          </tr>
        </table>
        <table>
          <tr><td colspan="10">後備馬匹</td></tr>
          <tr><td>編號</td><td>馬名/ 練馬師/ 6次近績</td><td>試閘</td><td>快操</td><td>踱步</td><td>游泳</td><td>馬匹 跑步機</td><td>馬匹水中 步行機</td><td>休歇</td><td>所有晨操紀錄</td></tr>
          <tr>
            <td>1</td>
            <td><a href="/horse?horseid=HK_2024_K532">勝在當下</a><br/>
                <a href="/trainerprofile?trainerid=LFC">羅富全</a><br/><span>6/12/9/9/4/2</span></td>
            <td class="BarrierTrial"><a href="/btresult"><b>15/10: 第2組</b> 1200 從化 全天候</a></td>
            <td class="Gallop"></td><td class="Trotting"></td><td class="Swimming"></td>
            <td class="Treadmill"></td><td class="AquaWalker"></td><td class="Spelling"></td>
            <td><a href="/trackwork">詳情</a></td>
          </tr>
        </table>
        '''
        rows = companions.parse_trackwork(shell(body), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        declared = [row for row in rows if row['runner_section'] == 'declared']
        standby = [row for row in rows if row['runner_section'] == 'standby']
        self.assertEqual(declared[0]['category'], 'declared')
        self.assertEqual(declared[0]['horse_no'], 1)
        self.assertIsNone(declared[0]['recent_form'])
        self.assertEqual(standby[0]['horse_no'], 1)
        self.assertEqual(standby[0]['horse_id'], 'HK_2024_K532')
        self.assertEqual(standby[0]['category'], 'trial')
        self.assertEqual(standby[0]['work_date'], '2026-10-15')
        self.assertIn('第2組', standby[0]['body_text'])

    def test_date_after_the_meeting_fails_and_december_rolls_back(self):
        with self.assertRaises(companions.ParseMiss):
            companions.parse_trackwork(self.page('<b>29/10:</b> 沙田'), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        rolled = companions.resolve_work_date(15, 12, date(2027, 1, 10))
        self.assertEqual(rolled, '2026-12-15')
        bare = self.page().replace(b'f_fs13 margin_top10', b'f_fs13')
        rows = companions.parse_trackwork(bare, '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        self.assertEqual(rows[0]['meeting_date'], '2026-10-28')


class RideTests(unittest.TestCase):
    def payload(self, wins=4, slice_wins=9):
        runner = {
            'horse': {'code': 'L073', 'name_ch': '幸運勝利', 'name_en': 'LUCKY SECRET', 'id': 'HK_2025_L073'},
            'jockey': {'name_en': 'Z Purton', 'name_ch': '潘頓', 'code': 'PZ'},
            'id': '20261028ST01L073', 'no': '1', 'winOdds': '99', 'status': 'Declared', 'trumpCard': False,
        }
        standby = {
            'horse': {'code': 'J218', 'name_ch': '添喜運', 'name_en': 'HAPPY', 'id': 'HK_2023_J218'},
            'jockey': {'name_en': 'W K Mo', 'name_ch': '巫偉傑', 'code': 'MWK'},
            'id': '20261028ST01J218', 'no': '2', 'winOdds': '', 'status': 'Standby', 'trumpCard': False,
        }
        return {'data': {
            'commonMeetings': [{
                'date': '2026-10-28', 'venueCode': 'ST', 'status': 'DEFINED',
                'races': [{
                    'no': 1, 'claCode': '5', 'distance': 1650, 'status': 'DECLARED',
                    'raceTrack': {'code': 'AWT', 'description_ch': '全天候跑道', 'description_en': 'ALL WEATHER TRACK'},
                    'runners': [runner, standby],
                }],
                'pmPools': [{
                    'leg': {'number': 1, 'races': [1]},
                    'oddsNodes': [
                        {'oddsValue': '5.3', 'combString': '01', 'hotFavourite': False},
                        {'oddsValue': '---', 'combString': '02', 'hotFavourite': False},
                    ],
                }],
                'changeHistories': [{
                    'type': '99', 'dueToPromotion': '0', 'raceNo': 1, 'runnerNo': 1, 'horseCode': 'L073',
                }],
            }, {
                'date': '2026-10-28', 'venueCode': 'S2', 'status': 'DEFINED', 'races': [],
            }],
            'jockeyStat': [
                stat('PZ', wins, 10),
                {'code': 'PZ', 'name_ch': '潘頓', 'name_en': 'Z Purton', 'ssnStat': []} if False else stat('MWK', 0, 3),
            ],
        }}

    def test_all_slice_is_not_summed_and_overseas_is_dropped(self):
        person = stat('PZ', 4, 10)
        person['ssnStat'].append({
            'ven': 'ST', 'trk': 'TURF', 'numFirst': 9, 'numSecond': 0, 'numThird': 0,
            'numFourth': 0, 'numFifth': 0, 'numStarts': 20, 'stakeWon': '1', 'dist': '1200',
        })
        payload = self.payload()
        payload['data']['jockeyStat'][0] = person
        rows = companions.parse_rides(payload, 'jockey', '2026-10-28', 'ST', 'abc', SCRAPED)
        purton = rows[0]
        self.assertEqual(purton['season_wins'], 4)
        self.assertNotEqual(purton['season_wins'], 13)
        self.assertEqual(purton['win_odds_text'], '5.3')
        self.assertEqual(purton['class_code'], '5')
        self.assertEqual(purton['track_label'], '全天候')
        self.assertEqual(purton['distance_m'], 1650)
        self.assertEqual(purton['jockey_changed'], 1)
        self.assertEqual(purton['runner_status'], 'Declared')
        self.assertIsNone(rows[1]['win_odds_text'])
        self.assertEqual(rows[1]['runner_status'], 'Standby')
        self.assertEqual(rows[1]['jockey_changed'], 0)
        self.assertTrue(all(row['venue'] == 'ST' for row in rows))
        self.assertTrue(all(row['not_race_result'] == 1 for row in rows))

    def test_unnumbered_standby_does_not_inherit_win_odds(self):
        payload = self.payload()
        standby = payload['data']['commonMeetings'][0]['races'][0]['runners'][1]
        standby['no'] = ''
        standby['jockey'] = {'name_en': '   ---', 'name_ch': '   ---', 'code': 'AAA'}
        payload['data']['jockeyStat'] = [payload['data']['jockeyStat'][0]]
        rows = companions.parse_rides(payload, 'jockey', '2026-10-28', 'ST', 'abc', SCRAPED)
        self.assertIsNone(rows[1]['horse_no'])
        self.assertIsNone(rows[1]['win_odds_text'])
        self.assertEqual(rows[1]['person_code'], 'AAA')
        self.assertEqual(rows[1]['person_name_ch'], '---')
        self.assertIsNone(rows[1]['season_wins'])
        self.assertEqual(rows[0]['win_odds_text'], '5.3')

    def test_runner_id_and_ambiguous_all_slice_fail(self):
        payload = self.payload()
        payload['data']['commonMeetings'][0]['races'][0]['runners'][0]['id'] = '20261025ST01L073'
        with self.assertRaises(companions.IdentityError):
            companions.parse_rides(payload, 'jockey', '2026-10-28', 'ST', 'abc', SCRAPED)
        payload = self.payload()
        payload['data']['jockeyStat'][0]['ssnStat'][0]['trk'] = 'TURF'
        with self.assertRaises(companions.IdentityError):
            companions.parse_rides(payload, 'jockey', '2026-10-28', 'ST', 'abc', SCRAPED)

    def test_queries_are_the_page_documents(self):
        queries = companions.load_queries()
        self.assertEqual(set(queries), {'rw_JockeysRides', 'rw_TrainersEntries', 'rw_Summary'})
        self.assertIn('pmPools(oddsTypes: [WIN])', queries['rw_JockeysRides'])
        self.assertNotIn('PLA', queries['rw_JockeysRides'])
        self.assertIn('jkSuspensions', queries['rw_Summary'])
        self.assertIn('penetrometerReadings', queries['rw_Summary'])


class SummaryTests(unittest.TestCase):
    def race(self, number, code='AWT', description='全天候跑道', going='好地', going_code='GD'):
        return {
            'no': number,
            'raceTrack': {'code': code, 'description_ch': description, 'description_en': description},
            'go_ch': going, 'go_en': 'GOOD', 'goCode': going_code, 'venueCode': 'ST',
        }

    def payload(self, races=None):
        return {'data': {'commonMeetings': [
            {
                'date': '2026-10-28', 'venueCode': 'S2', 'meetingTrack_ch': '日本', 'races': [self.race(1)],
                'pmPools': [{'oddsType': 'WIN', 'leg': {'number': 1, 'races': [1]}, 'sellStatus': 'START_SELL',
                             'jackpot': 100, 'dividends': [{'div': '99'}], 'estimatedDividend': 5}],
            },
            {
                'date': '2026-10-28', 'venueCode': 'ST', 'meetingTrack_ch': '全天候跑道', 'totalNumberOfRace': 2,
                'races': races or [self.race(1), self.race(2)],
                'pmPools': [{
                    'oddsType': 'DBL', 'leg': {'number': 1, 'races': [1, 2]}, 'sellStatus': 'START_SELL',
                    'jackpot': 880000, 'estimatedDividend': 12, 'dividends': [{'div': '40'}],
                }, {
                    'oddsType': 'SixUP', 'leg': {'number': 1, 'races': [1, 2, 3, 4, 5, 6]}, 'sellStatus': 'START_SELL',
                }],
                'foPools': [{'oddsType': 'JKC', 'instNo': '1', 'oddsTypeDes': {'chinese': '騎師王 {0}', 'english': 'JKC {0}'}}],
                'jkSuspensions': [{
                    'commencedOn': '2026-11-22+08:00', 'resumedOn': '2026-11-26+08:00', 'spsnTyp': 'Deferred',
                    'jockeyId': 'WPN', 'jockeyNms': [{'chinese': '黃寶妮', 'code': 'WPN', 'english': 'P N Wong'}],
                    'desc': {'chinese': '不小心策騎\n', 'english': 'Careless riding\n'},
                }],
                'stewards': [{
                    'name_ch': '郭子貽先生', 'name_en': 'Mr K C Y Kwok', 'sequenceNumber': 5,
                    'role': {'code': 'Stipendiary Steward', 'chinese': '受薪董事', 'english': 'Stipendiary Steward'},
                }, {
                    'name_ch': '陳錦榮先生', 'name_en': 'Mr C W Chan', 'sequenceNumber': 2,
                    'role': {'code': 'Racing Steward', 'chinese': '', 'english': 'Racing Steward'},
                }],
                'penetrometerReadings': [{'reading': 2.8, 'readingTime': '2026-10-28T08:00:00'}],
                'hammerReadings': [{'reading': 9, 'readingTime': '2026-10-28T08:00:00'}],
            },
        ]}}

    def test_sentence_pools_and_suspension_dates(self):
        stored = companions.parse_summary(self.payload(), '2026-10-28', 'ST', 'abc', SCRAPED)
        summary = stored['meeting_summary'][0]
        self.assertEqual(summary['going_sentence'], '沙田 - 全天候跑道、好地（第1,2場）')
        self.assertEqual(summary['not_race_result'], 1)
        self.assertNotIn('penetrometer', summary)
        pool = stored['meeting_pool']
        self.assertEqual(pool[0]['odds_type'], 'DBL')
        self.assertEqual(pool[0]['race_nos'], '1,2')
        self.assertIsNone(pool[0]['label_ch'])
        six = [row for row in pool if row['odds_type'] == 'SixUP']
        self.assertEqual(six[0]['race_nos'], '1,2,3,4,5,6')
        self.assertFalse(any('jackpot' in row or 'dividend' in row for row in pool))
        jkc = [row for row in pool if row['odds_type'] == 'JKC']
        self.assertEqual(jkc[0]['label_ch'], '騎師王 1')
        suspension = stored['jockey_suspension'][0]
        self.assertEqual(suspension['meeting_date'], '2026-10-28')
        self.assertEqual(suspension['commenced_on'], '2026-11-22')
        self.assertNotEqual(suspension['commenced_on'], suspension['meeting_date'])
        self.assertEqual(suspension['detail_ch'], '不小心策騎')
        self.assertEqual(stored['meeting_steward'][0]['role_ch'], '受薪董事')
        blank_role = [row for row in stored['meeting_steward'] if row['role_code'] == 'Racing Steward']
        self.assertIsNone(blank_role[0]['role_ch'])

    def test_mixed_going_and_partial_going(self):
        races = [self.race(1), self.race(2, 'TURF', '草地', '黏地', 'Y')]
        stored = companions.parse_summary(self.payload(races), '2026-10-28', 'ST', 'abc', SCRAPED)
        self.assertEqual(
            stored['meeting_summary'][0]['going_sentence'],
            '沙田 - [全天候]好地（第1場）；[草地]黏地（第2場）',
        )
        races[1]['go_ch'] = None
        races[1]['goCode'] = None
        with self.assertRaises(companions.ParseMiss):
            companions.parse_summary(self.payload(races), '2026-10-28', 'ST', 'abc', SCRAPED)


class SqlTests(unittest.TestCase):
    def test_roundtrip_keeps_nulls_and_replaces_the_meeting(self):
        report = companions.parse_report(ReportTests().page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        exceptional = companions.parse_exceptional(ExceptionalTests().page(), '2026-10-28', 'ST', TODAY, 'abc', SCRAPED)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            companions.store_surface(root, 'race_report_ext', report)
            companions.store_surface(root, 'exceptional_factor', exceptional)
            for name, (filename, columns) in companions.FILES.items():
                if name not in ('race_report_ext', 'exceptional_factor'):
                    companions.write_csv(root / 'data' / 'official_raceday' / filename, columns, [])
            sql = companions.emit_sql(root)
            self.assertIn('DELETE FROM official_race_report_ext', sql)
            self.assertNotIn('jackpot', sql)
            self.assertNotIn('penetrometer', sql)
            db = root / 'local.db'
            companions.apply_sql(db, sql)
            connection = sqlite3.connect(db)
            previous = connection.execute(
                'SELECT meeting_date, previous_run_date, description FROM official_race_report_ext WHERE horse_no = 1'
            ).fetchone()
            gear = connection.execute(
                'SELECT gear, conghua_return_date, weight_loss FROM official_exceptional_factor WHERE horse_no = 5'
            ).fetchone()
            connection.close()
            self.assertEqual(previous[0], '2026-10-28')
            self.assertEqual(previous[1], '2026-04-12')
            self.assertIn('01/01/2020', previous[2])
            self.assertEqual(gear[0], 'XB-/B2')
            self.assertIsNone(gear[1])
            self.assertIsNone(gear[2])


if __name__ == '__main__':
    unittest.main()
