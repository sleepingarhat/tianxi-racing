#!/usr/bin/env bash
# Apply one SQL file to remote D1, waiting out Cloudflare's single-import lock.
#
# D1 runs one `--file` import at a time per database. When two official-data
# workflows finish together, the second gets "Currently processing a
# long-running import. Cannot start another import" and its rows were dropped
# with a red run (2026-11-22 Race-day Companions). That error means the import
# never started, so retrying is safe. Every other failure still fails at once.
#
# Usage: d1-execute-file.sh <sql-file>   (run from the backend directory)
set -u
file="${1:?sql file required}"
attempts="${D1_IMPORT_ATTEMPTS:-8}"
delay="${D1_IMPORT_DELAY_SECONDS:-20}"
log="$(mktemp)"
for attempt in $(seq 1 "$attempts"); do
  if wrangler d1 execute tianxi-db --remote --file="$file" --yes >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    exit 0
  fi
  if grep -qE "long-running import|Cannot start another import" "$log" && [ "$attempt" -lt "$attempts" ]; then
    echo "D1 import lock held by another job; retry $attempt/$attempts in ${delay}s ($file)"
    sleep "$delay"
    delay=$((delay * 2 > 120 ? 120 : delay * 2))
    continue
  fi
  cat "$log"
  rm -f "$log"
  exit 1
done
cat "$log"
rm -f "$log"
exit 1
