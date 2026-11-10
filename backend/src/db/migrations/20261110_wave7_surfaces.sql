-- Surfaces collected by capy_wave7_surfaces.
-- Research and display copies. Not model inputs and not frozen picks.
-- Each statement stands alone so a table that already exists does not skip the rest.

CREATE TABLE IF NOT EXISTS official_stats_centre_image (
  slot TEXT NOT NULL CHECK (slot IN ('whos_hot', 'raceday_stats')),
  poster_date TEXT NOT NULL,
  window_end TEXT NOT NULL,
  last_update TEXT NOT NULL,
  image_path TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (slot)
);

CREATE TABLE IF NOT EXISTS official_horse_rating (
  board TEXT NOT NULL CHECK (board IN ('clas', 'csum', 'tp50')),
  line_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ch TEXT,
  rating INTEGER NOT NULL,
  change_text TEXT,
  mark_text TEXT,
  trainer_name TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (board, horse_code)
);

CREATE TABLE IF NOT EXISTS official_horse_rating_note (
  board TEXT NOT NULL CHECK (board IN ('clas', 'csum', 'tp50')),
  line_no INTEGER NOT NULL,
  note_ch TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (board, line_no)
);

CREATE TABLE IF NOT EXISTS official_horse_stakes (
  line_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  name_ch TEXT,
  name_en TEXT,
  wins INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  thirds INTEGER NOT NULL,
  fourths INTEGER NOT NULL,
  fifths INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  local_stakes INTEGER NOT NULL,
  overseas_stakes INTEGER NOT NULL,
  total_stakes INTEGER NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_code)
);

CREATE TABLE IF NOT EXISTS official_horse_stakes_note (
  line_no INTEGER NOT NULL,
  note_ch TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (line_no)
);

CREATE TABLE IF NOT EXISTS official_horse_news (
  view_code TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  title_ch TEXT NOT NULL,
  published_at TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  file_date TEXT NOT NULL,
  file_tag TEXT NOT NULL,
  venue TEXT CHECK (venue IS NULL OR venue IN ('ST', 'HV')),
  simulcast_code TEXT CHECK (simulcast_code IS NULL OR simulcast_code IN ('S1', 'S2', 'S3', 'S4')),
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (view_code, line_no)
);

CREATE TABLE IF NOT EXISTS official_horse_news_document (
  view_code TEXT NOT NULL,
  block_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paragraph', 'pdf')),
  text_ch TEXT,
  asset_path TEXT,
  file_name TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (view_code, block_no)
);

CREATE TABLE IF NOT EXISTS official_import_policy (
  page_code TEXT NOT NULL CHECK (page_code IN ('pps', 'ppgs')),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'exam_pdf', 'tab', 'paragraph', 'table_cell')),
  block_no INTEGER NOT NULL,
  row_no INTEGER NOT NULL,
  col_no INTEGER NOT NULL,
  text_ch TEXT,
  asset_path TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (page_code, kind, block_no, row_no, col_no)
);

CREATE TABLE IF NOT EXISTS official_racecard_runner (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  is_reserve INTEGER NOT NULL CHECK (is_reserve IN (0, 1)),
  horse_id TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  age INTEGER,
  sex TEXT,
  season_stakes INTEGER,
  owner TEXT,
  sire TEXT,
  dam TEXT,
  import_type TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, is_reserve, horse_no)
);

CREATE TABLE IF NOT EXISTS official_racecard_file (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('starter_pdf', 'starter_pdf_all', 'track_map', 'track_map_thumb')),
  artifact_path TEXT NOT NULL,
  distance INTEGER,
  surface_code TEXT,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, kind)
);
