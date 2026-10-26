-- 2026-10-26: Public read-only API v1 keys + daily usage (DRAFT — do not apply to production yet).
--
-- Auth: Authorization: Bearer tx_live_… ; D1 stores SHA-256 hex of full key only.
-- Rate limits: suggested 60/min + 5000/day per key (enforced in Worker via D1 / in-memory;
-- Cloudflare Rate Limiting binding optional later).
--
-- Apply manually only after review:
--   npx wrangler d1 execute tianxi-db --remote --file=src/db/migrations/20261026_api_v1_keys.sql

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'elo,picks,features',
  entitlement_until TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  label TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS api_usage_daily (
  key_id TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, date)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_daily_date ON api_usage_daily(date);
