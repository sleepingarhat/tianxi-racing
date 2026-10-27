#!/usr/bin/env python3
"""Official HKJC P2 boards: rankings, draw window, JKC/TNC, favourites, allowance, new-horse blurbs, owner index.

Parsers keep the page's own numbers. Ranking uses the ranking page's GraphQL
documents unchanged. Percentage view is the page's rounded ratio of those
counts, not a second scrape and not a past-record total. Draw rows are the
HKJC historical window shown beside a meeting card, not that race's result.
New-horse text is the intro blurb, not a result.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

HKT = ZoneInfo('Asia/Hong_Kong')
GRAPHQL = 'https://info.cld.hkjc.com/graphql/base/'
SITE = 'https://racing.hkjc.com'
UA = (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
)
QUERY_FILE = Path(__file__).with_name('hkjc-official-board-queries.graphql')
MIGRATION = Path(__file__).resolve().parents[1] / 'backend/src/db/migrations/20261027_official_p2_boards.sql'
HORSE_ID = re.compile(r'^HK_\d{4}_[A-Z]\d{3}$')
PERSON_CODE = re.compile(r'^[A-Z][A-Z0-9]{1,5}$')
SEASON_CODE = re.compile(r'^\d{2}/\d{2}$')
BRAND = re.compile(r'^[A-Z]\d{3}$')
ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
COUNT_KEYS = ('numFirst', 'numSecond', 'numThird', 'numFourth', 'numFifth', 'numStarts')
RACECOURSE = {
    ('ALL', 'ALL'): 'ALL',
    ('ST', 'TURF'): 'STT',
    ('ST', 'AWT'): 'STA',
    ('HV', 'TURF'): 'HVT',
    ('CH', 'TURF'): 'CHT',
    ('CH', 'AWT'): 'CHA',
}
VENUE_LABEL = {'沙田': 'ST', '跑馬地': 'HV'}
BOARD_COLUMNS = [
    'role', 'season_code', 'season_scope', 'as_of_date', 'as_of_kind', 'racecourse', 'view_basis',
    'person_code', 'name_ch', 'name_en', 'status', 'section', 'wins', 'seconds', 'thirds', 'fourths',
    'fifths', 'starts', 'stake_won', 'dh_wins', 'dh_seconds', 'dh_thirds', 'dh_fourths', 'dh_fifths',
    'board_rank', 'source_sha256', 'scraped_at',
]
SLICE_COLUMNS = [
    'role', 'season_code', 'as_of_date', 'person_code', 'stat_set', 'slice_index', 'ven', 'trk',
    'wins', 'seconds', 'thirds', 'fourths', 'fifths', 'starts', 'stake_won', 'source_sha256', 'scraped_at',
]
DRAW_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'distance_m', 'course_label', 'draw', 'starts', 'wins', 'seconds',
    'thirds', 'fourths', 'win_pct', 'quinella_pct', 'place_pct', 'top4_pct', 'stat_window',
    'not_race_result', 'source_sha256', 'scraped_at',
]
DRAW_FAV_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'distance_m', 'course_label', 'win_pct', 'place_pct', 'top4_pct',
    'stat_window', 'not_race_result', 'source_sha256', 'scraped_at',
]
POOL_COLUMNS = [
    'pool', 'as_of_date', 'section', 'rank_no', 'person_name', 'kind', 'column_label', 'meeting_date',
    'points_text', 'points_value', 'source_sha256', 'scraped_at',
]
FAV_COLUMNS = [
    'role', 'as_of_date', 'person_name', 'starts', 'wins', 'places', 'hot_count', 'hot_pct', 'hot_wins',
    'hot_win_pct', 'hot_places', 'hot_place_pct', 'source_sha256', 'scraped_at',
]
FAV_SUM_COLUMNS = ['role', 'as_of_date', 'label', 'value_text', 'source_sha256', 'scraped_at']
ALLOW_COLUMNS = ['as_of_date', 'person_name', 'wins', 'allowance_lb', 'allowance_text', 'source_sha256', 'scraped_at']
OWNER_COLUMNS = ['owner_name', 'horse_id', 'horse_name', 'horse_code', 'quoted_count', 'source_sha256', 'scraped_at']
INTRO_COLUMNS = [
    'meeting_date', 'brand_no', 'horse_name', 'race_no', 'horse_no', 'as_of_date', 'body_text', 'origin',
    'colour', 'import_type', 'source_path', 'source_sha256', 'scraped_at', 'not_race_result',
]
SURFACES = ('rankings', 'draw', 'pools', 'favourites', 'allowance', 'new-horse', 'owners')
FILES = {
    'ranking_board': ('ranking_board.csv', BOARD_COLUMNS),
    'ranking_slice': ('ranking_slice.csv', SLICE_COLUMNS),
    'draw_stat': ('draw_stat.csv', DRAW_COLUMNS),
    'draw_favourite': ('draw_favourite.csv', DRAW_FAV_COLUMNS),
    'pool_stat': ('pool_stat.csv', POOL_COLUMNS),
    'favourite_stat': ('favourite_stat.csv', FAV_COLUMNS),
    'favourite_summary': ('favourite_summary.csv', FAV_SUM_COLUMNS),
    'jockey_allowance': ('jockey_allowance.csv', ALLOW_COLUMNS),
    'owner_horse': ('owner_horse.csv', OWNER_COLUMNS),
    'new_horse_intro': ('new_horse_intro.csv', INTRO_COLUMNS),
}
REPLACE_KEYS = {
    'ranking_board': ('role', 'season_code', 'as_of_date'),
    'ranking_slice': ('role', 'season_code', 'as_of_date'),
    'draw_stat': ('meeting_date', 'venue'),
    'draw_favourite': ('meeting_date', 'venue'),
    'pool_stat': ('pool', 'as_of_date'),
    'favourite_stat': ('role', 'as_of_date'),
    'favourite_summary': ('role', 'as_of_date'),
    'jockey_allowance': ('as_of_date',),
    'owner_horse': ('owner_name',),
    'new_horse_intro': ('meeting_date',),
}


class IdentityError(ValueError):
    """Page identity does not match the requested or displayed meeting."""


class BoardPending(Exception):
    """Official page says the board is not published yet."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_queries() -> dict[str, str]:
    text = QUERY_FILE.read_text(encoding='utf-8')
    parts = re.split(r'(?m)^# operation (\w+)\s*$', text)
    if len(parts) < 3 or len(parts) % 2 == 0:
        raise IdentityError('ranking query file is not the page operation list')
    found = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
    need = {'rw_GetJockeyRanking', 'rw_GetTrainerRanking', 'rw_LastMeeting', 'rw_RacingSeasonPeriod'}
    if set(found) != need:
        raise IdentityError('ranking query file operations changed')
    for name, query in found.items():
        if not query.startswith('query ' + name):
            raise IdentityError(f'{name} is not the page query')
    return found


