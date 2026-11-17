-- Official single-race void (e.g. 2026-11-14 ST race 6).
-- Additive only. Existing rows stay NULL status, which means the race was run.
ALTER TABLE races ADD COLUMN status TEXT;
ALTER TABLE races ADD COLUMN official_note TEXT;
