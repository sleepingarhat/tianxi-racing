/**
 * Pro 研究室：自訂特徵組合回測引擎（研究層）。
 * 權重綜合分、strategy-pnl $10／注箱形規則、訓練／驗證分段、樣本<200 唔出 ROI。
 * 唔入公開戰績；矩陣來源可係 demo fixture／D1 快取（R2 binding 待開）。
 */
export const LAB_FEATURE_IDS = [
  'h2h',
  'distance',
  'draw',
  'time',
  'finish',
  'jt',
  'form',
  'track',
  'rest',
  'weight',
  'careerWin',
  'careerTop3',
  'distStarts',
  'drawStarts',
  'comboTop3',
  'formSlope',
  'formTop3',
  'weightAvg5',
  'goingTop3',
  'elo',
] as const;

export type LabFeatureId = (typeof LAB_FEATURE_IDS)[number];

export const POOL_COSTS = {
  FF: 10,
  TRIO: 40,
  TIERCE: 240,
  QUARTET: 240,
} as const;

export type PoolCode = keyof typeof POOL_COSTS;

export const ALL_POOLS: PoolCode[] = ['FF', 'TRIO', 'TIERCE', 'QUARTET'];

export const RESEARCH_LAYER_NOTE =
  '研究層結果：唔入公開戰績、對帳、Telegram 公開頻道。';

export const MIN_ROI_SAMPLE = 200;

export type FeatureWeight = {
  id: LabFeatureId;
  weight: number; // 0–3, step 0.5
  invert?: boolean;
};

export type BacktestParams = {
  features: FeatureWeight[];
  from: string; // YYYY-MM-DD
  to: string;
  pools: PoolCode[];
  /** 驗證段起始（預設＝from/to 內最後約 25% 賽日，或近一季） */
  valFrom?: string;
  matrixVersion?: string;
};

export type MatrixRunner = {
  horseNumber: number;
  /** as-of 標準化分數（約 0–100）；缺值可省略 */
  scores: Partial<Record<LabFeatureId, number>>;
  finishingPosition: number | null;
  /** 可選：該場官方凍結四揀馬號（有則用於官方基線） */
  officialPick?: boolean;
};

export type MatrixRace = {
  raceId: string;
  date: string;
  venue?: string;
  runners: MatrixRunner[];
  /** 箱形派彩（$10 注單位）；冇則只計命中 */
  boxDividends?: Partial<Record<PoolCode, number>>;
};

export type FeatureMatrix = {
  version: string;
  source: 'demo-fixture' | 'd1-cache' | 'r2' | 'actions-artifact';
  races: MatrixRace[];
  note?: string;
};

export type StrategySeriesPoint = {
  date: string;
  races: number;
  avgTop4Hits: number;
  cost: number;
  payout: number;
  net: number;
  cum: number;
};

export type StrategySummary = {
  label: string;
  raceCount: number;
  avgTop4Hits: number;
  poolHits: Partial<Record<PoolCode, { hits: number; bets: number; rate: number }>>;
  cost: number | null;
  payout: number | null;
  net: number | null;
  roiPct: number | null;
  maxDrawdown: number | null;
  /** 最長連輸賽日（日淨盈虧 < 0 嘅連續日數）；冇 series 時 null */
  maxLosingStreakDays: number | null;
  showRoi: boolean;
};

/** 實盤凍結標籤起計日（公開戰績／實盤標記；唔同研究層回測窗） */
export const LIVE_FROM_DATE = '2026-10-04' as const;

export type CompareStrategyKind = 'official' | 'elo' | 'custom';

export type CompareStrategyInput = {
  key: string;
  label: string;
  kind: CompareStrategyKind;
  /** custom 槽必填；official／elo 可省略 */
  features?: FeatureWeight[];
};

export type CompareSeriesPoint = StrategySeriesPoint & {
  phase: 'live' | 'backtest';
};

export type CompareStrategyResult = {
  key: string;
  label: string;
  kind: CompareStrategyKind;
  summary: StrategySummary;
  series: CompareSeriesPoint[];
  liveFrom: typeof LIVE_FROM_DATE;
};

