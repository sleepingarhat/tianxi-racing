-- Official HKJC P2 boards (research copies).
-- These rows are the public ranking / draw / JKC / favourite / allowance /
-- new-horse blurb / owner-search index. They are not race results, not
-- frozen prediction text, and not model features.
-- Draw and new-horse rows are historical windows or intro copy: not_race_result
-- is constrained to 1 so they cannot be stamped as a race outcome.

CREATE TABLE IF NOT EXISTS official_ranking_board (
  role TEXT NOT NULL CHECK (role IN ('jockey', 'trainer')),
  season_code TEXT NOT NULL,
  season_scope TEXT NOT NULL CHECK (season_scope IN ('current', 'previous')),
  as_of_date TEXT NOT NULL,
  as_of_kind TEXT NOT NULL CHECK (as_of_kind IN ('last_meeting', 'season_end')),
  racecourse TEXT NOT NULL CHECK (racecourse IN ('ALL', 'STT', 'STA', 'HVT', 'CHT', 'CHA')),
  view_basis TEXT NOT NULL DEFAULT 'Numbers' CHECK (view_basis = 'Numbers'),
  person_code TEXT NOT NULL,
  name_ch TEXT NOT NULL,
  name_en TEXT NOT NULL,
  status TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('service', 'other', 'previous')),
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  fourths INTEGER NOT NULL,
  fifths INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  stake_won REAL,
  dh_wins INTEGER NOT NULL,
  dh_seconds INTEGER NOT NULL,
  dh_thirds INTEGER NOT NULL,
  dh_fourths INTEGER NOT NULL,
  dh_fifths INTEGER NOT NULL,
  board_rank INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, season_code, racecourse, person_code, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_official_ranking_board_asof
  ON official_ranking_board(role, as_of_date, racecourse);

CREATE TABLE IF NOT EXISTS official_ranking_slice (
  role TEXT NOT NULL CHECK (role IN ('jockey', 'trainer')),
  season_code TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  person_code TEXT NOT NULL,
  stat_set TEXT NOT NULL CHECK (stat_set IN ('ssn', 'dh')),
  slice_index INTEGER NOT NULL,
  ven TEXT NOT NULL,
  trk TEXT NOT NULL,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  fourths INTEGER NOT NULL,
  fifths INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  stake_won REAL NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, season_code, as_of_date, person_code, stat_set, slice_index)
);

CREATE TABLE IF NOT EXISTS official_draw_stat (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  distance_m INTEGER NOT NULL,
  course_label TEXT NOT NULL,
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
  stat_window TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, draw)
);

CREATE INDEX IF NOT EXISTS idx_official_draw_stat_meeting
  ON official_draw_stat(meeting_date, venue, race_no);

CREATE TABLE IF NOT EXISTS official_draw_favourite (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  distance_m INTEGER NOT NULL,
  course_label TEXT NOT NULL,
  win_pct INTEGER NOT NULL,
  place_pct INTEGER NOT NULL,
  top4_pct INTEGER NOT NULL,
  stat_window TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no)
);

CREATE TABLE IF NOT EXISTS official_pool_stat (
  pool TEXT NOT NULL CHECK (pool IN ('jkc', 'tnc')),
  as_of_date TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('ranked', 'other')),
  rank_no INTEGER,
  person_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('meeting', 'recent_avg', 'season_avg', 'quarter_avg')),
  column_label TEXT NOT NULL,
  meeting_date TEXT,
  points_text TEXT NOT NULL,
  points_value REAL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (pool, as_of_date, person_name, kind, column_label)
);

CREATE INDEX IF NOT EXISTS idx_official_pool_stat_asof
  ON official_pool_stat(pool, as_of_date, meeting_date);

CREATE TABLE IF NOT EXISTS official_favourite_stat (
  role TEXT NOT NULL CHECK (role IN ('jockey', 'trainer')),
  as_of_date TEXT NOT NULL,
  person_name TEXT NOT NULL,
  starts INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  places INTEGER NOT NULL,
  hot_count INTEGER NOT NULL,
  hot_pct INTEGER NOT NULL,
  hot_wins INTEGER NOT NULL,
  hot_win_pct INTEGER NOT NULL,
  hot_places INTEGER NOT NULL,
  hot_place_pct INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, as_of_date, person_name)
);

CREATE TABLE IF NOT EXISTS official_favourite_summary (
  role TEXT NOT NULL CHECK (role IN ('jockey', 'trainer')),
  as_of_date TEXT NOT NULL,
  label TEXT NOT NULL,
  value_text TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (role, as_of_date, label)
);

CREATE TABLE IF NOT EXISTS official_jockey_allowance (
  as_of_date TEXT NOT NULL,
  person_name TEXT NOT NULL,
  wins INTEGER NOT NULL,
  allowance_lb INTEGER,
  allowance_text TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (as_of_date, person_name)
);

CREATE TABLE IF NOT EXISTS official_owner_horse (
  owner_name TEXT NOT NULL,
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  horse_code TEXT NOT NULL,
  quoted_count INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (owner_name, horse_id)
);

CREATE INDEX IF NOT EXISTS idx_official_owner_horse_code
  ON official_owner_horse(horse_code);

CREATE TABLE IF NOT EXISTS official_new_horse_intro (
  meeting_date TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  race_no TEXT NOT NULL,
  horse_no TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  body_text TEXT NOT NULL,
  origin TEXT NOT NULL,
  colour TEXT NOT NULL,
  import_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  PRIMARY KEY (meeting_date, brand_no, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_official_new_horse_intro_asof
  ON official_new_horse_intro(as_of_date, brand_no);
