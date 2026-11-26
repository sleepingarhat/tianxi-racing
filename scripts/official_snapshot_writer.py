"""Append-only official snapshot files and INSERT OR IGNORE D1 SQL.

A second freeze or post_race for the same meeting is refused. Payload rows for
kind=freeze must be captured inside [lockAt, firstPostAt). Stale live tables
are cited on the gap and are not copied in.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from official_snapshot_clock import MeetingClock, compact_utc, utc_iso
from official_snapshot_join import (
    CARD_SURFACES,
    FREEZE_REQUIRED,
    LEAKAGE,
    NOT_A_FREEZE_FAILURE,
    OPTIONAL_METADATA,
    OPTIONAL_UNPUBLISHED,
    POST_RACE_ONLY,
    blank_cell,
    freeze_card_deltas,
    gap_record,
    leakage_surface,
)

SNAPSHOT_DIR = Path('data') / 'official_snapshots'
ONCE_KINDS = frozenset({'freeze', 'post_race'})


class SnapshotConflict(RuntimeError):
    """An earlier freeze or post_race snapshot already exists."""


class OverwriteRefused(RuntimeError):
    """An existing snapshot file must not be rewritten."""


def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    return value


def dumps(value) -> str:
    return json.dumps(canonical(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def content_sha256(present: dict[str, list[dict]]) -> str:
    body = [{'surface': name, 'rows': present[name]} for name in sorted(present)]
    return sha256_text(dumps(body))


def snapshots_root(repo: Path) -> Path:
    return repo / SNAPSHOT_DIR


def meeting_folder(repo: Path, meeting_date: str, venue: str) -> Path:
    return snapshots_root(repo) / f'{meeting_date}_{venue}'


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def manifest_path(repo: Path) -> Path:
    return snapshots_root(repo) / 'manifest.jsonl'


def gaps_path(repo: Path) -> Path:
    return snapshots_root(repo) / 'gaps.jsonl'


def poll_path(repo: Path) -> Path:
    return snapshots_root(repo) / 'poll.jsonl'


def ticks_path(repo: Path) -> Path:
    return snapshots_root(repo) / 'ticks.jsonl'


def append_tick(repo: Path, record: dict) -> None:
    """Append one freeze-window decision. Idle ticks are not recorded."""
    append_jsonl(ticks_path(repo), record)


def load_manifest(repo: Path) -> list[dict]:
    return read_jsonl(manifest_path(repo))


def existing_snapshot(repo: Path, meeting_date: str, venue: str, kind: str, content_hash: str | None = None) -> dict | None:
    rows = [
        row for row in load_manifest(repo)
        if row.get('meeting_date') == meeting_date
        and row.get('venue') == venue
        and row.get('snapshot_kind') == kind
    ]
    if content_hash is None:
        return rows[-1] if rows else None
    for row in rows:
        if row.get('content_sha256') == content_hash:
            return row
    return None


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    before = path.read_bytes() if path.exists() else b''
    line = dumps(record) + '\n'
    with path.open('a', encoding='utf-8') as handle:
        handle.write(line)
    after = path.read_bytes()
    if not after.startswith(before) or after[len(before):] != line.encode('utf-8'):
        raise OverwriteRefused(f'{path} was rewritten instead of appended')


def append_gap_event(repo: Path, event: dict) -> bool:
    """Append a non-snapshot gap once. Identical meeting+reason is not repeated."""
    path = gaps_path(repo)
    key = (event.get('meeting_date'), event.get('venue'), event.get('reason'), event.get('snapshot_kind'))
    for row in read_jsonl(path):
        if (row.get('meeting_date'), row.get('venue'), row.get('reason'), row.get('snapshot_kind')) == key:
            return False
    append_jsonl(path, event)
    return True


def append_poll(repo: Path, meeting_date: str, venue: str, content_hash: str, captured_at: str) -> None:
    append_jsonl(poll_path(repo), {
        'meeting_date': meeting_date,
        'venue': venue,
        'snapshot_kind': 'post_race_poll',
        'content_sha256': content_hash,
        'captured_at': captured_at,
    })


def last_poll_hash(repo: Path, meeting_date: str, venue: str) -> str | None:
    found = [
        row for row in read_jsonl(poll_path(repo))
        if row.get('meeting_date') == meeting_date and row.get('venue') == venue
    ]
    return None if not found else found[-1].get('content_sha256')


def last_card_status(repo: Path, meeting_date: str, venue: str) -> str | None:
    rows = [
        row for row in load_manifest(repo)
        if row.get('meeting_date') == meeting_date
        and row.get('venue') == venue
        and row.get('snapshot_kind') == 'card_status'
    ]
    return None if not rows else rows[-1].get('card_status')


def _parse_captured(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f'captured_at {value!r} has no offset')
    return parsed.astimezone(timezone.utc)


def _csv_text(rows: list[dict]) -> str:
    keys: list[str] = []
    seen = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                keys.append(key)
    keys.sort()
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(buffer, fieldnames=keys, lineterminator='\n', extrasaction='ignore')
    writer.writeheader()
    for row in rows:
        writer.writerow({key: '' if row.get(key) is None else row.get(key) for key in keys})
    return buffer.getvalue()


def _write_exclusive(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        descriptor = os.open(path, flags, 0o644)
    except FileExistsError as exc:
        raise OverwriteRefused(f'{path} already exists') from exc
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def _identity(row: dict) -> dict:
    def text(*keys: str) -> str | None:
        for key in keys:
            value = row.get(key)
            if value not in (None, ''):
                return str(value)
        return None

    def number(*keys: str) -> int | None:
        raw = text(*keys)
        if raw is None:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    reserve = row.get('is_reserve')
    if reserve in (None, ''):
        reserve_bit = None
    else:
        reserve_bit = 1 if str(reserve) in ('1', 'true', 'True') else 0
    brand = text('brand_no', 'brand')
    return {
        'meeting_date': text('meeting_date', 'race_date', 'as_of_date'),
        'venue': text('venue', 'racecourse'),
        'race_no': number('race_no', 'race_number'),
        'horse_no': number('horse_no', 'horse_number'),
        'is_reserve': reserve_bit,
        'horse_id': text('horse_id'),
        'brand_no': brand,
        'horse_code': text('horse_code') or brand,
    }


def _normalize_entry_rows(rows: list[dict]) -> list[dict]:
    normalized = []
    for row in rows:
        deltas = freeze_card_deltas(row, row.get('results_declared_weight'))
        copied = dict(row)
        copied.pop('results_declared_weight', None)
        for key, value in (
            ('rating_change', deltas['ratingChange']),
            ('body_weight_change', deltas['bodyWeightChange']),
            ('best_time', deltas['bestTime']),
            ('days_since_run', deltas['daysSinceRun']),
            ('possible_overweight', deltas['possibleOverweight']),
            ('age_allowance', deltas['ageAllowance']),
            ('body_weight', deltas['bodyWeight']),
            ('declared_weight', deltas['imposedWeight']),
        ):
            if key in copied or value is not None:
                copied[key] = value
        copied['body_weight'] = deltas['bodyWeight']
        copied['declared_weight'] = deltas['imposedWeight']
        normalized.append(copied)
    return normalized


@dataclass
class SurfaceDecision:
    surface: str
    status: str
    rows: list[dict]
    captured_at: str | None
    source_sha256: str | None
    gap_reason: str | None
    gap: dict | None
    row_count: int


def decide_surface(
    name: str,
    capture: dict | None,
    clock: MeetingClock | None,
    kind: str,
) -> SurfaceDecision:
    """Classify one surface. Freeze payload rows must satisfy lockAt <= captured_at < firstPostAt."""
    if kind == 'freeze' and leakage_surface(name):
        gap = {'surface': name, 'status': 'excluded_leakage', 'reason': 'excluded_leakage'}
        return SurfaceDecision(name, 'excluded_leakage', [], None, None, 'excluded_leakage', gap, 0)
    if kind in ('card_status', 'pre_freeze_safety') and (name in LEAKAGE or name in POST_RACE_ONLY):
        return SurfaceDecision(name, 'excluded_leakage', [], None, None, 'excluded_leakage', None, 0)
    if name in NOT_A_FREEZE_FAILURE and not capture:
        return SurfaceDecision(name, 'present', [], None, None, None, None, 0)
    if capture is None:
        if name in NOT_A_FREEZE_FAILURE:
            return SurfaceDecision(name, 'present', [], None, None, None, None, 0)
        reason = 'not_published' if name in OPTIONAL_UNPUBLISHED else 'recrawl_failed'
        if name in OPTIONAL_METADATA:
            return SurfaceDecision(name, 'gap', [], None, None, 'not_published', None, 0)
        gap = gap_record(name, reason)
        status = 'gap'
        return SurfaceDecision(name, status, [], None, None, reason, gap, 0)
    unpublished = bool(capture.get('unpublished'))
    fetch_error = capture.get('error')
    rows = list(capture.get('rows') or [])
    if name == 'entries_upcoming':
        rows = _normalize_entry_rows(rows)
    captured_at = capture.get('captured_at')
    source_sha = capture.get('source_sha256')
    stale = capture.get('stale_available')
    if name in NOT_A_FREEZE_FAILURE:
        return SurfaceDecision(name, 'present', [], captured_at, source_sha, None, None, len(rows))
    required_now = set(FREEZE_REQUIRED) if kind != 'post_race' else {
        'official_results_all_runner', 'official_results_all_dividend',
    }
    if not rows and not fetch_error and (unpublished or name in OPTIONAL_UNPUBLISHED):
        gap = gap_record(name, 'not_published')
        return SurfaceDecision(name, 'gap', [], None, source_sha, 'not_published', gap, 0)
    if fetch_error or (not rows and name in required_now):
        gap = gap_record(name, 'recrawl_failed', stale if isinstance(stale, dict) else None)
        if isinstance(stale, dict):
            gap['reason'] = 'recrawl_failed'
        return SurfaceDecision(name, 'gap', [], None, source_sha, 'recrawl_failed', gap, 0)
    if kind == 'freeze':
        moment = _parse_captured(captured_at)
        if moment is None or clock is None or moment < clock.lock_at or moment >= clock.first_post_at:
            citation = stale if isinstance(stale, dict) else {
                'scraped_at': captured_at,
                'row_count': len(rows),
            }
            gap = gap_record(name, 'stale_only', citation)
            return SurfaceDecision(name, 'stale_available', [], None, source_sha, 'stale_only', gap, len(rows))
    kept = []
    for row in rows:
        copied = {key: blank_cell(value) if isinstance(value, str) else value for key, value in row.items()}
        if name == 'official_wind_probe':
            copied['reading'] = blank_cell(copied.get('reading'))
        kept.append(copied)
    digest = source_sha or sha256_text(dumps(kept))
    return SurfaceDecision(name, 'present', kept, captured_at, digest, None, None, len(kept))


def _required_names(kind: str) -> tuple[str, ...]:
    if kind == 'post_race':
        return ('official_results_all_runner', 'official_results_all_dividend')
    if kind == 'freeze':
        return FREEZE_REQUIRED
    return CARD_SURFACES


def _counts_as_failure(decision: SurfaceDecision, kind: str) -> bool:
    if kind != 'freeze':
        return False
    if decision.status == 'excluded_leakage':
        return False
    if decision.surface in OPTIONAL_UNPUBLISHED and decision.gap_reason == 'not_published':
        return False
    if decision.surface in NOT_A_FREEZE_FAILURE or decision.surface in OPTIONAL_METADATA:
        return False
    return decision.status != 'present'


def assemble_snapshot(
    clock: MeetingClock,
    kind: str,
    captured_at: str,
    captures: dict[str, dict],
    *,
    card_status: str | None = None,
    lock_crosscheck: dict | None = None,
    extra_gaps: list[dict] | None = None,
    completeness: str | None = None,
    source_commit: str | None = None,
) -> dict:
    names = list(_required_names(kind))
    for name in captures:
        if name not in names:
            names.append(name)
    decisions = [decide_surface(name, captures.get(name), clock, kind) for name in names]
    # Wind probe emptiness is success even when the caller omitted it.
    if kind == 'freeze' and not any(item.surface == 'official_wind_probe' for item in decisions):
        decisions.append(decide_surface('official_wind_probe', None, clock, kind))
    present = {item.surface: item.rows for item in decisions if item.status == 'present' and item.rows}
    digest = content_sha256(present)
    gaps = [item.gap for item in decisions if item.gap and item.surface not in NOT_A_FREEZE_FAILURE]
    gaps.extend(extra_gaps or [])
    failed = any(_counts_as_failure(item, kind) for item in decisions) or any(
        gap.get('status') == 'gap' and gap.get('reason') not in ('not_published',) for gap in (extra_gaps or [])
    )
    if completeness is None:
        if kind == 'freeze':
            completeness = 'partial' if failed else 'complete'
        elif kind == 'post_race':
            completeness = 'partial' if extra_gaps else 'complete'
        else:
            completeness = 'partial' if any(item.status == 'gap' and item.gap_reason == 'recrawl_failed' for item in decisions) else 'complete'
    header_body = {
        'meeting_date': clock.meeting_date,
        'venue': clock.venue,
        'snapshot_kind': kind,
        'card_status': card_status,
        'first_post_at': clock.first_post_text,
        'lock_at': clock.lock_at_iso(),
        'last_post_at': None if clock.last_post_at is None else utc_iso(clock.last_post_at),
        'captured_at': captured_at,
        'content_sha256': digest,
        'completeness': completeness,
        'gaps': gaps,
        'lock_crosscheck': lock_crosscheck,
        'source_commit': source_commit,
    }
    snapshot_id = sha256_text(dumps(header_body))
    surfaces = []
    for item in decisions:
        if item.surface in NOT_A_FREEZE_FAILURE and item.status == 'present' and not item.rows and item.captured_at is None and name_omitted(item, captures):
            continue
        surfaces.append({
            'surface': item.surface,
            'row_count': 0 if item.status != 'present' else item.row_count,
            'captured_at': item.captured_at if item.status == 'present' and item.rows else None,
            'source_sha256': item.source_sha256 if item.status == 'present' and item.rows else None,
            'status': item.status if item.rows or item.status != 'present' else 'present',
            'gap_reason': item.gap_reason,
            'rows': item.rows if item.status == 'present' else [],
        })
    record = {
        'snapshot_id': snapshot_id,
        **header_body,
        'created_at': captured_at,
        'surfaces': surfaces,
    }
    return record


def name_omitted(item: SurfaceDecision, captures: dict) -> bool:
    return item.surface not in captures


def _folder_name(kind: str, captured_at: str, card_status: str | None) -> str:
    stamp = compact_utc(_parse_captured(captured_at))
    if kind == 'card_status':
        return f'card_status_{card_status}_{stamp}'
    return f'{kind}_{stamp}'


def _guard_once(repo: Path, record: dict) -> dict | None:
    kind = record['snapshot_kind']
    existing_rows = [
        row for row in load_manifest(repo)
        if row.get('meeting_date') == record['meeting_date']
        and row.get('venue') == record['venue']
        and row.get('snapshot_kind') == kind
    ]
    if kind in ONCE_KINDS and existing_rows:
        current = existing_rows[0]
        if current.get('content_sha256') == record['content_sha256']:
            return current
        raise SnapshotConflict(
            f"{kind} snapshot already exists for {record['meeting_date']} {record['venue']}"
        )
    for row in existing_rows:
        if row.get('content_sha256') == record['content_sha256']:
            return row
    return None


def write_snapshot(repo: Path, record: dict) -> dict:
    """Write a new snapshot. Same content is a no-op. A different once-only snapshot aborts."""
    prior = _guard_once(repo, record)
    if prior is not None:
        return {'status': 'idempotent', 'snapshot_id': prior.get('snapshot_id'), 'record': prior}
    folder = meeting_folder(repo, record['meeting_date'], record['venue'])
    stem = _folder_name(record['snapshot_kind'], record['captured_at'], record.get('card_status'))
    header_path = folder / f'{stem}.json'
    body_dir = folder / stem
    surfaces_out = []
    files: list[tuple[Path, str]] = []
    for surface in record['surfaces']:
        rel = None
        if surface['status'] == 'present' and surface['rows']:
            rel = f"{record['meeting_date']}_{record['venue']}/{stem}/{surface['surface']}.csv"
            files.append((body_dir / f"{surface['surface']}.csv", _csv_text(surface['rows'])))
        surfaces_out.append({
            'surface': surface['surface'],
            'row_count': surface['row_count'] if surface['status'] == 'present' else 0,
            'captured_at': surface['captured_at'],
            'source_sha256': surface['source_sha256'],
            'status': surface['status'],
            'gap_reason': surface['gap_reason'],
            'repo_path': None if rel is None else f'data/official_snapshots/{rel}',
        })
    stored = {key: value for key, value in record.items() if key != 'surfaces'}
    stored['surfaces'] = surfaces_out
    header_text = json.dumps(stored, ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    files.append((header_path, header_text))
    written = []
    try:
        for path, text in files:
            _write_exclusive(path, text)
            written.append(path)
        append_jsonl(manifest_path(repo), stored)
    except Exception:
        for path in written:
            if path.exists():
                path.unlink()
        raise
    return {'status': 'written', 'snapshot_id': record['snapshot_id'], 'record': stored, 'header_path': header_path}


def sql_literal(value) -> str:
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        raise OverwriteRefused('refusing boolean SQL value')
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def emit_d1_sql(record: dict) -> str:
    """INSERT OR IGNORE only. Live Wave tables are not mentioned."""
    lines = ['-- official snapshot append; INSERT OR IGNORE only']
    manifest_cols = [
        'snapshot_id', 'meeting_date', 'venue', 'snapshot_kind', 'card_status',
        'first_post_at', 'lock_at', 'last_post_at', 'captured_at', 'content_sha256',
        'completeness', 'gaps_json', 'lock_crosscheck_json', 'source_commit', 'created_at',
    ]
    manifest_vals = [
        record['snapshot_id'], record['meeting_date'], record['venue'], record['snapshot_kind'],
        record.get('card_status'), record.get('first_post_at'), record.get('lock_at'),
        record.get('last_post_at'), record['captured_at'], record['content_sha256'],
        record['completeness'], dumps(record.get('gaps') or []),
        None if record.get('lock_crosscheck') is None else dumps(record.get('lock_crosscheck')),
        record.get('source_commit'), record.get('created_at') or record['captured_at'],
    ]
    lines.append(
        'INSERT OR IGNORE INTO official_snapshot_manifest ('
        + ', '.join(manifest_cols)
        + ') VALUES ('
        + ', '.join(sql_literal(value) for value in manifest_vals)
        + ');'
    )
    for surface in record['surfaces']:
        lines.append(
            'INSERT OR IGNORE INTO official_snapshot_surface ('
            'snapshot_id, surface, row_count, captured_at, source_sha256, status, gap_reason, repo_path'
            ') VALUES ('
            + ', '.join(sql_literal(value) for value in (
                record['snapshot_id'], surface['surface'], int(surface['row_count']),
                surface.get('captured_at'), surface.get('source_sha256'), surface['status'],
                surface.get('gap_reason'), surface.get('repo_path'),
            ))
            + ');'
        )
        for index, row in enumerate(surface.get('rows') or [], start=1):
            ident = _identity(row)
            lines.append(
                'INSERT OR IGNORE INTO official_snapshot_row ('
                'snapshot_id, surface, row_no, meeting_date, venue, race_no, horse_no, '
                'is_reserve, horse_id, brand_no, horse_code, payload_json'
                ') VALUES ('
                + ', '.join(sql_literal(value) for value in (
                    record['snapshot_id'], surface['surface'], index,
                    ident['meeting_date'], ident['venue'], ident['race_no'], ident['horse_no'],
                    ident['is_reserve'], ident['horse_id'], ident['brand_no'], ident['horse_code'],
                    dumps(row),
                ))
                + ');'
            )
    sql = '\n'.join(lines) + '\n'
    forbidden = ('UPDATE ', 'DELETE ', 'INSERT INTO official_ove', 'INSERT INTO official_fwb', 'INSERT INTO entries_upcoming')
    upper = sql.upper()
    if 'UPDATE ' in upper or 'DELETE ' in upper:
        raise OverwriteRefused('snapshot SQL tried to update or delete')
    for token in forbidden[2:]:
        if token in sql:
            raise OverwriteRefused(f'snapshot SQL targeted a live table via {token}')
    return sql


def write_sql_chunks(sql_text: str, directory: Path, size: int = 200) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    parts = [part.strip() for part in sql_text.split(';\n') if part.strip() and not part.strip().startswith('--')]
    paths = []
    for index in range(0, len(parts), size):
        chunk = ';\n'.join(parts[index:index + size]) + ';\n'
        path = directory / f'{index:05d}.sql'
        path.write_text(chunk, encoding='utf-8')
        paths.append(path)
    return paths


def emit_sql_for_manifest(repo: Path) -> str:
    """Rebuild INSERT OR IGNORE statements from the append-only manifest and CSVs."""
    blocks = []
    for record in load_manifest(repo):
        hydrated = dict(record)
        surfaces = []
        for surface in record.get('surfaces') or []:
            item = dict(surface)
            item['rows'] = []
            repo_path = surface.get('repo_path')
            if repo_path and surface.get('status') == 'present':
                path = repo / repo_path
                if path.exists():
                    with path.open(encoding='utf-8', newline='') as handle:
                        item['rows'] = [dict(row) for row in csv.DictReader(handle)]
            surfaces.append(item)
        hydrated['surfaces'] = surfaces
        blocks.append(emit_d1_sql(hydrated))
    return ''.join(blocks)
