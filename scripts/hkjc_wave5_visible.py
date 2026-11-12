#!/usr/bin/env python3
"""Visible official surfaces that were still uncollected after the fixture wave.

* 傷患資料庫 ovedatabase — the rolling 12-month table, not the per-horse file
* 宣佈出賽馬匹傷患紀錄 overecord — the meeting rollup linked from the menu
* 自購馬來港前賽績 — the page's own season tables, including former names on that list
* 騎師王 / 練馬師王賠率走勢 — the page's getOddsChart response
* 騎練配對及初出馬 — the workbook the page links
* 從化搬遷一覽 — the PDF the page links, for the one fixture inside its window

Rows are the public board. They are not race results, not model inputs, and not
frozen-pick inputs. A page that is not published yet is skipped. A published
page whose identity or a cell does not match is a hard failure and writes nothing.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

HKT = ZoneInfo('Asia/Hong_Kong')
SITE = 'https://racing.hkjc.com'
UA = (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
)
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
BRAND = re.compile(r'^[A-Za-z]\d{3}$')
PERSON = re.compile(r'^[A-Z][A-Z0-9]{1,5}$')
SEASON = re.compile(r'^(\d{4})-(\d{4})$')
PUSH = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
CN_DIGIT = {'零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
WEEKDAY = {'日': 6, '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5}
MONTHS = {
    'JANUARY': 1, 'FEBRUARY': 2, 'MARCH': 3, 'APRIL': 4, 'MAY': 5, 'JUNE': 6,
    'JULY': 7, 'AUGUST': 8, 'SEPTEMBER': 9, 'OCTOBER': 10, 'NOVEMBER': 11, 'DECEMBER': 12,
}
VENUE_LABEL = {'沙田': 'ST', '跑馬地': 'HV'}
RACE_LABEL = {'第一場': 1, '第二場': 2, '第三場': 3, '第四場': 4, '第五場': 5, '第六場': 6, '第七場': 7, '第八場': 8, '第九場': 9, '第十場': 10, '第十一場': 11, '第十二場': 12}
SURFACES = ('ove-database', 'ove-record', 'ppo', 'odds-chart', 'jtcombo', 'conghua')

OVE_COLUMNS = [
    'as_of_date', 'line_no', 'horse_code', 'horse_name', 'injury_date', 'detail', 'passed_date',
    'not_race_result', 'source_sha256', 'scraped_at',
]
RECORD_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'line_no', 'horse_no', 'is_reserve', 'horse_code', 'horse_name',
    'injury_date', 'detail', 'passed_date', 'not_race_result', 'source_sha256', 'scraped_at',
]
PPO_COLUMNS = [
    'season_code', 'brand_no', 'horse_name_ch', 'former_name', 'notes', 'show_play', 'season_enabled',
    'not_race_result', 'source_sha256', 'scraped_at',
]
ODDS_COLUMNS = [
    'pool', 'meeting_date', 'venue', 'winner_code', 'winner_name', 'points', 'race_no', 'odds_text',
    'chart_updated_at', 'not_race_result', 'source_sha256', 'scraped_at',
]
COMBO_COLUMNS = [
    'meeting_date', 'venue', 'section', 'race_no', 'horse_no', 'horse_name', 'import_type', 'trainer_name',
    'win_rate', 'place_rate', 'as_of_text', 'not_race_result', 'source_sha256', 'scraped_at',
]
CONGHUA_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'line_no', 'horse_no', 'is_reserve', 'horse_name_ch', 'horse_name_en',
    'arrived_date', 'returned_date', 'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'ove_database': ('ove_database.csv', OVE_COLUMNS),
    'ove_record': ('ove_record.csv', RECORD_COLUMNS),
    'ppo_performance': ('ppo_performance.csv', PPO_COLUMNS),
    'challenge_odds': ('challenge_odds.csv', ODDS_COLUMNS),
    'jt_combo': ('jt_combo.csv', COMBO_COLUMNS),
    'conghua_movement': ('conghua_movement.csv', CONGHUA_COLUMNS),
}
INTEGER_COLUMNS = {
    'line_no', 'race_no', 'horse_no', 'is_reserve', 'not_race_result', 'show_play', 'season_enabled', 'points',
}
# Rolling boards are replaced wholesale. Meeting boards replace one meeting.
REPLACE_ALL = {'ove_database', 'ppo_performance', 'challenge_odds'}
MEETING_KEYS = {'ove_record', 'jt_combo', 'conghua_movement'}


class IdentityError(ValueError):
    """The page is not the meeting or the horse it claims to be."""


class ParseMiss(ValueError):
    """A published table is not the official shape."""


class BoardPending(Exception):
    """The official page has not published this board yet."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def scraped_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def fetch_bytes(url: str, method: str = 'GET', body: bytes | None = None, headers: dict | None = None) -> bytes:
    last = None
    for attempt in range(3):
        req_headers = {'user-agent': UA, 'accept-encoding': 'identity', 'accept-language': 'zh-HK,zh;q=0.9'}
        if headers:
            req_headers.update(headers)
        req = Request(url, data=body, headers=req_headers, method=method)
        try:
            with urlopen(req, timeout=40) as response:
                host = (response.geturl() or url).split('/')[2]
                if not (host == 'consvc.hkjc.com' or host == 'info.cld.hkjc.com' or host.endswith('hkjc.com')):
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


