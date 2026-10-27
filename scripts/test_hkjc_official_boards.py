import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location('boards', Path(__file__).with_name('hkjc_official_boards.py'))
boards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boards)

TODAY = date(2026, 10, 27)
SCRAPED = '2026-10-27T05:00:00+00:00'


def person(code, name_ch, name_en, status, slices, dh=None):
    return {
        'code': code, 'id': code, 'name_ch': name_ch, 'name_en': name_en, 'status': status,
        'isCurSsn': True, 'season': '26/27',
        'ssnStat': slices, 'dhStat': dh or [],
    }


def stat(ven, trk, wins, starts, stake, seconds=0, thirds=0, fourths=0, fifths=0):
    return {
        'ven': ven, 'trk': trk, 'numFirst': wins, 'numSecond': seconds, 'numThird': thirds,
        'numFourth': fourths, 'numFifth': fifths, 'numStarts': starts, 'stakeWon': str(stake),
    }


class RankingTests(unittest.TestCase):
    def payload(self):
        # Course slices are the official partition. ALL is the board total, not a sum we invent.
        purton = person('PZ', '潘頓', 'Z Purton', 'Active', [
            stat('ST', 'TURF', 2, 6, 60),
            stat('ALL', 'ALL', 4, 10, 100),
            stat('ST', 'TURF', 1, 2, 20),
            stat('HV', 'TURF', 1, 2, 20),
        ], [stat('ALL', 'ALL', 0, 0, 0)])
        other = person('AAA', '見習', 'A Apprentice', 'Apprentice', [
            stat('ALL', 'ALL', 1, 3, 30),
            stat('HV', 'TURF', 1, 3, 30),
        ])
        idle = person('ZZZ', '未出賽', 'Z Zero', 'Left', [stat('ALL', 'ALL', 0, 0, 0)])
        return {'data': {'jockeyStat': [purton, other, idle]}}

    def build(self, payload=None, scope='current', season='26/27', as_of='2026-10-25', kind='last_meeting'):
        return boards.build_rankings(payload or self.payload(), 'jockey', season, scope, as_of, kind, TODAY, 'abc', SCRAPED)

    def test_all_board_uses_official_total_and_course_filter_sums_slices(self):
        rows, slices = self.build()
        all_rows = [row for row in rows if row['racecourse'] == 'ALL' and row['person_code'] == 'PZ']
        self.assertEqual(len(all_rows), 1)
        self.assertEqual(all_rows[0]['wins'], 4)
        self.assertEqual(all_rows[0]['starts'], 10)
        self.assertEqual(all_rows[0]['stake_won'], 100)
        self.assertEqual(all_rows[0]['view_basis'], 'Numbers')
        self.assertEqual(all_rows[0]['as_of_date'], '2026-10-25')
        stt = [row for row in rows if row['racecourse'] == 'STT' and row['person_code'] == 'PZ']
        self.assertEqual(stt[0]['wins'], 3)
        self.assertEqual(stt[0]['starts'], 8)
        self.assertIsNone(stt[0]['stake_won'])
        self.assertEqual(boards.board_percentage(stt[0]['wins'], stt[0]['starts']), '38%')
        self.assertTrue(any(row['stat_set'] == 'ssn' and row['ven'] == 'ALL' for row in slices))
        self.assertFalse(any(row['racecourse'] == 'CHT' for row in rows))

    def test_percentage_matches_page_rounding_and_is_not_stored(self):
        self.assertEqual(boards.board_percentage(2, 3), '67%')
        self.assertEqual(boards.board_percentage(1, 6), '17%')
        self.assertEqual(boards.board_percentage(0, 0), '0%')
        rows, _ = self.build()
        self.assertTrue(all(row['view_basis'] == 'Numbers' for row in rows))

    def test_zero_start_person_stays_off_the_board(self):
        rows, slices = self.build()
        self.assertFalse(any(row['person_code'] == 'ZZZ' for row in rows))
        self.assertTrue(any(row['person_code'] == 'ZZZ' for row in slices))

    def test_service_and_other_sections_rank_separately(self):
        rows, _ = self.build()
        service = [row for row in rows if row['racecourse'] == 'ALL' and row['section'] == 'service']
        other = [row for row in rows if row['racecourse'] == 'ALL' and row['section'] == 'other']
        self.assertEqual([row['person_code'] for row in service], ['PZ'])
        self.assertEqual(other[0]['person_code'], 'AAA')
        self.assertEqual(service[0]['board_rank'], 1)
        self.assertEqual(other[0]['board_rank'], 1)

    def test_slices_that_do_not_add_up_are_rejected(self):
        broken = person('PZ', '潘頓', 'Z Purton', 'Active', [
            stat('ALL', 'ALL', 4, 10, 100),
            stat('ST', 'TURF', 1, 1, 10),
        ])
        with self.assertRaises(boards.IdentityError):
            self.build({'data': {'jockeyStat': [broken]}})

    def test_future_as_of_rejected(self):
        with self.assertRaises(boards.IdentityError):
            self.build(as_of='2026-10-28')

    def test_queries_are_the_page_operations(self):
        queries = boards.load_queries()
        self.assertNotIn('distance', queries['rw_GetJockeyRanking'])
        self.assertIn('jockeyStat(season: $season)', queries['rw_GetJockeyRanking'])
        self.assertIn('trainerStat(season: $season)', queries['rw_GetTrainerRanking'])
        self.assertIn('lastMeeting(venueCodes: $venueCodes)', queries['rw_LastMeeting'])


