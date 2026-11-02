-- HKJC Jockey Challenge / Trainer Challenge boards (騎師王坐騎表、練馬師王出馬表).
-- Research reference only: never a model input, never a frozen-pick input, never a race result.

CREATE TABLE IF NOT EXISTS official_challenge_pool (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  odds_type TEXT NOT NULL CHECK (odds_type IN ('JKC', 'TNC')),
  inst_no INTEGER NOT NULL,
  label_ch TEXT NOT NULL,
  pool_status TEXT NOT NULL,
  is_concluded INTEGER,
  include_races TEXT NOT NULL,
  inplay_up_to INTEGER,
  other_sel_no INTEGER,
  last_update_time TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, odds_type, inst_no)
);

CREATE TABLE IF NOT EXISTS official_challenge_selection (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  odds_type TEXT NOT NULL CHECK (odds_type IN ('JKC', 'TNC')),
  inst_no INTEGER NOT NULL,
  comb_id INTEGER,
  is_other INTEGER NOT NULL CHECK (is_other IN (0, 1)),
  person_code TEXT,
  person_name_ch TEXT,
  person_name_en TEXT,
  odds_text TEXT,
  open_odds_text TEXT,
  scheduled_rides INTEGER,
  final_order INTEGER,
  other_order INTEGER,
  accumulated_points TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_official_challenge_selection_meeting
  ON official_challenge_selection(meeting_date, venue, odds_type, inst_no);
CREATE INDEX IF NOT EXISTS idx_official_challenge_selection_person
  ON official_challenge_selection(odds_type, person_code, meeting_date);

CREATE TABLE IF NOT EXISTS official_challenge_ride (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  odds_type TEXT NOT NULL CHECK (odds_type IN ('JKC', 'TNC')),
  inst_no INTEGER NOT NULL,
  person_code TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  horse_id TEXT NOT NULL,
  points INTEGER,
  incident_type TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_official_challenge_ride_meeting
  ON official_challenge_ride(meeting_date, venue, odds_type, person_code);
