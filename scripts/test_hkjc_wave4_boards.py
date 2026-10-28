import importlib.util
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location('wave4', Path(__file__).with_name('hkjc_wave4_boards.py'))
wave4 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wave4)

TODAY = date(2026, 10, 27)
SCRAPED = '2026-10-27T05:00:00+00:00'
HORSE = {'horse_id': 'HK_2023_J218', 'horse_name': '添喜運', 'brand_no': 'J218'}
NEW_HORSE = {'horse_id': 'HK_2025_L457', 'horse_name': '海象先生', 'brand_no': 'L457'}


def horse_page(name, brand, starts_line, content_rows):
    rows_html = ''.join(
        '<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>' for row in content_rows
    )
    return (
        f'<html><body>'
        f'<div class="horse_name"><a>{name} ({brand}) 往績紀錄 馬匹評分/體重/名次</a></div>'
        f'<div>冠-亞-季-總出賽次數* : {starts_line}</div>'
        f'<table><tr><td>shell</td></tr></table>'
        f'<table>{rows_html}</table>'
        f'</body></html>'
    ).encode('utf-8')


RATING_ROWS = [
    ['添喜運 (J218)'],
    ['', '04/10/2026', '09/09/2026'],
    ['評分', '29', '24'],
    ['賽果', '1/14', '1/12'],
    ['馬匹體重', '1276', '1268'],
    ['馬場', '沙田', '跑馬地'],
    ['跑道', '草地', '草地'],
    ['途程', '1200', '1400'],
]

OVERSEAS_ROWS = [
    ['自強不息 (H337)'],
    ['', '11/10/2026', '06/09/2026'],
    ['評分', '87', '90'],
    ['賽果', '10/12', '14/16'],
    ['馬匹體重', '1104', '---'],
    ['馬場', '沙田', '首爾'],
    ['跑道', '草地', '沙地跑道'],
    ['途程', '1200', '1200'],
]

PERF_ROWS = [
    ['', '', '出賽', '冠', '亞', '季', '負'],
    ['場地成績'],
    ['草地', '好地至快地', '11', '2', '1', '0', '8'],
    ['', '好地', '21', '2', '1', '1', '17'],
    ['路程成績'],
    ['沙田草地', '1200米', '4', '0', '0', '0', '4'],
    ['', '沙田草地總成績', '17', '2', '1', '2', '12'],
    ['歷季成績'],
    ['25/26', '', '30', '3', '2', '2', '23'],
]

MOVE_ROWS = [
    ['從', '至', '到達日期'],
    ['從化', '香港', '24/10/2026'],
    ['香港', '從化', '12/10/2026'],
    ['', '香港', '24/03/2026'],
]

OVEROAR_HTML = (
    '<html><body><table>'
    '<tr><td>患喘鳴症馬匹資料庫 (截至 2026年10月27日 星期二)</td></tr>'
    '<tr><td>烙印編號</td><td>馬名</td><td>診斷日期</td><td>曾接受手術</td></tr>'
    '<tr><td>G209</td><td>自力更生</td><td>06/12/2023</td><td>Y</td></tr>'
    '<tr><td>H354</td><td>精算特殊</td><td>14/06/2025</td><td>N</td></tr>'
    '</table></body></html>'
).encode('utf-8')

JKC_HTML = (
    '<html><body><div>賽事日期:25/10/2026 騎師王</div><table>'
    '<tr><td></td><td></td><td></td><td>實際數目</td><td></td></tr>'
    '<tr><td>編號</td><td>騎師</td><td>賽日 積分</td><td>冠</td><td>亞</td><td>季</td><td>殿</td><td>備註</td></tr>'
    '<tr><td>10</td><td>艾道拿</td><td>40</td><td>2</td><td>2</td><td>1</td><td>0</td><td>勝出</td></tr>'
    '<tr><td>4</td><td>袁幸堯</td><td>30</td><td>2</td><td>1</td><td>0</td><td>1</td><td></td></tr>'
    '</table></body></html>'
).encode('utf-8')