class DrawTests(unittest.TestCase):
    def page(self, date_text='28/10/2026', button='10月28日 - 沙田', course='全天候跑道', pending=False):
        races = ''
        if not pending:
            races = '''
            <div class="searchResult">
              <table class="table_bd"><thead>
                <tr id="race1"><td>第 1 場      1650米      {course}</td></tr>
                <tr><td>檔位</td><td>出賽次數</td><td>冠</td><td>亞</td><td>季</td><td>殿</td><td>勝出率%</td><td>入Q率%</td><td>上名率%</td><td>前4名率%</td></tr>
              </thead><tbody>
                <tr><td>1</td><td>69</td><td>6</td><td>9</td><td>5</td><td>8</td><td>9</td><td>22</td><td>29</td><td>41</td><td></td></tr>
                <tr><td>2</td><td>10</td><td>1</td><td>1</td><td>1</td><td>1</td><td>10</td><td>20</td><td>30</td><td>40</td><td></td></tr>
              </tbody><tfoot><tr><td>大熱門 :</td><td colspan="8">勝出率 23% 上名率 62% 前4名率 68%</td></tr></tfoot></table>
            </div>
            <table><tr><td>1.</td><td>檔位統計 ：三季來同一條跑道（欄杆位置）各途程分別統計各檔位出賽馬匹總數。</td></tr></table>
            '''.format(course=course)
        pending_line = '<p>檔位統計將於排位表上網後不久公佈。</p>' if pending else ''
        html = f'''<div class="Draw"><a class="blueBtn1">{button}</a>
            <table class="margin_top10"><tr><td class="f_fs13 font_wb">{date_text}<br/>沙田</td></tr></table>
            {pending_line}{races}</div>'''
        return html.encode()

    def test_historical_window_not_a_result(self):
        rows, favs = boards.parse_draw(self.page(), TODAY, 'drawsha', SCRAPED)
        self.assertEqual(rows[0]['meeting_date'], '2026-10-28')
        self.assertEqual(rows[0]['venue'], 'ST')
        self.assertEqual(rows[0]['course_label'], '全天候跑道')
        self.assertEqual(rows[0]['not_race_result'], 1)
        self.assertIn('三季來同一條跑道', rows[0]['stat_window'])
        self.assertEqual(favs[0]['win_pct'], 23)
        self.assertEqual(favs[0]['not_race_result'], 1)
        self.assertNotIn('finish', rows[0])

    def test_requested_date_mismatch_rejected(self):
        with self.assertRaises(boards.IdentityError):
            boards.parse_draw(self.page(), TODAY, 'x', SCRAPED, '2026-10-25', 'ST')

    def test_button_disagreement_rejected(self):
        with self.assertRaises(boards.IdentityError):
            boards.parse_draw(self.page(button='10月25日 - 跑馬地'), TODAY, 'x', SCRAPED)

    def test_unpublished_is_pending_not_an_empty_board(self):
        with self.assertRaises(boards.BoardPending):
            boards.parse_draw(self.page(pending=True), TODAY, 'x', SCRAPED)

    def test_unknown_course_rejected(self):
        with self.assertRaises(boards.IdentityError):
            boards.parse_draw(self.page(course='未知跑道'), TODAY, 'x', SCRAPED)


