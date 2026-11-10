-- Surfaces collected by capy_wave6_surfaces.
-- Research and display copies. Not model inputs and not frozen picks.
-- Each statement stands alone so a table that already exists does not skip the rest.

CREATE TABLE IF NOT EXISTS official_horse_former_name (
  horse_id TEXT NOT NULL,
  horse_code TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ch TEXT,
  former_name TEXT,
  sire TEXT NOT NULL,
  dam TEXT NOT NULL,
  import_type TEXT NOT NULL,
  import_type_ch TEXT NOT NULL,
  origin_code TEXT NOT NULL,
  origin_ch TEXT NOT NULL,
  age INTEGER NOT NULL,
  foaling_date TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_id)
);

CREATE TABLE IF NOT EXISTS official_fwb_declared (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  is_reserve INTEGER NOT NULL CHECK (is_reserve IN (0, 1)),
  horse_name_en TEXT NOT NULL,
  horse_name_ch TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  bonus_en TEXT NOT NULL,
  bonus_ch TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, is_reserve, horse_no)
);

CREATE TABLE IF NOT EXISTS official_finish_photo (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_no INTEGER NOT NULL,
  photo_code TEXT NOT NULL,
  season_code TEXT NOT NULL,
  image_path TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, photo_code)
);

CREATE TABLE IF NOT EXISTS official_special_index (
  code TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  note_ch TEXT NOT NULL,
  not_race_result INTEGER NOT NULL CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (code)
);
