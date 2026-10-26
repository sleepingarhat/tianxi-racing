#!/usr/bin/env bash
# Fail-closed guard: on an expected race day, collectors must write >0 rows.
# Usage: assert_collected_rows.sh <rows> [YYYY-MM-DD ...]
# Exit 0 if rows>0, or if none of the dates is a fixture race day.
# Exit 1 if any date is a race day (or fixture cache fail-open) and rows==0.
#
# Optional env (2026-10-26 adopted pattern — schema beyond row-count):
#   ASSERT_CSV=/path/to/file.csv
#   ASSERT_KIND=results|dividends|odds
#   ASSERT_MIN_ROWS=N          (optional)
#   ASSERT_MIN_RACES=N         (optional)
# When ASSERT_CSV+ASSERT_KIND are set AND rows>0, also run assert_csv_schema.py.
set -eu
ROWS="${1:-0}"
shift || true
if [ "$#" -eq 0 ]; then
  set -- "$(TZ=Asia/Hong_Kong date +%Y-%m-%d)"
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXPECTED=0
for d in "$@"; do
  [ -n "$d" ] || continue
  RC=0
  python3 "$ROOT/fixture_guard.py" check-date "$d" >/tmp/fg.out 2>/tmp/fg.err || RC=$?
  # fixture_guard: 0 = race day (or fail-open), 10 = not race day, 20 = stale fail-open
  if [ "$RC" -eq 0 ] || [ "$RC" -eq 20 ]; then
    EXPECTED=1
    echo "fixture_guard: $d is race-day (or fail-open, rc=$RC)"
  else
    echo "fixture_guard: $d not a race day (rc=$RC)"
  fi
done
echo "collected_rows=$ROWS expected_race_day=$EXPECTED"
if [ "$EXPECTED" -eq 1 ] && [ "${ROWS:-0}" -le 0 ]; then
  echo "::error::Race day expected data but collected 0 rows — failing closed (silent-green guard)"
  exit 1
fi
if [ "${ROWS:-0}" -gt 0 ]; then
  echo "::notice::Collected $ROWS rows"
  if [ -n "${ASSERT_CSV:-}" ] && [ -n "${ASSERT_KIND:-}" ]; then
    EXTRA=()
    [ -n "${ASSERT_MIN_ROWS:-}" ] && EXTRA+=(--min-rows "$ASSERT_MIN_ROWS")
    [ -n "${ASSERT_MIN_RACES:-}" ] && EXTRA+=(--min-races "$ASSERT_MIN_RACES")
    python3 "$ROOT/scripts/ci/assert_csv_schema.py" \
      --csv "$ASSERT_CSV" \
      --kind "$ASSERT_KIND" \
      "${EXTRA[@]}"
  fi
fi
exit 0