def iso(value: date) -> str:
    return value.isoformat()


def parse_iso(value: str) -> date:
    if not ISO_DATE.fullmatch(value or ''):
        raise IdentityError(f'bad date {value!r}')
    return datetime.strptime(value, '%Y-%m-%d').date()


def today_hkt(now: datetime | None = None) -> date:
    current = now or datetime.now(HKT)
    if current.tzinfo is None:
        current = current.replace(tzinfo=HKT)
    return current.astimezone(HKT).date()


def epoch_hkt(ms) -> str:
    if isinstance(ms, str) and ms.isdigit():
        ms = int(ms)
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        raise IdentityError('new-horse meeting timestamp missing')
    return datetime.fromtimestamp(ms / 1000, HKT).date().isoformat()


def money(value, label: str = 'stakeWon'):
    """Official prize money. The page prints a rounded dollar; the stored value stays the returned figure."""
    if isinstance(value, bool) or value is None:
        raise IdentityError(f'{label} is not official prize money')
    if isinstance(value, int):
        number = value
    elif isinstance(value, float):
        number = value
    elif isinstance(value, str) and re.fullmatch(r'\d+(?:\.\d+)?', value.strip()):
        text = value.strip()
        number = float(text) if '.' in text else int(text)
    else:
        raise IdentityError(f'{label} is not official prize money')
    if isinstance(number, float) and not number.is_integer() and not str(number).endswith('.5'):
        # Keep tenths the API actually returns (seen as x.5). Anything else is not a stable copy.
        if abs(number * 2 - round(number * 2)) > 1e-6:
            raise IdentityError(f'{label} is not a whole or half dollar')
    if number < 0:
        raise IdentityError(f'{label} is negative')
    return int(number) if isinstance(number, float) and number.is_integer() else number


def whole(value, label: str) -> int:
    if isinstance(value, bool):
        raise IdentityError(f'{label} is not an official count')
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and re.fullmatch(r'-?\d+', value.strip()):
        number = int(value.strip())
    else:
        raise IdentityError(f'{label} is not an official count')
    if number < 0:
        raise IdentityError(f'{label} is negative')
    return number


def percent_number(value, label: str) -> int:
    number = whole(value, label)
    if number > 100:
        raise IdentityError(f'{label} percent above 100')
    return number


def board_percentage(count: int, starts: int) -> str:
    """Same display as the ranking page: (count/starts*100).toFixed(0), or 0% when starts is 0."""
    if starts < 0 or count < 0:
        raise IdentityError('percentage needs official counts')
    if starts == 0:
        return '0%'
    rounded = (Decimal(count) / Decimal(starts) * Decimal(100)).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
    return f'{int(rounded)}%'


def fetch_bytes(url: str, method: str = 'GET', body: bytes | None = None, headers: dict | None = None, attempts: int = 3) -> bytes:
    last = None
    for attempt in range(attempts):
        req_headers = {'user-agent': UA, 'accept-encoding': 'identity', 'accept-language': 'zh-HK,zh;q=0.9'}
        if headers:
            req_headers.update(headers)
        req = Request(url, data=body, headers=req_headers, method=method)
        try:
            with urlopen(req, timeout=40) as response:
                host = (response.geturl() or url).split('/')[2]
                if not (host == 'info.cld.hkjc.com' or host.endswith('hkjc.com')):
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
            if isinstance(exc, IdentityError):
                raise
            if attempt == attempts - 1:
                break
    raise IdentityError(f'official fetch failed for {url}: {last}')


def graphql(query: str, variables: dict) -> tuple[dict, str]:
    raw = fetch_bytes(GRAPHQL, 'POST', json.dumps({'query': query, 'variables': variables}).encode(),
                      {'content-type': 'application/json', 'accept': 'application/json'})
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IdentityError('ranking response is not JSON') from exc
    if body.get('errors') or not isinstance(body.get('data'), dict):
        raise IdentityError('ranking query rejected or incomplete')
    return body, sha256(raw)


def text_of(node) -> str:
    return node.get_text(' ', strip=True) if node else ''


def cells(row) -> list[str]:
    return [text_of(cell) for cell in row.find_all(['td', 'th'])]


def season_sort_key(code: str) -> int:
    if not SEASON_CODE.fullmatch(code or ''):
        raise IdentityError(f'bad season code {code!r}')
    return int(code.split('/')[0])


def resolve_recent_dates(labels: list[str], today: date) -> list[str]:
    """Map DD/MM column headers onto racedays. A future column is not an as-of date."""
    if len(labels) != 10:
        raise IdentityError('JKC/TNC board does not have ten raceday columns')
    parsed = []
    for label in labels:
        match = re.fullmatch(r'(\d{1,2})/(\d{1,2})', label)
        if not match:
            raise IdentityError(f'bad raceday column {label!r}')
        day, month = int(match.group(1)), int(match.group(2))
        parsed.append((day, month, label))
    day, month, _ = parsed[0]
    candidates = []
    for year in (today.year, today.year - 1):
        try:
            candidate = date(year, month, day)
        except ValueError as exc:
            raise IdentityError(f'impossible raceday column {parsed[0][2]}') from exc
        if candidate <= today and (today - candidate).days <= 100:
            candidates.append(candidate)
    if not candidates:
        raise IdentityError('latest JKC/TNC column is not a past raceday')
    cursor = max(candidates)
    found = [iso(cursor)]
    for day, month, label in parsed[1:]:
        year = cursor.year
        try:
            nxt = date(year, month, day)
        except ValueError as exc:
            raise IdentityError(f'impossible raceday column {label}') from exc
        if nxt >= cursor:
            year -= 1
            try:
                nxt = date(year, month, day)
            except ValueError as exc:
                raise IdentityError(f'impossible raceday column {label}') from exc
        if nxt >= cursor or nxt > today:
            raise IdentityError('JKC/TNC columns are not strictly earlier racedays')
        cursor = nxt
        found.append(iso(cursor))
    return found


def _slice_row(row: dict, stat_set: str) -> dict:
    ven, trk = row.get('ven'), row.get('trk')
    if (ven, trk) not in RACECOURSE:
        raise IdentityError(f'unknown ranking course {ven}/{trk}')
    counts = [whole(row.get(key), key) for key in COUNT_KEYS]
    # Season rows are a partition of starts. Dead-heat rows are tie-break counts and can show a place with 0 starts.
    if stat_set == 'ssn' and sum(counts[:5]) > counts[5]:
        raise IdentityError('ranking places exceed starts')
    return {
        'ven': ven, 'trk': trk, 'stat_set': stat_set,
        'wins': counts[0], 'seconds': counts[1], 'thirds': counts[2], 'fourths': counts[3],
        'fifths': counts[4], 'starts': counts[5], 'stake_won': money(row.get('stakeWon')),
    }


