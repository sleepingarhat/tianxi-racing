-- Official HKJC horse race record, read from each horse's own profile page
-- (racing.hkjc.com/racing/information/Chinese/Horse/Horse.aspx?HorseNo=...).
-- One row per start with the page's own place, weight carried, margin and odds.
-- Weight carried is not body weight, so this table stays separate from
-- official_rating_weight. Research copy: not race results, not frozen prediction
-- input, not model features.

CREATE TABLE IF NOT EXISTS official_horse_record (
  horse_id TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  brand_no TEXT NOT NULL,
  season_label TEXT NOT NULL DEFAULT '',
  race_no_text TEXT NOT NULL,
  place_text TEXT NOT NULL,
  race_date TEXT NOT NULL,
  venue_text TEXT NOT NULL,
  distance_m INTEGER,
  going TEXT NOT NULL DEFAULT '',
  race_class TEXT NOT NULL DEFAULT '',
  draw INTEGER,
  rating INTEGER,
  trainer TEXT NOT NULL DEFAULT '',
  jockey TEXT NOT NULL DEFAULT '',
  winning_margin TEXT NOT NULL DEFAULT '',
  win_odds TEXT NOT NULL DEFAULT '',
  actual_weight_lbs INTEGER,
  running_position TEXT NOT NULL DEFAULT '',
  finish_time TEXT NOT NULL DEFAULT '',
  not_race_result INTEGER NOT NULL DEFAULT 1 CHECK (not_race_result = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_id, race_date, race_no_text)
);

CREATE INDEX IF NOT EXISTS idx_official_horse_record_date
  ON official_horse_record(race_date, horse_id);

CREATE INDEX IF NOT EXISTS idx_official_horse_record_brand
  ON official_horse_record(brand_no, race_date);
