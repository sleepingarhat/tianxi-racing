#!/usr/bin/env python3
"""Identity rules for the official surfaces still out after wave 6."""
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from hkjc_wave7_surfaces import (
    IdentityError, ParseMiss, BoardPending, news_views, parse_import_page, parse_news_document,
    parse_news_index, parse_racecard_page, parse_rating_board, parse_stakes_board, parse_stats_centre,
    parse_top50, sql_literal,
)

SCRAPED = '2026-11-10T00:00:00+00:00'
HKT = ZoneInfo('Asia/Hong_Kong')


def stats_flight(stamp='261111', folder='202611', slot_src='hot') -> str:
    hot = f'//consvc.hkjc.com/-/media/Sites/JCRW/Page/stats_centre/{folder}/statcentre_{slot_src}_{stamp}_ch.jpg?rev=aa8b6fe869b84fb3ace124aa055ca7d9&sc_lang=zh-HK'
    stats = f'//consvc.hkjc.com/-/media/Sites/JCRW/Page/stats_centre/{folder}/statcentre_stats_{stamp}_ch.jpg?rev=250beeac18834923980f78fa55da938a&sc_lang=zh-HK'
    return (
        '"name":"StatsCentre" 賽日數據 '
        '"endDateTime":{"dateValue":1794416400000} '
        '"lastUpdateDateTime":{"dateValue":1794283200000} '
        f'"whosHot":{{"src":"{hot}"}} '
        f'"racedayStats":{{"src":"{stats}"}}'
    )


def rating_html(left, right, note='') -> str:
    def column(rows):
        body = '<tr><td></td><td>Name</td><td>馬名</td><td>烙號</td><td>評分</td><td>變動</td></tr>'
        body += ''.join(
            f'<tr><td>{mark}</td><td>{en}</td><td>{ch}</td><td>{brand}</td><td>{rating}</td><td>{change}</td></tr>'
            for mark, en, ch, brand, rating, change in rows
        )
        return f'<table class="report_body_small">{body}</table>'
    note_html = f'<table><tr><td>{note}</td></tr></table>' if note else ''
    return f'<div id="tbSummary">{column(left)}{column(right)}</div>{note_html}'


def stakes_html() -> str:
    header = ''.join(f'<td>{cell}</td>' for cell in (
        '馬名', 'Horse Name', '烙號', '冠 *', '亞 *', '季 *', '殿 *', '第5名 *', '出賽次數 *',
        '本地賽事獎金 ($)#', '今季海外賽事 / 其他獎金 ($)%', '總獎金 ($)',
    ))
    return (
        '<table class="tbDataList"><tr>' + header + '</tr>'
        '<tr><td></td><td></td><td>M040</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>'
        '<tr><td>飛來霸</td><td>ZOUPER FELLOW</td><td>K284</td><td>0</td><td>1</td><td>0</td><td>0</td><td>0</td><td>2</td>'
        '<td>245,700</td><td>0</td><td>245,700</td></tr></table>'
        '<p>* 只限於本地賽事</p><p># 包括特別獎金</p><p>% 馬匹在港註冊後出賽海外賽事所贏取的獎金</p>'
    )


def news_index(view='List/dstr', href='/Racing/Info/MCS/Chinese/racing/prerace/dstr/20261111_HV0000_S_DSTR.xml.zip', title='宣佈出賽馬匹名單') -> str:
    rows = ''.join(
        f'<tr class="list"><td>{index}.</td><td><a href="{href}">{title} (2026/11/09 09:04:02)</a></td></tr>'
        for index in (1, 2)
    )
    # second row needs a distinct file; the helper uses one href unless title says otherwise
    return '<table>' + rows + '<tr class="list"><td colspan="2"></td></tr></table>'


