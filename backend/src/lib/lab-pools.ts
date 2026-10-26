/**
 * 彩池組合優化器（研究層）——只用凍結 pWin + Plackett–Luce／Harville。
 * 唔用臨場賠率、唔算「值博」、唔產生投注連結。
 */
import { computeRaceProbabilities, PL_PROB_MODEL } from './pl-prob';
import { dateIsLocked } from './prediction-lock-db';
import { dateFromRaceId, validateRaceId } from './running-style';

export const POOLS_DISCLAIMER =
  '研究用・唔係官方建議・唔入公開戰績。只用凍結模型機率（Harville／PL）派生組合；跨場標獨立假設。非投注建議，無落注連結。';

export const POOLS_RESEARCH_BANNER =
  '研究用・唔係官方建議・唔入公開戰績';

export type PoolKind = 'FF' | 'QUARTET' | 'TRIO';
export type OptimizeMethod = 'top_k' | 'banker_box';

export type PoolRunner = {
  horseId: string;
  horseNumber: number;
  nameCh: string | null;
  pWin: number;
  rank: number;
  score: number;
};

export type PoolCombo = {
  raceId: string;
  pool: PoolKind;
  method: OptimizeMethod;
  /** 馬號組合（FF／TRIO 無序；QUARTET 有序用 `-` 連接） */
  combination: string;
  horseNumbers: number[];
  horseIds: string[];
  legs: number;
  unitStake: number;
  bets: number;
  cost: number;
  /** 模型估算：該組合覆蓋／命中機率（Harville） */
  modelHitProb: number;
  note: string;
};

const UNIT: Record<PoolKind, number> = { FF: 1, QUARTET: 1, TRIO: 10 };

export function parsePool(raw: string): PoolKind | null {
  const u = raw.trim().toUpperCase();
  if (u === 'FF' || u === 'FIRST4' || u === 'F-F' || u === 'FIRST_4') return 'FF';
  if (u === 'QUARTET' || u === 'QTT' || u === '四重彩') return 'QUARTET';
  if (u === 'TRIO' || u === 'TCE' || u === '三重彩') return 'TRIO';
  return null;
}

export function parseMethod(raw: string | undefined): OptimizeMethod {
  const u = String(raw ?? 'top_k').trim().toLowerCase();
  if (u === 'banker_box' || u === 'banker' || u === '膽拖') return 'banker_box';
  return 'top_k';
}

/** Combinations C(n,k) count */
export function combCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Permutations P(n,k) */
export function permCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}


/** Coverage P(top-m all in index set S) via Harville on worths from pWin. */
function boxHitProb(pWin: number[], indices: number[], m: number): number {
  // Reconstruct approximate worths from pWin (monotone with score).
  const scores = pWin.map((p) => Math.log(Math.max(p, 1e-12)));
  const { coverage, exact, pWin: pw } = computeRaceProbabilities(scores);
  // Prefer exact coverage when set matches top-N analytic blocks; else DFS via computeRaceProbabilities field.
  // Always compute custom set with internal approach: use scores → worths → coverageProb is private,
  // so approximate with product of top-m place marginals when exact coverage N matches, else use
  // monte-free: P ≈ coverage of predicted top-|S| scaled — better: re-call compute and map.
  void coverage;
  void exact;
  void pw;
  // Direct Harville DFS (duplicated lightly to keep lab-pools self-contained for arbitrary S)
  const N = pWin.length;
  const mx = Math.max(...scores);
  const v = scores.map((s) => Math.exp(s - mx));
  m = Math.min(m, N, indices.length);
  if (m === 0) return 1;
  const used = new Array(N).fill(false);
  const rec = (depth: number, prob: number): number => {
    if (depth === m) return prob;
    let denom = 0;
    for (let i = 0; i < N; i++) if (!used[i]) denom += v[i]!;
    if (denom <= 0) return 0;
    let tot = 0;
    for (const i of indices) {
      if (used[i]) continue;
      used[i] = true;
      tot += rec(depth + 1, (prob * v[i]!) / denom);
      used[i] = false;
    }
    return tot;
  };
  return rec(0, 1);
}

/** Ordered quartet hit: P(exact order of 4 distinct horses in positions 1..4). */
function orderedQuartetProb(pWin: number[], orderIdx: number[]): number {
  if (orderIdx.length !== 4) return 0;
  const scores = pWin.map((p) => Math.log(Math.max(p, 1e-12)));
  const mx = Math.max(...scores);
  const v = scores.map((s) => Math.exp(s - mx));
  const N = v.length;
  const used = new Array(N).fill(false);
  let prob = 1;
  for (const i of orderIdx) {
    let denom = 0;
    for (let j = 0; j < N; j++) if (!used[j]) denom += v[j]!;
    if (denom <= 0) return 0;
    prob *= v[i]! / denom;
    used[i] = true;
  }
  return prob;
}

