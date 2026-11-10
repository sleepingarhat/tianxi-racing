#!/usr/bin/env python3
"""Official surfaces that were still missing or unfinished after wave 6.

* 賽日數據 — the two JPEG posters and their display-window timestamps.
  The pixels are not read and no numeric table is invented.
* 馬匹消息 — every View= the index page lists. Inline tables are stored as
  rows. Dated notices are stored as the list the page shows (title, clock,
  official artifact path). Zip and Word bytes are not unpacked.
* 馬匹評分榜 — the Horses/clas table behind that view's iframe.
* 進口資格 — the policy text, the tables inside it, the title image, and the
  pre-import examination PDF linked from the page.
* 排位表 leftovers — age, sex, owner, import type, season stakes, sire and dam
  from the starter table; reserve age from the standby table; starter PDF
  paths; track-map paths. These do not write entries_upcoming.

Rows are the public board. They are not model inputs and not frozen-pick inputs.
A page that is not published yet is skipped. A published page whose identity or
a cell does not match is a hard failure and writes nothing for that surface.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

HKT = ZoneInfo('Asia/Hong_Kong')
SITE = 'https://racing.hkjc.com'
UA = (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
)
PUSH = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
BRAND = re.compile(r'^[A-Z]\d{3}$')
HORSE_ID = re.compile(r'^HK_\d{4}_([A-Z]\d{3})$')
SEX = re.compile(r'^[雄雌閹]$')
IMPORT_TYPE = re.compile(r'^[A-Z][A-Z0-9]{1,7}$')
CHANGE = re.compile(r'^[+-]\d{1,2}$')
MARK = re.compile(r'^\(\d{1,2}\)$')
STAKES_TEXT = re.compile(r'^\d{1,3}(?:,\d{3})*$|^\d+$')
NEWS_FILE = re.compile(
    r'^/Racing/Info/MCS/Chinese/(?:racing/prerace|horses)/(?P<folder>[A-Za-z0-9_]+)/'
    r'(?P<day>\d{8})_(?P<tag>[A-Z0-9]+)_(?P<lang>[SC])_(?P<code>[A-Z0-9]+)'
    r'\.(?P<ext>xml\.zip|docx|doc)$',
    re.IGNORECASE,
)
STATS_IMAGE = re.compile(
    r'^https://consvc\.hkjc\.com/-/media/Sites/JCRW/Page/stats_centre/'
    r'(?P<folder>\d{6})/statcentre_(?P<slot>hot|stats)_(?P<stamp>\d{6})_ch\.jpg'
    r'\?rev=(?P<rev>[0-9a-fA-F]{32})&sc_lang=zh-HK$'
)
MAP_STEM = re.compile(r'^(hv|st)([a-z])(\d{3,4})$')
PDF_PATH = re.compile(
    r'^/racing/content/PDF/RaceCard/(?P<day>\d{8})_starter_(?:r(?P<race>\d+)|all)_chi\.pdf$'
)
VENUE_NAME = {'ST': '沙田', 'HV': '跑馬地'}
STARTER_HEADERS = (
    '馬匹編號', '6次近績', '綵衣', '馬名', '烙號', '負磅', '騎師', '可能超磅', '檔位', '練馬師',
    '國際評分', '評分', '評分+/-', '排位體重', '排位體重+/-', '最佳時間', '馬齡', '分齡讓磅',
    '性別', '今季獎金', '優先參賽次序', '上賽距今日數', '配備', '馬主', '父系', '母系', '進口類別',
)
STANDBY_HEADERS = (
    '編號', '馬名', '排位體重', '負磅', '評分', '馬齡', '6次近績', '練馬師', '優先參賽次序', '配備',
)
STAKES_HEADERS = (
    '馬名', 'Horse Name', '烙號', '冠 *', '亞 *', '季 *', '殿 *', '第5名 *', '出賽次數 *',
    '本地賽事獎金 ($)#', '今季海外賽事 / 其他獎金 ($)%', '總獎金 ($)',
)
TOP_HEADERS = ('評分', '馬名', 'Name', '烙號', '練馬師')
REQUIRED_NEWS_VIEWS = frozenset({
    'List/dstr', 'List/schr', 'List/swim', 'List/sbrp', 'List/sphl', 'List/c_exam',
    'List/stst', 'List/sres', 'List/btri', 'List/bres', 'Horses/c_ahrl', 'Horses/clas',
    'List/nimp', 'Horses/tp50', 'Horses/csum', 'List/c_gdrp', 'List/c_ipsd', 'List/nonh',
    'Horses/smon',
})
RATING_BOARDS = {'Horses/clas': 'clas', 'Horses/csum': 'csum'}
SURFACES = ('stats', 'horse-news', 'import', 'racecard')
CARD_WINDOW_DAYS = 14

STATS_COLUMNS = [
    'slot', 'poster_date', 'window_end', 'last_update', 'image_path',
    'not_race_result', 'source_sha256', 'scraped_at',
]
RATING_COLUMNS = [
    'board', 'line_no', 'horse_code', 'name_en', 'name_ch', 'rating', 'change_text', 'mark_text',
    'trainer_name', 'not_race_result', 'source_sha256', 'scraped_at',
]
RATING_NOTE_COLUMNS = [
    'board', 'line_no', 'note_ch', 'not_race_result', 'source_sha256', 'scraped_at',
]
STAKES_COLUMNS = [
    'line_no', 'horse_code', 'name_ch', 'name_en', 'wins', 'seconds', 'thirds', 'fourths', 'fifths',
    'starts', 'local_stakes', 'overseas_stakes', 'total_stakes',
    'not_race_result', 'source_sha256', 'scraped_at',
]
STAKES_NOTE_COLUMNS = [
    'line_no', 'note_ch', 'not_race_result', 'source_sha256', 'scraped_at',
]
NEWS_COLUMNS = [
    'view_code', 'line_no', 'title_ch', 'published_at', 'artifact_path', 'file_date', 'file_tag',
    'venue', 'simulcast_code', 'not_race_result', 'source_sha256', 'scraped_at',
]
DOCUMENT_COLUMNS = [
    'view_code', 'block_no', 'kind', 'text_ch', 'asset_path', 'file_name',
    'not_race_result', 'source_sha256', 'scraped_at',
]
IMPORT_COLUMNS = [
    'page_code', 'kind', 'block_no', 'row_no', 'col_no', 'text_ch', 'asset_path',
    'not_race_result', 'source_sha256', 'scraped_at',
]
RUNNER_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'horse_no', 'is_reserve', 'horse_id', 'brand_no', 'horse_name',
    'age', 'sex', 'season_stakes', 'owner', 'sire', 'dam', 'import_type',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FILE_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'kind', 'artifact_path', 'distance', 'surface_code',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'stats_centre_image': ('stats_centre_image.csv', STATS_COLUMNS),
    'horse_rating': ('horse_rating.csv', RATING_COLUMNS),
    'horse_rating_note': ('horse_rating_note.csv', RATING_NOTE_COLUMNS),
    'horse_stakes': ('horse_stakes.csv', STAKES_COLUMNS),
    'horse_stakes_note': ('horse_stakes_note.csv', STAKES_NOTE_COLUMNS),
    'horse_news': ('horse_news.csv', NEWS_COLUMNS),
    'horse_news_document': ('horse_news_document.csv', DOCUMENT_COLUMNS),
    'import_policy': ('import_policy.csv', IMPORT_COLUMNS),
    'racecard_runner': ('racecard_runner.csv', RUNNER_COLUMNS),
    'racecard_file': ('racecard_file.csv', FILE_COLUMNS),
}
INTEGER_COLUMNS = {
    'line_no', 'rating', 'wins', 'seconds', 'thirds', 'fourths', 'fifths', 'starts',
    'local_stakes', 'overseas_stakes', 'total_stakes', 'block_no', 'row_no', 'col_no',
    'race_no', 'horse_no', 'is_reserve', 'age', 'season_stakes', 'distance', 'not_race_result',
}
REPLACE_ALL = {
    'stats_centre_image', 'horse_rating', 'horse_rating_note', 'horse_stakes', 'horse_stakes_note',
    'horse_news', 'horse_news_document', 'import_policy',
}
MEETING_KEYS = {'racecard_runner', 'racecard_file'}


class IdentityError(ValueError):
    """The page is not the meeting, horse, or file it claims to be."""


class ParseMiss(ValueError):
    """A published board is not the official shape."""


class BoardPending(Exception):
    """The official page has not published this board yet."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def scraped_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def collapse(value: str | None) -> str:
    return re.sub(r'\s+', ' ', (value or '').replace('\xa0', ' ')).strip()


