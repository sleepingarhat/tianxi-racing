-- Upcoming racecard headers: official title, prize, rating band, per-race going.
-- Fresh databases already have these columns via schema_v2.sql CREATE TABLE.
-- Existing D1 / scratch databases need ALTER. Re-runs raise "duplicate column
-- name"; scrape-racecard ensureSchema ignores that. The racecard workflow
-- checks PRAGMA table_info before altering remote D1.
ALTER TABLE entries_upcoming ADD COLUMN race_name TEXT;
ALTER TABLE entries_upcoming ADD COLUMN prize TEXT;
ALTER TABLE entries_upcoming ADD COLUMN rating_range TEXT;
ALTER TABLE entries_upcoming ADD COLUMN going TEXT;