DRAW_FORM_HTML = (
    '<html><body>'
    '<select id="seasonId">'
    '<option value="2025">25/26 馬季至今</option>'
    '<option value="2026">26/27 馬季至今</option>'
    '</select>'
    '<select id="racecourseId">'
    '<option value="STT">沙田 -- 草地</option>'
    '<option value="STA">沙田 -- 全天候</option>'
    '<option value="HVT">跑馬地 -- 草地</option>'
    '<option value="CHT">從化 -- 草地</option>'
    '</select>'
    '<select id="courseId_2026STT"><option value="A">"A" 賽道</option><option value="B">"B" 賽道</option></select>'
    '<select id="distanceId_2026STT"><option value="1000">1000米</option><option value="1200">1200米</option></select>'
    '<select id="courseId_2026STA"></select>'
    '<select id="distanceId_2026STA"><option value="1200">1200米</option><option value="1650">1650米</option></select>'
    '<select id="courseId_2025STT"><option value="A">"A" 賽道</option></select>'
    '<select id="distanceId_2025STT"><option value="1200">1200米</option></select>'
    '<select id="courseId_2025STA"></select>'
    '<select id="distanceId_2025STA"><option value="1200">1200米</option></select>'
    '<select id="courseId_2025HVT"><option value="A">"A" 賽道</option></select>'
    '<select id="distanceId_2025HVT"><option value="1200">1200米</option></select>'
    '<select id="courseId_2025CHT"><option value="A">"A" 賽道</option></select>'
    '<select id="distanceId_2025CHT"><option value="1200">1200米</option></select>'
    '<select id="courseId_2026HVT"><option value="A">"A" 賽道</option></select>'
    '<select id="distanceId_2026HVT"><option value="1200">1200米</option></select>'
    '<select id="courseId_2026CHT"><option value="A">"A" 賽道</option></select>'
    '<select id="distanceId_2026CHT"><option value="1200">1200米</option></select>'
    '</body></html>'
).encode('utf-8')

DRAW_GRID_HTML = (
    '<html><body><div class="searchResult"><table>'
    '<tr><td>26/27 馬季至今   沙田    1200米    草地      "A" 賽道</td></tr>'
    '<tr><td>檔位</td><td>出賽 次數</td><td>冠</td><td>亞</td><td>季</td><td>殿</td>'
    '<td>勝出率 %</td><td>入Q率 %</td><td>上名率 %</td><td>前4名 率%</td><td></td></tr>'
    '<tr><td>1</td><td>13</td><td>3</td><td>1</td><td>1</td><td>1</td><td>23</td><td>31</td><td>38</td><td>46</td><td></td></tr>'
    '<tr><td>2</td><td>13</td><td>1</td><td>3</td><td>2</td><td>1</td><td>8</td><td>31</td><td>46</td><td>54</td><td></td></tr>'
    '</table></div></body></html>'
).encode('utf-8')


class RatingWeightTests(unittest.TestCase):
    def parse(self, raw, horse=HORSE):
        return wave4.parse_rating_weight(raw, horse, TODAY, 'abc', SCRAPED)

    def test_parses_each_date_column(self):
        rows = self.parse(horse_page('添喜運', 'J218', '3-2-2-40', RATING_ROWS))
        self.assertEqual(len(rows), 2)
        first = rows[0]
        self.assertEqual(first['race_date'], '2026-10-04')
        self.assertEqual(first['rating'], 29)
        self.assertEqual(first['finish_text'], '1/14')
        self.assertEqual(first['body_weight'], 1276)
        self.assertEqual(first['venue'], 'ST')
        self.assertEqual(first['track'], '草地')
        self.assertEqual(first['not_race_result'], 1)
        self.assertEqual(rows[1]['venue'], 'HV')
        self.assertEqual(rows[0]['distance_m'], 1200)

    def test_overseas_start_keeps_page_venue_and_blank_weight(self):
        horse = {'horse_id': 'HK_2022_H337', 'horse_name': '自強不息', 'brand_no': 'H337'}
        rows = self.parse(horse_page('自強不息', 'H337', '3-2-2-40', OVERSEAS_ROWS), horse)
        self.assertEqual(rows[1]['venue'], '首爾')
        self.assertEqual(rows[1]['track'], '沙地跑道')
        self.assertEqual(rows[1]['body_weight'], '')
        self.assertEqual(rows[0]['body_weight'], 1104)

    def test_identity_mismatch_refused(self):
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('另一匹', 'A001', '1-0-0-5', RATING_ROWS))

    def test_no_history_horse_has_no_curve_and_is_not_an_error(self):
        rows = self.parse(horse_page('海象先生', 'L457', '0-0-0-0', [['海象先生 (L457)']]), NEW_HORSE)
        self.assertEqual(rows, [])

    def test_horse_with_starts_but_no_curve_fails(self):
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', [['添喜運 (J218)']]))

    def test_future_race_date_refused(self):
        bad = [row[:] for row in RATING_ROWS]
        bad[1] = ['', '04/10/2026', '09/09/2027']
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', bad))

    def test_bad_finish_text_refused(self):
        bad = [row[:] for row in RATING_ROWS]
        bad[3] = ['賽果', 'WIN', '1/12']
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', bad))


