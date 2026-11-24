"""Regressions for official point-in-time snapshots. See docs/official-snapshot-rules.md §6.3."""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import timezone
from pathlib import Path

from official_snapshot_clock import (
    LOCK_LEAD_MINUTES,
    MeetingClock,
    card_status_to_snapshot,
    crosscheck_lock_state,
    hkt_hhmm,
    in_freeze_window,
    is_cancelled_meeting,
    meeting_clock,
    parse_instant,
    post_race_decision,
    post_race_earliest,
    resolve_card_status,
    select_meetings,
    utc_iso,
)
from official_snapshot_join import (
    FREEZE_REQUIRED,
    accept_jt_combo,
    blank_cell,
    body_weight_pounds,
    freeze_card_deltas,
    freeze_rejects,
    import_type_code,
    interpret_last10_wins,
    join_conghua,
    join_fwb,
    missing_join_races,
    ove_current_risk,
    penetrometer_reading,
    refuse_live_backfill,
    wind_probes_block_freeze,
)
from official_snapshot_recrawl import assert_staging_isolated, live_wave_dir, staging_wave_dir
from official_snapshot_tick import run
from official_snapshot_writer import (
    OverwriteRefused,
    SnapshotConflict,
    assemble_snapshot,
    emit_d1_sql,
    write_snapshot,
    _write_exclusive,
)


ST_POSTS = ['2026-11-22T12:30:00+08:00', '2026-11-22T18:25:00+08:00']
HV_POSTS = ['2026-11-25T18:40:00+08:00', '2026-11-25T22:50:00+08:00']
FRESH = '2026-11-22T03:05:00.000Z'


def st_clock():
    return meeting_clock('2026-11-22', 'ST', ST_POSTS, [1, 8])


def hv_clock():
    return meeting_clock('2026-11-25', 'HV', ['2026-11-25T18:40:00+08:00'], [1])


def capture_set(captured=FRESH, **overrides):
    base = {}
    for name in FREEZE_REQUIRED:
        if name in ('official_conghua_movement', 'official_jt_combo'):
            base[name] = {'rows': [], 'unpublished': True, 'captured_at': captured}
        else:
            base[name] = {
                'captured_at': captured,
                'rows': [{
                    'meeting_date': '2026-11-22',
                    'venue': 'ST',
                    'race_no': 1,
                    'horse_no': 1,
                    'is_reserve': 0,
                    'brand_no': 'J290',
                    'horse_code': 'J290',
                    'surface': name,
                }],
            }
    base['entries_upcoming'] = {
        'captured_at': captured,
        'rows': [{
            'meeting_date': '2026-11-22',
            'venue': 'ST',
            'race_number': 1,
            'horse_number': 1,
            'is_reserve': 0,
            'horse_code': 'J290',
            'brand_no': 'J290',
            'body_weight': 1151,
            'declared_weight': 132,
            'rating_change': '',
            'body_weight_change': '',
            'best_time': '',
            'days_since_run': '',
            'possible_overweight': '',
            'age_allowance': '',
            'results_declared_weight': 1200,
        }],
    }
    base.update(overrides)
    return base


