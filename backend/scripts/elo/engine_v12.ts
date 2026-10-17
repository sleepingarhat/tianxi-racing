/**
 * Elo v1.2 engine — HK-Native Time-Weighted Multi-Axis
 *
 * User-endorsed spec 2026-04-28. Upgrades over v1.1:
 *
 *  1. Time-weighted K: older races contribute less.
 *       K_effective = K_base × exp(-Δt_days / τ) × w_provisional
 *     where Δt is days between current race and the race being rated against
 *     (i.e. "how long ago is the knowledge encoded in R_current from").
 *     τ (tau) is the exponential decay time-constant per entity type:
 *       Horse   τ = 548  days (~1.5 years relevance half-life at w≈0.37)
 *       Jockey  τ = 730  days (~2 years — careers longer + more stable)
 *       Trainer τ = 1095 days (~3 years — slowest-moving)
 *
 *  2. Per-axis K base:
 *       Horse   K_base = 28  (narrower range, many races)
 *       Jockey  K_base = 18
 *       Trainer K_base = 11
 *
 *  3. Provisional modifier w_provisional:
 *       games_played < 6  →  w = 1.5   (learn fast)
 *       6 ≤ games < 20    →  w = 1.0
 *       games ≥ 20        →  w = 1.0   (unchanged — we rely on time-decay alone)
 *       Also: is_provisional flag stored for downstream consumers.
 *
 *  4. Burn-in period 2016-2017 (hard gate): snapshots written with is_burnin=1.
 *     Models MUST filter `WHERE is_burnin = 0 AND as_of_date >= '2018-01-01'` for train/validate.
 *
 *  5. Foreign-import priors (prior_rating): imported horses / international jockeys
 *     start at 1580 / 1550 instead of the generic 1500. Prior is applied only at init
 *     (first race), NOT re-applied on decay.
 *
 *  6. Freeze (not decay) on inactivity:
 *       Horse    > 365 days idle  → is_frozen = 1, no rating change
 *       Jockey   > 730 days idle  → is_frozen = 1
 *       Trainer  > 730 days idle  → is_frozen = 1
 *     Plus retirement flag:
 *       Horse    > 720 days idle  → is_retired = 1 (exclude from live lookup)
 *       Jockey   > 1095 days idle → is_retired = 1
 *       Trainer  > 1095 days idle → is_retired = 1
 *     Rationale: time-weighted K already down-weights stale contributions; an extra
 *     idle-decay R = 0.9R + 0.1·1500 over-corrects. Freeze preserves historical rating
 *     until the entity races again, which is what HK trainers actually observe.
 *
 *  7. End-of-season (7/31) mean regression:
 *       Every year on end-of-season date, apply:
 *         R_new = (1-α) · R_old + α · 1500
 *       where α per axis:
 *         Horse     α = 0.05  (some regression to mean over summer break)
 *         Jockey    α = 0.02
 *         Trainer   α = 0.02
 *       Flagged with is_season_end = 1 on first post-season race.
 *
 *  8. Confidence score per snapshot (0..1):
 *       confidence = min(1, games_played/20) × (1 - exp(-recency_weighted_games/6))
 *     stored so downstream can weight predictions.
 *
 * Design-doc reference: MEMORY.md §Prediction logic spec · 2026-04-28 directive.
 */

import { DEFAULT_CONFIG, type EloConfig, expectedScore } from './engine.js';

export type AxisType = 'horse' | 'jockey' | 'trainer';

export interface V12AxisState {
  rating: number;
  gamesPlayed: number;
  recencyWeightedGames: number;   // Σ exp(-Δt/τ) × 1 per past race
  lastRaceDate: string | null;
  priorRating: number;             // what this entity started at (default 1500)
  lastSeasonEndApplied: string | null; // YYYY for regression idempotency
  isFrozen: boolean;
  isRetired: boolean;
}

export interface V12Config {
  k: number;
  initialRating: number;
  tauDays: number;            // exponential decay constant
  freezeThresholdDays: number;
  retireThresholdDays: number;
  seasonEndMonth: number;     // HK season ends 7/31 (UK/EU style)
  seasonEndDay: number;
  seasonAlpha: number;        // mean-regression coefficient α
  provisionalGamesThreshold: number;
  provisionalMultiplier: number;
  burnInToDate: string;       // YYYY-MM-DD — races ≤ this date flagged is_burnin
}

