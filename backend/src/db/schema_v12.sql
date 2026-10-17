-- Elo v1.2 schema migration
-- Adds fields per 2026-04-28 HK-Native Time-Weighted spec.
-- Idempotent — safe to re-run.

-- Horse snapshots: v1.2 adds prior_rating, is_burnin, is_frozen, is_retired,
-- is_provisional, is_season_end, confidence, recency_weighted_games
ALTER TABLE horse_elo_snapshots ADD COLUMN prior_rating REAL;
ALTER TABLE horse_elo_snapshots ADD COLUMN is_burnin INTEGER DEFAULT 0;
ALTER TABLE horse_elo_snapshots ADD COLUMN is_frozen INTEGER DEFAULT 0;
ALTER TABLE horse_elo_snapshots ADD COLUMN is_retired INTEGER DEFAULT 0;
ALTER TABLE horse_elo_snapshots ADD COLUMN is_provisional INTEGER DEFAULT 0;
ALTER TABLE horse_elo_snapshots ADD COLUMN is_season_end INTEGER DEFAULT 0;
ALTER TABLE horse_elo_snapshots ADD COLUMN confidence REAL;
ALTER TABLE horse_elo_snapshots ADD COLUMN recency_weighted_games REAL;

ALTER TABLE jockey_elo_snapshots ADD COLUMN prior_rating REAL;
ALTER TABLE jockey_elo_snapshots ADD COLUMN is_burnin INTEGER DEFAULT 0;
ALTER TABLE jockey_elo_snapshots ADD COLUMN is_frozen INTEGER DEFAULT 0;
ALTER TABLE jockey_elo_snapshots ADD COLUMN is_retired INTEGER DEFAULT 0;
ALTER TABLE jockey_elo_snapshots ADD COLUMN is_provisional INTEGER DEFAULT 0;
ALTER TABLE jockey_elo_snapshots ADD COLUMN is_season_end INTEGER DEFAULT 0;
ALTER TABLE jockey_elo_snapshots ADD COLUMN confidence REAL;
ALTER TABLE jockey_elo_snapshots ADD COLUMN recency_weighted_games REAL;

ALTER TABLE trainer_elo_snapshots ADD COLUMN prior_rating REAL;
ALTER TABLE trainer_elo_snapshots ADD COLUMN is_burnin INTEGER DEFAULT 0;
ALTER TABLE trainer_elo_snapshots ADD COLUMN is_frozen INTEGER DEFAULT 0;
ALTER TABLE trainer_elo_snapshots ADD COLUMN is_retired INTEGER DEFAULT 0;
ALTER TABLE trainer_elo_snapshots ADD COLUMN is_provisional INTEGER DEFAULT 0;
ALTER TABLE trainer_elo_snapshots ADD COLUMN is_season_end INTEGER DEFAULT 0;
ALTER TABLE trainer_elo_snapshots ADD COLUMN confidence REAL;
ALTER TABLE trainer_elo_snapshots ADD COLUMN recency_weighted_games REAL;

-- Indexes for filtering out burn-in / frozen / retired at query time
CREATE INDEX IF NOT EXISTS idx_hes_active ON horse_elo_snapshots(horse_id, axis_key, is_retired, is_frozen, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_jes_active ON jockey_elo_snapshots(jockey_id, is_retired, is_frozen, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_tes_active ON trainer_elo_snapshots(trainer_id, is_retired, is_frozen, as_of_date DESC);

-- Run metadata: v1.2 labels its own runs and carries config fingerprint
ALTER TABLE elo_runs ADD COLUMN engine_version TEXT DEFAULT 'v1.1';
ALTER TABLE elo_runs ADD COLUMN tau_horse_days INTEGER;
ALTER TABLE elo_runs ADD COLUMN tau_jockey_days INTEGER;
ALTER TABLE elo_runs ADD COLUMN tau_trainer_days INTEGER;
ALTER TABLE elo_runs ADD COLUMN freeze_threshold_horse INTEGER;
ALTER TABLE elo_runs ADD COLUMN season_alpha_horse REAL;
