#!/usr/bin/env python3
"""HKJC Jockey Challenge (騎師王坐騎表) and Trainer Challenge (練馬師王出馬表) boards.

The GraphQL documents are the page bundles saved in hkjc-challenge-queries.graphql and
are not extended (the endpoint whitelists page queries). Rows are the public pool
board and its official points sheet: research reference only, never a model input,
never a frozen-pick input, and never a race result. Odds are stored as the page text.

A meeting whose challenge pool is not defined yet is reported as pending and writes
nothing. Any visible pool that cannot be fully mapped to official codes fails closed.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hkjc_raceday_companions import (  # noqa: E402
    HORSE_ID, PERSON, IdentityError, ParseMiss, graphql, local_meeting, parse_iso, read_csv,
    scraped_now, sql_literal, today_hkt, whole, write_csv,
)

QUERY_FILE = Path(__file__).with_name('hkjc-challenge-queries.graphql')
MIGRATION = Path(__file__).resolve().parents[1] / 'backend/src/db/migrations/20261103_official_challenge_boards.sql'
OPERATIONS = {'JKC': 'rw_JKCScheduledRides', 'TNC': 'rw_TNCTRAINERSENTRIES'}
STATUSES = {
    'DEFINED', 'SELLINGSTARTED', 'SELLINGSTOPPED', 'SUSPENDED', 'PAYOUTSTARTED', 'PAYOUTSTOPPED',
    'CLOSED', 'REFUNDBEFORESUSPEND', 'REFUND', 'START_SELL', 'STOP_SELL', 'PAYOUT', 'HOLD',
}
ODDS_TEXT = re.compile(r'^(\d+(\.\d+)?|SCR|---|-)$')

POOL_COLUMNS = [
    'meeting_date', 'venue', 'odds_type', 'inst_no', 'label_ch', 'pool_status', 'is_concluded',
    'include_races', 'inplay_up_to', 'other_sel_no', 'last_update_time', 'not_race_result',
    'source_sha256', 'scraped_at',
]
SELECTION_COLUMNS = [
    'meeting_date', 'venue', 'odds_type', 'inst_no', 'comb_id', 'is_other', 'person_code', 'person_name_ch',
    'person_name_en', 'odds_text', 'open_odds_text', 'scheduled_rides', 'final_order', 'other_order', 'accumulated_points',
    'not_race_result', 'source_sha256', 'scraped_at',
]
RIDE_COLUMNS = [
    'meeting_date', 'venue', 'odds_type', 'inst_no', 'person_code', 'race_no', 'horse_id', 'points',
    'incident_type', 'not_race_result', 'source_sha256', 'scraped_at',
]
FILES = {
    'challenge_pool': ('challenge_pool.csv', POOL_COLUMNS),
    'challenge_selection': ('challenge_selection.csv', SELECTION_COLUMNS),
    'challenge_ride': ('challenge_ride.csv', RIDE_COLUMNS),
}
KEYS = ('meeting_date', 'venue', 'odds_type')
INTEGER_COLUMNS = {
    'inst_no', 'is_concluded', 'inplay_up_to', 'other_sel_no', 'not_race_result', 'is_other',
    'scheduled_rides', 'final_order', 'other_order', 'race_no', 'points',
}


def load_queries() -> dict[str, str]:
    text = QUERY_FILE.read_text(encoding='utf-8')
    parts = re.split(r'(?m)^# operation (\w+)\s*$', text)
    found = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
    if set(found) != set(OPERATIONS.values()):
        raise IdentityError('challenge query file operations changed')
    for name, query in found.items():
        if not query.startswith('query ' + name):
            raise IdentityError(f'{name} is not the page query')
    if 'foPools(oddsTypes: [JKC])' not in found['rw_JKCScheduledRides']:
        raise IdentityError('jockey challenge query is not the JKC page bundle')
    if 'foPools(oddsTypes: TNC)' not in found['rw_TNCTRAINERSENTRIES']:
        raise IdentityError('trainer challenge query is not the TNC page bundle')
    return found


def odds_text(value, label: str) -> str | None:
    if value is None or str(value).strip() == '':
        return None
    text = str(value).strip()
    if not ODDS_TEXT.fullmatch(text):
        raise ParseMiss(f'{label} odds {text!r} is not page text')
    return text


def points_text(value, label: str) -> str | None:
    if value is None or str(value).strip() == '':
        return None
    text = str(value).strip()
    if not re.fullmatch(r'\d+(\.\d+)?', text):
        raise ParseMiss(f'{label} points {text!r} are not official')
    return text


def optional_whole(value, label: str) -> int | None:
    if value is None or str(value).strip() == '':
        return None
    return whole(value, label)


def code_of(value, label: str) -> str:
    code = str(value or '')
    if not PERSON.fullmatch(code):
        raise ParseMiss(f'{label} code {code!r} is not an official code')
    return code


def ride_rows(base: dict, person: str, incidents, race_set: set[int], digest: str, scraped_at: str) -> list[dict]:
    rows = []
    for item in incidents or []:
        race_no = whole(item.get('raceNo'), 'challenge race number')
        if race_no not in race_set:
            raise ParseMiss(f'challenge ride race {race_no} is outside the included races')
        horse_id = str(item.get('horseId') or '')
        if not HORSE_ID.fullmatch(horse_id):
            raise IdentityError(f'challenge horse id {horse_id!r} is not official')
        incident = item.get('raIncidentType')
        rows.append({
            **base, 'person_code': person, 'race_no': race_no, 'horse_id': horse_id,
            'points': optional_whole(item.get('points'), 'ride points'),
            'incident_type': None if incident is None else str(incident),
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
    return rows


def parse_challenge(payload: dict, odds_type: str, requested_date: str, requested_venue: str,
                    digest: str, scraped_at: str) -> dict[str, list[dict]] | None:
    """Return CSV rows, or None when the page shows the pool as not yet published."""
    if odds_type not in OPERATIONS:
        raise IdentityError('odds type is not JKC or TNC')
    for item in (payload.get('data') or {}).get('commonMeetings') or []:
        # The TNC bundle lists races out of order; identity checks still need every number once.
        item['races'] = sorted(item.get('races') or [], key=lambda race: whole(race.get('no'), 'race number'))
    meeting = local_meeting(payload, odds_type, requested_date, requested_venue)
    race_nos = {whole(race.get('no'), 'race number') for race in meeting['races']}
    horse_ids = {
        str((runner.get('horse') or {}).get('id') or '')
        for race in meeting['races'] for runner in race.get('runners') or []
    }
    stat_key = 'jockeyStat' if odds_type == 'JKC' else 'trainerStat'
    roster = {item.get('code'): item for item in payload.get('data', {}).get(stat_key) or []}
    pools = meeting.get('foPools') or []
    if not pools:
        return None
    out = {name: [] for name in FILES}
    seen_inst = set()
    for pool in pools:
        inst = whole(pool.get('instNo'), 'instance number')
        if inst in seen_inst:
            raise ParseMiss(f'{odds_type} instance {inst} repeats')
        seen_inst.add(inst)
        status = str(pool.get('status') or '')
        if status not in STATUSES:
            raise ParseMiss(f'{odds_type} pool status {status!r} is not known')
        include = [whole(value, 'included race') for value in pool.get('includeRaces') or []]
        if not include or not set(include) <= race_nos or len(set(include)) != len(include):
            raise ParseMiss(f'{odds_type} included races {include} are not meeting races')
        label = str((pool.get('oddsTypeDes') or {}).get('chinese') or '').replace('{0}', '').strip()
        expected_label = '騎師王' if odds_type == 'JKC' else '練馬師王'
        if label != expected_label:
            raise IdentityError(f'{odds_type} label {label!r} is not {expected_label}')
        other_no = optional_whole(pool.get('otherSelNo'), 'other selection number')
        base = {'meeting_date': meeting['date'], 'venue': meeting['venueCode'], 'odds_type': odds_type, 'inst_no': inst}
        concluded = pool.get('isConcluded')
        out['challenge_pool'].append({
            **base, 'label_ch': label, 'pool_status': status,
            'is_concluded': None if concluded is None else int(bool(concluded)),
            'include_races': ','.join(str(n) for n in include),
            'inplay_up_to': optional_whole(pool.get('inplayUpTo'), 'in-play race'),
            'other_sel_no': other_no, 'last_update_time': pool.get('lastUpdateTime'),
            'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
        })
        race_set = set(include)
        # Official points sheet: selStr is the zero-padded selection number.
        sheet = {}
        for item in pool.get('resultSheet') or []:
            sel = whole(item.get('selStr'), 'result selection')
            results = item.get('result') or []
            if len(results) != 1:
                raise ParseMiss(f'{odds_type} selection {sel} has {len(results)} result rows')
            sheet[sel] = results[0]
        others = []
        for item in pool.get('otherResultSheet') or []:
            others.extend(item.get('otherResult') or [])
        selections = pool.get('selections') or []
        if not selections:
            raise ParseMiss(f'{odds_type} pool has no selections')
        comb_seen = set()
        for sel in selections:
            comb = whole(sel.get('combId'), 'selection number')
            if comb in comb_seen:
                raise ParseMiss(f'{odds_type} selection {comb} repeats')
            comb_seen.add(comb)
            is_other = int(other_no is not None and comb == other_no)
            result = sheet.get(comb)
            listed = sel.get('code')
            if is_other:
                person = None
            elif listed:
                person = code_of(listed, f'{odds_type} selection {comb}')
                if result and result.get('refId') and result['refId'] != person:
                    raise IdentityError(f'{odds_type} selection {comb} result {result["refId"]} is not {person}')
            elif result and result.get('refId'):
                person = code_of(result['refId'], f'{odds_type} result {comb}')
            else:
                person = None
            out['challenge_selection'].append({
                **base, 'comb_id': comb, 'is_other': is_other, 'person_code': person,
                'person_name_ch': sel.get('name_ch') or (roster.get(person) or {}).get('name_ch'),
                'person_name_en': sel.get('name_en') or (roster.get(person) or {}).get('name_en'),
                'odds_text': odds_text(sel.get('currentOdds'), f'{odds_type} {comb}'),
                'open_odds_text': odds_text(sel.get('openOdds'), f'{odds_type} {comb} open'),
                'scheduled_rides': optional_whole(sel.get('scheduleRides'), 'scheduled rides'),
                'final_order': optional_whole(result.get('selOdrNo'), 'final order') if result else None,
                'other_order': None,
                'accumulated_points': points_text(result.get('accumulatedPoints'), f'{odds_type} {comb}') if result else None,
                'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
            if result and person:
                out['challenge_ride'].extend(ride_rows(base, person, result.get('raIncidents'), race_set, digest, scraped_at))
        missing = set(sheet) - comb_seen
        if missing:
            raise ParseMiss(f'{odds_type} results {sorted(missing)} have no selection')
        names = {item.get('code'): item for item in pool.get('otherSelections') or []}
        for item in others:
            person = code_of(item.get('refId'), f'{odds_type} other')
            listed = names.get(person) or {}
            out['challenge_selection'].append({
                **base, 'comb_id': other_no, 'is_other': 1, 'person_code': person,
                'person_name_ch': listed.get('name_ch') or (roster.get(person) or {}).get('name_ch'),
                'person_name_en': listed.get('name_en') or (roster.get(person) or {}).get('name_en'),
                'odds_text': None, 'open_odds_text': None,
                'scheduled_rides': optional_whole(listed.get('scheduleRides'), 'scheduled rides'),
                'final_order': None,
                'other_order': optional_whole(item.get('orderNo'), 'other order'),
                'accumulated_points': points_text(item.get('accumulatedPoints'), f'{odds_type} other {person}'),
                'not_race_result': 1, 'source_sha256': digest, 'scraped_at': scraped_at,
            })
            out['challenge_ride'].extend(ride_rows(base, person, item.get('raIncidents'), race_set, digest, scraped_at))
    for row in out['challenge_ride']:
        if row['horse_id'] not in horse_ids:
            raise IdentityError(f"challenge horse {row['horse_id']} is not a runner at this meeting")
    return out


def append_manifest(root: Path, surface: str, digest: str, scraped_at: str, row_count: int) -> None:
    path = root / 'data' / 'official_raceday' / 'manifest.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({'surface': surface, 'sha256': digest, 'scraped_at': scraped_at, 'rows': row_count},
                      ensure_ascii=False, sort_keys=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def run(root: Path, today: date, requested_date: str = '', requested_venue: str = '') -> dict:
    if requested_venue and requested_venue not in ('ST', 'HV'):
        raise IdentityError('venue must be ST or HV')
    if not requested_date or not requested_venue:
        raise IdentityError('challenge boards need --date and --venue from the fixture list')
    parse_iso(requested_date)
    queries = load_queries()
    scraped_at = scraped_now()
    summary = {}
    for odds_type, operation in OPERATIONS.items():
        variables = {'dates': [requested_date]}
        if odds_type == 'JKC':
            variables['active'] = None
        payload, digest = graphql(queries[operation], variables)
        rows = parse_challenge(payload, odds_type, requested_date, requested_venue, digest, scraped_at)
        if rows is None:
            summary[odds_type] = 'pending'
            continue
        for name, items in rows.items():
            # Replace this meeting's rows for this pool; earlier snapshots stay in git history and the manifest.
            filename, columns = FILES[name]
            path = root / 'data' / 'official_raceday' / filename
            key = (requested_date, requested_venue, odds_type)
            keep = [r for r in read_csv(path, columns) if (r['meeting_date'], r['venue'], r['odds_type']) != key]
            write_csv(path, columns, sorted(keep + items, key=lambda r: tuple(str(r[k]) for k in KEYS)))
        append_manifest(root, f'challenge_{odds_type.lower()}', digest, scraped_at, len(rows['challenge_selection']))
        summary[odds_type] = {name: len(items) for name, items in rows.items()}
    return summary


def emit_sql(root: Path) -> str:
    base = root / 'data' / 'official_raceday'
    statements = ['-- generated from data/official_raceday challenge boards; research reference, not a race result']
    for table, (filename, columns) in FILES.items():
        rows = read_csv(base / filename, columns)
        for meeting_date, venue, odds_type in sorted({(r['meeting_date'], r['venue'], r['odds_type']) for r in rows}):
            statements.append(
                f'DELETE FROM official_{table} WHERE meeting_date = {sql_literal(meeting_date)} '
                f'AND venue = {sql_literal(venue)} AND odds_type = {sql_literal(odds_type)};'
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
    parser = argparse.ArgumentParser(description='Scrape HKJC jockey / trainer challenge boards')
    parser.add_argument('--root', default='.')
    parser.add_argument('--date', default='', help='YYYY-MM-DD fixture date')
    parser.add_argument('--venue', default='', help='ST or HV')
    parser.add_argument('--emit-sql', default='')
    args = parser.parse_args()
    root = Path(args.root)
    try:
        if args.emit_sql:
            Path(args.emit_sql).write_text(emit_sql(root), encoding='utf-8')
            return
        print(json.dumps(run(root, today_hkt(), args.date, args.venue), ensure_ascii=False, sort_keys=True))
    except (IdentityError, ParseMiss) as exc:
        print(f'challenge boards refused: {exc}', file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == '__main__':
    main()
