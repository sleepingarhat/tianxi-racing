#!/usr/bin/env python3
"""Official surfaces that were still partial after wave 7.

Stored copies of the public page, not model inputs and not frozen picks:

* fixture class / distance / G2–G3 lines
* results-all condensed runners and the dividends printed on that page
* same-sire tables (View=All, including retired horses)
* selecthorse directory lists (location, stable, age, name length)
* jockey and trainer profile season tables and win-by-course grids
* windtracker station, sectional wind, and the page's own going / penetrometer

Odds snapshots, the frozen A-line, and racecard going are not written.
A penetrometer value of "--" stays blank. A page whose date or title does
not match is not stored under the requested identity.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import importlib.util
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

HKT = ZoneInfo('Asia/Hong_Kong')
SITE = 'https://racing.hkjc.com'
GRAPHQL = 'https://info.cld.hkjc.com/graphql/base/'
UA = (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
)
HORSE_ID = re.compile(r'^HK_\d{4}_[A-Z]\d{3}$')
PERSON_ID = re.compile(r'^[A-Z][A-Z0-9]{1,5}$')
SIRE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9 .'\-()]{0,40}$")
RATING_CELL = re.compile(r'^\((\d{1,3})\)$')
WIN_RATE = re.compile(r'^\d{1,3}(?:\.\d{1,2})?%$')
READING = re.compile(r'^\d+(?:\.\d+)?$')
DATE_ISO = re.compile(r'^\d{4}-\d{2}-\d{2}$')
VENUE_LABEL = {'跑馬地': 'HV', '沙田': 'ST', '從化': 'CH'}
SURFACE_LABEL = {'全天候跑道': 'awt', '草地跑道': 'turf'}
SEASON_HEADER = re.compile(r'(\d{2}/\d{2})\s*馬季\s*截至賽事日:\s*(\d{2}/\d{2}/\d{4})')
SKIP_LINK = {'簡歷', '成績', '策騎紀錄', '往績紀錄', '上季', '今季', '勝出場地途程', '其他練馬師'}
SEASON_LABELS = {
    '國籍': 'nationality',
    '冠': 'wins',
    '亞': 'seconds',
    '季': 'thirds',
    '殿': 'fourths',
    '總出賽次數': 'starts',
    '出馬總數': 'starts',
    '所贏獎金': 'stakes_hkd',
    '勝出率': 'win_rate',
    '過去10個賽馬日獲勝次數': 'last10_wins',
}
LOCATION_TITLE = {'HK': '所在位置 - 香港', 'CH': '所在位置 - 從化', 'OS': '所在位置 - 海外'}
CHAR_TITLE = {'0': '未命名馬匹', '2': '二字馬', '3': '三字馬', '4': '四字馬'}
SURFACES = ('fixture', 'results-all', 'same-sire', 'directory', 'persons', 'wind')
MEETING_VARS = {
    'localSim': 'LOCAL',
    'status': ['DECLARED', 'DEFINED', 'STARTED', 'CLOSED', 'ABANDON_PARTIAL', 'ABANDON'],
}

FIXTURE_COLUMNS = [
    'meeting_date', 'venue', 'line_no', 'class_code', 'distance', 'race_count',
    'course_text', 'rating_band', 'not_race_result', 'source_sha256', 'scraped_at',
]
RUNNER_COLUMNS = [
    'meeting_date', 'venue', 'section', 'place_label', 'race_no', 'line_no', 'placing_text',
    'horse_no', 'horse_name', 'jockey_name', 'trainer_name', 'actual_weight', 'draw',
    'not_race_result', 'source_sha256', 'scraped_at',
]
DIVIDEND_COLUMNS = [
    'meeting_date', 'venue', 'section', 'race_no', 'line_no', 'pool_name', 'combination',
    'dividend_text', 'not_race_result', 'source_sha256', 'scraped_at',
]
SIRE_PAGE_COLUMNS = [
    'sire_name', 'horse_count', 'not_race_result', 'source_sha256', 'scraped_at',
]
SIRE_COLUMNS = [
    'sire_name', 'line_no', 'horse_name', 'retired', 'wins', 'seconds', 'thirds', 'starts',
    'winning_distance', 'not_race_result', 'source_sha256', 'scraped_at',
]
DIRECTORY_PAGE_COLUMNS = [
    'list_kind', 'list_key', 'list_label', 'horse_count', 'not_race_result', 'source_sha256', 'scraped_at',
]
DIRECTORY_COLUMNS = [
    'list_kind', 'list_key', 'line_no', 'horse_id', 'horse_name', 'rating', 'list_label',
    'not_race_result', 'source_sha256', 'scraped_at',
]
SEASON_COLUMNS = [
    'role', 'person_id', 'person_name', 'season_label', 'as_of_date', 'nationality',
    'wins', 'seconds', 'thirds', 'fourths', 'starts', 'stakes_hkd', 'win_rate', 'last10_wins',
    'not_race_result', 'source_sha256', 'scraped_at',
]
WINSTAT_COLUMNS = [
    'role', 'person_id', 'season_label', 'line_no', 'venue_label', 'venue_code',
    'surface_label', 'surface_code', 'distance', 'wins', 'seconds', 'thirds', 'starts',
    'not_race_result', 'source_sha256', 'scraped_at',
]
WIND_MEETING_COLUMNS = [
    'meeting_date', 'venue', 'status', 'race_count', 'meeting_track_ch',
    'not_race_result', 'source_sha256', 'scraped_at',
]
WIND_GOING_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'going_ch', 'track_code',
    'not_race_result', 'source_sha256', 'scraped_at',
]
WIND_PROBE_COLUMNS = [
    'meeting_date', 'venue', 'instrument', 'sequence_no', 'reading_time', 'reading',
    'not_race_result', 'source_sha256', 'scraped_at',
]
WIND_STATION_COLUMNS = [
    'racecourse', 'location', 'observed_date', 'observed_time', 'wind_direction', 'wind_speed',
    'gust_direction', 'gust_speed', 'humidity', 'temperature', 'solar_radiation', 'sunshine_hour',
    'pressure', 'gust_speed_daily_max', 'humidity_daily_max', 'humidity_daily_min',
    'temperature_daily_max', 'temperature_daily_min', 'rain_1min', 'rain_10min', 'rain_daily',
    'soil_water', 'soil_loss_1min', 'soil_loss_daily', 'soil_loss_24h', 'status', 'is_valid',
    'gps_position', 'supply_voltage', 'not_race_result', 'source_sha256', 'scraped_at',
]
WIND_SECTION_COLUMNS = [
    'racecourse', 'location', 'observed_date', 'observed_time', 'wind_direction', 'wind_speed',
    'gust_direction', 'gust_speed', 'status', 'is_valid', 'gps_position', 'supply_voltage',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'fixture_line': ('fixture_line.csv', FIXTURE_COLUMNS),
    'results_all_runner': ('results_all_runner.csv', RUNNER_COLUMNS),
    'results_all_dividend': ('results_all_dividend.csv', DIVIDEND_COLUMNS),
    'same_sire_page': ('same_sire_page.csv', SIRE_PAGE_COLUMNS),
    'same_sire': ('same_sire.csv', SIRE_COLUMNS),
    'horse_directory_page': ('horse_directory_page.csv', DIRECTORY_PAGE_COLUMNS),
    'horse_directory': ('horse_directory.csv', DIRECTORY_COLUMNS),
    'person_season': ('person_season.csv', SEASON_COLUMNS),
    'person_winstat': ('person_winstat.csv', WINSTAT_COLUMNS),
    'wind_meeting': ('wind_meeting.csv', WIND_MEETING_COLUMNS),
    'wind_going': ('wind_going.csv', WIND_GOING_COLUMNS),
    'wind_probe': ('wind_probe.csv', WIND_PROBE_COLUMNS),
    'wind_station': ('wind_station.csv', WIND_STATION_COLUMNS),
    'wind_section': ('wind_section.csv', WIND_SECTION_COLUMNS),
}
INTEGER_COLUMNS = {
    'line_no', 'distance', 'race_count', 'race_no', 'actual_weight', 'draw', 'retired', 'wins',
    'seconds', 'thirds', 'fourths', 'starts', 'stakes_hkd', 'last10_wins', 'rating', 'horse_count',
    'is_valid', 'sequence_no', 'not_race_result',
}
REPLACE_KEYS = {
    'fixture_line': ('meeting_date', 'venue'),
    'results_all_runner': ('meeting_date', 'venue'),
    'results_all_dividend': ('meeting_date', 'venue'),
    'wind_station': ('racecourse', 'observed_date', 'observed_time'),
    'wind_section': ('racecourse', 'location', 'observed_date', 'observed_time'),
    'wind_meeting': ('meeting_date', 'venue'),
    'wind_going': ('meeting_date', 'venue', 'race_no'),
    'wind_probe': ('meeting_date', 'venue', 'instrument', 'sequence_no'),
}


class IdentityError(ValueError):
    """The page is not the meeting, sire, or person it claims to be."""


class DateMismatch(IdentityError):
    def __init__(self, found: str):
        super().__init__(f'results page date is {found}')
        self.found = found


class ParseMiss(ValueError):
    """A published board is not the official shape."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def scraped_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_hkt() -> date:
    return datetime.now(HKT).date()


