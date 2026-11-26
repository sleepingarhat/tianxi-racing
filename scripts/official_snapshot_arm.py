#!/usr/bin/env python3
"""Hold a snapshot run until the T-90 window, or catch up inside it.

GitHub Actions does not deliver the ten-minute cron this workflow used to
declare. A run that starts before lockAt waits until lockAt + 90 seconds.
A run that starts inside [lockAt, firstPostAt) writes kind=freeze immediately.
A run at or after firstPostAt records freeze_missed_window and does not backfill.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

from official_snapshot_clock import HKT, MeetingClock, in_freeze_window, parse_instant, utc_iso
from official_snapshot_tick import clocks_for, discover
from official_snapshot_writer import existing_snapshot

MAX_ARM_SLEEP_SECONDS = 330 * 60
WAKE_SKEW_SECONDS = 90
CATCH_UP_AFTER_SECONDS = 15 * 60
FAST_CAPTURE_MARGIN_SECONDS = 20 * 60
HEARTBEAT_SECONDS = 15 * 60


def _hkt(moment: datetime) -> str:
    return moment.astimezone(HKT).strftime('%Y-%m-%d %H:%M')


def _blank(now: datetime, **overrides) -> dict:
    plan = {
        'action': 'idle',
        'phase': 'no_pending_freeze',
        'reason': 'no_meeting',
        'meeting': '',
        'meeting_date': '',
        'venue': '',
        'lock_at': '',
        'first_post_at': '',
        'lock_at_hkt': '',
        'first_post_hkt': '',
        'now': utc_iso(now),
        'now_hkt': _hkt(now),
        'wake_at': '',
        'sleep_seconds': 0,
        'slept_seconds': 0,
        'catch_up': False,
        'not_backfilled': False,
        'margin_seconds': 0,
        'fast_capture': False,
        'run_tick': True,
    }
    plan.update(overrides)
    return plan


def _fields(now: datetime, clock: MeetingClock) -> dict:
    current = now.astimezone(timezone.utc)
    margin = int((clock.first_post_at - current).total_seconds())
    return {
        'meeting': f'{clock.meeting_date}|{clock.venue}',
        'meeting_date': clock.meeting_date,
        'venue': clock.venue,
        'lock_at': clock.lock_at_iso(),
        'first_post_at': utc_iso(clock.first_post_at),
        'lock_at_hkt': _hkt(clock.lock_at),
        'first_post_hkt': _hkt(clock.first_post_at),
        'margin_seconds': margin,
    }


def freeze_arm_plan(now: datetime, clocks: list[MeetingClock], frozen: set[tuple[str, str]]) -> dict:
    """Decide whether this run waits, captures kind=freeze, or records a miss.

    `frozen` holds meetings that already have kind=freeze. Those are not
    captured again and are not a reason to wait.
    """
    current = now.astimezone(timezone.utc)
    if not clocks:
        return _blank(current)
    pending = [clock for clock in clocks if (clock.meeting_date, clock.venue) not in frozen]
    if not pending:
        return _blank(current, reason='freeze_already_recorded', phase='freeze_present')

    in_window = [clock for clock in pending if in_freeze_window(current, clock)]
    if in_window:
        clock = min(in_window, key=lambda item: (item.first_post_at, item.venue))
        late = current >= clock.lock_at + timedelta(seconds=CATCH_UP_AFTER_SECONDS)
        margin = int((clock.first_post_at - current).total_seconds())
        return _blank(
            current,
            action='capture_now',
            phase='in_freeze_window',
            reason='catch_up_inside_window' if late else 'inside_window',
            catch_up=late,
            fast_capture=margin < FAST_CAPTURE_MARGIN_SECONDS,
            **_fields(current, clock),
        )

    armable: list[tuple[int, datetime, MeetingClock]] = []
    for clock in pending:
        if current >= clock.lock_at or current >= clock.first_post_at:
            continue
        wake = clock.lock_at + timedelta(seconds=WAKE_SKEW_SECONDS)
        latest = clock.first_post_at - timedelta(seconds=60)
        if wake > latest:
            wake = latest
        if wake <= current or wake >= clock.first_post_at or wake < clock.lock_at:
            continue
        delay = int((wake - current).total_seconds())
        if delay < 1 or delay > MAX_ARM_SLEEP_SECONDS:
            continue
        armable.append((delay, wake, clock))
    if armable:
        delay, wake, clock = min(armable, key=lambda item: (item[0], item[2].venue))
        return _blank(
            current,
            action='sleep',
            phase='before_freeze',
            reason='arm_until_lock',
            wake_at=utc_iso(wake),
            sleep_seconds=delay,
            **_fields(current, clock),
        )

    missed = [clock for clock in pending if current >= clock.first_post_at]
    if missed:
        clock = min(missed, key=lambda item: (item.first_post_at, item.venue))
        return _blank(
            current,
            action='record_gap',
            phase='after_first_post',
            reason='freeze_missed_window',
            not_backfilled=True,
            **_fields(current, clock),
        )
    return _blank(current, reason='beyond_arm_horizon', phase='before_arm_horizon')


def format_plan(plan: dict) -> str:
    meeting = plan.get('meeting') or '-'
    return ' '.join([
        '[official-snapshot]',
        f'meeting={meeting}',
        f"phase={plan.get('phase')}",
        f"action={plan.get('action')}",
        f"reason={plan.get('reason')}",
        f"now={plan.get('now')}",
        f"now_hkt={plan.get('now_hkt') or '-'}",
        f"lockAt={plan.get('lock_at') or '-'}",
        f"lockAt_hkt={plan.get('lock_at_hkt') or '-'}",
        f"firstPostAt={plan.get('first_post_at') or '-'}",
        f"firstPost_hkt={plan.get('first_post_hkt') or '-'}",
        f"wake_at={plan.get('wake_at') or '-'}",
        f"sleep_seconds={int(plan.get('sleep_seconds') or 0)}",
        f"slept_seconds={int(plan.get('slept_seconds') or 0)}",
        f"margin_seconds={int(plan.get('margin_seconds') or 0)}",
        f"catch_up={'true' if plan.get('catch_up') else 'false'}",
        f"not_backfilled={'true' if plan.get('not_backfilled') else 'false'}",
        f"fast_capture={'true' if plan.get('fast_capture') else 'false'}",
    ])


def wait_until_freeze(now_fn, state_fn, sleep_fn, log, *, heartbeat_seconds: int = HEARTBEAT_SECONDS, max_seconds: int = MAX_ARM_SLEEP_SECONDS) -> dict:
    """Sleep in heartbeats until the plan is no longer `sleep`.

    `state_fn()` returns `(clocks, frozen)` and may raise when the meeting
    API is unread. Three unread heartbeats stop the wait. The caller still
    runs the tick, which records a gap instead of inventing a freeze.
    """
    slept = 0
    last_wake: datetime | None = None
    errors = 0
    while True:
        now = now_fn().astimezone(timezone.utc)
        try:
            clocks, frozen = state_fn()
            errors = 0
        except Exception as exc:
            errors += 1
            log(f'[official-snapshot] clock unread during wait: {exc}')
            if last_wake is None or errors >= 3 or now >= last_wake or slept >= max_seconds:
                plan = _blank(now, reason='clock_unread', phase='clock_unread', slept_seconds=slept)
                log(format_plan(plan))
                return plan
            chunk = min(heartbeat_seconds, int((last_wake - now).total_seconds()), max_seconds - slept)
            if chunk < 1:
                plan = _blank(now, reason='clock_unread', phase='clock_unread', slept_seconds=slept)
                log(format_plan(plan))
                return plan
            sleep_fn(chunk)
            slept += chunk
            continue
        plan = freeze_arm_plan(now, clocks, frozen)
        plan['slept_seconds'] = slept
        log(format_plan(plan))
        if plan['action'] != 'sleep':
            return plan
        if slept >= max_seconds:
            stopped = dict(plan)
            stopped['action'] = 'idle'
            stopped['reason'] = 'arm_budget_exhausted'
            stopped['phase'] = 'before_freeze'
            stopped['sleep_seconds'] = 0
            stopped['slept_seconds'] = slept
            log(format_plan(stopped))
            return stopped
        wake = parse_instant(str(plan['wake_at']))
        last_wake = wake
        chunk = min(int(plan['sleep_seconds']), heartbeat_seconds, max_seconds - slept)
        if chunk < 1:
            return plan
        sleep_fn(chunk)
        slept += chunk


def _state(repo, now: datetime):
    posts, _statuses, _voids, _lock = discover(now)
    clocks = clocks_for(posts, now)
    frozen = {
        (clock.meeting_date, clock.venue)
        for clock in clocks
        if existing_snapshot(repo, clock.meeting_date, clock.venue, 'freeze')
    }
    return clocks, frozen


def _emit(plan: dict) -> None:
    path = os.environ.get('GITHUB_OUTPUT')
    if not path:
        return
    fields = {
        'action': plan.get('action') or '',
        'phase': plan.get('phase') or '',
        'reason': plan.get('reason') or '',
        'meeting': plan.get('meeting') or '',
        'lock_at': plan.get('lock_at') or '',
        'first_post_at': plan.get('first_post_at') or '',
        'wake_at': plan.get('wake_at') or '',
        'now': plan.get('now') or '',
        'sleep_seconds': int(plan.get('sleep_seconds') or 0),
        'slept_seconds': int(plan.get('slept_seconds') or 0),
        'margin_seconds': int(plan.get('margin_seconds') or 0),
        'catch_up': 'true' if plan.get('catch_up') else 'false',
        'not_backfilled': 'true' if plan.get('not_backfilled') else 'false',
        'fast_capture': 'true' if plan.get('fast_capture') else 'false',
        'run_tick': 'true',
    }
    with open(path, 'a', encoding='utf-8') as handle:
        for key, value in fields.items():
            text = str(value).replace('\n', ' ')
            handle.write(f'{key}={text}\n')


def _annotate(plan: dict) -> None:
    line = format_plan(plan)
    if plan.get('action') == 'capture_now':
        print(f'::notice::{line}')
    elif plan.get('action') == 'record_gap':
        print(f'::warning::{line}')
    print(line, flush=True)


def main() -> None:
    import argparse
    import time
    from pathlib import Path

    parser = argparse.ArgumentParser(description='Wait until the official freeze window or catch up inside it')
    parser.add_argument('--root', default='.')
    parser.add_argument('--now', default='')
    parser.add_argument('--no-sleep', action='store_true')
    parser.add_argument('--heartbeat-seconds', type=int, default=HEARTBEAT_SECONDS)
    args = parser.parse_args()
    if args.now and not args.no_sleep:
        raise SystemExit('--now is only valid with --no-sleep')
    repo = Path(args.root).resolve()
    trigger = os.environ.get('OFFICIAL_SNAPSHOT_TRIGGER') or '-'
    source = os.environ.get('OFFICIAL_SNAPSHOT_SOURCE') or '-'
    source_url = os.environ.get('OFFICIAL_SNAPSHOT_SOURCE_URL') or '-'
    print(f'[official-snapshot] trigger={trigger} source={source} source_url={source_url}', flush=True)
    fixed = parse_instant(args.now) if args.now else None

    def now_fn() -> datetime:
        if fixed is not None:
            return fixed
        return datetime.now(timezone.utc)

    def state_fn():
        return _state(repo, now_fn())

    if args.no_sleep:
        try:
            clocks, frozen = state_fn()
        except Exception as exc:
            print(f'[official-snapshot] clock unread: {exc}', file=sys.stderr)
            plan = _blank(now_fn(), reason='clock_unread', phase='clock_unread')
        else:
            plan = freeze_arm_plan(now_fn(), clocks, frozen)
        _annotate(plan)
        _emit(plan)
        return

    def log(line: str) -> None:
        print(line, flush=True)

    try:
        plan = wait_until_freeze(
            now_fn, state_fn, time.sleep, log,
            heartbeat_seconds=max(1, args.heartbeat_seconds),
        )
    except Exception as exc:
        print(f'[official-snapshot] arm failed open: {exc}', file=sys.stderr)
        plan = _blank(datetime.now(timezone.utc), reason='clock_unread', phase='clock_unread')
        _annotate(plan)
    else:
        _annotate(plan)
    _emit(plan)


if __name__ == '__main__':
    main()
