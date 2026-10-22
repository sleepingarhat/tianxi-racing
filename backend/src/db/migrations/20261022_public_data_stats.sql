-- 2026-10-22: public data-volume stats (single source of truth for site / README numbers).
--
-- OPTIONAL. The Worker creates this table itself (CREATE TABLE IF NOT EXISTS) the
-- first time the daily 06:00 HKT cron or a cold request writes the stats, so the
-- deploy works with or without applying this file first. Apply only if you prefer
-- schema to exist up front:
--   npx wrangler d1 execute tianxi-db --remote --file=./src/db/migrations/20261022_public_data_stats.sql
--
-- One row (key 'public:v1') holding the JSON returned by GET /api/analyze/data-stats.
-- Derived data: deleting it is always safe (next request/cron recomputes).
CREATE TABLE IF NOT EXISTS public_data_stats (
  key          TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  computed_at  TEXT NOT NULL
);
