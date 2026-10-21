-- 2026-10-22 perf: per-meeting freeze-ledger snapshot.
--
-- NOT applied automatically. Apply once to production D1 (after or before the
-- Worker deploy — the code falls back to live compute while this table is missing):
--   npx wrangler d1 execute tianxi-db --remote --file=./src/db/migrations/20261022_freeze_ledger_meeting.sql
--
-- One row per settled meeting = the exact LedgerMeeting JSON the
-- /api/analyze/freeze-ledger endpoint would compute live, wrapped as
-- {"v":<LEDGER_SNAPSHOT_VERSION>,"meeting":{...}}; sha256 = SHA-256 of payload_json.
-- Written only for meetings that are locked, verified, have results for every
-- frozen race and are >= 2 HKT days old. Rows are derived data: deleting any of
-- them is always safe (the next request/cron recomputes and rewrites them).
CREATE TABLE IF NOT EXISTS freeze_ledger_meeting (
  date         TEXT NOT NULL,
  engine       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (date, engine)
);

-- Optional (NOT required; heavier write on a large table — run off race nights):
-- the freeze ledger now filters PLA odds by (race_date, venue, pool_type), which the
-- existing (race_date, venue, race_number, pool_type, ...) indexes already serve by prefix.
-- CREATE INDEX IF NOT EXISTS idx_odds_archive_date_venue_pool ON odds_archive (race_date, venue, pool_type);
