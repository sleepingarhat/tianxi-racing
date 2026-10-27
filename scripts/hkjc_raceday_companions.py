#!/usr/bin/env python3
"""Race-day HKJC companion pages: last-start comments, form lines, exceptional factors,
the day's veterinary list, the meeting trackwork board, jockey/trainer rides, and the
summary going / pool list / suspensions.

HTML pages are read as tables. GraphQL documents are the three page bundles in
hkjc-raceday-companion-queries.graphql and are not extended. Summary dividends,
jackpots, penetrometer and hammer readings are requested only because that document
includes them; they are not stored. Rows are the public board, not race results.
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
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
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
QUERY_FILE = Path(__file__).with_name('hkjc-raceday-companion-queries.graphql')
MIGRATION = Path(__file__).resolve().parents[1] / 'backend/src/db/migrations/20261027_raceday_companions.sql'
HORSE_ID = re.compile(r'^HK_\d{4}_[A-Z]\d{3}$')
BRAND = re.compile(r'^[A-Z]\d{3}$')
PERSON = re.compile(r'^[A-Z][A-Z0-9]{1,5}$')
ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
SIGNED = re.compile(r'^[+-]?\d+$')
BLANK_TOKENS = {'', '--', '-', '—'}
VENUE_NAME = {'沙田': 'ST', '跑馬地': 'HV', '從化': 'CH'}
NAME_VENUE = {'ST': '沙田', 'HV': '跑馬地'}
GOING = '[好黏軟爛快地偏重至濕大]+'
LOCAL_VENUES = {'ST', 'HV'}
HTML_SURFACES = {
    'report': 'racereportext',
    'formline': 'formline',
    'exceptional': 'exceptionalfactors',
    'veterinary': 'veterinaryrecord',
    'trackwork': 'localtrackwork',
}
SURFACES = ('report', 'formline', 'exceptional', 'veterinary', 'trackwork', 'rides', 'summary')
OPERATIONS = ('rw_JockeysRides', 'rw_TrainersEntries', 'rw_Summary')
TRACKWORK_COLUMNS = (
    (2, 'BarrierTrial', 'trial'),
    (3, 'Gallop', 'gallop'),
    (4, 'Trotting', 'trot'),
    (5, 'Swimming', 'swim'),
    (6, 'Treadmill', 'treadmill'),
    (7, 'AquaWalker', 'aqua'),
    (8, 'Spelling', 'spell'),
)
REPORT_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'runner_section', 'horse_no', 'horse_code', 'horse_id', 'horse_name',
    'previous_run_date', 'previous_race_label', 'previous_race_no', 'previous_venue', 'description',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FORMLINE_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'prior_date', 'prior_race_label', 'prior_race_no', 'prior_venue',
    'prior_distance_m', 'prior_class', 'prior_rail', 'prior_going', 'line_no', 'horse_name',
    'weight_text', 'weight_lb', 'prior_weight_lb', 'rating_text', 'rating', 'prior_rating',
    'draw_text', 'draw', 'prior_draw', 'jockey_name', 'prior_jockey_name', 'placing', 'finish_time',
    'margin', 'odds_text', 'weight_diff', 'rating_diff', 'not_race_result', 'source_sha256', 'scraped_at',
]
EXCEPTIONAL_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'horse_no', 'horse_name', 'weight_loss', 'age_allowance', 'gear',
    'tongue_tie', 'previous_bit', 'current_bit', 'rating_change', 'distance_change', 'days_since',
    'trainer_change', 'conghua_return_date', 'not_race_result', 'source_sha256', 'scraped_at',
]
VETERINARY_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'horse_no', 'line_no', 'horse_id', 'horse_name', 'injury_date',
    'detail', 'passed_date', 'not_race_result', 'source_sha256', 'scraped_at',
]
TRACKWORK_FIELDS = [
    'meeting_date', 'venue', 'race_no', 'runner_section', 'horse_no', 'category', 'line_no', 'horse_id', 'horse_name',
    'trainer_code', 'trainer_name', 'recent_form', 'work_date', 'body_text', 'not_race_result',
    'source_sha256', 'scraped_at',
]
RIDE_COLUMNS = [
    'role', 'meeting_date', 'venue', 'race_no', 'horse_code', 'horse_id', 'horse_name_ch', 'horse_no',
    'runner_status', 'race_status', 'person_code', 'person_name_ch', 'person_name_en', 'win_odds_text',
    'jockey_changed', 'trainer_preference', 'trump_card', 'priority', 'class_code', 'distance_m',
    'track_code', 'track_label', 'track_description_ch', 'season_wins', 'season_seconds', 'season_thirds',
    'season_starts', 'not_race_result', 'source_sha256', 'scraped_at',
]
SUMMARY_COLUMNS = [
    'meeting_date', 'venue', 'meeting_track_ch', 'race_count', 'going_sentence', 'not_race_result',
    'source_sha256', 'scraped_at',
]
GOING_COLUMNS = [
    'meeting_date', 'venue', 'track_code', 'going_code', 'track_label', 'track_description_ch', 'going_ch',
    'race_nos', 'not_race_result', 'source_sha256', 'scraped_at',
]
POOL_COLUMNS = [
    'meeting_date', 'venue', 'pool_kind', 'odds_type', 'leg_or_inst', 'race_nos', 'label_ch', 'sell_status',
    'not_race_result', 'source_sha256', 'scraped_at',
]
SUSPENSION_COLUMNS = [
    'meeting_date', 'venue', 'jockey_id', 'commenced_on', 'spsn_typ', 'jockey_code', 'jockey_name_ch',
    'resumed_on', 'detail_ch', 'not_race_result', 'source_sha256', 'scraped_at',
]
STEWARD_COLUMNS = [
    'meeting_date', 'venue', 'sequence_number', 'name_ch', 'name_en', 'role_code', 'role_ch',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'race_report_ext': ('race_report_ext.csv', REPORT_COLUMNS),
    'formline': ('formline.csv', FORMLINE_COLUMNS),
    'exceptional_factor': ('exceptional_factor.csv', EXCEPTIONAL_COLUMNS),
    'veterinary_record': ('veterinary_record.csv', VETERINARY_COLUMNS),
    'meeting_trackwork': ('meeting_trackwork.csv', TRACKWORK_FIELDS),
    'ride_assignment': ('ride_assignment.csv', RIDE_COLUMNS),
    'meeting_summary': ('meeting_summary.csv', SUMMARY_COLUMNS),
    'meeting_going': ('meeting_going.csv', GOING_COLUMNS),
    'meeting_pool': ('meeting_pool.csv', POOL_COLUMNS),
    'jockey_suspension': ('jockey_suspension.csv', SUSPENSION_COLUMNS),
    'meeting_steward': ('meeting_steward.csv', STEWARD_COLUMNS),
}
REPLACE_KEYS = {name: ('meeting_date', 'venue') for name in FILES}
REPLACE_KEYS['ride_assignment'] = ('meeting_date', 'venue')
INTEGER_COLUMNS = {
    'race_no', 'horse_no', 'previous_race_no', 'prior_race_no', 'prior_distance_m', 'line_no', 'weight_lb',
    'prior_weight_lb', 'rating', 'prior_rating', 'draw', 'prior_draw', 'weight_loss', 'age_allowance',
    'days_since', 'not_race_result', 'jockey_changed', 'trump_card', 'priority', 'distance_m', 'season_wins',
    'season_seconds', 'season_thirds', 'season_starts', 'race_count', 'leg_or_inst', 'sequence_number',
}


class IdentityError(ValueError):
    """Page identity does not match the requested or displayed meeting."""


class ParseMiss(ValueError):
    """Visible official content was not stored."""


class BoardPending(Exception):
    """The meeting board is not published yet."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_queries() -> dict[str, str]:
    text = QUERY_FILE.read_text(encoding='utf-8')
    parts = re.split(r'(?m)^# operation (\w+)\s*$', text)
    if len(parts) < 3 or len(parts) % 2 == 0:
        raise IdentityError('companion query file is not the page operation list')
    found = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
    if set(found) != set(OPERATIONS):
        raise IdentityError('companion query file operations changed')
    for name, query in found.items():
        if not query.startswith('query ' + name):
            raise IdentityError(f'{name} is not the page query')
    jockey = found['rw_JockeysRides']
    trainer = found['rw_TrainersEntries']
    if 'oddsTypes: [WIN]' not in jockey or 'PLA' in jockey:
        raise IdentityError('jockey rides query is not the page WIN pool')
    if 'oddsTypes: [WIN]' not in trainer or 'PLA' in trainer:
        raise IdentityError('trainer entries query is not the page WIN pool')
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


