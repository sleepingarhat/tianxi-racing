#!/usr/bin/env python3
"""CSV schema guard (pandera / frictionless-inspired, zero extra deps).

Validates collected HKJC CSVs have required columns, enough rows, and a
minimum distinct race_no — catching truncated / wrong-header dumps that
assert_collected_rows (row-count only) would miss.

Usage:
  assert_csv_schema.py --csv PATH --kind results|dividends|odds [--min-rows N]
  assert_csv_schema.py --csv PATH --kind results --min-races 8

Exit 0 on pass; 1 on schema / cardinality failure; 2 on usage error.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Set

# Column sets mirror DATA_NOTES.md / existing collectors. Keep loosely typed:
# we only require presence, not dtype (CSV text is enough for fail-closed).
SCHEMAS: Dict[str, Sequence[str]] = {
    "results": (
        "date",
        "venue",
        "race_no",
        "horse_no",
        "place",
    ),
    "dividends": (
        "date",
        "venue",
        "race_no",
        "pool",
        "combination",
        "dividend_hkd",
    ),
    "odds": (
        "date",
        "venue",
        "race_no",
        "horse_no",
        "win_odds",
    ),
}

# Accept legacy / alternate header spellings as satisfying a required column.
COLUMN_ALIASES: Dict[str, Sequence[str]] = {
    "dividend_hkd": ("dividend", "dividend_hkd", "div"),
    "win_odds": ("win_odds", "odds", "win"),
}

DEFAULT_MIN_ROWS = {"results": 40, "dividends": 20, "odds": 40}
DEFAULT_MIN_RACES = {"results": 1, "dividends": 1, "odds": 1}


def _norm(h: str) -> str:
    return (h or "").strip().lstrip("\ufeff").lower()


def load_rows(path: Path) -> tuple[List[str], List[dict]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError(f"{path}: empty or headerless CSV")
        headers = [_norm(h) for h in reader.fieldnames]
        # Rebuild rows with normalized keys
        rows = []
        for raw in reader:
            rows.append({_norm(k): (v if v is not None else "") for k, v in raw.items()})
        return headers, rows


def validate(
    path: Path,
    kind: str,
    min_rows: int | None = None,
    min_races: int | None = None,
) -> List[str]:
    errors: List[str] = []
    required = SCHEMAS[kind]
    min_rows = DEFAULT_MIN_ROWS[kind] if min_rows is None else min_rows
    min_races = DEFAULT_MIN_RACES[kind] if min_races is None else min_races

    try:
        headers, rows = load_rows(path)
    except Exception as exc:  # noqa: BLE001 — surface as schema fail
        return [f"{path}: cannot read CSV ({exc})"]

    header_set: Set[str] = set(headers)

    def has_col(col: str) -> bool:
        aliases = COLUMN_ALIASES.get(col, (col,))
        return any(a in header_set for a in aliases)

    def resolve_col(col: str) -> str:
        for a in COLUMN_ALIASES.get(col, (col,)):
            if a in header_set:
                return a
        return col

    missing = [c for c in required if not has_col(c)]
    if missing:
        errors.append(f"{path}: missing required columns for kind={kind}: {missing}")

    # Drop fully blank rows
    data_rows = [r for r in rows if any((v or "").strip() for v in r.values())]
    if len(data_rows) < min_rows:
        errors.append(
            f"{path}: row count {len(data_rows)} < min_rows={min_rows} (kind={kind})"
        )

    if "race_no" in header_set:
        races = {
            (r.get("race_no") or "").strip()
            for r in data_rows
            if (r.get("race_no") or "").strip()
        }
        if len(races) < min_races:
            errors.append(
                f"{path}: distinct race_no={len(races)} < min_races={min_races}"
            )

    # Required fields non-empty on at least 80% of rows (tolerates a few blanks)
    if data_rows and not missing:
        for col in required:
            key = resolve_col(col)
            filled = sum(1 for r in data_rows if (r.get(key) or "").strip())
            ratio = filled / len(data_rows)
            if ratio < 0.8:
                errors.append(
                    f"{path}: column {col!r} (as {key!r}) filled on {filled}/{len(data_rows)} "
                    f"({ratio:.0%} < 80%)"
                )

    return errors


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv", required=True, help="Path to CSV file")
    p.add_argument(
        "--kind",
        required=True,
        choices=sorted(SCHEMAS.keys()),
        help="Schema kind",
    )
    p.add_argument("--min-rows", type=int, default=None)
    p.add_argument("--min-races", type=int, default=None)
    args = p.parse_args(argv)

    path = Path(args.csv)
    if not path.is_file():
        print(f"::error::{path} does not exist", file=sys.stderr)
        return 1

    errs = validate(path, args.kind, args.min_rows, args.min_races)
    if errs:
        for e in errs:
            print(f"::error::{e}", file=sys.stderr)
        return 1
    print(f"::notice::CSV schema OK kind={args.kind} path={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
