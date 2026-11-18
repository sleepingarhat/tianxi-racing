#!/usr/bin/env bash
# Add one column to an existing D1 table, once.
# Usage: scripts/d1_add_column.sh <table> <column> "<column definition>"
# A column that already exists counts as done; any other wrangler error fails.
set -euo pipefail
table="$1"; column="$2"; definition="$3"
[[ "$table" =~ ^[a-z_][a-z0-9_]*$ && "$column" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "bad identifier"; exit 1; }
if out=$(wrangler d1 execute tianxi-db --remote --yes \
    --command "ALTER TABLE ${table} ADD COLUMN ${column} ${definition}" 2>&1); then
  echo "added ${table}.${column}"
  exit 0
fi
if grep -qi "duplicate column name: ${column}" <<<"$out"; then
  echo "${table}.${column} already present"
  exit 0
fi
echo "$out"
exit 1