def scraped_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slash_date(value: date) -> str:
    return value.strftime('%Y/%m/%d')


def dmy_to_iso(text: str, label: str) -> str:
    match = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', (text or '').strip())
    if not match:
        raise ParseMiss(f'{label} date {text!r} is not DD/MM/YYYY')
    try:
        return date(int(match.group(3)), int(match.group(2)), int(match.group(1))).isoformat()
    except ValueError as exc:
        raise ParseMiss(f'{label} date {text!r} is not a calendar day') from exc


def civil_date(value: str, label: str) -> str:
    """HKJC suspension timestamps are a civil date plus +08:00, not a meeting stamp."""
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2})\+08:00', (value or '').strip())
    if not match:
        raise ParseMiss(f'{label} timestamp {value!r} is not a Hong Kong civil date')
    return parse_iso(match.group(1)).isoformat()


def blank(value: str | None) -> str | None:
    text = re.sub(r'\s+', ' ', (value or '').replace('\xa0', ' ')).strip()
    if text in BLANK_TOKENS:
        return None
    return text


def optional_int(value: str | None, label: str) -> int | None:
    text = blank(value)
    if text is None:
        return None
    if not SIGNED.fullmatch(text):
        raise ParseMiss(f'{label} {value!r} is not an official count')
    return int(text)


def whole(value, label: str) -> int:
    if isinstance(value, bool) or value is None:
        raise ParseMiss(f'{label} is not an official count')
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and re.fullmatch(r'-?\d+', value.strip()):
        number = int(value.strip())
    else:
        raise ParseMiss(f'{label} is not an official count')
    if number < 0:
        raise ParseMiss(f'{label} is negative')
    return number


def text_of(node) -> str:
    return node.get_text(' ', strip=True) if node else ''


def cells(row) -> list[str]:
    return [text_of(cell) for cell in row.find_all(['td', 'th'])]


def norm(text: str) -> str:
    return re.sub(r'\s+', '', text or '')


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
    raw = fetch_bytes(
        GRAPHQL, 'POST', json.dumps({'query': query, 'variables': variables}).encode(),
        {'content-type': 'application/json', 'accept': 'application/json'},
    )
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IdentityError('companion response is not JSON') from exc
    if body.get('errors') or not isinstance(body.get('data'), dict):
        raise IdentityError('companion query rejected or incomplete')
    return body, sha256(raw)


def page_url(path: str, meeting: date | None, venue: str, race_no: int) -> str:
    base = f'{SITE}/zh-hk/local/information/{path}'
    if meeting is None:
        return base
    return base + '?' + urlencode({
        'racedate': slash_date(meeting),
        'Racecourse': venue,
        'RaceNo': str(race_no),
    })


def soup_of(raw: bytes) -> BeautifulSoup:
    return BeautifulSoup(raw.decode('utf-8', errors='replace'), 'html.parser')


def pending_page(soup: BeautifulSoup) -> bool:
    text = soup.get_text(' ', strip=True)
    return any(phrase in text for phrase in ('資料將於稍後提供', '暫無資料', '暫時未有'))


def race_numbers(soup: BeautifulSoup) -> list[int]:
    found = []
    for image in soup.find_all('img'):
        match = re.search(r'racecard_rt_(\d+)', image.get('src') or '')
        if match:
            found.append(int(match.group(1)))
    numbers = sorted(set(found))
    if not numbers:
        raise ParseMiss('race tabs are missing')
    if numbers != list(range(1, numbers[-1] + 1)):
        raise ParseMiss(f'race tabs are not contiguous: {numbers}')
    return numbers


def header_node(soup: BeautifulSoup):
    """The race header is div.f_fs13. The trackwork board omits margin_top10; other boards include it."""
    nodes = []
    for node in soup.select('div.f_fs13'):
        if re.search(r'第\s*\d+\s*場', text_of(node)):
            nodes.append(node)
    leaves = [node for node in nodes if not any(other in node.descendants for other in nodes if other is not node)]
    if len(leaves) != 1:
        raise ParseMiss('race header is missing or repeated')
    return leaves[0]


def parse_header(soup: BeautifulSoup, requested_date: str, requested_venue: str, requested_race: int,
                 today: date) -> dict:
    node = header_node(soup)
    text = text_of(node)
    race_match = re.search(r'第\s*(\d+)\s*場\s*-\s*(\S.*?)\s*(?=\d{4}年|$)', text)
    date_match = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日[^,]*,[^,]*,\s*(沙田|跑馬地),\s*(\d{1,2}:\d{2})', text)
    if not race_match or not date_match:
        if pending_page(soup):
            raise BoardPending('companion board is not published')
        raise ParseMiss('race header date or race number is missing')
    try:
        meeting = date(int(date_match.group(1)), int(date_match.group(2)), int(date_match.group(3)))
    except ValueError as exc:
        raise IdentityError('race header date is not a calendar day') from exc
    venue = VENUE_NAME[date_match.group(4)]
    race_no = int(race_match.group(1))
    buttons = [text_of(node) for node in soup.select('div.date_title a.blueBtn1')]
    buttons = [item for item in buttons if item]
    if len(set(buttons)) != 1:
        raise IdentityError('meeting button is missing or disagrees with itself')
    button = re.fullmatch(r'(\d{1,2})月(\d{1,2})日\s*-\s*(沙田|跑馬地)', buttons[0])
    if not button:
        raise IdentityError(f'meeting button {buttons[0]!r} is not a local race day')
    if int(button.group(1)) != meeting.month or int(button.group(2)) != meeting.day:
        raise IdentityError('meeting button day does not match the race header')
    if VENUE_NAME[button.group(3)] != venue:
        raise IdentityError('meeting button venue does not match the race header')
    if requested_date and iso(meeting) != requested_date:
        raise IdentityError(f'page date {iso(meeting)} is not the requested {requested_date}')
    if requested_venue and venue != requested_venue:
        raise IdentityError(f'page venue {venue} is not the requested {requested_venue}')
    if requested_race and race_no != requested_race:
        raise IdentityError(f'page race {race_no} is not the requested {requested_race}')
    if meeting > today + timedelta(days=21):
        raise IdentityError(f'page date {iso(meeting)} is too far ahead of the Hong Kong clock')
    tabs = race_numbers(soup)
    if race_no not in tabs:
        raise IdentityError('header race is not on the race tabs')
    track, course, distance, going = parse_track_line(text)
    shows_surface = '全天候' in text or '草地' in text or '泥地' in text or '沙地' in text
    if shows_surface and '米' in text and (distance is None or track is None):
        raise ParseMiss('header shows a surface and metres but distance or track is empty')
    if distance is None or track is None:
        raise ParseMiss('race header has no distance or track')
    return {
        'meeting_date': iso(meeting),
        'venue': venue,
        'race_no': race_no,
        'race_name': race_match.group(2).strip(),
        'post_time': date_match.group(5),
        'track': track,
        'course': course,
        'distance_m': distance,
        'going': going,
        'race_numbers': tabs,
    }