def card_html() -> str:
    cells = [
        '1', '13/3', '', '電路一百', 'K308', '135', '巫顯東', '', '2', '沈集成', '-', '40', '-1',
        '1101', '+29', '1.42.43', '5', '-', '閹', '134,550', '+ 1', '41', 'B/TT', '何燕生與曾建華',
        'Zoustar', 'Reconstruct', 'PPG',
    ]
    body = ''.join(f'<td>{cell}</td>' for cell in cells)
    header = ''.join(f'<td>{cell}</td>' for cell in (
        '馬匹編號', '6次近績', '綵衣', '馬名', '烙號', '負磅', '騎師', '可能超磅', '檔位', '練馬師',
        '國際評分', '評分', '評分+/-', '排位體重', '排位體重+/-', '最佳時間', '馬齡', '分齡讓磅',
        '性別', '今季獎金', '優先參賽次序', '上賽距今日數', '配備', '馬主', '父系', '母系', '進口類別',
    ))
    name = body.replace('<td>電路一百</td>', '<td><a href="/zh-hk/local/information/horse?horseid=HK_2024_K308">電路一百</a></td>', 1)
    standby = (
        '<table id="standbylist"><tr>'
        + ''.join(f'<td>{cell}</td>' for cell in (
            '編號', '馬名', '排位體重', '負磅', '評分', '馬齡', '6次近績', '練馬師', '優先參賽次序', '配備',
        ))
        + '</tr><tr><td>1</td><td><a href="/zh-hk/local/information/horse?horseid=HK_2022_H454">良駒好友</a></td>'
        '<td>1190</td><td>129</td><td>34</td><td>7</td><td>11/9</td><td>文家良</td><td>1</td><td>B/TT</td></tr></table>'
    )
    return (
        '<div class="f_fs13">第 1 場 - 爵祿讓賽<br>2026年11月11日, 星期三, 跑馬地, 18:40<br>'
        '草地, "B" 賽道, 1650米, 好地</div>'
        '<a href="/racing/content/PDF/RaceCard/20261111_starter_r1_chi.pdf">此場</a>'
        '<a href="/racing/content/PDF/RaceCard/20261111_starter_all_chi.pdf">所有</a>'
        '<a href="//www.hkjc.com/chinese/racing/racecourse_img.asp?filename=hvt1650_h.gif">'
        '<img src="/racing/content/Chinese/RaceCourse/hvt1650_s.gif"></a>'
        f'<table class="starter"><tr>{header}</tr><tr>{name}</tr></table>{standby}'
    )