class ClockTests(unittest.TestCase):
    def test_lead_is_the_existing_lock_window(self):
        self.assertEqual(LOCK_LEAD_MINUTES, 90)

    def test_sha_tin_day_and_happy_valley_night(self):
        day = st_clock()
        self.assertEqual(hkt_hhmm(day.first_post_at), '12:30')
        self.assertEqual(hkt_hhmm(day.lock_at), '11:00')
        self.assertEqual(utc_iso(day.lock_at), '2026-11-22T03:00:00.000Z')
        self.assertEqual(hkt_hhmm(day.last_post_at), '18:25')
        self.assertEqual(hkt_hhmm(post_race_earliest(day)), '18:55')
        night = meeting_clock('2026-11-18', 'HV', ['2026-11-18T18:40:00+08:00', '2026-11-18T22:50:00+08:00'], [1, 9])
        self.assertEqual(hkt_hhmm(night.lock_at), '17:10')
        self.assertEqual(hkt_hhmm(post_race_earliest(night)), '23:20')
        live = hv_clock()
        self.assertEqual(utc_iso(live.lock_at), '2026-11-25T09:10:00.000Z')
        self.assertEqual(live.first_post_text, '2026-11-25T18:40:00+08:00')

    def test_wave_morning_is_not_a_freeze_instant(self):
        clock = st_clock()
        morning = parse_instant('2026-11-22T07:40:00+08:00')
        self.assertEqual(hkt_hhmm(morning), '07:40')
        self.assertFalse(in_freeze_window(morning, clock))
        self.assertTrue(in_freeze_window(parse_instant('2026-11-22T03:05:00Z'), clock))
        self.assertFalse(in_freeze_window(clock.first_post_at, clock))

    def test_cancelled_meeting_and_per_venue_clock(self):
        self.assertTrue(is_cancelled_meeting('2026-09-19'))
        self.assertIsNone(meeting_clock('2026-09-19', 'ST', ['2026-09-19T12:30:00+08:00'], [1]))
        now = parse_instant('2026-11-22T02:00:00Z')
        rows = [
            {'date': '2026-11-22', 'venue': 'ST', 'race_number': 1, 'post_time': '2026-11-22T12:30:00+08:00'},
            {'date': '2026-11-22', 'venue': 'HV', 'race_number': 1, 'post_time': '2026-11-22T18:40:00+08:00'},
            {'date': '2026-09-19', 'venue': 'ST', 'race_number': 1, 'post_time': '2026-09-19T12:30:00+08:00'},
        ]
        found = select_meetings(rows, now)
        self.assertEqual([(item.meeting_date, item.venue) for item in found], [('2026-11-22', 'ST'), ('2026-11-22', 'HV')])
        self.assertNotEqual(found[0].lock_at, found[1].lock_at)

    def test_lock_state_crosscheck_ignores_other_meetings(self):
        clock = hv_clock()
        remote = {
            'date': '2026-11-25',
            'venue': 'HV',
            'firstPostAt': '2026-11-25T18:40:00+08:00',
            'lockAt': '2026-11-25T09:10:00.000Z',
        }
        self.assertEqual(crosscheck_lock_state(clock, remote)['status'], 'match')
        other = dict(remote, venue='ST')
        self.assertEqual(crosscheck_lock_state(clock, other)['status'], 'skipped_other_meeting')
        drifted = dict(remote, lockAt='2026-11-25T09:11:00.000Z')
        self.assertEqual(crosscheck_lock_state(clock, drifted)['status'], 'clock_mismatch')

    def test_card_status_matches_meeting_card(self):
        self.assertEqual(resolve_card_status({'resulted': False, 'hasRaces': False, 'declaredRunners': 0, 'declaredDraws': 0, 'officialEntries': 3}), 'entries')
        self.assertEqual(resolve_card_status({'resulted': True, 'hasRaces': True, 'declaredRunners': 0, 'declaredDraws': 0, 'officialEntries': 0}), 'resulted')
        self.assertEqual(card_status_to_snapshot('entries', {'resulted': False, 'hasRaces': True, 'declaredRunners': 4, 'declaredDraws': 4, 'officialEntries': 0}), 'declared')
        self.assertIsNone(card_status_to_snapshot('declared', {'resulted': True, 'hasRaces': True, 'declaredRunners': 1, 'declaredDraws': 1, 'officialEntries': 0}))
        self.assertEqual(card_status_to_snapshot(None, {'resulted': False, 'hasRaces': False, 'declaredRunners': 0, 'declaredDraws': 0, 'officialEntries': 2}), 'entries')

    def test_post_race_settlement_is_win_pla_two_ticks_and_three_hour_cap(self):
        clock = st_clock()
        runners = [{'venue': 'ST', 'section': 'local', 'race_no': 1, 'placing_text': '1'}]
        runners.append({'venue': 'ST', 'section': 'local', 'race_no': 8, 'placing_text': '1'})
        dividends = []
        for race_no in (1, 8):
            dividends.append({'venue': 'ST', 'section': 'local', 'race_no': race_no, 'pool_name': '獨贏'})
            dividends.append({'venue': 'ST', 'section': 'local', 'race_no': race_no, 'pool_name': '位置'})
        early = parse_instant('2026-11-22T10:40:00Z')
        self.assertEqual(post_race_decision(early, clock, runners, dividends, set(), None, 'h', False).action, 'wait')
        ready = parse_instant('2026-11-22T10:56:00Z')
        first = post_race_decision(ready, clock, runners, dividends, set(), None, 'h', False)
        self.assertEqual(first.action, 'wait')
        second = post_race_decision(ready, clock, runners, dividends, set(), 'h', 'h', False)
        self.assertEqual(second.action, 'capture')
        self.assertEqual(second.completeness, 'complete')
        only_win = [row for row in dividends if row['pool_name'] == '獨贏']
        held = post_race_decision(ready, clock, runners, only_win, set(), 'h', 'h', False)
        self.assertEqual(held.action, 'wait')
        capped = parse_instant('2026-11-22T13:26:00Z')
        partial = post_race_decision(capped, clock, runners, only_win, set(), 'a', 'b', False)
        self.assertEqual(partial.completeness, 'partial')
        self.assertEqual(post_race_decision(capped, clock, runners, dividends, set(), 'h', 'h', True).action, 'noop')
        unknown = MeetingClock(
            '2026-11-22', 'ST', clock.first_post_at, clock.first_post_text, clock.lock_at,
            None, clock.post_times, clock.race_numbers,
        )
        self.assertEqual(post_race_decision(capped, unknown, [], [], set(), None, None, False).action, 'alert')


