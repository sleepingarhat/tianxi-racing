"""Join, sentinel, and leakage rules for official point-in-time snapshots.

FWB horse numbers are not rewritten. A row is joined by brand or horse_id,
including when the racecard runner is a reserve, then race_no is confirmed.
passed OVE dates are not current risk. last10_wins is last-10-raceday
wins and is not capped at 10.
"""
from __future__ import annotations

import re

BRAND = re.compile(r'^[A-Z]\d{3}$')
HORSE_ID = re.compile(r'^HK_\d{4}_(?P<brand>[A-Z]\d{3})$')
NAME_BRAND = re.compile(r'^(?P<name>.+?)\s*\(([A-Z]\d{3})\)$')
IMPORT_CODES = frozenset({'PPG', 'PP', 'ISG'})

FREEZE_REQUIRED = (
    'entries_upcoming',
    'official_racecard_runner',
    'official_ove_record',
    'official_ove_database',
    'official_conghua_movement',
    'official_jt_combo',
    'official_fwb_declared',
    'official_horse_rating',
    'official_horse_directory',
    'official_person_season',
    'official_person_winstat',
    'official_same_sire',
    'official_same_sire_page',
    'official_ppo_performance',
    'official_wind_meeting',
    'official_wind_going',
    'official_wind_station',
    'official_wind_section',
)
OPTIONAL_UNPUBLISHED = frozenset({'official_conghua_movement', 'official_jt_combo'})
OPTIONAL_METADATA = frozenset({'official_fixture_line'})
NOT_A_FREEZE_FAILURE = frozenset({'official_wind_probe'})
POST_RACE_ONLY = frozenset({
    'official_results_all_runner',
    'official_results_all_dividend',
    'post_race_going',
})
LEAKAGE = frozenset({
    'live_win_pla_odds',
    'live_win_odds',
    'live_pla_odds',
    'official_finish_photo',
    'raceday_jpeg',
    'official_import_policy',
    'official_horse_news',
    'official_horse_news_document',
    'official_special_index',
    'official_challenge_odds',
    'challenge_odds',
})
CARD_SURFACES = FREEZE_REQUIRED

GAP_REASONS = frozenset({
    'recrawl_failed',
    'not_published',
    'clock_mismatch',
    'freeze_missed_window',
    'stale_only',
})


def strip_meetings_suffix(name: str | None) -> str:
    text = (name or '').strip()
    match = NAME_BRAND.match(text)
    return match.group('name').strip() if match else text


def names_confirm(left: str | None, right: str | None) -> bool:
    return strip_meetings_suffix(left) == strip_meetings_suffix(right) and bool(strip_meetings_suffix(left))


def ove_current_risk(row: dict) -> bool:
    """A passed_date means the vet line is already passed, not a current injury."""
    passed = row.get('passed_date')
    return passed is None or str(passed).strip() == ''


def interpret_last10_wins(row: dict) -> dict:
    """Wins in the last 10 racedays. 19 is legal and is not a ride count."""
    if 'last10_wins' in row and row['last10_wins'] not in (None, ''):
        value = row['last10_wins']
    elif 'last10Wins' in row and row['last10Wins'] not in (None, ''):
        value = row['last10Wins']
    else:
        value = None
    number = None if value is None else int(value)
    return {
        'last10_wins': number,
        'last10Wins': number,
        'meaning': 'wins_in_the_last_10_racedays',
        'last_10_rides': False,
        'capped': False,
    }


def blank_cell(value):
    """A blank racecard cell is null. It is never coerced to 0."""
    if value is None:
        return None
    if isinstance(value, str) and value.strip() in ('', '-', '--', '---'):
        return None
    return value


def body_weight_pounds(value) -> int | None:
    number = blank_cell(value)
    if number is None:
        return None
    try:
        parsed = int(number)
    except (TypeError, ValueError):
        return None
    if 700 <= parsed <= 1500:
        return parsed
    return None


def imposed_pounds(value) -> int | None:
    number = blank_cell(value)
    if number is None:
        return None
    try:
        parsed = int(number)
    except (TypeError, ValueError):
        return None
    if 80 <= parsed <= 180:
        return parsed
    return None