def parse_track_line(text: str) -> tuple[str | None, str | None, int | None, str | None]:
    turf = re.search(
        rf'(草地|泥地|沙地)[^0-9"]{{0,24}}"([^"]+)"\s*賽道[^0-9]{{0,12}}(\d{{3,4}})\s*米[^0-9]{{0,12}}({GOING})',
        text,
    )
    if turf:
        return turf.group(1), turf.group(2), int(turf.group(3)), turf.group(4)
    awt = re.search(rf'(全天候)跑道?[^0-9]{{0,12}}(\d{{3,4}})\s*米[^0-9]{{0,12}}({GOING})', text)
    if awt:
        distance = int(awt.group(2))
        if not 800 <= distance <= 4000:
            raise ParseMiss(f'distance {distance} is outside the local range')
        return '全天候', None, distance, awt.group(3)
    return None, None, None, None


def require_header(cells_text: list[str], expected: list[str], label: str) -> None:
    if [norm(item) for item in cells_text] != [norm(item) for item in expected]:
        raise ParseMiss(f'{label} header {cells_text} is not the official columns')


def horse_anchor(cell) -> tuple[str, str | None]:
    link = cell.find('a', href=True)
    name = text_of(link) if link else text_of(cell)
    if not name:
        raise ParseMiss('horse name is empty')
    horse_id = None
    if link:
        match = re.search(r'horseid=(HK_\d{4}_[A-Z]\d{3})', link['href'])
        if not match:
            raise ParseMiss(f'horse link {link["href"]} has no local horse id')
        horse_id = match.group(1)
        if not HORSE_ID.fullmatch(horse_id):
            raise IdentityError(f'horse id {horse_id} is not a local horse')
    return name, horse_id


def query_params(href: str) -> dict[str, str]:
    parsed = parse_qs(urlparse(href).query)
    return {key: values[0] for key, values in parsed.items() if values}


def stamp(row: dict, digest: str, scraped_at: str) -> dict:
    row['not_race_result'] = 1
    row['source_sha256'] = digest
    row['scraped_at'] = scraped_at
    return row


