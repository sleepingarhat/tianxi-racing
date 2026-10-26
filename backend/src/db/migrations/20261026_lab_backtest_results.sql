-- DRAFT ONLY — 唔好喺呢個 PR apply 去 production。
-- lab 回測結果快取（D1）。R2 features/{season}.json.gz binding 待開。

CREATE TABLE IF NOT EXISTS lab_backtest_results (
  hash TEXT PRIMARY KEY,
  params_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  series_json TEXT,
  matrix_version TEXT NOT NULL,
  matrix_source TEXT,
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_feature_matrix_meta (
  version TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- 'd1-cache' | 'actions-artifact' | 'r2'（r2 待開）
  note TEXT,
  race_count INTEGER,
  updated_at TEXT NOT NULL
);

-- 可選：逐場矩陣行（若唔用 R2／artifact 檔，可先落地 D1；体積極大時改 R2）
-- CREATE TABLE IF NOT EXISTS lab_feature_matrix_rows (
--   matrix_version TEXT NOT NULL,
--   race_id TEXT NOT NULL,
--   race_date TEXT NOT NULL,
--   payload_json TEXT NOT NULL,
--   PRIMARY KEY (matrix_version, race_id)
-- );
