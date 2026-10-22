/**
 * Public data-volume statistics — the single source of truth for every
 * "how much data" number (website, README badges, repo copy).
 *
 * Counted EXACTLY from production D1 (COUNT(*)), but only once a day by cron
 * (06:00 HKT, after the 00:23 results sync and 05:17 Pool-A sync) and stored in
 * the tiny `public_data_stats` table. Requests read that one row; they never
 * scan the big tables. On a cold miss (row absent or > MAX_AGE old) one request
 * recomputes, throttled per isolate so concurrent misses can't stampede D1.
 *
 * Every table is read independently: a missing table yields `null` (reported in
 * `missing`) instead of failing the whole payload.
 */
import type { Env } from '../types';

export const DATA_STATS_VERSION = 1;
const STATS_KEY = 'public:v1';
/** Stored stats older than this are recomputed on the next request. */
export const DATA_STATS_MAX_AGE_MS = 30 * 3600_000;
/** Per-isolate guard: at most one on-request recompute per this window. */
const RECOMPUTE_THROTTLE_MS = 10 * 60_000;

type DB = Env['DB'];

export type DataStats = {
  schemaVersion: number;
  source: 'd1';
  generatedAt: string;
  range: { first: string | null; last: string | null };
  counts: {
    /** Meetings that have at least one result row. */
    raceDays: number | null;
    /** Races that have at least one result row. */
    races: number | null;
    /** Runner result rows (one per horse per race). */
    runnerResults: number | null;
    horses: number | null;
    jockeys: number | null;
    trainers: number | null;
    formRecords: number | null;
    trackwork: number | null;
    sectionals: number | null;
    dividends: number | null;
    injuries: number | null;
    trialSessions: number | null;
    trialRunners: number | null;
    runningComments: number | null;
    /** Cumulative archived odds snapshots (live table is pruned to the latest day). */
    oddsArchive: number | null;
    /** Odds snapshots currently in the live table (latest meeting only). */
    oddsLive: number | null;
  };
  latest: {
    results: string | null;
    trackwork: string | null;
    injury: string | null;
    form: string | null;
    trial: string | null;
  };
  /** Tables that could not be read (absent from D1 or read error). */
  missing: string[];
};

const COUNT_TABLES: Array<[keyof DataStats['counts'], string]> = [
  ['horses', 'horses'],
  ['jockeys', 'jockeys'],
  ['trainers', 'trainers'],
  ['formRecords', 'horse_form_records'],
  ['trackwork', 'horse_trackwork'],
  ['sectionals', 'horse_sectional_times'],
  ['dividends', 'dividends'],
  ['injuries', 'horse_injury'],
  ['trialSessions', 'trial_sessions'],
  ['trialRunners', 'trial_runners'],
  ['runningComments', 'running_comments'],
  ['oddsArchive', 'odds_archive'],
  ['oddsLive', 'odds_snapshots'],
];

const LATEST: Array<[keyof DataStats['latest'], string, string]> = [
  ['trackwork', 'horse_trackwork', 'trackwork_date'],
  ['injury', 'horse_injury', 'injury_date'],
  ['form', 'horse_form_records', 'race_date'],
  ['trial', 'trial_sessions', 'trial_date'],
];

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 10) : null);

