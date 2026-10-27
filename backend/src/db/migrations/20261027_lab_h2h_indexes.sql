-- lab h2h 查詢加速 index（self-join／條件切片）。
-- 手動 apply：wrangler d1 execute <DB> --remote --file=backend/src/db/migrations/20261027_lab_h2h_indexes.sql
-- 未 apply 前：頭對頭 API 仍用現有 idx_results_horse／idx_results_jockey／idx_results_race。
-- Elo 已有 idx_hes_axis／idx_jes_jockey；唔需要新表。
-- 驗證：EXPLAIN QUERY PLAN 對 lab-h2h loadResultRows。

CREATE INDEX IF NOT EXISTS idx_results_horse_race ON race_results(horse_id, race_id);
CREATE INDEX IF NOT EXISTS idx_results_jockey_race ON race_results(jockey_id, race_id);
