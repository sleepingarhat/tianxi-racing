/**
 * Pro 研究室「分段／走位／節奏」純函式。
 * 無 I/O；路由層負責查 DB、auth。
 * 節奏提示屬研究層，唔入官方四揀。
 */

import {
  STYLE_LABELS,
  classifyStyleFromNorm,
  normalisePosition,
  parseFirstPosition,
  type RunningStyleCode,
  type RunningStyleEntry,
} from './running-style';

export const PACE_DISCLAIMER = '研究提示・唔入排名';
export const RESEARCH_LAYER_NOTE =
  '節奏提示屬研究層，唔影響官方凍結四揀同公開戰績。';

export type PaceLabel = '快' | '中' | '慢';

export type RoleCode = RunningStyleCode;
export const ROLE_LABELS: Record<RoleCode, string> = {
  leader: '領放',
  prominent: '跟前',
  midfield: '居中',
  'held-up': '後上',
};

export type PaceSection = {
  sectionNumber: number;
  distance: number | null;
  raceTime: number | null;
  classMedian: number | null;
  deltaVsMedian: number | null;
};

export type PaceRunner = {
  horseId: string;
  horseNumber: number | null;
  nameCh: string | null;
  nameEn: string | null;
  draw: number | null;
  finishingPosition: number | null;
  runningPosition: string | null;
  positions: (number | null)[];
  times: (number | null)[];
  role: RoleCode | null;
  roleLabel: string | null;
  pickRank: number | null;
};

export type PaceIndex = {
  early: number | null;
  mid: number | null;
  late: number | null;
  label: PaceLabel | null;
  source: 'computed' | 'profile' | 'none';
};

export type StyleMixBucket = {
  code: RoleCode | 'unknown';
  label: string;
  count: number;
  share: number;
};

export type StyleMix = {
  total: number;
  known: number;
  buckets: StyleMixBucket[];
  nLeaders: number;
};

export type PaceForecast = {
  forecast: PaceLabel;
  rationale: string;
  rule: string;
  disclaimer: typeof PACE_DISCLAIMER;
};

export type DrawStyleCell = {
  draw: number;
  style: RoleCode | 'unknown';
  styleLabel: string;
  horseId: string;
  horseNumber: number | null;
  nameCh: string | null;
};

/** 解析沿途走位字串（例 2-3-3-1）為位置陣列；結尾終點名次通常與 finishing 重複，保留原樣。 */
export function parseRunningPositions(
  raw: string | null | undefined,
): number[] {
  if (!raw) return [];
  const trimmed = String(raw).trim();
  if (!/^\d+([-\s]\d+)*$/.test(trimmed)) return [];
  return trimmed
    .split(/[-\s]+/)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isFinite(n) && n >= 1);
}

export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 以早段位置（首個有效位置）分角色；缺資料 → null。 */
export function classifyRole(
  positions: readonly (number | null)[],
  totalRunners: number | null,
): RoleCode | null {
  const first = positions.find((p) => p != null && p >= 1) ?? null;
  const norm = normalisePosition(first, totalRunners);
  if (norm == null) return null;
  return classifyStyleFromNorm(norm);
}

/**
 * 步速指數：本場分段用時相對同程同班中位數。
 * 負＝快過中位；正＝慢。early/mid/late 取相對段落。
 * 閾值：平均 Δ ≤ −0.15 → 快；≥ 0.15 → 慢；其餘中。
 */
export function buildPaceIndex(
  sectionDeltas: readonly (number | null)[],
): PaceIndex {
  const vals = sectionDeltas.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  if (!vals.length) {
    return { early: null, mid: null, late: null, label: null, source: 'none' };
  }
  const n = vals.length;
  const early = vals[0] ?? null;
  const late = vals[n - 1] ?? null;
  const mid =
    n >= 3
      ? median(vals.slice(1, -1))
      : n === 2
        ? vals[0]!
        : null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  let label: PaceLabel = '中';
  if (avg <= -0.15) label = '快';
  else if (avg >= 0.15) label = '慢';
  return { early, mid, late, label, source: 'computed' };
}

export function sectionDelta(
  raceTime: number | null,
  classMedian: number | null,
): number | null {
  if (
    raceTime == null ||
    classMedian == null ||
    !Number.isFinite(raceTime) ||
    !Number.isFinite(classMedian)
  ) {
    return null;
  }
  return Number((raceTime - classMedian).toFixed(3));
}

/**
 * 初版節奏規則（計劃 f4）：慣放 ≥ 3 → 快；0–1 → 慢；其餘中。
 * 之後可用 race_pace_profile 校準並經研究閘。
 */
export function forecastFromLeaders(nLeaders: number): PaceForecast {
  let forecast: PaceLabel;
  let rationale: string;
  if (nLeaders >= 3) {
    forecast = '快';
    rationale = `場內約有 ${nLeaders} 匹慣放，初段競爭可能偏快。`;
  } else if (nLeaders <= 1) {
    forecast = '慢';
    rationale =
      nLeaders === 0
        ? '場內未見穩定慣放，初段或偏慢。'
        : '場內僅約 1 匹慣放，初段或偏慢。';
  } else {
    forecast = '中';
    rationale = `場內約有 ${nLeaders} 匹慣放，節奏或屬中性。`;
  }
  return {
    forecast,
    rationale,
    rule: '慣放≥3→快；0–1→慢；其餘→中（研究層初版）',
    disclaimer: PACE_DISCLAIMER,
  };
}

