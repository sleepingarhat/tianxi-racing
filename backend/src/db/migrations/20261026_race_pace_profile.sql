-- DRAFT ONLY — 唔 apply 生產。
-- 賽果入庫後可預計算 race_pace_profile（早／中／末段步速指數）。
-- 應用前需經研究閘；節奏提示唔入官方四揀。

CREATE TABLE IF NOT EXISTS race_pace_profile (
  race_id TEXT PRIMARY KEY,
  early_idx REAL,
  mid_idx REAL,
  late_idx REAL,
  pace_label TEXT,          -- 快／中／慢
  n_leaders INTEGER,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_race_pace_profile_label
  ON race_pace_profile(pace_label);