export function chooseTopK(fieldSize: number, pool: PoolKind, budget: number, method: OptimizeMethod): number {
  const unit = UNIT[pool];
  const depth = pool === 'TRIO' ? 3 : 4;
  // Find largest K such that box cost fits budget (single race).
  let best = depth;
  for (let k = fieldSize; k >= depth; k--) {
    const bets =
      pool === 'QUARTET' && method === 'top_k'
        ? permCount(k, 4) // 複式有序四重彩 = P(K,4) 注；研究層用「前 K 全排列」估算
        : pool === 'QUARTET' && method === 'banker_box'
          ? Math.max(1, permCount(Math.max(0, k - 1), 3)) // 1 膽 + 腳
          : combCount(k, depth);
    const cost = bets * unit;
    if (cost <= budget && cost > 0) {
      best = k;
      break;
    }
    best = depth;
  }
  // If even minimum exceeds budget, still return depth (caller reports overspend).
  return Math.min(best, fieldSize);
}

export function buildCombosForRace(opts: {
  raceId: string;
  pool: PoolKind;
  method: OptimizeMethod;
  budget: number;
  runners: PoolRunner[];
}): { combos: PoolCombo[]; warnings: string[] } {
  const { raceId, pool, method, budget, runners } = opts;
  const warnings: string[] = [];
  const sorted = [...runners].sort((a, b) => b.pWin - a.pWin || a.rank - b.rank);
  if (sorted.length < (pool === 'TRIO' ? 3 : 4)) {
    warnings.push(`${raceId}: 場內馬數不足`);
    return { combos: [], warnings };
  }
  const pWin = sorted.map((r) => r.pWin);
  // renormalize
  const z = pWin.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < pWin.length; i++) pWin[i] = pWin[i]! / z;

  const depth = pool === 'TRIO' ? 3 : 4;
  const k = chooseTopK(sorted.length, pool, budget, method);
  const selected = sorted.slice(0, k);
  const indices = selected.map((_, i) => i); // indices into pWin/sorted prefix — wait, pWin is full sorted field
  // Use indices 0..k-1 into sorted/pWin
  const selIdx = Array.from({ length: k }, (_, i) => i);
  const unit = UNIT[pool];

  if (method === 'banker_box') {
    const banker = selected[0]!;
    const legs = selected.slice(1);
    if (legs.length < depth - 1) {
      warnings.push(`${raceId}: 膽拖腳不足`);
      return { combos: [], warnings };
    }
    if (pool === 'QUARTET') {
      // 1 banker in win position variants is complex; research MVP: banker must be in top-4 set, legs box ordered as P(legs,3) with banker fixed 1st — document as simplified.
      const bets = permCount(legs.length, 3);
      const cost = bets * unit;
      const orderProb = (() => {
        // Approx: banker wins * Harville for legs taking 2..4 among remaining — use box of {banker}+legs for coverage
        const setIdx = [0, ...legs.map((_, i) => i + 1)];
        return boxHitProb(pWin, setIdx, 4) * 0.25; // crude share for banker-first among box
      })();
      const combo: PoolCombo = {
        raceId,
        pool,
        method,
        combination: `${banker.horseNumber}>${legs.map((l) => l.horseNumber).join(',')}`,
        horseNumbers: [banker.horseNumber, ...legs.map((l) => l.horseNumber)],
        horseIds: [banker.horseId, ...legs.map((l) => l.horseId)],
        legs: legs.length,
        unitStake: unit,
        bets,
        cost,
        modelHitProb: round4(orderProb),
        note: '膽拖（簡化：膽固定頭馬位置估算；研究層）',
      };
      return { combos: cost <= budget * 1.0001 ? [combo] : [combo], warnings: cost > budget ? [`${raceId}: 成本 ${cost} 超預算 ${budget}`] : warnings };
    }
    // FF / TRIO banker box = C(legs, depth-1) with banker included
    const need = depth - 1;
    const bets = combCount(legs.length, need);
    const cost = bets * unit;
    const setIdx = [0, ...legs.map((_, i) => i + 1)];
    const hit = boxHitProb(pWin, setIdx, depth);
    const combo: PoolCombo = {
      raceId,
      pool,
      method,
      combination: `${banker.horseNumber}>${legs.map((l) => l.horseNumber).join(',')}`,
      horseNumbers: [banker.horseNumber, ...legs.map((l) => l.horseNumber)],
      horseIds: [banker.horseId, ...legs.map((l) => l.horseId)],
      legs: legs.length,
      unitStake: unit,
      bets,
      cost,
      modelHitProb: round4(hit),
      note: '膽拖複式（無序彩池；研究層）',
    };
    if (cost > budget) warnings.push(`${raceId}: 成本 ${cost} 超預算 ${budget}`);
    return { combos: [combo], warnings };
  }

  // top_k box
  if (pool === 'QUARTET') {
    // Research: report one summary line for full permutation box of top-K, plus optional top single ordered line.
    const bets = permCount(k, 4);
    const cost = bets * unit;
    const hit = boxHitProb(pWin, selIdx, 4); // coverage of unordered set (= FF coverage); ordered share lower
    const nums = selected.map((r) => r.horseNumber);
    const combo: PoolCombo = {
      raceId,
      pool,
      method,
      combination: nums.join('-'),
      horseNumbers: nums,
      horseIds: selected.map((r) => r.horseId),
      legs: k,
      unitStake: unit,
      bets,
      cost,
      modelHitProb: round4(hit / 24), // 4! orders share coverage roughly for equal-ish — document as approx ordered
      note: `前 ${k} 有序複式 P(${k},4)；命中機率為組合覆蓋／24 近似`,
    };
    // Also emit best single ordered by model (top4 by pWin order)
    const bestOrder = selected.slice(0, 4);
    const bestIdx = [0, 1, 2, 3];
    const singleProb = orderedQuartetProb(pWin, bestIdx);
    const single: PoolCombo = {
      raceId,
      pool,
      method,
      combination: bestOrder.map((r) => r.horseNumber).join('-'),
      horseNumbers: bestOrder.map((r) => r.horseNumber),
      horseIds: bestOrder.map((r) => r.horseId),
      legs: 4,
      unitStake: unit,
      bets: 1,
      cost: unit,
      modelHitProb: round4(singleProb),
      note: '模型排序單注（研究）',
    };
    if (cost > budget) warnings.push(`${raceId}: 複式成本 ${cost} 超預算 ${budget}；仍回傳方案供參考`);
    return { combos: budget >= cost ? [combo, single] : [single, combo], warnings };
  }

  const bets = combCount(k, depth);
  const cost = bets * unit;
  const hit = boxHitProb(pWin, selIdx, depth);
  const nums = selected.map((r) => r.horseNumber);
  const combo: PoolCombo = {
    raceId,
    pool,
    method,
    combination: nums.slice().sort((a, b) => a - b).join(','),
    horseNumbers: nums,
    horseIds: selected.map((r) => r.horseId),
    legs: k,
    unitStake: unit,
    bets,
    cost,
    modelHitProb: round4(hit),
    note: `前 ${k} 無序複式 C(${k},${depth})`,
  };
  if (cost > budget) warnings.push(`${raceId}: 成本 ${cost} 超預算 ${budget}`);
  return { combos: [combo], warnings };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export type RaceFrozenField = {
  raceId: string;
  date: string;
  venue: string;
  raceNumber: number;
  locked: boolean;
  runners: PoolRunner[];
};