def collapse(value: str | None) -> str:
    return re.sub(r'\s+', ' ', (value or '').replace('\xa0', ' ').replace('\u00a0', ' ')).strip()


def blank(value) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = collapse(str(value))
    if text in ('', '-', '--', '---', '----'):
        return None
    return text


def whole(value, label: str) -> int:
    text = collapse(str(value) if value is not None else '')
    if not re.fullmatch(r'\d{1,6}', text):
        raise ParseMiss(f'{label} {value!r} is not a whole number')
    return int(text)


def money(value, label: str) -> int | None:
    text = collapse(str(value or '')).replace('$', '').replace(',', '').replace(' ', '')
    if text in ('', '-', '--'):
        return None
    if not re.fullmatch(r'\d{1,12}', text):
        raise ParseMiss(f'{label} {value!r} is not an amount')
    return int(text)


def iso_from_dmy(text: str) -> str:
    try:
        return datetime.strptime(text, '%d/%m/%Y').date().isoformat()
    except ValueError as exc:
        raise ParseMiss(f'date {text!r} is not DD/MM/YYYY') from exc


def fetch_bytes(url: str) -> bytes:
    last: Exception | None = None
    for _attempt in range(3):
        req = Request(url, headers={
            'user-agent': UA,
            'accept-encoding': 'identity',
            'accept-language': 'zh-HK,zh;q=0.9',
        })
        try:
            with urlopen(req, timeout=40) as response:
                host = (response.geturl() or url).split('/')[2]
                if not host.endswith('hkjc.com'):
                    raise IdentityError(f'unexpected host {host}')
                raw = response.read()
                encoding = response.headers.get('content-encoding', '')
            if encoding == 'gzip' or raw.startswith(b'\x1f\x8b'):
                raw = gzip.decompress(raw)
            elif encoding not in ('', 'identity'):
                raise IdentityError('unsupported official encoding')
            return raw
        except (HTTPError, URLError, TimeoutError) as exc:
            last = exc
    raise IdentityError(f'fetch failed {url}: {last}')


def graphql(query: str, variables: dict | None) -> tuple[dict, str]:
    payload = json.dumps({'query': query, 'variables': variables or {}}, ensure_ascii=False).encode()
    req = Request(GRAPHQL, data=payload, headers={
        'content-type': 'application/json',
        'user-agent': UA,
        'accept-encoding': 'identity',
    })
    with urlopen(req, timeout=40) as response:
        raw = response.read()
        encoding = response.headers.get('content-encoding', '')
    if encoding == 'gzip' or raw.startswith(b'\x1f\x8b'):
        raw = gzip.decompress(raw)
    body = json.loads(raw.decode('utf-8'))
    if body.get('errors'):
        raise IdentityError(f'official query rejected: {body["errors"][0].get("message", "error")}')
    return body, sha256(raw)