export const V12_DEFAULTS: Record<AxisType, V12Config> = {
  horse: {
    k: 28,
    initialRating: 1500,
    tauDays: 548,
    freezeThresholdDays: 365,
    retireThresholdDays: 720,
    seasonEndMonth: 7,
    seasonEndDay: 31,
    seasonAlpha: 0.05,
    provisionalGamesThreshold: 6,
    provisionalMultiplier: 1.5,
    burnInToDate: '2017-12-31',
  },
  jockey: {
    k: 18,
    initialRating: 1500,
    tauDays: 730,
    freezeThresholdDays: 730,
    retireThresholdDays: 1095,
    seasonEndMonth: 7,
    seasonEndDay: 31,
    seasonAlpha: 0.02,
    provisionalGamesThreshold: 6,
    provisionalMultiplier: 1.5,
    burnInToDate: '2017-12-31',
  },
  trainer: {
    k: 11,
    initialRating: 1500,
    tauDays: 1095,
    freezeThresholdDays: 730,
    retireThresholdDays: 1095,
    seasonEndMonth: 7,
    seasonEndDay: 31,
    seasonAlpha: 0.02,
    provisionalGamesThreshold: 6,
    provisionalMultiplier: 1.5,
    burnInToDate: '2017-12-31',
  },
};

// Import-prior map — inferred from HKJC horse code prefix or jockey license origin.
// Pipelined: the batch driver calls resolvePriorRating(...) at entity-init time.
export const IMPORT_PRIORS = {
  horse: {
    defaultLocal: 1500,
    foreignImport: 1580,   // horse_profiles.import_type IN ('GR','ISG','PPG','Imported')
    privatePurchase: 1560, // 'PP'
  },
  jockey: {
    defaultLocal: 1500,
    visitingInternational: 1550, // jockey_profile.nationality / visiting flag
  },
  trainer: {
    defaultLocal: 1500,
  },
} as const;

function daysBetween(fromDate: string, toDate: string): number {
  const ms = Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z');
  return Math.round(ms / 86_400_000);
}

/**
 * Compute effective K for one pair (i, j) in a race at date `raceDate`.
 * Time-weighting applies on TOP of the pairwise K; v1.1's K/(N-1) scale is preserved.
 * `recencyGapDays` = how far the smaller of the two participants' last race was back;
 * we use 0 for a brand-new encounter (full K applies).
 */
export function timeWeightedK(cfg: V12Config, daysSinceLastRace: number | null): number {
  if (daysSinceLastRace == null || daysSinceLastRace < 0) return cfg.k;
  return cfg.k * Math.exp(-daysSinceLastRace / cfg.tauDays);
}

export function provisionalMultiplier(cfg: V12Config, gamesPlayed: number): number {
  return gamesPlayed < cfg.provisionalGamesThreshold ? cfg.provisionalMultiplier : 1.0;
}

/**
 * Decide if a state is frozen / retired at a given reference date.
 * Does NOT mutate; pure lookup for the compute driver to branch on.
 */
export function classifyIdle(
  cfg: V12Config,
  state: V12AxisState,
  refDate: string,
): { isFrozen: boolean; isRetired: boolean; gapDays: number | null } {
  if (!state.lastRaceDate) return { isFrozen: false, isRetired: false, gapDays: null };
  const gap = daysBetween(state.lastRaceDate, refDate);
  return {
    isFrozen: gap > cfg.freezeThresholdDays && gap <= cfg.retireThresholdDays,
    isRetired: gap > cfg.retireThresholdDays,
    gapDays: gap,
  };
}

/**
 * Apply end-of-season mean regression once per season per entity.
 * Should be called BEFORE the first race of a new season (after 7/31 crossover).
 * Mutates the state, returns metadata for snapshot columns.
 */
