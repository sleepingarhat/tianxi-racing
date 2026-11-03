-- HKJC race-day focus (賽日頭條) and last-run reminder (上仗備忘).
-- Research reference only: never a model input, never a frozen-pick input, never a race result.
-- The focus body is an editorial article: only its SHA-256 and length are stored.

CREATE TABLE IF NOT EXISTS official_raceday_focus (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  version INTEGER,
  title_ch TEXT NOT NULL,
  highlight_ch TEXT,
  body_sha256 TEXT NOT NULL,
  body_chars INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue)
);

CREATE TABLE IF NOT EXISTS official_last_run_reminder (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name_ch TEXT NOT NULL,
  last_date TEXT NOT NULL,
  last_race_no INTEGER NOT NULL,
  last_race_index INTEGER NOT NULL,
  last_venue TEXT NOT NULL CHECK (last_venue IN ('ST', 'HV', 'CH')),
  last_track_ch TEXT,
  last_class TEXT,
  last_distance_m INTEGER NOT NULL,
  last_draw INTEGER NOT NULL,
  running_positions TEXT,
  running_lanes TEXT,
  memo_ch TEXT NOT NULL,
  page_updated_at TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, horse_no)
);

CREATE INDEX IF NOT EXISTS idx_official_last_run_reminder_horse
  ON official_last_run_reminder (horse_id, meeting_date);
