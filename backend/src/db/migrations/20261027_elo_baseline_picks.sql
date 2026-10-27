-- elo_baseline_picks：預先物化純 Elo 頭四（同 backtest on-demand 邏輯）。
-- 手動 apply：wrangler d1 execute <DB> --remote --file=backend/src/db/migrations/20261027_elo_baseline_picks.sql
-- 未 apply 前：runCompare／runBacktest 仍由特徵矩陣 on-demand 排頭四（行為不變）。
-- 唔喺呢個 PR 自動 remote apply／全量 backfill。

CREATE TABLE IF NOT EXISTS elo_baseline_picks (
  race_id TEXT NOT NULL,
  matrix_version TEXT NOT NULL,
  pick1 INTEGER NOT NULL,
  pick2 INTEGER NOT NULL,
  pick3 INTEGER NOT NULL,
  pick4 INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (race_id, matrix_version)
);

CREATE INDEX IF NOT EXISTS idx_elo_baseline_picks_matrix
  ON elo_baseline_picks (matrix_version);

-- 可選 backfill（見 backend/scripts/backfill-elo-baseline-picks.md）：
-- 1) dump-features → 讀 matrix
-- 2) 每場 pickTop4(runners, [{id:'elo',weight:1}])
-- 3) INSERT OR REPLACE INTO elo_baseline_picks ...