export async function loadFrozenFieldForRaceId(
  db: D1Database,
  raceId: string,
  engine = 'v12',
): Promise<{ ok: true; field: RaceFrozenField } | { ok: false; status: number; error: string; message: string }> {
  if (!validateRaceId(raceId)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'raceId 格式須為 race_YYYY-MM-DD_ST|HV_N' };
  }
  const date = dateFromRaceId(raceId);
  const race = await db
    .prepare(
      `SELECT r.id, r.race_number, rm.date AS meeting_date, rm.venue
         FROM races r
         JOIN race_meetings rm ON rm.id = r.meeting_id
        WHERE r.id = ?
        LIMIT 1`,
    )
    .bind(raceId)
    .first<{ id: string; meeting_date: string; venue: string; race_number: number }>();
  // Prefer DB meta; fall back to raceId parse when row missing (tests / partial DBs).
  const parsed = /^race_(\d{4}-\d{2}-\d{2})_(ST|HV)_(\d+)$/.exec(raceId);
  if (!race && !parsed) {
    return { ok: false, status: 404, error: 'not_found', message: '找不到該場次' };
  }
  const venue = race?.venue ?? (parsed?.[2] as string);
  const raceNumber = race?.race_number ?? Number(parsed?.[3] ?? 0);
  const locked = await dateIsLocked(db, date, venue);
  if (!locked) {
    return {
      ok: false,
      status: 403,
      error: 'not_frozen',
      message: '只接受已凍結賽日嘅預測；未鎖今日／該日唔開放',
    };
  }
  const { results } = await db
    .prepare(
      `SELECT pl.horse_id, pl.horse_number, pl.p_win, pl.predicted_rank, pl.final_score,
              h.name_ch AS name_ch
         FROM prediction_log pl
         LEFT JOIN horses h ON h.id = pl.horse_id
        WHERE pl.date = ? AND pl.engine = ? AND pl.variant = 'baseline'
          AND pl.race_number = ?
          AND pl.predicted_rank IS NOT NULL
        ORDER BY pl.predicted_rank ASC`,
    )
    .bind(date, engine, raceNumber)
    .all<{
      horse_id: string;
      horse_number: number;
      p_win: number | null;
      predicted_rank: number;
      final_score: number | null;
      name_ch: string | null;
    }>();
  const rows = results ?? [];
  if (!rows.length) {
    return { ok: false, status: 404, error: 'not_found', message: '該場無凍結預測' };
  }
  const runners: PoolRunner[] = rows.map((r) => ({
    horseId: r.horse_id,
    horseNumber: Number(r.horse_number),
    nameCh: r.name_ch,
    pWin: Number(r.p_win ?? 0),
    rank: Number(r.predicted_rank),
    score: Number(r.final_score ?? 0),
  }));
  // If pWin all zero, derive from rank scores via softmax on final_score
  if (runners.every((x) => x.pWin <= 0) && runners.some((x) => Number.isFinite(x.score))) {
    const probs = computeRaceProbabilities(runners.map((x) => x.score)).pWin;
    runners.forEach((r, i) => {
      r.pWin = probs[i] ?? 0;
    });
  }
  return {
    ok: true,
    field: {
      raceId,
      date,
      venue,
      raceNumber,
      locked: true,
      runners,
    },
  };
}

