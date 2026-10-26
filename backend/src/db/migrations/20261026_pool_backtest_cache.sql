-- DRAFT ONLY — do not apply to production from this PR.
-- Optional cache for lab pool backtests (phase-2 / MVP stub).
CREATE TABLE IF NOT EXISTS pool_backtest_cache (
  id TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  method TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_backtest_hash ON pool_backtest_cache(params_hash);
