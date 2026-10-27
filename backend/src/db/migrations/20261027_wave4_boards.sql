-- Official HKJC Wave4 boards (research copies).
-- Horse rating/weight curve, distance performance, stable movements, overoar
-- list, JKC/TNC meeting results and draw advanced-search grids. They are not
-- race results, not frozen prediction text, and not model features.
-- not_race_result is constrained to 1 so these rows cannot be stamped as a
-- race outcome.

CREATE TABLE IF NOT EXISTS official_rating_weight (
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  race_date TEXT NOT NULL,
  rating INTEGER,
  finish_text TEXT NOT NULL,
  body_weight INTEGER,
  venue TEXT NOT NULL,
  track TEXT NOT NULL,
  distance_m INTEGER,
  course_label TEXT NOT NULL DEFAULT '',
  going TEXT NOT NULL DEFAULT '',
  race_class TEXT NOT NULL DEFAULT '',
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_id, race_date)
);

CREATE INDEX IF NOT EXISTS idx_official_rating_weight_date
  ON official_rating_weight(race_date, horse_id);

CREATE TABLE IF NOT EXISTS official_performance (
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('going', 'distance', 'season')),
  label_a TEXT NOT NULL,
  label_b TEXT NOT NULL,
  starts INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_id, section, label_a, label_b)
);

CREATE TABLE IF NOT EXISTS official_movement (
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  from_loc TEXT NOT NULL,
  to_loc TEXT NOT NULL,
  arrive_date TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_id, arrive_date, from_loc, to_loc)
);

CREATE INDEX IF NOT EXISTS idx_official_movement_date
  ON official_movement(arrive_date, horse_id);

CREATE TABLE IF NOT EXISTS official_overoar (
  as_of_date TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  diagnosis_date TEXT NOT NULL,
  surgery TEXT NOT NULL CHECK (surgery IN ('Y', 'N')),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (brand_no)
);

CREATE TABLE IF NOT EXISTS official_pool_result (
  pool TEXT NOT NULL CHECK (pool IN ('jkc', 'tnc')),
  meeting_date TEXT NOT NULL,
  rank_no INTEGER NOT NULL,
  person_name TEXT NOT NULL,
  points INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  fourths INTEGER NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (pool, meeting_date, person_name)
);

CREATE INDEX IF NOT EXISTS idx_official_pool_result_meeting
  ON official_pool_result(pool, meeting_date);

CREATE TABLE IF NOT EXISTS official_draw_adv_stat (
  season_code TEXT NOT NULL,
  racecourse TEXT NOT NULL CHECK (racecourse IN ('STT', 'STA', 'HVT', 'CHT')),
  course_label TEXT NOT NULL DEFAULT '',
  distance_m INTEGER NOT NULL,
  going TEXT NOT NULL DEFAULT 'ALL' CHECK (going = 'ALL'),
  draw INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  fourths INTEGER NOT NULL,
  win_pct INTEGER NOT NULL,
  quinella_pct INTEGER NOT NULL,
  place_pct INTEGER NOT NULL,
  top4_pct INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (season_code, racecourse, course_label, distance_m, going, draw)
);

CREATE INDEX IF NOT EXISTS idx_official_draw_adv_stat_lookup
  ON official_draw_adv_stat(racecourse, distance_m, season_code);