class JoinTests(unittest.TestCase):
    def test_fwb_brand_first_does_not_rewrite_horse_no(self):
        starters = [
            {'race_no': 8, 'horse_no': 1, 'is_reserve': 0, 'brand_no': 'J290', 'horse_id': 'HK_2023_J290'},
            {'race_no': 8, 'horse_no': 11, 'is_reserve': 0, 'brand_no': 'M021', 'horse_id': 'HK_2026_M021'},
        ]
        fwb = [{'race_no': 8, 'horse_no': 1, 'is_reserve': 1, 'brand_no': 'M021', 'horse_name_ch': '天時威威'}]
        original = dict(fwb[0])
        joined = join_fwb(fwb, starters)
        self.assertEqual(fwb[0], original)
        self.assertEqual(joined[0]['fwb_horse_no'], 1)
        self.assertFalse(joined[0]['horse_no_rewritten'])
        self.assertEqual(joined[0]['starter_horse_no'], 11)
        self.assertEqual(joined[0]['starter_brand'], 'M021')
        self.assertEqual(joined[0]['rejected_same_horse_no'], [{'horse_no': 1, 'brand_no': 'J290'}])
        self.assertNotEqual(joined[0]['starter_brand'], 'J290')

    def test_last10_wins_passed_ove_blank_deltas_and_import_codes(self):
        parsed = interpret_last10_wins({'last10_wins': 19})
        self.assertEqual(parsed['last10Wins'], 19)
        self.assertEqual(parsed['last10_wins'], 19)
        self.assertFalse(parsed['last_10_rides'])
        self.assertFalse(parsed['capped'])
        self.assertFalse(ove_current_risk({'passed_date': '2026-11-03'}))
        self.assertTrue(ove_current_risk({'passed_date': ''}))
        self.assertIsNone(blank_cell(''))
        self.assertIsNone(blank_cell('--'))
        self.assertNotEqual(blank_cell(''), 0)
        deltas = freeze_card_deltas({
            'rating_change': '', 'body_weight': '', 'declared_weight': 132,
        }, results_declared_weight=1200)
        self.assertIsNone(deltas['ratingChange'])
        self.assertIsNone(deltas['bodyWeight'])
        self.assertEqual(deltas['imposedWeight'], 132)
        self.assertNotEqual(deltas['bodyWeight'], 1200)
        self.assertIsNone(body_weight_pounds(132))
        self.assertEqual(body_weight_pounds(1151), 1151)
        self.assertEqual(import_type_code('PPG'), 'PPG')
        self.assertEqual(import_type_code('PP'), 'PP')
        self.assertEqual(import_type_code('ISG'), 'ISG')
        self.assertIsNone(import_type_code('自購馬'))

    def test_conghua_jt_void_penetrometer_and_leakage(self):
        trips = join_conghua(
            [
                {'race_no': 2, 'horse_no': 4, 'is_reserve': 0, 'line_no': 1, 'horse_name_ch': '好馬 (J290)', 'arrived_date': '', 'returned_date': None},
                {'race_no': 2, 'horse_no': 4, 'is_reserve': 0, 'line_no': 2, 'horse_name_ch': '好馬', 'arrived_date': '2026-11-01', 'returned_date': ''},
            ],
            [{'race_no': 2, 'horse_no': 4, 'is_reserve': 0, 'horse_name_ch': '好馬'}],
        )
        self.assertEqual([row['line_no'] for row in trips], [1, 2])
        self.assertTrue(all(row['attached'] for row in trips))
        self.assertTrue(all(row['brand_no'] is None for row in trips))
        self.assertIsNone(trips[0]['arrived_date'])
        combo = accept_jt_combo({'race_no': 1, 'horse_no': 3, 'is_reserve': 0, 'section': 'debut', 'horse_name': '', 'as_of_text': '10/11/2026 12:00'})
        self.assertTrue(combo['name_missing'])
        self.assertEqual(combo['as_of_text'], '10/11/2026 12:00')
        self.assertFalse(combo['join_by_name'])
        self.assertEqual(missing_join_races([1, 6], {1}, {6}), [])
        self.assertEqual(missing_join_races([1, 6], set(), set()), [1, 6])
        self.assertIsNone(penetrometer_reading('--'))
        self.assertFalse(wind_probes_block_freeze(0))
        for name in ('official_results_all_runner', 'official_results_all_dividend', 'live_win_pla_odds', 'official_finish_photo'):
            self.assertTrue(freeze_rejects(name))