def blank(value: str | None) -> str | None:
    text = re.sub(r'\s+', ' ', (value or '').replace('\xa0', ' ')).strip()
    if text in ('', '-', '--', '---'):
        return None
    return text


# HKJC prints 不適用 in 通過日期 when no veterinary pass is required (for example
# after gelding). It is not a date and not a missing pass; store no pass date.
PASS_NOT_REQUIRED = frozenset({'不適用'})


def passed_on(value: str | None) -> str | None:
    text = blank(value)
    if text is None or text in PASS_NOT_REQUIRED:
        return None
    return dmy(text, 'passed')


def dmy(value: str, label: str) -> str:
    match = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', (value or '').strip())
    if not match:
        raise ParseMiss(f'{label} {value!r} is not DD/MM/YYYY')
    try:
        return date(int(match.group(3)), int(match.group(2)), int(match.group(1))).isoformat()
    except ValueError as exc:
        raise ParseMiss(f'{label} {value!r} is not a calendar day') from exc


def cn_number(text: str) -> int:
    if text == '十':
        return 10
    if '十' in text:
        left, _, right = text.partition('十')
        tens = CN_DIGIT[left] if left else 1
        ones = CN_DIGIT[right] if right else 0
        return tens * 10 + ones
    if not text or any(char not in CN_DIGIT for char in text):
        raise ParseMiss(f'Chinese number {text!r} is not official')
    return int(''.join(str(CN_DIGIT[char]) for char in text))


def weekday_ok(day: date, label: str) -> None:
    match = re.search(r'星期([日一二三四五六])', label)
    if match and WEEKDAY[match.group(1)] != day.weekday():
        raise IdentityError(f'{day.isoformat()} is not 星期{match.group(1)}')


