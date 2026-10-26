-- DRAFT ONLY — 唔自動 apply 生產。P1 通知新事件類型（計劃 f6 剩餘）。
-- Worker 寫入；Lovable cron 經 GET /api/notify/events 拉走。Worker 唔知用戶。

CREATE TABLE IF NOT EXISTS notify_events (
  event_key TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('lock_complete', 'top4_lock', 'daily_pnl')),
  meeting_date TEXT,
  venue TEXT,
  race_number INTEGER,
  horse_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notify_events_created ON notify_events (created_at);
CREATE INDEX IF NOT EXISTS idx_notify_events_type_created ON notify_events (type, created_at);
CREATE INDEX IF NOT EXISTS idx_notify_events_horse ON notify_events (horse_id, created_at);
