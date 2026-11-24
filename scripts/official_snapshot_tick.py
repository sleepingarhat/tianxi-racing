#!/usr/bin/env python3
"""Decide and write official pre-race, post-race, and intermediate snapshots.

The freeze clock is MeetingClock: MIN(post_time) - 90 minutes. This job does
not crawl from a Worker cron and does not write live Wave tables.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from official_snapshot_clock import (
    HKT,
    KINDS,
    MeetingClock,
    card_status_to_snapshot,
    crosscheck_lock_state,
    freeze_missed,
    in_freeze_window,
    in_pre_freeze_window,
    is_cancelled_meeting,
    labelled_void_races,
    meeting_clock,
    parse_instant,
    post_race_cap,
    post_race_decision,
    select_meetings,
    utc_iso,
)
from official_snapshot_join import FREEZE_REQUIRED
from official_snapshot_writer import (
    SnapshotConflict,
    append_gap_event,
    append_poll,
    assemble_snapshot,
    content_sha256,
    emit_d1_sql,
    existing_snapshot,
    last_card_status,
    last_poll_hash,
    load_manifest,
    write_snapshot,
    write_sql_chunks,
)

API = 'https://tianxi-backend.tianxi-entertainment.workers.dev'
LIVE_CSV = {
    'entries_upcoming': None,
    'official_racecard_runner': 'data/official_wave7/racecard_runner.csv',
    'official_ove_record': 'data/official_wave5/ove_record.csv',
    'official_ove_database': 'data/official_wave5/ove_database.csv',
    'official_conghua_movement': 'data/official_wave5/conghua_movement.csv',
    'official_jt_combo': 'data/official_wave5/jt_combo.csv',
    'official_fwb_declared': 'data/official_wave6/fwb_declared.csv',
    'official_horse_rating': 'data/official_wave7/horse_rating.csv',
    'official_horse_directory': 'data/official_wave8/horse_directory.csv',
    'official_person_season': 'data/official_wave8/person_season.csv',
    'official_person_winstat': 'data/official_wave8/person_winstat.csv',
    'official_same_sire': 'data/official_wave8/same_sire.csv',
    'official_same_sire_page': 'data/official_wave8/same_sire_page.csv',
    'official_ppo_performance': 'data/official_wave5/ppo_performance.csv',
    'official_wind_meeting': 'data/official_wave8/wind_meeting.csv',
    'official_wind_going': 'data/official_wave8/wind_going.csv',
    'official_wind_station': 'data/official_wave8/wind_station.csv',
    'official_wind_section': 'data/official_wave8/wind_section.csv',
}


def hkt_dates(now: datetime) -> list[str]:
    day = now.astimezone(HKT).date()
    return [(day + timedelta(days=offset)).isoformat() for offset in (-1, 0, 1)]


def fetch_json(url: str):
    from urllib.request import Request, urlopen
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0 TianxiOfficialSnapshot/1.0', 'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def signals_for_status(status: str | None) -> dict | None:
    if status == 'resulted':
        return {'resulted': True, 'hasRaces': True, 'declaredRunners': 1, 'declaredDraws': 1, 'officialEntries': 0}
    if status == 'declared':
        return {'resulted': False, 'hasRaces': True, 'declaredRunners': 1, 'declaredDraws': 1, 'officialEntries': 0}
    if status == 'entries':
        return {'resulted': False, 'hasRaces': False, 'declaredRunners': 0, 'declaredDraws': 0, 'officialEntries': 1}
    if status == 'fixture':
        return {'resulted': False, 'hasRaces': False, 'declaredRunners': 0, 'declaredDraws': 0, 'officialEntries': 0}
    return None


def rows_from_meeting(day: str, payload: dict) -> tuple[list[dict], list[int], str | None]:
    venue = payload.get('venue')
    rows = []
    voids = []
    if is_cancelled_meeting(day) or venue not in ('ST', 'HV'):
        return rows, voids, payload.get('cardStatus')
    for race in payload.get('races') or []:
        number = race.get('raceNumber')
        start = race.get('startTime')
        if isinstance(number, int) and number > 0 and isinstance(start, str) and len(start) == 5:
            try:
                post = f'{day}T{start}:00+08:00'
                parse_instant(post)
            except ValueError:
                continue
            rows.append({'date': day, 'venue': venue, 'race_number': number, 'post_time': post})
        if isinstance(number, int) and (race.get('cancelled') or race.get('void') or str(race.get('status') or '').lower() in ('cancelled', 'void')):
            voids.append(number)
    return rows, voids, payload.get('cardStatus')


def discover(now: datetime) -> tuple[list[dict], dict, dict[str, list[int]], dict]:
    rows = []
    voids = {}
    statuses = {}
    for day in hkt_dates(now):
        try:
            payload = fetch_json(f'{API}/api/meetings/{day}')
        except Exception as exc:
            print(f'[official-snapshot] meetings {day} unread: {exc}', file=sys.stderr)
            continue
        day_rows, day_voids, status = rows_from_meeting(day, payload)
        rows.extend(day_rows)
        if payload.get('venue') in ('ST', 'HV'):
            voids[f"{day}|{payload['venue']}"] = day_voids
            if status:
                statuses[f"{day}|{payload['venue']}"] = status
    try:
        lock_state = fetch_json(f'{API}/api/analyze/lock-state')
    except Exception as exc:
        print(f'[official-snapshot] lock-state unread: {exc}', file=sys.stderr)
        lock_state = None
    return rows, statuses, voids, lock_state


def clocks_for(rows: list[dict], now: datetime) -> list[MeetingClock]:
    selected = {(clock.meeting_date, clock.venue): clock for clock in select_meetings(rows, now)}
    grouped: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        date = str(row.get('date') or '')
        venue = str(row.get('venue') or '')
        if date and venue in ('ST', 'HV') and not is_cancelled_meeting(date):
            grouped.setdefault((date, venue), []).append(row)
    current = now.astimezone(timezone.utc)
    for key, items in grouped.items():
        if key in selected:
            continue
        numbers = [int(item['race_number']) for item in items if item.get('race_number')]
        clock = meeting_clock(key[0], key[1], [str(item['post_time']) for item in items], numbers)
        cap = post_race_cap(clock) if clock else None
        if clock and cap is not None and current <= cap + timedelta(minutes=10):
            selected[key] = clock
    return sorted(selected.values(), key=lambda clock: (clock.first_post_at, clock.venue))


def groups_for(kind: str) -> set[str]:
    if kind == 'post_race':
        return {'results', 'wind'}
    if kind == 'card_status':
        return {'entries', 'racecard', 'wave5', 'wave6'}
    return {'entries', 'racecard', 'wave5', 'wave6', 'ratings', 'directory', 'persons', 'same-sire', 'wind'}


def cite_stale(repo: Path, surface: str, meeting_date: str, venue: str) -> dict | None:
    relative = LIVE_CSV.get(surface)
    if not relative:
        return None
    path = repo / relative
    if not path.exists():
        return None
    import csv
    with path.open(encoding='utf-8-sig', newline='') as handle:
        rows = list(csv.DictReader(handle))
    kept = []
    for row in rows:
        date = row.get('meeting_date') or row.get('race_date') or row.get('as_of_date')
        row_venue = row.get('venue') or row.get('racecourse')
        if date and row.get('meeting_date', date) and 'meeting_date' in row and row.get('meeting_date') != meeting_date:
            continue
        if 'venue' in row and row.get('venue') not in (None, '', venue):
            continue
        if 'racecourse' in row and row.get('racecourse') not in (None, '', venue):
            continue
        kept.append(row)
    if not kept:
        return None
    scraped = next((row.get('scraped_at') for row in kept if row.get('scraped_at')), None)
    return {'scraped_at': scraped, 'row_count': len(kept), 'not_freeze_fresh': True}


def attach_stale_citations(repo: Path, clock: MeetingClock, captures: dict[str, dict]) -> dict[str, dict]:
    """Cite a live Wave file on a gap. Do not copy its rows into the freeze payload."""
    cited = {}
    for name in FREEZE_REQUIRED:
        capture = dict(captures.get(name) or {})
        if capture.get('rows') and not capture.get('error'):
            cited[name] = capture
            continue
        stale = cite_stale(repo, name, clock.meeting_date, clock.venue)
        if stale:
            capture['stale_available'] = stale
        if name in captures or stale:
            cited[name] = capture if capture else {'rows': [], 'error': 'recrawl_failed', 'stale_available': stale}
        else:
            cited[name] = {'rows': [], 'error': 'recrawl_failed'}
    for name, capture in captures.items():
        cited.setdefault(name, capture)
    return cited


def settlement_hash(runners: list[dict], dividends: list[dict]) -> str:
    return content_sha256({
        'official_results_all_dividend': dividends,
        'official_results_all_runner': runners,
    })


def _key(clock: MeetingClock) -> str:
    return f'{clock.meeting_date}|{clock.venue}'


def run(
    repo: Path,
    now: datetime,
    clocks: list[MeetingClock],
    lock_state: dict | None,
    payloads: dict[str, dict],
    card_signals: dict[str, dict],
    explicit_voids: dict[str, list[int]],
    *,
    recrawl: bool,
    kinds: set[str] | None,
    source_commit: str | None,
) -> dict:
    summary = {'actions': [], 'exit': 0, 'written': []}
    sql_parts = []
    wanted = kinds or set(KINDS)

    def fail(code: int) -> None:
        if code > summary['exit']:
            summary['exit'] = code

    for clock in clocks:
        key = _key(clock)
        check = crosscheck_lock_state(clock, lock_state)
        freeze_row = existing_snapshot(repo, clock.meeting_date, clock.venue, 'freeze')
        post_row = existing_snapshot(repo, clock.meeting_date, clock.venue, 'post_race')
        signals = card_signals.get(key)

        def load(kind: str) -> dict[str, dict]:
            if key in payloads:
                captures = dict(payloads[key])
            elif recrawl:
                from official_snapshot_recrawl import recrawl_meeting
                captures = recrawl_meeting(repo, clock.meeting_date, clock.venue, groups_for(kind))
            else:
                captures = {}
            if kind == 'post_race' and 'official_wind_going' in captures:
                captures['post_race_going'] = captures.pop('official_wind_going')
            if kind == 'freeze':
                for leakage in ('official_results_all_runner', 'official_results_all_dividend', 'post_race_going', 'live_win_pla_odds', 'official_finish_photo'):
                    captures.pop(leakage, None)
                captures = attach_stale_citations(repo, clock, captures)
            return captures

        if 'freeze' in wanted and in_freeze_window(now, clock):
            if freeze_row:
                summary['actions'].append({'meeting': key, 'kind': 'freeze', 'status': 'noop'})
            elif check.get('status') == 'clock_mismatch':
                created = append_gap_event(repo, {
                    'meeting_date': clock.meeting_date,
                    'venue': clock.venue,
                    'snapshot_kind': 'freeze',
                    'reason': 'clock_mismatch',
                    'lock_crosscheck': check,
                    'captured_at': utc_iso(now),
                })
                summary['actions'].append({'meeting': key, 'kind': 'freeze', 'status': 'clock_mismatch'})
                if created:
                    fail(3)
            else:
                captures = load('freeze')
                record = assemble_snapshot(
                    clock, 'freeze', utc_iso(now), captures,
                    lock_crosscheck=check, source_commit=source_commit,
                )
                outcome = _write(repo, record, summary, sql_parts)
                if record['completeness'] != 'complete' and outcome == 'written':
                    fail(2)
        elif 'freeze' in wanted and freeze_missed(now, clock, freeze_row is not None):
            created = append_gap_event(repo, {
                'meeting_date': clock.meeting_date,
                'venue': clock.venue,
                'snapshot_kind': 'freeze',
                'reason': 'freeze_missed_window',
                'captured_at': utc_iso(now),
                'not_backfilled': True,
            })
            summary['actions'].append({'meeting': key, 'kind': 'freeze', 'status': 'freeze_missed_window'})
            if created:
                fail(4)

        if 'pre_freeze_safety' in wanted and in_pre_freeze_window(now, clock):
            captures = load('pre_freeze_safety')
            record = assemble_snapshot(
                clock, 'pre_freeze_safety', utc_iso(now), captures,
                lock_crosscheck=check, source_commit=source_commit,
            )
            _write(repo, record, summary, sql_parts)

        if 'card_status' in wanted and signals:
            status = card_status_to_snapshot(last_card_status(repo, clock.meeting_date, clock.venue), signals)
            if status:
                captures = load('card_status')
                for leakage in ('official_results_all_runner', 'official_results_all_dividend', 'live_win_pla_odds', 'official_finish_photo'):
                    captures.pop(leakage, None)
                record = assemble_snapshot(
                    clock, 'card_status', utc_iso(now), captures,
                    card_status=status, lock_crosscheck=check, source_commit=source_commit,
                )
                _write(repo, record, summary, sql_parts)

        if 'post_race' in wanted:
            captures = {}
            if post_row is None and (post_race_cap(clock) is None or now.astimezone(timezone.utc) >= (clock.last_post_at or now)):
                # Load settlement evidence only once last post has passed; unknown timing alerts below.
                if clock.last_post_at is not None and now.astimezone(timezone.utc) >= clock.last_post_at:
                    captures = load('post_race')
            runners = (captures.get('official_results_all_runner') or {}).get('rows') or []
            dividends = (captures.get('official_results_all_dividend') or {}).get('rows') or []
            voids = labelled_void_races(
                list(clock.race_numbers), runners, dividends, set(explicit_voids.get(key) or []),
            )
            current_hash = settlement_hash(runners, dividends) if runners or dividends else None
            decision = post_race_decision(
                now, clock, runners, dividends, voids,
                last_poll_hash(repo, clock.meeting_date, clock.venue),
                current_hash, post_row is not None,
            )
            if decision.action == 'wait' and current_hash and clock.last_post_at is not None:
                earliest_ok = now.astimezone(timezone.utc) >= clock.last_post_at + timedelta(minutes=30)
                if earliest_ok:
                    append_poll(repo, clock.meeting_date, clock.venue, current_hash, utc_iso(now))
                summary['actions'].append({'meeting': key, 'kind': 'post_race', 'status': decision.reason})
            elif decision.action == 'alert':
                summary['actions'].append({'meeting': key, 'kind': 'post_race', 'status': 'unknown_timing'})
                fail(2)
            elif decision.action == 'capture':
                going = captures.get('post_race_going')
                post_captures = {
                    'official_results_all_runner': captures.get('official_results_all_runner') or {'rows': runners},
                    'official_results_all_dividend': captures.get('official_results_all_dividend') or {'rows': dividends},
                }
                if going:
                    post_captures['post_race_going'] = going
                record = assemble_snapshot(
                    clock, 'post_race', utc_iso(now), post_captures,
                    lock_crosscheck=check, extra_gaps=list(decision.gaps),
                    completeness=decision.completeness, source_commit=source_commit,
                )
                outcome = _write(repo, record, summary, sql_parts)
                if decision.completeness == 'partial' and outcome == 'written':
                    fail(2)
            else:
                summary['actions'].append({'meeting': key, 'kind': 'post_race', 'status': decision.action})

    if sql_parts:
        directory = repo / 'data' / 'official_snapshots' / '_staging' / 'd1'
        write_sql_chunks(''.join(sql_parts), directory)
    summary_path = repo / 'data' / 'official_snapshots' / '_staging' / 'summary.json'
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for action in summary['actions']:
        print(f"[official-snapshot] {action['meeting']} {action['kind']} {action['status']}")
    return summary


def _write(repo: Path, record: dict, summary: dict, sql_parts: list[str]) -> str:
    try:
        result = write_snapshot(repo, record)
    except SnapshotConflict as exc:
        summary['actions'].append({
            'meeting': f"{record['meeting_date']}|{record['venue']}",
            'kind': record['snapshot_kind'],
            'status': 'refused_existing',
            'detail': str(exc),
        })
        summary['exit'] = max(summary['exit'], 5)
        return 'refused_existing'
    summary['actions'].append({
        'meeting': f"{record['meeting_date']}|{record['venue']}",
        'kind': record['snapshot_kind'],
        'status': result['status'],
        'completeness': record.get('completeness'),
    })
    if result['status'] == 'written':
        summary['written'].append(result['snapshot_id'])
        sql_parts.append(emit_d1_sql(record))
    return result['status']


def _load_json(path: str | None):
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding='utf-8'))


def main() -> None:
    parser = argparse.ArgumentParser(description='Write append-only official HKJC snapshots')
    parser.add_argument('--root', default='.')
    parser.add_argument('--date', default='')
    parser.add_argument('--venue', default='')
    parser.add_argument('--kind', default='')
    parser.add_argument('--now', default='')
    parser.add_argument('--posts-json', default='')
    parser.add_argument('--payload-json', default='')
    parser.add_argument('--lock-state-json', default='')
    parser.add_argument('--card-signals-json', default='')
    parser.add_argument('--voids-json', default='')
    parser.add_argument('--no-recrawl', action='store_true')
    args = parser.parse_args()
    repo = Path(args.root).resolve()
    now = parse_instant(args.now) if args.now else datetime.now(timezone.utc)
    kinds = {args.kind} if args.kind else None
    if kinds and not kinds <= KINDS:
        raise SystemExit(f'kind must be one of {sorted(KINDS)}')
    posts = _load_json(args.posts_json)
    payloads = _load_json(args.payload_json) or {}
    lock_state = _load_json(args.lock_state_json)
    card_signals = _load_json(args.card_signals_json) or {}
    voids = _load_json(args.voids_json) or {}
    statuses = {}
    if posts is None:
        posts, statuses, discovered_voids, discovered_lock = discover(now)
        voids = {**discovered_voids, **voids}
        if lock_state is None:
            lock_state = discovered_lock
        for key, status in statuses.items():
            card_signals.setdefault(key, signals_for_status(status))
    clocks = clocks_for(posts, now)
    if args.date or args.venue:
        clocks = [
            clock for clock in clocks
            if (not args.date or clock.meeting_date == args.date)
            and (not args.venue or clock.venue == args.venue)
        ]
    recrawl = not args.no_recrawl and not args.payload_json
    summary = run(
        repo, now, clocks, lock_state, payloads, card_signals, voids,
        recrawl=recrawl, kinds=kinds, source_commit=os.environ.get('GITHUB_SHA'),
    )
    # Touching the manifest reader keeps a missed import from looking green.
    load_manifest(repo)
    raise SystemExit(summary['exit'])


if __name__ == '__main__':
    main()