def freeze_card_deltas(entry: dict | None, results_declared_weight=None) -> dict:
    """Racecard deltas at freeze. Results declared_weight is never a fill."""
    row = entry or {}
    best = blank_cell(row.get('best_time'))
    if isinstance(best, str) and not re.fullmatch(r'\d{1,2}\.\d{2}\.\d{2}', best):
        best = None
    return {
        'ratingChange': blank_cell(row.get('rating_change', row.get('ratingChange'))),
        'bodyWeightChange': blank_cell(row.get('body_weight_change', row.get('bodyWeightChange'))),
        'bestTime': best,
        'daysSinceRun': blank_cell(row.get('days_since_run', row.get('daysSinceRun'))),
        'possibleOverweight': blank_cell(row.get('possible_overweight', row.get('possibleOverweight'))),
        'ageAllowance': blank_cell(row.get('age_allowance', row.get('ageAllowance'))),
        'bodyWeight': body_weight_pounds(row.get('body_weight', row.get('bodyWeight'))),
        'imposedWeight': imposed_pounds(row.get('declared_weight', row.get('declaredWeight'))),
        'resultsDeclaredWeightIgnored': results_declared_weight is not None,
    }


def import_type_code(value: str | None) -> str | None:
    """Official codes stay PPG / PP / ISG. Chinese labels are not invented."""
    if value in IMPORT_CODES:
        return value
    return None


def penetrometer_reading(value) -> str | None:
    """A penetrometer '--' stays blank. Probes are not required."""
    blank = blank_cell(value)
    return None if blank is None else str(blank)


def wind_probes_block_freeze(probe_count: int) -> bool:
    """probes=0 is an empty optional surface, not a freeze failure."""
    return False if int(probe_count) == 0 else False


def leakage_surface(name: str) -> bool:
    return name in LEAKAGE or name in POST_RACE_ONLY


def _brand_of(row: dict) -> str:
    """Official brand, or the brand embedded in HK_YYYY_BRAND. Never a saddle number."""
    brand = str(row.get('brand_no') or row.get('brand') or '')
    if BRAND.fullmatch(brand):
        return brand
    match = HORSE_ID.fullmatch(str(row.get('horse_id') or ''))
    return match.group('brand') if match else ''


def _horse_id_of(row: dict) -> str:
    horse_id = str(row.get('horse_id') or '')
    return horse_id if HORSE_ID.fullmatch(horse_id) else ''


def join_fwb(fwb_rows: list[dict], starters: list[dict]) -> list[dict]:
    """Join one FWB row to one runner by brand or horse_id, then confirm race_no.

    Standby numbers (`STBY-1` → horse_no 1, is_reserve 1) reuse declared saddle
    numbers. A reserve and a declared runner that share a number stay distinct
    unless they are the same brand. Racecard reserves are eligible matches:
    a standby bonus follows that brand onto a declared saddle when the card
    has already given the horse one. The captured FWB horse_no is not rewritten.
    """
    by_brand: dict[tuple[int, str], list[dict]] = {}
    by_id: dict[tuple[int, str], list[dict]] = {}
    for starter in starters:
        race_no = int(starter['race_no'])
        brand = _brand_of(starter)
        if brand:
            by_brand.setdefault((race_no, brand), []).append(starter)
        horse_id = _horse_id_of(starter)
        if horse_id:
            by_id.setdefault((race_no, horse_id), []).append(starter)
    attached = []
    for row in fwb_rows:
        explicit_brand = str(row.get('brand_no') or row.get('brand') or '')
        explicit_brand = explicit_brand if BRAND.fullmatch(explicit_brand) else ''
        brand = explicit_brand or _brand_of(row)
        race_no = int(row['race_no'])
        horse_no = int(row['horse_no'])
        horse_id = _horse_id_of(row)
        id_matches = by_id.get((race_no, horse_id), []) if horse_id else []
        brand_matches = by_brand.get((race_no, brand), []) if brand else []
        # A brand and a horse_id that name different runners are not a match.
        # Either identity alone is enough. Saddle number is never enough.
        if horse_id and explicit_brand:
            agreed = [runner for runner in id_matches if runner in brand_matches]
            matches = agreed if len(agreed) == 1 else []
            matched_by = 'horse_id' if len(agreed) == 1 else None
        elif horse_id:
            matches = id_matches if len(id_matches) == 1 else []
            matched_by = 'horse_id' if len(id_matches) == 1 else None
        else:
            matches = brand_matches if len(brand_matches) == 1 else []
            matched_by = 'brand' if len(brand_matches) == 1 else None
        rejected = []
        for starter in starters:
            if int(starter['race_no']) != race_no or int(starter['horse_no']) != horse_no:
                continue
            starter_brand = _brand_of(starter)
            if starter_brand != brand:
                rejected.append({
                    'horse_no': int(starter['horse_no']),
                    'brand_no': starter_brand,
                    'is_reserve': int(starter.get('is_reserve') or 0),
                })
        match = matches[0] if len(matches) == 1 else None
        attached.append({
            'brand_no': brand,
            'fwb_horse_no': horse_no,
            'fwb_is_reserve': int(row.get('is_reserve') or 0),
            'race_no': race_no,
            'starter_horse_no': None if match is None else int(match['horse_no']),
            'starter_brand': None if match is None else _brand_of(match),
            'card_is_reserve': None if match is None else int(match.get('is_reserve') or 0),
            'card_horse_id': None if match is None else (_horse_id_of(match) or None),
            'matched_by': matched_by if match is not None else None,
            'attached': match is not None,
            'horse_no_rewritten': False,
            'rejected_same_horse_no': rejected,
        })
    return attached


