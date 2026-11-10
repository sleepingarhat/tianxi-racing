#!/usr/bin/env bash
# Apply 20261110 official-card DDL to remote D1 before any INSERT.
# One statement per wrangler call. A duplicate column on a single statement
# means that column arrived between PRAGMA and ALTER; later statements still run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DB="${D1_DATABASE:-tianxi-db}"
WORKDIR="${TMPDIR:-/tmp}/d1-official-card-schema"
mkdir -p "$WORKDIR"

fetch() {
  local sql="$1"
  local out="$2"
  npx wrangler d1 execute "$DB" --remote --json --command="$sql" > "$out"
}

fetch "PRAGMA table_info(entries_upcoming)" "$WORKDIR/entries_upcoming.json"
fetch "PRAGMA table_info(official_fixtures)" "$WORKDIR/official_fixtures.json"
fetch "PRAGMA table_info(official_race_entries)" "$WORKDIR/official_race_entries.json"
fetch "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('official_fixtures','official_race_entries')" "$WORKDIR/indexes.json"

npx tsx scripts/d1-official-card-schema.ts \
  --migration=src/db/migrations/20261027_entries_upcoming_race_meta.sql \
  --migration=src/db/migrations/20261110_official_fixtures_entries.sql \
  --entries-upcoming="$WORKDIR/entries_upcoming.json" \
  --official-fixtures="$WORKDIR/official_fixtures.json" \
  --official-race-entries="$WORKDIR/official_race_entries.json" \
  --indexes="$WORKDIR/indexes.json" \
  --out="$WORKDIR/ensure.sql" \
  --database="$DB" \
  --apply