class PerformanceTests(unittest.TestCase):
    def parse(self, raw, horse=HORSE):
        return wave4.parse_performance(raw, horse, TODAY, 'abc', SCRAPED)

    def test_sections_and_carried_labels(self):
        rows = self.parse(horse_page('添喜運', 'J218', '3-2-2-40', PERF_ROWS))
        self.assertEqual(len(rows), 5)
        going = [row for row in rows if row['section'] == 'going']
        self.assertEqual(going[0]['label_a'], '草地')
        self.assertEqual(going[1]['label_a'], '草地')
        self.assertEqual(going[1]['label_b'], '好地')
        distance = [row for row in rows if row['section'] == 'distance']
        self.assertEqual(distance[1]['label_b'], '沙田草地總成績')
        season = [row for row in rows if row['section'] == 'season']
        self.assertEqual(season[0]['label_a'], '25/26')
        self.assertEqual(season[0]['starts'], 30)

    def test_places_must_add_to_starts(self):
        bad = [row[:] for row in PERF_ROWS]
        bad[2] = ['草地', '好地至快地', '11', '9', '9', '9', '9']
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', bad))

    def test_no_history_horse_has_no_table_and_is_not_an_error(self):
        rows = self.parse(horse_page('海象先生', 'L457', '0-0-0-0', [['海象先生 (L457)']]), NEW_HORSE)
        self.assertEqual(rows, [])

    def test_horse_with_starts_but_no_table_fails(self):
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', [['添喜運 (J218)']]))


class MovementTests(unittest.TestCase):
    def parse(self, raw, horse=HORSE):
        return wave4.parse_movement(raw, horse, TODAY, 'abc', SCRAPED)

    def test_parses_moves_and_first_arrival(self):
        rows = self.parse(horse_page('添喜運', 'J218', '3-2-2-40', MOVE_ROWS))
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['from_loc'], '從化')
        self.assertEqual(rows[0]['to_loc'], '香港')
        self.assertEqual(rows[0]['arrive_date'], '2026-10-24')
        self.assertEqual(rows[2]['from_loc'], '')

    def test_future_arrival_refused(self):
        bad = [row[:] for row in MOVE_ROWS]
        bad[1] = ['從化', '香港', '24/10/2027']
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', bad))

    def test_empty_destination_refused(self):
        bad = [row[:] for row in MOVE_ROWS]
        bad[1] = ['從化', '', '24/10/2026']
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', bad))

    def test_empty_table_fails(self):
        with self.assertRaises(wave4.IdentityError):
            self.parse(horse_page('添喜運', 'J218', '3-2-2-40', [['從', '至', '到達日期']]))


class OveroarTests(unittest.TestCase):
    def test_parses_list_and_as_of(self):
        rows = wave4.parse_overoar(OVEROAR_HTML, TODAY, 'abc', SCRAPED)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['as_of_date'], '2026-10-27')
        self.assertEqual(rows[0]['brand_no'], 'G209')
        self.assertEqual(rows[0]['surgery'], 'Y')
        self.assertEqual(rows[1]['diagnosis_date'], '2025-06-14')

    def test_future_as_of_refused(self):
        bad = OVEROAR_HTML.replace(b'2026\xe5\xb9\xb410\xe6\x9c\x8827\xe6\x97\xa5', '2027年10月27日'.encode('utf-8'))
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_overoar(bad, TODAY, 'abc', SCRAPED)

    def test_bad_brand_refused(self):
        bad = OVEROAR_HTML.replace(b'G209', b'209')
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_overoar(bad, TODAY, 'abc', SCRAPED)

    def test_bad_surgery_flag_refused(self):
        bad = OVEROAR_HTML.replace(b'<td>Y</td>', b'<td>YES</td>')
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_overoar(bad, TODAY, 'abc', SCRAPED)