def blank(value: str | None) -> str | None:
    text = collapse(value)
    if text in ('', '-', '--', '---', '----'):
        return None
    return text


def fetch_bytes(url: str) -> bytes:
    last = None
    for attempt in range(3):
        req = Request(url, headers={'user-agent': UA, 'accept-encoding': 'identity', 'accept-language': 'zh-HK,zh;q=0.9'})
        try:
            with urlopen(req, timeout=40) as response:
                host = (response.geturl() or url).split('/')[2]
                if not (host == 'consvc.hkjc.com' or host.endswith('hkjc.com')):
                    raise IdentityError(f'unexpected host {host}')
                raw = response.read()
                encoding = response.headers.get('content-encoding', '')
            if encoding == 'gzip' or raw.startswith(b'\x1f\x8b'):
                raw = gzip.decompress(raw)
            elif encoding not in ('', 'identity'):
                raise IdentityError('unsupported official encoding')
            return raw
        except (HTTPError, URLError, TimeoutError, IdentityError) as exc:
            last = exc
            if isinstance(exc, IdentityError) or attempt == 2:
                break
    raise IdentityError(f'official fetch failed for {url}: {last}')


def flight_text(html: str) -> str:
    pieces = []
    for item in PUSH.findall(html):
        try:
            pieces.append(json.loads('"' + item + '"'))
        except json.JSONDecodeError as exc:
            raise ParseMiss('content page payload is not JSON') from exc
    if not pieces:
        raise ParseMiss('content page has no embedded payload')
    return ''.join(pieces)


def absolute(url: str, page: str | None = None) -> str:
    text = (url or '').replace('&amp;', '&').strip()
    if text.startswith('//'):
        text = 'https:' + text
    elif text.startswith('/'):
        text = 'https://racing.hkjc.com' + text
    elif text.startswith('http://'):
        text = 'https://' + text[len('http://'):]
    elif text.startswith('https://'):
        pass
    elif page:
        text = urljoin(page, text)
    else:
        raise ParseMiss(f'path {url!r} is not an official url')
    host = text.split('/')[2] if text.startswith('https://') and text.count('/') >= 2 else ''
    if host not in ('racing.hkjc.com', 'www.hkjc.com', 'consvc.hkjc.com', 'mcs.hkjc.com'):
        raise IdentityError(f'path host {host or text!r} is not official')
    return text


def is_pdf(url: str) -> bool:
    path, _, query = url.lower().partition('?')
    if path.endswith('.pdf'):
        return True
    filename = ''
    for part in query.split('&'):
        if part.startswith('filename='):
            filename = part.split('=', 1)[1]
    return filename.endswith('.pdf')


def hkt_stamp(epoch_ms: str, label: str) -> str:
    if not re.fullmatch(r'\d{13}', epoch_ms):
        raise ParseMiss(f'{label} is not an official timestamp')
    moment = datetime.fromtimestamp(int(epoch_ms) / 1000, tz=timezone.utc).astimezone(HKT)
    if moment.microsecond or moment.second:
        raise ParseMiss(f'{label} is not a whole minute')
    return moment.replace(microsecond=0).isoformat()


def ymd_stamp(value: str, label: str) -> str:
    match = re.fullmatch(r'(\d{2})(\d{2})(\d{2})', value)
    if not match:
        raise ParseMiss(f'{label} {value!r} is not YYMMDD')
    year = 2000 + int(match.group(1))
    try:
        return date(year, int(match.group(2)), int(match.group(3))).isoformat()
    except ValueError as exc:
        raise ParseMiss(f'{label} {value!r} is not a calendar day') from exc


def ymd_digits(value: str, label: str) -> str:
    match = re.fullmatch(r'(\d{4})(\d{2})(\d{2})', value)
    if not match:
        raise ParseMiss(f'{label} {value!r} is not YYYYMMDD')
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3))).isoformat()
    except ValueError as exc:
        raise ParseMiss(f'{label} {value!r} is not a calendar day') from exc