export function applySeasonEndRegressionIfNeeded(
  cfg: V12Config,
  state: V12AxisState,
  raceDate: string,
): { applied: boolean; fromRating: number; toRating: number; season: string | null } {
  if (!state.lastRaceDate) return { applied: false, fromRating: state.rating, toRating: state.rating, season: null };

  const lastYear = parseInt(state.lastRaceDate.slice(0, 4), 10);
  const lastMonth = parseInt(state.lastRaceDate.slice(5, 7), 10);
  const lastDay = parseInt(state.lastRaceDate.slice(8, 10), 10);
  const curYear = parseInt(raceDate.slice(0, 4), 10);
  const curMonth = parseInt(raceDate.slice(5, 7), 10);
  const curDay = parseInt(raceDate.slice(8, 10), 10);

  // Season boundary: last race was ≤ 7/31 of year Y, current race > 7/31 of same or later year
  const lastBeforeBoundary = lastMonth < cfg.seasonEndMonth ||
    (lastMonth === cfg.seasonEndMonth && lastDay <= cfg.seasonEndDay);
  const curAfterBoundary = curMonth > cfg.seasonEndMonth ||
    (curMonth === cfg.seasonEndMonth && curDay > cfg.seasonEndDay);
  const crossedBoundary =
    (curYear > lastYear) ||
    (curYear === lastYear && lastBeforeBoundary && curAfterBoundary);

  if (!crossedBoundary) return { applied: false, fromRating: state.rating, toRating: state.rating, season: null };

  // Season label = year of end boundary (season 2025/26 closes 7/31/26)
  const seasonLabel = `${curMonth > cfg.seasonEndMonth || (curMonth === cfg.seasonEndMonth && curDay > cfg.seasonEndDay) ? curYear : curYear - 1}`;
  if (state.lastSeasonEndApplied === seasonLabel) {
    return { applied: false, fromRating: state.rating, toRating: state.rating, season: seasonLabel };
  }

  const from = state.rating;
  const to = (1 - cfg.seasonAlpha) * from + cfg.seasonAlpha * cfg.initialRating;
  state.rating = to;
  state.lastSeasonEndApplied = seasonLabel;
  return { applied: true, fromRating: from, toRating: to, season: seasonLabel };
}

/**
 * Resolve prior rating for a new entity, given import/visitor flags.
 */
export function resolvePriorRating(
  axisType: AxisType,
  flags: { isForeignImport?: boolean; isPrivatePurchase?: boolean; isVisitingInternational?: boolean },
): number {
  if (axisType === 'horse') {
    if (flags.isForeignImport) return IMPORT_PRIORS.horse.foreignImport;
    if (flags.isPrivatePurchase) return IMPORT_PRIORS.horse.privatePurchase;
    return IMPORT_PRIORS.horse.defaultLocal;
  }
  if (axisType === 'jockey') {
    if (flags.isVisitingInternational) return IMPORT_PRIORS.jockey.visitingInternational;
    return IMPORT_PRIORS.jockey.defaultLocal;
  }
  return IMPORT_PRIORS.trainer.defaultLocal;
}

/**
 * Compute confidence score [0..1] for snapshot output.
 */
export function computeConfidence(cfg: V12Config, state: V12AxisState): number {
  const volumeTerm = Math.min(1, state.gamesPlayed / 20);
  const recencyTerm = 1 - Math.exp(-state.recencyWeightedGames / 6);
  return volumeTerm * recencyTerm;
}

/**
 * Compute deltas for a race using time-weighted pairwise math.
 * Each runner's effective K is scaled by their own idle-gap exponent;
 * if a runner has never raced (state.lastRaceDate==null) their K = full base K
 * (first encounter — no temporal degradation).
 */
export interface V12Runner {
  entityId: string;
  finish: number;             // 1..N (999 = DNF, excluded)
  currentRating: number;
  gamesPlayed: number;
  daysSinceLastRace: number | null;  // null for debutant
}

export function computeV12RaceDeltas(
  runners: V12Runner[],
  cfg: V12Config,
): Map<string, number> {
  const deltas = new Map<string, number>();
  const valid = runners.filter((r) => r.finish !== 999);
  for (const r of runners) deltas.set(r.entityId, 0);
  if (valid.length < 2) return deltas;

  const N = valid.length;

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];

      // Per-entity K uses their own idle-gap (how stale was their last rating?)
      const kA = timeWeightedK(cfg, a.daysSinceLastRace) * provisionalMultiplier(cfg, a.gamesPlayed);
      const kB = timeWeightedK(cfg, b.daysSinceLastRace) * provisionalMultiplier(cfg, b.gamesPlayed);
      const scaleA = kA / (N - 1);
      const scaleB = kB / (N - 1);

      let scoreA: number;
      let scoreB: number;
      if (a.finish < b.finish) { scoreA = 1; scoreB = 0; }
      else if (a.finish > b.finish) { scoreA = 0; scoreB = 1; }
      else { scoreA = 0.5; scoreB = 0.5; }

      const expA = expectedScore(a.currentRating, b.currentRating);
      const expB = 1 - expA;

      deltas.set(a.entityId, (deltas.get(a.entityId) ?? 0) + scaleA * (scoreA - expA));
      deltas.set(b.entityId, (deltas.get(b.entityId) ?? 0) + scaleB * (scoreB - expB));
    }
  }
  return deltas;
}

export function isBurnInRace(cfg: V12Config, raceDate: string): boolean {
  return raceDate <= cfg.burnInToDate;
}

// Re-export for driver convenience
export { expectedScore };
export type { EloConfig };
export { DEFAULT_CONFIG };