def _sum_rows(rows: list[dict]) -> dict:
    total = {key: 0 for key in ('wins', 'seconds', 'thirds', 'fourths', 'fifths', 'starts', 'stake_won')}
    for row in rows:
        for key in total:
            total[key] += row[key]
    return total


def build_rankings(payload: dict, role: str, season_code: str, season_scope: str, as_of_date: str,
                   as_of_kind: str, today: date, digest: str, scraped_at: str) -> tuple[list[dict], list[dict]]:
    if role not in ('jockey', 'trainer') or season_scope not in ('current', 'previous'):
        raise IdentityError('bad ranking scope')
    if as_of_kind not in ('last_meeting', 'season_end'):
        raise IdentityError('bad ranking as-of kind')
    as_of = parse_iso(as_of_date)
    if as_of > today:
        raise IdentityError('ranking as-of date is still in the future')
    field = 'jockeyStat' if role == 'jockey' else 'trainerStat'
    people = payload.get('data', {}).get(field)
    if not isinstance(people, list) or not people:
        raise IdentityError('official ranking is empty')
    slices, prepared = [], []
    for person in people:
        if person.get('season') != season_code or person.get('id') != person.get('code'):
            raise IdentityError('ranking season or code does not match the row')
        code = person.get('code') or ''
        if not PERSON_CODE.fullmatch(code):
            raise IdentityError(f'bad official code {code!r}')
        name_ch = (person.get('name_ch') or '').strip()
        name_en = (person.get('name_en') or '').strip()
        status = (person.get('status') or '').strip()
        if not name_ch or not name_en or not status:
            raise IdentityError(f'ranking identity incomplete for {code}')
        # The page drops a person whose season array is empty. Do not invent a zero row.
        if not person.get('ssnStat'):
            continue
        ssn = [_slice_row(row, 'ssn') for row in person.get('ssnStat') or []]
        dh = [_slice_row(row, 'dh') for row in person.get('dhStat') or []]
        all_rows = [row for row in ssn if (row['ven'], row['trk']) == ('ALL', 'ALL')]
        if len(all_rows) != 1:
            raise IdentityError(f'{code} does not have one ALL total')
        parts = [row for row in ssn if (row['ven'], row['trk']) != ('ALL', 'ALL')]
        summed = _sum_rows(parts)
        for key in ('wins', 'seconds', 'thirds', 'fourths', 'fifths', 'starts', 'stake_won'):
            if Decimal(str(summed[key])) != Decimal(str(all_rows[0][key])):
                raise IdentityError(f'{code} course slices do not add up to the ALL board')
        for index, row in enumerate(ssn + dh):
            slices.append({
                'role': role, 'season_code': season_code, 'as_of_date': as_of_date, 'person_code': code,
                'stat_set': row['stat_set'], 'slice_index': index if row['stat_set'] == 'ssn' else index - len(ssn),
                'ven': row['ven'], 'trk': row['trk'], 'wins': row['wins'], 'seconds': row['seconds'],
                'thirds': row['thirds'], 'fourths': row['fourths'], 'fifths': row['fifths'],
                'starts': row['starts'], 'stake_won': row['stake_won'], 'source_sha256': digest,
                'scraped_at': scraped_at,
            })
        prepared.append({'code': code, 'name_ch': name_ch, 'name_en': name_en, 'status': status, 'ssn': ssn, 'dh': dh})
    boards = []
    filters = ['ALL', 'STT', 'STA', 'HVT', 'CHT', 'CHA']
    for racecourse in filters:
        visible = []
        for person in prepared:
            if racecourse == 'ALL':
                numbers = next(row for row in person['ssn'] if (row['ven'], row['trk']) == ('ALL', 'ALL'))
                dh_rows = [row for row in person['dh'] if (row['ven'], row['trk']) == ('ALL', 'ALL')]
                if len(dh_rows) > 1:
                    raise IdentityError(f"{person['code']} has more than one ALL dead-heat row")
                dh = dh_rows[0] if dh_rows else None
                stake = numbers['stake_won']
            else:
                pair = next(key for key, value in RACECOURSE.items() if value == racecourse)
                numbers_rows = [row for row in person['ssn'] if (row['ven'], row['trk']) == pair]
                if not numbers_rows:
                    continue
                numbers = _sum_rows(numbers_rows)
                dh = _sum_rows([row for row in person['dh'] if (row['ven'], row['trk']) == pair])
                stake = None
            starts = numbers['starts']
            if season_scope == 'current' and person['status'] == 'Active':
                section = 'service'
            elif season_scope == 'current' and starts > 0:
                section = 'other'
            elif season_scope == 'previous' and starts > 0:
                section = 'previous'
            else:
                continue
            visible.append({
                'role': role, 'season_code': season_code, 'season_scope': season_scope, 'as_of_date': as_of_date,
                'as_of_kind': as_of_kind, 'racecourse': racecourse, 'view_basis': 'Numbers',
                'person_code': person['code'], 'name_ch': person['name_ch'], 'name_en': person['name_en'],
                'status': person['status'], 'section': section, 'wins': numbers['wins'], 'seconds': numbers['seconds'],
                'thirds': numbers['thirds'], 'fourths': numbers['fourths'], 'fifths': numbers['fifths'],
                'starts': starts, 'stake_won': stake,
                'dh_wins': 0 if dh is None else dh['wins'], 'dh_seconds': 0 if dh is None else dh['seconds'],
                'dh_thirds': 0 if dh is None else dh['thirds'], 'dh_fourths': 0 if dh is None else dh['fourths'],
                'dh_fifths': 0 if dh is None else dh['fifths'],
                'source_sha256': digest, 'scraped_at': scraped_at,
            })
        if racecourse == 'ALL' and not visible:
            raise IdentityError('ALL ranking board is empty')
        for section in ('service', 'other', 'previous'):
            group = [row for row in visible if row['section'] == section]
            group.sort(key=lambda row: (
                -row['wins'], row['dh_wins'], -row['seconds'], row['dh_seconds'], -row['thirds'], row['dh_thirds'],
                -row['fourths'], row['dh_fourths'], -row['fifths'], row['dh_fifths'], row['starts'], row['name_en'].upper(),
            ))
            for rank, row in enumerate(group, 1):
                row['board_rank'] = rank
                boards.append(row)
    return boards, slices