class PoolAndFavouriteTests(unittest.TestCase):
    def pool_html(self):
        dates = ['25/10', '21/10', '19/10', '14/10', '11/10', '7/10', '4/10', '1/10', '27/9', '23/9']
        head = ''.join(f'<td>{item}</td>' for item in dates) + '<td>今季</td><td>25/26 季度</td>'
        row = '<tr><td>1</td><td>田泰安</td>' + '<td>26</td><td>-</td>' + '<td>1</td>' * 8 + '<td>17.1</td><td></td><td>15.4</td><td>14.0</td></tr>'
        other = '<tr><td>14</td><td>其他騎師</td></tr><tr><td>巫顯東</td>' + '<td>0</td>' * 10 + '<td>0.0</td><td></td><td>0.8</td><td>1.6</td></tr>'
        return f'<table class="table_bd"><tr><td>編號</td><td>騎師</td></tr><tr><td></td><td>近十個賽事日積分（左為最近）</td></tr><tr>{head}</tr>{row}{other}</table>'.encode()

    def test_dash_is_not_zero_and_as_of_is_latest_column(self):
        rows = boards.parse_pool(self.pool_html(), 'jkc', TODAY, 'poolsha', SCRAPED)
        meetings = [row for row in rows if row['person_name'] == '田泰安' and row['kind'] == 'meeting']
        self.assertEqual(meetings[0]['as_of_date'], '2026-10-25')
        self.assertEqual(meetings[0]['meeting_date'], '2026-10-25')
        self.assertEqual(meetings[0]['points_text'], '26')
        dash = meetings[1]
        self.assertEqual(dash['points_text'], '-')
        self.assertIsNone(dash['points_value'])
        self.assertEqual(meetings[-1]['meeting_date'], '2026-09-23')
        other = [row for row in rows if row['person_name'] == '巫顯東' and row['kind'] == 'quarter_avg']
        self.assertEqual(other[0]['section'], 'other')
        self.assertIsNone(other[0]['rank_no'])
        self.assertEqual(other[0]['column_label'], '25/26 季度')

    def test_future_column_rejected(self):
        html = self.pool_html().replace(b'25/10', b'28/10')
        with self.assertRaises(boards.IdentityError):
            boards.parse_pool(html, 'jkc', TODAY, 'x', SCRAPED)

    def test_new_year_column_uses_previous_year(self):
        labels = ['02/01', '28/12', '20/12', '01/12', '20/11', '01/11', '20/10', '01/10', '20/09', '01/09']
        found = boards.resolve_recent_dates(labels, date(2026, 1, 5))
        self.assertEqual(found[0], '2026-01-02')
        self.assertEqual(found[1], '2025-12-28')

    def favourite(self, as_of='25/10/2026', footer='<tr><td colspan="10"> </td></tr><tr><td colspan="10">其他</td></tr><tr><td colspan="10"> --- </td></tr>'):
        return f'''<table class="table_bd"><tr><td>騎師大熱勝出及入位統計 (截至賽事日: {as_of})</td></tr>
            <tr><td>騎師</td><td>出賽次數</td><td>頭馬</td><td>位置</td><td>大熱</td><td>大熱%</td><td>大熱勝出</td><td>大熱勝出%</td><td>大熱入位</td><td>大熱入位%</td></tr>
            <tr><td>潘頓</td><td>118</td><td>26</td><td>61</td><td>42</td><td>36</td><td>15</td><td>36</td><td>26</td><td>62</td></tr>
            {footer}
            </table><table class="table_bd tb_botm"><tr><td>大熱馬匹總數</td><td>138</td></tr></table>'''.encode()

    def test_favourite_as_of(self):
        people, totals = boards.parse_favourite(self.favourite(), 'jockey', TODAY, 'fav', SCRAPED)
        self.assertEqual(people[0]['as_of_date'], '2026-10-25')
        self.assertEqual(people[0]['hot_wins'], 15)
        self.assertEqual(totals[0]['value_text'], '138')
        self.assertEqual([row['person_name'] for row in people], ['潘頓'])

    def test_favourite_other_footer_is_not_a_person(self):
        trainer = self.favourite(footer='<tr class="empty"><td colspan="10"></td></tr><tr><td colspan="10">其他</td></tr>')
        trainer = trainer.replace('騎師大熱'.encode(), '練馬師大熱'.encode()).replace(
            '出賽次數'.encode(), '出馬'.encode(), 1).replace('騎師'.encode(), '練馬師'.encode(), 1)
        people, _totals = boards.parse_favourite(trainer, 'trainer', TODAY, 'fav', SCRAPED)
        self.assertEqual([row['person_name'] for row in people], ['潘頓'])
        stray = self.favourite(footer='<tr><td>註</td><td>1</td></tr>')
        with self.assertRaises(boards.IdentityError):
            boards.parse_favourite(stray, 'jockey', TODAY, 'fav', SCRAPED)

    def test_allowance_blank_is_not_zero(self):
        html = '''<div>本地騎師讓磅</div><table class="table_bd">
            <tr><td>本地騎師讓磅</td><td>(截至賽事日:  25/10/2026)</td></tr>
            <tr><td>騎師</td><td>頭馬次數</td><td>現時讓磅</td></tr>
            <tr><td>何澤堯</td><td>661</td><td>--</td></tr>
            <tr><td>周俊樂</td><td>234</td><td>2 磅</td></tr>
            </table>'''.encode()
        rows = boards.parse_allowance(html, TODAY, 'allow', SCRAPED)
        self.assertIsNone(rows[0]['allowance_lb'])
        self.assertEqual(rows[0]['allowance_text'], '--')
        self.assertEqual(rows[1]['allowance_lb'], 2)
        self.assertEqual(rows[0]['as_of_date'], '2026-10-25')


