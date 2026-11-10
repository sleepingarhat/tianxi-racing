-- Racecard columns the whitelisted GraphQL query does not carry.
-- Applied one statement at a time. A duplicate column is the column already
-- being there, not a reason to skip the rest.
-- Display fields only. They are not a model input and not a frozen-pick input.

ALTER TABLE entries_upcoming ADD COLUMN rating_change INTEGER;
ALTER TABLE entries_upcoming ADD COLUMN body_weight_change INTEGER;
ALTER TABLE entries_upcoming ADD COLUMN best_time TEXT;
ALTER TABLE entries_upcoming ADD COLUMN days_since_run INTEGER;
