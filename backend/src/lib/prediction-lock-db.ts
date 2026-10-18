import { applyFrozenOrder, auditTop4Pairs } from './prediction-lock';
import { getMeetingLockState } from './lock-window';

/**
 * APPROVED FREEZE SPEC (T−1.5h): the published Top-4 must come from the frozen
 * prediction_log from 90 minutes before the first race onward — not only after
 * results land. `dateHasSettledResults` stays as the stricter backstop.
 */
export async function dateIsLocked(
  db: D1Database,
  date: string | null | undefined,
  venue?: string | null,
): Promise<boolean> {
  if (!date) return false;
  const settled = await dateHasSettledResults(db, date, venue);
  if (settled) return true;
  const lock = await getMeetingLockState(db, date, venue, { settled });
  return lock.locked;
}

type EloEngine = 'v11' | 'v12';

export async function dateHasSettledResults(
  db: D1Database,
  date: string | null | undefined,
  venue?: string | null,
): Promise<boolean> {
  if (!date) return false;
  const hk = (venue === 'ST' || venue === 'HV') ? venue : null;
  try {
    const row = hk
      ? await db.prepare(
          `SELECT 1 AS x FROM race_meetings m
             JOIN races r ON r.meeting_id = m.id
             JOIN race_results rr ON rr.race_id = r.id
            WHERE m.date = ? AND m.venue = ? AND rr.finishing_position > 0
            LIMIT 1`,
        ).bind(date, hk).first().catch(() => null)
      : await db.prepare(
          `SELECT 1 AS x FROM race_meetings m
             JOIN races r ON r.meeting_id = m.id
             JOIN race_results rr ON rr.race_id = r.id
            WHERE m.date = ? AND m.venue IN ('ST','HV') AND rr.finishing_position > 0
            LIMIT 1`,
        ).bind(date).first().catch(() => null);
    return !!row;
  } catch {
    return false;
  }
}

export type FrozenPicksResult =
  | { ok: true; byRace: Map<number, any[]> }
  | { ok: false; error: string };

/**
 * Load the frozen baseline picks for a date. Fail-closed: a database error is
 * reported as an error, never silently treated as "no frozen rows" (which
 * would let callers fall back to live recompute after the lock).
 */