class WriterTests(unittest.TestCase):
    def test_freeze_keeps_null_deltas_and_rejects_leakage(self):
        clock = st_clock()
        captures = capture_set()
        captures['official_results_all_runner'] = {'captured_at': FRESH, 'rows': [{'race_no': 1, 'placing_text': '1'}]}
        captures['live_win_pla_odds'] = {'captured_at': FRESH, 'rows': [{'odds': 3}]}
        captures['official_finish_photo'] = {'captured_at': FRESH, 'rows': [{'image_path': 'a.jpg'}]}
        captures['official_wind_probe'] = {'captured_at': FRESH, 'rows': []}
        record = assemble_snapshot(clock, 'freeze', FRESH, captures)
        self.assertEqual(record['completeness'], 'complete')
        present = {item['surface']: item for item in record['surfaces']}
        entry = present['entries_upcoming']['rows'][0]
        self.assertIsNone(entry['rating_change'])
        self.assertEqual(entry['body_weight'], 1151)
        self.assertEqual(entry['declared_weight'], 132)
        self.assertNotIn('results_declared_weight', entry)
        self.assertNotEqual(entry['body_weight'], 1200)
        self.assertEqual(present['official_results_all_runner']['status'], 'excluded_leakage')
        self.assertEqual(present['official_results_all_runner']['rows'], [])
        self.assertEqual(present['live_win_pla_odds']['status'], 'excluded_leakage')
        self.assertEqual(present['official_finish_photo']['rows'], [])
        self.assertFalse(wind_probes_block_freeze(0))
        sql = emit_d1_sql(record)
        self.assertNotIn('UPDATE ', sql.upper())
        self.assertNotIn('DELETE ', sql.upper())
        self.assertIn('INSERT OR IGNORE INTO official_snapshot_manifest', sql)
        self.assertNotIn('INSERT INTO official_ove', sql)
        self.assertNotIn('INSERT INTO entries_upcoming', sql)

    def test_stale_gap_is_not_replaced_by_later_rows(self):
        clock = st_clock()
        stale = '2026-11-22T23:40:00+08:00'
        captures = capture_set()
        captures['official_wind_going'] = {
            'captured_at': stale,
            'rows': [{'meeting_date': '2026-11-22', 'venue': 'ST', 'race_no': 1, 'going_ch': '好地'}],
            'stale_available': {'scraped_at': '2026-11-25T02:41:58+08:00', 'row_count': 9},
        }
        record = assemble_snapshot(clock, 'freeze', FRESH, captures)
        wind = next(item for item in record['surfaces'] if item['surface'] == 'official_wind_going')
        self.assertEqual(wind['status'], 'stale_available')
        self.assertEqual(wind['rows'], [])
        gap = next(item for item in record['gaps'] if item['surface'] == 'official_wind_going')
        self.assertTrue(gap['stale_available']['not_freeze_fresh'])
        self.assertEqual(gap['stale_available']['row_count'], 9)
        later = [{'going_ch': '快地', 'captured_at': '2026-11-22T12:40:00+08:00'}]
        self.assertIs(refuse_live_backfill(gap, later), gap)
        self.assertEqual(record['completeness'], 'partial')

    def test_second_freeze_and_post_race_do_not_change_bytes(self):
        clock = st_clock()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            record = assemble_snapshot(clock, 'freeze', FRESH, capture_set())
            first = write_snapshot(repo, record)
            header = first['header_path']
            raw = header.read_bytes()
            manifest = (repo / 'data' / 'official_snapshots' / 'manifest.jsonl').read_bytes()
            again = write_snapshot(repo, record)
            self.assertEqual(again['status'], 'idempotent')
            self.assertEqual(header.read_bytes(), raw)
            changed_captures = capture_set(captured='2026-11-22T03:20:00.000Z')
            changed_captures['official_horse_rating']['rows'][0]['surface'] = 'changed-after-freeze'
            changed = assemble_snapshot(clock, 'freeze', '2026-11-22T03:20:00.000Z', changed_captures)
            with self.assertRaises(SnapshotConflict):
                write_snapshot(repo, changed)
            self.assertEqual(header.read_bytes(), raw)
            self.assertEqual((repo / 'data' / 'official_snapshots' / 'manifest.jsonl').read_bytes(), manifest)
            post = assemble_snapshot(
                clock, 'post_race', '2026-11-22T11:10:00.000Z',
                {
                    'official_results_all_runner': {'captured_at': '2026-11-22T11:10:00.000Z', 'rows': [{'race_no': 1, 'placing_text': '1', 'venue': 'ST'}]},
                    'official_results_all_dividend': {'captured_at': '2026-11-22T11:10:00.000Z', 'rows': [{'race_no': 1, 'pool_name': '獨贏', 'venue': 'ST'}]},
                },
                completeness='complete',
            )
            written = write_snapshot(repo, post)
            post_bytes = written['header_path'].read_bytes()
            self.assertEqual(write_snapshot(repo, post)['status'], 'idempotent')
            with self.assertRaises(SnapshotConflict):
                write_snapshot(repo, assemble_snapshot(
                    clock, 'post_race', '2026-11-22T12:10:00.000Z',
                    {
                        'official_results_all_runner': {'captured_at': '2026-11-22T12:10:00.000Z', 'rows': [{'race_no': 1, 'placing_text': '2', 'venue': 'ST'}]},
                        'official_results_all_dividend': {'captured_at': '2026-11-22T12:10:00.000Z', 'rows': [{'race_no': 1, 'pool_name': '獨贏', 'venue': 'ST'}]},
                    },
                    completeness='complete',
                ))
            self.assertEqual(written['header_path'].read_bytes(), post_bytes)

    def test_existing_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'freeze.json'
            path.write_text('original\n', encoding='utf-8')
            with self.assertRaises(OverwriteRefused):
                _write_exclusive(path, 'replacement\n')
            self.assertEqual(path.read_text(encoding='utf-8'), 'original\n')

    def test_safety_snapshot_is_not_a_freeze(self):
        clock = st_clock()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            record = assemble_snapshot(clock, 'pre_freeze_safety', '2026-11-22T02:20:00.000Z', capture_set(captured='2026-11-22T02:20:00.000Z'))
            self.assertEqual(record['snapshot_kind'], 'pre_freeze_safety')
            write_snapshot(repo, record)
            names = list((repo / 'data' / 'official_snapshots').rglob('*'))
            self.assertFalse(any(path.name.startswith('freeze_') for path in names))