def ranking_context(queries: dict[str, str], today: date) -> list[dict]:
    last, _ = graphql(queries['rw_LastMeeting'], {'venueCodes': ['ST', 'HV', 'CH']})
    periods, _ = graphql(queries['rw_RacingSeasonPeriod'], {'locSim': 'LOCAL'})
    meeting = last.get('data', {}).get('lastMeeting') or {}
    meeting_date = meeting.get('date')
    meeting_season = meeting.get('season')
    parse_iso(meeting_date or '')
    if parse_iso(meeting_date) > today:
        raise IdentityError('last meeting date is in the future')
    if not SEASON_CODE.fullmatch(meeting_season or ''):
        raise IdentityError('last meeting season missing')
    period_rows = periods.get('data', {}).get('racingSeasonPeriod')
    if not isinstance(period_rows, list) or len(period_rows) < 2:
        raise IdentityError('official season list is incomplete')
    ordered = sorted(period_rows, key=lambda row: season_sort_key(row.get('code')), reverse=True)
    if ordered[0].get('code') != meeting_season:
        raise IdentityError('current season is not the last meeting season')
    previous = ordered[1]
    end = str(previous.get('endDate') or '').split('+', 1)[0]
    end_date = parse_iso(end)
    if end_date >= parse_iso(meeting_date):
        raise IdentityError('previous season end is not before the last meeting')
    return [
        {'season_code': meeting_season, 'season_scope': 'current', 'as_of_date': meeting_date, 'as_of_kind': 'last_meeting'},
        {'season_code': previous['code'], 'season_scope': 'previous', 'as_of_date': iso(end_date), 'as_of_kind': 'season_end'},
    ]


def collect_rankings(queries: dict[str, str], today: date, scraped_at: str) -> tuple[list[dict], list[dict]]:
    boards, slices = [], []
    for ctx in ranking_context(queries, today):
        for role, operation in (('jockey', 'rw_GetJockeyRanking'), ('trainer', 'rw_GetTrainerRanking')):
            payload, digest = graphql(queries[operation], {'season': ctx['season_code']})
            built, built_slices = build_rankings(payload, role, ctx['season_code'], ctx['season_scope'],
                                                  ctx['as_of_date'], ctx['as_of_kind'], today, digest, scraped_at)
            boards.extend(built)
            slices.extend(built_slices)
    return boards, slices