export function optimizePools(input: {
  pool: PoolKind;
  method: OptimizeMethod;
  budget: number;
  fields: RaceFrozenField[];
}): {
  combos: PoolCombo[];
  totalCost: number;
  totalModelHitProbProxy: number;
  warnings: string[];
  model: string;
  disclaimer: string;
  researchBanner: string;
  scope: string;
} {
  const perRaceBudget = input.fields.length > 0 ? input.budget / input.fields.length : input.budget;
  const combos: PoolCombo[] = [];
  const warnings: string[] = [
    '跨場標獨立假設：各場機率相乘唔保證聯合校準。',
    '孖T／三T 跨場彩池列為 phase-2，本 MVP 只涵蓋單場 FF／QUARTET／TRIO。',
  ];
  for (const field of input.fields) {
    const built = buildCombosForRace({
      raceId: field.raceId,
      pool: input.pool,
      method: input.method,
      budget: perRaceBudget,
      runners: field.runners,
    });
    warnings.push(...built.warnings);
    combos.push(...built.combos);
  }
  // Greedy keep under total budget by modelHitProb/cost
  const affordable = [...combos].sort((a, b) => b.modelHitProb / Math.max(b.cost, 1e-9) - a.modelHitProb / Math.max(a.cost, 1e-9));
  const kept: PoolCombo[] = [];
  let spent = 0;
  for (const c of affordable) {
    // Prefer keeping the primary box per race; allow single+box if fits
    if (spent + c.cost <= input.budget + 1e-9) {
      kept.push(c);
      spent += c.cost;
    }
  }
  // If nothing fit, still return cheapest per race for transparency
  if (!kept.length && combos.length) {
    const byRace = new Map<string, PoolCombo>();
    for (const c of combos) {
      const prev = byRace.get(c.raceId);
      if (!prev || c.cost < prev.cost) byRace.set(c.raceId, c);
    }
    kept.push(...byRace.values());
    warnings.push('預算不足以覆蓋建議複式；回傳每場最低成本方案供研究。');
    spent = kept.reduce((a, c) => a + c.cost, 0);
  }
  return {
    combos: kept,
    totalCost: Math.round(spent * 100) / 100,
    totalModelHitProbProxy: round4(kept.reduce((a, c) => a + c.modelHitProb, 0) / Math.max(kept.length, 1)),
    warnings,
    model: PL_PROB_MODEL,
    disclaimer: POOLS_DISCLAIMER,
    researchBanner: POOLS_RESEARCH_BANNER,
    scope: '單場 FF／QUARTET／TRIO；孖T／三T phase-2',
  };
}
