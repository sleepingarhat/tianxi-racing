-- Official 更易事項 board. HTML snapshots stay append-only under
-- data/racing-changes/; this table is the rebuildable projection of the
-- latest snapshot per meeting. Re-runs replace that meeting's rows.
CREATE TABLE IF NOT EXISTS racing_changes (
  id TEXT PRIMARY KEY,
  race_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  horse_number INTEGER,
  horse_name TEXT,
  change_type TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  announced_at TEXT,
  raw_text TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  snapshot_path TEXT,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_racing_changes_meeting
  ON racing_changes(race_date, venue, race_number);