def join_conghua(movements: list[dict], runners: list[dict]) -> list[dict]:
    """Join race_no + horse_no and confirm the Chinese name. Multiple trips stay.

    Conghua rows have no horse code. A brand is not invented.
    """
    by_key = {}
    for runner in runners:
        key = (int(runner['race_no']), int(runner['horse_no']), int(runner.get('is_reserve') or 0))
        by_key[key] = runner
    joined = []
    for row in movements:
        key = (int(row['race_no']), int(row['horse_no']), int(row.get('is_reserve') or 0))
        runner = by_key.get(key)
        runner_name = None if runner is None else (runner.get('horse_name_ch') or runner.get('horse_name'))
        joined.append({
            'race_no': key[0],
            'horse_no': key[1],
            'is_reserve': key[2],
            'line_no': int(row['line_no']),
            'attached': runner is not None and names_confirm(row.get('horse_name_ch'), runner_name),
            'brand_no': None,
            'arrived_date': blank_cell(row.get('arrived_date')),
            'returned_date': blank_cell(row.get('returned_date')),
        })
    return joined


def accept_jt_combo(row: dict) -> dict:
    """Empty names are missing, not an error. as_of_text is kept. Do not join by name."""
    name = blank_cell(row.get('horse_name'))
    return {
        'race_no': int(row['race_no']),
        'horse_no': int(row['horse_no']),
        'is_reserve': int(row.get('is_reserve') or 0),
        'section': row.get('section'),
        'horse_name': name,
        'name_missing': name is None,
        'as_of_text': row.get('as_of_text'),
        'join_by_name': False,
    }


def missing_join_races(expected: list[int], joined: set[int], void_races: set[int]) -> list[int]:
    """Void and cancelled races are labelled, not counted as missing joins."""
    return [race_no for race_no in expected if race_no not in void_races and race_no not in joined]


def freeze_rejects(surface: str) -> bool:
    return surface in LEAKAGE or surface in POST_RACE_ONLY


def gap_record(surface: str, reason: str, stale: dict | None = None) -> dict:
    if reason not in GAP_REASONS:
        raise ValueError(f'gap reason {reason!r} is not in the snapshot vocabulary')
    record = {'surface': surface, 'status': 'gap', 'reason': reason}
    if stale is not None:
        record['status'] = 'stale_available' if reason == 'stale_only' else record['status']
        record['stale_available'] = {
            'scraped_at': stale.get('scraped_at'),
            'row_count': int(stale.get('row_count') or 0),
            'not_freeze_fresh': True,
        }
    return record


def refuse_live_backfill(decision: dict, later_rows: list[dict]) -> dict:
    """Later live or post-race rows do not fill a freeze gap."""
    del later_rows
    return decision