def fixtures(root: Path) -> list[dict]:
    path = root / 'data' / 'fixtures' / 'fixtures.csv'
    if not path.exists():
        raise IdentityError('fixtures.csv is missing')
    with path.open(encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def unique_fixture(root: Path, start_ms: int, end_ms: int) -> dict:
    start = datetime.fromtimestamp(start_ms / 1000, HKT).date()
    end = datetime.fromtimestamp(end_ms / 1000, HKT).date()
    if end < start:
        raise ParseMiss('content window ends before it starts')
    hits = []
    for row in fixtures(root):
        try:
            day = date.fromisoformat(row['date'])
        except ValueError as exc:
            raise IdentityError(f"fixture date {row.get('date')!r} is not ISO") from exc
        if start <= day <= end and row.get('venue') in ('ST', 'HV'):
            hits.append(row)
    if len(hits) != 1:
        raise IdentityError(f'content window {start.isoformat()}..{end.isoformat()} covers {len(hits)} local fixtures')
    count = hits[0].get('race_count') or ''
    if not re.fullmatch(r'\d+', count):
        raise IdentityError('fixture race count is empty')
    return hits[0]


def content_url(flight: str, key: str, suffix: str) -> str | None:
    found = re.findall(rf'"{key}":\{{"url":"([^"]+)"\}}', flight)
    if not found:
        return None
    if len(set(found)) != 1:
        raise IdentityError(f'{key} has more than one official file')
    url = found[0]
    if url.startswith('//'):
        url = 'https:' + url
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname != 'consvc.hkjc.com' or suffix not in parsed.path.lower():
        raise IdentityError(f'{key} is not an official {suffix} file')
    return url


def content_window(flight: str) -> tuple[int, int]:
    found = re.findall(r'"startDateTime":\{"dateValue":(\d+)\},"endDateTime":\{"dateValue":(\d+)\}', flight)
    if len(found) != 1:
        raise ParseMiss(f'content window count is {len(found)}')
    return int(found[0][0]), int(found[0][1])


def cells(row) -> list:
    return row.find_all(['td', 'th'])


def text_of(node) -> str:
    return node.get_text(' ', strip=True) if node else ''


def parse_ove_database(raw: bytes, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw.decode('utf-8', errors='replace'), 'html.parser')
    tables = soup.find_all('table')
    if len(tables) != 1:
        raise ParseMiss(f'injury database has {len(tables)} tables')
    body = tables[0].find_all('tr')
    title = text_of(body[0]) if body else ''
    as_of = re.search(r'截至\s*(\d{4})年(\d{1,2})月(\d{1,2})日', title)
    if not as_of or '過去12個月' not in title.replace(' ', ''):
        raise ParseMiss('injury database title is not the 12-month board')
    try:
        as_of_date = date(int(as_of.group(1)), int(as_of.group(2)), int(as_of.group(3)))
    except ValueError as exc:
        raise ParseMiss('injury database as-of date is not a calendar day') from exc
    weekday_ok(as_of_date, title)
    header = [text_of(cell) for cell in cells(body[1])]
    if header[:5] != ['烙印編號', '馬名', '日期', '詳情', '通過日期']:
        raise ParseMiss('injury database header changed')
    current = None
    rows = []
    for row in body[2:]:
        values = cells(row)
        if len(values) != 5:
            raise ParseMiss('injury database row does not have five cells')
        code = blank(text_of(values[0]))
        name = blank(text_of(values[1]))
        if code or name:
            # The rolling board prints some brands with the name cell empty.
            # The brand is the identity; an empty name stays empty.
            if not code or not BRAND.fullmatch(code):
                raise IdentityError(f'injury database horse {code!r} {name!r} is incomplete')
            current = (code, name)
        elif current is None:
            raise ParseMiss('injury database detail has no horse')
        injury = dmy(text_of(values[2]), 'injury')
        detail = text_of(values[3]).strip()
        if not detail:
            raise ParseMiss('injury database detail is empty')
        passed = passed_on(text_of(values[4]))
        rows.append({
            'as_of_date': as_of_date.isoformat(), 'line_no': len(rows) + 1,
            'horse_code': current[0], 'horse_name': current[1], 'injury_date': injury, 'detail': detail,
            'passed_date': passed,
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss('injury database has a header and no rows')
    return rows


def parse_ove_record(raw: bytes, root: Path, digest: str, scraped_at: str) -> list[dict] | None:
    soup = BeautifulSoup(raw.decode('utf-8', errors='replace'), 'html.parser')
    text = soup.get_text(' ', strip=True)
    if any(phrase in text for phrase in ('資料將於稍後提供', '暫無資料', '暫時未有')):
        return None
    table = soup.find('table', class_='list')
    if table is None:
        raise ParseMiss('declared veterinary rollup is missing')
    heading = ''
    buttons = [text_of(node) for node in soup.select('a.blueBtn1') if text_of(node)]
    if len(set(buttons)) != 1:
        raise IdentityError('declared veterinary meeting button is missing or disagrees')
    button = re.fullmatch(r'(\d{1,2})月(\d{1,2})日\s*-\s*(沙田|跑馬地)', buttons[0])
    if not button:
        raise IdentityError(f'meeting button {buttons[0]!r} is not a local race day')
    rows = []
    race_no = None
    current = None
    line_no = 0
    meeting = None
    for row in table.find_all('tr'):
        values = cells(row)
        joined = text_of(row)
        if not heading and '宣佈出賽馬匹傷患紀錄' in joined:
            heading = joined
            found = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日', heading)
            if not found:
                raise ParseMiss('declared veterinary heading has no date')
            try:
                meeting = date(int(found.group(1)), int(found.group(2)), int(found.group(3)))
            except ValueError as exc:
                raise IdentityError('declared veterinary heading is not a calendar day') from exc
            weekday_ok(meeting, heading)
            if meeting.month != int(button.group(1)) or meeting.day != int(button.group(2)):
                raise IdentityError('meeting button does not match the veterinary heading')
            continue
        if values and re.fullmatch(r'第\s*(\d+)\s*場', text_of(values[0]) or '') and all(not text_of(cell) for cell in values[1:]):
            race_no = int(re.fullmatch(r'第\s*(\d+)\s*場', text_of(values[0])).group(1))
            current = None
            continue
        if not any(text_of(cell) for cell in values):
            continue
        if [text_of(cell) for cell in values[:7]] == ['場次', '馬號', '馬名', '烙印編號', '日期', '詳情', '通過日期']:
            continue
        if meeting is None or race_no is None or len(values) != 7:
            raise ParseMiss('declared veterinary row is outside a race')
        number = blank(text_of(values[1]))
        name = blank(text_of(values[2]))
        code = blank(text_of(values[3]))
        if number or name or code:
            reserve = 0
            if number and number.startswith('後備'):
                reserve = 1
                number = number.removeprefix('後備').strip()
            if not number or not name or not code or not BRAND.fullmatch(code) or not re.fullmatch(r'\d+', number):
                raise IdentityError(f'declared veterinary horse {number!r} {name!r} {code!r} is incomplete')
            link = values[2].find('a')
            if link and link.get('href'):
                horse_id = re.search(r'horseid=(HK_\d{4}_[A-Za-z]\d{3})', link['href'])
                if not horse_id or not horse_id.group(1).upper().endswith('_' + code.upper()):
                    raise IdentityError(f'declared veterinary link disagrees with brand {code}')
            current = {'horse_no': int(number), 'is_reserve': reserve, 'horse_code': code, 'horse_name': name}
        elif current is None:
            raise ParseMiss('declared veterinary detail has no horse')
        detail = text_of(values[5]).strip()
        if not detail:
            raise ParseMiss('declared veterinary detail is empty')
        passed = passed_on(text_of(values[6]))
        line_no += 1
        rows.append({
            'meeting_date': meeting.isoformat(), 'venue': VENUE_LABEL[button.group(3)], 'race_no': race_no,
            'line_no': line_no, **current, 'injury_date': dmy(text_of(values[4]), 'injury'), 'detail': detail,
            'passed_date': passed,
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss('declared veterinary rollup has no rows')
    known = [row for row in fixtures(root) if row.get('date') == meeting.isoformat() and row.get('venue') in ('ST', 'HV')]
    if len(known) == 1 and known[0]['venue'] != rows[0]['venue']:
        raise IdentityError('declared veterinary venue disagrees with the fixture calendar')
    limit = int(known[0]['race_count']) if len(known) == 1 and re.fullmatch(r'\d+', known[0].get('race_count') or '') else None
    if limit is not None and any(row['race_no'] < 1 or row['race_no'] > limit for row in rows):
        raise IdentityError('declared veterinary race is outside the fixture')
    return rows


def parse_ppo(html: str, digest: str, scraped_at: str) -> list[dict]:
    flight = flight_text(html)
    anchor = flight.find('"dataList":')
    if anchor < 0:
        raise ParseMiss('pre-import performance list is missing')
    try:
        seasons, _ = json.JSONDecoder().raw_decode(flight, anchor + len('"dataList":'))
    except json.JSONDecodeError as exc:
        raise ParseMiss('pre-import performance list is not JSON') from exc
    if not isinstance(seasons, list) or not seasons:
        raise ParseMiss('pre-import performance list is empty')
    rows = []
    seen = set()
    for season in seasons:
        code = str(season.get('name') or '')
        match = SEASON.fullmatch(code)
        if not match or int(match.group(2)) != int(match.group(1)) + 1:
            raise ParseMiss(f'pre-import season {code!r} is not a consecutive pair')
        enabled = (season.get('enable') or {}).get('boolValue')
        if not isinstance(enabled, bool):
            raise ParseMiss(f'pre-import season {code} has no enable flag')
        children = season.get('children') or []
        if not children:
            raise ParseMiss(f'pre-import season {code} has no horses')
        for horse in children:
            brand = str((horse.get('brandNo') or {}).get('value') or '')
            former = str((horse.get('formerName') or {}).get('value') or '').strip()
            name = str((horse.get('hKName') or {}).get('value') or '').strip()
            notes = str((horse.get('notes') or {}).get('value') or '')
            play = (horse.get('showPlayUrl') or {}).get('boolValue')
            if not BRAND.fullmatch(brand) or not former or not isinstance(play, bool):
                raise IdentityError(f'pre-import horse {brand!r} is incomplete')
            key = (code, brand)
            if key in seen:
                raise IdentityError(f'pre-import horse {brand} is repeated in {code}')
            seen.add(key)
            rows.append({
                'season_code': code, 'brand_no': brand, 'horse_name_ch': name or None, 'former_name': former,
                'notes': notes.strip() or None, 'show_play': int(play), 'season_enabled': int(enabled),
                'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
    return rows


def odds_text(value) -> str:
    if value == -1:
        return '-'
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ParseMiss(f'odds {value!r} is not a number')
    number = Decimal(str(value))
    cents = (number * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
    if abs(number * 100 - cents) > Decimal('0.001') or cents <= 0 or cents > 99900:
        raise ParseMiss(f'odds {value!r} is not a two-decimal price')
    return format((cents / Decimal(100)).quantize(Decimal('0.01')), 'f')


def parse_odds(payload: dict, pool: str, digest: str, scraped_at: str) -> list[dict]:
    if pool not in ('jkc', 'tnc'):
        raise IdentityError(pool)
    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ParseMiss('odds chart has no data')
    updated = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2})', str(data.get('UpdateTime') or ''))
    if not updated:
        raise ParseMiss('odds chart update time is missing')
    try:
        updated_at = datetime(
            int(updated.group(3)), int(updated.group(2)), int(updated.group(1)),
            int(updated.group(4)), int(updated.group(5)), tzinfo=HKT,
        )
    except ValueError as exc:
        raise ParseMiss('odds chart update time is not a clock time') from exc
    winners = data.get('WinnerList')
    if not isinstance(winners, list) or not winners:
        raise ParseMiss('odds chart has no meetings')
    rows = []
    seen = set()
    for item in winners:
        meeting = dmy(str(item.get('MeetingDate') or ''), 'chart meeting')
        if meeting > updated_at.date().isoformat():
            raise IdentityError('odds chart meeting is after its update time')
        venue = item.get('Venue')
        if venue not in ('ST', 'HV'):
            raise IdentityError(f'odds chart venue {venue!r} is not local')
        winner = item.get('Winner') or {}
        code = str(winner.get('Code') or '')
        name = str(winner.get('Name') or '').strip()
        if not PERSON.fullmatch(code) or not name or winner.get('Id') != code:
            raise IdentityError(f'odds chart winner {code!r} is incomplete')
        points = item.get('Point')
        if isinstance(points, bool) or not isinstance(points, int) or points < 0:
            raise ParseMiss('odds chart points are not an official count')
        trend = [point for point in item.get('OddsTrend') or [] if point is not None]
        numbers = [point.get('RaceNo') if isinstance(point, dict) else None for point in trend]
        if numbers != list(range(len(numbers))):
            raise ParseMiss(f'odds chart races {numbers} are not the opening price plus each race')
        key = (meeting, venue, code)
        if key in seen:
            raise IdentityError(f'odds chart repeats {meeting} {venue} {code}')
        seen.add(key)
        for point in trend:
            rows.append({
                'pool': pool, 'meeting_date': meeting, 'venue': venue, 'winner_code': code, 'winner_name': name,
                'points': points, 'race_no': point['RaceNo'], 'odds_text': odds_text(point.get('Odds')),
                'chart_updated_at': updated_at.isoformat(), 'not_race_result': 1,
                'source_sha256': digest, 'scraped_at': scraped_at,
            })
    return rows


def rate_text(raw: str, label: str) -> str:
    try:
        number = Decimal(str(raw).strip())
    except (InvalidOperation, ValueError) as exc:
        raise ParseMiss(f'{label} {raw!r} is not a rate') from exc
    if number < 0 or number > 1:
        raise ParseMiss(f'{label} {raw!r} is outside 0 to 1')
    return format(number.quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP), 'f')


def sheet_rows(raw: bytes) -> list[list[str]]:
    try:
        book = zipfile.ZipFile(__import__('io').BytesIO(raw))
        shared = ET.fromstring(book.read('xl/sharedStrings.xml'))
        strings = [
            ''.join(node.text or '' for node in item.iter(f'{{{NS["m"]}}}t'))
            for item in shared.findall('m:si', NS)
        ]
        sheet = ET.fromstring(book.read('xl/worksheets/sheet1.xml'))
    except (KeyError, ET.ParseError, zipfile.BadZipFile) as exc:
        raise ParseMiss('jockey-trainer workbook is not the official sheet') from exc
    rows = []
    for row in sheet.findall('m:sheetData/m:row', NS):
        values = {}
        width = 0
        for cell in row.findall('m:c', NS):
            ref = cell.get('r') or 'A1'
            letters = ''.join(char for char in ref if char.isalpha())
            index = 0
            for char in letters:
                index = index * 26 + ord(char) - 64
            index -= 1
            node = cell.find('m:v', NS)
            value = node.text if node is not None and node.text is not None else ''
            if cell.get('t') == 's' and value != '':
                value = strings[int(value)]
            values[index] = value
            width = max(width, index + 1)
        rows.append([values.get(index, '') for index in range(width)])
    return rows


def updated_stamp(text: str) -> str:
    match = re.fullmatch(r'最後更新\s*:\s*(\d{2}/\d{2}/\d{4} \d{2}:\d{2})', text.strip())
    if not match:
        raise ParseMiss(f'workbook update {text!r} is not official')
    dmy(match.group(1)[:10], 'workbook update')
    return match.group(1)


def parse_combo_rows(rows: list[list[str]], meeting_date: str, venue: str, race_count: int, digest: str, scraped_at: str) -> list[dict]:
    if not rows or not str(rows[0][0]).startswith('騎練配對成績'):
        raise ParseMiss('jockey-trainer workbook title changed')
    header = next((row for row in rows if row and row[0] == '馬號'), None)
    races = next((row for row in rows if row and '第一場' in row), None)
    if header is None or races is None:
        raise ParseMiss('jockey-trainer workbook has no race header')
    race_numbers = [RACE_LABEL[cell] for cell in races if cell]
    if race_numbers != list(range(1, race_count + 1)):
        raise IdentityError(f'workbook races {race_numbers} are not fixture race count {race_count}')
    if header[0] != '馬號' or len(header) < 1 + race_count * 2:
        raise ParseMiss('jockey-trainer rate header changed')
    for index in range(race_count):
        if header[1 + index * 2].strip() != '勝出率' or header[2 + index * 2].strip() != '上名率':
            raise ParseMiss('jockey-trainer rate columns are not win then place')
    stamps = []
    for row in rows:
        for cell in row:
            if str(cell).strip().startswith('最後更新'):
                stamps.append(updated_stamp(str(cell)))
    if not stamps or len(set(stamps)) != 1:
        raise ParseMiss('jockey-trainer workbook update lines disagree')
    if dmy(stamps[0][:10], 'workbook update') > meeting_date:
        raise IdentityError('workbook update is after the meeting it describes')
    out = []
    numbers = []
    in_combo = False
    for row in rows:
        if not row:
            continue
        if row[0] == '馬號':
            in_combo = True
            continue
        if any(str(cell).strip().startswith('最後更新') for cell in row):
            in_combo = False
            continue
        if not in_combo or not str(row[0]).strip():
            continue
        if not re.fullmatch(r'\d+', str(row[0]).strip()):
            raise ParseMiss(f'combo horse number {row[0]!r} is not official')
        horse_no = int(row[0])
        numbers.append(horse_no)
        for race_no in range(1, race_count + 1):
            out.append({
                'meeting_date': meeting_date, 'venue': venue, 'section': 'combo', 'race_no': race_no,
                'horse_no': horse_no, 'horse_name': None, 'import_type': None, 'trainer_name': None,
                'win_rate': rate_text(row[1 + (race_no - 1) * 2], 'win rate'),
                'place_rate': rate_text(row[2 + (race_no - 1) * 2], 'place rate'),
                'as_of_text': stamps[0], 'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
    if numbers != list(range(1, len(numbers) + 1)) or not numbers:
        raise ParseMiss('combo horse numbers are not 1..n')
    debut_at = next((index for index, row in enumerate(rows) if row and str(row[0]).startswith('練馬師在港初出馬成績')), None)
    if debut_at is None:
        raise ParseMiss('debutant section is missing')
    debut_header = rows[debut_at + 1]
    expected = ['場次', '馬號', '馬名', '', '進口類別', '', '練馬師', '', '勝出率', '上名率']
    if [cell.strip() for cell in debut_header[:len(expected)]] != [cell.strip() for cell in expected]:
        raise ParseMiss('debutant header changed')
    for row in rows[debut_at + 2:]:
        if not row or not str(row[0]).strip() or str(row[0]).startswith('最後更新'):
            continue
        if not re.fullmatch(r'\d+', str(row[0]).strip()) or not re.fullmatch(r'\d+', str(row[1]).strip()):
            raise ParseMiss('debutant race or horse number is not official')
        race_no = int(row[0])
        horse_no = int(row[1])
        if race_no < 1 or race_no > race_count or horse_no < 1:
            raise IdentityError('debutant row is outside the fixture')
        name = str(row[2]).strip()
        trainer = str(row[6]).strip()
        if not name or not trainer:
            raise IdentityError('debutant horse name or trainer is empty')
        out.append({
            'meeting_date': meeting_date, 'venue': venue, 'section': 'debut', 'race_no': race_no,
            'horse_no': horse_no, 'horse_name': name, 'import_type': str(row[4]).strip() or None,
            'trainer_name': trainer, 'win_rate': rate_text(row[8], 'debut win rate'),
            'place_rate': rate_text(row[9], 'debut place rate'), 'as_of_text': stamps[0],
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not any(row['section'] == 'debut' for row in out):
        raise ParseMiss('debutant section has a header and no horses')
    return out


def parse_conghua_text(text: str, meeting_date: str, venue: str, race_count: int, digest: str, scraped_at: str) -> list[dict]:
    chinese = re.search(r'([〇零一二三四五六七八九]+)年([〇零一二三四五六七八九十]+)月([〇零一二三四五六七八九十]+)日', text)
    english = re.search(r'(\d{1,2})\s+([A-Z]+)\s+(\d{4})', text)
    if not chinese or not english or 'HORSES STABLED IN CONGHUA SINCE LAST START' not in text:
        raise ParseMiss('Conghua list heading is missing')
    try:
        chinese_day = date(cn_number(chinese.group(1)), cn_number(chinese.group(2)), cn_number(chinese.group(3)))
        english_day = date(int(english.group(3)), MONTHS[english.group(2)], int(english.group(1)))
    except (KeyError, ValueError) as exc:
        raise ParseMiss('Conghua list heading is not a calendar day') from exc
    if chinese_day.isoformat() != meeting_date or english_day.isoformat() != meeting_date:
        raise IdentityError('Conghua list date disagrees with the fixture in its window')
    if venue not in ('ST', 'HV'):
        raise IdentityError('Conghua venue is not local')
    line_re = re.compile(
        r'^(?:(?P<race>\d+)\s+)?(?:(?P<reserve>Standby)\s+)?(?P<no>\d+)\s+(?P<ch>\S+)\s+(?P<en>.+?)\s+'
        r'(?P<arrived>\d{2}/\d{2}/\d{4})\s+(?P<returned>\d{2}/\d{2}/\d{4})\s*$'
    )
    rows = []
    race_no = None
    seen = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('場次') or line.startswith('Race ') or 'HORSES STABLED' in line:
            continue
        if re.search(r'年.+月.+日', line) or re.search(r'\d{1,2}\s+[A-Z]+\s+\d{4}', line):
            continue
        match = line_re.match(line)
        if not match:
            if re.search(r'\d{2}/\d{2}/\d{4}', line):
                raise ParseMiss(f'Conghua line {line!r} is not a horse row')
            continue
        if match.group('race'):
            race_no = int(match.group('race'))
        if race_no is None or race_no < 1 or race_no > race_count:
            raise IdentityError('Conghua race is outside the fixture')
        horse_no = int(match.group('no'))
        reserve = 1 if match.group('reserve') else 0
        key = (race_no, reserve, horse_no)
        if key in seen:
            raise IdentityError(f'Conghua horse {key} is repeated')
        seen.add(key)
        arrived = dmy(match.group('arrived'), 'Conghua arrival')
        returned = dmy(match.group('returned'), 'Conghua return')
        if arrived > returned or returned > meeting_date:
            raise IdentityError('Conghua dates are not arrival, then return, then the meeting')
        rows.append({
            'meeting_date': meeting_date, 'venue': venue, 'race_no': race_no, 'line_no': len(rows) + 1,
            'horse_no': horse_no, 'is_reserve': reserve, 'horse_name_ch': match.group('ch'),
            'horse_name_en': match.group('en'), 'arrived_date': arrived, 'returned_date': returned,
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss('Conghua list has a heading and no horses')
    return rows


def extract_pdf_text(raw: bytes) -> str:
    from pypdf import PdfReader
    from io import BytesIO
    try:
        reader = PdfReader(BytesIO(raw))
        return '\n'.join((page.extract_text() or '') for page in reader.pages)
    except Exception as exc:
        raise ParseMiss('Conghua PDF has no official text') from exc


def data_dir(root: Path) -> Path:
    path = root / 'data' / 'official_wave5'
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n')
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
    if isinstance(value, bool):
        raise IdentityError('refusing boolean SQL value')
    if isinstance(value, int):
        return str(value)
    text = str(value)
    if text == '':
        return 'NULL'
    return "'" + text.replace("'", "''") + "'"


def sql_value(column: str, raw: str) -> str:
    if raw == '' and column not in INTEGER_COLUMNS:
        return 'NULL'
    if column in INTEGER_COLUMNS:
        if not re.fullmatch(r'-?\d+', raw or ''):
            raise IdentityError(f'{column} is not a stored number')
        return str(int(raw))
    return sql_literal(raw)


def emit_sql(root: Path) -> str:
    base = data_dir(root)
    statements = ['-- generated from data/official_wave5; official board upsert, not a race result']
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


def collect(root: Path, surfaces: set[str]) -> dict[str, int]:
    scraped_at = scraped_now()
    summary = {}
    if 'ove-database' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/information/ovedatabase')
        rows = parse_ove_database(raw, sha256(raw), scraped_at)
        write_csv(data_dir(root) / FILES['ove_database'][0], OVE_COLUMNS, rows)
        append_manifest(root, 'ove-database', sha256(raw), scraped_at, len(rows))
        summary['ove-database'] = len(rows)
    if 'ove-record' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/information/overecord')
        rows = parse_ove_record(raw, root, sha256(raw), scraped_at)
        if rows is None:
            summary['ove-record'] = 0
        else:
            write_csv(data_dir(root) / FILES['ove_record'][0], RECORD_COLUMNS, rows)
            append_manifest(root, 'ove-record', sha256(raw), scraped_at, len(rows))
            summary['ove-record'] = len(rows)
    if 'ppo' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/page/ppo-performance')
        rows = parse_ppo(raw.decode('utf-8', errors='replace'), sha256(raw), scraped_at)
        write_csv(data_dir(root) / FILES['ppo_performance'][0], PPO_COLUMNS, rows)
        append_manifest(root, 'ppo', sha256(raw), scraped_at, len(rows))
        summary['ppo'] = len(rows)
    if 'odds-chart' in surfaces:
        rows = []
        digests = []
        for pool in ('jkc', 'tnc'):
            raw = fetch_bytes(
                SITE + '/contentAsset/api/getOddsChart', 'POST',
                json.dumps({'lang': 'zh-hk', 'requestType': pool, 'season': ''}).encode(),
                {'content-type': 'application/json', 'accept': 'application/json'},
            )
            digests.append(sha256(raw))
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ParseMiss('odds chart response is not JSON') from exc
            rows.extend(parse_odds(payload, pool, sha256(raw), scraped_at))
        digest = hashlib.sha256(''.join(digests).encode()).hexdigest()
        write_csv(data_dir(root) / FILES['challenge_odds'][0], ODDS_COLUMNS, rows)
        append_manifest(root, 'odds-chart', digest, scraped_at, len(rows))
        summary['odds-chart'] = len(rows)
    if 'jtcombo' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/page/jtcombo-debutants-statistics')
        flight = flight_text(raw.decode('utf-8', errors='replace'))
        url = content_url(flight, 'jTExcelFile', '.xlsx')
        if url is None:
            summary['jtcombo'] = 0
        else:
            start, end = content_window(flight)
            fixture = unique_fixture(root, start, end)
            book = fetch_bytes(url)
            rows = parse_combo_rows(
                sheet_rows(book), fixture['date'], fixture['venue'], int(fixture['race_count']), sha256(book), scraped_at,
            )
            write_csv(data_dir(root) / FILES['jt_combo'][0], COMBO_COLUMNS, rows)
            append_manifest(root, 'jtcombo', sha256(book), scraped_at, len(rows))
            summary['jtcombo'] = len(rows)
    if 'conghua' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/page/conghua-movement-records')
        flight = flight_text(raw.decode('utf-8', errors='replace'))
        url = content_url(flight, 'cHMovementRecordsPDF', '.pdf')
        if url is None:
            summary['conghua'] = 0
        else:
            start, end = content_window(flight)
            fixture = unique_fixture(root, start, end)
            pdf = fetch_bytes(url)
            rows = parse_conghua_text(
                extract_pdf_text(pdf), fixture['date'], fixture['venue'], int(fixture['race_count']), sha256(pdf), scraped_at,
            )
            write_csv(data_dir(root) / FILES['conghua_movement'][0], CONGHUA_COLUMNS, rows)
            append_manifest(root, 'conghua', sha256(pdf), scraped_at, len(rows))
            summary['conghua'] = len(rows)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Collect the next visible official HKJC surfaces')
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
