/**
 * Lock-time telemetry (2026-10-16). Storage only: nothing here feeds score,
 * rank, alpha or gates. Values are captured when prediction_log is written,
 * so they are the exact numbers used before the T−90 freeze. Old rows stay NULL.
 */

export const PACE_METHOD = 'history-v1';
export const FACTOR_KEYS = ['recency', 'distance', 'going', 'draw', 'weight', 'condition', 'injury', 'jtCombo'] as const;
/** Factors that actually enter factor_bonus (R5 ablation 2026-05-10). */
export const FACTOR_USED = ['draw', 'weight'] as const;

export interface FormRow { horse_id: string; race_date: string; distance: number | null; running_position: string | null }
export interface PaceEstimate { early: number; mid: number; late: number; n: number; field: number; method: string }

const round = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/** factorBreakdown → {draw,weight,…,total,used}. total is the stored factor_bonus, never re-derived. */
export function factorScores(breakdown: any, factorBonus: number | null | undefined): string | null {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const k of FACTOR_KEYS) out[k] = round(breakdown[k]?.bonus);
  out.total = round(factorBonus);
  out.used = [...FACTOR_USED];
  return JSON.stringify(out);
}

export function distanceBand(d: number) { return d <= 1200 ? 's' : d <= 1650 ? 'm' : d <= 2000 ? 'i' : 'l'; }

/** Same stage rule as the public page: drop final number, take first / middle / last running call. */
export function stagesOf(rp: string | null | undefined): [number, number, number] | null {
  const t = rp?.trim() ?? '';
  if (!/^\d+(?:\s+\d+)+$/.test(t)) return null;
  const ps = t.split(/\s+/).map(Number).slice(0, -1);
  const pick = (f: number) => ps[Math.round((ps.length - 1) * f)];
  const s = [pick(0), pick(0.5), pick(1)];
  return s.every((x) => x > 0) ? (s as [number, number, number]) : null;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Pre-race only: rows on/after raceDate are ignored. Last 8 starts, same distance band
 * preferred, ≥3 samples. Per-horse median stage position, then ranked within today's field.
 */
export function paceEstimates(horseIds: string[], rows: FormRow[], raceDate: string, distance: number | null): Map<string, PaceEstimate> {
  const raw = new Map<string, { s: [number, number, number]; n: number }>();
  for (const id of horseIds) {
    const own = rows.filter((r) => r.horse_id === id && r.race_date < raceDate && stagesOf(r.running_position))
      .sort((a, b) => b.race_date.localeCompare(a.race_date));
    const band = distance ? own.filter((r) => r.distance && distanceBand(r.distance) === distanceBand(distance)) : [];
    const sel = (band.length >= 3 ? band : own).slice(0, 8);
    if (sel.length < 3) continue;
    const st = sel.map((r) => stagesOf(r.running_position)!);
    raw.set(id, { s: [0, 1, 2].map((i) => median(st.map((x) => x[i]))) as [number, number, number], n: sel.length });
  }
  const out = new Map<string, PaceEstimate>();
  const ids = [...raw.keys()];
  const rank = (i: number) => {
    const sorted = [...ids].sort((a, b) => raw.get(a)!.s[i] - raw.get(b)!.s[i] || a.localeCompare(b));
    return new Map(sorted.map((id, k) => [id, k + 1]));
  };
  const [e, m, l] = [rank(0), rank(1), rank(2)];
  for (const id of ids) out.set(id, { early: e.get(id)!, mid: m.get(id)!, late: l.get(id)!, n: raw.get(id)!.n, field: ids.length, method: PACE_METHOD });
  return out;
}

/** Config fingerprint: hash of the scoring configuration. Not a booster file hash. */
export async function configFingerprint(cfg: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(cfg)));
  return 'cfg-' + [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
