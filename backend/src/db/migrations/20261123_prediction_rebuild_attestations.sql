-- Owner-approved, labelled post-lock rebuilds of an original freeze.
-- Append-only: a rebuild is never edited or removed, and the snapshot it
-- created carries the same provenance inside its SHA-256 covered JSON.
CREATE TABLE IF NOT EXISTS prediction_rebuild_attestations (
  date TEXT NOT NULL,
  engine TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'post-lock-rebuild'),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approval TEXT NOT NULL,
  rebuilt_at TEXT NOT NULL,
  blocked_reason TEXT NOT NULL,
  rows INTEGER NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (date, engine)
);
CREATE TRIGGER IF NOT EXISTS prediction_rebuild_attestations_no_update BEFORE UPDATE ON prediction_rebuild_attestations BEGIN SELECT RAISE(ABORT,'rebuild attestation immutable'); END;
CREATE TRIGGER IF NOT EXISTS prediction_rebuild_attestations_no_delete BEFORE DELETE ON prediction_rebuild_attestations BEGIN SELECT RAISE(ABORT,'rebuild attestation immutable'); END;
