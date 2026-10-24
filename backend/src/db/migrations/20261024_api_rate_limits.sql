-- 2026-10-24: D1 fixed-window rate limits for /api/chat and lounge posting.
--
-- OPTIONAL. The Worker creates this table itself (CREATE TABLE IF NOT EXISTS) on the
-- first rate-limited request, so the deploy works with or without applying this file.
-- Apply manually only if you prefer to create it ahead of time:
--   npx wrangler d1 execute tianxi-db --remote --file=src/db/migrations/20261024_api_rate_limits.sql

CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_expires ON api_rate_limits(expires_at);
