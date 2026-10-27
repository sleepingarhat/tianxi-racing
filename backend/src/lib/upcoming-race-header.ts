/**
 * Race headers stored on entries_upcoming (denormalised onto each runner).
 * Readers prefer the per-race going and fall back to the meeting value only
 * when that race has none — mixed cards must not display the first race's going.
 */

export interface UpcomingRaceHeaderRow {
  race_name?: string | null;
  prize?: string | null;
  rating_range?: string | null;
  going?: string | null;
  race_class?: string | null;
  distance?: number | null;
  track?: string | null;
  course?: string | null;
}

export interface UpcomingRaceHeaderView {
  title: string | null;
  class: string | null;
  distance: number | null;
  going: string | null;
  track: string | null;
  course: string | null;
  prize: string | null;
  ratingRange: string | null;
}

export const ENTRY_RACE_META_COLUMNS =
  'e.race_name, e.prize, e.rating_range, e.going';

export const ENTRY_RACE_META_COLUMNS_LEGACY =
  'NULL AS race_name, NULL AS prize, NULL AS rating_range, NULL AS going';

export function upcomingRaceHeaderView(
  row: UpcomingRaceHeaderRow | null | undefined,
  meetingGoing: string | null,
): UpcomingRaceHeaderView {
  const r = row ?? {};
  return {
    title: r.race_name ?? null,
    class: r.race_class ?? null,
    distance: r.distance ?? null,
    going: r.going ?? meetingGoing ?? null,
    track: r.track ?? null,
    course: r.course ?? null,
    prize: r.prize ?? null,
    ratingRange: r.rating_range ?? null,
  };
}

type BoundAll = {
  all: <T = unknown>() => Promise<{ results?: T[] }>;
};

type Statement = {
  bind: (...args: unknown[]) => BoundAll;
};

type PrepareDb = {
  prepare: (sql: string) => Statement;
};

/**
 * Run the race-meta SELECT. If D1 has not been altered yet, run the legacy
 * SELECT that fills those fields with NULL. Any other failure is rethrown.
 */
export async function allEntriesOrLegacy<T = any>(
  db: PrepareDb,
  fullSql: string,
  legacySql: string,
  binds: unknown[],
): Promise<T[]> {
  try {
    const { results } = await db.prepare(fullSql).bind(...binds).all<T>();
    return results ?? [];
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err);
    if (!/no such column/i.test(msg)) throw err;
    console.error('[entries_upcoming] race-meta columns missing; legacy select', msg);
    const { results } = await db.prepare(legacySql).bind(...binds).all<T>();
    return results ?? [];
  }
}