export type CompareDayDiff = {
  date: string;
  phase: 'live' | 'backtest';
  nets: Record<string, number>;
  cums: Record<string, number>;
  maxGap: number | null;
  maxGapKeys: [string, string] | null;
};

export type CompareResult = {
  status: 'ready';
  from: string;
  to: string;
  pools: PoolCode[];
  strategies: CompareStrategyResult[];
  dayDiff: CompareDayDiff[];
  researchNote: string;
  matrixVersion: string;
  matrixSource: FeatureMatrix['source'];
  limitations: string[];
  liveFrom: typeof LIVE_FROM_DATE;
};

export type BacktestResult = {
  hash: string;
  status: 'ready';
  params: BacktestParams;
  matrixVersion: string;
  matrixSource: FeatureMatrix['source'];
  researchNote: string;
  train: StrategySummary;
  validation: StrategySummary;
  overall: StrategySummary;
  /** 官方四揀基線（有 officialPick 標記時） */
  officialBaseline: StrategySummary | null;
  /** 純 Elo 基線 */
  eloBaseline: StrategySummary | null;
  series: StrategySeriesPoint[];
  bySeason: { season: string; summary: StrategySummary }[];
  computedAt: string;
  limitations: string[];
};

function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 0;
  const stepped = Math.round(w * 2) / 2;
  return Math.max(0, Math.min(3, stepped));
}

export function normalizeWeights(features: FeatureWeight[]): FeatureWeight[] {
  const seen = new Set<string>();
  const out: FeatureWeight[] = [];
  for (const f of features) {
    if (!LAB_FEATURE_IDS.includes(f.id)) continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const weight = clampWeight(f.weight);
    if (weight <= 0) continue;
    out.push({ id: f.id, weight, invert: !!f.invert });
  }
  return out;
}

export function validateParams(raw: unknown): { ok: true; params: BacktestParams } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body 必須係 JSON object' };
  const b = raw as Record<string, unknown>;
  const from = String(b.from ?? '');
  const to = String(b.to ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { ok: false, error: 'from／to 必須係 YYYY-MM-DD' };
  }
  if (from > to) return { ok: false, error: 'from 唔可以遲過 to' };
  const featuresRaw = Array.isArray(b.features) ? b.features : [];
  const features = normalizeWeights(
    featuresRaw.map((x: any) => ({
      id: String(x?.id ?? x?.feature ?? '') as LabFeatureId,
      weight: Number(x?.weight ?? 1),
      invert: !!(x?.invert ?? x?.reverse),
    })),
  );
  if (!features.length) return { ok: false, error: '至少要有一項權重 > 0 嘅特徵' };
  const poolsRaw = Array.isArray(b.pools) ? b.pools.map(String) : ALL_POOLS;
  const pools = poolsRaw.filter((p): p is PoolCode => (ALL_POOLS as string[]).includes(p));
  if (!pools.length) return { ok: false, error: 'pools 無效' };
  const valFrom = b.valFrom != null ? String(b.valFrom) : undefined;
  if (valFrom && !/^\d{4}-\d{2}-\d{2}$/.test(valFrom)) {
    return { ok: false, error: 'valFrom 必須係 YYYY-MM-DD' };
  }
  return {
    ok: true,
    params: {
      features,
      from,
      to,
      pools,
      valFrom,
      matrixVersion: b.matrixVersion != null ? String(b.matrixVersion) : undefined,
    },
  };
}

