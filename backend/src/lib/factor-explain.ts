// Explanation-only factors (場地／狀態). Production finalScore keeps only draw + weight
// (R5 ablation, reports/decision-log.md 2026-05-10); these helpers shape the factor
// breakdown and pick-reason text, never the ranking. LGB inputs are built separately in
// scripts/backtest/dump-features.ts and are NOT changed by this module.

export type FactorResult = { bonus: number; conf: number; note: string };
export type GoingRow = { track: string | null; going: string | null; starts: number; top3: number };
export type Surface = 'turf' | 'awt';

// Official HKJC going grades, firm → heavy. Neighbouring grades share one step.
const TURF_GRADES = ['快地', '好地至快地', '好地', '好地至黏地', '黏地', '黏地至軟地', '軟地', '大爛地'];
const AWT_GRADES = ['快地', '好地', '濕快地', '濕慢地'];
const AWT_ONLY = new Set(['濕快地', '濕慢地', '封地']);

export function surfaceOf(track: string | null | undefined, going: string | null | undefined): Surface | null {
  const t = String(track ?? '');
  if (/全天候|ALL\s*WEATHER|AWT/i.test(t)) return 'awt';
  if (/草|TURF/i.test(t)) return 'turf';
  if (going && AWT_ONLY.has(going)) return 'awt';
  return null;
}

function gradeOf(surface: Surface, going: string): number | null {
  const idx = (surface === 'turf' ? TURF_GRADES : AWT_GRADES).indexOf(going);
  return idx >= 0 ? idx : null;
}

function neighbourLabel(surface: Surface, going: string): string {
  const grades = surface === 'turf' ? TURF_GRADES : AWT_GRADES;
  const g = gradeOf(surface, going);
  if (g == null) return going;
  return grades.slice(Math.max(0, g - 1), g + 2).join('／');
}

/**
 * Going fit for explanations. Same surface only, today's grade ±1 official step, so a
 * rare reading such as 好地至黏地 still counts a horse's 好地 and 黏地 runs. Unknown
 * surface falls back to the exact going string (previous behaviour).
 */
export function goingFitFromRows(rows: GoingRow[], going: string | null | undefined, track: string | null | undefined): FactorResult {
  if (!going) return { bonus: 0, conf: 0, note: '場地狀況未定' };
  if (!rows.length) return { bonus: 0, conf: 0, note: '無場地往績' };
  const surface = surfaceOf(track, going);
  let starts = 0;
  let top3 = 0;
  const target = surface ? gradeOf(surface, going) : null;
  for (const row of rows) {
    if (!row.going) continue;
    let match = false;
    if (!surface) match = row.going === going;
    else if (surfaceOf(row.track, row.going) === surface) {
      if (target == null) match = row.going === going;
      else {
        const g = gradeOf(surface, row.going);
        match = g != null && Math.abs(g - target) <= 1;
      }
    }
    if (match) { starts += Number(row.starts) || 0; top3 += Number(row.top3) || 0; }
  }
  const scope = surface && target != null
    ? `${surface === 'turf' ? '草地' : '全天候'} ${neighbourLabel(surface, going)}`
    : going;
  if (starts < 2) return { bonus: 0, conf: 0, note: `${scope} 往績不足` };
  const rate = top3 / starts;
  return {
    bonus: Math.max(-15, Math.min(15, (rate - 0.3) * 40)),
    conf: Math.min(1, starts / 4),
    note: `${scope} ${starts} 戰 ${top3}上 (${Math.round(rate * 100)}%)`,
  };
}

export type TrackworkCounts = { total: number; fast: number; trials: number; races?: number };

/**
 * 14-day trackwork for explanations. HKJC lists every 踱步／游水／跑步機 routine, so
 * raw session counts (20+ per fortnight is normal) say nothing about fitness. Only
 * 快操 and 試閘 are read; a fortnight with neither is flagged, otherwise neutral.
 * 2026-09-01→11-14 runners: 0 fast works 25.6% top-4 vs 31–34% for 1–4 (n=2,427).
 */
export function conditionFromCounts(c: TrackworkCounts): FactorResult {
  const total = Number(c.total) || 0;
  const fast = Number(c.fast) || 0;
  const trials = Number(c.trials) || 0;
  const races = Number(c.races) || 0;
  if (total === 0) return { bonus: 0, conf: 0, note: '無晨操記錄' };
  const routine = Math.max(0, total - fast - trials - races);
  const routineNote = routine > 0 ? `（另有 ${routine} 課踱步、游水等）` : '';
  if (fast + trials === 0) {
    return { bonus: -3, conf: Math.min(1, total / 10), note: `14 天未見快操或試閘${routineNote}` };
  }
  const parts = [fast > 0 ? `快操 ${fast} 課` : null, trials > 0 ? `試閘 ${trials} 次` : null].filter(Boolean).join('、');
  return { bonus: 0, conf: Math.min(1, (fast + trials) / 3), note: `14 天${parts}${routineNote}` };
}

export const TRACKWORK_COUNT_SQL = `COUNT(*) AS total,
  SUM(CASE WHEN COALESCE(NULLIF(work_type,''), batch) = '快操' THEN 1 ELSE 0 END) AS fast,
  SUM(CASE WHEN COALESCE(NULLIF(work_type,''), batch) = '試閘' THEN 1 ELSE 0 END) AS trials,
  SUM(CASE WHEN COALESCE(NULLIF(work_type,''), batch) = '出賽' THEN 1 ELSE 0 END) AS races`;
