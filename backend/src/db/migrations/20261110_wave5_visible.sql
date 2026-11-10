-- Visible official boards collected by capy_wave5_visible.
-- Research copies. Not race results, not model inputs, not frozen picks.
-- Each statement stands alone so a table that already exists does not skip the rest.

CREATE TABLE IF NOT EXISTS official_ove_database (
  as_of_date TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_name TEXT,
  injury_date TEXT NOT NULL,
  detail TEXT NOT NULL,
  passed_date TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (as_of_date, line_no)
);

CREATE TABLE IF NOT EXISTS official_ove_record (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  is_reserve INTEGER NOT NULL CHECK (is_reserve IN (0, 1)),
  horse_code TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  injury_date TEXT NOT NULL,
  detail TEXT NOT NULL,
  passed_date TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, line_no)
);

CREATE TABLE IF NOT EXISTS official_ppo_performance (
  season_code TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  horse_name_ch TEXT,
  former_name TEXT NOT NULL,
  notes TEXT,
  show_play INTEGER NOT NULL CHECK (show_play IN (0, 1)),
  season_enabled INTEGER NOT NULL CHECK (season_enabled IN (0, 1)),
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (season_code, brand_no)
);

CREATE TABLE IF NOT EXISTS official_challenge_odds (
  pool TEXT NOT NULL CHECK (pool IN ('jkc', 'tnc')),
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  winner_code TEXT NOT NULL,
  winner_name TEXT NOT NULL,
  points INTEGER NOT NULL,
  race_no INTEGER NOT NULL,
  odds_text TEXT NOT NULL,
  chart_updated_at TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (pool, meeting_date, venue, winner_code, race_no)
);

CREATE TABLE IF NOT EXISTS official_jt_combo (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  section TEXT NOT NULL CHECK (section IN ('combo', 'debut')),
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  horse_name TEXT,
  import_type TEXT,
  trainer_name TEXT,
  win_rate TEXT NOT NULL,
  place_rate TEXT NOT NULL,
  as_of_text TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, section, race_no, horse_no)
);

CREATE TABLE IF NOT EXISTS official_conghua_movement (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  is_reserve INTEGER NOT NULL CHECK (is_reserve IN (0, 1)),
  horse_name_ch TEXT NOT NULL,
  horse_name_en TEXT NOT NULL,
  arrived_date TEXT NOT NULL,
  returned_date TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, line_no)
);