/** 穩定 hash（Web Crypto 或 Node）；回傳 hex 前 32 字。 */
export async function hashParams(
  params: BacktestParams,
  matrixVersion: string,
): Promise<string> {
  const canonical = JSON.stringify({
    features: params.features
      .map((f) => ({ id: f.id, weight: f.weight, invert: !!f.invert }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    from: params.from,
    to: params.to,
    pools: [...params.pools].sort(),
    valFrom: params.valFrom ?? null,
    matrixVersion,
  });
  const data = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export function compositeScore(
  scores: Partial<Record<LabFeatureId, number>>,
  weights: FeatureWeight[],
): number {
  let sum = 0;
  let wSum = 0;
  for (const w of weights) {
    const raw = scores[w.id];
    if (raw == null || !Number.isFinite(raw)) continue;
    const v = w.invert ? 100 - raw : raw;
    sum += v * w.weight;
    wSum += w.weight;
  }
  if (wSum <= 0) return 0;
  return sum / wSum;
}

export function pickTop4(
  runners: MatrixRunner[],
  weights: FeatureWeight[],
): number[] {
  return [...runners]
    .map((r) => ({ no: r.horseNumber, score: compositeScore(r.scores, weights) }))
    .sort((a, b) => b.score - a.score || a.no - b.no)
    .slice(0, 4)
    .map((x) => x.no);
}

function top4Hits(predicted: number[], actualPositions: Map<number, number>): number {
  let hits = 0;
  for (const no of predicted) {
    const pos = actualPositions.get(no);
    if (pos != null && pos >= 1 && pos <= 4) hits++;
  }
  return hits;
}

function poolHit(
  pool: PoolCode,
  predicted: number[],
  actualTop: number[],
): boolean {
  const pred = new Set(predicted);
  if (pool === 'FF' || pool === 'QUARTET') {
    if (actualTop.length < 4 || predicted.length < 4) return false;
    if (pool === 'FF') {
      return actualTop.slice(0, 4).every((n) => pred.has(n));
    }
    // QUARTET 依序：預測排序＝名次排序（簡化：用預測次序對實際 1–4）
    return predicted.length >= 4 && predicted.every((n, i) => n === actualTop[i]);
  }
  if (pool === 'TRIO') {
    if (actualTop.length < 3 || predicted.length < 3) return false;
    return actualTop.slice(0, 3).every((n) => pred.has(n));
  }
  if (pool === 'TIERCE') {
    if (actualTop.length < 3 || predicted.length < 3) return false;
    return predicted[0] === actualTop[0] && predicted[1] === actualTop[1] && predicted[2] === actualTop[2];
  }
  return false;
}

function emptyPoolHits(pools: PoolCode[]) {
  const out: StrategySummary['poolHits'] = {};
  for (const p of pools) out[p] = { hits: 0, bets: 0, rate: 0 };
  return out;
}

function emptySummary(label: string, pools: PoolCode[]): StrategySummary {
  return {
    label,
    raceCount: 0,
    avgTop4Hits: 0,
    poolHits: emptyPoolHits(pools),
    cost: null,
    payout: null,
    net: null,
    roiPct: null,
    maxDrawdown: null,
    maxLosingStreakDays: null,
    showRoi: false,
  };
}

export function maxLosingStreakDays(series: StrategySeriesPoint[]): number {
  let best = 0;
  let cur = 0;
  for (const p of series) {
    if (p.net < 0) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

export function seriesPhase(date: string): 'live' | 'backtest' {
  return date >= LIVE_FROM_DATE ? 'live' : 'backtest';
}

type RaceEval = {
  date: string;
  hits: number;
  cost: number;
  payout: number;
  net: number;
  poolHits: Partial<Record<PoolCode, boolean>>;
};

function evaluateRaces(
  races: MatrixRace[],
  weights: FeatureWeight[],
  pools: PoolCode[],
  pickFn: (runners: MatrixRunner[]) => number[],
): { summary: StrategySummary; series: StrategySeriesPoint[]; evals: RaceEval[] } {
  const evals: RaceEval[] = [];
  for (const race of races) {
    const actualPositions = new Map<number, number>();
    for (const r of race.runners) {
      if (r.finishingPosition != null && r.finishingPosition > 0) {
        actualPositions.set(r.horseNumber, r.finishingPosition);
      }
    }
    if (actualPositions.size < 4) continue;
    const actualTop = [...actualPositions.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([no]) => no);
    const predicted = pickFn(race.runners);
    if (new Set(predicted).size < 4) continue;

    const hits = top4Hits(predicted, actualPositions);
    let cost = 0;
    let payout = 0;
    const ph: Partial<Record<PoolCode, boolean>> = {};
    for (const pool of pools) {
      cost += POOL_COSTS[pool];
      const hit = poolHit(pool, predicted, actualTop);
      ph[pool] = hit;
      if (hit) {
        const div = race.boxDividends?.[pool];
        // 冇派彩資料時：命中記 0 派彩（只計命中率）；有則用 $10 單位派彩
        if (div != null && Number.isFinite(div)) payout += Number(div);
      }
    }
    evals.push({
      date: race.date,
      hits,
      cost,
      payout,
      net: payout - cost,
      poolHits: ph,
    });
  }

  const byDate = new Map<string, RaceEval[]>();
  for (const e of evals) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }
  const series: StrategySeriesPoint[] = [];
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!;
    const racesN = day.length;
    const avgHits = day.reduce((s, x) => s + x.hits, 0) / racesN;
    const cost = day.reduce((s, x) => s + x.cost, 0);
    const payout = day.reduce((s, x) => s + x.payout, 0);
    const net = payout - cost;
    cum += net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    series.push({ date, races: racesN, avgTop4Hits: Math.round(avgHits * 100) / 100, cost, payout, net, cum });
  }

  const raceCount = evals.length;
  const showRoi = raceCount >= MIN_ROI_SAMPLE;
  const totalCost = evals.reduce((s, x) => s + x.cost, 0);
  const totalPayout = evals.reduce((s, x) => s + x.payout, 0);
  const totalNet = totalPayout - totalCost;
  const poolHits = emptyPoolHits(pools);
  for (const e of evals) {
    for (const pool of pools) {
      const bucket = poolHits[pool]!;
      bucket.bets++;
      if (e.poolHits[pool]) bucket.hits++;
    }
  }
  for (const pool of pools) {
    const b = poolHits[pool]!;
    b.rate = b.bets ? Math.round((b.hits / b.bets) * 1000) / 10 : 0;
  }
  const avgTop4Hits = raceCount
    ? Math.round((evals.reduce((s, x) => s + x.hits, 0) / raceCount) * 100) / 100
    : 0;

  const hasAnyDiv = races.some((r) => r.boxDividends && Object.keys(r.boxDividends).length > 0);

  const losingStreak = maxLosingStreakDays(series);
  const summary: StrategySummary = {
    label: 'custom',
    raceCount,
    avgTop4Hits,
    poolHits,
    cost: hasAnyDiv ? totalCost : null,
    payout: hasAnyDiv ? totalPayout : null,
    net: hasAnyDiv ? totalNet : null,
    roiPct: hasAnyDiv && showRoi && totalCost ? Math.round((totalNet / totalCost) * 1000) / 10 : null,
    maxDrawdown: hasAnyDiv && showRoi ? Math.round(maxDd * 10) / 10 : null,
    maxLosingStreakDays: series.length ? losingStreak : null,
    showRoi: hasAnyDiv && showRoi,
  };
  return { summary, series, evals };
}

function seasonOf(date: string): string {
  // 港季約 9 月起：2025-09 → 2025/26
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (m >= 9) return `${y}/${String(y + 1).slice(2)}`;
  return `${y - 1}/${String(y).slice(2)}`;
}

function defaultValFrom(dates: string[]): string | undefined {
  if (dates.length < 8) return dates[Math.floor(dates.length * 0.75)] ?? dates[dates.length - 1];
  // 約最後 25% 賽日
  const idx = Math.floor(dates.length * 0.75);
  return dates[idx];
}

export function runBacktest(matrix: FeatureMatrix, params: BacktestParams): Omit<BacktestResult, 'hash' | 'computedAt'> {
  const weights = normalizeWeights(params.features);
  const pools = params.pools.length ? params.pools : ALL_POOLS;
  const races = matrix.races.filter((r) => r.date >= params.from && r.date <= params.to);
  const dates = [...new Set(races.map((r) => r.date))].sort();
  const valFrom = params.valFrom && params.valFrom >= params.from && params.valFrom <= params.to
    ? params.valFrom
    : defaultValFrom(dates) ?? params.to;

  const trainRaces = races.filter((r) => r.date < valFrom);
  const valRaces = races.filter((r) => r.date >= valFrom);

  const pickCustom = (runners: MatrixRunner[]) => pickTop4(runners, weights);
  const pickElo = (runners: MatrixRunner[]) =>
    pickTop4(runners, [{ id: 'elo', weight: 1 }]);
  const pickOfficial = (runners: MatrixRunner[]) => {
    const flagged = runners.filter((r) => r.officialPick).map((r) => r.horseNumber);
    if (flagged.length >= 4) return flagged.slice(0, 4);
    // 冇標記時用 elo 代替並喺 summary 標明
    return pickElo(runners);
  };

  const overall = evaluateRaces(races, weights, pools, pickCustom);
  const train = evaluateRaces(trainRaces, weights, pools, pickCustom);
  const validation = evaluateRaces(valRaces, weights, pools, pickCustom);
  train.summary.label = 'train';
  validation.summary.label = 'validation';
  overall.summary.label = 'custom';

  const hasOfficial = races.some((r) => r.runners.some((x) => x.officialPick));
  const officialBaseline = hasOfficial
    ? evaluateRaces(races, weights, pools, pickOfficial).summary
    : null;
  if (officialBaseline) officialBaseline.label = 'official';

  const eloBaseline = evaluateRaces(races, weights, pools, pickElo).summary;
  eloBaseline.label = 'elo';

  const bySeasonMap = new Map<string, MatrixRace[]>();
  for (const r of races) {
    const s = seasonOf(r.date);
    const list = bySeasonMap.get(s) ?? [];
    list.push(r);
    bySeasonMap.set(s, list);
  }
  const bySeason = [...bySeasonMap.keys()].sort().map((season) => ({
    season,
    summary: evaluateRaces(bySeasonMap.get(season)!, weights, pools, pickCustom).summary,
  }));

  const limitations: string[] = [
    RESEARCH_LAYER_NOTE,
    '只用 as-of 特徵；訓練段同驗證段分開顯示，防過擬合。',
  ];
  if (matrix.source !== 'r2') {
    limitations.push(
      `特徵矩陣來源＝${matrix.source}（production R2 binding 尚未開通；夜間 dump-features→R2 待接）。`,
    );
  }
  if (!races.some((r) => r.boxDividends && Object.keys(r.boxDividends).length)) {
    limitations.push('呢批矩陣冇箱形派彩：只出命中，唔出 ROI／盈虧。');
  }
  if (overall.summary.raceCount < MIN_ROI_SAMPLE) {
    limitations.push(`樣本 ${overall.summary.raceCount} 場 < ${MIN_ROI_SAMPLE}：唔顯示 ROI。`);
  }

  return {
    status: 'ready',
    params: { ...params, features: weights, pools, valFrom },
    matrixVersion: matrix.version,
    matrixSource: matrix.source,
    researchNote: RESEARCH_LAYER_NOTE,
    train: train.summary,
    validation: validation.summary,
    overall: overall.summary,
    officialBaseline,
    eloBaseline,
    series: overall.series,
    bySeason,
    limitations,
  };
}

/** 決定性 PRNG（mulberry32） */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 內建 demo 特徵矩陣（as-of 風格合成資料）。
 * 用嚟喺未有 R2／夜間 artifact 時跑通 API＋單元測試；回應會標 matrixSource=demo-fixture。
 */
export function buildDemoMatrix(opts?: {
  raceCount?: number;
  seed?: number;
  from?: string;
  withDividends?: boolean;
  withOfficial?: boolean;
}): FeatureMatrix {
  const raceCount = opts?.raceCount ?? 220;
  const rand = mulberry32(opts?.seed ?? 20261026);
  const from = opts?.from ?? '2025-09-07';
  const withDividends = opts?.withDividends !== false;
  const withOfficial = opts?.withOfficial !== false;

  const start = Date.parse(`${from}T00:00:00Z`);
  const races: MatrixRace[] = [];
  let ri = 0;
  let dayOffset = 0;
  while (ri < raceCount) {
    // 每 3 日一賽日、每賽日 8–11 場
    const racesToday = 8 + Math.floor(rand() * 4);
    const date = new Date(start + dayOffset * 86400000).toISOString().slice(0, 10);
    const venue = rand() > 0.45 ? 'ST' : 'HV';
    for (let rn = 1; rn <= racesToday && ri < raceCount; rn++, ri++) {
      const nRunners = 10 + Math.floor(rand() * 5);
      const trueStrength: number[] = [];
      for (let i = 0; i < nRunners; i++) trueStrength.push(rand());
      const order = trueStrength
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s);
      const finishPos = new Array(nRunners);
      order.forEach((o, rank) => {
        finishPos[o.i] = rank + 1;
      });

      const runners: MatrixRunner[] = [];
      for (let i = 0; i < nRunners; i++) {
        const strength = trueStrength[i];
        const noise = () => (rand() - 0.5) * 30;
        const scores: Partial<Record<LabFeatureId, number>> = {
          elo: clamp01to100(strength * 100 + noise() * 0.4),
          h2h: clamp01to100(strength * 80 + noise()),
          distance: clamp01to100(strength * 70 + noise()),
          draw: clamp01to100(50 + noise()),
          time: clamp01to100(strength * 75 + noise()),
          finish: clamp01to100(strength * 65 + noise()),
          jt: clamp01to100(40 + noise()),
          form: clamp01to100(strength * 60 + noise()),
          track: clamp01to100(45 + noise()),
          rest: clamp01to100(50 + noise()),
          weight: clamp01to100(50 + noise()),
          careerWin: clamp01to100(strength * 55 + noise()),
          careerTop3: clamp01to100(strength * 60 + noise()),
          distStarts: clamp01to100(40 + noise()),
          drawStarts: clamp01to100(40 + noise()),
          comboTop3: clamp01to100(strength * 50 + noise()),
          formSlope: clamp01to100(50 + noise()),
          formTop3: clamp01to100(strength * 55 + noise()),
          weightAvg5: clamp01to100(50 + noise()),
          goingTop3: clamp01to100(45 + noise()),
        };
        runners.push({
          horseNumber: i + 1,
          scores,
          finishingPosition: finishPos[i],
        });
      }

      // 官方四揀 ≈ elo top4（略加噪）
      if (withOfficial) {
        const eloTop = [...runners]
          .sort(
            (a, b) =>
              (b.scores.elo ?? 0) - (a.scores.elo ?? 0) || a.horseNumber - b.horseNumber,
          )
          .slice(0, 4);
        for (const r of eloTop) r.officialPick = true;
      }

      const actualTop = [...runners]
        .filter((r) => r.finishingPosition != null)
        .sort((a, b) => (a.finishingPosition! - b.finishingPosition!))
        .map((r) => r.horseNumber);

      let boxDividends: MatrixRace['boxDividends'];
      if (withDividends) {
        // 合成派彩：命中時畀一個合理 $10 單位派彩
        boxDividends = {};
        const eloPred = pickTop4(runners, [{ id: 'elo', weight: 1 }]);
        for (const pool of ALL_POOLS) {
          if (poolHit(pool, eloPred, actualTop)) {
            boxDividends[pool] =
              pool === 'FF' ? 80 + rand() * 200
              : pool === 'TRIO' ? 200 + rand() * 600
              : pool === 'TIERCE' ? 800 + rand() * 4000
              : 1500 + rand() * 8000;
          }
        }
      }

      races.push({
        raceId: `race_${date}_${venue}_${rn}`,
        date,
        venue,
        runners,
        boxDividends,
      });
    }
    dayOffset += 3;
  }

  return {
    version: 'demo-v1',
    source: 'demo-fixture',
    races,
    note: '合成 as-of 風格矩陣；production 應改用 dump-features → R2／Actions artifact。',
  };
}

function clamp01to100(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** 官方 vs Elo 最小對照（功能 2 stub／連帶） */
export function compareOfficialVsElo(
  matrix: FeatureMatrix,
  opts: { from: string; to: string; pools?: PoolCode[] },
): {
  official: StrategySummary;
  elo: StrategySummary;
  researchNote: string;
  matrixVersion: string;
  matrixSource: FeatureMatrix['source'];
} {
  const pools = opts.pools ?? ALL_POOLS;
  const races = matrix.races.filter((r) => r.date >= opts.from && r.date <= opts.to);
  const params: BacktestParams = {
    features: [{ id: 'elo', weight: 1 }],
    from: opts.from,
    to: opts.to,
    pools,
  };
  const result = runBacktest({ ...matrix, races }, params);
  return {
    official: result.officialBaseline ?? emptySummary('official', pools),
    elo: result.eloBaseline ?? emptySummary('elo', pools),
    researchNote: RESEARCH_LAYER_NOTE,
    matrixVersion: matrix.version,
    matrixSource: matrix.source,
  };
}

function buildDayDiff(strategies: CompareStrategyResult[]): CompareDayDiff[] {
  const dates = new Set<string>();
  for (const s of strategies) {
    for (const p of s.series) dates.add(p.date);
  }
  const out: CompareDayDiff[] = [];
  for (const date of [...dates].sort()) {
    const nets: Record<string, number> = {};
    const cums: Record<string, number> = {};
    for (const s of strategies) {
      const pt = s.series.find((x) => x.date === date);
      nets[s.key] = pt?.net ?? 0;
      cums[s.key] = pt?.cum ?? 0;
    }
    const keys = strategies.map((s) => s.key);
    let maxGap: number | null = null;
    let maxGapKeys: [string, string] | null = null;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const ka = keys[i]!;
        const kb = keys[j]!;
        const gap = Math.abs((cums[ka] ?? 0) - (cums[kb] ?? 0));
        if (maxGap == null || gap > maxGap) {
          maxGap = Math.round(gap * 10) / 10;
          maxGapKeys = [ka, kb];
        }
      }
    }
    out.push({
      date,
      phase: seriesPhase(date),
      nets,
      cums,
      maxGap,
      maxGapKeys,
    });
  }
  return out;
}

export function validateCompareParams(
  raw: unknown,
): { ok: true; from: string; to: string; pools: PoolCode[]; strategies: CompareStrategyInput[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body／query 必須係 object' };
  const b = raw as Record<string, unknown>;
  const from = String(b.from ?? '');
  const to = String(b.to ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { ok: false, error: 'from／to 必須係 YYYY-MM-DD' };
  }
  if (from > to) return { ok: false, error: 'from 唔可以遲過 to' };

  let pools: PoolCode[] = ALL_POOLS;
  if (b.pools != null) {
    const poolsRaw = Array.isArray(b.pools)
      ? b.pools.map(String)
      : String(b.pools)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    pools = poolsRaw.filter((p): p is PoolCode => (ALL_POOLS as string[]).includes(p));
    if (!pools.length) return { ok: false, error: 'pools 無效' };
  }

  let strategies: CompareStrategyInput[] = [];
  if (Array.isArray(b.strategies) && b.strategies.length) {
    for (const item of b.strategies) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      const kindRaw = String(s.kind ?? s.key ?? '').toLowerCase();
      const kind: CompareStrategyKind =
        kindRaw === 'official' || kindRaw === 'elo' || kindRaw === 'custom'
          ? kindRaw
          : String(s.key ?? '') === 'official'
            ? 'official'
            : String(s.key ?? '') === 'elo'
              ? 'elo'
              : 'custom';
      const key = String(s.key ?? kind).trim() || kind;
      const label = String(s.label ?? (kind === 'official' ? '官方四揀' : kind === 'elo' ? '純 Elo' : key));
      if (kind === 'custom') {
        const featuresRaw = Array.isArray(s.features) ? s.features : [];
        const features = normalizeWeights(
          featuresRaw.map((x: any) => ({
            id: String(x?.id ?? x?.feature ?? '') as LabFeatureId,
            weight: Number(x?.weight ?? 1),
            invert: !!(x?.invert ?? x?.reverse),
          })),
        );
        if (!features.length) return { ok: false, error: `自訂策略「${label}」至少要有一項權重 > 0` };
        strategies.push({ key, label, kind, features });
      } else {
        strategies.push({ key, label, kind });
      }
    }
  } else if (typeof b.strategies === 'string' || b.s != null) {
    const rawKeys = String(b.strategies ?? b.s ?? 'official,elo')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const k of rawKeys) {
      if (k === 'official') strategies.push({ key: 'official', label: '官方四揀', kind: 'official' });
      else if (k === 'elo') strategies.push({ key: 'elo', label: '純 Elo', kind: 'elo' });
      else return { ok: false, error: `GET 只支援 official／elo；自訂請用 POST body（唔識「${k}」）` };
    }
  } else {
    strategies = [
      { key: 'official', label: '官方四揀', kind: 'official' },
      { key: 'elo', label: '純 Elo', kind: 'elo' },
    ];
  }

  if (strategies.length < 2) return { ok: false, error: '至少要兩個策略先比較' };
  if (strategies.length > 4) return { ok: false, error: '最多四個策略槽（A–D）' };
  const seen = new Set<string>();
  for (const s of strategies) {
    if (seen.has(s.key)) return { ok: false, error: `策略 key 重複：${s.key}` };
    seen.add(s.key);
  }
  return { ok: true, from, to, pools, strategies };
}

