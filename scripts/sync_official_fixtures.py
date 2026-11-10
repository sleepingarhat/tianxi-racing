"""Replace D1 official_fixtures from data/fixtures/fixtures.csv.

The CSV is the calendar capy_fixture_weekly already writes. This does not
invent meetings: a row without a date or an ST/HV venue aborts the file.
Blank race_count stays NULL (HKJC sometimes publishes a day before the
race count). The Worker reads the table; it does not scrape.
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "fixtures" / "fixtures.csv"
REQUIRED = ("date", "venue", "weekday", "timing", "race_count", "surface", "captured_at")
TIMING = {"day", "night", "twilight"}
SURFACE = {"turf", "awt", "mixed"}
VENUE = {"ST", "HV"}


class FixtureSyncError(Exception):
    pass


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def load_fixtures(path: Path) -> list[dict]:
    if not path.is_file():
        raise FixtureSyncError(f"missing {path}")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        missing = [name for name in REQUIRED if name not in fields]
        if missing:
            raise FixtureSyncError(f"fixtures.csv missing columns {missing}")
        rows = []
        seen = set()
        for raw in reader:
            date = (raw.get("date") or "").strip()
            try:
                datetime.strptime(date, "%Y-%m-%d")
            except ValueError as exc:
                raise FixtureSyncError(f"bad fixture date {date!r}") from exc
            venue = (raw.get("venue") or "").strip().upper()
            timing = (raw.get("timing") or "").strip().lower()
            surface = (raw.get("surface") or "").strip().lower()
            if venue not in VENUE:
                raise FixtureSyncError(f"{date} venue {venue!r} is not ST/HV")
            if timing not in TIMING:
                raise FixtureSyncError(f"{date} timing {timing!r}")
            if surface not in SURFACE:
                raise FixtureSyncError(f"{date} surface {surface!r}")
            race_count_raw = (raw.get("race_count") or "").strip()
            race_count = None
            if race_count_raw:
                if not race_count_raw.isdigit():
                    raise FixtureSyncError(f"{date} race_count {race_count_raw!r}")
                race_count = int(race_count_raw)
                if race_count < 1 or race_count > 14:
                    raise FixtureSyncError(f"{date} race_count {race_count} out of range")
            key = (date, venue)
            if key in seen:
                raise FixtureSyncError(f"duplicate fixture {date} {venue}")
            seen.add(key)
            rows.append({
                "date": date,
                "venue": venue,
                "weekday": (raw.get("weekday") or "").strip() or None,
                "timing": timing,
                "race_count": race_count,
                "surface": surface,
                "captured_at": (raw.get("captured_at") or "").strip() or None,
            })
    if len(rows) < 20:
        raise FixtureSyncError(f"fixtures.csv has {len(rows)} rows; refusing a short replace")
    return rows


def emit_sql(rows: list[dict]) -> str:
    lines = [
        "-- full replace of official_fixtures from fixtures.csv",
        "DELETE FROM official_fixtures;",
    ]
    for row in rows:
        values = ", ".join(sql_literal(row[name]) for name in (
            "date", "venue", "weekday", "timing", "race_count", "surface", "captured_at",
        ))
        lines.append(
            "INSERT INTO official_fixtures "
            "(date, venue, weekday, timing, race_count, surface, captured_at) "
            f"VALUES ({values});"
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="fixtures.csv → official_fixtures SQL")
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        rows = load_fixtures(Path(args.csv))
    except FixtureSyncError as exc:
        print(f"[fixtures] FAIL {exc}", file=sys.stderr)
        return 1
    Path(args.out).write_text(emit_sql(rows), encoding="utf-8")
    print(f"[fixtures] {len(rows)} rows -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
