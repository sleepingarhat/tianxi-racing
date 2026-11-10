#!/usr/bin/env python3
"""Official surfaces that were still missing after capy_wave5_visible.

* 馬匹來港前名稱 — the page's own rw_HorseFormerName query (the all-horse directory)
* 獎金計劃出賽馬 — the page payload's declared-starter list
* 終點相片 — the results-page photo grid (official image paths, not the bytes)
* 賽事特別情況索引 — the abbreviation table in the page payload

賽日數據 is two JPEG posters. 馬匹消息 / 馬匹評分榜 View= returns the index
shell and the page scripts do not request a table. Those stay uncollected.

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
PUSH = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
HORSE_ID = re.compile(r'^HK_(\d{4})_([A-Z]\d{3})$')
BRAND = re.compile(r'^[A-Z]\d{3}$')
ORIGIN = re.compile(r'^[A-Z]{2,3}$')
IMPORT_CODE = re.compile(r'^[A-Z0-9]{2,8}$')
PHOTO_CODE = re.compile(r'^P\d{1,2}$')
INDEX_CODE = re.compile(r'^[A-Z][A-Z0-9-]{0,8}$')
PHOTO_PATH = re.compile(
    r'^https://consvc\.hkjc\.com/-/media/Sites/JCRW/FinishPhotos/'
    r'(?P<season>\d{2}_\d{2})/(?P<day>\d{8})/(?P=day)R(?P<race>\d{2})_(?P<code>P\d{1,2})\.jpg$'
)
REQUIRED_INDEX = (
    'DISQ', 'DNF', 'FE', 'ML', 'PU', 'TNP', 'TO', 'UR', 'VOID', 'WR', 'WV', 'WV-A', 'WX', 'WX-A', 'WXNR',
)
VENUE_LABEL = {'沙田': 'ST', '跑馬地': 'HV'}
SURFACES = ('former', 'fwb', 'finish-photo', 'special-index')
FINISH_WINDOW_DAYS = 21

FORMER_QUERY = """
  query rw_HorseFormerName {
    horses {
      id
      code
      name_en
      name_ch
      formerName
      sire
      dam
      importType
      importTypeNm {
        english
        chinese
        code
      }
      cntyOfOrg {
        code
        chinese
        english
      }
      age
      foalingDate
    }
  }
