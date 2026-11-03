#!/usr/bin/env python3
"""HKJC race-day focus article (賽日頭條) and last-run reminder (上仗備忘).

Both pages are content shells whose data is embedded in the Next.js flight payload of
the public HTML. Nothing is requested beyond the two public pages.

* focus   — the article for one meeting: title, highlighted lead, version, and the
            SHA-256 / length of the body. The body text itself is not stored: it is
            an editorial article, so the product links to the official page instead.
            The theme image is not stored either (no image licence).
* lastrun — one row per selected runner: the official last-start line and comment.
            Every runner must match the meeting's declared runners (race, horse
            number, brand, name) from ride_assignment.csv, and its last start must be
            before the meeting date. Anything else fails closed and writes nothing.

Rows are research reference only: never a model input, never a frozen-pick input,
never a race result.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sqlite3
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hkjc_raceday_companions import (  # noqa: E402
    BRAND, IdentityError, ParseMiss, SITE, fetch_bytes, parse_iso, read_csv, scraped_now,
    sql_literal, today_hkt, write_csv,
)

MIGRATION = Path(__file__).resolve().parents[1] / 'backend/src/db/migrations/20261103_official_raceday_articles.sql'
PAGES = {'focus': '/zh-hk/local/page/raceday-focus', 'lastrun': '/zh-hk/local/page/last-run-reminder'}
LAST_VENUE = {'田': 'ST', '谷': 'HV', '從': 'CH'}
LASTRUN_HEADER = (
    '場次', '馬匹編號', '馬名', '烙號', '賽事日期', '場次', '馬場', '賽道/跑道', '班次', '路程(米)', '檔位',
    '沿途走位6', '沿途走位5', '沿途走位4', '沿途走位3', '沿途走位2', '沿途走位1',
    '沿途疊數6', '沿途疊數5', '沿途疊數4', '沿途疊數3', '沿途疊數2', '沿途疊數1', '上仗備忘',
)
PUSH = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
TEXT_CHUNK = re.compile(rb'(?:^|\n)([0-9a-f]+):T([0-9a-f]+),')
DMY = re.compile(r'^(\d{2})/(\d{2})/(\d{2}|\d{4})$')
STAMP = re.compile(r'^(\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2})$')
LAST_RACE = re.compile(r'^(\d{1,2}) \((\d{1,3})\)$')

FOCUS_COLUMNS = [
    'meeting_date', 'venue', 'version', 'title_ch', 'highlight_ch', 'body_sha256', 'body_chars',
    'source_url', 'not_race_result', 'source_sha256', 'scraped_at',
]
LASTRUN_COLUMNS = [
    'meeting_date', 'venue', 'race_no', 'horse_no', 'horse_code', 'horse_id', 'horse_name_ch',
    'last_date', 'last_race_no', 'last_race_index', 'last_venue', 'last_track_ch', 'last_class',
    'last_distance_m', 'last_draw', 'running_positions', 'running_lanes', 'memo_ch', 'page_updated_at',
    'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'raceday_focus': ('raceday_focus.csv', FOCUS_COLUMNS),
    'last_run_reminder': ('last_run_reminder.csv', LASTRUN_COLUMNS),
}
INTEGER_COLUMNS = {
    'version', 'body_chars', 'not_race_result', 'race_no', 'horse_no', 'last_race_no', 'last_race_index',
    'last_distance_m', 'last_draw',
}


def flight_bytes(html: str) -> bytes:
    pieces = [json.loads('"' + m + '"') for m in PUSH.findall(html)]
    if not pieces:
        raise ParseMiss('page has no embedded content payload')
    return ''.join(pieces).encode('utf-8')


def text_chunks(flight: bytes) -> dict[str, str]:
    """Text rows are `id:T<hex byte length>,<bytes>`; the length is in UTF-8 bytes."""
    out = {}
    for m in TEXT_CHUNK.finditer(flight):
        start = m.end()
        out[m.group(1).decode()] = flight[start:start + int(m.group(2), 16)].decode('utf-8')
    return out


def dmy_iso(value: str, label: str) -> str:
    m = DMY.match(value.strip())
    if not m:
        raise ParseMiss(f'{label} {value!r} is not dd/mm/yy')
    year = int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
    try:
        return date(year, int(m.group(2)), int(m.group(1))).isoformat()
    except ValueError as exc:
        raise ParseMiss(f'{label} {value!r} is not a date') from exc


def whole(value: str, label: str, low: int, high: int) -> int:
    if not re.fullmatch(r'\d+', value.strip()):
        raise ParseMiss(f'{label} {value!r} is not a whole number')
    number = int(value)
    if not low <= number <= high:
        raise ParseMiss(f'{label} {number} is outside {low}-{high}')
    return number


def strip_html(fragment: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', fragment)
    text = re.sub(r'&nbsp;|&#160;', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def parse_focus(html: str, requested_date: str, requested_venue: str, digest: str, scraped_at: str) -> dict | None:
    flight = flight_bytes(html)
    text = flight.decode('utf-8')
    anchor = text.find('{"raceDateObj":')
    if anchor < 0:
        raise ParseMiss('race-day focus payload is missing')
    try:
        props, _ = json.JSONDecoder().raw_decode(text, anchor)
    except json.JSONDecodeError as exc:
        raise ParseMiss('race-day focus payload is not JSON') from exc
    by_date = props.get('raceDateObj')
    if not isinstance(by_date, dict) or not by_date:
        raise ParseMiss('race-day focus has no dated articles')
    key = date.fromisoformat(requested_date).strftime('%d/%m/%Y')
    entries = [e for e in by_date.get(key) or [] if e.get('enable') is True]
    if not entries:
        return None  # not published yet for this meeting
    if len(entries) != 1:
        raise IdentityError(f'{len(entries)} enabled focus articles for {requested_date}')
    entry = entries[0]
    stamp = (entry.get('raceDate') or {}).get('dateValue')
    if not isinstance(stamp, int):
        raise ParseMiss('focus article has no race date')
    # dateValue is midnight HKT expressed in UTC milliseconds.
    if datetime.utcfromtimestamp(stamp / 1000 + 8 * 3600).date().isoformat() != requested_date:
        raise IdentityError('focus article date does not match its key')
    title = ((entry.get('themeTitle') or {}).get('value') or '').strip()
    lead = strip_html((entry.get('highlightedText') or {}).get('value') or '')
    if not title:
        raise ParseMiss('focus article has no title')
    ref = ((entry.get('detailText') or {}).get('rendered') or '')
    body = ref
    if isinstance(ref, str) and ref.startswith('$'):
        body = text_chunks(flight).get(ref[1:])
        if body is None:
            raise ParseMiss(f'focus body {ref} is missing')
    body_text = strip_html(body or '')
    if not body_text:
        raise ParseMiss('focus article body is empty')
    versions = [v.get('version') for v in entry.get('versions') or [] if isinstance(v.get('version'), int)]
    return {
        'meeting_date': requested_date, 'venue': requested_venue,
        'version': max(versions) if versions else None,
        'title_ch': title, 'highlight_ch': lead,
        'body_sha256': hashlib.sha256(body_text.encode('utf-8')).hexdigest(), 'body_chars': len(body_text),
        'source_url': SITE + PAGES['focus'], 'not_race_result': 1,
        'source_sha256': digest, 'scraped_at': scraped_at,
    }


def meeting_runners(root: Path, requested_date: str, requested_venue: str) -> dict[tuple[int, int], dict]:
    path = root / 'data' / 'official_raceday' / 'ride_assignment.csv'
    out = {}
    if not path.exists():
        return out
    with path.open(encoding='utf-8-sig', newline='') as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        if (row.get('role') == 'jockey' and row.get('meeting_date') == requested_date and row.get('venue') == requested_venue
                and str(row.get('race_no', '')).isdigit() and str(row.get('horse_no', '')).isdigit()):
            out[(int(row['race_no']), int(row['horse_no']))] = row
    return out


def dash_join(cells: list[str]) -> str:
    return '-'.join(c.strip() for c in cells if c.strip() not in ('', '-'))


def parse_lastrun(html: str, requested_date: str, requested_venue: str, runners: dict, digest: str,
                  scraped_at: str) -> list[dict] | None:
    flight = flight_bytes(html)
    tables = [t for t in text_chunks(flight).values() if t.startswith('場次\t馬匹編號\t')]
    if len(tables) != 1:
        raise ParseMiss(f'{len(tables)} last-run tables on the page')
    lines = [line.split('\t') for line in tables[0].replace('\r\n', '\n').split('\n')]
    header = tuple(c.strip() for c in lines[0][:len(LASTRUN_HEADER)])
    if header != LASTRUN_HEADER:
        raise ParseMiss('last-run table header changed')
    body, trailer = [], None
    for cells in lines[1:]:
        if not any(c.strip() for c in cells):
            continue
        if DMY.match(cells[0].strip()):
            if trailer is not None:
                raise ParseMiss('last-run table has two meeting rows')
            trailer = cells
            continue
        if trailer is not None:
            raise ParseMiss('last-run runner row after the meeting row')
        body.append(cells)
    if trailer is None:
        raise ParseMiss('last-run table has no meeting row')
    page_date = dmy_iso(trailer[0], 'last-run meeting')
    if page_date != requested_date:
        return None  # the page still shows another meeting
    stamp = STAMP.match(trailer[1].strip())
    if not stamp:
        raise ParseMiss('last-run update time is missing')
    updated = f'{stamp.group(3)}-{stamp.group(2)}-{stamp.group(1)}T{stamp.group(4)}:{stamp.group(5)}:00+08:00'
    if not body:
        raise ParseMiss('last-run table has no runners')
    if not runners:
        raise IdentityError(f'no declared runners stored for {requested_date} {requested_venue}')
    out, seen = [], set()
    for cells in body:
        if len(cells) < len(LASTRUN_HEADER):
            raise ParseMiss('last-run row is short')
        race_no = whole(cells[0], 'race', 1, 11)
        horse_no = whole(cells[1], 'horse number', 1, 14)
        name, brand = cells[2].strip(), cells[3].strip()
        if not BRAND.match(brand):
            raise ParseMiss(f'brand {brand!r} is not an official code')
        runner = runners.get((race_no, horse_no))
        if runner is None or runner['horse_code'] != brand or runner['horse_name_ch'] != name:
            raise IdentityError(f'R{race_no} #{horse_no} {name} {brand} is not a declared runner')
        if (race_no, horse_no) in seen:
            raise IdentityError(f'R{race_no} #{horse_no} listed twice')
        seen.add((race_no, horse_no))
        last_date = dmy_iso(cells[4], 'last start')
        if last_date >= requested_date:
            raise IdentityError(f'R{race_no} #{horse_no} last start {last_date} is not before the meeting')
        last_race = LAST_RACE.match(cells[5].strip())
        if not last_race:
            raise ParseMiss(f'last race {cells[5]!r} is not "race (index)"')
        venue = LAST_VENUE.get(cells[6].strip())
        if venue is None:
            raise ParseMiss(f'last venue {cells[6]!r} is unknown')
        memo = cells[23].strip()
        if not memo:
            raise ParseMiss(f'R{race_no} #{horse_no} has no reminder text')
        out.append({
            'meeting_date': requested_date, 'venue': requested_venue, 'race_no': race_no, 'horse_no': horse_no,
            'horse_code': brand, 'horse_id': runner['horse_id'], 'horse_name_ch': name,
            'last_date': last_date, 'last_race_no': int(last_race.group(1)),
            'last_race_index': int(last_race.group(2)), 'last_venue': venue,
            'last_track_ch': cells[7].strip(), 'last_class': cells[8].strip(),
            'last_distance_m': whole(cells[9], 'distance', 800, 2600),
            'last_draw': whole(cells[10], 'draw', 1, 14),
            'running_positions': dash_join(cells[11:17]), 'running_lanes': dash_join(cells[17:23]),
            'memo_ch': memo, 'page_updated_at': updated, 'not_race_result': 1,
            'source_sha256': digest, 'scraped_at': scraped_at,
        })
    return out


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = root / 'data' / 'official_raceday' / 'manifest.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({'surface': surface, 'sha256': digest, 'scraped_at': scraped_at, 'rows': row_count},
                      ensure_ascii=False, sort_keys=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def replace_meeting(root: Path, table: str, requested_date: str, requested_venue: str, items: list[dict]) -> None:
    filename, columns = FILES[table]
    path = root / 'data' / 'official_raceday' / filename
    keep = [r for r in read_csv(path, columns) if (r['meeting_date'], r['venue']) != (requested_date, requested_venue)]
    rows = keep + items
    write_csv(path, columns, sorted(rows, key=lambda r: (str(r['meeting_date']), str(r['venue']),
                                                        int(r.get('race_no') or 0), int(r.get('horse_no') or 0))))


def run(root: Path, today: date, requested_date: str, requested_venue: str, surfaces: list[str],
        fetch=None) -> dict:
    if requested_venue not in ('ST', 'HV'):
        raise IdentityError('venue must be ST or HV')
    parse_iso(requested_date)
    unknown = [s for s in surfaces if s not in PAGES]
    if unknown:
        raise IdentityError(f'unknown surfaces {unknown}')
    fetch = fetch or (lambda path: fetch_bytes(SITE + path))
    scraped_at = scraped_now()
    summary = {}
    for surface in surfaces:
        raw = fetch(PAGES[surface])
        digest = hashlib.sha256(raw).hexdigest()
        html = raw.decode('utf-8')
        if surface == 'focus':
            row = parse_focus(html, requested_date, requested_venue, digest, scraped_at)
            if row is None:
                summary[surface] = 'pending'
                continue
            replace_meeting(root, 'raceday_focus', requested_date, requested_venue, [row])
            append_manifest(root, 'raceday_focus', digest, scraped_at, 1)
            summary[surface] = 1
        else:
            rows = parse_lastrun(html, requested_date, requested_venue,
                                 meeting_runners(root, requested_date, requested_venue), digest, scraped_at)
            if rows is None:
                summary[surface] = 'pending'
                continue
            replace_meeting(root, 'last_run_reminder', requested_date, requested_venue, rows)
            append_manifest(root, 'last_run_reminder', digest, scraped_at, len(rows))
            summary[surface] = len(rows)
    return summary


def emit_sql(root: Path) -> str:
    base = root / 'data' / 'official_raceday'
    statements = ['-- generated from data/official_raceday focus / last-run; research reference, not a race result']
    for table, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        for meeting_date, venue in sorted({(r['meeting_date'], r['venue']) for r in rows}):
            statements.append(f'DELETE FROM official_{table} WHERE meeting_date = {sql_literal(meeting_date)} '
                              f'AND venue = {sql_literal(venue)};')
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
            statements.append(f"INSERT INTO official_{table} ({', '.join(columns)}) VALUES ({', '.join(values)});")
    return '\n'.join(statements) + '\n'


def apply_sql(db_path: Path, sql_text: str) -> None:
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(MIGRATION.read_text(encoding='utf-8'))
        connection.executescript(sql_text)
        connection.commit()
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description='Scrape HKJC race-day focus and last-run reminder')
    parser.add_argument('--root', default='.')
    parser.add_argument('--date', default='')
    parser.add_argument('--venue', default='')
    parser.add_argument('--surfaces', default='focus,lastrun')
    parser.add_argument('--emit-sql', default='')
    args = parser.parse_args()
    root = Path(args.root)
    try:
        if args.emit_sql:
            Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
            return
        surfaces = [s for s in args.surfaces.split(',') if s]
        print(json.dumps(run(root, today_hkt(), args.date, args.venue, surfaces), ensure_ascii=False, sort_keys=True))
    except (IdentityError, ParseMiss) as exc:
        print(f'race-day articles refused: {exc}', file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == '__main__':
    main()
