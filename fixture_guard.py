"""
Fixture Guard — pre-flight helper for race-day-aware workflows.

Usage from CLI (used by GHA pre-flight step):
    python fixture_guard.py check-today        # exit 0 if today is race day, 10 if not, 20 if stale
    python fixture_guard.py check-date 2026-04-26
    python fixture_guard.py next-meets 5       # print next 5 upcoming meets
    python fixture_guard.py cache-status       # report age of fixtures.csv

Fail-open policy:
    If fixtures.csv missing OR older than STALE_DAYS, treat every day as race day
    (exit 0). Rationale: we never want to skip a real meeting because our cache
    is stale. Staleness is reported on stderr so the caller can log/alert.

Import usage:
    from fixture_guard import is_race_day, days_until_next_race, cache_status
"""

import argparse
import csv
import os
import sys
from datetime import date, datetime, timezone, timedelta
from typing import Optional, List, Dict

FIXTURE_CSV = os.path.join("data", "fixtures", "fixtures.csv")
STALE_DAYS = 21  # 3 weeks — if cache older than this, fail-open


def _parse_date(s: str) -> Optional[date]:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def _load() -> List[Dict]:
    if not os.path.exists(FIXTURE_CSV):
        return []
    out = []
    with open(FIXTURE_CSV, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            d = _parse_date(row.get("date", ""))
            if d:
                row["_date"] = d
                out.append(row)
    return out


def cache_status() -> Dict:
    """Return {exists, path, rows, newest_captured, age_days, stale}."""
    rows = _load()
    status = {"exists": False, "path": FIXTURE_CSV, "rows": 0,
              "newest_captured": None, "age_days": None, "stale": True}
    if not rows:
        return status
    status["exists"] = True
    status["rows"] = len(rows)
    caps = [r.get("captured_at", "") for r in rows if r.get("captured_at")]
    if caps:
        latest = max(caps)
        try:
            dt = datetime.strptime(latest[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - dt).days
            status["newest_captured"] = latest
            status["age_days"] = age
            status["stale"] = age > STALE_DAYS
        except Exception:
            pass
    return status


def is_race_day(d: date) -> bool:
    """Return True if d is in the fixture cache.

    Fail-open: if cache missing/stale, return True (caller proceeds as if race day).
    """
    rows = _load()
    if not rows:
        print(f"[fixture-guard] WARN: no fixture cache at {FIXTURE_CSV} — failing open",
              file=sys.stderr)
        return True

    st = cache_status()
    if st["stale"]:
        print(f"[fixture-guard] WARN: fixture cache is stale (age={st['age_days']}d) — failing open",
              file=sys.stderr)
        return True

    for r in rows:
        if r["_date"] == d:
            return True
    return False


def days_until_next_race(from_d: Optional[date] = None) -> Optional[int]:
    """Return # days until next race meeting >= from_d (today if None). None if unknown."""
    rows = _load()
    if not rows:
        return None
    from_d = from_d or date.today()
    future = [r["_date"] for r in rows if r["_date"] >= from_d]
    if not future:
        return None
    return (min(future) - from_d).days


def next_meets(n: int = 5, from_d: Optional[date] = None) -> List[Dict]:
    rows = _load()
    from_d = from_d or date.today()
    upcoming = [r for r in rows if r["_date"] >= from_d]
    upcoming.sort(key=lambda r: r["_date"])
    return upcoming[:n]


def _cli_check(target: date) -> int:
    st = cache_status()
    if not st["exists"]:
        print(f"NO_CACHE path={FIXTURE_CSV}", file=sys.stderr)
        return 20
    if st["stale"]:
        print(f"STALE age={st['age_days']}d — failing open", file=sys.stderr)
        return 0
    if is_race_day(target):
        print(f"RACE_DAY {target}")
        return 0
    print(f"NO_RACE {target} (next in {days_until_next_race(target)} days)")
    return 10


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check-today")
    p2 = sub.add_parser("check-date"); p2.add_argument("date")
    p3 = sub.add_parser("next-meets"); p3.add_argument("n", type=int, default=5, nargs="?")
    sub.add_parser("cache-status")
    args = ap.parse_args()

    if args.cmd == "check-today":
        # Use HK time (UTC+8) and accept today∨yesterday as race-day.
        # Cron runs HK 23:30; with setup overhead the scraper often starts
        # past HK midnight. Strict "today" mis-classifies the just-finished
        # race day as no-race.
        from datetime import timedelta as _td
        hk_now = (datetime.now(timezone.utc) + _td(hours=8)).date()
        for cand in (hk_now, hk_now - _td(days=1)):
            if is_race_day(cand):
                print(f"RACE_DAY {cand} (window today∨yesterday HK)")
                sys.exit(0)
        print(f"NO_RACE in window {hk_now - _td(days=1)} or {hk_now}")
        sys.exit(10)
    if args.cmd == "check-date":
        d = _parse_date(args.date)
        if not d:
            print(f"invalid date: {args.date}", file=sys.stderr); sys.exit(2)
        sys.exit(_cli_check(d))
    if args.cmd == "next-meets":
        for r in next_meets(args.n):
            venue = r.get("venue") or r.get("venue_hint") or "?"
            print(
                f"{r['date']} {r.get('weekday','?'):>3}  {venue:>2}  "
                f"{r.get('timing','?'):<5}  {r.get('surface','?'):<5}  n={r.get('race_count','?')}"
            )
        sys.exit(0)
    if args.cmd == "cache-status":
        st = cache_status()
        for k, v in st.items():
            print(f"{k}: {v}")
        sys.exit(0 if st["exists"] and not st["stale"] else 1)


if __name__ == "__main__":
    main()