"""

FORMER_COLUMNS = [
    'horse_id', 'horse_code', 'name_en', 'name_ch', 'former_name', 'sire', 'dam',
    'import_type', 'import_type_ch', 'origin_code', 'origin_ch', 'age', 'foaling_date',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FWB_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'horse_no', 'is_reserve', 'horse_name_en', 'horse_name_ch',
    'brand_no', 'bonus_en', 'bonus_ch', 'not_race_result', 'source_sha256', 'scraped_at',
]
PHOTO_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'photo_code', 'season_code', 'image_path',
    'not_race_result', 'source_sha256', 'scraped_at',
]
INDEX_COLUMNS = [
    'code', 'line_no', 'note_ch', 'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'horse_former_name': ('horse_former_name.csv', FORMER_COLUMNS),
    'fwb_declared': ('fwb_declared.csv', FWB_COLUMNS),
    'finish_photo': ('finish_photo.csv', PHOTO_COLUMNS),
    'special_index': ('special_index.csv', INDEX_COLUMNS),
}
INTEGER_COLUMNS = {'age', 'race_no', 'horse_no', 'is_reserve', 'line_no', 'not_race_result'}
REPLACE_ALL = {'horse_former_name', 'special_index', 'fwb_declared'}
MEETING_KEYS = {'finish_photo'}


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
                if not (host == 'info.cld.hkjc.com' or host == 'consvc.hkjc.com' or host.endswith('hkjc.com')):
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


def graphql(query: str) -> tuple[dict, str]:
    raw = fetch_bytes(
        GRAPHQL, 'POST', json.dumps({'query': query, 'variables': {}}).encode(),
        {'content-type': 'application/json', 'accept': 'application/json'},
    )
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IdentityError('former-name response is not JSON') from exc
    if body.get('errors') or not isinstance(body.get('data'), dict):
        raise IdentityError('former-name query rejected or incomplete')
    return body, sha256(raw)


def blank(value: str | None) -> str | None:
    text = re.sub(r'\s+', ' ', (value or '').replace('\xa0', ' ')).strip()
    if text in ('', '-', '--', '---', '----'):
        return None
    return text


def dmy(value: str, label: str) -> str:
    match = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', (value or '').strip())
    if not match:
        raise ParseMiss(f'{label} {value!r} is not DD/MM/YYYY')
    try:
        return date(int(match.group(3)), int(match.group(2)), int(match.group(1))).isoformat()
    except ValueError as exc:
        raise ParseMiss(f'{label} {value!r} is not a calendar day') from exc


def ymd(value: str) -> str:
    return value.replace('-', '')


def season_code(day: date) -> str:
    start = day.year if day.month >= 9 else day.year - 1
    return f'{start % 100:02d}_{start % 100 + 1:02d}'


def fixtures(root: Path) -> list[dict]:
    path = root / 'data' / 'fixtures' / 'fixtures.csv'
    if not path.exists():
        raise IdentityError('fixtures.csv is missing')
    with path.open(encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def fixture_on(root: Path, meeting_date: str) -> dict:
    matches = [row for row in fixtures(root) if row.get('date') == meeting_date and row.get('venue') in ('ST', 'HV')]
    if len(matches) != 1:
        raise IdentityError(f'{meeting_date} does not match one local fixture')
    count = matches[0].get('race_count') or ''
    if not re.fullmatch(r'\d+', count) or int(count) < 1 or int(count) > 14:
        raise IdentityError(f'{meeting_date} fixture has no race count')
    return matches[0]


def recent_fixtures(root: Path, today: date) -> list[dict]:
    start = (today - timedelta(days=FINISH_WINDOW_DAYS)).isoformat()
    rows = []
    for row in fixtures(root):
        if row.get('venue') not in ('ST', 'HV'):
            continue
        if not (start <= (row.get('date') or '') <= today.isoformat()):
            continue
        if not re.fullmatch(r'\d+', row.get('race_count') or ''):
            continue
        rows.append(row)
    return rows


def parse_former(payload: dict, digest: str, scraped_at: str, today: date) -> list[dict]:
    horses = (payload.get('data') or {}).get('horses') if isinstance(payload, dict) else None
    if not isinstance(horses, list) or not horses:
        raise ParseMiss('former-name directory is empty')
    rows = []
    seen = set()
    for horse in horses:
        if not isinstance(horse, dict):
            raise ParseMiss('former-name row is not an object')
        horse_id = str(horse.get('id') or '')
        code = str(horse.get('code') or '')
        match = HORSE_ID.fullmatch(horse_id)
        if not match or match.group(2) != code or not BRAND.fullmatch(code):
            raise IdentityError(f'former-name horse {horse_id!r}/{code!r} is not a local brand')
        if horse_id in seen:
            raise IdentityError(f'former-name horse {horse_id} is repeated')
        seen.add(horse_id)
        name_en = blank(horse.get('name_en'))
        sire = blank(horse.get('sire'))
        dam = blank(horse.get('dam'))
        if not name_en or not sire or not dam:
            raise IdentityError(f'former-name horse {horse_id} is missing a name or pedigree')
        import_type = str(horse.get('importType') or '')
        named = horse.get('importTypeNm') or {}
        origin = horse.get('cntyOfOrg') or {}
        if import_type != named.get('code') or not IMPORT_CODE.fullmatch(import_type):
            raise IdentityError(f'former-name horse {horse_id} import type disagrees')
        import_ch = blank(named.get('chinese'))
        origin_code = str(origin.get('code') or '')
        origin_ch = blank(origin.get('chinese'))
        if not import_ch or not ORIGIN.fullmatch(origin_code) or not origin_ch:
            raise IdentityError(f'former-name horse {horse_id} origin or import label is empty')
        age_text = str(horse.get('age') or '')
        if not re.fullmatch(r'\d{1,2}', age_text):
            raise ParseMiss(f'former-name horse {horse_id} age is not official')
        age = int(age_text)
        if age < 2 or age > 15:
            raise ParseMiss(f'former-name horse {horse_id} age {age} is outside 2 to 15')
        foaling = str(horse.get('foalingDate') or '')
        stamp = re.fullmatch(r'(\d{4}-\d{2}-\d{2})\+08:00', foaling)
        if not stamp:
            raise ParseMiss(f'former-name horse {horse_id} foaling date is not Hong Kong')
        try:
            born = date.fromisoformat(stamp.group(1))
        except ValueError as exc:
            raise ParseMiss(f'former-name horse {horse_id} foaling date is not a day') from exc
        if born.year < 1990 or born > today:
            raise IdentityError(f'former-name horse {horse_id} foaling date is not before today')
        rows.append({
            'horse_id': horse_id, 'horse_code': code, 'name_en': name_en,
            'name_ch': blank(horse.get('name_ch')), 'former_name': blank(horse.get('formerName')),
            'sire': sire, 'dam': dam, 'import_type': import_type, 'import_type_ch': import_ch,
            'origin_code': origin_code, 'origin_ch': origin_ch, 'age': age, 'foaling_date': stamp.group(1),
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    rows.sort(key=lambda row: row['horse_id'])
    return rows


def json_string_after(flight: str, marker: str) -> str:
    index = flight.find(marker)
    if index < 0:
        raise ParseMiss(f'page payload has no {marker}')
    start = index + len(marker)
    if start >= len(flight) or flight[start] != '"':
        raise ParseMiss(f'{marker} is not a JSON string')
    try:
        value, _ = json.JSONDecoder().raw_decode(flight[start:])
    except json.JSONDecodeError as exc:
        raise ParseMiss(f'{marker} JSON string is broken') from exc
    if not isinstance(value, str):
        raise ParseMiss(f'{marker} is not text')
    return value


def parse_fwb(flight: str, root: Path, digest: str, scraped_at: str) -> list[dict]:
    text = json_string_after(flight, '"pP_PPG_and_ISG_Bonuses":{"value":')
    lines = [line.strip() for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n') if line.strip()]
    if not lines:
        raise BoardPending('bonus declared-starter list is not published')
    meeting_date = dmy(lines[0], 'bonus meeting')
    fixture = fixture_on(root, meeting_date)
    race_count = int(fixture['race_count'])
    venue = fixture['venue']
    rows = []
    seen = set()
    for line in lines[1:]:
        parts = [part.strip() for part in line.split(',')]
        if len(parts) != 7:
            raise ParseMiss(f'bonus line {line!r} does not have seven fields')
        race_text, number_text, name_en, name_ch, brand, bonus_en, bonus_ch = parts
        if not re.fullmatch(r'\d{1,2}', race_text):
            raise ParseMiss(f'bonus race {race_text!r} is not official')
        race_no = int(race_text)
        reserve = 0
        if number_text.upper().startswith('STBY-'):
            reserve = 1
            number_text = number_text.split('-', 1)[1]
        if not re.fullmatch(r'\d{1,2}', number_text):
            raise ParseMiss(f'bonus horse number {number_text!r} is not official')
        horse_no = int(number_text)
        if race_no < 1 or race_no > race_count or horse_no < 1 or horse_no > 30:
            raise IdentityError('bonus horse is outside the fixture')
        if not name_en or not name_ch or not BRAND.fullmatch(brand) or not bonus_en or not bonus_ch:
            raise IdentityError(f'bonus horse {brand!r} is incomplete')
        key = (race_no, reserve, horse_no)
        if key in seen:
            raise IdentityError(f'bonus horse {key} is repeated')
        seen.add(key)
        rows.append({
            'meeting_date': meeting_date, 'venue': venue, 'race_no': race_no, 'horse_no': horse_no,
            'is_reserve': reserve, 'horse_name_en': name_en, 'horse_name_ch': name_ch, 'brand_no': brand,
            'bonus_en': bonus_en, 'bonus_ch': bonus_ch, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss('bonus list has a date and no horses')
    return rows


def heading_venue(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, 'html.parser')
    found = []
    seen: list = []
    for node in soup.find_all(string=re.compile(r'賽事日期')):
        parent = node.parent
        if parent in seen:
            continue
        seen.append(parent)
        text = re.sub(r'\s+', ' ', parent.get_text(' ', strip=True))
        match = re.fullmatch(r'賽事日期:\s*(\d{2}/\d{2}/\d{4})\s+(沙田|跑馬地)', text)
        if match:
            found.append(match)
    if len(found) != 1:
        raise IdentityError('results page does not have one local 賽事日期 heading')
    return dmy(found[0].group(1), 'results heading'), VENUE_LABEL[found[0].group(2)]


def parse_finish_race(html: str, meeting_date: str, venue: str, race_no: int, digest: str, scraped_at: str) -> list[dict] | None:
    page_date, page_venue = heading_venue(html)
    if page_date != meeting_date or page_venue != venue:
        raise BoardPending(f'{meeting_date} {venue} results page shows {page_date} {page_venue}')
    soup = BeautifulSoup(html, 'html.parser')
    block = soup.find('div', class_='finish_photos')
    if block is None:
        return None
    rows = []
    seen = set()
    expected_season = season_code(date.fromisoformat(meeting_date))
    for link in block.find_all('a', href=True):
        href = link['href'].replace('&amp;', '&')
        path = href.split('path=', 1)[1] if 'path=' in href else href
        if path.startswith('//'):
            path = 'https:' + path
        match = PHOTO_PATH.fullmatch(path.split('?', 1)[0])
        if not match:
            raise ParseMiss(f'finish photo {path!r} is not an official path')
        if match.group('season') != expected_season:
            raise IdentityError(f'finish photo season {match.group("season")} is not {expected_season}')
        if match.group('day') != ymd(meeting_date) or int(match.group('race')) != race_no:
            raise IdentityError(f'finish photo {path} is not {meeting_date} race {race_no}')
        code = match.group('code')
        if not PHOTO_CODE.fullmatch(code) or code in seen:
            raise IdentityError(f'finish photo code {code} is repeated or not official')
        seen.add(code)
        rows.append({
            'meeting_date': meeting_date, 'venue': venue, 'race_no': race_no, 'photo_code': code,
            'season_code': expected_season, 'image_path': path, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    if not rows:
        raise ParseMiss(f'{meeting_date} race {race_no} finish-photo block has no photos')
    return rows


def parse_special_index(flight: str, digest: str, scraped_at: str) -> list[dict]:
    marker = flight.find('英文縮寫')
    start = flight.rfind('<table', 0, marker)
    end = flight.find('</table>', marker)
    if marker < 0 or start < 0 or end < 0:
        raise ParseMiss('special-index payload has no table')
    html = flight[start:end + len('</table>')]
    soup = BeautifulSoup(html, 'html.parser')
    table = soup.find('table')
    if table is None:
        raise ParseMiss('special-index payload has no table')
    body = []
    for tr in table.find_all('tr'):
        cells = [re.sub(r'\s+', ' ', cell.get_text(' ', strip=True)).strip() for cell in tr.find_all(['td', 'th'])]
        cells = [cell for cell in cells if cell]
        if cells:
            body.append(cells)
    if not body or body[0] != ['賽事特別情況索引'] or body[1] != ['英文縮寫', '註釋']:
        raise ParseMiss('special-index headings changed')
    rows = []
    seen = set()
    for cells in body[2:]:
        if len(cells) != 2:
            raise ParseMiss(f'special-index row {cells!r} is not code plus note')
        code, note = cells
        if not INDEX_CODE.fullmatch(code) or code in seen or not note:
            raise IdentityError(f'special-index code {code!r} is not official')
        seen.add(code)
        rows.append({
            'code': code, 'line_no': len(rows) + 1, 'note_ch': note, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    missing = [code for code in REQUIRED_INDEX if code not in seen]
    if missing:
        raise ParseMiss(f'special-index is missing {", ".join(missing)}')
    return rows


def data_dir(root: Path) -> Path:
    path = root / 'data' / 'official_wave6'
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
    if isinstance(value, bool):
        raise IdentityError('refusing boolean SQL value')
    text = str(value)
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
    statements = ['-- generated from data/official_wave6; official board upsert, not a model input']
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


def collect_finish(root: Path, scraped_at: str) -> tuple[list[dict], str]:
    filename, columns = FILES['finish_photo']
    grouped: dict[tuple[str, str, int], list[dict]] = {}
    for row in read_csv(data_dir(root) / filename, columns):
        grouped.setdefault((row['meeting_date'], row['venue'], int(row['race_no'])), []).append(row)
    digests = []
    today = datetime.now(HKT).date()
    for fixture in recent_fixtures(root, today):
        meeting_date = fixture['date']
        venue = fixture['venue']
        race_count = int(fixture['race_count'])
        heading_ok = False
        pending_meeting = False
        fresh: dict[int, list[dict]] = {}
        for race_no in range(1, race_count + 1):
            url = (
                f'{SITE}/zh-hk/local/information/localresults'
                f'?racedate={meeting_date[0:4]}/{meeting_date[5:7]}/{meeting_date[8:10]}'
                f'&Racecourse={venue}&RaceNo={race_no}'
            )
            raw = fetch_bytes(url)
            digest = sha256(raw)
            try:
                parsed = parse_finish_race(
                    raw.decode('utf-8', errors='replace'), meeting_date, venue, race_no, digest, scraped_at,
                )
            except BoardPending as exc:
                if not heading_ok:
                    pending_meeting = True
                    break
                raise IdentityError(f'{meeting_date} {venue} race {race_no} heading disagrees with race 1') from exc
            heading_ok = True
            if parsed is None:
                continue
            fresh[race_no] = parsed
            digests.append(digest)
        if pending_meeting:
            continue
        for race_no, parsed in fresh.items():
            grouped[(meeting_date, venue, race_no)] = parsed
    rows = [row for key in sorted(grouped) for row in grouped[key]]
    digest = hashlib.sha256(''.join(digests).encode()).hexdigest() if digests else sha256(b'pending')
    return rows, digest


def collect(root: Path, surfaces: set[str]) -> dict[str, int]:
    scraped_at = scraped_now()
    today = datetime.now(HKT).date()
    summary = {}
    if 'former' in surfaces:
        payload, digest = graphql(FORMER_QUERY)
        rows = parse_former(payload, digest, scraped_at, today)
        write_csv(data_dir(root) / FILES['horse_former_name'][0], FORMER_COLUMNS, rows)
        append_manifest(root, 'former', digest, scraped_at, len(rows))
        summary['former'] = len(rows)
    if 'fwb' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/page/fwb-declared-starters')
        rows = parse_fwb(flight_text(raw.decode('utf-8', errors='replace')), root, sha256(raw), scraped_at)
        write_csv(data_dir(root) / FILES['fwb_declared'][0], FWB_COLUMNS, rows)
        append_manifest(root, 'fwb', sha256(raw), scraped_at, len(rows))
        summary['fwb'] = len(rows)
    if 'finish-photo' in surfaces:
        rows, digest = collect_finish(root, scraped_at)
        write_csv(data_dir(root) / FILES['finish_photo'][0], PHOTO_COLUMNS, rows)
        append_manifest(root, 'finish-photo', digest, scraped_at, len(rows))
        summary['finish-photo'] = len(rows)
    if 'special-index' in surfaces:
        raw = fetch_bytes(SITE + '/zh-hk/local/page/special-race-index')
        rows = parse_special_index(flight_text(raw.decode('utf-8', errors='replace')), sha256(raw), scraped_at)
        write_csv(data_dir(root) / FILES['special_index'][0], INDEX_COLUMNS, rows)
        append_manifest(root, 'special-index', sha256(raw), scraped_at, len(rows))
        summary['special-index'] = len(rows)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Collect the remaining visible official HKJC surfaces')
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