def parse_stats_centre(flight: str, digest: str, scraped_at: str) -> list[dict]:
    if '"name":"StatsCentre"' not in flight or '賽日數據' not in flight:
        raise ParseMiss('stats centre payload is not the official poster page')
    end = re.search(r'"endDateTime":\{"dateValue":(\d+)\}', flight)
    last = re.search(r'"lastUpdateDateTime":\{"dateValue":(\d+)\}', flight)
    images = {
        'whos_hot': re.search(r'"whosHot":\{"src":"([^"]+)"\}', flight),
        'raceday_stats': re.search(r'"racedayStats":\{"src":"([^"]+)"\}', flight),
    }
    if not end or not last or any(item is None for item in images.values()):
        raise ParseMiss('stats centre payload is missing a poster or a window')
    window_end = hkt_stamp(end.group(1), 'stats window end')
    last_update = hkt_stamp(last.group(1), 'stats last update')
    rows = []
    poster_dates = set()
    for slot, match in images.items():
        src = match.group(1).replace('&amp;', '&')
        if src.startswith('//'):
            src = 'https:' + src
        parsed = STATS_IMAGE.fullmatch(src)
        if not parsed:
            raise ParseMiss(f'stats poster {src!r} is not an official JPEG path')
        expected = 'hot' if slot == 'whos_hot' else 'stats'
        if parsed.group('slot') != expected:
            raise IdentityError(f'stats slot {slot} points at {parsed.group("slot")}')
        poster = ymd_stamp(parsed.group('stamp'), 'stats poster')
        folder = parsed.group('folder')
        if folder != poster[:4] + poster[5:7]:
            raise IdentityError(f'stats folder {folder} does not match {poster}')
        poster_dates.add(poster)
        rows.append({
            'slot': slot, 'poster_date': poster, 'window_end': window_end, 'last_update': last_update,
            'image_path': src, 'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if len(poster_dates) != 1:
        raise IdentityError('stats posters are not the same raceday')
    return rows


def rating_columns(container) -> list[list[str]]:
    tables = container.select('table.report_body_small')
    if len(tables) not in (1, 2):
        raise ParseMiss(f'rating board has {len(tables)} columns')
    parsed = []
    for table in tables:
        rows = []
        for tr in table.find_all('tr'):
            cells = [collapse(cell.get_text(' ', strip=True)) for cell in tr.find_all('td', recursive=False)]
            if not cells or cells[0] == 'Name' or (len(cells) > 1 and cells[1] == 'Name'):
                continue
            rows.append(cells)
        if not rows:
            raise ParseMiss('rating column has a header and no horses')
        parsed.append(rows)
    if len(parsed) == 1:
        return parsed[0]
    left, right = parsed
    if abs(len(left) - len(right)) > 1:
        raise ParseMiss('rating columns are not one visual list')
    ordered = []
    for index in range(max(len(left), len(right))):
        if index < len(left):
            ordered.append(left[index])
        if index < len(right):
            ordered.append(right[index])
    return ordered


def rating_change(value: str, brand: str) -> str | None:
    if value == '':
        return None
    if value == '*' or CHANGE.fullmatch(value):
        return value
    raise ParseMiss(f'rating change {value!r} for {brand} is not official')


def parse_rating_board(html: str, board: str, digest: str, scraped_at: str) -> tuple[list[dict], list[dict]]:
    soup = BeautifulSoup(html, 'html.parser')
    container = soup.select_one('#tbHorseList') or soup.select_one('#tbSummary')
    if container is None:
        raise ParseMiss(f'{board} rating table is not on the page')
    rows = []
    seen = set()
    for cells in rating_columns(container):
        mark = None
        if len(cells) == 6:
            mark = blank(cells[0])
            cells = cells[1:]
        if len(cells) != 5:
            raise ParseMiss(f'{board} row {cells!r} is not the rating shape')
        name_en, name_ch, brand, rating_text, change = cells
        if not BRAND.fullmatch(brand):
            raise IdentityError(f'{board} brand {brand!r} is not local')
        if brand in seen:
            raise IdentityError(f'{board} horse {brand} is repeated')
        seen.add(brand)
        if not name_en:
            raise ParseMiss(f'{board} horse {brand} has no name cell')
        if mark is not None and not MARK.fullmatch(mark):
            raise ParseMiss(f'{board} mark {mark!r} is not official')
        if not re.fullmatch(r'\d{1,3}', rating_text):
            raise ParseMiss(f'{board} rating {rating_text!r} is not official')
        rating = int(rating_text)
        if rating < 0 or rating > 200:
            raise ParseMiss(f'{board} rating {rating} is outside 0 to 200')
        rows.append({
            'board': board, 'line_no': len(rows) + 1, 'horse_code': brand, 'name_en': name_en,
            'name_ch': blank(name_ch), 'rating': rating, 'change_text': rating_change(change, brand),
            'mark_text': mark, 'trainer_name': None, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss(f'{board} rating table is empty')
    notes = []
    seen_notes = set()
    for td in soup.find_all('td'):
        text = collapse(td.get_text(' ', strip=True))
        if '比應負' not in text and not text.startswith('(1)'):
            continue
        if len(td.parent.find_all('td', recursive=False)) != 1 or text in seen_notes:
            continue
        seen_notes.add(text)
        notes.append({
            'board': board, 'line_no': len(notes) + 1, 'note_ch': text, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    marks = {row['mark_text'] for row in rows if row['mark_text']}
    if marks and not any(all(mark in note['note_ch'] for mark in marks) for note in notes):
        raise ParseMiss(f'{board} shows a mark without its official note')
    return rows, notes


def parse_top50(html: str, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(html, 'html.parser')
    table = soup.select_one('#tbTop50')
    if table is None:
        raise ParseMiss('top-50 table is not on the page')
    body = []
    for tr in table.find_all('tr'):
        cells = [collapse(cell.get_text(' ', strip=True)) for cell in tr.find_all(['td', 'th'], recursive=False)]
        if cells:
            body.append(cells)
    if not body or tuple(body[0]) != TOP_HEADERS:
        raise ParseMiss(f'top-50 headings are {body[0] if body else None!r}')
    rows = []
    seen = set()
    for cells in body[1:]:
        if len(cells) != 5:
            raise ParseMiss(f'top-50 row {cells!r} is not the official shape')
        rating_text, name_ch, name_en, brand, trainer = cells
        if not BRAND.fullmatch(brand) or brand in seen:
            raise IdentityError(f'top-50 brand {brand!r} is not a single local horse')
        seen.add(brand)
        if not name_en or not name_ch or not trainer:
            raise ParseMiss(f'top-50 horse {brand} is missing a name or trainer')
        if not re.fullmatch(r'\d{1,3}', rating_text):
            raise ParseMiss(f'top-50 rating {rating_text!r} is not official')
        rows.append({
            'board': 'tp50', 'line_no': len(rows) + 1, 'horse_code': brand, 'name_en': name_en,
            'name_ch': name_ch, 'rating': int(rating_text), 'change_text': None, 'mark_text': None,
            'trainer_name': trainer, 'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    previous = None
    for row in rows:
        if previous is not None and row['rating'] > previous:
            raise ParseMiss('top-50 ratings are not in the official order')
        previous = row['rating']
    return rows


def stakes_amount(value: str, label: str) -> int:
    if not STAKES_TEXT.fullmatch(value):
        raise ParseMiss(f'{label} {value!r} is not an official amount')
    return int(value.replace(',', ''))


def parse_stakes_board(html: str, digest: str, scraped_at: str) -> tuple[list[dict], list[dict]]:
    soup = BeautifulSoup(html, 'html.parser')
    table = soup.select_one('table.tbDataList')
    if table is None:
        raise ParseMiss('stakes table is not on the page')
    body = []
    for tr in table.find_all('tr'):
        cells = [collapse(cell.get_text(' ', strip=True)) for cell in tr.find_all(['td', 'th'], recursive=False)]
        if cells:
            body.append(cells)
    if not body or tuple(body[0]) != STAKES_HEADERS:
        raise ParseMiss('stakes headings changed')
    rows = []
    seen = set()
    for cells in body[1:]:
        if len(cells) != 12:
            raise ParseMiss(f'stakes row has {len(cells)} cells')
        name_ch, name_en, brand = cells[0], cells[1], cells[2]
        if not BRAND.fullmatch(brand) or brand in seen:
            raise IdentityError(f'stakes brand {brand!r} is not a single local horse')
        seen.add(brand)
        numbers = [stakes_amount(value, f'{brand} stakes') for value in cells[3:]]
        rows.append({
            'line_no': len(rows) + 1, 'horse_code': brand, 'name_ch': blank(name_ch), 'name_en': blank(name_en),
            'wins': numbers[0], 'seconds': numbers[1], 'thirds': numbers[2], 'fourths': numbers[3],
            'fifths': numbers[4], 'starts': numbers[5], 'local_stakes': numbers[6],
            'overseas_stakes': numbers[7], 'total_stakes': numbers[8], 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss('stakes table has a header and no horses')
    notes = []
    seen_notes = set()
    for node in soup.find_all(['p', 'td', 'div']):
        if node.find(['p', 'td', 'div', 'table']):
            continue
        parts = []
        for child in node.children:
            if getattr(child, 'name', None) == 'br':
                parts.append('\n')
            else:
                parts.append(child.get_text(' ', strip=True) if hasattr(child, 'get_text') else str(child))
        for line in ''.join(parts).split('\n'):
            text = collapse(line)
            if text in seen_notes or not re.fullmatch(r'[*#%] \S.{0,120}', text):
                continue
            seen_notes.add(text)
            notes.append({
                'line_no': len(notes) + 1, 'note_ch': text, 'not_race_result': 1,
                'source_sha256': digest, 'scraped_at': scraped_at,
            })
    for symbol, meaning in (('*', '本地'), ('#', '特別'), ('%', '海外')):
        if not any(note['note_ch'].startswith(symbol) and meaning in note['note_ch'] for note in notes):
            raise ParseMiss(f'stakes legend is missing the {symbol} note')
    return rows, notes


def news_file_identity(tag: str, ext: str, lang: str, view_code: str) -> tuple[str | None, str | None]:
    """Return venue and simulcast code for an official notice filename."""
    if ext == 'xml.zip':
        if lang != 'S':
            raise IdentityError(f'{view_code} xml notice is not the S file')
        if tag == 'HV0000':
            return 'HV', None
        if tag == 'ST0000':
            return 'ST', None
        if tag == '000000':
            return None, None
        simulcast = re.fullmatch(r'(S[1-4])0000', tag)
        if simulcast:
            return None, simulcast.group(1)
        raise ParseMiss(f'{view_code} xml tag {tag} is not official')
    if ext not in ('doc', 'docx') or lang != 'C' or not re.fullmatch(r'\d{6}', tag):
        raise ParseMiss(f'{view_code} document {tag}.{ext} is not official')
    hour, minute, second = int(tag[0:2]), int(tag[2:4]), int(tag[4:6])
    if hour > 23 or minute > 59 or second > 59:
        raise ParseMiss(f'{view_code} document clock {tag} is not a time')
    return None, None


def view_matches_folder(view_code: str, folder: str) -> bool:
    segment = view_code.split('/')[-1].lower()
    folder_l = folder.lower()
    return segment == folder_l or segment == 'c_' + folder_l


def parse_news_index(html: str, view_code: str, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(html, 'html.parser')
    rows = []
    for tr in soup.select('tr.list'):
        link = tr.find('a', href=True)
        if link is None:
            continue
        title = collapse(link.get_text(' ', strip=True))
        stamped = re.fullmatch(r'(.+?) \((\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})\)', title)
        if not stamped:
            raise ParseMiss(f'{view_code} title {title!r} has no official clock')
        try:
            published = datetime(
                int(stamped.group(2)), int(stamped.group(3)), int(stamped.group(4)),
                int(stamped.group(5)), int(stamped.group(6)), int(stamped.group(7)), tzinfo=HKT,
            )
        except ValueError as exc:
            raise ParseMiss(f'{view_code} clock is not a real time') from exc
        href = link['href'].replace('&amp;', '&')
        parsed = NEWS_FILE.fullmatch(href)
        if not parsed:
            raise ParseMiss(f'{view_code} artifact {href!r} is not an official file')
        if parsed.group('code').lower() != parsed.group('folder').lower():
            raise IdentityError(f'{view_code} file code does not match its folder')
        if not view_matches_folder(view_code, parsed.group('folder')):
            raise IdentityError(f'{view_code} does not match folder {parsed.group("folder")}')
        tag = parsed.group('tag')
        ext = parsed.group('ext').lower()
        lang = parsed.group('lang').upper()
        venue, simulcast = news_file_identity(tag, ext, lang, view_code)
        overseas = re.search(r'海外賽事 - (S[1-4])', stamped.group(1))
        if overseas:
            if simulcast != overseas.group(1):
                raise IdentityError(f'{view_code} overseas label does not match {tag}')
        elif simulcast:
            raise IdentityError(f'{view_code} local title points at {tag}')
        number = collapse(tr.find('td').get_text(' ', strip=True))
        if number != f'{len(rows) + 1}.':
            raise ParseMiss(f'{view_code} line number {number!r} is out of order')
        rows.append({
            'view_code': view_code, 'line_no': len(rows) + 1, 'title_ch': title,
            'published_at': published.isoformat(), 'artifact_path': absolute(href),
            'file_date': ymd_digits(parsed.group('day'), view_code), 'file_tag': tag,
            'venue': venue, 'simulcast_code': simulcast, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss(f'{view_code} notice list is empty')
    return rows


def parse_news_document(html: str, view_code: str, file_name: str, digest: str, scraped_at: str) -> list[dict]:
    named = re.fullmatch(r'(\d{8})_\d{6}_C_AHRL\.htm', file_name)
    if not named:
        raise ParseMiss(f'{view_code} snapshot {file_name!r} is not the official file')
    soup = BeautifulSoup(html, 'html.parser')
    rows = []
    for paragraph in soup.find_all('p'):
        text = collapse(paragraph.get_text(' ', strip=True))
        if not text:
            continue
        rows.append({
            'view_code': view_code, 'block_no': len(rows) + 1, 'kind': 'paragraph', 'text_ch': text,
            'asset_path': None, 'file_name': file_name, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    pdfs = []
    for link in soup.find_all('a', href=True):
        href = absolute(link['href'])
        if not is_pdf(href):
            continue
        if named.group(1) not in href:
            raise IdentityError(f'{view_code} pdf {href} is not {named.group(1)}')
        pdfs.append((collapse(link.get_text(' ', strip=True)), href))
    if not pdfs:
        raise ParseMiss(f'{view_code} snapshot has no PDF')
    for label, href in pdfs:
        rows.append({
            'view_code': view_code, 'block_no': len(rows) + 1, 'kind': 'pdf', 'text_ch': label or None,
            'asset_path': href, 'file_name': file_name, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    prose = ' '.join(row['text_ch'] or '' for row in rows if row['kind'] == 'paragraph')
    if '評分' not in prose or f"{int(named.group(1)[6:8])}/{int(named.group(1)[4:6])}/{named.group(1)[:4]}" not in prose:
        raise IdentityError(f'{view_code} snapshot text does not carry its file date')
    return rows


def news_views(html: str) -> list[str]:
    found = []
    for match in re.findall(r'View=([A-Za-z]+/[A-Za-z0-9_]+)/?', html):
        if match not in found:
            found.append(match)
    if set(found) != REQUIRED_NEWS_VIEWS:
        missing = sorted(REQUIRED_NEWS_VIEWS - set(found))
        extra = sorted(set(found) - REQUIRED_NEWS_VIEWS)
        raise ParseMiss(f'horse news views changed missing={missing} extra={extra}')
    return found


def main_content(flight: str) -> str:
    start = flight.find('<div class="mainContent')
    if start < 0:
        raise ParseMiss('import page has no main content')
    depth = 0
    for match in re.finditer(r'</?div\b[^>]*>', flight[start:], flags=re.I):
        depth += -1 if match.group(0).lower().startswith('</') else 1
        if depth == 0:
            return flight[start:start + match.end()]
    raise ParseMiss('import main content does not close')


def inside_leaf_table(node) -> bool:
    parent = node.find_parent('table')
    return parent is not None and parent.find('table') is None


def parse_import_page(html: str, page_code: str, page_url: str, digest: str, scraped_at: str) -> list[dict]:
    if page_code not in ('pps', 'ppgs'):
        raise IdentityError(f'import page {page_code} is not official')
    flight = flight_text(html)
    content = BeautifulSoup(main_content(flight), 'html.parser')
    rows = []

    def add(kind: str, block_no: int, row_no: int, col_no: int, text: str | None, path: str | None) -> None:
        rows.append({
            'page_code': page_code, 'kind': kind, 'block_no': block_no, 'row_no': row_no, 'col_no': col_no,
            'text_ch': text, 'asset_path': path, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })

    images = []
    for match in re.findall(r'//consvc\.hkjc\.com/-/media/Sites/JCRW/Page/[^"\\]+\.(?:gif|jpg)\?[^"\\]+', flight):
        path = absolute(match)
        if 'import_critieria' in path and path not in images:
            images.append(path)
    if len(images) != 1:
        raise ParseMiss(f'{page_code} title image count is {len(images)}')
    add('image', 1, 0, 0, None, images[0])

    exams = []
    for match in re.finditer(
        r'"link":\{"value":"([^"]+)"\}(?:,"[^"]+":\{[^{}]{0,80}\}){0,4},"label":\{"value":"馬匹進口前體格檢驗規定"\}',
        flight,
    ):
        path = absolute(match.group(1), page_url)
        if not is_pdf(path):
            raise ParseMiss(f'{page_code} exam link is not a PDF')
        if path not in exams:
            exams.append(path)
    soup = BeautifulSoup(html, 'html.parser')
    for link in soup.find_all('a', href=True):
        if collapse(link.get_text(' ', strip=True)) != '馬匹進口前體格檢驗規定':
            continue
        path = absolute(link['href'], page_url)
        if not is_pdf(path):
            raise ParseMiss(f'{page_code} exam link is not a PDF')
        if path not in exams:
            exams.append(path)
    if not exams:
        raise ParseMiss(f'{page_code} page has no pre-import exam PDF')
    for index, path in enumerate(exams, start=1):
        add('exam_pdf', index, 0, 0, '馬匹進口前體格檢驗規定', path)

    tabs = []
    for link in content.find_all('a', href=True):
        href = link['href']
        if 'import-critieria' not in href:
            continue
        label = collapse(link.get_text(' ', strip=True))
        path = absolute(href, page_url)
        if label and (label, path) not in tabs:
            tabs.append((label, path))
    if not tabs:
        raise ParseMiss(f'{page_code} page has no import tabs')
    for index, (label, path) in enumerate(tabs, start=1):
        add('tab', index, 0, 0, label, path)

    paragraph_no = 0
    for paragraph in content.find_all('p'):
        if inside_leaf_table(paragraph):
            continue
        text = collapse(paragraph.get_text(' ', strip=True))
        if not text:
            continue
        paragraph_no += 1
        add('paragraph', paragraph_no, 0, 0, text, None)
    if paragraph_no == 0 or not any('進口' in (row['text_ch'] or '') for row in rows if row['kind'] == 'paragraph'):
        raise ParseMiss(f'{page_code} policy text is missing')

    table_no = 0
    for table in content.find_all('table'):
        if table.find('table') is not None:
            continue
        table_no += 1
        row_no = 0
        for tr in table.find_all('tr'):
            cells = [collapse(cell.get_text(' ', strip=True)) for cell in tr.find_all(['td', 'th'], recursive=False)]
            if not any(cells):
                continue
            row_no += 1
            for col_no, text in enumerate(cells, start=1):
                add('table_cell', table_no, row_no, col_no, text or None, None)
        if row_no == 0:
            raise ParseMiss(f'{page_code} table {table_no} is empty')
    if table_no == 0:
        raise ParseMiss(f'{page_code} policy has no table')
    return rows


def direct_cells(tr) -> list:
    return tr.find_all('td', recursive=False)


def horse_link(cell) -> tuple[str, str, str]:
    link = cell.find('a', href=True)
    if link is None:
        raise IdentityError('racecard horse has no profile link')
    match = re.search(r'horseid=(HK_\d{4}_[A-Z]\d{3})', link['href'])
    if not match:
        raise IdentityError('racecard horse link is not local')
    horse_id = match.group(1)
    brand = HORSE_ID.fullmatch(horse_id).group(1)
    return horse_id, brand, collapse(link.get_text(' ', strip=True))


def season_stakes(value: str, brand: str) -> int | None:
    text = blank(value)
    if text is None:
        return None
    if not STAKES_TEXT.fullmatch(text):
        raise ParseMiss(f'{brand} season stakes {value!r} is not official')
    return int(text.replace(',', ''))


def runner_age(value: str, brand: str) -> int | None:
    text = blank(value)
    if text is None:
        return None
    if not re.fullmatch(r'\d{1,2}', text):
        raise ParseMiss(f'{brand} age {value!r} is not official')
    age = int(text)
    if age < 2 or age > 15:
        raise ParseMiss(f'{brand} age {age} is outside 2 to 15')
    return age


def runner_sex(value: str, brand: str) -> str | None:
    text = blank(value)
    if text is None:
        return None
    if not SEX.fullmatch(text):
        raise ParseMiss(f'{brand} sex {value!r} is not an official label')
    return text


def runner_import(value: str, brand: str) -> str | None:
    text = blank(value)
    if text is None:
        return None
    if not IMPORT_TYPE.fullmatch(text):
        raise ParseMiss(f'{brand} import type {value!r} is not official')
    return text


def header_facts(html: str, meeting_date: str, venue: str, race_no: int) -> dict | None:
    block = re.search(r'class="f_fs13"[\s\S]{0,2500}?</div>', html)
    if not block:
        return None
    raw = block.group(0).replace('&quot;', '"').replace('&#34;', '"')
    text = collapse(BeautifulSoup(raw, 'html.parser').get_text(' ', strip=True))
    if not re.search(rf'第\s*{race_no}\s*場', text):
        return None
    year, month, day = (int(part) for part in meeting_date.split('-'))
    if f'{year}年{month}月{day}日' not in text or VENUE_NAME[venue] not in text:
        raise IdentityError(f'racecard header is not {meeting_date} {venue} race {race_no}')
    turf = re.search(r'(草地|泥地|沙地).*?(\d{3,4})\s*米', text)
    awt = re.search(r'(全天候)跑道?.*?(\d{3,4})\s*米', text)
    if turf and awt:
        raise ParseMiss('racecard header names two surfaces')
    if turf:
        if turf.group(1) != '草地':
            raise ParseMiss(f'racecard surface {turf.group(1)} has no verified map letter')
        return {'track': '草地', 'distance': int(turf.group(2))}
    if awt:
        return {'track': '全天候', 'distance': int(awt.group(2))}
    raise ParseMiss('racecard header has 場次 but no distance')


def parse_racecard_page(
    html: str, meeting_date: str, venue: str, race_no: int, digest: str, scraped_at: str,
) -> tuple[list[dict], list[dict]]:
    facts = header_facts(html, meeting_date, venue, race_no)
    soup = BeautifulSoup(html, 'html.parser')
    starter = None
    for table in soup.find_all('table'):
        if 'starter' in (table.get('class') or []):
            starter = table
            break
    if facts is None and starter is None:
        raise BoardPending(f'{meeting_date} {venue} race {race_no} card is not published')
    if facts is None or starter is None:
        raise ParseMiss(f'{meeting_date} {venue} race {race_no} card is only half published')
    header_row = None
    data_rows = []
    for tr in starter.find_all('tr'):
        cells = direct_cells(tr)
        if not cells:
            continue
        titles = [collapse(cell.get_text(' ', strip=True)) for cell in cells]
        if titles and titles[0] == '馬匹編號':
            header_row = titles
            continue
        if titles and re.fullmatch(r'\d+', titles[0] or ''):
            data_rows.append(cells)
    if header_row != list(STARTER_HEADERS):
        raise ParseMiss(f'racecard columns changed: {header_row}')
    runners = []
    seen = set()
    for cells in data_rows:
        if len(cells) != len(STARTER_HEADERS):
            raise ParseMiss(f'racecard row has {len(cells)} cells')
        horse_no = int(collapse(cells[0].get_text(' ', strip=True)))
        horse_id, linked_brand, horse_name = horse_link(cells[3])
        brand = collapse(cells[4].get_text(' ', strip=True))
        if brand != linked_brand or not BRAND.fullmatch(brand):
            raise IdentityError(f'racecard horse {horse_no} brand {brand} disagrees with {horse_id}')
        if horse_no in seen:
            raise IdentityError(f'racecard horse number {horse_no} is repeated')
        seen.add(horse_no)
        if not horse_name:
            raise ParseMiss(f'racecard horse {horse_no} has no name')
        runners.append({
            'meeting_date': meeting_date, 'venue': venue, 'race_no': race_no, 'horse_no': horse_no,
            'is_reserve': 0, 'horse_id': horse_id, 'brand_no': brand, 'horse_name': horse_name,
            'age': runner_age(cells[16].get_text(' ', strip=True), brand),
            'sex': runner_sex(cells[18].get_text(' ', strip=True), brand),
            'season_stakes': season_stakes(cells[19].get_text(' ', strip=True), brand),
            'owner': blank(cells[23].get_text(' ', strip=True)),
            'sire': blank(cells[24].get_text(' ', strip=True)),
            'dam': blank(cells[25].get_text(' ', strip=True)),
            'import_type': runner_import(cells[26].get_text(' ', strip=True), brand),
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not runners:
        raise ParseMiss(f'{meeting_date} race {race_no} starter table has no runners')

    standby = soup.select_one('#standbylist')
    if standby is not None:
        reserve_seen = set()
        opened = False
        for tr in standby.find_all('tr'):
            cells = direct_cells(tr)
            titles = [collapse(cell.get_text(' ', strip=True)) for cell in cells]
            if titles and titles[0] == '編號':
                if titles != list(STANDBY_HEADERS):
                    raise ParseMiss(f'standby columns changed: {titles}')
                opened = True
                continue
            if not titles or not re.fullmatch(r'\d+', titles[0] or ''):
                continue
            if not opened or len(cells) != len(STANDBY_HEADERS):
                raise ParseMiss('standby row is not the official shape')
            horse_no = int(titles[0])
            horse_id, brand, horse_name = horse_link(cells[1])
            if horse_no in reserve_seen or not horse_name:
                raise IdentityError(f'standby horse {horse_no} is repeated or unnamed')
            reserve_seen.add(horse_no)
            runners.append({
                'meeting_date': meeting_date, 'venue': venue, 'race_no': race_no, 'horse_no': horse_no,
                'is_reserve': 1, 'horse_id': horse_id, 'brand_no': brand, 'horse_name': horse_name,
                'age': runner_age(cells[5].get_text(' ', strip=True), brand),
                'sex': None, 'season_stakes': None, 'owner': None, 'sire': None, 'dam': None, 'import_type': None,
                'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
            })

    files = racecard_files(soup, meeting_date, venue, race_no, facts, digest, scraped_at)
    return runners, files


def racecard_files(soup, meeting_date: str, venue: str, race_no: int, facts: dict, digest: str, scraped_at: str) -> list[dict]:
    day = meeting_date.replace('-', '')
    pdfs = []
    for link in soup.find_all('a', href=True):
        href = link['href'].replace('&amp;', '&')
        if '/racing/content/PDF/RaceCard/' not in href:
            continue
        if href not in pdfs:
            pdfs.append(href)
    race_pdf = None
    all_pdf = None
    for href in pdfs:
        parsed = PDF_PATH.fullmatch(href)
        if not parsed:
            raise ParseMiss(f'starter pdf {href!r} is not an official path')
        if parsed.group('day') != day:
            raise IdentityError(f'starter pdf {href} is not {meeting_date}')
        if parsed.group('race'):
            if int(parsed.group('race')) != race_no:
                raise IdentityError(f'starter pdf {href} is not race {race_no}')
            if race_pdf:
                raise ParseMiss('racecard has two race PDFs')
            race_pdf = href
        else:
            if all_pdf:
                raise ParseMiss('racecard has two meeting PDFs')
            all_pdf = href
    if not race_pdf or not all_pdf:
        raise ParseMiss(f'{meeting_date} race {race_no} is missing a starter PDF')

    maps = []
    for img in soup.find_all('img'):
        src = img.get('src') or ''
        match = re.search(r'/racing/content/Chinese/RaceCourse/([a-z0-9]+)_s\.gif$', src)
        if not match:
            continue
        parent = img.find_parent('a')
        href = (parent.get('href') if parent else '') or ''
        maps.append((match.group(1), src, href.replace('&amp;', '&')))
    if len(maps) != 1:
        raise ParseMiss(f'{meeting_date} race {race_no} track map count is {len(maps)}')
    stem, thumb, full = maps[0]
    parsed = MAP_STEM.fullmatch(stem)
    if not parsed:
        raise ParseMiss(f'track map {stem!r} is not an official stem')
    if parsed.group(1) != venue.lower() or int(parsed.group(3)) != facts['distance']:
        raise IdentityError(f'track map {stem} is not {venue} {facts["distance"]}m')
    letter = parsed.group(2)
    if facts['track'] == '草地' and letter != 't':
        raise IdentityError(f'turf map letter {letter} is not t')
    if facts['track'] == '全天候' and letter == 't':
        raise IdentityError('all-weather map uses the turf letter')
    expected_full = f'filename={stem}_h.gif'
    if expected_full not in full:
        raise IdentityError(f'track map link {full!r} does not match {stem}')
    common = {
        'meeting_date': meeting_date, 'venue': venue, 'not_race_result': 1,
        'source_sha256': digest, 'scraped_at': scraped_at,
    }
    return [
        {**common, 'race_no': race_no, 'kind': 'starter_pdf', 'artifact_path': absolute(race_pdf), 'distance': None, 'surface_code': None},
        {**common, 'race_no': 0, 'kind': 'starter_pdf_all', 'artifact_path': absolute(all_pdf), 'distance': None, 'surface_code': None},
        {**common, 'race_no': race_no, 'kind': 'track_map_thumb', 'artifact_path': absolute(thumb), 'distance': facts['distance'], 'surface_code': letter},
        {**common, 'race_no': race_no, 'kind': 'track_map', 'artifact_path': absolute(full), 'distance': facts['distance'], 'surface_code': letter},
    ]


def data_dir(root: Path) -> Path:
    path = root / 'data' / 'official_wave7'
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n', quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: '' if row.get(column) is None else row[column] for column in columns})


def read_csv(path: Path, columns: list[str]) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != columns:
            raise IdentityError(f'{path.name} columns changed')
        return [dict(row) for row in reader]


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = data_dir(root) / 'manifest.jsonl'
    line = json.dumps(
        {'surface': surface, 'sha256': digest, 'scraped_at': scraped_at, 'rows': row_count},
        ensure_ascii=False, sort_keys=True,
    )
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def sql_literal(value) -> str:
    if value is None or value == '':
        return 'NULL'
    text = str(value)
    return "'" + text.replace("'", "''") + "'"


def sql_value(column: str, raw: str) -> str:
    if raw == '':
        return 'NULL'
    if column in INTEGER_COLUMNS:
        if not re.fullmatch(r'-?\d+', raw or ''):
            raise IdentityError(f'{column} is not a stored number')
        return str(int(raw))
    return sql_literal(raw)


def emit_sql(root: Path) -> str:
    base = data_dir(root)
    statements = ['-- generated from data/official_wave7; official board upsert, not a model input']
    for table, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        if not rows:
            continue
        sql_table = 'official_' + table
        if table in REPLACE_ALL:
            statements.append(f'DELETE FROM {sql_table};')
        elif table in MEETING_KEYS:
            meetings = sorted({(row['meeting_date'], row['venue']) for row in rows})
            for meeting_date, venue in meetings:
                statements.append(
                    f"DELETE FROM {sql_table} WHERE meeting_date = {sql_literal(meeting_date)} AND venue = {sql_literal(venue)};"
                )
        for row in rows:
            values = [sql_value(column, row.get(column, '')) for column in columns]
            statements.append(
                f"INSERT INTO {sql_table} ({', '.join(columns)}) VALUES ({', '.join(values)});"
            )
    return '\n'.join(statements) + '\n'


def fixtures(root: Path) -> list[dict]:
    path = root / 'data' / 'fixtures' / 'fixtures.csv'
    if not path.exists():
        raise IdentityError('fixtures.csv is missing')
    with path.open(encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def upcoming_fixtures(root: Path, today: date) -> list[dict]:
    end = (today + timedelta(days=CARD_WINDOW_DAYS)).isoformat()
    rows = []
    for row in fixtures(root):
        if row.get('venue') not in ('ST', 'HV'):
            continue
        meeting = row.get('date') or ''
        if not (today.isoformat() <= meeting <= end):
            continue
        if not re.fullmatch(r'\d+', row.get('race_count') or ''):
            continue
        rows.append(row)
    return rows


def merge_meetings(old_rows: list[dict], new_rows: list[dict]) -> list[dict]:
    fresh = {(row['meeting_date'], row['venue']) for row in new_rows}
    kept = [row for row in old_rows if (row['meeting_date'], row['venue']) not in fresh]
    return kept + new_rows


def classify_news(html: str) -> str:
    soup = BeautifulSoup(html, 'html.parser')
    if soup.select_one('#tbHorseList') or soup.select_one('#tbSummary'):
        return 'rating'
    if soup.select_one('#tbTop50'):
        return 'top50'
    if soup.select_one('table.tbDataList'):
        return 'stakes'
    if soup.select('tr.list a[href]'):
        return 'index'
    if soup.select_one('iframe[src*="ShowHtmlIFrame"]'):
        return 'document'
    raise ParseMiss('horse news view is not a table, a notice list, or a snapshot')


def collect_news(scraped_at: str) -> dict[str, tuple[list[dict], str]]:
    index_raw = fetch_bytes(SITE + '/zh-hk/local/information/latestonhorse')
    index_html = index_raw.decode('utf-8', errors='replace')
    if '馬匹消息' not in index_html:
        raise ParseMiss('horse news index is not the official page')
    views = news_views(index_html)
    ratings: list[dict] = []
    rating_notes: list[dict] = []
    stakes: list[dict] = []
    stakes_notes: list[dict] = []
    notices: list[dict] = []
    documents: list[dict] = []
    digests = [sha256(index_raw)]
    for view in views:
        raw = fetch_bytes(SITE + '/racing/info/mcs/Chinese/' + view)
        html = raw.decode('utf-8', errors='replace')
        digest = sha256(raw)
        digests.append(digest)
        kind = classify_news(html)
        if kind == 'rating':
            board = RATING_BOARDS.get(view)
            if board is None:
                raise ParseMiss(f'{view} rating table is not a known board')
            rows, notes = parse_rating_board(html, board, digest, scraped_at)
            ratings.extend(rows)
            rating_notes.extend(notes)
        elif kind == 'top50':
            if view != 'Horses/tp50':
                raise ParseMiss(f'{view} is a top-50 table')
            ratings.extend(parse_top50(html, digest, scraped_at))
        elif kind == 'stakes':
            if view != 'Horses/smon':
                raise ParseMiss(f'{view} is a stakes table')
            rows, notes = parse_stakes_board(html, digest, scraped_at)
            stakes.extend(rows)
            stakes_notes.extend(notes)
        elif kind == 'index':
            notices.extend(parse_news_index(html, view, digest, scraped_at))
        else:
            soup = BeautifulSoup(html, 'html.parser')
            iframe = soup.select_one('iframe[src*="ShowHtmlIFrame"]')
            src = absolute(iframe['src'], SITE + '/')
            file_name = re.search(r'FileName=([^&]+)', src)
            if not file_name:
                raise ParseMiss(f'{view} snapshot iframe has no file name')
            inner = fetch_bytes(src)
            documents.extend(parse_news_document(
                inner.decode('utf-8', errors='replace'), view, file_name.group(1), sha256(inner), scraped_at,
            ))
            digests.append(sha256(inner))
    if not any(row['board'] == 'clas' for row in ratings):
        raise ParseMiss('horse rating list was not on Horses/clas')
    digest = hashlib.sha256(''.join(digests).encode()).hexdigest()
    return {
        'horse_rating': (ratings, digest),
        'horse_rating_note': (rating_notes, digest),
        'horse_stakes': (stakes, digest),
        'horse_stakes_note': (stakes_notes, digest),
        'horse_news': (notices, digest),
        'horse_news_document': (documents, digest),
    }


def collect_racecard(root: Path, scraped_at: str) -> tuple[list[dict], list[dict], str]:
    today = datetime.now(HKT).date()
    runners: list[dict] = []
    files: list[dict] = []
    digests = []
    for fixture in upcoming_fixtures(root, today):
        meeting_date = fixture['date']
        venue = fixture['venue']
        race_count = int(fixture['race_count'])
        meeting_runners: list[dict] = []
        meeting_files: list[dict] = []
        pending = False
        for race_no in range(1, race_count + 1):
            url = (
                f'{SITE}/zh-hk/local/information/racecard?racedate='
                f'{meeting_date[0:4]}/{meeting_date[5:7]}/{meeting_date[8:10]}&Racecourse={venue}&RaceNo={race_no}'
            )
            raw = fetch_bytes(url)
            digest = sha256(raw)
            try:
                parsed_runners, parsed_files = parse_racecard_page(
                    raw.decode('utf-8', errors='replace'), meeting_date, venue, race_no, digest, scraped_at,
                )
            except BoardPending:
                if meeting_runners:
                    raise IdentityError(f'{meeting_date} {venue} race {race_no} dropped off a published card')
                pending = True
                break
            meeting_runners.extend(parsed_runners)
            meeting_files.extend(parsed_files)
            digests.append(digest)
        if pending:
            continue
        all_pdfs = {row['artifact_path'] for row in meeting_files if row['kind'] == 'starter_pdf_all'}
        if len(all_pdfs) != 1:
            raise IdentityError(f'{meeting_date} {venue} meeting PDF is not one file')
        kept_files = []
        seen_all = False
        for row in meeting_files:
            if row['kind'] == 'starter_pdf_all':
                if seen_all:
                    continue
                seen_all = True
            kept_files.append(row)
        runners.extend(meeting_runners)
        files.extend(kept_files)
    digest = hashlib.sha256(''.join(digests).encode()).hexdigest() if digests else sha256(b'pending')
    old_runners = read_csv(data_dir(root) / FILES['racecard_runner'][0], RUNNER_COLUMNS)
    old_files = read_csv(data_dir(root) / FILES['racecard_file'][0], FILE_COLUMNS)
    return merge_meetings(old_runners, runners), merge_meetings(old_files, files), digest


def collect_import(scraped_at: str) -> tuple[list[dict], str]:
    rows = []
    digests = []
    for page_code in ('pps', 'ppgs'):
        url = f'{SITE}/zh-hk/local/page/{page_code}-import-critieria'
        raw = fetch_bytes(url)
        digests.append(sha256(raw))
        rows.extend(parse_import_page(raw.decode('utf-8', errors='replace'), page_code, url, sha256(raw), scraped_at))
    return rows, hashlib.sha256(''.join(digests).encode()).hexdigest()


def collect(root: Path, surfaces: set[str]) -> dict[str, int]:
    scraped_at = scraped_now()
    summary = {}
    if 'stats' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/page/stats-centre')
        rows = parse_stats_centre(flight_text(raw.decode('utf-8', errors='replace')), sha256(raw), scraped_at)
        write_csv(data_dir(root) / FILES['stats_centre_image'][0], STATS_COLUMNS, rows)
        append_manifest(root, 'stats', sha256(raw), scraped_at, len(rows))
        summary['stats'] = len(rows)
    if 'horse-news' in surfaces:
        boards = collect_news(scraped_at)
        for key, (rows, digest) in boards.items():
            write_csv(data_dir(root) / FILES[key][0], FILES[key][1], rows)
            summary[key] = len(rows)
        append_manifest(root, 'horse-news', boards['horse_news'][1], scraped_at, summary['horse_news'])
    if 'import' in surfaces:
        rows, digest = collect_import(scraped_at)
        write_csv(data_dir(root) / FILES['import_policy'][0], IMPORT_COLUMNS, rows)
        append_manifest(root, 'import', digest, scraped_at, len(rows))
        summary['import'] = len(rows)
    if 'racecard' in surfaces:
        runners, files, digest = collect_racecard(root, scraped_at)
        write_csv(data_dir(root) / FILES['racecard_runner'][0], RUNNER_COLUMNS, runners)
        write_csv(data_dir(root) / FILES['racecard_file'][0], FILE_COLUMNS, files)
        append_manifest(root, 'racecard', digest, scraped_at, len(runners))
        summary['racecard_runner'] = len(runners)
        summary['racecard_file'] = len(files)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Collect the next official HKJC surfaces')
    parser.add_argument('--root', default='.')
    parser.add_argument('--surfaces', default=','.join(SURFACES))
    parser.add_argument('--emit-sql', default='')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if args.emit_sql:
        Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
        return
    selected = {item.strip() for item in args.surfaces.split(',') if item.strip()}
    unknown = selected - set(SURFACES)
    if unknown:
        raise SystemExit(f'unknown surfaces: {", ".join(sorted(unknown))}')
    try:
        summary = collect(root, selected)
    except (IdentityError, ParseMiss, BoardPending) as exc:
        raise SystemExit(str(exc)) from exc
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
