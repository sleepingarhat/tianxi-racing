-- HKJC pool board, official dividends and going probe readings (research / settlement reference).
-- Dividends are post-race facts: never a model or frozen-pick input. Rows are insert-or-ignore.
CREATE TABLE IF NOT EXISTS official_pool_status (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  odds_type TEXT NOT NULL,
  leg_no INTEGER NOT NULL,
  race_nos TEXT NOT NULL,
  sell_status TEXT,
  jackpot_hkd TEXT,
  estimated_dividend_hkd TEXT,
  merged_pool_id TEXT,
  rebate_rate INTEGER,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, odds_type, leg_no)
);
CREATE TABLE IF NOT EXISTS official_pool_dividend (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  odds_type TEXT NOT NULL,
  leg_no INTEGER NOT NULL,
  race_nos TEXT NOT NULL,
  dividend_type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  win_comb TEXT NOT NULL,
  dividend_hkd TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  partial_unit INTEGER NOT NULL DEFAULT 0,
  guarantee TEXT,
  status TEXT NOT NULL,
  post_race_only INTEGER NOT NULL DEFAULT 1 CHECK (post_race_only = 1),
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, odds_type, leg_no, dividend_type, seq, win_comb)
);
CREATE TABLE IF NOT EXISTS official_track_probe (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  instrument TEXT NOT NULL CHECK (instrument IN ('penetrometer', 'hammer')),
  reading_time TEXT NOT NULL,
  reading TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, instrument, reading_time)
);