def parse_draw(raw: bytes, today: date, digest: str, scraped_at: str, requested_date: str = '', requested_venue: str = '') -> tuple[list[dict], list[dict]]:
    soup = BeautifulSoup(raw, 'html.parser')
    page = soup.get_text(' ', strip=True)
    pending = '將於排位表上網後不久公佈' in page
    tables = soup.select('div.searchResult table.table_bd')
    if pending and tables:
        raise IdentityError('draw page is both unpublished and populated')
    if pending:
        raise BoardPending('draw statistics are not published yet')
    if not tables:
        raise IdentityError('draw page has no official table')
    date_node = soup.select_one('td.font_wb')
    date_text = text_of(date_node)
    date_match = re.search(r'(\d{2})/(\d{2})/(\d{4})', date_text)
    venue_match = re.search(r'(沙田|跑馬地)', date_text)
    if not date_match or not venue_match:
        raise IdentityError('draw page meeting date or venue missing')
    meeting = date(int(date_match.group(3)), int(date_match.group(2)), int(date_match.group(1)))
    venue = VENUE_LABEL[venue_match.group(1)]
    button = text_of(soup.select_one('a.blueBtn1'))
    button_match = re.search(r'(\d{1,2})月(\d{1,2})日\s*-\s*(沙田|跑馬地)', button)
    if not button_match:
        raise IdentityError('draw page button does not name the meeting')
    if int(button_match.group(1)) != meeting.month or int(button_match.group(2)) != meeting.day or VENUE_LABEL[button_match.group(3)] != venue:
        raise IdentityError('draw page button disagrees with the meeting heading')
    if requested_date and requested_date != iso(meeting):
        raise IdentityError('draw page meeting is not the requested date')
    if requested_venue and requested_venue != venue:
        raise IdentityError('draw page venue is not the requested venue')
    window_node = soup.find(string=re.compile(r'三季來同一條跑道'))
    if not window_node:
        raise IdentityError('draw page is missing the historical-window note')
    stat_window = text_of(window_node.find_parent(['td', 'li', 'p']) or window_node.parent)
    if '三季來同一條跑道' not in stat_window:
        raise IdentityError('draw window note is not the official sentence')
    rows, favourites, race_numbers = [], [], []
    for table in tables:
        title = text_of(table.select_one('thead tr'))
        header = re.search(r'^第\s*(\d+)\s*場\s+(\d+)\s*米\s+(\S(?:.*\S)?)$', title)
        if not header:
            raise IdentityError(f'draw race heading unreadable: {title!r}')
        race_no = int(header.group(1))
        distance = int(header.group(2))
        course = header.group(3).strip()
        if not any(token in course for token in ('草地', '全天候', '泥地', '沙地')):
            raise IdentityError(f'draw course label unreadable: {course}')
        body = []
        for tr in table.select('tbody tr'):
            values = cells(tr)
            if not values or not values[0].isdigit():
                continue
            if len(values) < 10:
                raise IdentityError('draw row is short')
            draw = whole(values[0], 'draw')
            if draw < 1:
                raise IdentityError('draw number is invalid')
            starts, wins, seconds, thirds, fourths = [whole(values[i], 'draw count') for i in range(1, 6)]
            if wins + seconds + thirds + fourths > starts:
                raise IdentityError('draw places exceed starts')
            percents = [percent_number(values[i], 'draw percent') for i in range(6, 10)]
            body.append({
                'meeting_date': iso(meeting), 'venue': venue, 'race_no': race_no, 'distance_m': distance,
                'course_label': course, 'draw': draw, 'starts': starts, 'wins': wins, 'seconds': seconds,
                'thirds': thirds, 'fourths': fourths, 'win_pct': percents[0], 'quinella_pct': percents[1],
                'place_pct': percents[2], 'top4_pct': percents[3], 'stat_window': stat_window,
                'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
        if not body:
            raise IdentityError(f'draw race {race_no} has no rows')
        if len({row['draw'] for row in body}) != len(body):
            raise IdentityError(f'draw race {race_no} repeats a barrier')
        foot = text_of(table.select_one('tfoot'))
        fav = re.search(r'勝出率\s*(\d+)%\s*上名率\s*(\d+)%\s*前4名率\s*(\d+)%', foot)
        if not fav:
            raise IdentityError(f'draw race {race_no} is missing the historical favourite line')
        favourites.append({
            'meeting_date': iso(meeting), 'venue': venue, 'race_no': race_no, 'distance_m': distance,
            'course_label': course, 'win_pct': percent_number(fav.group(1), 'favourite'),
            'place_pct': percent_number(fav.group(2), 'favourite'),
            'top4_pct': percent_number(fav.group(3), 'favourite'), 'stat_window': stat_window,
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
        rows.extend(body)
        race_numbers.append(race_no)
    if race_numbers != list(range(1, len(race_numbers) + 1)):
        raise IdentityError('draw races are not a complete 1..N card')
    return rows, favourites


def _points(value: str):
    if value == '-':
        return '-', None
    if not re.fullmatch(r'\d+(?:\.\d+)?', value):
        raise IdentityError(f'bad JKC/TNC points {value!r}')
    return value, float(value) if '.' in value else int(value)


def parse_pool(raw: bytes, pool: str, today: date, digest: str, scraped_at: str) -> list[dict]:
    if pool not in ('jkc', 'tnc'):
        raise IdentityError('unknown pool')
    soup = BeautifulSoup(raw, 'html.parser')
    table = soup.select_one('table.table_bd')
    if not table:
        raise IdentityError('pool page has no table')
    header_rows = table.find_all('tr')
    if len(header_rows) < 4:
        raise IdentityError('pool table is short')
    labels = cells(header_rows[2])
    if len(labels) < 12 or labels[10] != '今季' or '季度' not in labels[11]:
        raise IdentityError('pool column headers are not the official ten racedays')
    dates = resolve_recent_dates(labels[:10], today)
    quarter = labels[11]
    rows, seen, section = [], set(), 'ranked'
    for tr in header_rows[3:]:
        values = cells(tr)
        if len(values) == 2:
            if values[1] not in ('其他騎師', '其他練馬師'):
                raise IdentityError('pool section row is not the official other-group label')
            section = 'other'
            continue
        if section == 'ranked':
            if len(values) != 16 or not values[0].isdigit():
                raise IdentityError('ranked pool row has an unexpected shape')
            rank, name, numbers = int(values[0]), values[1], values[2:]
        else:
            if len(values) != 15:
                raise IdentityError('other pool row has an unexpected shape')
            rank, name, numbers = None, values[0], values[1:]
        if not name or name in seen:
            raise IdentityError('pool person name missing or duplicated')
        seen.add(name)
        if numbers[11] != '' or len(numbers) != 14:
            raise IdentityError('pool average spacer is not where the page puts it')
        meeting_points = numbers[:10]
        recent, season_avg, quarter_avg = numbers[10], numbers[12], numbers[13]
        for label, meeting_date, points in zip(labels[:10], dates, meeting_points):
            text, numeric = _points(points)
            rows.append({
                'pool': pool, 'as_of_date': dates[0], 'section': section, 'rank_no': rank, 'person_name': name,
                'kind': 'meeting', 'column_label': meeting_date, 'meeting_date': meeting_date,
                'points_text': text, 'points_value': numeric, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
        for kind, label, points in (
            ('recent_avg', '平均賽事日積分', recent),
            ('season_avg', '今季', season_avg),
            ('quarter_avg', quarter, quarter_avg),
        ):
            text, numeric = _points(points)
            rows.append({
                'pool': pool, 'as_of_date': dates[0], 'section': section, 'rank_no': rank, 'person_name': name,
                'kind': kind, 'column_label': label, 'meeting_date': '', 'points_text': text,
                'points_value': numeric, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
    if not rows:
        raise IdentityError('pool board is empty')
    return rows


FAV_HEADERS = {
    'jockey': ['騎師', '出賽次數', '頭馬', '位置', '大熱', '大熱%', '大熱勝出', '大熱勝出%', '大熱入位', '大熱入位%'],
    'trainer': ['練馬師', '出馬', '頭馬', '位置', '大熱', '大熱%', '大熱勝出', '大熱勝出%', '大熱入位', '大熱入位%'],
}


def favourite_footer_label(values: list[str]) -> str | None:
    """The live board closes with a blank colspan row, then 其他, and sometimes a rule.

    Those rows publish no counts. A person named 其他 with invented zeros would not be the page.
    """
    if len(values) == 10:
        return None
    label = ' '.join(part for part in values if part.strip()).strip()
    if label == '':
        return 'blank'
    if label in ('其他', '---'):
        return label
    return None


def parse_favourite(raw: bytes, role: str, today: date, digest: str, scraped_at: str) -> tuple[list[dict], list[dict]]:
    soup = BeautifulSoup(raw, 'html.parser')
    table = soup.select_one('table.table_bd')
    summary = soup.select_one('table.tb_botm')
    if not table or not summary:
        raise IdentityError('favourite page is missing the board or the total')
    header_rows = table.find_all('tr')
    title = text_of(header_rows[0])
    match = re.search(r'截至賽事日:\s*(\d{2})/(\d{2})/(\d{4})', title)
    if not match or ('騎師大熱' if role == 'jockey' else '練馬師大熱') not in title:
        raise IdentityError('favourite as-of date or title missing')
    as_of = date(int(match.group(3)), int(match.group(2)), int(match.group(1))).isoformat()
    if parse_iso(as_of) > today:
        raise IdentityError('favourite as-of date is still in the future')
    if cells(header_rows[1]) != FAV_HEADERS[role]:
        raise IdentityError('favourite columns are not the official header')
    people, seen, footers = [], set(), []
    for tr in header_rows[2:]:
        values = cells(tr)
        footer = favourite_footer_label(values)
        if footer is not None:
            footers.append(footer)
            continue
        if len(values) != 10:
            raise IdentityError('favourite row shape changed')
        if footers:
            raise IdentityError('favourite person row follows the official footer')
        name = values[0]
        if not name or name in seen:
            raise IdentityError('favourite name missing or duplicated')
        seen.add(name)
        numbers = [whole(item, 'favourite') for item in values[1:5]]
        percents = [percent_number(item, 'favourite') for item in (values[5], values[7], values[9])]
        counts = [whole(values[6], 'favourite'), whole(values[8], 'favourite')]
        starts, wins, places, hot_count = numbers
        if wins > starts or places > starts or hot_count > starts or counts[0] > hot_count or counts[1] > hot_count:
            raise IdentityError('favourite counts are not inside the official starts')
        people.append({
            'role': role, 'as_of_date': as_of, 'person_name': name, 'starts': numbers[0], 'wins': numbers[1],
            'places': numbers[2], 'hot_count': numbers[3], 'hot_pct': percents[0], 'hot_wins': counts[0],
            'hot_win_pct': percents[1], 'hot_places': counts[1], 'hot_place_pct': percents[2],
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if footers[:2] != ['blank', '其他'] or footers[2:] not in ([], ['---']):
        raise IdentityError('favourite board is missing the official 其他 footer')
    if not people:
        raise IdentityError('favourite board is empty')
    totals = []
    for tr in summary.find_all('tr'):
        values = cells(tr)
        if len(values) != 2 or not values[0] or not values[1]:
            raise IdentityError('favourite total row unreadable')
        totals.append({'role': role, 'as_of_date': as_of, 'label': values[0], 'value_text': values[1],
                       'source_sha256': digest, 'scraped_at': scraped_at})
    if not totals:
        raise IdentityError('favourite totals missing')
    return people, totals


def parse_allowance(raw: bytes, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw, 'html.parser')
    table = soup.select_one('table.table_bd')
    if not table:
        raise IdentityError('allowance page has no table')
    header_rows = table.find_all('tr')
    title = ' '.join(cells(header_rows[0]))
    match = re.search(r'截至賽事日:\s*(\d{2})/(\d{2})/(\d{4})', title)
    if not match or '本地騎師讓磅' not in soup.get_text(' ', strip=True):
        raise IdentityError('allowance as-of date missing')
    as_of = date(int(match.group(3)), int(match.group(2)), int(match.group(1))).isoformat()
    if parse_iso(as_of) > today:
        raise IdentityError('allowance as-of date is still in the future')
    if cells(header_rows[1])[:3] != ['騎師', '頭馬次數', '現時讓磅']:
        raise IdentityError('allowance columns changed')
    rows, seen = [], set()
    for tr in header_rows[2:]:
        values = cells(tr)
        if len(values) < 3:
            raise IdentityError('allowance row short')
        name, wins, allowance = values[0], values[1], values[2]
        if not name or name in seen:
            raise IdentityError('allowance name missing or duplicated')
        seen.add(name)
        if allowance == '--':
            pounds = None
        else:
            found = re.fullmatch(r'(\d+)\s*磅', allowance)
            if not found:
                raise IdentityError(f'allowance text unreadable: {allowance!r}')
            pounds = int(found.group(1))
        rows.append({
            'as_of_date': as_of, 'person_name': name, 'wins': whole(wins, 'allowance wins'),
            'allowance_lb': pounds, 'allowance_text': allowance, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise IdentityError('allowance board is empty')
    return rows


def parse_owner(raw: bytes, expected_owner: str, profiles: dict[str, str], digest: str, scraped_at: str,
               names: dict[str, str] | None = None) -> list[dict]:
    if expected_owner is None or expected_owner == '':
        raise IdentityError('owner query is empty')
    soup = BeautifulSoup(raw, 'html.parser')
    table = soup.select_one('table.searchedData')
    blob = text_of(table) if table else ''
    match = re.search(r'共有(\d+)匹馬之馬主為"([^"]*)"', blob)
    if not match:
        raise IdentityError('owner search did not echo an owner')
    count = int(match.group(1))
    quoted = match.group(2)
    if quoted != expected_owner:
        raise IdentityError('owner search echo is not the profile owner string')
    links = table.select('a[href*="horseid="]')
    if len(links) != count:
        raise IdentityError('owner search count does not match horse links')
    rows, seen = [], set()
    for link in links:
        href = link.get('href') or ''
        found = re.search(r'horseid=(HK_\d{4}_[A-Z]\d{3})', href)
        if not found or not HORSE_ID.fullmatch(found.group(1)):
            raise IdentityError('owner search horse link is not a local horse id')
        horse_id = found.group(1)
        if horse_id in seen:
            raise IdentityError('owner search repeats a horse')
        seen.add(horse_id)
        horse_name = text_of(link)
        if not horse_name:
            raise IdentityError('owner search horse has no name')
        code = horse_id.rsplit('_', 1)[-1]
        profile_owner = profiles.get(code)
        profile_name = ((names or {}).get(code) or '').split(' (')[0].strip()
        # Brand numbers are reused. Compare owners only when the profile name is this horse.
        if profile_owner is not None and profile_owner != quoted and (not profile_name or profile_name == horse_name):
            raise IdentityError(f'{code} profile owner is not the search echo')
        rows.append({
            'owner_name': quoted, 'horse_id': horse_id, 'horse_name': horse_name, 'horse_code': code,
            'quoted_count': count, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise IdentityError('owner echo listed horses but none were linked')
    return rows


def load_profile_owners(path: Path) -> tuple[dict[str, str], dict[str, str], list[str]]:
    profiles, names, active = {}, {}, []
    with path.open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            code = row.get('horse_no') or ''
            owner = row.get('馬主')
            if owner is None:
                continue
            if code and owner:
                if code in profiles and profiles[code] != owner:
                    raise IdentityError(f'profile file disagrees on owner of {code}')
                profiles[code] = owner
                names[code] = row.get('name') or ''
            if row.get('status') == 'active' and owner:
                active.append(owner)
    return profiles, names, sorted(set(active))


def parse_new_horse_list(payload: dict) -> list[dict]:
    meetings = payload.get('data')
    if not isinstance(meetings, list) or not meetings:
        raise IdentityError('new-horse list is empty')
    parsed = []
    for meeting in meetings:
        name = meeting.get('name') or ''
        if not re.fullmatch(r'\d{8}', name):
            raise IdentityError('new-horse meeting name is not a date')
        path = meeting.get('path') or ''
        if not path.endswith('/' + name):
            raise IdentityError('new-horse path date disagrees with the meeting name')
        meeting_date = f'{name[0:4]}-{name[4:6]}-{name[6:8]}'
        parse_iso(meeting_date)
        if meeting.get('date') is not None and epoch_hkt(meeting.get('date')) != meeting_date:
            raise IdentityError('new-horse timestamp disagrees with the meeting name')
        horses = []
        for child in meeting.get('children') or []:
            brand = ((child.get('brandNo') or {}).get('value') or '').strip()
            horse_name = ((child.get('horseName') or {}).get('value') or '').strip()
            race_no = ((child.get('raceNo') or {}).get('value') or '').strip()
            horse_no = ((child.get('horseNo') or {}).get('value') or '').strip()
            child_path = child.get('path') or ''
            # Declared runners are 1, 2, 3… Reserves on the same card are R1, R2.
            if not BRAND.fullmatch(brand) or not horse_name or not race_no.isdigit() or not re.fullmatch(r'R?\d+', horse_no):
                raise IdentityError('new-horse list identity incomplete')
            # Older CMS items sometimes use an English leaf instead of the brand.
            # The meeting folder still has to be this date. The brand leaf is checked
            # when the meeting is actually selected, so a stale path cannot be fetched.
            if f'/{name}/' not in child_path:
                raise IdentityError('new-horse path does not match brand and meeting')
            stamp = (child.get('raceDate') or {}).get('dateValue')
            if stamp is not None and epoch_hkt(stamp) != meeting_date:
                raise IdentityError('new-horse race date disagrees with the meeting')
            horses.append({'brand': brand, 'horse_name': horse_name, 'race_no': race_no, 'horse_no': horse_no, 'path': child_path})
        parsed.append({'meeting_date': meeting_date, 'horses': horses})
    return parsed


def parse_new_horse_body(raw_html: str, item: dict, today: date, digest: str, scraped_at: str) -> dict:
    soup = BeautifulSoup(raw_html, 'html.parser')
    text = soup.get_text('\n', strip=True)
    title = text_of(soup.select_one('.horse_name a') or soup.find('a'))
    title_match = re.fullmatch(r'(.+?)\(([A-Z]\d{3})\)', title.replace('（', '(').replace('）', ')'))
    if not title_match:
        raise IdentityError('new-horse title is not name(brand)')
    if title_match.group(1) != item['horse_name'] or title_match.group(2) != item['brand']:
        raise IdentityError('new-horse title does not match the list identity')
    as_of = re.search(r'資料及評語\s*[（(]截至\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日', text)
    if not as_of:
        raise IdentityError('new-horse as-of date missing')
    as_of_date = date(int(as_of.group(1)), int(as_of.group(2)), int(as_of.group(3))).isoformat()
    if parse_iso(as_of_date) > today:
        raise IdentityError('new-horse comment date is still in the future')
    if parse_iso(as_of_date) > parse_iso(item['meeting_date']):
        raise IdentityError('new-horse comment date is after the meeting it introduces')
    body_match = re.search(r'評語及展望\s*[:：]\s*(.+)\Z', text, re.S)
    if not body_match:
        raise IdentityError('new-horse comment body missing')
    body = body_match.group(1).strip()
    if not body or '服役時頭馬數目' in body or '出賽子嗣數目' in body:
        raise IdentityError('new-horse body is pedigree counts, not the comment')
    try:
        facts = text.split('馬匹資料', 1)[1].split('血統表', 1)[0]
    except IndexError as exc:
        raise IdentityError('new-horse profile block missing') from exc
    def fact(label: str) -> str:
        found = re.search(label + r'\s*[:：]\s*(\S+)', facts)
        return found.group(1) if found else ''
    return {
        'meeting_date': item['meeting_date'], 'brand_no': item['brand'], 'horse_name': item['horse_name'],
        'race_no': item['race_no'], 'horse_no': item['horse_no'], 'as_of_date': as_of_date, 'body_text': body,
        'origin': fact('出生地'), 'colour': fact('毛色'), 'import_type': fact('進口類別'),
        'source_path': item['path'], 'source_sha256': digest, 'scraped_at': scraped_at, 'not_race_result': 1,
    }


def select_intro_meetings(meetings: list[dict], anchor: date, back_days: int, forward_days: int, requested: str = '') -> list[dict]:
    if requested:
        chosen = [meeting for meeting in meetings if meeting['meeting_date'] == requested]
        if not chosen:
            raise IdentityError('requested new-horse meeting is not on the official list')
    else:
        start, end = anchor - timedelta(days=back_days), anchor + timedelta(days=forward_days)
        chosen = [meeting for meeting in meetings if start <= parse_iso(meeting['meeting_date']) <= end]
    for meeting in chosen:
        folder = meeting['meeting_date'].replace('-', '')
        for horse in meeting['horses']:
            path = horse['path']
            if f'/{folder}/' not in path or not path.endswith('/' + horse['brand']):
                raise IdentityError('new-horse path does not match brand and meeting')
    return chosen


def read_csv(path: Path, columns: list[str]) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding='utf-8-sig', newline='') as handle:
        rows = list(csv.DictReader(handle))
    if rows and list(rows[0].keys()) != columns:
        raise IdentityError(f'{path.name} columns changed')
    return rows


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator='\n', extrasaction='raise')
    writer.writeheader()
    for row in rows:
        writer.writerow({key: '' if row.get(key) is None else row.get(key) for key in columns})
    path.write_bytes(('\ufeff' + buffer.getvalue()).encode('utf-8'))


def merge_rows(existing: list[dict], fresh: list[dict], keys: tuple[str, ...]) -> list[dict]:
    fresh_keys = {tuple(str(row[key]) for key in keys) for row in fresh}
    kept = [row for row in existing if tuple(str(row[key]) for key in keys) not in fresh_keys]
    merged = kept + fresh
    merged.sort(key=lambda row: tuple(str(row[key]) for key in keys))
    return merged


def store_surface(root: Path, name: str, rows: list[dict]) -> None:
    filename, columns = FILES[name]
    path = root / 'data' / 'official_p2' / filename
    merged = merge_rows(read_csv(path, columns), rows, REPLACE_KEYS[name])
    write_csv(path, columns, merged)


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = root / 'data' / 'official_p2' / 'manifest.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({'surface': surface, 'sha256': digest, 'scraped_at': scraped_at, 'rows': row_count},
                      ensure_ascii=False, sort_keys=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def sql_literal(value) -> str:
    if value is None or value == '':
        return 'NULL'
    if isinstance(value, bool):
        raise IdentityError('refusing boolean SQL value')
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    text = str(value)
    return "'" + text.replace("'", "''") + "'"


def emit_sql(root: Path) -> str:
    base = root / 'data' / 'official_p2'
    statements = ['-- generated from data/official_p2; official board upsert, not a race result']
    integer_columns = {
        'wins', 'seconds', 'thirds', 'fourths', 'fifths', 'starts', 'dh_wins', 'dh_seconds',
        'dh_thirds', 'dh_fourths', 'dh_fifths', 'board_rank', 'slice_index', 'race_no', 'distance_m', 'draw',
        'win_pct', 'quinella_pct', 'place_pct', 'top4_pct', 'not_race_result', 'rank_no', 'hot_count',
        'hot_pct', 'hot_wins', 'hot_win_pct', 'hot_places', 'hot_place_pct', 'places', 'allowance_lb',
        'quoted_count', 'points_value',
    }
    decimal_columns = {'stake_won', 'points_value'}
    for table, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        sql_table = 'official_' + table
        if table == 'owner_horse':
            owners = sorted({row['owner_name'] for row in rows})
            for owner in owners:
                statements.append(f"DELETE FROM {sql_table} WHERE owner_name = {sql_literal(owner)};")
        for row in rows:
            values = []
            for column in columns:
                raw = row.get(column, '')
                if raw == '':
                    values.append('NULL')
                elif column in decimal_columns and re.fullmatch(r'\d+\.\d+', raw):
                    values.append(raw)
                elif column in integer_columns or column in decimal_columns:
                    if not re.fullmatch(r'-?\d+', raw):
                        raise IdentityError(f'{column} is not a stored number')
                    values.append(str(int(raw)))
                else:
                    values.append(sql_literal(raw))
            statements.append(
                f"INSERT OR REPLACE INTO {sql_table} ({', '.join(columns)}) VALUES ({', '.join(values)});"
            )
    return '\n'.join(statements) + '\n'


def apply_sql(db_path: Path, sql_text: str) -> None:
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(MIGRATION.read_text(encoding='utf-8'))
        connection.executescript(sql_text)
        connection.commit()
    finally:
        connection.close()


def scraped_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def run(root: Path, surfaces: list[str], today: date, requested_date: str = '', requested_venue: str = '',
        owners: list[str] | None = None, workers: int = 4) -> dict:
    unknown = [name for name in surfaces if name not in SURFACES]
    if unknown:
        raise IdentityError(f'unknown surfaces {unknown}')
    scraped_at = scraped_now()
    queries = load_queries()
    summary = {}
    if 'rankings' in surfaces:
        boards, slices = collect_rankings(queries, today, scraped_at)
        store_surface(root, 'ranking_board', boards)
        store_surface(root, 'ranking_slice', slices)
        append_manifest(root, 'rankings', boards[0]['source_sha256'], scraped_at, len(boards))
        summary['rankings'] = len(boards)
    if 'draw' in surfaces:
        url = SITE + '/zh-hk/local/information/draw'
        try:
            raw = fetch_bytes(url)
            rows, favs = parse_draw(raw, today, sha256(raw), scraped_at, requested_date, requested_venue)
        except BoardPending:
            if requested_date:
                raise IdentityError('requested draw meeting is not published') from None
            summary['draw'] = 'pending'
        else:
            store_surface(root, 'draw_stat', rows)
            store_surface(root, 'draw_favourite', favs)
            append_manifest(root, 'draw', sha256(raw), scraped_at, len(rows))
            summary['draw'] = len(rows)
    if 'pools' in surfaces:
        pool_rows = []
        for pool, path in (('jkc', 'jkcstat'), ('tnc', 'tncstat')):
            raw = fetch_bytes(f'{SITE}/zh-hk/local/information/{path}')
            pool_rows.extend(parse_pool(raw, pool, today, sha256(raw), scraped_at))
        store_surface(root, 'pool_stat', pool_rows)
        append_manifest(root, 'pools', pool_rows[0]['source_sha256'], scraped_at, len(pool_rows))
        summary['pools'] = len(pool_rows)
    if 'favourites' in surfaces:
        people, totals = [], []
        for role, path in (('jockey', 'jockeyfavourite'), ('trainer', 'trainerfavourite')):
            raw = fetch_bytes(f'{SITE}/zh-hk/local/information/{path}')
            person_rows, total_rows = parse_favourite(raw, role, today, sha256(raw), scraped_at)
            people.extend(person_rows)
            totals.extend(total_rows)
        store_surface(root, 'favourite_stat', people)
        store_surface(root, 'favourite_summary', totals)
        append_manifest(root, 'favourites', people[0]['source_sha256'], scraped_at, len(people))
        summary['favourites'] = len(people)
    if 'allowance' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/information/jockeyallowance')
        rows = parse_allowance(raw, today, sha256(raw), scraped_at)
        store_surface(root, 'jockey_allowance', rows)
        append_manifest(root, 'allowance', sha256(raw), scraped_at, len(rows))
        summary['allowance'] = len(rows)
    if 'new-horse' in surfaces:
        raw = fetch_bytes(SITE + '/contentAsset/api/getNewHorse', 'POST', json.dumps({'lang': 'zh-hk'}).encode(),
                          {'content-type': 'application/json', 'accept': 'application/json'})
        meetings = select_intro_meetings(parse_new_horse_list(json.loads(raw)), today, 14, 14, requested_date)
        intros = []
        for meeting in meetings:
            for horse in meeting['horses']:
                detail = fetch_bytes(SITE + '/contentAsset/api/getNewHorse', 'POST',
                                     json.dumps({'lang': 'zh-hk', 'detail': True, 'path': horse['path']}).encode(),
                                     {'content-type': 'application/json', 'accept': 'application/json'})
                body = json.loads(detail)
                html = ((body.get('data') or {}).get('contents') or {}).get('rendered')
                if not html:
                    raise IdentityError(f"new-horse body missing for {horse['brand']}")
                item = dict(horse, meeting_date=meeting['meeting_date'])
                try:
                    intros.append(parse_new_horse_body(html, item, today, sha256(detail), scraped_at))
                except IdentityError as exc:
                    raise IdentityError(f"{horse['brand']} {meeting['meeting_date']}: {exc}") from exc
        if intros:
            store_surface(root, 'new_horse_intro', intros)
            append_manifest(root, 'new-horse', intros[0]['source_sha256'], scraped_at, len(intros))
        summary['new-horse'] = len(intros)
    if 'owners' in surfaces:
        profile_path = root / 'horses/profiles/horse_profiles.csv'
        profiles, names, active = load_profile_owners(profile_path)
        chosen = owners if owners is not None else active
        if not chosen:
            raise IdentityError('no owner strings to search')
        owner_rows = []

        def one(owner: str):
            raw = fetch_bytes(SITE + '/zh-hk/local/information/ownersearch?' + urlencode({'horseowner': owner}))
            return parse_owner(raw, owner, profiles, sha256(raw), scraped_at, names)

        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = [pool.submit(one, owner) for owner in chosen]
            for future in as_completed(futures):
                owner_rows.extend(future.result())
        store_surface(root, 'owner_horse', owner_rows)
        append_manifest(root, 'owners', owner_rows[0]['source_sha256'], scraped_at, len(owner_rows))
        summary['owners'] = len(owner_rows)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Scrape official HKJC P2 boards into CSV and optional SQL')
    parser.add_argument('--root', default='.')
    parser.add_argument('--surfaces', default=','.join(SURFACES))
    parser.add_argument('--date', default='', help='YYYY-MM-DD identity for draw and new-horse; blank follows the page')
    parser.add_argument('--venue', default='', help='ST or HV when --date is set for draw')
    parser.add_argument('--owner', default='', help='One owner string; blank uses active profile owners')
    parser.add_argument('--emit-sql', default='', help='Write D1 upsert SQL from CSV and exit')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    root = Path(args.root)
    if args.emit_sql:
        Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
        return
    if args.date:
        parse_iso(args.date)
    if args.venue and args.venue not in ('ST', 'HV'):
        raise SystemExit('venue must be ST or HV')
    surfaces = [part.strip() for part in args.surfaces.split(',') if part.strip()]
    owners = [args.owner] if args.owner else None
    summary = run(root, surfaces, today_hkt(), args.date, args.venue, owners, args.workers)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
