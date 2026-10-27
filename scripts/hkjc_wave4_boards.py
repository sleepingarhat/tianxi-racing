#!/usr/bin/env python3
"""Official HKJC Wave4 boards: horse rating/weight curve, distance performance, movements,
overoar list, JKC/TNC meeting results, draw advanced search.

Parsers keep the page's own numbers. Per-horse pages are fetched for the horses
on a racecard snapshot (or every active profile with --all-active); the page
title must echo the snapshot's name and brand or the read fails. The draw
advanced search echoes season / racecourse / distance / course in its title row;
a missing grid is only acceptable for a racecourse with no races in that season
(e.g. Conghua before its first meeting). Everything here is a research copy:
not race results, not frozen prediction input, not model features.
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
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

HKT = ZoneInfo('Asia/Hong_Kong')
SITE = 'https://racing.hkjc.com'
UA = (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
)
MIGRATION = Path(__file__).resolve().parents[1] / 'backend/src/db/migrations/20261027_wave4_boards.sql'
HORSE_ID = re.compile(r'^HK_\d{4}_[A-Z]\d{3}$')
BRAND = re.compile(r'^[A-Z]\d{3}$')
ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
SLASH_DATE = re.compile(r'^(\d{2})/(\d{2})/(\d{4})$')
VENUE_NAME = {'沙田': 'ST', '跑馬地': 'HV', '從化': 'CH'}
TRACK_NAME = {'草地', '全天候'}
MOVE_PLACE = {'香港', '從化', ''}
RACECOURSE_NAME = {'STT': '沙田', 'STA': '沙田', 'HVT': '跑馬地', 'CHT': '從化'}
RACECOURSE_SURF = {'STT': '草地', 'STA': '全天候', 'HVT': '草地', 'CHT': '草地'}

RATING_WEIGHT_COLUMNS = [
    'horse_id', 'horse_name', 'brand_no', 'race_date', 'rating', 'finish_text', 'body_weight',
    'venue', 'track', 'distance_m', 'course_label', 'going', 'race_class',
    'not_race_result', 'source_sha256', 'scraped_at',
]
PERFORMANCE_COLUMNS = [
    'horse_id', 'horse_name', 'brand_no', 'section', 'label_a', 'label_b', 'starts', 'wins',
    'seconds', 'thirds', 'losses', 'not_race_result', 'source_sha256', 'scraped_at',
]
MOVEMENT_COLUMNS = [
    'horse_id', 'horse_name', 'brand_no', 'from_loc', 'to_loc', 'arrive_date',
    'not_race_result', 'source_sha256', 'scraped_at',
]
OVEROAR_COLUMNS = [
    'as_of_date', 'brand_no', 'horse_name', 'diagnosis_date', 'surgery', 'source_sha256', 'scraped_at',
]
POOL_RESULT_COLUMNS = [
    'pool', 'meeting_date', 'rank_no', 'person_name', 'points', 'wins', 'seconds', 'thirds',
    'fourths', 'remark', 'not_race_result', 'source_sha256', 'scraped_at',
]
DRAW_ADV_COLUMNS = [
    'season_code', 'racecourse', 'course_label', 'distance_m', 'going', 'draw', 'starts', 'wins',
    'seconds', 'thirds', 'fourths', 'win_pct', 'quinella_pct', 'place_pct', 'top4_pct',
    'not_race_result', 'source_sha256', 'scraped_at',
]
SURFACES = ('rating-weight', 'performance', 'movement', 'overoar', 'pool-result', 'draw-adv')
FILES = {
    'rating_weight': ('rating_weight.csv', RATING_WEIGHT_COLUMNS),
    'performance': ('performance.csv', PERFORMANCE_COLUMNS),
    'movement': ('movement.csv', MOVEMENT_COLUMNS),
    'overoar': ('overoar.csv', OVEROAR_COLUMNS),
    'pool_result': ('pool_result.csv', POOL_RESULT_COLUMNS),
    'draw_adv_stat': ('draw_adv_stat.csv', DRAW_ADV_COLUMNS),
}
REPLACE_KEYS = {
    'rating_weight': ('horse_id',),
    'performance': ('horse_id',),
    'movement': ('horse_id',),
    'overoar': ('brand_no',),
    'pool_result': ('pool', 'meeting_date'),
    'draw_adv_stat': ('season_code', 'racecourse'),
}


class IdentityError(ValueError):
    """Page identity does not match the requested horse, meeting or search."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def iso(value: date) -> str:
    return value.isoformat()


