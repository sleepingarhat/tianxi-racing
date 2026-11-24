-- Append-only official point-in-time snapshots.
-- Live official_* Wave tables are not altered. Scheduled jobs never UPDATE or DELETE these tables.
-- A second freeze or post_race for the same meeting with a different content hash aborts.

CREATE TABLE IF NOT EXISTS official_snapshot_manifest (
  snapshot_id TEXT NOT NULL PRIMARY KEY,          -- sha256 of canonical header+content
  meeting_date TEXT NOT NULL,                     -- YYYY-MM-DD
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  snapshot_kind TEXT NOT NULL CHECK (
    snapshot_kind IN ('freeze', 'post_race', 'card_status', 'pre_freeze_safety')
  ),
  card_status TEXT CHECK (
    card_status IS NULL OR card_status IN ('fixture', 'entries', 'declared')
  ),
  first_post_at TEXT,
  lock_at TEXT,
  last_post_at TEXT,
  captured_at TEXT NOT NULL,                      -- ISO instant
  content_sha256 TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
  gaps_json TEXT NOT NULL,                        -- JSON array, empty if none
  lock_crosscheck_json TEXT,                      -- lock-state vs local clock
  source_commit TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS official_snapshot_freeze_once
  ON official_snapshot_manifest (meeting_date, venue)
  WHERE snapshot_kind = 'freeze';

CREATE UNIQUE INDEX IF NOT EXISTS official_snapshot_postrace_once
  ON official_snapshot_manifest (meeting_date, venue)
  WHERE snapshot_kind = 'post_race';

CREATE UNIQUE INDEX IF NOT EXISTS official_snapshot_idempotent
  ON official_snapshot_manifest (meeting_date, venue, snapshot_kind, content_sha256);

CREATE TABLE IF NOT EXISTS official_snapshot_surface (
  snapshot_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  captured_at TEXT,                               -- null iff status is gap / excluded
  source_sha256 TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('present', 'gap', 'stale_available', 'excluded_leakage')
  ),
  gap_reason TEXT,
  repo_path TEXT,
  PRIMARY KEY (snapshot_id, surface)
);

-- Row payload: copy of the official row plus snapshot identity. No UPDATE, no DELETE.
CREATE TABLE IF NOT EXISTS official_snapshot_row (
  snapshot_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  meeting_date TEXT,
  venue TEXT,
  race_no INTEGER,
  horse_no INTEGER,
  is_reserve INTEGER CHECK (is_reserve IS NULL OR is_reserve IN (0, 1)),
  horse_id TEXT,
  brand_no TEXT,
  horse_code TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, surface, row_no)
);

-- INSERT OR IGNORE swallows unique-index conflicts. A different freeze or post_race
-- hash must still abort, so these guards use RAISE, which OR IGNORE does not swallow.
CREATE TRIGGER IF NOT EXISTS official_snapshot_freeze_once_guard
BEFORE INSERT ON official_snapshot_manifest
WHEN NEW.snapshot_kind = 'freeze'
 AND EXISTS (
   SELECT 1 FROM official_snapshot_manifest
    WHERE meeting_date = NEW.meeting_date
      AND venue = NEW.venue
      AND snapshot_kind = 'freeze'
      AND content_sha256 != NEW.content_sha256
 )
BEGIN
  SELECT RAISE(ABORT, 'freeze snapshot already exists for this meeting');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_postrace_once_guard
BEFORE INSERT ON official_snapshot_manifest
WHEN NEW.snapshot_kind = 'post_race'
 AND EXISTS (
   SELECT 1 FROM official_snapshot_manifest
    WHERE meeting_date = NEW.meeting_date
      AND venue = NEW.venue
      AND snapshot_kind = 'post_race'
      AND content_sha256 != NEW.content_sha256
 )
BEGIN
  SELECT RAISE(ABORT, 'post_race snapshot already exists for this meeting');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_manifest_no_update
BEFORE UPDATE ON official_snapshot_manifest
BEGIN
  SELECT RAISE(ABORT, 'official_snapshot_manifest is append-only');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_manifest_no_delete
BEFORE DELETE ON official_snapshot_manifest
BEGIN
  SELECT RAISE(ABORT, 'official_snapshot_manifest is append-only');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_surface_no_update
BEFORE UPDATE ON official_snapshot_surface
BEGIN
  SELECT RAISE(ABORT, 'official_snapshot_surface is append-only');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_surface_no_delete
BEFORE DELETE ON official_snapshot_surface
BEGIN
  SELECT RAISE(ABORT, 'official_snapshot_surface is append-only');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_row_no_update
BEFORE UPDATE ON official_snapshot_row
BEGIN
  SELECT RAISE(ABORT, 'official_snapshot_row is append-only');
END;

CREATE TRIGGER IF NOT EXISTS official_snapshot_row_no_delete
BEFORE DELETE ON official_snapshot_row
BEGIN
  SELECT RAISE(ABORT, 'official_snapshot_row is append-only');
END;