class TickTests(unittest.TestCase):
    def test_clock_mismatch_and_missed_window_do_not_backfill(self):
        clock = st_clock()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            now = parse_instant(FRESH)
            mismatched = run(
                repo, now, [clock],
                {'date': '2026-11-22', 'venue': 'ST', 'firstPostAt': clock.first_post_text, 'lockAt': '2026-11-22T03:01:00.000Z'},
                {'2026-11-22|ST': capture_set()}, {}, {},
                recrawl=False, kinds={'freeze'}, source_commit=None,
            )
            self.assertEqual(mismatched['exit'], 3)
            self.assertFalse(any(path.name.startswith('freeze_') for path in (repo / 'data').rglob('*') if path.is_file()))
            later = parse_instant('2026-11-22T05:00:00Z')
            payload = capture_set(captured='2026-11-22T05:10:00.000Z')
            payload['official_results_all_runner'] = {'captured_at': '2026-11-22T05:10:00.000Z', 'rows': [{'placing_text': '1'}]}
            missed = run(
                repo, later, [clock], None, {'2026-11-22|ST': payload}, {}, {},
                recrawl=False, kinds={'freeze'}, source_commit=None,
            )
            self.assertEqual(missed['exit'], 4)
            gap_text = (repo / 'data' / 'official_snapshots' / 'gaps.jsonl').read_text(encoding='utf-8')
            self.assertIn('freeze_missed_window', gap_text)
            self.assertIn('clock_mismatch', gap_text)
            self.assertFalse(any(path.name.startswith('freeze_') for path in repo.rglob('*') if path.is_file()))

    def test_partial_freeze_is_not_completed_later(self):
        clock = st_clock()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            now = parse_instant(FRESH)
            captures = capture_set()
            captures['official_wind_going'] = {
                'captured_at': '2026-11-21T23:40:00+00:00',
                'rows': [{'going_ch': '好地'}],
            }
            first = run(
                repo, now, [clock], None, {'2026-11-22|ST': captures}, {}, {},
                recrawl=False, kinds={'freeze'}, source_commit=None,
            )
            self.assertEqual(first['exit'], 2)
            header = next((repo / 'data' / 'official_snapshots').rglob('freeze_*.json'))
            raw = header.read_bytes()
            captures['official_wind_going'] = {'captured_at': FRESH, 'rows': [{'going_ch': '快地'}]}
            second = run(
                repo, parse_instant('2026-11-22T03:10:00Z'), [clock], None, {'2026-11-22|ST': captures}, {}, {},
                recrawl=False, kinds={'freeze'}, source_commit=None,
            )
            self.assertEqual(second['actions'][0]['status'], 'noop')
            self.assertEqual(header.read_bytes(), raw)

    def test_staging_cannot_replace_live_wave_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            assert_staging_isolated(repo)
            for wave in ('official_wave5', 'official_wave6', 'official_wave7', 'official_wave8'):
                self.assertNotEqual(staging_wave_dir(repo, wave).resolve(), live_wave_dir(repo, wave).resolve())

    def test_migration_is_append_only_snapshot_schema(self):
        text = Path(__file__).resolve().parents[1].joinpath('backend/src/db/migrations/20261125_official_snapshots.sql').read_text(encoding='utf-8')
        self.assertIn('CREATE TABLE IF NOT EXISTS official_snapshot_manifest', text)
        self.assertIn("snapshot_kind IN ('freeze', 'post_race', 'card_status', 'pre_freeze_safety')", text)
        self.assertIn('official_snapshot_freeze_once', text)
        self.assertIn('official_snapshot_postrace_once', text)
        self.assertIn('RAISE(ABORT', text)
        self.assertNotIn('ALTER TABLE official_ove', text)
        self.assertNotIn('ALTER TABLE entries_upcoming', text)
        rules = Path(__file__).resolve().parents[1].joinpath('docs/official-snapshot-rules.md').read_text(encoding='utf-8')
        self.assertIn('LOCK_LEAD_MINUTES = 90', rules)
        self.assertIn('does **not** rewrite FWB', rules)


if __name__ == '__main__':
    unittest.main()