class OwnerAndIntroTests(unittest.TestCase):
    def test_owner_echo_must_match_profile_verbatim(self):
        html = '''<table class="searchedData"><tr><td>共有2匹馬之馬主為"鄭穩偉、鄭芷欣與鄭芷晴"</td></tr>
            <tr><td><a href="/zh-hk/local/information/horse?horseid=HK_2024_K546">精益大將</a></td>
            <td><a href="/zh-hk/local/information/horse?horseid=HK_2022_H134">精益大師</a></td></tr></table>'''.encode()
        profiles = {'K546': '鄭穩偉、鄭芷欣與鄭芷晴'}
        rows = boards.parse_owner(html, '鄭穩偉、鄭芷欣與鄭芷晴', profiles, 'own', SCRAPED)
        self.assertEqual(rows[0]['owner_name'], '鄭穩偉、鄭芷欣與鄭芷晴')
        self.assertIn('與', rows[0]['owner_name'])
        self.assertEqual(rows[1]['horse_code'], 'H134')
        with self.assertRaises(boards.IdentityError):
            boards.parse_owner(html, '鄭穩偉', profiles, 'own', SCRAPED)
        with self.assertRaises(boards.IdentityError):
            boards.parse_owner(html, '鄭穩偉、鄭芷欣與鄭芷晴', {'K546': '另一個馬主'}, 'own', SCRAPED)

    def test_recycled_brand_is_not_the_current_profile_horse(self):
        html = '''<table class="searchedData"><tr><td>共有1匹馬之馬主為"劉漢鈞、黎榮、潘長風與李國麟"</td></tr>
            <tr><td><a href="/zh-hk/local/information/otherhorse?horseid=HK_2009_L003">多多寶馬</a></td></tr></table>'''.encode()
        profiles = {'L003': '譚智峯與潘子聰醫生'}
        names = {'L003': '俏眼光 (L003)'}
        rows = boards.parse_owner(html, '劉漢鈞、黎榮、潘長風與李國麟', profiles, 'own', SCRAPED, names)
        self.assertEqual(rows[0]['horse_id'], 'HK_2009_L003')
        self.assertEqual(rows[0]['owner_name'], '劉漢鈞、黎榮、潘長風與李國麟')
        same = html.replace('多多寶馬'.encode(), '俏眼光'.encode())
        with self.assertRaises(boards.IdentityError):
            boards.parse_owner(same, '劉漢鈞、黎榮、潘長風與李國麟', profiles, 'own', SCRAPED, names)

    def test_owner_count_mismatch_rejected(self):
        html = '''<table class="searchedData"><tr><td>共有2匹馬之馬主為"戴鈞安"</td></tr>
            <tr><td><a href="/horse?horseid=HK_2024_K417">機不可失</a></td></tr></table>'''.encode()
        with self.assertRaises(boards.IdentityError):
            boards.parse_owner(html, '戴鈞安', {}, 'own', SCRAPED)

    def intro_html(self):
        return '''<table><tr><td class="horse_name"><a href="/horse?HorseNo=L505">同心華駿(L505)</a></td></tr></table>
            <p>資料及評語(截至2026年10月26日)</p>
            <p>馬匹資料 : 出生地: 愛爾蘭 毛色: 棗 進口類別: 自購馬</p>
            <p>血統表: SUPREMACY 服役時頭馬數目: 3勝 出賽子嗣數目: 0匹</p>
            <p>評語及展望: 「同心華駿」在愛爾蘭出賽兩次獲一冠。長力可望扳至1800米。</p>'''

    def item(self):
        return {'meeting_date': '2026-10-28', 'brand': 'L505', 'horse_name': '同心華駿', 'race_no': '9', 'horse_no': '8', 'path': '/NewHorse/20261028/L505'}

    def test_intro_body_is_the_comment_not_pedigree_counts(self):
        row = boards.parse_new_horse_body(self.intro_html(), self.item(), TODAY, 'intro', SCRAPED)
        self.assertEqual(row['as_of_date'], '2026-10-26')
        self.assertIn('出賽兩次', row['body_text'])
        self.assertNotIn('服役時頭馬數目', row['body_text'])
        self.assertNotIn('出賽子嗣數目', row['body_text'])
        self.assertEqual(row['not_race_result'], 1)
        self.assertEqual(row['origin'], '愛爾蘭')
        self.assertEqual(row['import_type'], '自購馬')

    def test_intro_list_rejects_disagreement(self):
        payload = {'data': [{
            'name': '20261028', 'path': '/NewHorse/20261028', 'date': 1793116800000,
            'children': [{
                'path': '/NewHorse/20261028/L505', 'brandNo': {'value': 'L505'},
                'horseName': {'value': '同心華駿'}, 'raceNo': {'value': '9'}, 'horseNo': {'value': '8'},
                'raceDate': {'dateValue': 1793116800000},
            }],
        }]}
        payload['data'][0]['children'].append({
            'path': '/NewHorse/20261028/L506', 'brandNo': {'value': 'L506'},
            'horseName': {'value': '後備駒'}, 'raceNo': {'value': '9'}, 'horseNo': {'value': 'R2'},
            'raceDate': {'dateValue': 1793116800000},
        })
        meetings = boards.parse_new_horse_list(payload)
        chosen = boards.select_intro_meetings(meetings, TODAY, 14, 14, '2026-10-28')
        self.assertEqual(chosen[0]['horses'][0]['brand'], 'L505')
        self.assertEqual(chosen[0]['horses'][1]['horse_no'], 'R2')
        with self.assertRaises(boards.IdentityError):
            boards.select_intro_meetings(meetings, TODAY, 14, 14, '2026-10-25')
        payload['data'][0]['children'][0]['path'] = '/NewHorse/20261028/L999'
        mismatched = boards.parse_new_horse_list(payload)
        with self.assertRaises(boards.IdentityError):
            boards.select_intro_meetings(mismatched, TODAY, 14, 14, '2026-10-28')
        payload['data'][0]['children'][0]['path'] = '/NewHorse/20261025/L505'
        with self.assertRaises(boards.IdentityError):
            boards.parse_new_horse_list(payload)

    def test_sql_roundtrip_keeps_null_allowance_and_draw_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            draw_rows, favs = boards.parse_draw(DrawTests().page(), TODAY, 'drawsha', SCRAPED)
            allow = boards.parse_allowance(PoolAndFavouriteTests().favourite().replace(
                b'jockeyfavourite', b'x'), TODAY, 'allow', SCRAPED) if False else boards.parse_allowance(
                '''<div>本地騎師讓磅</div><table class="table_bd"><tr><td>本地騎師讓磅</td><td>(截至賽事日:  25/10/2026)</td></tr>
                <tr><td>騎師</td><td>頭馬次數</td><td>現時讓磅</td></tr>
                <tr><td>何澤堯</td><td>661</td><td>--</td></tr></table>'''.encode(), TODAY, 'allow', SCRAPED)
            boards.store_surface(root, 'draw_stat', draw_rows)
            boards.store_surface(root, 'draw_favourite', favs)
            boards.store_surface(root, 'jockey_allowance', allow)
            for name in boards.FILES:
                if name not in ('draw_stat', 'draw_favourite', 'jockey_allowance'):
                    filename, columns = boards.FILES[name]
                    boards.write_csv(root / 'data' / 'official_p2' / filename, columns, [])
            sql = boards.emit_sql(root)
            db = root / 'local.db'
            boards.apply_sql(db, sql)
            connection = sqlite3.connect(db)
            flag = connection.execute('SELECT not_race_result, stat_window FROM official_draw_stat').fetchone()
            allowance = connection.execute('SELECT allowance_lb, allowance_text FROM official_jockey_allowance').fetchone()
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            connection.close()
            self.assertEqual(flag[0], 1)
            self.assertIn('三季來同一條跑道', flag[1])
            self.assertIsNone(allowance[0])
            self.assertEqual(allowance[1], '--')
            self.assertIn('official_ranking_board', tables)
            self.assertNotIn('race_results', sql)


if __name__ == '__main__':
    unittest.main()
