/**
 * Pro 研究室「場地狀況／天氣影響」純函式。
 * 無 I/O；路由層負責查 DB、auth。
 * 標研究層／歷史統計；唔入官方四揀。
 */

import {
  STYLE_LABELS,
  classifyStyleFromNorm,
  normalisePosition,
  parseFirstPosition,
  type RunningStyleCode,
} from './running-style';

export const GOING_DISCLAIMER = '歷史統計・研究層';
export const RESEARCH_LAYER_NOTE =
  '場地／天氣偏差屬研究層歷史統計，唔影響官方凍結四揀同公開戰績。樣本不足格呈灰色，唔宜當成入馬提示。';
export const MIN_SAMPLE_RACES = 30;
export const HISTORY_SINCE = '2016-01-01';
export const PENDING_GOING = '待公佈';

/** 地況桶：統一中英／常見變體，方便聚合。 */
const GOING_ALIASES: Record<string, string> = {
  good: '好地',
  'good to firm': '好地至快地',
  firm: '快地',
  yielding: '黏地',
  'good to yielding': '好地至黏地',
  soft: '軟地',
  'yielding to soft': '黏地至軟地',
  heavy: '大爛地',
  wet: '濕地',
  'wet slow': '濕慢地',
  'wet fast': '濕快地',
  好地: '好地',
  好地至快地: '好地至快地',
  快地: '快地',
  好地至快: '好地至快地',
  黏地: '黏地',
  好地至黏地: '好地至黏地',
  軟地: '軟地',
  黏地至軟地: '黏地至軟地',
  大爛地: '大爛地',
  濕地: '濕地',
  濕慢地: '濕慢地',
  濕快地: '濕快地',
  好: '好地',
  快: '快地',
  黏: '黏地',
  軟: '軟地',
};

export function normalizeGoingBucket(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t || t === PENDING_GOING || t === '-' || t === '—') return null;
  const lower = t.toLowerCase();
  if (GOING_ALIASES[t]) return GOING_ALIASES[t];
  if (GOING_ALIASES[lower]) return GOING_ALIASES[lower];
  // 去掉多餘空白再試
  const compact = t.replace(/\s+/g, '');
  if (GOING_ALIASES[compact]) return GOING_ALIASES[compact];
  return t; // 保留原文作為桶，避免丟資料
}

export type DrawHeatCell = {
  draw: number;
  distance: number;
  runners: number;
  wins: number;
  top3: number;
  races: number;
  top3Rate: number | null;
  deltaVsAvg: number | null;
  /** true = 樣本不足，UI 應灰色 */
  sparse: boolean;
};

export type DrawHeatmap = {
  draws: number[];
  distances: number[];
  cells: DrawHeatCell[];
  avgTop3Rate: number | null;
  minSample: number;
  totalRunners: number;
  totalRaces: number;
};

export type StyleBiasRow = {
  code: RunningStyleCode;
  label: string;
  runners: number;
  wins: number;
  top3: number;
  winRate: number | null;
  top3Rate: number | null;
  deltaWinVsAvg: number | null;
  sparse: boolean;
};

export type SuitedHorse = {
  horseId: string;
  horseNumber: number | null;
  nameCh: string | null;
  nameEn: string | null;
  draw: number | null;
  goingStarts: number;
  goingTop3Rate: number | null;
  overallTop3Rate: number | null;
  /** goingTop3Rate − overallTop3Rate（百分點） */
  edgePp: number | null;
  tag: '今日合地';
};

export type RawGoingResult = {
  draw: number | null;
  distance: number | null;
  finishingPosition: number | null;
  runningPosition: string | null;
  horseId: string;
  raceId: string;
  fieldSize: number | null;
};

export type HorseGoingStat = {
  horseId: string;
  goingStarts: number;
  goingTop3: number;
  overallStarts: number;
  overallTop3: number;
};

export type FieldHorse = {
  horseId: string;
  horseNumber: number | null;
  nameCh: string | null;
  nameEn: string | null;
  draw: number | null;
};

function rate(n: number, d: number): number | null {
  if (d <= 0) return null;
  return n / d;
}