class PoolResultTests(unittest.TestCase):
    def test_parses_jkc_meeting_result(self):
        rows = wave4.parse_pool_result(JKC_HTML, 'jkc', TODAY, 'abc', SCRAPED, '2026-10-25')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['meeting_date'], '2026-10-25')
        self.assertEqual(rows[0]['person_name'], '艾道拿')
        self.assertEqual(rows[0]['points'], 40)
        self.assertEqual(rows[0]['remark'], '勝出')
        self.assertEqual(rows[0]['not_race_result'], 1)

    def test_wrong_role_label_refused(self):
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_pool_result(JKC_HTML, 'tnc', TODAY, 'abc', SCRAPED)

    def test_requested_date_mismatch_refused(self):
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_pool_result(JKC_HTML, 'jkc', TODAY, 'abc', SCRAPED, '2026-10-21')

    def test_future_meeting_refused(self):
        bad = JKC_HTML.replace(b'25/10/2026', b'25/10/2027')
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_pool_result(bad, 'jkc', TODAY, 'abc', SCRAPED)


class DrawAdvTests(unittest.TestCase):
    def test_form_combos_read_from_page(self):
        combos = wave4.draw_adv_combos(DRAW_FORM_HTML)
        self.assertEqual(combos[('2026', 'STT')]['courses'], ['A', 'B'])
        self.assertEqual(combos[('2026', 'STT')]['distances'], ['1000', '1200'])
        self.assertEqual(combos[('2026', 'STA')]['courses'], [])
        self.assertEqual(combos[('2026', 'STA')]['distances'], ['1200', '1650'])

    def test_grid_parses_with_title_echo(self):
        rows = wave4.parse_draw_adv(DRAW_GRID_HTML, '2026', 'STT', 'A', '1200', 'abc', SCRAPED)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['season_code'], '26/27')
        self.assertEqual(rows[0]['racecourse'], 'STT')
        self.assertEqual(rows[0]['course_label'], 'A')
        self.assertEqual(rows[0]['distance_m'], 1200)
        self.assertEqual(rows[0]['draw'], 1)
        self.assertEqual(rows[0]['win_pct'], 23)
        self.assertEqual(rows[0]['top4_pct'], 46)

    def test_title_mismatch_refused(self):
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_draw_adv(DRAW_GRID_HTML, '2026', 'STT', 'B', '1200', 'abc', SCRAPED)
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_draw_adv(DRAW_GRID_HTML, '2026', 'STT', 'A', '1400', 'abc', SCRAPED)

    def test_placings_above_starts_refused(self):
        bad = DRAW_GRID_HTML.replace(
            b'<td>1</td><td>13</td><td>3</td>', b'<td>1</td><td>13</td><td>10</td>')
        bad = bad.replace(b'<td>1</td><td>1</td><td>23</td>', b'<td>5</td><td>5</td><td>23</td>')
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_draw_adv(bad, '2026', 'STT', 'A', '1200', 'abc', SCRAPED)

    def test_unraced_combo_with_form_intact_is_empty_not_error(self):
        empty = (b'<html><body><select id="seasonId">'
                 b'<option value="2026">26/27 \xe9\xa6\xac\xe5\xad\xa3\xe8\x87\xb3\xe4\xbb\x8a</option>'
                 b'</select><p>no grid</p></body></html>')
        rows = wave4.parse_draw_adv(empty, '2026', 'CHT', 'A', '1200', 'abc', SCRAPED)
        self.assertEqual(rows, [])
        rows = wave4.parse_draw_adv(empty, '2026', 'HVT', 'A', '2200', 'abc', SCRAPED)
        self.assertEqual(rows, [])

    def test_page_without_search_form_fails(self):
        empty = b'<html><body><p>no grid</p></body></html>'
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_draw_adv(empty, '2026', 'STT', 'A', '1200', 'abc', SCRAPED)
        with self.assertRaises(wave4.IdentityError):
            wave4.parse_draw_adv(empty, '2026', 'CHT', 'A', '1200', 'abc', SCRAPED)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_merge_replaces_horse_rows_and_keeps_others(self):
        first = [{'horse_id': 'HK_2023_J218', 'horse_name': '添喜運', 'brand_no': 'J218',
                  'from_loc': '從化', 'to_loc': '香港', 'arrive_date': '2026-10-24',
                  'not_race_result': 1, 'source_sha256': 'a', 'scraped_at': SCRAPED}]
        wave4.store_surface(self.root, 'movement', first)
        other = dict(first[0], horse_id='HK_2025_L457', horse_name='海象先生', brand_no='L457')
        wave4.store_surface(self.root, 'movement', [other])
        fresh = dict(first[0], arrive_date='2026-10-26', source_sha256='b')
        wave4.store_surface(self.root, 'movement', [fresh])
        rows = wave4.read_csv(self.root / 'data/official_wave4/movement.csv', wave4.MOVEMENT_COLUMNS)
        self.assertEqual(len(rows), 2)
        kept = [row for row in rows if row['horse_id'] == 'HK_2023_J218']
        self.assertEqual(kept[0]['arrive_date'], '2026-10-26')
        self.assertEqual(kept[0]['source_sha256'], 'b')

    def test_emit_sql_stores_numbers_as_numbers(self):
        wave4.store_surface(self.root, 'overoar', wave4.parse_overoar(OVEROAR_HTML, TODAY, 'abc', SCRAPED))
        sql = wave4.emit_sql(self.root)
        self.assertIn('official_overoar', sql)
        self.assertNotIn("'1'", sql)
        db = self.root / 'test.db'
        wave4.apply_sql(db, sql)
        connection = sqlite3.connect(db)
        try:
            count = connection.execute('SELECT COUNT(*) FROM official_overoar').fetchone()[0]
            self.assertEqual(count, 2)
            row = connection.execute(
                "SELECT diagnosis_date, surgery FROM official_overoar WHERE brand_no = 'G209'").fetchone()
            self.assertEqual(row, ('2023-12-06', 'Y'))
        finally:
            connection.close()

    def test_empty_official_text_survives_database_write(self):
        wave4.store_surface(self.root, 'movement', wave4.parse_movement(
            horse_page('添喜運', 'J218', '0-0-0-0', MOVE_ROWS), HORSE, TODAY, 'abc', SCRAPED))
        wave4.store_surface(self.root, 'pool_result', wave4.parse_pool_result(JKC_HTML, 'jkc', date(2026, 10, 25), 'abc', SCRAPED))
        db = self.root / 'empty-text.db'
        wave4.apply_sql(db, wave4.emit_sql(self.root))
        with sqlite3.connect(db) as connection:
            self.assertEqual(connection.execute("SELECT from_loc FROM official_movement WHERE arrive_date='2026-03-24'").fetchone(), ('',))
            self.assertEqual(connection.execute("SELECT remark FROM official_pool_result WHERE person_name='袁幸堯'").fetchone(), ('',))

    def test_apply_sql_creates_all_six_tables(self):
        db = self.root / 'empty.db'
        wave4.apply_sql(db, '-- nothing\n')
        connection = sqlite3.connect(db)
        try:
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'official_%'")}
        finally:
            connection.close()
        self.assertEqual(tables, {
            'official_rating_weight', 'official_performance', 'official_movement',
            'official_overoar', 'official_pool_result', 'official_draw_adv_stat',
        })

    def test_not_race_result_constraint_holds(self):
        db = self.root / 'guard.db'
        wave4.apply_sql(db, '-- nothing\n')
        connection = sqlite3.connect(db)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO official_pool_result (pool, meeting_date, rank_no, person_name, points,"
                    " wins, seconds, thirds, fourths, remark, not_race_result, source_sha256, scraped_at)"
                    " VALUES ('jkc', '2026-10-25', 1, '甲', 0, 0, 0, 0, 0, '', 0, 'x', 'y')")
        finally:
            connection.close()


class RacecardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        folder = self.root / 'entries/racecard_snapshots/2026-10-28_ST'
        folder.mkdir(parents=True)
        (folder / 'snap.csv').write_text(
            'horse_id,horse_name_ch,horse_code\n'
            'HK_2025_L073,幸運勝利,L073\n'
            'HK_2023_J218,添喜運,J218\n',
            encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_racecard_accepts_space_or_underscore(self):
        by_space = wave4.load_racecard_horses(self.root, '2026-10-28 ST')
        by_under = wave4.load_racecard_horses(self.root, '2026-10-28_ST')
        self.assertEqual(by_space, by_under)
        self.assertEqual(len(by_space), 2)
        self.assertEqual(by_space[0]['brand_no'], 'J218')

    def test_latest_snapshot_is_default(self):
        horses = wave4.load_racecard_horses(self.root)
        self.assertEqual(len(horses), 2)

    def test_bad_horse_id_refused(self):
        folder = self.root / 'entries/racecard_snapshots/2026-10-29_ST'
        folder.mkdir(parents=True)
        (folder / 'snap.csv').write_text('horse_id,horse_name_ch,horse_code\nBAD,馬,X001\n', encoding='utf-8')
        with self.assertRaises(wave4.IdentityError):
            wave4.load_racecard_horses(self.root, '2026-10-29_ST')


if __name__ == '__main__':
    unittest.main()