def fixture_module():
    path = Path(__file__).resolve().parents[1] / 'FixtureCalendar_Scraper.py'
    spec = importlib.util.spec_from_file_location('fixture_calendar', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def data_dir(root: Path) -> Path:
    path = root / 'data' / 'official_wave8'
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_csv(path: Path, columns: list[str]) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        if list(reader.fieldnames or []) != columns:
            raise IdentityError(f'{path.name} columns changed')
        return [dict(row) for row in reader]


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n', extrasaction='raise')
        writer.writeheader()
        for row in rows:
            writer.writerow({column: '' if row.get(column) is None else row[column] for column in columns})


def merge_groups(existing: list[dict], fresh: list[dict], keys: tuple[str, ...]) -> list[dict]:
    fresh_keys = {tuple(str(row[key]) for key in keys) for row in fresh}
    kept = [row for row in existing if tuple(str(row[key]) for key in keys) not in fresh_keys]
    merged = kept + fresh
    merged.sort(key=lambda row: tuple(str(row[key]) for key in keys))
    return merged


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = data_dir(root) / 'manifest.jsonl'
    line = json.dumps(
        {'surface': surface, 'sha256': digest, 'scraped_at': scraped_at, 'rows': row_count},
        ensure_ascii=False, sort_keys=True,
    )
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def stamp(row: dict, digest: str, scraped_at: str) -> dict:
    row['not_race_result'] = 1
    row['source_sha256'] = digest
    row['scraped_at'] = scraped_at
    return row


def displayed_results_date(html: str) -> str:
    soup = BeautifulSoup(html, 'html.parser')
    for node in soup.find_all(string=re.compile('賽事日期')):
        text = collapse(node.parent.get_text(' ', strip=True))
        match = re.search(r'賽事日期:\s*(\d{2}/\d{2}/\d{4})', text)
        if match:
            return match.group(1)
    raise ParseMiss('results page has no 賽事日期 heading')


def result_dates(html: str) -> list[str]:
    found = re.findall(r"""value='\{"date":"(\d{2}/\d{2}/\d{4})","venue":""\}'""", html)
    if not found:
        raise ParseMiss('results page has no date list')
    return found


def section_identity(table) -> tuple[str, str, str]:
    span = table.find('span')
    label = collapse((span or table).get_text(' ', strip=True)).rstrip(':').strip()
    if label.startswith('沙田'):
        return 'ST', 'local', '沙田'
    if label.startswith('跑馬地'):
        return 'HV', 'local', '跑馬地'
    match = re.match(r'(S\d{1,2})(?:\s*(\S+))?$', label)
    if not match:
        raise ParseMiss(f'results section {label!r} is not a local or simulcast meeting')
    return match.group(1), 'simulcast', label


def parse_results_all(html: str, requested: str, digest: str, scraped_at: str) -> dict[str, list[dict]]:
    shown = displayed_results_date(html)
    if iso_from_dmy(shown) != requested:
        raise DateMismatch(shown)
    soup = BeautifulSoup(html, 'html.parser')
    blocks = soup.select('div.margin_top15')
    if not blocks:
        blocks = soup.select('div.result_content')
    runners: list[dict] = []
    dividends: list[dict] = []
    seen_race = set()
    local_expected: dict[str, int] = {}
    local_seen: dict[str, set[int]] = {}
    for block in blocks:
        heading_node = block.select_one('.bg_blue, .bg_green')
        heading = collapse(heading_node.get_text(' ', strip=True) if heading_node else '')
        race_match = re.search(r'第\s*(\d{1,2})\s*場', heading)
        if not race_match:
            continue
        race_no = int(race_match.group(1))
        overseas = re.search(r'海外賽事\((S\d{1,2})\b[^)]*\)', heading)
        if overseas:
            venue, section, place = overseas.group(1), 'simulcast', collapse(overseas.group(0))
        else:
            tab = block.find_previous(class_='js_racecard')
            if tab is None:
                raise ParseMiss(f'race {race_no} has no meeting tab')
            venue, section, place = section_identity(tab)
            numbers = set()
            for anchor in tab.select('a[href*="RaceNo="]'):
                href = anchor.get('href') or ''
                number = re.search(r'RaceNo=(\d+)', href)
                course = re.search(r'Racecourse=([A-Za-z0-9]+)', href)
                if course and course.group(1) not in ('ST', 'HV', venue):
                    continue
                if number:
                    numbers.add(int(number.group(1)))
            if not numbers:
                raise ParseMiss(f'{venue} section has no race tabs')
            local_expected[venue] = numbers
            local_seen.setdefault(venue, set()).add(race_no)
        key = (venue, race_no)
        if key in seen_race:
            raise ParseMiss(f'{venue} race {race_no} is repeated')
        seen_race.add(key)
        table = block.select_one('table.result')
        # 宣佈取消 and 宣佈無效 both replace the runner table with refund lines.
        block_text = collapse(block.get_text(' ', strip=True))
        cancelled = '取消' in block_text or '無效' in block_text
        if table is None and section == 'local' and not cancelled:
            raise ParseMiss(f'{requested} race {race_no} has no condensed result table')
        if table is not None:
            body = table.select('tbody tr')
            if not body:
                raise ParseMiss(f'race {race_no} condensed table is empty')
            for line_no, tr in enumerate(body, start=1):
                cells = [collapse(td.get_text(' ', strip=True)) for td in tr.find_all('td')]
                if len(cells) != 7:
                    raise ParseMiss(f'race {race_no} result row has {len(cells)} cells')
                placing, horse_no, horse_name, jockey, trainer, weight, draw = cells
                if not placing or not horse_name or not jockey or not trainer:
                    raise ParseMiss(f'race {race_no} result row is missing a name')
                if section == 'local' and not re.fullmatch(r'\d{1,2}', horse_no):
                    raise ParseMiss(f'race {race_no} horse number {horse_no!r} is not local')
                runners.append(stamp({
                    'meeting_date': requested, 'venue': venue, 'section': section,
                    'place_label': place, 'race_no': race_no, 'line_no': line_no,
                    'placing_text': placing, 'horse_no': horse_no, 'horse_name': horse_name,
                    'jockey_name': jockey, 'trainer_name': trainer,
                    'actual_weight': whole(weight, 'actual weight') if weight not in ('', '-') else None,
                    'draw': whole(draw, 'draw') if draw not in ('', '-') else None,
                }, digest, scraped_at))
        div = block.select_one('table.dividends')
        if div is None:
            raise ParseMiss(f'race {race_no} has no dividend table')
        pool = None
        div_no = 0
        for tr in div.select('tbody tr'):
            cells = [collapse(td.get_text(' ', strip=True)) for td in tr.find_all('td')]
            if not cells or cells[0] in ('彩池', '派彩'):
                continue
            if len(cells) == 3:
                pool, combination, amount = cells
            elif len(cells) == 2 and pool:
                combination, amount = cells
            else:
                raise ParseMiss(f'race {race_no} dividend row {cells!r} is not a pool line')
            if not pool or not combination:
                raise ParseMiss(f'race {race_no} dividend is missing a pool or combination')
            div_no += 1
            dividends.append(stamp({
                'meeting_date': requested, 'venue': venue, 'section': section,
                'race_no': race_no, 'line_no': div_no, 'pool_name': pool, 'combination': combination,
                'dividend_text': blank(amount.replace(',', '')),
            }, digest, scraped_at))
    for venue, expected in local_expected.items():
        if local_seen.get(venue) != expected:
            raise ParseMiss(f'{venue} tabs list {sorted(expected)} but the tables are {sorted(local_seen.get(venue, []))}')
    if not runners and not dividends:
        raise ParseMiss(f'{requested} results page has no condensed table')
    return {'results_all_runner': runners, 'results_all_dividend': dividends}


def parse_same_sire(html: str, sire: str, digest: str, scraped_at: str) -> tuple[dict, list[dict]]:
    if not SIRE_NAME.fullmatch(sire):
        raise IdentityError(f'sire {sire!r} is not an official name')
    soup = BeautifulSoup(html, 'html.parser')
    title = soup.select_one('.htable_text')
    heading = collapse(title.get_text(' ', strip=True) if title else '')
    if heading != f'同父系馬賽績紀錄 - {sire}':
        raise IdentityError(f'same-sire heading {heading!r} is not {sire}')
    if '沒有其他同父系馬' in collapse(soup.get_text(' ', strip=True)):
        page = stamp({'sire_name': sire, 'horse_count': 0}, digest, scraped_at)
        return page, []
    selected = soup.select_one('#ddlSelect option[selected]')
    if selected is None or (selected.get('value') or '') != 'All':
        raise ParseMiss(f'{sire} page is not the full same-sire table')
    table = soup.select_one('table.samesire')
    if table is None:
        raise ParseMiss(f'{sire} has no same-sire table')
    header = [collapse(cell.get_text(' ', strip=True)) for cell in table.select('thead th')]
    if header[1:] != ['冠', '亞', '季', '出賽', '曾勝路程']:
        raise ParseMiss(f'{sire} header {header!r} is not the same-sire table')
    rows = []
    seen = set()
    for line_no, tr in enumerate(table.select('tbody tr'), start=1):
        cells = [collapse(td.get_text(' ', strip=True)) for td in tr.find_all('td')]
        if len(cells) != 6:
            raise ParseMiss(f'{sire} row has {len(cells)} cells')
        name, wins, seconds, thirds, starts, distance = cells
        if not name or name in seen:
            raise ParseMiss(f'{sire} repeats or omits a horse name')
        seen.add(name)
        win_count = whole(wins, 'wins')
        distance_text = blank(distance)
        if win_count > 0 and distance_text is None:
            raise ParseMiss(f'{sire} {name} has wins and no winning distance')
        rows.append(stamp({
            'sire_name': sire, 'line_no': line_no, 'horse_name': name,
            'retired': 1 if '(已退役)' in name else 0,
            'wins': win_count, 'seconds': whole(seconds, 'seconds'),
            'thirds': whole(thirds, 'thirds'), 'starts': whole(starts, 'starts'),
            'winning_distance': distance_text,
        }, digest, scraped_at))
    page = stamp({
        'sire_name': sire, 'horse_count': len(rows),
    }, digest, scraped_at)
    return page, rows


def directory_links(html: str) -> list[tuple[str, str, str, str]]:
    soup = BeautifulSoup(html, 'html.parser')
    found = []
    seen = set()
    for anchor in soup.select('a[href]'):
        href = anchor.get('href') or ''
        text = collapse(anchor.get_text(' ', strip=True))
        kind = key = None
        if 'listbylocation?location=' in href:
            match = re.search(r'location=([A-Z]{2})', href)
            kind, key = 'location', match.group(1) if match else ''
        elif 'listbystable?trainerid=' in href:
            match = re.search(r'trainerid=([A-Z0-9]+)', href)
            kind, key = 'stable', match.group(1) if match else ''
        elif 'listbyage?ordertype=' in href:
            match = re.search(r'ordertype=(\d{1,2})', href)
            kind, key = 'age', match.group(1) if match else ''
        elif 'selecthorsebychar?ordertype=' in href:
            match = re.search(r'ordertype=(\d)', href)
            kind, key = 'char', match.group(1) if match else ''
        if not kind or not key or (kind, key) in seen:
            continue
        seen.add((kind, key))
        found.append((kind, key, text, href))
    if not any(item[0] == 'location' for item in found):
        raise ParseMiss('selecthorse page has no location directory')
    return found


def parse_directory(html: str, kind: str, key: str, label: str, digest: str, scraped_at: str) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(html, 'html.parser')

    def title_ok(title: str) -> bool:
        if kind == 'location':
            expect = LOCATION_TITLE[key]
            return title == expect or title.startswith(expect + ' ')
        if kind == 'age':
            prefix = f'馬齡 - {int(key)}'
            return title == prefix or (title.startswith(prefix) and not title[len(prefix):len(prefix) + 1].isdigit())
        if kind == 'char':
            return title == CHAR_TITLE[key] or title.startswith(CHAR_TITLE[key] + ' ')
        return title.startswith(f'以練馬師分類 - {label}')

    board = None
    title = ''
    for table in soup.select('table.bigborder'):
        first = table.find('tr')
        title = collapse(first.get_text(' ', strip=True) if first else '')
        if title_ok(title):
            board = table
            break
    if board is None:
        raise IdentityError(f'{kind} {key} title is not {expect}')
    count_match = re.search(r'總數:\s*(\d+)', title)
    rows = []
    seen = set()
    for anchor in board.select('a[href*="horseid="]'):
        match = re.search(r'horseid=(HK_\d{4}_[A-Z]\d{3})', anchor.get('href') or '')
        if not match or not HORSE_ID.fullmatch(match.group(1)):
            raise ParseMiss(f'{kind} {key} horse link is not a local id')
        horse_id = match.group(1)
        if horse_id in seen:
            raise ParseMiss(f'{kind} {key} repeats {horse_id}')
        seen.add(horse_id)
        name = collapse(anchor.get_text(' ', strip=True))
        if not name:
            raise ParseMiss(f'{horse_id} has no directory name')
        parent = anchor.find_parent('tr')
        rating_text = collapse(parent.find_all('td')[-1].get_text(' ', strip=True)) if parent else ''
        rating = None
        if rating_text not in ('', '-', '--', '(-)', '(--)'):
            rated = RATING_CELL.fullmatch(rating_text)
            if not rated:
                raise ParseMiss(f'{horse_id} rating {rating_text!r} is not the directory cell')
            rating = int(rated.group(1))
        rows.append(stamp({
            'list_kind': kind, 'list_key': key, 'line_no': len(rows) + 1, 'horse_id': horse_id,
            'horse_name': name, 'rating': rating, 'list_label': title,
        }, digest, scraped_at))
    if count_match and int(count_match.group(1)) != len(rows):
        raise ParseMiss(f'{label} count {count_match.group(1)} is not {len(rows)} horses')
    if kind == 'location' and key == 'HK' and len(rows) < 100:
        raise ParseMiss('Hong Kong directory is unexpectedly short')
    return title, rows


def _season_values(table) -> dict[str, str]:
    cells = [collapse(td.get_text(' ', strip=True)) for td in table.find_all(['td', 'th'])]
    found: dict[str, str] = {}
    index = 0
    while index < len(cells) - 1:
        label = re.sub(r'\s+', '', cells[index])
        field = SEASON_LABELS.get(label)
        if field and cells[index + 1].startswith(':'):
            found[field] = cells[index + 1].lstrip(':').strip()
            index += 2
            continue
        index += 1
    return found


def parse_person_season(html: str, role: str, person_id: str, digest: str, scraped_at: str) -> dict:
    if role not in ('jockey', 'trainer') or not PERSON_ID.fullmatch(person_id):
        raise IdentityError('person identity is not a profile id')
    soup = BeautifulSoup(html, 'html.parser')
    titled = soup.select_one('p.tit')
    name = collapse(titled.get_text(' ', strip=True) if titled else '')
    season_table = None
    for table in soup.find_all('table'):
        text = collapse(table.get_text(' ', strip=True))
        if '馬季' in text and '截至賽事日' in text:
            season_table = table
            continue
        if name:
            continue
        first = table.find('tr')
        candidate = collapse(first.get_text(' ', strip=True) if first else '')
        if candidate and '途程' not in candidate and '馬季' not in candidate:
            name = candidate
    if season_table is None or not name or name.startswith('馬季'):
        raise ParseMiss(f'{person_id} profile has no season table')
    header = SEASON_HEADER.search(collapse(season_table.get_text(' ', strip=True)))
    if not header:
        raise ParseMiss(f'{person_id} season header is missing')
    values = _season_values(season_table)
    required = ['wins', 'seconds', 'thirds', 'fourths', 'starts', 'stakes_hkd', 'win_rate', 'last10_wins']
    if role == 'jockey':
        required.append('nationality')
    missing = [field for field in required if field not in values or values[field] == '']
    if missing:
        raise ParseMiss(f'{person_id} profile is missing {missing}')
    rate = values['win_rate'].replace(' ', '')
    if not WIN_RATE.fullmatch(rate):
        raise ParseMiss(f'{person_id} win rate {rate!r} is not the page text')
    return stamp({
        'role': role, 'person_id': person_id, 'person_name': name, 'season_label': header.group(1),
        'as_of_date': iso_from_dmy(header.group(2)),
        'nationality': values.get('nationality') or None,
        'wins': whole(values['wins'], 'wins'), 'seconds': whole(values['seconds'], 'seconds'),
        'thirds': whole(values['thirds'], 'thirds'), 'fourths': whole(values['fourths'], 'fourths'),
        'starts': whole(values['starts'], 'starts'), 'stakes_hkd': money(values['stakes_hkd'], 'stakes'),
        'win_rate': rate, 'last10_wins': whole(values['last10_wins'], 'last 10'),
    }, digest, scraped_at)


def parse_winstat(html: str, role: str, person_id: str, digest: str, scraped_at: str) -> tuple[dict, list[dict]]:
    season = parse_person_season(html, role, person_id, digest, scraped_at)
    soup = BeautifulSoup(html, 'html.parser')
    table = None
    for candidate in soup.find_all('table'):
        header = [collapse(cell.get_text(' ', strip=True)) for cell in candidate.find_all('tr')[:1]]
        # header cells of the first row
        first = candidate.find('tr')
        cells = [collapse(cell.get_text(' ', strip=True)) for cell in first.find_all(['td', 'th'])] if first else []
        if '途程' in cells and '冠' in cells and ('總出賽次數' in cells or '總出馬次數' in cells):
            table = candidate
            break
    if table is None:
        raise ParseMiss(f'{person_id} has no win-stat grid')
    venue = surface = None
    lines = []
    total = None
    for tr in table.find_all('tr')[1:]:
        cells = [collapse(td.get_text(' ', strip=True)) for td in tr.find_all(['td', 'th'])]
        if not any(cells):
            continue
        if cells[0] == '合計':
            numbers = cells[1:]
            if len(numbers) != 4:
                raise ParseMiss(f'{person_id} total row {cells!r}')
            total = [whole(item, 'total') for item in numbers]
            continue
        if len(cells) == 7:
            venue, surface, distance, numbers = cells[0], cells[1], cells[2], cells[3:]
        elif len(cells) == 6 and cells[0] in VENUE_LABEL:
            venue, surface, distance, numbers = cells[0], None, cells[1], cells[2:]
        elif len(cells) == 6 and cells[0] in SURFACE_LABEL:
            surface, distance, numbers = cells[0], cells[1], cells[2:]
        elif len(cells) == 5 and re.fullmatch(r'\d{3,4}', cells[0]):
            distance, numbers = cells[0], cells[1:]
        else:
            raise ParseMiss(f'{person_id} win-stat row {cells!r}')
        if venue not in VENUE_LABEL:
            raise ParseMiss(f'{person_id} venue {venue!r} is not on the win-stat page')
        if surface is not None and surface not in SURFACE_LABEL:
            raise ParseMiss(f'{person_id} surface {surface!r} is not on the win-stat page')
        if len(numbers) != 4:
            raise ParseMiss(f'{person_id} win-stat counts {numbers!r}')
        lines.append(stamp({
            'role': role, 'person_id': person_id, 'season_label': season['season_label'],
            'line_no': len(lines) + 1, 'venue_label': venue, 'venue_code': VENUE_LABEL[venue],
            'surface_label': surface, 'surface_code': SURFACE_LABEL.get(surface or ''),
            'distance': whole(distance, 'distance'),
            'wins': whole(numbers[0], 'wins'), 'seconds': whole(numbers[1], 'seconds'),
            'thirds': whole(numbers[2], 'thirds'), 'starts': whole(numbers[3], 'starts'),
        }, digest, scraped_at))
    if not lines or total is None:
        raise ParseMiss(f'{person_id} win-stat grid has no total')
    sums = [
        sum(row['wins'] for row in lines), sum(row['seconds'] for row in lines),
        sum(row['thirds'] for row in lines), sum(row['starts'] for row in lines),
    ]
    if sums != total:
        raise ParseMiss(f'{person_id} win-stat lines {sums} do not add to {total}')
    if [season['wins'], season['seconds'], season['thirds'], season['starts']] != total:
        raise ParseMiss(f'{person_id} win-stat total does not match the season table')
    return season, lines


def roster_ids(html: str, role: str) -> list[str]:
    needle = 'jockeyid=' if role == 'jockey' else 'trainerid='
    soup = BeautifulSoup(html, 'html.parser')
    found = []
    seen = set()
    for anchor in soup.select(f'a[href*="{needle}"]'):
        text = collapse(anchor.get_text(' ', strip=True))
        if text in SKIP_LINK or not text:
            continue
        match = re.search(rf'{needle}([A-Z0-9]+)', anchor.get('href') or '')
        if not match or not PERSON_ID.fullmatch(match.group(1)) or match.group(1) in seen:
            continue
        seen.add(match.group(1))
        found.append(match.group(1))
    if len(found) < 15:
        raise ParseMiss(f'{role} roster has {len(found)} names')
    return found


def course_code(value) -> str:
    text = collapse(str(value or ''))
    mapping = {'HV': 'HV', 'ST': 'ST', 'Happy Valley': 'HV', 'Sha Tin': 'ST', '跑馬地': 'HV', '沙田': 'ST'}
    if text not in mapping:
        raise ParseMiss(f'wind racecourse {value!r} is not Sha Tin or Happy Valley')
    return mapping[text]


def parse_wind_weather(payload: dict, digest: str, scraped_at: str) -> dict[str, list[dict]]:
    courses = (payload.get('data') or {}).get('weather')
    if not isinstance(courses, list) or not courses:
        raise ParseMiss('windtracker weather payload is empty')
    stations, sections = [], []
    seen_course = set()
    for item in courses:
        code = course_code(item.get('racecourse'))
        if code in seen_course:
            raise ParseMiss(f'{code} weather is repeated')
        seen_course.add(code)
        station = item.get('weatherStation') or {}
        if not isinstance(station, dict) or not station.get('date'):
            raise ParseMiss(f'{code} has no weather station')
        observed = str(station.get('date'))
        if not DATE_ISO.fullmatch(observed):
            raise ParseMiss(f'{code} station date {observed!r}')
        clock = blank(station.get('time'))
        if not clock:
            raise ParseMiss(f'{code} station time is blank')
        stations.append(stamp({
            'racecourse': code, 'location': blank(station.get('location')) or code,
            'observed_date': observed, 'observed_time': clock,
            'wind_direction': blank(station.get('avgCorrectedWindDirection')),
            'wind_speed': blank(station.get('avgCorrectedWindSpeed')),
            'gust_direction': blank(station.get('correctedGustDirection')),
            'gust_speed': blank(station.get('correctedGustSpeed')),
            'humidity': blank(station.get('relativeHumidity')),
            'temperature': blank(station.get('temperature')),
            'solar_radiation': blank(station.get('solarRadiation')),
            'sunshine_hour': blank(station.get('sunshineHour')),
            'pressure': blank(station.get('pressure')),
            'gust_speed_daily_max': blank(station.get('correctedGustSpeedDailyMax')),
            'humidity_daily_max': blank(station.get('relativeHumidityDailyMax')),
            'humidity_daily_min': blank(station.get('relativeHumidityDailyMin')),
            'temperature_daily_max': blank(station.get('temperatureDailyMax')),
            'temperature_daily_min': blank(station.get('temperatureDailyMin')),
            'rain_1min': blank(station.get('rainFallPrecipitation1Min')),
            'rain_10min': blank(station.get('rainFallPrecipitation10Min')),
            'rain_daily': blank(station.get('rainPrecipitationDailyTotal')),
            'soil_water': blank(station.get('soilVolumeticWaterContent')),
            'soil_loss_1min': blank(station.get('soilMoistureLoss1Min')),
            'soil_loss_daily': blank(station.get('soilMoistureLossDailyTotal')),
            'soil_loss_24h': blank(station.get('soilMoistureLoss24H')),
            'status': blank(station.get('status')),
            'is_valid': 1 if station.get('isValid') is True else 0,
            'gps_position': blank(station.get('gpsPosition')),
            'supply_voltage': blank(station.get('supplyVoltage')),
        }, digest, scraped_at))
        points = item.get('sectional') or []
        if not isinstance(points, list) or not points:
            raise ParseMiss(f'{code} has no sectional wind')
        seen_point = set()
        for point in points:
            location = blank(point.get('location'))
            if not location or location in seen_point:
                raise ParseMiss(f'{code} sectional location {location!r}')
            seen_point.add(location)
            point_date = str(point.get('date') or '')
            point_time = blank(point.get('time'))
            if not DATE_ISO.fullmatch(point_date) or not point_time:
                raise ParseMiss(f'{code} sectional date {point_date!r} {point.get("time")!r}')
            sections.append(stamp({
                'racecourse': code, 'location': location, 'observed_date': point_date,
                'observed_time': point_time,
                'wind_direction': blank(point.get('avgCorrectedWindDirection')),
                'wind_speed': blank(point.get('avgCorrectedWindSpeed')),
                'gust_direction': blank(point.get('correctedGustDirection')),
                'gust_speed': blank(point.get('correctedGustSpeed')),
                'status': blank(point.get('status')),
                'is_valid': 1 if point.get('isValid') is True else 0,
                'gps_position': blank(point.get('gpsPosition')),
                'supply_voltage': blank(point.get('supplyVoltage')),
            }, digest, scraped_at))
    return {'wind_station': stations, 'wind_section': sections}


def parse_wind_meeting(payload: dict, digest: str, scraped_at: str) -> dict[str, list[dict]]:
    meetings = (payload.get('data') or {}).get('commonMeetings') or []
    headers, going, probes = [], [], []
    for meeting in meetings:
        venue = str(meeting.get('venueCode') or '')
        if venue not in ('ST', 'HV'):
            continue
        meeting_date = str(meeting.get('date') or '')
        if not DATE_ISO.fullmatch(meeting_date):
            raise ParseMiss(f'wind meeting date {meeting_date!r}')
        races = meeting.get('races') or []
        race_count = meeting.get('totalNumberOfRace')
        if race_count is not None and int(race_count) != len(races):
            raise ParseMiss(f'{meeting_date} {venue} race count does not match the going list')
        headers.append(stamp({
            'meeting_date': meeting_date, 'venue': venue, 'status': blank(meeting.get('status')),
            'race_count': int(race_count) if race_count is not None else len(races),
            'meeting_track_ch': blank(meeting.get('meetingTrack_ch')),
        }, digest, scraped_at))
        for race in races:
            going.append(stamp({
                'meeting_date': meeting_date, 'venue': venue,
                'race_no': whole(race.get('no'), 'race'),
                'going_ch': blank(race.get('go_ch')),
                'track_code': blank((race.get('raceTrack') or {}).get('code')),
            }, digest, scraped_at))
        for instrument, key in (('penetrometer', 'penetrometerReadings'), ('hammer', 'hammerReadings')):
            for index, item in enumerate(meeting.get(key) or [], start=1):
                raw_reading = item.get('reading')
                reading = blank(raw_reading)
                if reading is not None and not READING.fullmatch(reading):
                    raise ParseMiss(f'{instrument} reading {raw_reading!r} is not a number or blank')
                probes.append(stamp({
                    'meeting_date': meeting_date, 'venue': venue, 'instrument': instrument,
                    'sequence_no': whole(item.get('sequenceNumber'), 'sequence') if item.get('sequenceNumber') not in (None, '') else index,
                    'reading_time': blank(item.get('readingTime')),
                    'reading': reading,
                }, digest, scraped_at))
    if not headers:
        raise ParseMiss('windtracker has no local meeting')
    return {'wind_meeting': headers, 'wind_going': going, 'wind_probe': probes}


def load_sires(root: Path) -> list[str]:
    path = root / 'horses' / 'profiles' / 'horse_profiles.csv'
    if not path.exists():
        raise IdentityError('horse profiles are missing, so same-sire names cannot be listed')
    sires = set()
    with path.open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            sire = collapse(row.get('父系'))
            if sire and sire not in ('沒有', '-', '--', '----'):
                if not SIRE_NAME.fullmatch(sire):
                    raise IdentityError(f'profile sire {sire!r} is not an English sire name')
                sires.add(sire)
    if len(sires) < 100:
        raise IdentityError('profile sire list is unexpectedly short')
    return sorted(sires)


def collect_fixture(root: Path, scraped_at: str) -> tuple[list[dict], str]:
    module = fixture_module()
    rows = []
    digests = []
    year = today_hkt().year
    for calendar_year in (year - 1, year, year + 1):
        for month in range(1, 13):
            url = f'{SITE}/zh-hk/local/information/fixture?calyear={calendar_year}&calmonth={month}'
            raw = fetch_bytes(url)
            digests.append(sha256(raw))
            html = raw.decode('utf-8', errors='replace')
            for line in module.parse_month_lines(html, calendar_year, month):
                rows.append(stamp(dict(line), sha256(raw), scraped_at))
    if not rows:
        raise ParseMiss('fixture calendar produced no class lines')
    digest = hashlib.sha256(''.join(digests).encode()).hexdigest()
    old = read_csv(data_dir(root) / FILES['fixture_line'][0], FIXTURE_COLUMNS)
    return merge_groups(old, rows, REPLACE_KEYS['fixture_line']), digest


def collect_results(root: Path, scraped_at: str) -> tuple[dict[str, list[dict]], str]:
    seed = fetch_bytes(f'{SITE}/zh-hk/local/information/resultsall')
    dates = result_dates(seed.decode('utf-8', errors='replace'))
    today = today_hkt()
    runners: list[dict] = []
    dividends: list[dict] = []
    digests = []
    for index, text in enumerate(dates, start=1):
        requested = iso_from_dmy(text)
        slash = f'{requested[0:4]}/{requested[5:7]}/{requested[8:10]}'
        raw = fetch_bytes(f'{SITE}/zh-hk/local/information/resultsall?RaceDate={slash}')
        digest = sha256(raw)
        try:
            parsed = parse_results_all(raw.decode('utf-8', errors='replace'), requested, digest, scraped_at)
        except DateMismatch:
            # Today and later can still be on the menu before the condensed table exists.
            if date.fromisoformat(requested) >= today:
                continue
            raise
        runners.extend(parsed['results_all_runner'])
        dividends.extend(parsed['results_all_dividend'])
        digests.append(digest)
        if index % 20 == 0:
            print(f'[results-all] {index}/{len(dates)}', flush=True)
    if not runners:
        raise ParseMiss('results-all stored no meetings')
    folder = data_dir(root)
    stored = {
        'results_all_runner': merge_groups(
            read_csv(folder / FILES['results_all_runner'][0], RUNNER_COLUMNS), runners, REPLACE_KEYS['results_all_runner'],
        ),
        'results_all_dividend': merge_groups(
            read_csv(folder / FILES['results_all_dividend'][0], DIVIDEND_COLUMNS), dividends, REPLACE_KEYS['results_all_dividend'],
        ),
    }
    return stored, hashlib.sha256(''.join(digests).encode()).hexdigest()


def collect_sires(root: Path, scraped_at: str) -> tuple[list[dict], list[dict], str]:
    pages, horses, digests = [], [], []
    sires = load_sires(root)
    for index, sire in enumerate(sires, start=1):
        url = f'{SITE}/zh-hk/local/information/samesire?{urlencode({"horsesire": sire, "View": "All"})}'
        raw = fetch_bytes(url)
        digest = sha256(raw)
        page, rows = parse_same_sire(raw.decode('utf-8', errors='replace'), sire, digest, scraped_at)
        pages.append(page)
        horses.extend(rows)
        digests.append(digest)
        if index % 50 == 0:
            print(f'[same-sire] {index}/{len(sires)}', flush=True)
    return pages, horses, hashlib.sha256(''.join(digests).encode()).hexdigest()


def collect_directory(root: Path, scraped_at: str) -> tuple[list[dict], list[str], str]:
    raw = fetch_bytes(f'{SITE}/zh-hk/local/information/selecthorse')
    menu = raw.decode('utf-8', errors='replace')
    links = directory_links(menu)
    rows = []
    pages = []
    digests = [sha256(raw)]
    trainer_ids = []
    for kind, key, label, href in links:
        if kind == 'stable':
            trainer_ids.append(key)
        page = fetch_bytes(SITE + href if href.startswith('/') else href)
        digest = sha256(page)
        digests.append(digest)
        title, parsed = parse_directory(page.decode('utf-8', errors='replace'), kind, key, label, digest, scraped_at)
        pages.append(stamp({
            'list_kind': kind, 'list_key': key, 'list_label': title, 'horse_count': len(parsed),
        }, digest, scraped_at))
        rows.extend(parsed)
    if not any(page['list_kind'] == 'location' and page['list_key'] == 'HK' and page['horse_count'] >= 100 for page in pages):
        raise ParseMiss('Hong Kong directory page was not stored')
    return rows, pages, trainer_ids, hashlib.sha256(''.join(digests).encode()).hexdigest()


def collect_persons(scraped_at: str, trainer_ids: list[str]) -> tuple[list[dict], list[dict], str]:
    seasons, grids, digests = [], [], []
    seed = fetch_bytes(f'{SITE}/zh-hk/local/information/jockeyprofile?jockeyid=HEL&Season=Current')
    jockeys = roster_ids(seed.decode('utf-8', errors='replace'), 'jockey')
    if 'HEL' not in jockeys:
        jockeys.insert(0, 'HEL')
    people = [('jockey', person_id) for person_id in jockeys]
    people.extend(('trainer', person_id) for person_id in trainer_ids)
    for role, person_id in people:
        if role == 'jockey':
            profile_url = f'{SITE}/zh-hk/local/information/jockeyprofile?jockeyid={person_id}&Season=Current'
            stat_url = f'{SITE}/zh-hk/local/information/jockeywinstat?jockeyid={person_id}&season=Current'
        else:
            profile_url = f'{SITE}/zh-hk/local/information/trainerprofile?trainerid={person_id}&season=Current'
            stat_url = f'{SITE}/zh-hk/local/information/trainerwinstat?trainerid={person_id}&season=Current'
        profile_raw = fetch_bytes(profile_url)
        stat_raw = fetch_bytes(stat_url)
        profile_digest = sha256(profile_raw)
        stat_digest = sha256(stat_raw)
        profile = parse_person_season(profile_raw.decode('utf-8', errors='replace'), role, person_id, profile_digest, scraped_at)
        stat_season, lines = parse_winstat(stat_raw.decode('utf-8', errors='replace'), role, person_id, stat_digest, scraped_at)
        if profile['person_name'] != stat_season['person_name'] or profile['as_of_date'] != stat_season['as_of_date']:
            raise IdentityError(f'{person_id} profile and win-stat pages are different seasons')
        if (profile['wins'], profile['starts']) != (stat_season['wins'], stat_season['starts']):
            raise IdentityError(f'{person_id} profile totals do not match the win-stat page')
        seasons.append(profile)
        grids.extend(lines)
        digests.extend((profile_digest, stat_digest))
    return seasons, grids, hashlib.sha256(''.join(digests).encode()).hexdigest()


def query_text(path: Path) -> str:
    text = path.read_text(encoding='utf-8')
    return '\n'.join(line for line in text.splitlines() if not line.strip().startswith('#'))


def collect_wind(root: Path, scraped_at: str) -> tuple[dict[str, list[dict]], str]:
    here = Path(__file__).resolve().parent
    weather_query = query_text(here / 'hkjc-wind-query.graphql')
    meeting_query = query_text(here / 'hkjc-track-condition-query.graphql')
    weather, weather_digest = graphql(weather_query, None)
    meeting, meeting_digest = graphql(meeting_query, MEETING_VARS)
    stored = parse_wind_weather(weather, weather_digest, scraped_at)
    stored.update(parse_wind_meeting(meeting, meeting_digest, scraped_at))
    folder = data_dir(root)
    merged = {}
    for name, rows in stored.items():
        merged[name] = merge_groups(
            read_csv(folder / FILES[name][0], FILES[name][1]), rows, REPLACE_KEYS[name],
        )
    digest = hashlib.sha256((weather_digest + meeting_digest).encode()).hexdigest()
    return merged, digest


def sql_literal(value) -> str:
    if value is None or value == '':
        return 'NULL'
    return "'" + str(value).replace("'", "''") + "'"


def sql_value(column: str, raw: str) -> str:
    if raw == '':
        return 'NULL'
    if column in INTEGER_COLUMNS:
        if not re.fullmatch(r'-?\d+', raw):
            raise IdentityError(f'{column} is not a stored number')
        return str(int(raw))
    return sql_literal(raw)


def emit_sql(root: Path) -> str:
    base = data_dir(root)
    statements = ['-- generated from data/official_wave8; official board upsert, not a model input']
    for table, (filename, columns) in FILES.items():
        path = base / filename
        if not path.exists():
            continue
        rows = read_csv(path, columns)
        sql_table = 'official_' + table
        statements.append(f'DELETE FROM {sql_table};')
        for row in rows:
            values = [sql_value(column, row.get(column, '') or '') for column in columns]
            statements.append(
                f"INSERT INTO {sql_table} ({', '.join(columns)}) VALUES ({', '.join(values)});"
            )
    return '\n'.join(statements) + '\n'


def store(root: Path, name: str, rows: list[dict]) -> None:
    filename, columns = FILES[name]
    write_csv(data_dir(root) / filename, columns, rows)


def collect(root: Path, surfaces: set[str]) -> dict[str, int]:
    scraped_at = scraped_now()
    summary: dict[str, int] = {}
    trainer_ids: list[str] = []
    if 'fixture' in surfaces:
        rows, digest = collect_fixture(root, scraped_at)
        store(root, 'fixture_line', rows)
        append_manifest(root, 'fixture', digest, scraped_at, len(rows))
        summary['fixture_line'] = len(rows)
    if 'results-all' in surfaces:
        stored, digest = collect_results(root, scraped_at)
        for name, rows in stored.items():
            store(root, name, rows)
            summary[name] = len(rows)
        append_manifest(root, 'results-all', digest, scraped_at, summary['results_all_runner'])
    if 'directory' in surfaces or 'persons' in surfaces:
        rows, pages, trainer_ids, digest = collect_directory(root, scraped_at)
        if 'directory' in surfaces:
            store(root, 'horse_directory_page', pages)
            store(root, 'horse_directory', rows)
            append_manifest(root, 'directory', digest, scraped_at, len(rows))
            summary['horse_directory'] = len(rows)
            summary['horse_directory_page'] = len(pages)
    if 'persons' in surfaces:
        if not trainer_ids:
            _rows, _pages, trainer_ids, _digest = collect_directory(root, scraped_at)
        seasons, grids, digest = collect_persons(scraped_at, trainer_ids)
        store(root, 'person_season', seasons)
        store(root, 'person_winstat', grids)
        append_manifest(root, 'persons', digest, scraped_at, len(seasons))
        summary['person_season'] = len(seasons)
        summary['person_winstat'] = len(grids)
    if 'same-sire' in surfaces:
        pages, horses, digest = collect_sires(root, scraped_at)
        store(root, 'same_sire_page', pages)
        store(root, 'same_sire', horses)
        append_manifest(root, 'same-sire', digest, scraped_at, len(horses))
        summary['same_sire'] = len(horses)
        summary['same_sire_page'] = len(pages)
    if 'wind' in surfaces:
        stored, digest = collect_wind(root, scraped_at)
        for name, rows in stored.items():
            store(root, name, rows)
            summary[name] = len(rows)
        append_manifest(root, 'wind', digest, scraped_at, summary.get('wind_station', 0))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Collect the remaining official HKJC surfaces')
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
    except (IdentityError, ParseMiss) as exc:
        raise SystemExit(str(exc)) from exc
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
