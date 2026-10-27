-- Official HKJC race-day companion boards.
-- Last-start comments, previous meetings, exceptional factors, the day's
-- veterinary list, meeting trackwork, jockey/trainer rides, and the summary
-- going sentence / pool list / suspensions. These rows are not race results,
-- not frozen prediction text, and not model features. not_race_result is
-- constrained to 1. Summary dividends, jackpots and penetrometer readings
-- are not columns here.

CREATE TABLE IF NOT EXISTS official_race_report_ext (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  runner_section TEXT NOT NULL CHECK (runner_section IN ('declared', 'standby')),
  horse_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  previous_run_date TEXT,
  previous_race_label TEXT,
  previous_race_no INTEGER,
  previous_venue TEXT,
  description TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, runner_section, horse_no)
);

CREATE INDEX IF NOT EXISTS idx_official_race_report_ext_horse
  ON official_race_report_ext(horse_id, meeting_date);

CREATE TABLE IF NOT EXISTS official_formline (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  prior_date TEXT NOT NULL,
  prior_race_label TEXT NOT NULL,
  prior_race_no INTEGER NOT NULL,
  prior_venue TEXT NOT NULL,
  prior_distance_m INTEGER NOT NULL,
  prior_class TEXT NOT NULL,
  prior_rail TEXT,
  prior_going TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  horse_name TEXT NOT NULL,
  weight_text TEXT NOT NULL,
  weight_lb INTEGER NOT NULL,
  prior_weight_lb INTEGER NOT NULL,
  rating_text TEXT NOT NULL,
  rating INTEGER NOT NULL,
  prior_rating INTEGER NOT NULL,
  draw_text TEXT NOT NULL,
  draw INTEGER NOT NULL,
  prior_draw INTEGER NOT NULL,
  jockey_name TEXT NOT NULL,
  prior_jockey_name TEXT NOT NULL,
  placing TEXT NOT NULL,
  finish_time TEXT NOT NULL,
  margin TEXT,
  odds_text TEXT,
  weight_diff TEXT,
  rating_diff TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, prior_date, prior_race_label, horse_name)
);

CREATE INDEX IF NOT EXISTS idx_official_formline_prior
  ON official_formline(prior_date, prior_venue, prior_race_no);

CREATE TABLE IF NOT EXISTS official_exceptional_factor (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  horse_name TEXT NOT NULL,
  weight_loss INTEGER,
  age_allowance INTEGER,
  gear TEXT,
  tongue_tie TEXT,
  previous_bit TEXT,
  current_bit TEXT,
  rating_change TEXT,
  distance_change TEXT,
  days_since INTEGER,
  trainer_change TEXT,
  conghua_return_date TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, horse_no)
);

CREATE TABLE IF NOT EXISTS official_veterinary_record (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  injury_date TEXT NOT NULL,
  detail TEXT NOT NULL,
  passed_date TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, horse_no, line_no)
);

CREATE INDEX IF NOT EXISTS idx_official_veterinary_record_horse
  ON official_veterinary_record(horse_id, injury_date);

CREATE TABLE IF NOT EXISTS official_meeting_trackwork (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  runner_section TEXT NOT NULL CHECK (runner_section IN ('declared', 'standby')),
  horse_no INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('declared', 'trial', 'gallop', 'trot', 'swim', 'treadmill', 'aqua', 'spell')),
  line_no INTEGER NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  trainer_code TEXT NOT NULL,
  trainer_name TEXT NOT NULL,
  recent_form TEXT,
  work_date TEXT,
  body_text TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, runner_section, horse_no, category, line_no)
);

CREATE INDEX IF NOT EXISTS idx_official_meeting_trackwork_horse
  ON official_meeting_trackwork(horse_id, work_date);

CREATE TABLE IF NOT EXISTS official_ride_assignment (
  role TEXT NOT NULL CHECK (role IN ('jockey', 'trainer')),
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name_ch TEXT NOT NULL,
  horse_no INTEGER,
  runner_status TEXT NOT NULL,
  race_status TEXT NOT NULL,
  person_code TEXT NOT NULL,
  person_name_ch TEXT NOT NULL,
  person_name_en TEXT NOT NULL,
  win_odds_text TEXT,
  jockey_changed INTEGER NOT NULL CHECK (jockey_changed IN (0, 1)),
  trainer_preference TEXT,
  trump_card INTEGER CHECK (trump_card IN (0, 1)),
  priority INTEGER CHECK (priority IN (0, 1)),
  class_code TEXT NOT NULL,
  distance_m INTEGER NOT NULL,
  track_code TEXT NOT NULL,
  track_label TEXT NOT NULL,
  track_description_ch TEXT NOT NULL,
  season_wins INTEGER,
  season_seconds INTEGER,
  season_thirds INTEGER,
  season_starts INTEGER,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, meeting_date, venue, race_no, horse_code)
);

CREATE INDEX IF NOT EXISTS idx_official_ride_assignment_person
  ON official_ride_assignment(role, meeting_date, person_code);

CREATE TABLE IF NOT EXISTS official_meeting_summary (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  meeting_track_ch TEXT NOT NULL,
  race_count INTEGER NOT NULL,
  going_sentence TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue)
);

CREATE TABLE IF NOT EXISTS official_meeting_going (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  track_code TEXT NOT NULL,
  going_code TEXT NOT NULL,
  track_label TEXT NOT NULL,
  track_description_ch TEXT NOT NULL,
  going_ch TEXT NOT NULL,
  race_nos TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, track_code, going_code)
);

CREATE TABLE IF NOT EXISTS official_meeting_pool (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  pool_kind TEXT NOT NULL CHECK (pool_kind IN ('pm', 'fo')),
  odds_type TEXT NOT NULL,
  leg_or_inst INTEGER NOT NULL,
  race_nos TEXT,
  label_ch TEXT,
  sell_status TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, pool_kind, odds_type, leg_or_inst)
);

CREATE TABLE IF NOT EXISTS official_jockey_suspension (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  jockey_id TEXT NOT NULL,
  commenced_on TEXT NOT NULL,
  spsn_typ TEXT NOT NULL,
  jockey_code TEXT NOT NULL,
  jockey_name_ch TEXT NOT NULL,
  resumed_on TEXT NOT NULL,
  detail_ch TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, jockey_id, commenced_on, spsn_typ)
);

CREATE TABLE IF NOT EXISTS official_meeting_steward (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  sequence_number INTEGER NOT NULL,
  name_ch TEXT NOT NULL,
  name_en TEXT,
  role_code TEXT NOT NULL,
  role_ch TEXT,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, sequence_number)
);
