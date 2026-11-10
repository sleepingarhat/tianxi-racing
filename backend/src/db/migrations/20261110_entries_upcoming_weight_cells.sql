-- Racecard 可能超磅 and 分齡讓磅. The whitelisted GraphQL query does not
-- carry them. Applied one statement at a time. A duplicate column is the
-- column already being there, not a reason to skip the rest.
-- Display fields only. They are not a model input and not a frozen-pick input.

ALTER TABLE entries_upcoming ADD COLUMN possible_overweight INTEGER;
ALTER TABLE entries_upcoming ADD COLUMN age_allowance INTEGER;