/**
 * 功能 2 比較器：官方／Elo／自訂（FeatureWeight）並列 summary＋series＋dayDiff。
 * Elo／官方 on-demand 由矩陣計（唔使 elo_baseline_picks 表）。
 */
export function runCompare(
  matrix: FeatureMatrix,
  opts: { from: string; to: string; pools: PoolCode[]; strategies: CompareStrategyInput[] },
): CompareResult {
  const pools = opts.pools.length ? opts.pools : ALL_POOLS;
  const races = matrix.races.filter((r) => r.date >= opts.from && r.date <= opts.to);
  const pickElo = (runners: MatrixRunner[]) => pickTop4(runners, [{ id: 'elo', weight: 1 }]);
  const pickOfficial = (runners: MatrixRunner[]) => {
    const flagged = runners.filter((r) => r.officialPick).map((r) => r.horseNumber);
    if (flagged.length >= 4) return flagged.slice(0, 4);
    return pickElo(runners);
  };

  const results: CompareStrategyResult[] = [];
  const limitations: string[] = [
    RESEARCH_LAYER_NOTE,
    `實盤標記由 ${LIVE_FROM_DATE} 起；之前系列標「回測」。研究層結果永遠唔入公開戰績。`,
  ];

  for (const slot of opts.strategies) {
    let evaluated: { summary: StrategySummary; series: StrategySeriesPoint[] };
    if (slot.kind === 'official') {
      evaluated = evaluateRaces(races, [{ id: 'elo', weight: 1 }], pools, pickOfficial);
      evaluated.summary.label = slot.label;
    } else if (slot.kind === 'elo') {
      evaluated = evaluateRaces(races, [{ id: 'elo', weight: 1 }], pools, pickElo);
      evaluated.summary.label = slot.label;
    } else {
      const weights = normalizeWeights(slot.features ?? []);
      evaluated = evaluateRaces(races, weights, pools, (runners) => pickTop4(runners, weights));
      evaluated.summary.label = slot.label;
    }
    results.push({
      key: slot.key,
      label: slot.label,
      kind: slot.kind,
      summary: evaluated.summary,
      series: evaluated.series.map((p) => ({ ...p, phase: seriesPhase(p.date) })),
      liveFrom: LIVE_FROM_DATE,
    });
  }

  if (matrix.source !== 'r2') {
    limitations.push(
      `特徵矩陣來源＝${matrix.source}（production R2 binding 尚未開通；夜間 dump-features→R2 待接）。`,
    );
  }
  if (!races.some((r) => r.boxDividends && Object.keys(r.boxDividends).length)) {
    limitations.push('呢批矩陣冇箱形派彩：只出命中，唔出 ROI／盈虧。');
  }
  const minRaces = Math.min(...results.map((r) => r.summary.raceCount));
  if (minRaces < MIN_ROI_SAMPLE) {
    limitations.push(`樣本最少 ${minRaces} 場 < ${MIN_ROI_SAMPLE}：唔顯示 ROI（同回測規則）。`);
  }
  limitations.push(
    'elo_baseline_picks 表未建：純 Elo 由矩陣 on-demand 排頭四（可選 backfill migration 見草稿）。',
  );
  limitations.push('自訂策略權重由客戶端帶上；唔依賴雲端 me/strategies。');

  return {
    status: 'ready',
    from: opts.from,
    to: opts.to,
    pools,
    strategies: results,
    dayDiff: buildDayDiff(results),
    researchNote: RESEARCH_LAYER_NOTE,
    matrixVersion: matrix.version,
    matrixSource: matrix.source,
    limitations,
    liveFrom: LIVE_FROM_DATE,
  };
}