def parse_iso(value: str) -> date:
    if not ISO_DATE.fullmatch(value or ''):
        raise IdentityError(f'bad date {value!r}')
    return datetime.strptime(value, '%Y-%m-%d').date()


def parse_slash(value: str, label: str) -> date:
    match = SLASH_DATE.fullmatch((value or '').strip())
    if not match:
        raise IdentityError(f'{label} is not a DD/MM/YYYY date')
    day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
    try:
        return date(year, month, day)
    except ValueError as exc:
        raise IdentityError(f'{label} is an impossible date') from exc


def today_hkt(now: datetime | None = None) -> date:
    current = now or datetime.now(HKT)
    if current.tzinfo is None:
        current = current.replace(tzinfo=HKT)
    return current.astimezone(HKT).date()


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
                if not host.endswith('hkjc.com'):
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


def text_of(node) -> str:
    return node.get_text(' ', strip=True) if node else ''


def cells(row) -> list[str]:
    return [text_of(cell) for cell in row.find_all(['td', 'th'])]


def horse_display_name(soup: BeautifulSoup) -> tuple[str, str]:
    """Profile shell title is '馬名 (烙號)' immediately before the 往績紀錄 tab strip."""
    text = soup.get_text(' ', strip=True).replace('\xa0', ' ')
    match = re.search(r'([^\s（()]{1,30}?)\s*[（(]([A-Z]\d{3})[）)]\s*往績紀錄', text)
    if not match:
        raise IdentityError('horse page title is not name(brand)')
    return match.group(1).strip(), match.group(2)


def check_horse_identity(soup: BeautifulSoup, horse: dict) -> tuple[str, str]:
    name, brand = horse_display_name(soup)
    want_name = re.sub(r'\s*[（(][A-Z]\d{3}[）)]\s*$', '', horse['horse_name']).strip()
    if name != want_name or brand != horse['brand_no']:
        raise IdentityError(f"horse page is {name} ({brand}), not {want_name} ({horse['brand_no']})")
    return name, brand


def content_table(soup: BeautifulSoup) -> list[list[str]]:
    tables = soup.find_all('table')
    if not tables:
        raise IdentityError('horse page has no content table')
    return [cells(row) for row in tables[-1].find_all('tr')]


def starts_on_page(soup: BeautifulSoup) -> int:
    """Profile block 冠-亞-季-總出賽次數 w-x-y-z; the last number is career starts."""
    text = soup.get_text(' ', strip=True)
    match = re.search(r'冠-亞-季-總出賽次數\*?\s*[:：]\s*(\d+)-(\d+)-(\d+)-(\d+)', text)
    if not match:
        raise IdentityError('horse page career-start line missing')
    return int(match.group(4))