/** 由結果列建檔位×途程熱圖（三甲率減全局平均）。 */
export function buildDrawHeatmap(
  rows: RawGoingResult[],
  opts: { draws?: number[]; minSample?: number } = {},
): DrawHeatmap {
  const draws = opts.draws ?? Array.from({ length: 14 }, (_, i) => i + 1);
  const minSample = opts.minSample ?? MIN_SAMPLE_RACES;
  const drawSet = new Set(draws);

  type Agg = { runners: number; wins: number; top3: number; races: Set<string> };
  const byKey = new Map<string, Agg>();
  const distSet = new Set<number>();
  let totalRunners = 0;
  let totalTop3 = 0;
  const allRaces = new Set<string>();

  for (const row of rows) {
    const draw = row.draw == null ? null : Math.trunc(Number(row.draw));
    const distance = row.distance == null ? null : Math.trunc(Number(row.distance));
    const pos = row.finishingPosition == null ? null : Number(row.finishingPosition);
    if (draw == null || !drawSet.has(draw) || distance == null || distance <= 0) continue;
    if (pos == null || !Number.isFinite(pos) || pos < 1 || pos >= 90) continue;

    distSet.add(distance);
    const key = `${draw}|${distance}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = { runners: 0, wins: 0, top3: 0, races: new Set() };
      byKey.set(key, agg);
    }
    agg.runners += 1;
    if (pos === 1) agg.wins += 1;
    if (pos <= 3) agg.top3 += 1;
    if (row.raceId) agg.races.add(row.raceId);

    totalRunners += 1;
    if (pos <= 3) totalTop3 += 1;
    if (row.raceId) allRaces.add(row.raceId);
  }

  const distances = [...distSet].sort((a, b) => a - b);
  const avgTop3Rate = rate(totalTop3, totalRunners);
  const cells: DrawHeatCell[] = [];

  for (const distance of distances) {
    for (const draw of draws) {
      const agg = byKey.get(`${draw}|${distance}`);
      const runners = agg?.runners ?? 0;
      const wins = agg?.wins ?? 0;
      const top3 = agg?.top3 ?? 0;
      const races = agg?.races.size ?? 0;
      const top3Rate = rate(top3, runners);
      const deltaVsAvg =
        top3Rate == null || avgTop3Rate == null ? null : top3Rate - avgTop3Rate;
      cells.push({
        draw,
        distance,
        runners,
        wins,
        top3,
        races,
        top3Rate,
        deltaVsAvg,
        sparse: races < minSample,
      });
    }
  }

  return {
    draws,
    distances,
    cells,
    avgTop3Rate,
    minSample,
    totalRunners,
    totalRaces: allRaces.size,
  };
}

/** 該地況下跑法（放／前／中／後）勝率與相對平均偏差。 */
export function buildStyleBias(
  rows: RawGoingResult[],
  opts: { minSample?: number } = {},
): StyleBiasRow[] {
  const minSample = opts.minSample ?? MIN_SAMPLE_RACES;
  const codes: RunningStyleCode[] = ['leader', 'prominent', 'midfield', 'held-up'];
  const buckets = new Map<RunningStyleCode, { runners: number; wins: number; top3: number }>();
  for (const c of codes) buckets.set(c, { runners: 0, wins: 0, top3: 0 });

  let known = 0;
  let knownWins = 0;

  for (const row of rows) {
    const pos = row.finishingPosition == null ? null : Number(row.finishingPosition);
    if (pos == null || !Number.isFinite(pos) || pos < 1 || pos >= 90) continue;
    const first = parseFirstPosition(row.runningPosition);
    const norm = normalisePosition(first, row.fieldSize);
    if (norm == null) continue;
    const code = classifyStyleFromNorm(norm);
    const b = buckets.get(code)!;
    b.runners += 1;
    if (pos === 1) b.wins += 1;
    if (pos <= 3) b.top3 += 1;
    known += 1;
    if (pos === 1) knownWins += 1;
  }

  const avgWin = rate(knownWins, known);
  return codes.map((code) => {
    const b = buckets.get(code)!;
    const winRate = rate(b.wins, b.runners);
    const top3Rate = rate(b.top3, b.runners);
    return {
      code,
      label: STYLE_LABELS[code],
      runners: b.runners,
      wins: b.wins,
      top3: b.top3,
      winRate,
      top3Rate,
      deltaWinVsAvg:
        winRate == null || avgWin == null ? null : winRate - avgWin,
      sparse: b.runners < minSample,
    };
  });
}

/** 「今日合地」：同類地況三甲率明顯高過自己整體。 */
export function buildSuitedHorses(
  field: FieldHorse[],
  stats: HorseGoingStat[],
  opts: { minGoingStarts?: number; minEdgePp?: number; limit?: number } = {},
): SuitedHorse[] {
  const minGoingStarts = opts.minGoingStarts ?? 5;
  const minEdgePp = opts.minEdgePp ?? 0.05; // 5 百分點
  const limit = opts.limit ?? 12;
  const byId = new Map(stats.map((s) => [s.horseId, s]));

  const out: SuitedHorse[] = [];
  for (const h of field) {
    const s = byId.get(h.horseId);
    if (!s || s.goingStarts < minGoingStarts || s.overallStarts < minGoingStarts) continue;
    const goingTop3Rate = rate(s.goingTop3, s.goingStarts);
    const overallTop3Rate = rate(s.overallTop3, s.overallStarts);
    if (goingTop3Rate == null || overallTop3Rate == null) continue;
    const edgePp = goingTop3Rate - overallTop3Rate;
    if (edgePp < minEdgePp) continue;
    out.push({
      horseId: h.horseId,
      horseNumber: h.horseNumber,
      nameCh: h.nameCh,
      nameEn: h.nameEn,
      draw: h.draw,
      goingStarts: s.goingStarts,
      goingTop3Rate,
      overallTop3Rate,
      edgePp,
      tag: '今日合地',
    });
  }
  out.sort((a, b) => (b.edgePp ?? 0) - (a.edgePp ?? 0));
  return out.slice(0, limit);
}

export function parseVenue(raw: string | null | undefined): 'ST' | 'HV' | null {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'ST' || v === 'HV') return v;
  if (v === '沙田') return 'ST';
  if (v === '跑馬地' || v === '快活谷') return 'HV';
  return null;
}

export function parseDistance(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 800 || n > 3200) return null;
  return Math.trunc(n);
}

export function parseCourse(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t || t.length > 16) return null;
  return t;
}
