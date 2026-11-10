-- Official fixture calendar and pre-draw entry lists.
-- Written by capy_fixture_weekly and capy_entries. The Worker only reads them.
-- card_stage on official_race_entries stays 'entries': a barrier draw is a
-- different record (entries_upcoming), not a rewrite of this list.
--
-- Remote D1 already has entries_upcoming, so CREATE TABLE IF NOT EXISTS does
-- not add body_weight. scripts/d1-ensure-official-card-schema.sh applies this
-- file and 20261027_entries_upcoming_race_meta.sql one statement at a time,
-- before capy_d1_sync_entries inserts and before the Worker deploy. Do not
-- execute the whole file as one remote batch: the first "duplicate column"
-- aborts every later ALTER and rolls the batch back.

CREATE TABLE IF NOT EXISTS official_fixtures (
  date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  weekday TEXT,
  timing TEXT,
  race_count INTEGER,
  surface TEXT,
  captured_at TEXT,
  PRIMARY KEY (date, venue)
);

CREATE INDEX IF NOT EXISTS idx_official_fixtures_month
  ON official_fixtures(date);

CREATE TABLE IF NOT EXISTS official_race_entries (
  race_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  race_number INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_name TEXT NOT NULL,
  trainer_name TEXT,
  race_class TEXT,
  distance INTEGER,
  track TEXT,
  rating_range TEXT,
  race_name TEXT,
  section_label TEXT,
  card_stage TEXT NOT NULL DEFAULT 'entries' CHECK (card_stage = 'entries'),
  draw_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (draw_status = 'unavailable'),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (race_date, venue, race_number, horse_code)
);

CREATE INDEX IF NOT EXISTS idx_official_race_entries_date
  ON official_race_entries(race_date, venue);

-- Fields already returned by the whitelisted racecard query, previously dropped.
-- body_weight is 排位體重. declared_weight stays 負磅.
ALTER TABLE entries_upcoming ADD COLUMN body_weight INTEGER;
ALTER TABLE entries_upcoming ADD COLUMN allowance REAL;
ALTER TABLE entries_upcoming ADD COLUMN international_rating INTEGER;
ALTER TABLE entries_upcoming ADD COLUMN last6run TEXT;
ALTER TABLE entries_upcoming ADD COLUMN silk_file TEXT;
ALTER TABLE entries_upcoming ADD COLUMN card_stage TEXT;

-- Repair a remote official_race_entries created without the identity columns.
-- A fresh CREATE TABLE above already includes both; statement-at-a-time apply
-- skips these when the column is present.
ALTER TABLE official_race_entries ADD COLUMN card_stage TEXT NOT NULL DEFAULT 'entries' CHECK (card_stage = 'entries');
ALTER TABLE official_race_entries ADD COLUMN draw_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (draw_status = 'unavailable');
