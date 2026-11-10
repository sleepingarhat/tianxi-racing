/**
 * Public meeting card status and runner weights.
 *
 * `weight` is imposed or carried pounds (負磅 / 實際負磅, about 80–180).
 * 排位體重 is body weight (about 700–1500) and is never returned as `weight`.
 * On race_results the column named declared_weight is the results-page
 * 排位體重, not the racecard 負磅. Upcoming entries_upcoming.declared_weight
 * is the racecard 負磅.
 */

export type CardStatus = 'fixture' | 'entries' | 'declared' | 'resulted';
export type DrawStatus = 'published' | 'unavailable' | null;

export interface CardSignals {
  resulted: boolean;
  hasRaces: boolean;
  declaredRunners: number;
  declaredDraws: number;
  officialEntries: number;
}

export interface CardView {
  cardStatus: CardStatus;
  isDeclaredCard: boolean;
  drawStatus: DrawStatus;
  /** Set when the official entries list is published and the barrier draw is not. */
  drawNote: string | null;
}

export function resolveCardStatus(signals: CardSignals): CardView {
  let cardStatus: CardStatus;
  if (signals.resulted) cardStatus = 'resulted';
  else if (signals.hasRaces || signals.declaredRunners > 0) cardStatus = 'declared';
  else if (signals.officialEntries > 0) cardStatus = 'entries';
  else cardStatus = 'fixture';

  const isDeclaredCard = cardStatus === 'declared' || cardStatus === 'resulted';
  let drawStatus: DrawStatus = null;
  if (cardStatus === 'entries') drawStatus = 'unavailable';
  else if (cardStatus === 'resulted') drawStatus = 'published';
  else if (cardStatus === 'declared') drawStatus = signals.declaredDraws > 0 ? 'published' : 'unavailable';

  return {
    cardStatus,
    isDeclaredCard,
    drawStatus,
    drawNote: cardStatus === 'entries' ? '已報名，正式排位未公布' : null,
  };
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 負磅 or 實際負磅. Rejects body-weight scale values. */
export function carriedPounds(value: unknown): number | null {
  const n = finite(value);
  return n != null && n >= 80 && n <= 180 ? n : null;
}

/** 排位體重. Rejects carried-weight scale values. */
export function bodyPounds(value: unknown): number | null {
  const n = finite(value);
  return n != null && n >= 700 && n <= 1500 ? n : null;
}

export interface PublicWeights {
  /** Imposed or carried pounds. Never 排位體重. */
  weight: number | null;
  bodyWeight: number | null;
  /** Racecard 負磅. Null on results, where that figure is not stored separately. */
  declaredWeight: number | null;
  /** 實際負磅 after allowance. */
  actualWeight: number | null;
}

export function publicWeights(source: 'results' | 'upcoming', row: {
  actual_weight?: unknown;
  declared_weight?: unknown;
  body_weight?: unknown;
}): PublicWeights {
  if (source === 'results') {
    const carried = carriedPounds(row.actual_weight);
    return {
      weight: carried,
      bodyWeight: bodyPounds(row.declared_weight),
      declaredWeight: null,
      actualWeight: carried,
    };
  }
  const imposed = carriedPounds(row.declared_weight);
  const carried = carriedPounds(row.actual_weight);
  return {
    weight: imposed ?? carried,
    bodyWeight: bodyPounds(row.body_weight),
    declaredWeight: imposed,
    actualWeight: carried,
  };
}

export function positiveInt(value: unknown): number | null {
  const n = finite(value);
  return n != null && n > 0 ? Math.trunc(n) : null;
}

export interface CardDeltas {
  /** 評分+/-. Null when the racecard cell is blank. */
  ratingChange: number | null;
  /** 排位體重+/-. */
  bodyWeightChange: number | null;
  /** 最佳時間, official text such as 1.42.43. */
  bestTime: string | null;
  /** 上賽距今日數. */
  daysSinceRun: number | null;
}

function wholeInt(value: unknown): number | null {
  const n = finite(value);
  return n != null && Number.isInteger(n) ? n : null;
}

/** Racecard deltas stored beside the runner. Missing columns read as null. */
export function cardDeltas(row: {
  rating_change?: unknown;
  body_weight_change?: unknown;
  best_time?: unknown;
  days_since_run?: unknown;
} | null | undefined): CardDeltas {
  const best = typeof row?.best_time === 'string' && /^\d{1,2}\.\d{2}\.\d{2}$/.test(row.best_time)
    ? row.best_time
    : null;
  const days = wholeInt(row?.days_since_run);
  return {
    ratingChange: wholeInt(row?.rating_change),
    bodyWeightChange: wholeInt(row?.body_weight_change),
    bestTime: best,
    daysSinceRun: days != null && days >= 0 && days <= 999 ? days : null,
  };
}
