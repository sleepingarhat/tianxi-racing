-- 2026-10-22: D1 daily-sync gap — horse_sectional_times (race sync) and
-- trial_sessions / trial_runners (Pool A sync).
--
-- Idempotent (CREATE ... IF NOT EXISTS only; never alters or drops). The sync
-- workflows run this file themselves before pushing, so applying it by hand is
-- OPTIONAL:
--   npx wrangler d1 execute tianxi-db --remote --file=./src/db/migrations/20261022_sync_trials_sectionals.sql
-- If a table already exists in D1 with a different shape, this is a no-op and the
-- workflow's schema guard (scripts/d1-schema-guard.ts) skips that table with a
-- warning instead of failing the sync.
CREATE TABLE IF NOT EXISTS horse_sectional_times (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  horse_id TEXT NOT NULL REFERENCES horses(id),
  section_number INTEGER NOT NULL,
  section_time REAL,
  position_at_section INTEGER,
  UNIQUE(race_id, horse_id, section_number)
);

CREATE TABLE IF NOT EXISTS trial_sessions (
  id TEXT PRIMARY KEY,
  trial_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  session_number INTEGER,
  distance INTEGER,
  going TEXT,
  track TEXT,
  total_runners INTEGER,
  source_commit TEXT,
  UNIQUE(trial_date, venue, session_number)
);
CREATE INDEX IF NOT EXISTS idx_ts_date ON trial_sessions(trial_date DESC);

CREATE TABLE IF NOT EXISTS trial_runners (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES trial_sessions(id),
  horse_id TEXT NOT NULL REFERENCES horses(id),
  horse_number INTEGER,
  finishing_position INTEGER,
  time_text TEXT,
  time_sec REAL,
  jockey_name TEXT,
  jockey_id TEXT REFERENCES jockeys(id),
  lbw TEXT,
  gear TEXT,
  comment TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, horse_id)
);
CREATE INDEX IF NOT EXISTS idx_tr_session ON trial_runners(session_id);
CREATE INDEX IF NOT EXISTS idx_tr_horse ON trial_runners(horse_id);
