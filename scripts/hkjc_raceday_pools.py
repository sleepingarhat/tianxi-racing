#!/usr/bin/env python3
"""HKJC race-day pool board: every pari-mutuel pool, official dividends, jackpots and
the going probe (penetrometer / Clegg hammer) readings.

The data comes from the same public rw_Summary GraphQL document used by
hkjc_raceday_companions.py (the zh-hk results / summary page bundle). The document is
not extended. Only Sha Tin and Happy Valley meetings are stored.

* pool_status   — one row per pool: type, leg, races, sell status, jackpot, estimated dividend.
* pool_dividend — one row per official dividend line (winning, consolation, bonus).
                  An OFFICIAL line that is already stored can never change or disappear:
                  a later read that disagrees fails closed and writes nothing.
* track_probe   — penetrometer and hammer readings with their official reading time.

Dividends are post-race facts. They are research and settlement reference only:
never a model input, never a frozen-pick input.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hkjc_raceday_companions import (  # noqa: E402
    IdentityError, ParseMiss, graphql, load_queries, local_meeting, parse_iso, read_csv,
    scraped_now, sql_literal, today_hkt, whole, write_csv,
)

MIGRATION = Path(__file__).resolve().parents[1] / 'backend/src/db/migrations/20261104_official_raceday_pools.sql'
POOL_TYPE = re.compile(r'^[A-Za-z][A-Za-z0-9]{1,8}$')
DIV_TYPE = re.compile(r'^[A-Za-z0-9]{2,20}$')
DIV_STATUS = re.compile(r'^[A-Z_]{2,20}$')
COMB = re.compile(r'^[0-9F,/>+\- ]{1,120}$')  # F = field (all runners)
MONEY = re.compile(r'^\d+(?:\.\d{1,2})?$')
READING = re.compile(r'^\d{1,2}(?:\.\d{1,3})?$')

STATUS_COLUMNS = [
    'meeting_date', 'venue', 'odds_type', 'leg_no', 'race_nos', 'sell_status', 'jackpot_hkd',
    'estimated_dividend_hkd', 'merged_pool_id', 'rebate_rate', 'source_sha256', 'scraped_at',
]
DIVIDEND_COLUMNS = [
    'meeting_date', 'venue', 'odds_type', 'leg_no', 'race_nos', 'dividend_type', 'seq', 'win_comb',
    'dividend_hkd', 'partial', 'partial_unit', 'guarantee', 'status', 'post_race_only',
    'source_sha256', 'scraped_at',
]
PROBE_COLUMNS = [
    'meeting_date', 'venue', 'instrument', 'reading_time', 'reading', 'source_sha256', 'scraped_at',
]
FILES = {
    'pool_status': ('pool_status.csv', STATUS_COLUMNS),
    'pool_dividend': ('pool_dividend.csv', DIVIDEND_COLUMNS),
    'track_probe': ('track_probe.csv', PROBE_COLUMNS),
}
INTEGER_COLUMNS = {'leg_no', 'seq', 'partial', 'partial_unit', 'post_race_only', 'rebate_rate'}
DIVIDEND_KEY = ('odds_type', 'leg_no', 'dividend_type', 'seq', 'win_comb')


def money(value, label: str) -> str | None:
    if value is None or value == '':
        return None
    text = str(value).strip()
    if not MONEY.fullmatch(text):
        raise ParseMiss(f'{label} {text!r} is not an amount')
    return text


def race_list(leg: dict, race_count: int, label: str) -> tuple[int, str]:
    leg_no = whole(leg.get('number'), f'{label} leg')
    races = [whole(item, f'{label} race') for item in (leg.get('races') or [])]
    if not races or any(not 1 <= r <= race_count for r in races) or races != sorted(set(races)):
        raise ParseMiss(f'{label} leg {leg_no} races {races} are not on this card')
    return leg_no, ','.join(str(r) for r in races)


def probe_time(value: str, meeting: str) -> str:
    try:
        stamp = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ParseMiss(f'probe time {value!r} is not ISO') from exc
    if stamp.tzinfo is None or stamp.utcoffset() != timedelta(hours=8):
        raise ParseMiss('probe time is not Hong Kong time')
    day = parse_iso(meeting)
    if not day - timedelta(days=3) <= stamp.date() <= day:
        raise IdentityError(f'probe reading {value} is not for meeting {meeting}')
    return stamp.isoformat()


def parse_pools(payload: dict, requested_date: str, requested_venue: str, digest: str, scraped_at: str) -> dict[str, list[dict]]:
    # Older meetings list races out of order; order by number before the contiguity check.
    payload = copy.deepcopy(payload)
    for item in (payload.get('data') or {}).get('commonMeetings') or []:
        if isinstance(item.get('races'), list):
            item['races'].sort(key=lambda race: int(race.get('no') or 0))
    meeting = local_meeting(payload, 'pools', requested_date, requested_venue)
    day, venue = meeting['date'], meeting['venueCode']
    race_count = len(meeting['races'])
    base = {'meeting_date': day, 'venue': venue, 'source_sha256': digest, 'scraped_at': scraped_at}
    statuses, dividends, probes = [], [], []
    seen_pools = set()
    for pool in meeting.get('pmPools') or []:
        odds_type = str(pool.get('oddsType') or '')
        if not POOL_TYPE.fullmatch(odds_type):
            raise ParseMiss(f'pool type {odds_type!r} is not an official code')
        leg_no, races = race_list(pool.get('leg') or {}, race_count, odds_type)
        if (odds_type, leg_no) in seen_pools:
            raise ParseMiss(f'{odds_type} leg {leg_no} appears twice')
        seen_pools.add((odds_type, leg_no))
        rebate = pool.get('rebateRate')
        if rebate not in (None, '') and not re.fullmatch(r'\d{1,2}', str(rebate)):
            raise ParseMiss(f'{odds_type} rebate {rebate!r} is not a percentage')
        statuses.append({
            **base, 'odds_type': odds_type, 'leg_no': leg_no, 'race_nos': races,
            'sell_status': str(pool.get('sellStatus') or '') or None,
            'jackpot_hkd': money(pool.get('jackpot'), f'{odds_type} jackpot'),
            'estimated_dividend_hkd': money(pool.get('estimatedDividend'), f'{odds_type} estimate'),
            'merged_pool_id': str(pool.get('mergedPoolId') or '') or None,
            'rebate_rate': None if rebate in (None, '') else int(rebate),
        })
        for item in pool.get('dividends') or []:
            kind = str(item.get('type') or '')
            status = str(item.get('status') or '')
            comb = str(item.get('winComb') or '').strip()
            if not DIV_TYPE.fullmatch(kind) or not DIV_STATUS.fullmatch(status):
                raise ParseMiss(f'{odds_type} dividend type/status {kind!r}/{status!r} unknown')
            if not COMB.fullmatch(comb):
                raise ParseMiss(f'{odds_type} winning combination {comb!r} is not the page text')
            amount = money(item.get('div'), f'{odds_type} dividend')
            if amount is None:
                raise ParseMiss(f'{odds_type} dividend amount is empty')
            dividends.append({
                **base, 'odds_type': odds_type, 'leg_no': leg_no, 'race_nos': races,
                'dividend_type': kind, 'seq': whole(item.get('seq'), 'dividend seq'), 'win_comb': comb,
                'dividend_hkd': amount, 'partial': 1 if item.get('partial') else 0,
                'partial_unit': whole(item.get('partialUnit') or 0, 'partial unit'),
                'guarantee': money(item.get('guarantee'), f'{odds_type} guarantee'),
                'status': status, 'post_race_only': 1,
            })
    for instrument, key in (('penetrometer', 'penetrometerReadings'), ('hammer', 'hammerReadings')):
        for item in meeting.get(key) or []:
            reading = str(item.get('reading') or '').strip()
            if not READING.fullmatch(reading):
                raise ParseMiss(f'{instrument} reading {reading!r} is not a number')
            probes.append({
                **base, 'instrument': instrument, 'reading_time': probe_time(item.get('readingTime'), day),
                'reading': reading,
            })
    if not statuses:
        raise ParseMiss('meeting has no pari-mutuel pools')
    return {'pool_status': statuses, 'pool_dividend': dividends, 'track_probe': probes}


def key_of(row: dict, keys) -> tuple:
    return tuple(str(row.get(k) if row.get(k) is not None else '') for k in keys)


def guard_official(existing: list[dict], fresh: list[dict], meeting: tuple[str, str]) -> None:
    """Stored OFFICIAL dividends are final: they may gain lines, never change or vanish."""
    old = {key_of(r, DIVIDEND_KEY): r for r in existing
           if (r['meeting_date'], r['venue']) == meeting and r['status'] == 'OFFICIAL'}
    new = {key_of(r, DIVIDEND_KEY): r for r in fresh}
    for key, row in old.items():
        if key not in new:
            raise IdentityError(f'stored official dividend {key} is missing from the new read')
        if str(new[key]['dividend_hkd']) != row['dividend_hkd'] or new[key]['status'] != 'OFFICIAL':
            raise IdentityError(f'stored official dividend {key} changed')


def store(root: Path, name: str, rows: list[dict], meeting: tuple[str, str]) -> None:
    filename, columns = FILES[name]
    path = root / 'data' / 'official_raceday' / filename
    existing = read_csv(path, columns)
    if name == 'pool_dividend':
        guard_official(existing, rows, meeting)
    kept = [r for r in existing if (r['meeting_date'], r['venue']) != meeting]
    merged = kept + rows
    merged.sort(key=lambda r: key_of(r, columns))
    write_csv(path, columns, merged)


def append_manifest(root: Path, digest: str, scraped_at: str, counts: dict) -> None:
    path = root / 'data' / 'official_raceday' / 'manifest.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({'surface': 'pools', 'sha256': digest, 'scraped_at': scraped_at, 'rows': counts},
                      ensure_ascii=False, sort_keys=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def emit_sql(root: Path) -> str:
    base = root / 'data' / 'official_raceday'
    statements = []
    for name, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        table = 'official_' + name
        for meeting_date, venue in sorted({(r['meeting_date'], r['venue']) for r in rows}):
            if name != 'pool_dividend':  # dividends are insert-or-ignore, never deleted
                statements.append(
                    f'DELETE FROM {table} WHERE meeting_date = {sql_literal(meeting_date)} AND venue = {sql_literal(venue)};'
                )
        verb = 'INSERT OR IGNORE' if name == 'pool_dividend' else 'INSERT OR REPLACE'
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
            statements.append(f"{verb} INTO {table} ({', '.join(columns)}) VALUES ({', '.join(values)});")
    return '\n'.join(statements) + ('\n' if statements else '')


def apply_sql(db_path: Path, sql_text: str) -> None:
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(MIGRATION.read_text(encoding='utf-8'))
        connection.executescript(sql_text)
        connection.commit()
    finally:
        connection.close()


def run(root: Path, requested_date: str, requested_venue: str, today: date, payload: dict | None = None,
        digest: str = '') -> dict:
    if not requested_date or requested_venue not in ('ST', 'HV'):
        raise IdentityError('pools need an explicit date and ST/HV venue')
    if parse_iso(requested_date) > today + timedelta(days=2):
        raise IdentityError('meeting is too far ahead for a pool board')
    scraped_at = scraped_now()
    if payload is None:
        payload, digest = graphql(load_queries()['rw_Summary'], {'dates': [requested_date]})
    stored = parse_pools(payload, requested_date, requested_venue, digest, scraped_at)
    meeting = (requested_date, requested_venue)
    # Check the dividend guard before touching any file, so a refusal writes nothing.
    guard_official(read_csv(root / 'data' / 'official_raceday' / 'pool_dividend.csv', DIVIDEND_COLUMNS),
                   stored['pool_dividend'], meeting)
    for name, rows in stored.items():
        store(root, name, rows, meeting)
    counts = {name: len(rows) for name, rows in stored.items()}
    append_manifest(root, digest, scraped_at, counts)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description='HKJC pool board, dividends and going probe into CSV / SQL')
    parser.add_argument('--root', default='.')
    parser.add_argument('--date', default='')
    parser.add_argument('--venue', default='')
    parser.add_argument('--emit-sql', default='')
    args = parser.parse_args()
    root = Path(args.root)
    try:
        if args.emit_sql:
            Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
            return
        print(json.dumps(run(root, args.date, args.venue, today_hkt()), ensure_ascii=False, sort_keys=True))
    except (IdentityError, ParseMiss) as exc:
        print(f'raceday pools refused: {exc}', file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == '__main__':
    main()
