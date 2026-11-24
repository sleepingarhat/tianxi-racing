-- Surfaces collected by capy_wave8_surfaces.
-- Copies of official pages. Not model inputs and not frozen picks.
-- Each statement stands alone so a table that already exists does not skip the rest.

CREATE TABLE IF NOT EXISTS official_fixture_line (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  class_code TEXT NOT NULL,
  distance INTEGER NOT NULL,
  race_count INTEGER NOT NULL,
  course_text TEXT,
  rating_band TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, line_no)
);

CREATE TABLE IF NOT EXISTS official_results_all_runner (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  section TEXT NOT NULL,
  place_label TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  placing_text TEXT NOT NULL,
  horse_no TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  jockey_name TEXT NOT NULL,
  trainer_name TEXT NOT NULL,
  actual_weight INTEGER,
  draw INTEGER,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, line_no)
);

CREATE TABLE IF NOT EXISTS official_results_all_dividend (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  section TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  pool_name TEXT NOT NULL,
  combination TEXT NOT NULL,
  dividend_text TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, line_no)
);

CREATE TABLE IF NOT EXISTS official_same_sire_page (
  sire_name TEXT NOT NULL,
  horse_count INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (sire_name)
);

CREATE TABLE IF NOT EXISTS official_same_sire (
  sire_name TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  horse_name TEXT NOT NULL,
  retired INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  winning_distance TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (sire_name, line_no)
);

CREATE TABLE IF NOT EXISTS official_horse_directory_page (
  list_kind TEXT NOT NULL,
  list_key TEXT NOT NULL,
  list_label TEXT NOT NULL,
  horse_count INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (list_kind, list_key)
);

CREATE TABLE IF NOT EXISTS official_horse_directory (
  list_kind TEXT NOT NULL,
  list_key TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  rating INTEGER,
  list_label TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (list_kind, list_key, horse_id)
);

CREATE TABLE IF NOT EXISTS official_person_season (
  role TEXT NOT NULL,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  season_label TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  nationality TEXT,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  fourths INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  stakes_hkd INTEGER,
  win_rate TEXT NOT NULL,
  last10_wins INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, person_id, season_label)
);

CREATE TABLE IF NOT EXISTS official_person_winstat (
  role TEXT NOT NULL,
  person_id TEXT NOT NULL,
  season_label TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  venue_label TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  surface_label TEXT,
  surface_code TEXT,
  distance INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, person_id, season_label, line_no)
);

CREATE TABLE IF NOT EXISTS official_wind_meeting (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  status TEXT,
  race_count INTEGER NOT NULL,
  meeting_track_ch TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue)
);

CREATE TABLE IF NOT EXISTS official_wind_going (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  going_ch TEXT,
  track_code TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no)
);

CREATE TABLE IF NOT EXISTS official_wind_probe (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  instrument TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  reading_time TEXT,
  reading TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, instrument, sequence_no)
);

CREATE TABLE IF NOT EXISTS official_wind_station (
  racecourse TEXT NOT NULL,
  location TEXT NOT NULL,
  observed_date TEXT NOT NULL,
  observed_time TEXT NOT NULL,
  wind_direction TEXT,
  wind_speed TEXT,
  gust_direction TEXT,
  gust_speed TEXT,
  humidity TEXT,
  temperature TEXT,
  solar_radiation TEXT,
  sunshine_hour TEXT,
  pressure TEXT,
  gust_speed_daily_max TEXT,
  humidity_daily_max TEXT,
  humidity_daily_min TEXT,
  temperature_daily_max TEXT,
  temperature_daily_min TEXT,
  rain_1min TEXT,
  rain_10min TEXT,
  rain_daily TEXT,
  soil_water TEXT,
  soil_loss_1min TEXT,
  soil_loss_daily TEXT,
  soil_loss_24h TEXT,
  status TEXT,
  is_valid INTEGER NOT NULL,
  gps_position TEXT,
  supply_voltage TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (racecourse, observed_date, observed_time)
);

CREATE TABLE IF NOT EXISTS official_wind_section (
  racecourse TEXT NOT NULL,
  location TEXT NOT NULL,
  observed_date TEXT NOT NULL,
  observed_time TEXT NOT NULL,
  wind_direction TEXT,
  wind_speed TEXT,
  gust_direction TEXT,
  gust_speed TEXT,
  status TEXT,
  is_valid INTEGER NOT NULL,
  gps_position TEXT,
  supply_voltage TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (racecourse, location, observed_date, observed_time)
);