export async function loadFrozenPicksForDate(
  db: D1Database,
  date: string,
  engine: string,
): Promise<FrozenPicksResult> {
  const byRace = new Map<number, any[]>();
  try {
    const res = await db.prepare(
      `SELECT pl.race_number, pl.horse_id, pl.horse_number, pl.draw, pl.horse_elo,
              pl.elo_composite, pl.factor_bonus, pl.final_score, pl.p_win, pl.p_top3,
              pl.predicted_rank, pl.lgb_score, pl.lgb_model_version, pl.score_source,
              h.name_ch AS name_ch
         FROM prediction_log pl
         LEFT JOIN horses h ON h.id = pl.horse_id
        WHERE pl.date = ? AND pl.engine = ? AND pl.variant = 'baseline'
          AND pl.predicted_rank IS NOT NULL
        ORDER BY pl.race_number ASC, pl.predicted_rank ASC`,
    ).bind(date, engine).all<any>();
    for (const r of res?.results ?? []) {
      if (!byRace.has(r.race_number)) byRace.set(r.race_number, []);
      byRace.get(r.race_number)!.push({
        horseId: r.horse_id,
        horseNumber: r.horse_number,
        draw: r.draw,
        nameCh: r.name_ch ?? null,
        horseElo: r.horse_elo,
        eloComposite: r.elo_composite,
        factorBonus: r.factor_bonus,
        finalScore: r.final_score,
        pWin: r.p_win,
        pTop3: r.p_top3,
        rank: r.predicted_rank,
        lgbScore: r.lgb_score,
        lgbModelVersion: r.lgb_model_version,
        scoreSource: r.score_source,
      });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, byRace };
}

/**
 * After the lock, a missing or unreadable frozen record is an error, never a
 * silent live fallback: the payload is marked freezeError so callers can
 * answer 503 instead of serving post-lock live recompute as "the prediction".
 */
export async function freezeTopPicksPayload(
  db: D1Database,
  payload: any,
  engine: string = 'v12',
): Promise<any> {
  if (!payload?.date) return payload;
  if (!(await dateIsLocked(db, payload.date, payload.venue))) {
    payload.frozen = false;
    payload.freezeSource = 'live-recompute';
    return payload;
  }
  const frozen = await loadFrozenPicksForDate(db, payload.date, engine);
  const raceNo = Number(payload.raceNumber);
  const fr = frozen.ok ? frozen.byRace.get(raceNo) : undefined;
  if (!frozen.ok || !fr || fr.length < 4) {
    payload.frozen = false;
    payload.freezeSource = frozen.ok ? 'missing-log' : 'frozen-read-error';
    payload.freezeError = true;
    return payload;
  }
  const merged = applyFrozenOrder(payload.allPicks || payload.picks, fr);
  if (!merged.applied) {
    payload.frozen = false;
    payload.freezeSource = merged.reason || 'frozen-not-intact';
    payload.freezeError = true;
    return payload;
  }
  payload.picks = merged.picks.slice(0, 5);
  payload.allPicks = merged.picks;
  payload.frozen = true;
  payload.freezeSource = 'prediction_log';
  return payload;
}

/**
 * Meeting overlay is all-or-nothing after the lock: every race must have an
 * intact frozen record, otherwise the whole payload is marked freezeError so
 * no partially-live meeting is served as frozen.
 */
export async function freezeMeetingPayload(
  db: D1Database,
  payload: any,
  engine: string = 'v12',
): Promise<any> {
  if (!payload?.date || !Array.isArray(payload?.races)) return payload;
  if (!(await dateIsLocked(db, payload.date, payload.venue))) {
    payload.frozen = false;
    return payload;
  }
  const frozen = await loadFrozenPicksForDate(db, payload.date, engine);
  if (!frozen.ok) {
    payload.frozen = false;
    payload.freezeSource = 'frozen-read-error';
    payload.freezeError = true;
    return payload;
  }
  let applied = 0;
  const missing: number[] = [];
  for (const r of payload.races) {
    const raceNo = Number(r.raceNumber);
    const fr = frozen.byRace.get(raceNo);
    if (!fr || fr.length < 4) { missing.push(raceNo); continue; }
    const merged = applyFrozenOrder(r.picks, fr);
    if (!merged.applied) { missing.push(raceNo); continue; }
    r.picks = merged.picks;
    applied++;
  }
  if (missing.length) {
    payload.frozen = false;
    payload.freezeSource = 'missing-log';
    payload.freezeError = true;
    payload.freezeMissingRaces = missing;
    return payload;
  }
  payload.frozen = applied > 0;
  payload.freezeAppliedRaces = applied;
  return payload;
}

export async function auditPredictionLock(
  db: D1Database,
  date: string,
  engine: EloEngine = 'v12',
): Promise<{
  date: string;
  engine: string;
  settled: boolean;
  ok: boolean;
  source: string;
  races: any[];
  mismatches: any[];
}> {
  const settled = await dateHasSettledResults(db, date);
  if (!settled) {
    return { date, engine, settled: false, ok: true, source: 'unsettled', races: [], mismatches: [] };
  }
  const frozen = await loadFrozenPicksForDate(db, date, engine);
  if (!frozen.ok) {
    return { date, engine, settled: true, ok: false, source: 'frozen-read-error', races: [], mismatches: [{ reason: frozen.error }] };
  }
  if (!frozen.byRace.size) {
    return { date, engine, settled: true, ok: false, source: 'missing-log', races: [], mismatches: [{ reason: 'prediction_log incomplete' }] };
  }
  let compared = new Map<number, any[]>();
  try {
    const row = await db.prepare(
      `SELECT payload_json FROM meeting_hit_rate_cache WHERE date=? AND engine LIKE ?`,
    ).bind(date, `${engine}-%`).first<{ payload_json: string }>();
    if (row?.payload_json) {
      const parsed = JSON.parse(row.payload_json);
      for (const r of parsed.races || []) {
        compared.set(Number(r.raceNumber), r.predictedTop4 || r.picks || []);
      }
    }
  } catch { /* cache miss is not a ranking leak by itself */ }
  const audit = auditTop4Pairs(frozen.byRace, compared);
  return {
    date,
    engine,
    settled: true,
    ok: audit.ok,
    source: 'prediction_log-vs-hit-rate',
    races: audit.races,
    mismatches: audit.mismatches,
  };
}

export async function freezeExplainPayload(
  db: D1Database,
  payload: any,
  raceId?: string | null,
  horseId?: string | null,
  engine: string = 'v12',
): Promise<any> {
  if (!payload || !raceId || !horseId) return payload;
  let date = payload.date as string | undefined;
  let raceNumber = Number(payload.raceNumber);
  let venue = payload.venue as string | undefined;
  if (!date || !Number.isFinite(raceNumber)) {
    try {
      const row = await db.prepare(
        `SELECT r.race_number AS race_number, rm.date AS date, rm.venue AS venue
           FROM races r JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE r.id = ?`,
      ).bind(raceId).first<{ race_number: number; date: string; venue: string }>();
      if (!row) return payload;
      date = row.date;
      raceNumber = Number(row.race_number);
      venue = row.venue;
    } catch {
      return payload;
    }
  }
  if (!(await dateIsLocked(db, date, venue))) {
    payload.frozen = false;
    return payload;
  }
  const frozen = await loadFrozenPicksForDate(db, date, engine);
  if (!frozen.ok) {
    payload.frozen = false;
    payload.freezeSource = 'frozen-read-error';
    payload.freezeError = true;
    return payload;
  }
  const fr = frozen.byRace.get(raceNumber) || [];
  const fp = fr.find((p: any) =>
    (p.horseId && String(p.horseId) === String(horseId)) ||
    (payload.horseNumber != null && String(p.horseNumber) === String(payload.horseNumber)),
  );
  if (!fp) {
    payload.frozen = false;
    payload.freezeSource = 'missing-log-horse';
    payload.freezeError = true;
    return payload;
  }
  // Frozen-owned analytical fields: a frozen NULL stays NULL, never hydrated
  // from the live explain payload.
  payload.rank = 'rank' in fp ? fp.rank : null;
  payload.pWin = 'pWin' in fp ? fp.pWin : null;
  payload.pTop3 = 'pTop3' in fp ? fp.pTop3 : null;
  payload.pTop4 = 'pTop4' in fp ? fp.pTop4 : null;
  payload.finalScore = 'finalScore' in fp ? fp.finalScore : null;
  payload.frozen = true;
  payload.freezeSource = 'prediction_log';
  return payload;
}