class Wave7Tests(unittest.TestCase):
    def test_stats_posters_keep_the_official_path_and_window(self):
        rows = parse_stats_centre(stats_flight(), 'abc', SCRAPED)
        self.assertEqual([row['slot'] for row in rows], ['whos_hot', 'raceday_stats'])
        self.assertEqual(rows[0]['poster_date'], '2026-11-11')
        self.assertTrue(rows[0]['image_path'].startswith('https://consvc.hkjc.com/'))
        self.assertEqual(rows[0]['window_end'], datetime(2026, 11, 12, 1, 0, tzinfo=HKT).isoformat())
        self.assertEqual(rows[0]['not_race_result'], 1)
        self.assertNotIn('energy', rows[0])

    def test_stats_poster_folder_must_match_the_filename_day(self):
        with self.assertRaises(IdentityError):
            parse_stats_centre(stats_flight(folder='202610'), 'abc', SCRAPED)

    def test_rating_list_keeps_a_blank_change_and_a_star(self):
        rows, notes = parse_rating_board(rating_html(
            [('', 'A TIME', '開心', 'K475', '47', ''), ('(1)', 'SPEED', '勁速', 'H380', '105', '+7')],
            [('', 'ABLE', '勁草', 'M022', '52', '*'), ('', 'ZOOM', '尾', 'Z999', '40', '-2')],
            '(1)比應負磅位多負四磅',
        ), 'csum', 'abc', SCRAPED)
        by_brand = {row['horse_code']: row for row in rows}
        self.assertIsNone(by_brand['K475']['change_text'])
        self.assertEqual(by_brand['M022']['change_text'], '*')
        self.assertEqual(by_brand['H380']['mark_text'], '(1)')
        self.assertEqual([row['horse_code'] for row in rows], ['K475', 'M022', 'H380', 'Z999'])
        self.assertIn('比應負', notes[0]['note_ch'])

    def test_rating_mark_without_its_note_fails(self):
        with self.assertRaises(ParseMiss):
            parse_rating_board(rating_html(
                [('(2)', 'SPEED', '勁速', 'H380', '105', '+7')],
                [],
            ), 'csum', 'abc', SCRAPED)

    def test_top50_requires_fifty_named_horses(self):
        header = '<tr><td>評分</td><td>馬名</td><td>Name</td><td>烙號</td><td>練馬師</td></tr>'
        body = ''.join(
            f'<tr><td>{140 - index}</td><td>馬{index}</td><td>HORSE {index}</td><td>K{index:03d}</td><td>練馬師</td></tr>'
            for index in range(50)
        )
        rows = parse_top50(f'<table id="tbTop50">{header}{body}</table>', 'abc', SCRAPED)
        self.assertEqual(len(rows), 50)
        self.assertEqual(rows[0]['trainer_name'], '練馬師')
        self.assertEqual(rows[0]['board'], 'tp50')

    def test_stakes_keep_a_blank_name_and_the_legend(self):
        rows, notes = parse_stakes_board(stakes_html(), 'abc', SCRAPED)
        self.assertIsNone(rows[0]['name_ch'])
        self.assertEqual(rows[1]['local_stakes'], 245700)
        self.assertEqual(rows[1]['total_stakes'], 245700)
        self.assertEqual(len(notes), 3)

    def test_news_index_stores_the_artifact_path(self):
        html = (
            '<tr class="list"><td>1.</td><td><a href="/Racing/Info/MCS/Chinese/racing/prerace/dstr/20261111_HV0000_S_DSTR.xml.zip">'
            '宣佈出賽馬匹名單 (2026/11/09 09:04:02)</a></td></tr>'
            '<tr class="list"><td>2.</td><td><a href="/Racing/Info/MCS/Chinese/racing/prerace/dstr/20261107_S30000_S_DSTR.xml.zip">'
            '宣佈出賽馬匹名單 - 海外賽事 - S3 (2026/11/05 22:12:00)</a></td></tr>'
        )
        rows = parse_news_index(html, 'List/dstr', 'abc', SCRAPED)
        self.assertEqual(rows[0]['venue'], 'HV')
        self.assertIsNone(rows[0]['simulcast_code'])
        self.assertTrue(rows[0]['artifact_path'].endswith('20261111_HV0000_S_DSTR.xml.zip'))
        self.assertEqual(rows[1]['simulcast_code'], 'S3')
        self.assertIsNone(rows[1]['venue'])
        self.assertEqual(rows[0]['published_at'], '2026-11-09T09:04:02+08:00')

    def test_news_index_rejects_a_local_title_on_a_simulcast_file(self):
        html = (
            '<tr class="list"><td>1.</td><td><a href="/Racing/Info/MCS/Chinese/racing/prerace/dstr/20261107_S30000_S_DSTR.xml.zip">'
            '宣佈出賽馬匹名單 (2026/11/05 22:12:00)</a></td></tr>'
        )
        with self.assertRaises(IdentityError):
            parse_news_index(html, 'List/dstr', 'abc', SCRAPED)

    def test_news_views_must_be_the_official_menu(self):
        html = ''.join(f'<a href="?View={view}">x</a>' for view in sorted(news_views.__globals__['REQUIRED_NEWS_VIEWS']))
        self.assertIn('Horses/clas', news_views(html))
        with self.assertRaises(ParseMiss):
            news_views(html.replace('Horses/clas', 'Horses/missing'))

    def test_seasonal_rating_snapshot_keeps_text_and_pdf_date(self):
        html = (
            '<p>24/7/2025</p><p>馬匹評分表（截至二○二五年七月二十四日）</p>'
            '<a href="https://mcs.hkjc.com/getFile.aspx?filename=HorseRatingList_RatingOrder_20250724.pdf">PDF</a>'
        )
        rows = parse_news_document(html, 'Horses/c_ahrl', '20250724_122104_C_AHRL.htm', 'abc', SCRAPED)
        self.assertEqual(rows[-1]['kind'], 'pdf')
        self.assertIn('20250724', rows[-1]['asset_path'])
        self.assertIn('評分', rows[1]['text_ch'])

    def test_import_policy_stores_text_cells_and_the_title_image(self):
        html = '''
        <script>self.__next_f.push([1,"<div class=\\"mainContent\\"><p>曾出賽馬匹進口資格</p><table><tr><td>阿根廷</td><td>秘魯 *</td></tr></table><a href=\\"ppgs-import-critieria\\">2026/27自購新馬</a></div>\\n6:next"])</script>
        <img src="//consvc.hkjc.com/-/media/Sites/JCRW/Page/pps_import_critieria/title.gif?rev=ac5b74de05424e54abe2a3933fcb4a8f&sc_lang=zh-HK">
        <a href="/general/-/media/Sites/JCRW/pp_formsheet/ch/Veterinary_Pre-Import_Exam_Protocol_Version_Chi.pdf">馬匹進口前體格檢驗規定</a>
        '''
        # The flight decoder needs a real escaped push. Build one.
        from json import dumps
        body = (
            '<div class="mainContent"><p>曾出賽馬匹進口資格</p>'
            '<table><tr><td>阿根廷</td><td>秘魯 *</td></tr></table>'
            '<a href="ppgs-import-critieria">2026/27自購新馬</a></div>'
        )
        image = '//consvc.hkjc.com/-/media/Sites/JCRW/Page/pps_import_critieria/title.gif?rev=ac5b74de05424e54abe2a3933fcb4a8f&sc_lang=zh-HK'
        flight = body + image
        page = (
            '<script>self.__next_f.push([1,' + dumps(flight) + '])</script>'
            '<a href="/general/-/media/Sites/JCRW/pp_formsheet/ch/Veterinary_Pre-Import_Exam_Protocol_Version_Chi.pdf">馬匹進口前體格檢驗規定</a>'
        )
        rows = parse_import_page(page, 'pps', 'https://racing.hkjc.com/zh-hk/local/page/pps-import-critieria', 'abc', SCRAPED)
        kinds = {row['kind'] for row in rows}
        self.assertEqual(kinds, {'image', 'exam_pdf', 'paragraph', 'table_cell', 'tab'})
        cells = [row['text_ch'] for row in rows if row['kind'] == 'table_cell']
        self.assertEqual(cells, ['阿根廷', '秘魯 *'])
        self.assertTrue(rows[0]['asset_path'].startswith('https://consvc.hkjc.com/'))

    def test_racecard_profile_comes_from_the_starter_table(self):
        runners, files = parse_racecard_page(card_html(), '2026-11-11', 'HV', 1, 'abc', SCRAPED)
        declared = runners[0]
        self.assertEqual(declared['horse_id'], 'HK_2024_K308')
        self.assertEqual(declared['age'], 5)
        self.assertEqual(declared['sex'], '閹')
        self.assertEqual(declared['season_stakes'], 134550)
        self.assertEqual(declared['owner'], '何燕生與曾建華')
        self.assertEqual(declared['import_type'], 'PPG')
        self.assertEqual(declared['sire'], 'Zoustar')
        reserve = runners[1]
        self.assertEqual(reserve['is_reserve'], 1)
        self.assertEqual(reserve['age'], 7)
        self.assertIsNone(reserve['sex'])
        self.assertIsNone(reserve['owner'])
        kinds = {row['kind']: row for row in files}
        self.assertIn('20261111_starter_r1_chi.pdf', kinds['starter_pdf']['artifact_path'])
        self.assertEqual(kinds['track_map']['distance'], 1650)
        self.assertEqual(kinds['track_map']['surface_code'], 't')
        self.assertEqual(kinds['starter_pdf_all']['race_no'], 0)

    def test_racecard_map_distance_must_match_the_header(self):
        html = card_html().replace('hvt1650', 'hvt1200')
        with self.assertRaises(IdentityError):
            parse_racecard_page(html, '2026-11-11', 'HV', 1, 'abc', SCRAPED)

    def test_racecard_before_booklets_keeps_runners_and_maps(self):
        # 2026-11-12: the 14/11 card was out but both download buttons pointed at No_PDF_Download.html.
        html = (card_html()
                .replace('/racing/content/PDF/RaceCard/20261111_starter_r1_chi.pdf', '/racing/chinese/No_PDF_Download.html')
                .replace('/racing/content/PDF/RaceCard/20261111_starter_all_chi.pdf', '/racing/chinese/No_PDF_Download.html'))
        runners, files = parse_racecard_page(html, '2026-11-11', 'HV', 1, 'abc', SCRAPED)
        self.assertEqual(runners[0]['horse_id'], 'HK_2024_K308')
        self.assertEqual(sorted(row['kind'] for row in files), ['track_map', 'track_map_thumb'])

    def test_racecard_without_booklet_or_placeholder_fails(self):
        html = (card_html()
                .replace('<a href="/racing/content/PDF/RaceCard/20261111_starter_r1_chi.pdf">此場</a>', '')
                .replace('<a href="/racing/content/PDF/RaceCard/20261111_starter_all_chi.pdf">所有</a>', ''))
        with self.assertRaises(ParseMiss):
            parse_racecard_page(html, '2026-11-11', 'HV', 1, 'abc', SCRAPED)

    def test_racecard_with_only_one_booklet_fails(self):
        html = card_html().replace('/racing/content/PDF/RaceCard/20261111_starter_all_chi.pdf', '/racing/chinese/No_PDF_Download.html')
        with self.assertRaises(ParseMiss):
            parse_racecard_page(html, '2026-11-11', 'HV', 1, 'abc', SCRAPED)

    def test_unpublished_card_is_pending(self):
        with self.assertRaises(BoardPending):
            parse_racecard_page('<html><title>排位表</title></html>', '2026-11-14', 'ST', 1, 'abc', SCRAPED)

    def test_sql_literal_escapes_a_name_apostrophe(self):
        self.assertEqual(sql_literal("CAPTAINS' PRIDE"), "'CAPTAINS'' PRIDE'")


if __name__ == '__main__':
    unittest.main()