def parse_rating_weight(raw: bytes, horse: dict, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw, 'html.parser')
    name, brand = check_horse_identity(soup, horse)
    rows = content_table(soup)
    date_row = None
    labels = {}
    for row in rows:
        if not row:
            continue
        if date_row is None and len(row) >= 2 and all(SLASH_DATE.fullmatch(c) for c in row[1:] if c):
            if any(SLASH_DATE.fullmatch(c) for c in row[1:]):
                date_row = row
                continue
        if row[0] in ('評分', '賽果', '馬匹體重', '馬場', '跑道', '途程', '賽道', '場地狀況', '賽事班次'):
            labels[row[0]] = row
    if date_row is None or not {'評分', '賽果', '馬匹體重', '馬場', '跑道'} <= set(labels):
        if starts_on_page(soup) == 0:
            return []
        raise IdentityError('rating/weight table incomplete for a horse with starts')
    dates = [c for c in date_row[1:] if c]
    out = []
    for index, day_text in enumerate(dates):
        race_date = parse_slash(day_text, 'rating race date')
        if race_date > today:
            raise IdentityError('rating row date is in the future')
        column = index + 1
        # A horse's first start(s) can have no published rating; keep the row.
        rating_text = labels['評分'][column]
        rating = '' if rating_text in ('', '---') else whole(rating_text, 'rating')
        finish = labels['賽果'][column]
        if not re.fullmatch(r'\d+/\d+', finish):
            raise IdentityError(f'finish text {finish!r} is not position/field')
        # Overseas starts show --- for body weight; keep the row, store NULL.
        weight_text = labels['馬匹體重'][column]
        if weight_text == '---':
            body_weight = ''
        else:
            body_weight = whole(weight_text, 'body weight')
        # HK venues map to codes; overseas venues keep the page's own name.
        venue_text = labels['馬場'][column]
        if not venue_text:
            raise IdentityError('rating row venue missing')
        venue = VENUE_NAME.get(venue_text, venue_text)
        track = labels['跑道'][column]
        if not track:
            raise IdentityError('rating row track missing')
        distance_m = ''
        if '途程' in labels:
            distance_text = labels['途程'][column]
            if distance_text:
                distance_m = whole(distance_text, 'distance')
        def optional(label: str) -> str:
            if label not in labels:
                return ''
            value = labels[label][column]
            return '' if value == '---' else value
        out.append({
            'horse_id': horse['horse_id'], 'horse_name': name, 'brand_no': brand,
            'race_date': iso(race_date), 'rating': rating, 'finish_text': finish,
            'body_weight': body_weight, 'venue': venue, 'track': track, 'distance_m': distance_m,
            'course_label': optional('賽道'), 'going': optional('場地狀況'), 'race_class': optional('賽事班次'),
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    return out


def parse_performance(raw: bytes, horse: dict, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw, 'html.parser')
    name, brand = check_horse_identity(soup, horse)
    rows = content_table(soup)
    header = next((row for row in rows if len(row) >= 7 and row[2] == '出賽' and row[3] == '冠'), None)
    if header is None:
        if starts_on_page(soup) == 0:
            return []
        raise IdentityError('performance table header missing for a horse with starts')
    out = []
    section = None
    carry_a = ''
    for row in rows:
        if not row or row is header:
            continue
        first = row[0] if len(row) > 0 else ''
        if first in ('場地成績', '路程成績', '歷季成績'):
            section = {'場地成績': 'going', '路程成績': 'distance', '歷季成績': 'season'}[first]
            carry_a = ''
            continue
        if section is None or len(row) < 7:
            continue
        label_a = row[0] or carry_a
        label_b = row[1]
        if section == 'season':
            # Season rows put the season code in the second column.
            if not row[0] and label_b:
                label_a, label_b = label_b, '全季'
            elif not label_b:
                label_b = '全季'
        if not label_a or not label_b:
            raise IdentityError('performance row label missing')
        carry_a = label_a
        numbers = [whole(row[i], f'performance {label_a}/{label_b}') for i in range(2, 7)]
        starts, wins, seconds, thirds, losses = numbers
        if wins + seconds + thirds + losses != starts:
            raise IdentityError(f'performance {label_a}/{label_b} places do not add to starts')
        out.append({
            'horse_id': horse['horse_id'], 'horse_name': name, 'brand_no': brand,
            'section': section, 'label_a': label_a, 'label_b': label_b,
            'starts': starts, 'wins': wins, 'seconds': seconds, 'thirds': thirds, 'losses': losses,
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not out and starts_on_page(soup) > 0:
        raise IdentityError('performance table empty for a horse with starts')
    return out


def parse_movement(raw: bytes, horse: dict, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw, 'html.parser')
    name, brand = check_horse_identity(soup, horse)
    rows = content_table(soup)
    header = next((row for row in rows if row[:3] == ['從', '至', '到達日期']), None)
    if header is None:
        raise IdentityError('movement table header missing')
    out = []
    for row in rows:
        if row is header or len(row) < 3:
            continue
        from_loc, to_loc, day_text = row[0], row[1], row[2]
        # Places are the page's own words (香港, 從化, 海外, …). The identity
        # anchor is the horse title and the date column, not a place list.
        if not to_loc or len(from_loc) > 10 or len(to_loc) > 10:
            raise IdentityError(f'bad movement place {from_loc!r}->{to_loc!r}')
        arrive = parse_slash(day_text, 'movement arrival')
        if arrive > today:
            raise IdentityError('movement arrival is in the future')
        out.append({
            'horse_id': horse['horse_id'], 'horse_name': name, 'brand_no': brand,
            'from_loc': from_loc, 'to_loc': to_loc, 'arrive_date': iso(arrive),
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not out:
        raise IdentityError('movement table is empty')
    return out


def parse_overoar(raw: bytes, today: date, digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw, 'html.parser')
    tables = soup.find_all('table')
    if not tables:
        raise IdentityError('overoar page has no table')
    rows = [cells(row) for row in tables[0].find_all('tr')]
    title = rows[0][0] if rows and rows[0] else ''
    as_of = re.search(r'截至\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日', title)
    if not as_of:
        raise IdentityError('overoar as-of date missing')
    as_of_date = date(int(as_of.group(1)), int(as_of.group(2)), int(as_of.group(3)))
    if as_of_date > today:
        raise IdentityError('overoar as-of date is in the future')
    header = next((row for row in rows if row[:4] == ['烙印編號', '馬名', '診斷日期', '曾接受手術']), None)
    if header is None:
        raise IdentityError('overoar table header missing')
    out = []
    for row in rows:
        if row is header or len(row) < 4 or row is rows[0]:
            continue
        brand, horse_name, day_text, surgery = row[0], row[1], row[2], row[3]
        if not BRAND.fullmatch(brand):
            raise IdentityError(f'bad overoar brand {brand!r}')
        # The official list can leave the name blank (e.g. an unnamed or
        # de-registered horse). The brand is the identity; keep the row.
        diagnosis = parse_slash(day_text, 'overoar diagnosis')
        if diagnosis > today or diagnosis > as_of_date:
            raise IdentityError('overoar diagnosis date is after the as-of date')
        if surgery not in ('Y', 'N'):
            raise IdentityError(f'overoar surgery flag {surgery!r} is not Y/N')
        out.append({
            'as_of_date': iso(as_of_date), 'brand_no': brand, 'horse_name': horse_name,
            'diagnosis_date': iso(diagnosis), 'surgery': surgery,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not out:
        raise IdentityError('overoar list is empty')
    return out


def parse_pool_result(raw: bytes, pool: str, today: date, digest: str, scraped_at: str,
                      requested_date: str = '') -> list[dict]:
    if pool not in ('jkc', 'tnc'):
        raise IdentityError('pool must be jkc or tnc')
    soup = BeautifulSoup(raw, 'html.parser')
    text = soup.get_text(' ', strip=True)
    stamp = re.search(r'賽事日期\s*[:：]\s*(\d{2}/\d{2}/\d{4})', text)
    if not stamp:
        raise IdentityError('pool result meeting date missing')
    meeting = parse_slash(stamp.group(1), 'pool result meeting')
    if meeting > today:
        raise IdentityError('pool result meeting is in the future')
    if requested_date and iso(meeting) != requested_date:
        raise IdentityError(f'pool result is {iso(meeting)}, not requested {requested_date}')
    role_label = '騎師' if pool == 'jkc' else '練馬師'
    tables = soup.find_all('table')
    if not tables:
        raise IdentityError('pool result page has no table')
    rows = [cells(row) for row in tables[0].find_all('tr')]
    header = next((row for row in rows if len(row) >= 8 and row[0] == '編號' and row[1] == role_label), None)
    if header is None:
        raise IdentityError(f'pool result header for {role_label} missing')
    out = []
    for row in rows:
        if row is header or len(row) < 8 or not re.fullmatch(r'\d+', row[0] or ''):
            continue
        rank_no = whole(row[0], 'pool rank')
        person = row[1]
        if not person:
            raise IdentityError('pool result person name missing')
        points = whole(row[2], 'pool points')
        wins, seconds, thirds, fourths = (whole(row[i], 'pool placing') for i in range(3, 7))
        out.append({
            'pool': pool, 'meeting_date': iso(meeting), 'rank_no': rank_no, 'person_name': person,
            'points': points, 'wins': wins, 'seconds': seconds, 'thirds': thirds, 'fourths': fourths,
            'remark': row[7], 'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not out:
        raise IdentityError('pool result table is empty')
    return out


def season_code_for(year_value: str) -> str:
    if not re.fullmatch(r'\d{4}', year_value or ''):
        raise IdentityError(f'bad season year {year_value!r}')
    start = int(year_value) % 100
    return f'{start:02d}/{start + 1:02d}'


def draw_adv_combos(raw: bytes) -> dict[tuple[str, str], dict]:
    """Read the search form: per (season year, racecourse) the course and distance options."""
    soup = BeautifulSoup(raw, 'html.parser')
    seasons = {}
    season_select = soup.find('select', id='seasonId')
    if season_select is None:
        raise IdentityError('draw search season select missing')
    for option in season_select.find_all('option'):
        value = option.get('value') or ''
        label = text_of(option)
        code = season_code_for(value)
        if not label.startswith(code):
            raise IdentityError(f'season option {value} label {label!r} disagrees')
        seasons[value] = code
    racecourse_select = soup.find('select', id='racecourseId')
    if racecourse_select is None:
        raise IdentityError('draw search racecourse select missing')
    racecourses = [option.get('value') or '' for option in racecourse_select.find_all('option')]
    if not racecourses or any(rc not in RACECOURSE_NAME for rc in racecourses):
        raise IdentityError('draw search racecourse options changed')
    combos = {}
    for year in seasons:
        for rc in racecourses:
            course_select = soup.find('select', id=f'courseId_{year}{rc}')
            distance_select = soup.find('select', id=f'distanceId_{year}{rc}')
            if distance_select is None:
                raise IdentityError(f'draw search distances missing for {year}{rc}')
            distances = [option.get('value') or '' for option in distance_select.find_all('option')]
            if not distances or any(not re.fullmatch(r'\d+', d) for d in distances):
                raise IdentityError(f'draw search distances bad for {year}{rc}')
            courses = []
            if course_select is not None:
                courses = [option.get('value') or '' for option in course_select.find_all('option')]
                courses = [c for c in courses if c]
            combos[(year, rc)] = {'courses': courses, 'distances': distances}
    return combos


def parse_draw_adv(raw: bytes, year: str, racecourse: str, course: str, distance: str,
                   digest: str, scraped_at: str) -> list[dict]:
    soup = BeautifulSoup(raw, 'html.parser')
    result = soup.select_one('div.searchResult')
    season_code = season_code_for(year)
    if result is None:
        # A combo with no races in the season (e.g. Conghua before its first
        # meeting, or an unraced distance early in the season) returns the form
        # page with no grid. The form must still be there; a page without the
        # search form means the page changed and the read fails.
        if soup.find('select', id='seasonId') is None:
            raise IdentityError(f'draw search page changed for {year} {racecourse} {course} {distance}')
        return []
    table = result.find('table')
    rows = [cells(row) for row in table.find_all('tr')] if table else []
    if len(rows) < 3:
        raise IdentityError('draw grid table incomplete')
    title = ' '.join(rows[0])
    for token in (season_code, RACECOURSE_NAME[racecourse], f'{distance}米', RACECOURSE_SURF[racecourse]):
        if token not in title:
            raise IdentityError(f'draw grid title missing {token!r}')
    if course and f'"{course}" 賽道' not in title:
        raise IdentityError(f'draw grid title missing course {course!r}')
    header = rows[1]
    if header[:6] != ['檔位', '出賽 次數', '冠', '亞', '季', '殿'] and header[:6] != ['檔位', '出賽次數', '冠', '亞', '季', '殿']:
        raise IdentityError('draw grid header changed')
    out = []
    for row in rows[2:]:
        if len(row) < 10 or not re.fullmatch(r'\d+', row[0] or ''):
            continue
        draw = whole(row[0], 'draw')
        if not 1 <= draw <= 14:
            raise IdentityError(f'draw {draw} out of range')
        starts, wins, seconds, thirds, fourths = (whole(row[i], 'draw count') for i in range(1, 6))
        if wins + seconds + thirds + fourths > starts:
            raise IdentityError('draw placings exceed starts')
        win_pct, quinella_pct, place_pct, top4_pct = (percent_number(row[i], 'draw pct') for i in range(6, 10))
        out.append({
            'season_code': season_code, 'racecourse': racecourse, 'course_label': course,
            'distance_m': int(distance), 'going': 'ALL', 'draw': draw, 'starts': starts,
            'wins': wins, 'seconds': seconds, 'thirds': thirds, 'fourths': fourths,
            'win_pct': win_pct, 'quinella_pct': quinella_pct, 'place_pct': place_pct,
            'top4_pct': top4_pct, 'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not out:
        raise IdentityError('draw grid has no rows')
    return out


def load_racecard_horses(root: Path, racecard: str = '') -> list[dict]:
    base = root / 'entries' / 'racecard_snapshots'
    if racecard:
        key = racecard.replace(' ', '_')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}_(ST|HV)', key):
            raise IdentityError(f'bad racecard {racecard!r}')
        folder = base / key
    else:
        folders = sorted(path for path in base.glob('*_*') if path.is_dir())
        if not folders:
            raise IdentityError('no racecard snapshot available')
        folder = folders[-1]
    if not folder.is_dir():
        raise IdentityError(f'racecard snapshot {folder.name} not found')
    csvs = sorted(folder.glob('*.csv'))
    if not csvs:
        raise IdentityError(f'racecard snapshot {folder.name} has no CSV')
    horses = {}
    with csvs[-1].open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            horse_id = row.get('horse_id') or ''
            name = row.get('horse_name_ch') or ''
            brand = row.get('horse_code') or ''
            if not horse_id and not name:
                continue
            if not HORSE_ID.fullmatch(horse_id) or not name or not BRAND.fullmatch(brand):
                raise IdentityError(f'racecard horse identity incomplete: {horse_id!r} {name!r} {brand!r}')
            horses[horse_id] = {'horse_id': horse_id, 'horse_name': name, 'brand_no': brand}
    if not horses:
        raise IdentityError('racecard snapshot has no horses')
    return sorted(horses.values(), key=lambda item: item['horse_id'])


def load_active_horses(root: Path) -> list[dict]:
    """Weekly sweep: every active profile horse. Brand year is unknown, so the
    horse id comes from the newest racecard snapshots when present; profiles
    without a recent snapshot id are skipped (fail-closed, never guessed)."""
    base = root / 'entries' / 'racecard_snapshots'
    by_brand = {}
    for folder in sorted(base.glob('*_*')):
        for path in sorted(folder.glob('*.csv')):
            with path.open(encoding='utf-8-sig', newline='') as handle:
                for row in csv.DictReader(handle):
                    horse_id = row.get('horse_id') or ''
                    brand = row.get('horse_code') or ''
                    name = row.get('horse_name_ch') or ''
                    if HORSE_ID.fullmatch(horse_id) and BRAND.fullmatch(brand) and name:
                        by_brand[brand] = {'horse_id': horse_id, 'horse_name': name, 'brand_no': brand}
    horses = []
    with (root / 'horses/profiles/horse_profiles.csv').open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            if row.get('status') != 'active':
                continue
            brand = row.get('horse_no') or ''
            if brand in by_brand:
                horses.append(by_brand[brand])
    if not horses:
        raise IdentityError('no active horses with a known official id')
    return sorted(horses, key=lambda item: item['horse_id'])


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
    path.write_bytes(('﻿' + buffer.getvalue()).encode('utf-8'))


def merge_rows(existing: list[dict], fresh: list[dict], keys: tuple[str, ...]) -> list[dict]:
    fresh_keys = {tuple(str(row[key]) for key in keys) for row in fresh}
    kept = [row for row in existing if tuple(str(row[key]) for key in keys) not in fresh_keys]
    merged = kept + fresh
    merged.sort(key=lambda row: tuple(str(row[key]) for key in keys))
    return merged


def store_surface(root: Path, name: str, rows: list[dict]) -> None:
    filename, columns = FILES[name]
    path = root / 'data' / 'official_wave4' / filename
    merged = merge_rows(read_csv(path, columns), rows, REPLACE_KEYS[name])
    write_csv(path, columns, merged)


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = root / 'data' / 'official_wave4' / 'manifest.jsonl'
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
    base = root / 'data' / 'official_wave4'
    statements = ['-- generated from data/official_wave4; official board upsert, not a race result']
    integer_columns = {
        'rating', 'body_weight', 'starts', 'wins', 'seconds', 'thirds', 'losses', 'fourths',
        'not_race_result', 'rank_no', 'points', 'distance_m', 'draw', 'win_pct', 'quinella_pct',
        'place_pct', 'top4_pct',
    }
    for table, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        sql_table = 'official_' + table
        for row in rows:
            values = []
            for column in columns:
                raw = row.get(column, '')
                if raw == '':
                    values.append('NULL')
                elif column in integer_columns:
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


def fetch_horse_surface(path: str, horses: list[dict], parser, today: date, scraped_at: str,
                        workers: int) -> tuple[list[dict], str]:
    rows = []
    digests = []

    def one(horse: dict):
        raw = fetch_bytes(f'{SITE}/zh-hk/local/information/{path}?' + urlencode({'horseid': horse['horse_id']}))
        digest = sha256(raw)
        return parser(raw, horse, today, digest, scraped_at), digest

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(one, horse): horse for horse in horses}
        for future in as_completed(futures):
            horse = futures[future]
            try:
                parsed, digest = future.result()
            except IdentityError as exc:
                raise IdentityError(f"{horse['brand_no']} {horse['horse_id']}: {exc}") from exc
            rows.extend(parsed)
            digests.append(digest)
    combined = hashlib.sha256(''.join(sorted(digests)).encode()).hexdigest()
    return rows, combined


def run(root: Path, surfaces: list[str], today: date, racecard: str = '', requested_date: str = '',
        all_active: bool = False, seasons: str = 'current', workers: int = 4) -> dict:
    unknown = [name for name in surfaces if name not in SURFACES]
    if unknown:
        raise IdentityError(f'unknown surfaces {unknown}')
    scraped_at = scraped_now()
    summary = {}
    horse_surfaces = [name for name in surfaces if name in ('rating-weight', 'performance', 'movement')]
    horses = None
    if horse_surfaces:
        horses = load_active_horses(root) if all_active else load_racecard_horses(root, racecard)
    if 'rating-weight' in surfaces:
        rows, digest = fetch_horse_surface('ratingresultweight', horses, parse_rating_weight, today, scraped_at, workers)
        store_surface(root, 'rating_weight', rows)
        append_manifest(root, 'rating-weight', digest, scraped_at, len(rows))
        summary['rating-weight'] = len(rows)
    if 'performance' in surfaces:
        rows, digest = fetch_horse_surface('performance', horses, parse_performance, today, scraped_at, workers)
        store_surface(root, 'performance', rows)
        append_manifest(root, 'performance', digest, scraped_at, len(rows))
        summary['performance'] = len(rows)
    if 'movement' in surfaces:
        rows, digest = fetch_horse_surface('movementrecords', horses, parse_movement, today, scraped_at, workers)
        store_surface(root, 'movement', rows)
        append_manifest(root, 'movement', digest, scraped_at, len(rows))
        summary['movement'] = len(rows)
    if 'overoar' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/information/overoar')
        rows = parse_overoar(raw, today, sha256(raw), scraped_at)
        store_surface(root, 'overoar', rows)
        append_manifest(root, 'overoar', sha256(raw), scraped_at, len(rows))
        summary['overoar'] = len(rows)
    if 'pool-result' in surfaces:
        rows = []
        for pool, path in (('jkc', 'jkcresult'), ('tnc', 'tncresult')):
            url = f'{SITE}/zh-hk/local/information/{path}'
            if requested_date:
                stamp = parse_iso(requested_date)
                url += '?' + urlencode({'racedate': stamp.strftime('%Y/%m/%d')})
            raw = fetch_bytes(url)
            rows.extend(parse_pool_result(raw, pool, today, sha256(raw), scraped_at, requested_date))
        store_surface(root, 'pool_result', rows)
        append_manifest(root, 'pool-result', rows[0]['source_sha256'], scraped_at, len(rows))
        summary['pool-result'] = len(rows)
    if 'draw-adv' in surfaces:
        if seasons not in ('current', 'all'):
            raise IdentityError('seasons must be current or all')
        raw = fetch_bytes(SITE + '/zh-hk/local/information/drawadvsearch')
        combos = draw_adv_combos(raw)
        current_start = today.year if today.month >= 9 else today.year - 1
        rows = []
        digests = []
        for (year, racecourse), options in sorted(combos.items()):
            if seasons == 'current' and int(year) != current_start:
                continue
            courses = options['courses'] or ['']
            for course in courses:
                for distance in options['distances']:
                    query = {'Year': year, 'Racecourse': racecourse, 'Distance': distance, 'Going': 'ALL'}
                    if course:
                        query['Course'] = course
                    page = fetch_bytes(SITE + '/zh-hk/local/information/drawadvsearch?' + urlencode(query))
                    digest = sha256(page)
                    rows.extend(parse_draw_adv(page, year, racecourse, course, distance, digest, scraped_at))
                    digests.append(digest)
        if not rows:
            raise IdentityError('draw advanced search produced no rows')
        combined = hashlib.sha256(''.join(sorted(digests)).encode()).hexdigest()
        store_surface(root, 'draw_adv_stat', rows)
        append_manifest(root, 'draw-adv', combined, scraped_at, len(rows))
        summary['draw-adv'] = len(rows)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Scrape official HKJC Wave4 boards into CSV and optional SQL')
    parser.add_argument('--root', default='.')
    parser.add_argument('--surfaces', default=','.join(SURFACES))
    parser.add_argument('--racecard', default='', help='YYYY-MM-DD_ST or "YYYY-MM-DD ST"; blank uses the latest snapshot')
    parser.add_argument('--date', default='', help='YYYY-MM-DD racedate for pool-result; blank follows the page')
    parser.add_argument('--all-active', action='store_true', help='Per-horse surfaces cover every active profile horse')
    parser.add_argument('--seasons', default='current', choices=['current', 'all'],
                        help='draw-adv: current season only, or every season on the form')
    parser.add_argument('--emit-sql', default='', help='Write D1 upsert SQL from CSV and exit')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    root = Path(args.root)
    if args.emit_sql:
        Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
        return
    if args.date:
        parse_iso(args.date)
    surfaces = [part.strip() for part in args.surfaces.split(',') if part.strip()]
    summary = run(root, surfaces, today_hkt(), args.racecard, args.date, args.all_active, args.seasons, args.workers)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
