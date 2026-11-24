"""Recrawl official surfaces into a staging root.

Existing Wave parse and collect functions are called with a staging root so
data/official_waveN is not replaced. Snapshot SQL never calls Wave emit_sql
(those statements DELETE live tables). Leakage surfaces are not requested.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

LIVE_WAVES = ('official_wave5', 'official_wave6', 'official_wave7', 'official_wave8')


def staging_root(repo: Path) -> Path:
    return repo / 'data' / 'official_snapshots' / '_staging' / 'root'


def live_wave_dir(repo: Path, wave: str) -> Path:
    if wave not in LIVE_WAVES:
        raise ValueError(f'{wave} is not a live wave directory')
    return repo / 'data' / wave


def staging_wave_dir(repo: Path, wave: str) -> Path:
    path = staging_root(repo) / 'data' / wave
    live = live_wave_dir(repo, wave).resolve()
    if path.resolve() == live:
        raise RuntimeError(f'staging path collided with live {wave}')
    return path


def assert_staging_isolated(repo: Path) -> None:
    root = staging_root(repo).resolve()
    marker = (repo / 'data' / 'official_snapshots' / '_staging').resolve()
    if marker not in root.parents and root != marker:
        raise RuntimeError('staging root escaped official_snapshots/_staging')
    for wave in LIVE_WAVES:
        if staging_wave_dir(repo, wave).resolve() == live_wave_dir(repo, wave).resolve():
            raise RuntimeError(f'{wave} staging is the live directory')


def prepare_staging(repo: Path) -> Path:
    """Empty the staging root and link the fixture inputs Wave parsers already read."""
    import shutil
    assert_staging_isolated(repo)
    root = staging_root(repo)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    fixtures = repo / 'data' / 'fixtures'
    if fixtures.exists():
        destination = root / 'data' / 'fixtures'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(fixtures.resolve(), target_is_directory=True)
    horses = repo / 'horses'
    if horses.exists():
        (root / 'horses').symlink_to(horses.resolve(), target_is_directory=True)
    return root


def _module(name: str):
    scripts = Path(__file__).resolve().parent
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    return importlib.import_module(name)


def _capture(rows: list[dict], captured_at: str | None, digest: str | None = None, error: str | None = None, unpublished: bool = False) -> dict:
    return {
        'rows': rows,
        'captured_at': captured_at,
        'source_sha256': digest,
        'error': error,
        'unpublished': unpublished,
    }


def _stamp(rows: list[dict]) -> str | None:
    for row in rows:
        if row.get('scraped_at'):
            return str(row['scraped_at'])
    return None


def _read_csv(path: Path, columns: list[str]) -> list[dict]:
    if not path.exists():
        return []
    import csv
    with path.open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != columns:
            raise RuntimeError(f'{path.name} columns changed')
        return [dict(row) for row in reader]


def _meeting_rows(rows: list[dict], meeting_date: str, venue: str) -> list[dict]:
    kept = []
    for row in rows:
        date = row.get('meeting_date') or row.get('race_date')
        row_venue = row.get('venue') or row.get('racecourse')
        if date and date != meeting_date:
            continue
        if row_venue and row_venue != venue:
            continue
        kept.append(row)
    return kept


def cite_live_csv(repo: Path, wave: str, filename: str, columns: list[str], meeting_date: str | None = None, venue: str | None = None) -> dict | None:
    """Citation only. The rows are not returned for a freeze payload."""
    path = live_wave_dir(repo, wave) / filename
    if not path.exists():
        return None
    try:
        rows = _read_csv(path, columns)
    except Exception:
        return None
    if meeting_date and venue:
        rows = _meeting_rows(rows, meeting_date, venue)
    if not rows:
        return None
    return {
        'scraped_at': _stamp(rows),
        'row_count': len(rows),
        'not_freeze_fresh': True,
    }


def recrawl_meeting(repo: Path, meeting_date: str, venue: str, groups: set[str]) -> dict[str, dict]:
    """Recrawl the requested groups. Failures become gap captures, not live-table fills."""
    root = prepare_staging(repo)
    captures: dict[str, dict] = {}
    if 'wave5' in groups:
        captures.update(_wave5(root, meeting_date, venue))
    if 'wave6' in groups:
        captures.update(_wave6(root, meeting_date, venue))
    if 'racecard' in groups:
        captures.update(_racecard(root, meeting_date, venue))
    if 'ratings' in groups:
        captures.update(_ratings())
    if 'directory' in groups or 'persons' in groups:
        captures.update(_directory_persons(root, 'directory' in groups, 'persons' in groups))
    if 'same-sire' in groups:
        captures.update(_same_sire(root))
    if 'wind' in groups:
        captures.update(_wind(meeting_date, venue))
    if 'results' in groups:
        captures.update(_results(meeting_date, venue))
    if 'entries' in groups:
        captures['entries_upcoming'] = _entries(repo, meeting_date, venue)
    return captures


def _guard(label: str):
    def wrap(exc: Exception) -> dict:
        name = type(exc).__name__
        unpublished = name == 'BoardPending'
        return _capture([], None, error=None if unpublished else f'{label}: {exc}', unpublished=unpublished)
    return wrap


def _wave5(root: Path, meeting_date: str, venue: str) -> dict[str, dict]:
    module = _module('hkjc_wave5_visible')
    out = {}
    mapping = {
        'ove-database': ('official_ove_database', 'ove_database'),
        'ove-record': ('official_ove_record', 'ove_record'),
        'ppo': ('official_ppo_performance', 'ppo_performance'),
        'jtcombo': ('official_jt_combo', 'jt_combo'),
        'conghua': ('official_conghua_movement', 'conghua_movement'),
    }
    for flag, (surface, table) in mapping.items():
        try:
            module.collect(root, {flag})
            filename, columns = module.FILES[table]
            rows = _read_csv(module.data_dir(root) / filename, columns)
            if table != 'ove_database' and table != 'ppo_performance':
                rows = _meeting_rows(rows, meeting_date, venue)
            unpublished = flag in ('jtcombo', 'conghua') and not rows
            # Completion time, not the parser's start stamp: a crawl that began
            # before lockAt is usable only when it finishes inside the window.
            out[surface] = _capture(rows, module.scraped_now(), unpublished=unpublished)
        except Exception as exc:
            out[surface] = _guard(surface)(exc)
    return out


def _wave6(root: Path, meeting_date: str, venue: str) -> dict[str, dict]:
    module = _module('hkjc_wave6_surfaces')
    try:
        module.collect(root, {'fwb'})
        filename, columns = module.FILES['fwb_declared']
        rows = _meeting_rows(_read_csv(module.data_dir(root) / filename, columns), meeting_date, venue)
        return {'official_fwb_declared': _capture(rows, module.scraped_now())}
    except Exception as exc:
        return {'official_fwb_declared': _guard('official_fwb_declared')(exc)}


def _racecard(root: Path, meeting_date: str, venue: str) -> dict[str, dict]:
    module = _module('hkjc_wave7_surfaces')
    try:
        module.collect(root, {'racecard'})
        filename, columns = module.FILES['racecard_runner']
        rows = _meeting_rows(_read_csv(module.data_dir(root) / filename, columns), meeting_date, venue)
        unpublished = not rows
        return {'official_racecard_runner': _capture(rows, module.scraped_now(), unpublished=unpublished)}
    except Exception as exc:
        return {'official_racecard_runner': _guard('official_racecard_runner')(exc)}


def _ratings() -> dict[str, dict]:
    module = _module('hkjc_wave7_surfaces')
    try:
        scraped = module.scraped_now()
        ratings = []
        digests = []
        for view, board in module.RATING_BOARDS.items():
            raw = module.fetch_bytes(module.SITE + '/racing/info/mcs/Chinese/' + view)
            digest = module.sha256(raw)
            digests.append(digest)
            parsed, _notes = module.parse_rating_board(raw.decode('utf-8', errors='replace'), board, digest, scraped)
            ratings.extend(parsed)
        raw = module.fetch_bytes(module.SITE + '/racing/info/mcs/Chinese/Horses/tp50')
        digest = module.sha256(raw)
        digests.append(digest)
        ratings.extend(module.parse_top50(raw.decode('utf-8', errors='replace'), digest, scraped))
        if not any(row.get('board') == 'clas' for row in ratings):
            raise module.ParseMiss('horse rating list was not on Horses/clas')
        return {'official_horse_rating': _capture(ratings, scraped, module.sha256(''.join(digests).encode()))}
    except Exception as exc:
        return {'official_horse_rating': _guard('official_horse_rating')(exc)}


def _directory_persons(root: Path, directory: bool, persons: bool) -> dict[str, dict]:
    module = _module('hkjc_wave8_surfaces')
    out = {}
    try:
        module.collect(root, {flag for flag, enabled in (('directory', directory), ('persons', persons)) if enabled})
        if directory:
            rows = _read_csv(module.data_dir(root) / module.FILES['horse_directory'][0], module.FILES['horse_directory'][1])
            out['official_horse_directory'] = _capture(rows, module.scraped_now())
        if persons:
            seasons = _read_csv(module.data_dir(root) / module.FILES['person_season'][0], module.FILES['person_season'][1])
            wins = _read_csv(module.data_dir(root) / module.FILES['person_winstat'][0], module.FILES['person_winstat'][1])
            finished = module.scraped_now()
            out['official_person_season'] = _capture(seasons, finished)
            out['official_person_winstat'] = _capture(wins, finished)
    except Exception as exc:
        failed = _guard('directory')(exc)
        if directory:
            out.setdefault('official_horse_directory', failed)
        if persons:
            out.setdefault('official_person_season', failed)
            out.setdefault('official_person_winstat', failed)
    return out


def _same_sire(root: Path) -> dict[str, dict]:
    module = _module('hkjc_wave8_surfaces')
    try:
        module.collect(root, {'same-sire'})
        pages = _read_csv(module.data_dir(root) / module.FILES['same_sire_page'][0], module.FILES['same_sire_page'][1])
        horses = _read_csv(module.data_dir(root) / module.FILES['same_sire'][0], module.FILES['same_sire'][1])
        finished = module.scraped_now()
        return {
            'official_same_sire_page': _capture(pages, finished),
            'official_same_sire': _capture(horses, finished),
        }
    except Exception as exc:
        failed = _guard('same-sire')(exc)
        return {'official_same_sire_page': failed, 'official_same_sire': failed}


def _wind(meeting_date: str, venue: str) -> dict[str, dict]:
    module = _module('hkjc_wave8_surfaces')
    try:
        scraped = module.scraped_now()
        here = Path(module.__file__).resolve().parent
        weather, weather_digest = module.graphql(module.query_text(here / 'hkjc-wind-query.graphql'), None)
        meeting, meeting_digest = module.graphql(module.query_text(here / 'hkjc-track-condition-query.graphql'), module.MEETING_VARS)
        stored = module.parse_wind_weather(weather, weather_digest, scraped)
        stored.update(module.parse_wind_meeting(meeting, meeting_digest, scraped))
        digest = module.sha256((weather_digest + meeting_digest).encode())
        out = {}
        for table, surface in (
            ('wind_meeting', 'official_wind_meeting'),
            ('wind_going', 'official_wind_going'),
            ('wind_station', 'official_wind_station'),
            ('wind_section', 'official_wind_section'),
            ('wind_probe', 'official_wind_probe'),
        ):
            rows = stored.get(table) or []
            if table in ('wind_meeting', 'wind_going', 'wind_probe'):
                rows = _meeting_rows(rows, meeting_date, venue)
            out[surface] = _capture(rows, scraped, digest)
        return out
    except Exception as exc:
        failed = _guard('wind')(exc)
        return {name: failed for name in (
            'official_wind_meeting', 'official_wind_going', 'official_wind_station', 'official_wind_section',
        )}


def _results(meeting_date: str, venue: str) -> dict[str, dict]:
    module = _module('hkjc_wave8_surfaces')
    try:
        scraped = module.scraped_now()
        slash = f'{meeting_date[0:4]}/{meeting_date[5:7]}/{meeting_date[8:10]}'
        raw = module.fetch_bytes(f'{module.SITE}/zh-hk/local/information/resultsall?RaceDate={slash}')
        digest = module.sha256(raw)
        parsed = module.parse_results_all(raw.decode('utf-8', errors='replace'), meeting_date, digest, scraped)
        runners = _meeting_rows(parsed['results_all_runner'], meeting_date, venue)
        dividends = _meeting_rows(parsed['results_all_dividend'], meeting_date, venue)
        runners = [row for row in runners if row.get('section') in (None, '', 'local')]
        dividends = [row for row in dividends if row.get('section') in (None, '', 'local')]
        return {
            'official_results_all_runner': _capture(runners, scraped, digest),
            'official_results_all_dividend': _capture(dividends, scraped, digest),
        }
    except Exception as exc:
        failed = _guard('results')(exc)
        return {'official_results_all_runner': failed, 'official_results_all_dividend': failed}


def _entries(repo: Path, meeting_date: str, venue: str) -> dict:
    """Dump racecard deltas through the existing racecard parsers. No D1 write."""
    import subprocess
    out = staging_root(repo).parent / f'entries_{meeting_date}_{venue}.json'
    script = repo / 'backend' / 'scripts' / 'dump-racecard-snapshot.ts'
    if not script.exists():
        return _capture([], None, error='entries dump script is missing')
    completed = subprocess.run(
        ['npx', 'tsx', 'scripts/dump-racecard-snapshot.ts', f'--date={meeting_date}', f'--venue={venue}', f'--out={out}'],
        cwd=repo / 'backend',
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0 or not out.exists():
        detail = (completed.stderr or completed.stdout or 'entries recrawl failed').strip().splitlines()
        return _capture([], None, error=detail[-1] if detail else 'entries recrawl failed')
    payload = json.loads(out.read_text(encoding='utf-8'))
    if payload.get('unpublished'):
        return _capture([], payload.get('captured_at'), unpublished=True)
    return _capture(payload.get('rows') or [], payload.get('captured_at'), payload.get('source_sha256'))