def parse_report(raw: bytes, requested_date: str, requested_venue: str, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = soup_of(raw)
    header = parse_header(soup, requested_date, requested_venue, 0, today)
    table = soup.find(id='PastRacingIncidentExt')
    if table is None:
        if pending_page(soup):
            raise BoardPending('race report extract is not published')
        raise ParseMiss('race report extract table is missing')
    rows = table.find_all('tr')
    require_header(cells(rows[0]), ['馬號', '烙號', '馬名', '日期', '場次', '描述'], 'race report')
    parsed = []
    section = 'declared'
    seen = set()
    for row in rows[1:]:
        values = row.find_all('td', recursive=False)
        if len(values) == 1 and norm(text_of(values[0])) == '後備馬匹':
            if section == 'standby':
                raise ParseMiss('race report repeats the standby banner')
            section = 'standby'
            continue
        if len(values) != 6:
            raise ParseMiss('race report row does not have the six official cells')
        horse_no = whole(text_of(values[0]), 'horse number')
        brand = text_of(values[1])
        if not BRAND.fullmatch(brand):
            raise ParseMiss(f'brand {brand!r} is not a local brand')
        horse_name, horse_id = horse_anchor(values[2])
        if horse_id is None or not horse_id.endswith('_' + brand):
            raise IdentityError(f'{brand} link does not match the brand cell')
        previous = blank(text_of(values[3]))
        previous_date = dmy_to_iso(previous, 'previous run') if previous else None
        label_cell = values[4]
        label = blank(text_of(label_cell))
        previous_race_no = None
        previous_venue = None
        link = label_cell.find('a', href=True)
        if link:
            params = query_params(link['href'])
            link_date = (params.get('racedate') or params.get('RaceDate') or '').replace('/', '-')
            if previous_date and link_date != previous_date:
                raise IdentityError(f'previous race link date {link_date} is not the cell date {previous}')
            race_key = next((key for key in params if key.lower() == 'raceno'), '')
            venue_key = next((key for key in params if key.lower() == 'racecourse'), '')
            if not race_key or not venue_key:
                raise ParseMiss('previous race link has no race or course')
            previous_race_no = whole(params[race_key], 'previous race number')
            previous_venue = params[venue_key]
            if not re.fullmatch(r'[A-Z][A-Z0-9]', previous_venue):
                raise ParseMiss(f'previous venue {previous_venue!r} is not a course code')
            label = blank(text_of(link))
        description = text_of(values[5]).strip()
        if not description:
            raise ParseMiss(f'horse {horse_no} report text is empty')
        if (section, horse_no) in seen:
            raise ParseMiss(f'race report repeats horse {horse_no} in {section}')
        seen.add((section, horse_no))
        parsed.append(stamp({
            'meeting_date': header['meeting_date'],
            'venue': header['venue'],
            'race_no': header['race_no'],
            'runner_section': section,
            'horse_no': horse_no,
            'horse_code': brand,
            'horse_id': horse_id,
            'horse_name': horse_name,
            'previous_run_date': previous_date,
            'previous_race_label': label,
            'previous_race_no': previous_race_no,
            'previous_venue': previous_venue,
            'description': description,
        }, digest, scraped_at))
    if not parsed:
        raise ParseMiss('race report extract has a header and no horses')
    return parsed


def pair_numbers(text: str, label: str) -> tuple[str, int, int]:
    match = re.fullmatch(r'(\d+)\((\d+)\)', text or '')
    if not match:
        raise ParseMiss(f'{label} {text!r} is not current(previous)')
    return text, int(match.group(1)), int(match.group(2))


def parse_formline(raw: bytes, requested_date: str, requested_venue: str, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = soup_of(raw)
    header = parse_header(soup, requested_date, requested_venue, 0, today)
    table = soup.find(id='formlinelist')
    if table is None:
        if pending_page(soup):
            raise BoardPending('form line is not published')
        raise ParseMiss('form line table is missing')
    parsed = []
    block = None
    line_no = 0
    for row in table.find_all('tr'):
        classes = row.get('class') or []
        values = row.find_all('td')
        texts = [text_of(cell) for cell in values]
        if 'bg_blue' in classes:
            if len(values) != 6:
                raise ParseMiss('form line meeting row is not the six official cells')
            link = values[0].find('a', href=True)
            if link is None:
                raise ParseMiss('form line meeting has no previous-race link')
            label_text = text_of(link)
            match = re.fullmatch(r'(\d{2}/\d{2}/\d{4})\s*\(([^)]+)\)', label_text)
            if not match:
                raise ParseMiss(f'form line meeting {label_text!r} has no date and race label')
            params = query_params(link['href'])
            prior_date = dmy_to_iso(match.group(1), 'form line')
            link_date = (params.get('racedate') or params.get('RaceDate') or '').replace('/', '-')
            if link_date != prior_date:
                raise IdentityError(f'form line link date {link_date} is not {prior_date}')
            race_key = next((key for key in params if key.lower() == 'raceno'), '')
            venue_key = next((key for key in params if key.lower() == 'racecourse'), '')
            if not race_key or not venue_key:
                raise ParseMiss('form line link is missing race or course')
            venue_word = texts[1]
            if venue_word not in VENUE_NAME:
                raise ParseMiss(f'form line venue {venue_word!r} is not local or Conghua')
            if VENUE_NAME[venue_word] != params[venue_key]:
                raise IdentityError('form line venue word does not match the link')
            distance_match = re.fullmatch(r'(\d{3,4})米', texts[2])
            if not distance_match:
                raise ParseMiss(f'form line distance {texts[2]!r} is not metres')
            block = {
                'prior_date': prior_date,
                'prior_race_label': match.group(2).strip(),
                'prior_race_no': whole(params[race_key], 'prior race'),
                'prior_venue': params[venue_key],
                'prior_distance_m': int(distance_match.group(1)),
                'prior_class': texts[3],
                'prior_rail': blank(texts[4]),
                'prior_going': blank(texts[5]),
            }
            if not block['prior_class'] or not block['prior_going']:
                raise ParseMiss('form line class or going is empty')
            line_no = 0
            continue
        if texts and texts[0] == '馬名':
            require_header(texts, ['馬名', '負磅', '評分', '檔位', '騎師', '上賽騎師', '名次', '完成時間', '距離', '賠率', '相對負磅差異', '相對評分差異'], 'form line')
            continue
        if block is None:
            raise ParseMiss('form line horse appears before its previous meeting')
        if len(texts) != 12:
            raise ParseMiss('form line horse row does not have twelve cells')
        line_no += 1
        weight_text, weight_lb, prior_weight = pair_numbers(texts[1], 'weight')
        rating_text, rating, prior_rating = pair_numbers(texts[2], 'rating')
        draw_text, draw, prior_draw = pair_numbers(texts[3], 'draw')
        placing = texts[6]
        if not re.fullmatch(r'\d+/\d+', placing):
            raise ParseMiss(f'placing {placing!r} is not a previous finish')
        finish = texts[7]
        if not re.fullmatch(r'\d+\.\d{2}\.\d{2}', finish):
            raise ParseMiss(f'finish time {finish!r} is not an official time')
        margin = blank(texts[8])
        if margin and (len(margin) > 20 or re.search(r'\s', margin)):
            raise ParseMiss(f'margin {margin!r} is not a short official token')
        odds = blank(texts[9])
        if odds and not re.fullmatch(r'\d+(?:\.\d+)?', odds):
            raise ParseMiss(f'odds {texts[9]!r} is not an official price')
        weight_diff = blank(texts[10])
        rating_diff = blank(texts[11])
        for label, value in (('weight difference', weight_diff), ('rating difference', rating_diff)):
            if value and not SIGNED.fullmatch(value):
                raise ParseMiss(f'{label} {value!r} is not a signed official number')
        parsed.append(stamp({
            'meeting_date': header['meeting_date'],
            'venue': header['venue'],
            'race_no': header['race_no'],
            **block,
            'line_no': line_no,
            'horse_name': texts[0],
            'weight_text': weight_text,
            'weight_lb': weight_lb,
            'prior_weight_lb': prior_weight,
            'rating_text': rating_text,
            'rating': rating,
            'prior_rating': prior_rating,
            'draw_text': draw_text,
            'draw': draw,
            'prior_draw': prior_draw,
            'jockey_name': texts[4],
            'prior_jockey_name': texts[5],
            'placing': placing,
            'finish_time': finish,
            'margin': margin,
            'odds_text': odds,
            'weight_diff': weight_diff,
            'rating_diff': rating_diff,
        }, digest, scraped_at))
    return parsed


def signed_text(value: str, label: str) -> str | None:
    text = blank(value)
    if text is None:
        return None
    if not SIGNED.fullmatch(text):
        raise ParseMiss(f'{label} {value!r} is not a signed official number')
    return text


def parse_exceptional(raw: bytes, requested_date: str, requested_venue: str, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = soup_of(raw)
    header = parse_header(soup, requested_date, requested_venue, 0, today)
    table = soup.find(id='ExceptionList')
    if table is None:
        if pending_page(soup):
            raise BoardPending('exceptional factors are not published')
        raise ParseMiss('exceptional factor table is missing')
    rows = table.find_all('tr')
    require_header(cells(rows[0]), [
        '馬號', '馬名', '蝕磅', '分齡讓磅', '配備', '綁繫舌帶', '上賽口銜鐵', '今賽口銜鐵', '評分', '途程',
        '上賽距今日數', '轉投練馬師', '從化回港日期',
    ], 'exceptional factors')
    parsed = []
    for row in rows[1:]:
        values = [text_of(cell) for cell in row.find_all('td')]
        if len(values) != 13:
            raise ParseMiss('exceptional factor row does not have the thirteen official cells')
        horse_no = whole(values[0], 'horse number')
        if not values[1]:
            raise ParseMiss('exceptional factor horse name is empty')
        trainer = blank(values[11])
        if trainer not in (None, 'YES'):
            raise ParseMiss(f'trainer change {values[11]!r} is not YES or blank')
        returned = blank(values[12])
        parsed.append(stamp({
            'meeting_date': header['meeting_date'],
            'venue': header['venue'],
            'race_no': header['race_no'],
            'horse_no': horse_no,
            'horse_name': values[1],
            'weight_loss': optional_int(values[2], 'weight loss'),
            'age_allowance': optional_int(values[3], 'age allowance'),
            'gear': blank(values[4]),
            'tongue_tie': blank(values[5]),
            'previous_bit': blank(values[6]),
            'current_bit': blank(values[7]),
            'rating_change': signed_text(values[8], 'rating change'),
            'distance_change': signed_text(values[9], 'distance change'),
            'days_since': optional_int(values[10], 'days since last run'),
            'trainer_change': trainer,
            'conghua_return_date': dmy_to_iso(returned, 'Conghua return') if returned else None,
        }, digest, scraped_at))
    if not parsed:
        raise ParseMiss('exceptional factor table has a header and no horses')
    return parsed


def parse_veterinary(raw: bytes, requested_date: str, requested_venue: str, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = soup_of(raw)
    header = parse_header(soup, requested_date, requested_venue, 0, today)
    tables = []
    for table in soup.find_all('table'):
        body = table.find_all('tr')
        if body and [norm(item) for item in cells(body[0])] == [norm(item) for item in ['馬號', '馬名', '日期', '詳情', '通過日期']]:
            tables.append(table)
    if len(tables) != 1:
        if pending_page(soup):
            raise BoardPending('veterinary list is not published')
        raise ParseMiss('veterinary list table is missing or repeated')
    current = None
    parsed = []
    line_no = 0
    for row in tables[0].find_all('tr')[1:]:
        values = row.find_all('td')
        if len(values) != 5:
            raise ParseMiss('veterinary row does not have the five official cells')
        number = blank(text_of(values[0]))
        name = blank(text_of(values[1]))
        if number or name:
            if not number or not name:
                raise ParseMiss('veterinary horse number and name must arrive together')
            horse_name, horse_id = horse_anchor(values[1])
            current = {'horse_no': whole(number, 'horse number'), 'horse_name': horse_name, 'horse_id': horse_id}
        elif current is None:
            raise ParseMiss('veterinary detail has no horse')
        injury = dmy_to_iso(text_of(values[2]), 'injury')
        detail = text_of(values[3]).strip()
        if not detail:
            raise ParseMiss('veterinary detail is empty')
        passed = blank(text_of(values[4]))
        line_no += 1
        parsed.append(stamp({
            'meeting_date': header['meeting_date'],
            'venue': header['venue'],
            'race_no': header['race_no'],
            'horse_no': current['horse_no'],
            'line_no': line_no,
            'horse_id': current['horse_id'],
            'horse_name': current['horse_name'],
            'injury_date': injury,
            'detail': detail,
            'passed_date': dmy_to_iso(passed, 'passed') if passed else None,
        }, digest, scraped_at))
    if not parsed:
        raise ParseMiss('veterinary list has a header and no records')
    return parsed


def resolve_work_date(day: int, month: int, meeting: date) -> str:
    try:
        same = date(meeting.year, month, day)
    except ValueError as exc:
        raise ParseMiss(f'trackwork date {day:02d}/{month:02d} is not a calendar day') from exc
    if same <= meeting:
        chosen = same
    else:
        try:
            previous = date(meeting.year - 1, month, day)
        except ValueError as exc:
            raise ParseMiss(f'trackwork date {day:02d}/{month:02d} is not a calendar day') from exc
        if (same - meeting).days <= 45 or (meeting - previous).days > 500:
            raise ParseMiss(f'trackwork date {day:02d}/{month:02d} is after meeting {iso(meeting)}')
        chosen = previous
    return iso(chosen)


def trackwork_lines(cell, meeting: date) -> list[tuple[str, str]]:
    """Dated lines. Trial dates sit inside the barrier-trial link, with the group name in the same bold tag."""
    lines = []
    current = None

    def add_text(text: str) -> None:
        nonlocal current
        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            return
        if current is None:
            raise ParseMiss(f'trackwork text {text!r} has no date')
        current['parts'].append(text)

    def walk(node) -> None:
        nonlocal current
        for child in getattr(node, 'children', []):
            name = getattr(child, 'name', None)
            if name == 'b':
                label = text_of(child).strip()
                match = re.fullmatch(r'(\d{2})\s*/\s*(\d{2})\s*:\s*(.*)', label)
                if not match:
                    raise ParseMiss(f'trackwork label {label!r} is not a date')
                if current:
                    lines.append(current)
                current = {
                    'date': resolve_work_date(int(match.group(1)), int(match.group(2)), meeting),
                    'parts': [],
                }
                if match.group(3).strip():
                    current['parts'].append(match.group(3).strip())
            elif name in ('br', 'script', 'style'):
                continue
            elif name:
                walk(child)
            else:
                add_text(str(child))

    walk(cell)
    if current:
        lines.append(current)
    if not lines and text_of(cell):
        raise ParseMiss('trackwork cell has text but no dated line')
    return [(item['date'], re.sub(r'\s+', ' ', ' '.join(item['parts'])).strip()) for item in lines]


def parse_trackwork(raw: bytes, requested_date: str, requested_venue: str, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = soup_of(raw)
    header = parse_header(soup, requested_date, requested_venue, 0, today)
    meeting = parse_iso(header['meeting_date'])
    expected = ['編號', '馬名/練馬師/6次近績', '試閘', '快操', '踱步', '游泳', '馬匹跑步機', '馬匹水中步行機', '休歇', '所有晨操紀錄']
    expected_norm = [norm(item) for item in expected]
    sections = []
    for table in soup.find_all('table'):
        body = table.find_all('tr')
        if not body:
            continue
        first = [norm(item) for item in cells(body[0])]
        if first == expected_norm:
            sections.append(('declared', body[1:]))
        elif first == ['後備馬匹']:
            if len(body) < 2 or [norm(item) for item in cells(body[1])] != expected_norm:
                raise ParseMiss('standby trackwork header changed')
            sections.append(('standby', body[2:]))
    declared_count = sum(name == 'declared' for name, _rows in sections)
    standby_count = sum(name == 'standby' for name, _rows in sections)
    if declared_count != 1 or standby_count > 1:
        if pending_page(soup) and declared_count == 0:
            raise BoardPending('meeting trackwork is not published')
        raise ParseMiss('meeting trackwork table is missing or repeated')
    parsed = []
    seen = set()
    for section, section_rows in sections:
        for row in section_rows:
            values = row.find_all('td', recursive=False)
            if len(values) != 10:
                raise ParseMiss('trackwork row does not have ten cells')
            horse_no = whole(text_of(values[0]), 'horse number')
            horse_name, horse_id = horse_anchor(values[1])
            if horse_id is None:
                raise ParseMiss(f'horse {horse_no} has no horse link')
            trainer_link = values[1].find('a', href=re.compile(r'trainerid='))
            if trainer_link is None:
                raise ParseMiss(f'horse {horse_no} has no trainer link')
            trainer_match = re.search(r'trainerid=([A-Z][A-Z0-9]{1,5})', trainer_link['href'])
            if not trainer_match:
                raise ParseMiss('trainer link has no trainer code')
            form = values[1].find('span')
            if form is None:
                raise ParseMiss(f'horse {horse_no} recent-form cell is missing')
            recent = text_of(form) or None
            if norm(text_of(values[9])) != '詳情':
                raise ParseMiss('trackwork detail column is not the per-horse link')
            if (section, horse_no) in seen:
                raise ParseMiss(f'trackwork repeats horse {horse_no} in {section}')
            seen.add((section, horse_no))
            horse = {
                'meeting_date': header['meeting_date'],
                'venue': header['venue'],
                'race_no': header['race_no'],
                'runner_section': section,
                'horse_no': horse_no,
                'horse_id': horse_id,
                'horse_name': horse_name,
                'trainer_code': trainer_match.group(1),
                'trainer_name': text_of(trainer_link),
                'recent_form': recent,
            }
            produced = 0
            for index, css, category in TRACKWORK_COLUMNS:
                classes = values[index].get('class') or []
                if css not in classes:
                    raise ParseMiss(f'{category} cell class is {classes}')
                for line_no, (work_date, body) in enumerate(trackwork_lines(values[index], meeting), start=1):
                    produced += 1
                    parsed.append(stamp({**horse, 'category': category, 'line_no': line_no, 'work_date': work_date, 'body_text': body or None}, digest, scraped_at))
            if produced == 0:
                parsed.append(stamp({**horse, 'category': 'declared', 'line_no': 0, 'work_date': None, 'body_text': None}, digest, scraped_at))
    if not parsed:
        raise ParseMiss('meeting trackwork has a header and no horses')
    return parsed


def season_all(stat: dict | None) -> dict[str, int | None]:
    """The rides page prints the ven=ALL season total. ALL/ALL is that total; other slices are not added."""
    empty = {'season_wins': None, 'season_seconds': None, 'season_thirds': None, 'season_starts': None}
    if not stat:
        return empty
    slices = stat.get('ssnStat') or []
    exact = [item for item in slices if item.get('ven') == 'ALL' and item.get('trk') == 'ALL']
    if len(exact) != 1:
        visible = [item for item in slices if item.get('ven') == 'ALL']
        if visible or len(exact) > 1:
            raise IdentityError(f"{stat.get('code')} ALL season total is not a single ALL/ALL slice")
        return empty
    row = exact[0]
    return {
        'season_wins': whole(row.get('numFirst'), 'wins'),
        'season_seconds': whole(row.get('numSecond'), 'seconds'),
        'season_thirds': whole(row.get('numThird'), 'thirds'),
        'season_starts': whole(row.get('numStarts'), 'starts'),
    }


def odds_index(pools: list[dict]) -> dict[int, dict[int, str | None]]:
    indexed: dict[int, dict[int, str | None]] = {}
    for pool in pools or []:
        leg = pool.get('leg') or {}
        races = leg.get('races') or []
        if len(races) != 1:
            raise ParseMiss('WIN pool leg is not a single race')
        race_no = whole(races[0], 'WIN pool race')
        if race_no in indexed:
            raise ParseMiss(f'race {race_no} has more than one WIN pool')
        prices: dict[int, str | None] = {}
        for node in pool.get('oddsNodes') or []:
            comb = str(node.get('combString') or '')
            if not re.fullmatch(r'\d+', comb):
                raise ParseMiss(f'WIN comb {comb!r} is not a horse number')
            horse_no = int(comb)
            if horse_no in prices:
                raise ParseMiss(f'race {race_no} repeats horse {horse_no} odds')
            raw_price = '' if node.get('oddsValue') is None else str(node.get('oddsValue')).strip()
            if raw_price in BLANK_TOKENS or raw_price == '---':
                prices[horse_no] = None
            elif re.fullmatch(r'\d+(?:\.\d+)?', raw_price):
                prices[horse_no] = raw_price
            else:
                raise ParseMiss(f'WIN odds {raw_price!r} is not an official price')
        indexed[race_no] = prices
    return indexed


def displayed_name(value, label: str) -> str:
    text = re.sub(r'\s+', ' ', str(value or '')).strip()
    if text in BLANK_TOKENS or re.fullmatch(r'-+', text or ''):
        if text:
            return '---'
        raise ParseMiss(f'{label} is empty')
    return text


def changed_horses(histories: list[dict]) -> set[tuple[int, int, str]]:
    found = set()
    for item in histories or []:
        if str(item.get('type')) != '99' or str(item.get('dueToPromotion')) != '0':
            continue
        race_no = whole(item.get('raceNo'), 'change race')
        runner_no = whole(item.get('runnerNo'), 'change runner')
        brand = str(item.get('horseCode') or '')
        if not BRAND.fullmatch(brand):
            raise ParseMiss(f'jockey change brand {brand!r} is not local')
        found.add((race_no, runner_no, brand))
    return found


def track_label(track: dict) -> tuple[str, str, str]:
    code = str((track or {}).get('code') or '')
    description = str((track or {}).get('description_ch') or '')
    if code == 'AWT':
        if '全天候' not in description:
            raise ParseMiss(f'AWT description {description!r} is not 全天候')
        return code, '全天候', description
    if not code or not description:
        raise ParseMiss('race track label is empty')
    return code, description, description


def local_meeting(payload: dict, key: str, requested_date: str, requested_venue: str) -> dict:
    meetings = payload.get('data', {}).get('commonMeetings')
    if not isinstance(meetings, list):
        raise IdentityError('meetings response is missing')
    local = [item for item in meetings if item.get('venueCode') in LOCAL_VENUES]
    if requested_date:
        local = [item for item in local if item.get('date') == requested_date]
    if requested_venue:
        local = [item for item in local if item.get('venueCode') == requested_venue]
    if len(local) != 1:
        raise IdentityError(f'{key} local meeting count is {len(local)}')
    meeting = local[0]
    if not ISO_DATE.fullmatch(str(meeting.get('date') or '')):
        raise IdentityError('meeting date is not ISO')
    if meeting.get('venueCode') not in LOCAL_VENUES:
        raise IdentityError('meeting venue is not Sha Tin or Happy Valley')
    races = meeting.get('races') or []
    numbers = [whole(race.get('no'), 'race number') for race in races]
    if numbers != list(range(1, len(numbers) + 1)):
        raise ParseMiss(f'race numbers {numbers} are not contiguous')
    expected = meeting.get('totalNumberOfRace')
    if expected is not None and whole(expected, 'race count') != len(races):
        raise IdentityError('totalNumberOfRace does not match the race list')
    return meeting


def parse_rides(payload: dict, role: str, requested_date: str, requested_venue: str, digest: str, scraped_at: str) -> list[dict]:
    if role not in ('jockey', 'trainer'):
        raise IdentityError('ride role is not jockey or trainer')
    stat_key = 'jockeyStat' if role == 'jockey' else 'trainerStat'
    person_key = 'jockey' if role == 'jockey' else 'trainer'
    meeting = local_meeting(payload, role, requested_date, requested_venue)
    stats = {item.get('code'): item for item in payload.get('data', {}).get(stat_key) or []}
    odds = odds_index(meeting.get('pmPools') or [])
    changes = changed_horses(meeting.get('changeHistories') or []) if role == 'jockey' else set()
    rows = []
    for race in meeting['races']:
        race_no = whole(race.get('no'), 'race number')
        code, label, description = track_label(race.get('raceTrack') or {})
        distance = whole(race.get('distance'), 'distance')
        if not 800 <= distance <= 4000:
            raise ParseMiss(f'distance {distance} is outside the local range')
        class_code = str(race.get('claCode') or '')
        if not re.fullmatch(r'[A-Za-z0-9]{1,4}', class_code):
            raise ParseMiss(f'class code {class_code!r} is not the page class')
        race_status = str(race.get('status') or '')
        if not race_status:
            raise ParseMiss('race status is empty')
        seen = set()
        runners = race.get('runners') or []
        if not runners:
            raise ParseMiss(f'race {race_no} has no runners')
        prices = odds.get(race_no)
        for runner in runners:
            horse = runner.get('horse') or {}
            person = runner.get(person_key) or {}
            brand = str(horse.get('code') or '')
            horse_id = str(horse.get('id') or '')
            if not BRAND.fullmatch(brand) or not horse_id.endswith('_' + brand) or not HORSE_ID.fullmatch(horse_id):
                raise IdentityError(f'runner brand {brand} does not match {horse_id}')
            runner_id = str(runner.get('id') or '')
            expected_id = f"{meeting['date'].replace('-', '')}{meeting['venueCode']}{race_no:02d}{brand}"
            if runner_id != expected_id:
                raise IdentityError(f'runner id {runner_id} is not {expected_id}')
            status = str(runner.get('status') or '')
            if not status:
                raise ParseMiss(f'{brand} runner status is empty')
            raw_no = '' if runner.get('no') is None else str(runner.get('no')).strip()
            if raw_no == '':
                if status != 'Standby':
                    raise ParseMiss(f'{brand} has no saddle cloth number')
                horse_no = None
            else:
                horse_no = whole(raw_no, 'horse number')
            if (race_no, brand) in seen:
                raise ParseMiss(f'race {race_no} repeats {brand}')
            seen.add((race_no, brand))
            person_code = str(person.get('code') or '')
            if not PERSON.fullmatch(person_code):
                raise ParseMiss(f'person code {person_code!r} is not an official code')
            person_name_ch = displayed_name(person.get('name_ch'), f'{person_code} Chinese name')
            person_name_en = displayed_name(person.get('name_en'), f'{person_code} English name')
            if status == 'Standby' or horse_no is None or not prices:
                price = None
            elif horse_no not in prices:
                raise ParseMiss(f'race {race_no} horse {horse_no} has no WIN cell')
            else:
                price = prices[horse_no]
            flag = 1 if horse_no is not None and (race_no, horse_no, brand) in changes else 0
            preference = runner.get('trainerPreference')
            if role == 'trainer':
                if preference is not None:
                    preference = str(preference)
                    if not re.fullmatch(r'\d+', preference):
                        raise ParseMiss(f'trainer preference {preference!r} is not official')
                trump = runner.get('trumpCard')
                priority = runner.get('priority')
                if not isinstance(trump, bool) or not isinstance(priority, bool):
                    raise ParseMiss('trainer trump card or priority is not a boolean')
                trump_card, priority_flag = int(trump), int(priority)
            else:
                preference, trump_card, priority_flag = None, None, None
            rows.append(stamp({
                'role': role,
                'meeting_date': meeting['date'],
                'venue': meeting['venueCode'],
                'race_no': race_no,
                'horse_code': brand,
                'horse_id': horse_id,
                'horse_name_ch': horse.get('name_ch'),
                'horse_no': horse_no,
                'runner_status': status,
                'race_status': race_status,
                'person_code': person_code,
                'person_name_ch': person_name_ch,
                'person_name_en': person_name_en,
                'win_odds_text': price,
                'jockey_changed': flag if role == 'jockey' else 0,
                'trainer_preference': preference,
                'trump_card': trump_card,
                'priority': priority_flag,
                'class_code': class_code,
                'distance_m': distance,
                'track_code': code,
                'track_label': label,
                'track_description_ch': description,
                **season_all(stats.get(person_code)),
            }, digest, scraped_at))
    return rows


def going_sentence(venue: str, meeting_track: str, groups: list[dict]) -> str:
    venue_name = NAME_VENUE[venue]
    if len(groups) == 1:
        group = groups[0]
        if group['track_code'] == 'AWT' and '全天候' not in meeting_track:
            raise IdentityError('meeting track does not agree with the all-weather races')
        if group['track_code'] != 'AWT' and group['track_description_ch'] not in meeting_track and '草地' not in meeting_track:
            raise IdentityError('meeting track does not agree with the turf races')
        return f"{venue_name} - {meeting_track}、{group['going_ch']}（第{group['race_nos']}場）"
    parts = [f"[{group['track_label']}]{group['going_ch']}（第{group['race_nos']}場）" for group in groups]
    return f"{venue_name} - " + '；'.join(parts)


def parse_summary(payload: dict, requested_date: str, requested_venue: str, digest: str, scraped_at: str) -> dict[str, list[dict]]:
    meeting = local_meeting(payload, 'summary', requested_date, requested_venue)
    races = []
    for race in meeting['races']:
        race_no = whole(race.get('no'), 'race number')
        code, label, description = track_label(race.get('raceTrack') or {})
        going = blank(race.get('go_ch'))
        going_code = blank(race.get('goCode'))
        if (going is None) != (going_code is None):
            raise ParseMiss(f'race {race_no} going text and code disagree')
        races.append({
            'race_no': race_no, 'track_code': code, 'track_label': label,
            'track_description_ch': description, 'going_ch': going, 'going_code': going_code,
        })
    with_going = [race for race in races if race['going_ch']]
    if with_going and len(with_going) != len(races):
        raise ParseMiss('some races have a going and some do not')
    groups = []
    if with_going:
        order = []
        for race in races:
            key = (race['track_code'], race['going_code'])
            if key not in order:
                order.append(key)
        for track_code, going_code in order:
            members = [race for race in races if race['track_code'] == track_code and race['going_code'] == going_code]
            groups.append({
                'meeting_date': meeting['date'],
                'venue': meeting['venueCode'],
                'track_code': track_code,
                'going_code': going_code,
                'track_label': members[0]['track_label'],
                'track_description_ch': members[0]['track_description_ch'],
                'going_ch': members[0]['going_ch'],
                'race_nos': ','.join(str(race['race_no']) for race in members),
            })
    meeting_track = str(meeting.get('meetingTrack_ch') or '')
    if not meeting_track:
        raise ParseMiss('summary meeting track sentence is empty')
    sentence = going_sentence(meeting['venueCode'], meeting_track, groups) if groups else f"{NAME_VENUE[meeting['venueCode']]} - {meeting_track}"
    summary = [stamp({
        'meeting_date': meeting['date'],
        'venue': meeting['venueCode'],
        'meeting_track_ch': meeting_track,
        'race_count': len(races),
        'going_sentence': sentence,
    }, digest, scraped_at)]
    going_rows = [stamp(dict(group), digest, scraped_at) for group in groups]
    pools = []
    for pool in meeting.get('pmPools') or []:
        odds_type = str(pool.get('oddsType') or '')
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]{1,8}', odds_type):
            raise ParseMiss(f'pool type {odds_type!r} is not an official code')
        leg = pool.get('leg') or {}
        leg_no = whole(leg.get('number'), 'pool leg')
        race_list = leg.get('races') or []
        if not race_list:
            raise ParseMiss(f'{odds_type} has no races')
        pools.append(stamp({
            'meeting_date': meeting['date'],
            'venue': meeting['venueCode'],
            'pool_kind': 'pm',
            'odds_type': odds_type,
            'leg_or_inst': leg_no,
            'race_nos': ','.join(str(whole(item, 'pool race')) for item in race_list),
            'label_ch': None,
            'sell_status': str(pool.get('sellStatus') or '') or None,
        }, digest, scraped_at))
    for pool in meeting.get('foPools') or []:
        odds_type = str(pool.get('oddsType') or '')
        label = str(((pool.get('oddsTypeDes') or {}).get('chinese')) or '')
        inst = str(pool.get('instNo') or '')
        if not label or '{0}' not in label or not re.fullmatch(r'\d+', inst):
            raise ParseMiss(f'fixed-odds label for {odds_type} is not the page text')
        pools.append(stamp({
            'meeting_date': meeting['date'],
            'venue': meeting['venueCode'],
            'pool_kind': 'fo',
            'odds_type': odds_type,
            'leg_or_inst': int(inst),
            'race_nos': None,
            'label_ch': label.replace('{0}', inst),
            'sell_status': None,
        }, digest, scraped_at))
    suspensions = []
    for item in meeting.get('jkSuspensions') or []:
        names = item.get('jockeyNms') or []
        if len(names) != 1:
            raise ParseMiss('suspension does not name one jockey')
        person = names[0]
        code = str(person.get('code') or '')
        if not PERSON.fullmatch(code) or not person.get('chinese'):
            raise ParseMiss('suspension jockey name is incomplete')
        detail = re.sub(r'\s+', ' ', str((item.get('desc') or {}).get('chinese') or '')).strip()
        if not detail:
            raise ParseMiss('suspension detail is empty')
        kind = str(item.get('spsnTyp') or '')
        if not re.fullmatch(r'[A-Za-z]+', kind):
            raise ParseMiss(f'suspension type {kind!r} is not an official token')
        suspensions.append(stamp({
            'meeting_date': meeting['date'],
            'venue': meeting['venueCode'],
            'jockey_id': str(item.get('jockeyId') or code),
            'commenced_on': civil_date(str(item.get('commencedOn') or ''), 'suspension start'),
            'spsn_typ': kind,
            'jockey_code': code,
            'jockey_name_ch': person.get('chinese'),
            'resumed_on': civil_date(str(item.get('resumedOn') or ''), 'suspension resume'),
            'detail_ch': detail,
        }, digest, scraped_at))
    stewards = []
    for item in meeting.get('stewards') or []:
        role = item.get('role') or {}
        sequence = whole(item.get('sequenceNumber'), 'steward sequence')
        if not item.get('name_ch') or not role.get('code'):
            raise ParseMiss('steward name or role is empty')
        stewards.append(stamp({
            'meeting_date': meeting['date'],
            'venue': meeting['venueCode'],
            'sequence_number': sequence,
            'name_ch': item.get('name_ch'),
            'name_en': item.get('name_en') or None,
            'role_code': role.get('code'),
            'role_ch': blank(role.get('chinese')),
        }, digest, scraped_at))
    return {
        'meeting_summary': summary,
        'meeting_going': going_rows,
        'meeting_pool': pools,
        'jockey_suspension': suspensions,
        'meeting_steward': stewards,
    }


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
    path = root / 'data' / 'official_raceday' / filename
    merged = merge_rows(read_csv(path, columns), rows, REPLACE_KEYS[name])
    write_csv(path, columns, merged)


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = root / 'data' / 'official_raceday' / 'manifest.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
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
    return "'" + text.replace("'", "''") + "'"


def emit_sql(root: Path) -> str:
    base = root / 'data' / 'official_raceday'
    statements = ['-- generated from data/official_raceday; companion upsert, not a race result']
    for table, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        sql_table = 'official_' + table
        meetings = sorted({(row['meeting_date'], row['venue']) for row in rows})
        for meeting_date, venue in meetings:
            statements.append(
                f"DELETE FROM {sql_table} WHERE meeting_date = {sql_literal(meeting_date)} AND venue = {sql_literal(venue)};"
            )
        for row in rows:
            values = []
            for column in columns:
                raw = row.get(column, '')
                if raw == '':
                    values.append('NULL')
                elif column in INTEGER_COLUMNS:
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


def fetch_html_surface(path: str, parser, requested_date: str, requested_venue: str, today: date, scraped_at: str) -> tuple[list[dict], str]:
    meeting = parse_iso(requested_date) if requested_date else None
    venue = requested_venue or 'ST'
    first_race = 1
    first = fetch_bytes(page_url(path, meeting, venue, first_race))
    first_header = parse_header(soup_of(first), requested_date, requested_venue, first_race if meeting else 0, today)
    rows = []
    digests = []
    for race_no in first_header['race_numbers']:
        raw = first if race_no == first_header['race_no'] else fetch_bytes(
            page_url(path, parse_iso(first_header['meeting_date']), first_header['venue'], race_no)
        )
        digest = sha256(raw)
        digests.append(digest)
        parse_header(soup_of(raw), first_header['meeting_date'], first_header['venue'], race_no, today)
        page_rows = parser(raw, first_header['meeting_date'], first_header['venue'], today, digest, scraped_at)
        for row in page_rows:
            if row['meeting_date'] != first_header['meeting_date'] or row['venue'] != first_header['venue']:
                raise IdentityError('companion page changed meeting inside one fetch')
            if row['race_no'] != race_no:
                raise IdentityError(f"page race {row['race_no']} is not requested race {race_no}")
        rows.extend(page_rows)
    return rows, digests[0]


def run(root: Path, surfaces: list[str], today: date, requested_date: str = '', requested_venue: str = '') -> dict:
    unknown = [name for name in surfaces if name not in SURFACES]
    if unknown:
        raise IdentityError(f'unknown surfaces {unknown}')
    if requested_venue and requested_venue not in LOCAL_VENUES:
        raise IdentityError('venue must be ST or HV')
    if requested_date:
        parse_iso(requested_date)
    scraped_at = scraped_now()
    queries = load_queries()
    summary = {}
    parsers = {
        'report': parse_report,
        'formline': parse_formline,
        'exceptional': parse_exceptional,
        'veterinary': parse_veterinary,
        'trackwork': parse_trackwork,
    }
    files = {
        'report': 'race_report_ext',
        'formline': 'formline',
        'exceptional': 'exceptional_factor',
        'veterinary': 'veterinary_record',
        'trackwork': 'meeting_trackwork',
    }
    for surface, parser in parsers.items():
        if surface not in surfaces:
            continue
        try:
            rows, digest = fetch_html_surface(HTML_SURFACES[surface], parser, requested_date, requested_venue, today, scraped_at)
        except BoardPending:
            if requested_date:
                raise IdentityError(f'requested {surface} meeting is not published') from None
            summary[surface] = 'pending'
            continue
        if rows:
            store_surface(root, files[surface], rows)
            append_manifest(root, surface, digest, scraped_at, len(rows))
        summary[surface] = len(rows)
    if 'rides' in surfaces:
        ride_rows = []
        digest = ''
        for role, operation in (('jockey', 'rw_JockeysRides'), ('trainer', 'rw_TrainersEntries')):
            payload, digest = graphql(queries[operation], {'dates': [requested_date] if requested_date else None})
            ride_rows.extend(parse_rides(payload, role, requested_date, requested_venue, digest, scraped_at))
        store_surface(root, 'ride_assignment', ride_rows)
        append_manifest(root, 'rides', digest, scraped_at, len(ride_rows))
        summary['rides'] = len(ride_rows)
    if 'summary' in surfaces:
        payload, digest = graphql(queries['rw_Summary'], {'dates': [requested_date] if requested_date else None})
        stored = parse_summary(payload, requested_date, requested_venue, digest, scraped_at)
        for name, rows in stored.items():
            if rows:
                store_surface(root, name, rows)
        append_manifest(root, 'summary', digest, scraped_at, len(stored['meeting_summary']))
        summary['summary'] = len(stored['meeting_pool'])
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Scrape HKJC race-day companion pages into CSV and optional SQL')
    parser.add_argument('--root', default='.')
    parser.add_argument('--surfaces', default=','.join(SURFACES))
    parser.add_argument('--date', default='', help='YYYY-MM-DD identity; blank follows the date printed on the page')
    parser.add_argument('--venue', default='', help='ST or HV when a date is set')
    parser.add_argument('--emit-sql', default='', help='Write D1 upsert SQL from CSV and exit')
    args = parser.parse_args()
    root = Path(args.root)
    try:
        if args.emit_sql:
            Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
            return
        surfaces = [part.strip() for part in args.surfaces.split(',') if part.strip()]
        print(json.dumps(run(root, surfaces, today_hkt(), args.date, args.venue), ensure_ascii=False, sort_keys=True))
    except (IdentityError, ParseMiss) as exc:
        print(f'raceday companions refused: {exc}', file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == '__main__':
    main()