/** Exact counts straight from D1. Heavy (full scans) — cron / throttled miss only. */
export async function computeDataStats(db: DB, now: number = Date.now()): Promise<DataStats> {
  const missing: string[] = [];
  const counts = Object.fromEntries(COUNT_TABLES.map(([k]) => [k, null])) as DataStats['counts'];
  counts.raceDays = null; counts.races = null; counts.runnerResults = null;
  const latest: DataStats['latest'] = { results: null, trackwork: null, injury: null, form: null, trial: null };
  let range: DataStats['range'] = { first: null, last: null };

  const core = db.prepare(
    `SELECT COUNT(*) AS rows_n, COUNT(DISTINCT rr.race_id) AS races_n, COUNT(DISTINCT m.date) AS days_n,
            MIN(m.date) AS first_d, MAX(m.date) AS last_d
       FROM race_results rr
       JOIN races r ON r.id = rr.race_id
       JOIN race_meetings m ON m.id = r.meeting_id`,
  ).first<Record<string, unknown>>().then((row) => {
    counts.runnerResults = num(row?.rows_n);
    counts.races = num(row?.races_n);
    counts.raceDays = num(row?.days_n);
    range = { first: str(row?.first_d), last: str(row?.last_d) };
    latest.results = range.last;
  }).catch(() => { missing.push('race_results'); });

  const tables = COUNT_TABLES.map(([key, table]) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: unknown }>()
      .then((row) => { counts[key] = num(row?.n); })
      .catch(() => { if (!missing.includes(table)) missing.push(table); }),
  );
  const dates = LATEST.map(([key, table, col]) =>
    db.prepare(`SELECT MAX(${col}) AS d FROM ${table}`).first<{ d: unknown }>()
      .then((row) => { latest[key] = str(row?.d); })
      .catch(() => { /* table absence already reported by the count */ }),
  );
  await Promise.all([core, ...tables, ...dates]);
  return { schemaVersion: DATA_STATS_VERSION, source: 'd1', generatedAt: new Date(now).toISOString(), range, counts, latest, missing: missing.sort() };
}

async function ensureStatsTable(db: DB): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS public_data_stats (key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, computed_at TEXT NOT NULL)`,
  ).run();
}

export async function readStoredDataStats(db: DB): Promise<DataStats | null> {
  try {
    const row = await db.prepare(`SELECT payload_json FROM public_data_stats WHERE key = ?`).bind(STATS_KEY).first<{ payload_json: string }>();
    if (!row?.payload_json) return null;
    const parsed = JSON.parse(row.payload_json) as DataStats;
    return parsed?.schemaVersion === DATA_STATS_VERSION ? parsed : null;
  } catch {
    return null; // table not created yet, or unreadable → treat as miss
  }
}

/** Compute and persist. Used by the daily cron and by a throttled cold miss. */
export async function refreshDataStats(db: DB, now: number = Date.now()): Promise<DataStats> {
  const stats = await computeDataStats(db, now);
  // Never overwrite a good snapshot with one where the core results read failed.
  if (stats.counts.runnerResults == null) return stats;
  try {
    await ensureStatsTable(db);
    await db.prepare(
      `INSERT INTO public_data_stats (key, payload_json, computed_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, computed_at = excluded.computed_at`,
    ).bind(STATS_KEY, JSON.stringify(stats), stats.generatedAt).run();
  } catch { /* serving still works from the computed value */ }
  return stats;
}

let lastOnRequestCompute = 0;
let inflight: Promise<DataStats> | null = null;

/** Request path: stored row when fresh enough; otherwise one throttled recompute. */
export async function getDataStats(db: DB, now: number = Date.now()): Promise<{ stats: DataStats | null; state: 'stored' | 'computed' | 'stale' | 'unavailable' }> {
  const stored = await readStoredDataStats(db);
  const age = stored ? now - Date.parse(stored.generatedAt) : Infinity;
  if (stored && age >= 0 && age < DATA_STATS_MAX_AGE_MS) return { stats: stored, state: 'stored' };
  if (inflight) {
    const s = await inflight.catch(() => null);
    return s?.counts.runnerResults != null ? { stats: s, state: 'computed' } : { stats: stored, state: stored ? 'stale' : 'unavailable' };
  }
  if (now - lastOnRequestCompute < RECOMPUTE_THROTTLE_MS) return { stats: stored, state: stored ? 'stale' : 'unavailable' };
  lastOnRequestCompute = now;
  inflight = refreshDataStats(db, now).finally(() => { inflight = null; });
  const fresh = await inflight.catch(() => null);
  if (fresh && fresh.counts.runnerResults != null) return { stats: fresh, state: 'computed' };
  return { stats: stored, state: stored ? 'stale' : 'unavailable' };
}

/** Test hook. */
export function resetDataStatsThrottle() { lastOnRequestCompute = 0; inflight = null; }