export function buildStyleMix(
  styles: readonly RunningStyleEntry[],
  fieldSize: number,
): StyleMix {
  const counts: Record<RoleCode | 'unknown', number> = {
    leader: 0,
    prominent: 0,
    midfield: 0,
    'held-up': 0,
    unknown: 0,
  };
  const byHorse = new Map(styles.map((s) => [s.horseId, s]));
  // styles 可能只含有足夠樣本嘅馬；未知數由 fieldSize − known 推算
  for (const s of styles) {
    counts[s.code] += 1;
  }
  const known =
    counts.leader + counts.prominent + counts.midfield + counts['held-up'];
  const unknown = Math.max(0, fieldSize - known);
  counts.unknown = unknown;

  const total = fieldSize > 0 ? fieldSize : known + unknown;
  const order: (RoleCode | 'unknown')[] = [
    'leader',
    'prominent',
    'midfield',
    'held-up',
    'unknown',
  ];
  const buckets: StyleMixBucket[] = order.map((code) => ({
    code,
    label: code === 'unknown' ? '未知' : STYLE_LABELS[code],
    count: counts[code],
    share: total > 0 ? counts[code] / total : 0,
  }));

  return {
    total,
    known,
    buckets,
    nLeaders: counts.leader,
  };
}

/** 檔位 × 跑法小圖用列。 */
export function buildDrawStyleGrid(
  runners: readonly {
    horseId: string;
    horseNumber: number | null;
    nameCh: string | null;
    draw: number | null;
    style: RoleCode | null;
  }[],
): DrawStyleCell[] {
  return runners
    .filter((r) => r.draw != null && Number.isFinite(r.draw))
    .map((r) => {
      const style: RoleCode | 'unknown' = r.style ?? 'unknown';
      return {
        draw: Number(r.draw),
        style,
        styleLabel: style === 'unknown' ? '未知' : STYLE_LABELS[style],
        horseId: r.horseId,
        horseNumber: r.horseNumber,
        nameCh: r.nameCh,
      };
    })
    .sort((a, b) => a.draw - b.draw || (a.horseNumber ?? 99) - (b.horseNumber ?? 99));
}

export function assembleRunner(input: {
  horseId: string;
  horseNumber: number | null;
  nameCh: string | null;
  nameEn: string | null;
  draw: number | null;
  finishingPosition: number | null;
  runningPosition: string | null;
  totalRunners: number | null;
  sectionTimesByNumber: Map<number, number | null>;
  sectionNumbers: number[];
  pickRank: number | null;
}): PaceRunner {
  const positions = parseRunningPositions(input.runningPosition);
  // 若有 horse_sectional 位置，優先用佢哋對齊 sections；否則用沿途走位（去掉終點位若多一段）
  const alignedPositions: (number | null)[] = input.sectionNumbers.map(
    (n, i) => {
      // position_at_section 會喺路由層塞入 map；此處僅用 running positions 對齊
      return positions[i] ?? null;
    },
  );
  const times = input.sectionNumbers.map(
    (n) => input.sectionTimesByNumber.get(n) ?? null,
  );
  const role = classifyRole(
    alignedPositions.length ? alignedPositions : positions,
    input.totalRunners,
  );
  return {
    horseId: input.horseId,
    horseNumber: input.horseNumber,
    nameCh: input.nameCh,
    nameEn: input.nameEn,
    draw: input.draw,
    finishingPosition: input.finishingPosition,
    runningPosition: input.runningPosition,
    positions: alignedPositions.length ? alignedPositions : positions,
    times,
    role,
    roleLabel: role ? ROLE_LABELS[role] : null,
    pickRank: input.pickRank,
  };
}

/** 用 sectional 位置覆蓋／補齊 runner.positions。 */
export function applySectionPositions(
  runner: PaceRunner,
  sectionNumbers: number[],
  positionBySection: Map<number, number | null>,
  totalRunners: number | null,
): PaceRunner {
  const positions = sectionNumbers.map(
    (n) => positionBySection.get(n) ?? null,
  );
  const hasAny = positions.some((p) => p != null);
  if (!hasAny) return runner;
  const role = classifyRole(positions, totalRunners);
  return {
    ...runner,
    positions,
    role,
    roleLabel: role ? ROLE_LABELS[role] : null,
  };
}

/** 凍結四揀 predicted_rank（1–4）；冇就 null。 */
export function resolvePickRank(
  horseId: string,
  pickByHorseId: ReadonlyMap<string, number>,
): number | null {
  const r = pickByHorseId.get(horseId);
  if (r == null || !Number.isFinite(r)) return null;
  const n = Math.trunc(Number(r));
  return n >= 1 && n <= 4 ? n : null;
}

export function pickHighlightIds(
  runners: readonly PaceRunner[],
  max = 4,
): Set<string> {
  const ranked = runners
    .filter((r) => r.pickRank != null && r.pickRank >= 1 && r.pickRank <= max)
    .sort((a, b) => (a.pickRank ?? 99) - (b.pickRank ?? 99));
  if (ranked.length) return new Set(ranked.map((r) => r.horseId));
  // 無四揀時：完場前四名
  const finishers = runners
    .filter(
      (r) =>
        r.finishingPosition != null &&
        r.finishingPosition >= 1 &&
        r.finishingPosition <= max,
    )
    .sort(
      (a, b) => (a.finishingPosition ?? 99) - (b.finishingPosition ?? 99),
    );
  return new Set(finishers.map((r) => r.horseId));
}

export { STYLE_LABELS, parseFirstPosition };
