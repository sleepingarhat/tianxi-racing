-- DRAFT ONLY — 唔 apply 生產。
-- 夜間預計算 going_bias（venue × course × distance × going × draw）；
-- 賽日天氣快照 weather_snapshots（meeting 維度）。
-- 應用前需經研究閘；歷史統計唔入官方四揀。
-- 註：網站 Supabase 另有 public.weather_snapshots（場地即時歸檔）；本表係 D1／meeting 維度，唔重複取代。

CREATE TABLE IF NOT EXISTS going_bias (
  venue TEXT NOT NULL,                 -- ST / HV
  course TEXT NOT NULL DEFAULT '',     -- A / C+3 等；空字串＝全部賽道聚合
  distance INTEGER NOT NULL,
  going_bucket TEXT NOT NULL,         -- 好地／黏地／…
  draw INTEGER NOT NULL,               -- 1–14
  runners INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  top3 INTEGER NOT NULL DEFAULT 0,
  races INTEGER NOT NULL DEFAULT 0,
  delta_vs_avg REAL,                  -- top3_rate − 同過濾平均
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (venue, course, distance, going_bucket, draw)
);

CREATE INDEX IF NOT EXISTS idx_going_bias_lookup
  ON going_bias(venue, going_bucket, distance);

CREATE TABLE IF NOT EXISTS weather_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL,
  ts TEXT NOT NULL,                   -- ISO8601
  temp REAL,
  rh REAL,
  rain_mm REAL,
  wind_dir TEXT,
  wind_kmh REAL,
  soil_moisture REAL,
  source TEXT,                        -- hkjc / archive / …
  UNIQUE (meeting_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_weather_snapshots_meeting
  ON weather_snapshots(meeting_id, ts);
