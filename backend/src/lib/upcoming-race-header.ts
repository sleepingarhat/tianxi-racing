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

/** Already on the whitelisted racecard query; absent until the D1 alter runs. */
export const ENTRY_RUNNER_EXTRA_COLUMNS =
  'e.body_weight, e.allowance, e.international_rating, e.last6run, e.silk_file, e.card_stage';

export const ENTRY_RUNNER_EXTRA_COLUMNS_LEGACY =
  'NULL AS body_weight, NULL AS allowance, NULL AS international_rating, NULL AS last6run, NULL AS silk_file, NULL AS card_stage';

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

const ENTRY_ROW_SELECT = `SELECT
        e.race_number, e.race_class, e.distance, e.track, e.course,
        %META%,
        %EXTRA%,
        e.horse_id, e.horse_number, e.horse_code, e.draw,
        e.jockey_name, e.trainer_name, e.actual_weight, e.declared_weight,
        e.rating, e.gear, e.priority_order,
        h.name_en, h.name_ch, h.code, h.current_rating, h.sire, h.dam, h.dam_sire,
        h.age, h.sex, h.import_type, h.season_stakes
       FROM entries_upcoming e
       LEFT JOIN horses h ON h.id = e.horse_id
      WHERE e.race_date = ? AND e.venue = ? AND e.race_number > 0
        AND (e.priority_order IS NULL OR e.priority_order NOT LIKE '後備%')
      ORDER BY e.race_number, e.horse_number`;

function entrySelect(meta: string, extra: string): string {
  return ENTRY_ROW_SELECT.replace('%META%', meta).replace('%EXTRA%', extra);
}

/**
 * Declared-card runners. Falls back when D1 has not been altered yet, without
 * dropping race headers that are already stored.
 */
export async function selectDeclaredRunners<T = any>(
  db: PrepareDb,
  date: string,
  venue: string,
): Promise<T[]> {
  const attempts = [
    entrySelect(ENTRY_RACE_META_COLUMNS, ENTRY_RUNNER_EXTRA_COLUMNS),
    entrySelect(ENTRY_RACE_META_COLUMNS, ENTRY_RUNNER_EXTRA_COLUMNS_LEGACY),
    entrySelect(ENTRY_RACE_META_COLUMNS_LEGACY, ENTRY_RUNNER_EXTRA_COLUMNS_LEGACY),
  ];
  let last: unknown;
  for (const sql of attempts) {
    try {
      const { results } = await db.prepare(sql).bind(date, venue).all<T>();
      return results ?? [];
    } catch (err) {
      last = err;
      const msg = String((err as { message?: string })?.message ?? err);
      if (!/no such column/i.test(msg)) throw err;
    }
  }
  throw last;
}
