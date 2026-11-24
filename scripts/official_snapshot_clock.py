"""T-90 official snapshot clock.

The freeze instant is the same rule as backend/src/lib/lock-window.ts:
LOCK_LEAD_MINUTES = 90, firstPostAt = MIN(entries_upcoming.post_time),
lockAt = firstPostAt - 90 minutes. Comparisons are instants, never ISO text.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

LOCK_LEAD_MINUTES = 90
LOCK_TICK_WINDOW_HOURS = 8
PRE_FREEZE_SAFETY_MINUTES = 45
POST_RACE_AFTER_LAST_MINUTES = 30
POST_RACE_CAP_HOURS = 3
CANCELLED_MEETING_DATES = frozenset({'2026-09-19'})
HKT = timezone(timedelta(hours=8))
VENUES = frozenset({'ST', 'HV'})
KINDS = frozenset({'freeze', 'post_race', 'card_status', 'pre_freeze_safety'})
HHMM = re.compile(r'^(?:[01]\d|2[0-3]):[0-5]\d$')
WIN_POOLS = frozenset({'WIN', '獨贏'})
PLA_POOLS = frozenset({'PLA', '位置'})


def parse_instant(value: str) -> datetime:
    text = str(value).strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f'timestamp {value!r} has no offset')
    return parsed.astimezone(timezone.utc)


def utc_iso(moment: datetime) -> str:
    utc = moment.astimezone(timezone.utc).replace(microsecond=0)
    return utc.strftime('%Y-%m-%dT%H:%M:%S.000Z')


def hkt_hhmm(moment: datetime) -> str:
    return moment.astimezone(HKT).strftime('%H:%M')


def compact_utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def is_cancelled_meeting(date: str | None) -> bool:
    return bool(date) and date in CANCELLED_MEETING_DATES


def post_time_from_start(meeting_date: str, start_hhmm: str) -> str:
    """Rebuild the entries_upcoming post_time instant from a meetings startTime."""
    if not HHMM.fullmatch(start_hhmm or ''):
        raise ValueError(f'startTime {start_hhmm!r} is not HH:MM')
    return f'{meeting_date}T{start_hhmm}:00+08:00'


@dataclass(frozen=True)
class MeetingClock:
    meeting_date: str
    venue: str
    first_post_at: datetime
    first_post_text: str
    lock_at: datetime
    last_post_at: datetime | None
    post_times: tuple[str, ...]
    race_numbers: tuple[int, ...]

    def lock_at_iso(self) -> str:
        return utc_iso(self.lock_at)

    def first_post_iso(self) -> str:
        return self.first_post_text

    def last_post_iso(self) -> str | None:
        if self.last_post_at is None:
            return None
        return utc_iso(self.last_post_at)


def meeting_clock(
    meeting_date: str,
    venue: str,
    post_times: list[str],
    race_numbers: list[int] | None = None,
) -> MeetingClock | None:
    if is_cancelled_meeting(meeting_date) or venue not in VENUES:
        return None
    parsed: list[tuple[datetime, str]] = []
    for text in post_times:
        if not text:
            continue
        parsed.append((parse_instant(text), text))
    if not parsed:
        return None
    first_dt, first_text = min(parsed, key=lambda item: item[0])
    last_dt = max(item[0] for item in parsed)
    numbers = tuple(sorted({int(n) for n in (race_numbers or []) if int(n) > 0}))
    return MeetingClock(
        meeting_date=meeting_date,
        venue=venue,
        first_post_at=first_dt,
        first_post_text=first_text,
        lock_at=first_dt - timedelta(minutes=LOCK_LEAD_MINUTES),
        last_post_at=last_dt,
        post_times=tuple(text for _, text in sorted(parsed, key=lambda item: item[0])),
        race_numbers=numbers,
    )


def select_meetings(rows: list[dict], now: datetime) -> list[MeetingClock]:
    """Meetings whose true first post is in the future or within the last 8 hours.

    Same qualification as selectMeetingForLockTick. Every (date, venue) is kept
    so two venues on one date do not share a lockAt. Earliest first post first.
    """
    grouped: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        date = row.get('date') or row.get('race_date') or row.get('meeting_date')
        venue = row.get('venue')
        post = row.get('post_time')
        if not date or venue not in VENUES or not post or is_cancelled_meeting(str(date)):
            continue
        grouped.setdefault((str(date), str(venue)), []).append(row)
    cutoff = now.astimezone(timezone.utc) - timedelta(hours=LOCK_TICK_WINDOW_HOURS)
    found: list[MeetingClock] = []
    for (date, venue), items in grouped.items():
        numbers = []
        for item in items:
            raw = item.get('race_number', item.get('race_no'))
            if raw is None or raw == '':
                continue
            numbers.append(int(raw))
        clock = meeting_clock(date, venue, [str(item['post_time']) for item in items], numbers)
        if clock is None or clock.first_post_at < cutoff:
            continue
        found.append(clock)
    found.sort(key=lambda clock: (clock.first_post_at, clock.venue))
    return found


def in_freeze_window(now: datetime, clock: MeetingClock) -> bool:
    current = now.astimezone(timezone.utc)
    return clock.lock_at <= current < clock.first_post_at


def in_pre_freeze_window(now: datetime, clock: MeetingClock) -> bool:
    current = now.astimezone(timezone.utc)
    start = clock.lock_at - timedelta(minutes=PRE_FREEZE_SAFETY_MINUTES)
    return start <= current < clock.lock_at


def freeze_missed(now: datetime, clock: MeetingClock, freeze_exists: bool) -> bool:
    return now.astimezone(timezone.utc) >= clock.first_post_at and not freeze_exists


def post_race_earliest(clock: MeetingClock) -> datetime | None:
    if clock.last_post_at is None:
        return None
    return clock.last_post_at + timedelta(minutes=POST_RACE_AFTER_LAST_MINUTES)


def post_race_cap(clock: MeetingClock) -> datetime | None:
    if clock.last_post_at is None:
        return None
    return clock.last_post_at + timedelta(hours=POST_RACE_CAP_HOURS)


def is_freeze_instant(now: datetime, clock: MeetingClock) -> bool:
    """True only inside [lockAt, firstPostAt). 07:40 HKT is not a freeze instant."""
    return in_freeze_window(now, clock)


def crosscheck_lock_state(clock: MeetingClock, remote: dict | None) -> dict:
    """Compare local clock to GET /api/analyze/lock-state.

    That route ignores date and venue filters and returns the current lock-tick
    meeting only. A different meeting is not a mismatch.
    """
    if not remote:
        return {'status': 'unavailable'}
    if remote.get('date') != clock.meeting_date or remote.get('venue') != clock.venue:
        return {
            'status': 'skipped_other_meeting',
            'remoteDate': remote.get('date'),
            'remoteVenue': remote.get('venue'),
        }
    mismatches = []
    remote_first = remote.get('firstPostAt')
    remote_lock = remote.get('lockAt')
    try:
        if not remote_first or parse_instant(str(remote_first)) != clock.first_post_at:
            mismatches.append('firstPostAt')
    except ValueError:
        mismatches.append('firstPostAt')
    try:
        if not remote_lock or parse_instant(str(remote_lock)) != clock.lock_at:
            mismatches.append('lockAt')
    except ValueError:
        mismatches.append('lockAt')
    payload = {
        'local': {'firstPostAt': clock.first_post_text, 'lockAt': clock.lock_at_iso()},
        'remote': {'firstPostAt': remote_first, 'lockAt': remote_lock},
    }
    if mismatches:
        return {'status': 'clock_mismatch', 'fields': mismatches, **payload}
    return {'status': 'match', **payload}


def resolve_card_status(signals: dict) -> str:
    """Same branches as backend/src/lib/meeting-card.ts resolveCardStatus."""
    if signals.get('resulted'):
        return 'resulted'
    if signals.get('hasRaces') or int(signals.get('declaredRunners') or 0) > 0:
        return 'declared'
    if int(signals.get('officialEntries') or 0) > 0:
        return 'entries'
    return 'fixture'


def card_status_to_snapshot(previous: str | None, signals: dict) -> str | None:
    """Snapshot entries and declared transitions. Resulted belongs to post_race."""
    current = resolve_card_status(signals)
    if current == 'resulted' or current == previous:
        return None
    if current in ('entries', 'declared'):
        return current
    return None


def _pools_by_race(dividends: list[dict], venue: str) -> dict[int, set[str]]:
    found: dict[int, set[str]] = {}
    for row in dividends:
        if row.get('venue') not in (None, '', venue):
            continue
        if row.get('section') not in (None, '', 'local'):
            continue
        race_no = int(row['race_no'])
        pool = str(row.get('pool_name') or row.get('pool') or '').strip()
        if pool:
            found.setdefault(race_no, set()).add(pool)
    return found


def _finished_races(runners: list[dict], venue: str) -> set[int]:
    finished = set()
    for row in runners:
        if row.get('venue') not in (None, '', venue):
            continue
        if row.get('section') not in (None, '', 'local'):
            continue
        placing = str(row.get('placing_text') or row.get('placing') or '').strip()
        if placing:
            finished.add(int(row['race_no']))
    return finished


@dataclass(frozen=True)
class PostRaceDecision:
    action: str
    completeness: str | None
    gaps: tuple[dict, ...]
    reason: str


def post_race_decision(
    now: datetime,
    clock: MeetingClock,
    runners: list[dict],
    dividends: list[dict],
    void_races: set[int],
    previous_hash: str | None,
    current_hash: str | None,
    already_exists: bool,
) -> PostRaceDecision:
    """WIN+PLA, two identical poll hashes, and a 3-hour cap. Unknown timing does not settle."""
    if already_exists:
        return PostRaceDecision('noop', None, (), 'already_snapshotted')
    if clock.last_post_at is None:
        return PostRaceDecision('alert', None, (), 'unknown_timing')
    current = now.astimezone(timezone.utc)
    earliest = post_race_earliest(clock)
    cap = post_race_cap(clock)
    assert earliest is not None and cap is not None
    if current < earliest:
        return PostRaceDecision('wait', None, (), 'before_last_plus_30')
    gaps: list[dict] = []
    finished = _finished_races(runners, clock.venue)
    pools = _pools_by_race(dividends, clock.venue)
    scheduled = clock.race_numbers or tuple(sorted(finished | set(pools) | set(void_races)))
    for race_no in scheduled:
        if race_no in void_races:
            continue
        if race_no not in finished:
            gaps.append({
                'surface': 'official_results_all_runner',
                'status': 'gap',
                'reason': 'not_published',
                'race_no': race_no,
            })
        race_pools = pools.get(race_no, set())
        if not (race_pools & WIN_POOLS) or not (race_pools & PLA_POOLS):
            gaps.append({
                'surface': 'official_results_all_dividend',
                'status': 'gap',
                'reason': 'not_published',
                'race_no': race_no,
                'missing': 'WIN+PLA',
            })
    stable = previous_hash is not None and current_hash is not None and previous_hash == current_hash
    if current < cap and (gaps or not stable):
        return PostRaceDecision('wait', None, tuple(gaps), 'unstable' if not stable else 'unsettled')
    if gaps or not stable:
        reason = 'cap' if not stable else 'partial_at_cap'
        return PostRaceDecision('capture', 'partial', tuple(gaps), reason)
    return PostRaceDecision('capture', 'complete', (), 'settled')


def labelled_void_races(scheduled: list[int], runners: list[dict], dividends: list[dict], explicit: set[int]) -> set[int]:
    """A race is void only when labelled, or when it has refund lines and no finishers.

    Absence of results alone is not a void label.
    """
    void = set(explicit)
    finished = {int(row['race_no']) for row in runners if str(row.get('placing_text') or row.get('placing') or '').strip()}
    by_race: dict[int, list[dict]] = {}
    for row in dividends:
        by_race.setdefault(int(row['race_no']), []).append(row)
    for race_no in scheduled:
        if race_no in finished or race_no in void:
            continue
        texts = []
        for row in by_race.get(race_no, []):
            texts.append(str(row.get('dividend_text') or ''))
            texts.append(str(row.get('combination') or ''))
            texts.append(str(row.get('pool_name') or ''))
        blob = ' '.join(texts)
        if '退款' in blob or '取消' in blob or '無效' in blob:
            void.add(race_no)
    return void
