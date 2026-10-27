/**
 * Pro 研究室「頭對頭」純函式：條件切片、跑法分佈、交手結果、樣本警示。
 * 無 I/O；路由層負責查 DB、auth、cache。
 */

import {
  classifyStyleFromNorm,
  normalisePosition,
  parseFirstPosition,
  STYLE_LABELS,
  type RunningStyleCode,
} from './running-style';

export type H2hType = 'horse' | 'jockey' | 'trainer';

export const LOW_SAMPLE_THRESHOLD = 5;
export const LOW_SAMPLE_NOTE = '樣本較少，解讀需審慎';

export type ConditionSliceStats = {
  starts: number;
  wins: number;
  top3: number;
  avgPlace: number | null;
  sample: number;
  lowSample: boolean;
};

export type ConditionRow = {
  key: string;
  label: string;
  a: ConditionSliceStats;
  b: ConditionSliceStats;
};

export type EloPoint = { date: string; rating: number };

export type MeetingMarker = {
  date: string;
  raceId: string;
  venue: string | null;
  raceNumber: number | null;
};

export type DirectMeeting = {
  date: string;
  raceId: string;
  venue: string | null;
  raceNumber: number | null;
  distance: number | null;
  going: string | null;
  a: { position: number | null; draw: number | null };
  b: { position: number | null; draw: number | null };
  /** 邊邊名次較前（有效完成）；平手／缺資料為 null */
  ahead: 'a' | 'b' | 'tie' | null;
};

export type StyleBucket = {
  code: RunningStyleCode;
  label: string;
  count: number;
  share: number;
};

export type RunningStyleSummary = {
  sample: number;
  lowSample: boolean;
  buckets: StyleBucket[];
  earlyMedian: number | null;
  last400Avg: number | null;
};

export type ResultRow = {
  entityId: string;
  raceId: string;
  date: string;
  venue: string | null;
  raceNumber: number | null;
  distance: number | null;
  going: string | null;
  track: string | null;
  draw: number | null;
  position: number | null;
  runningPosition: string | null;
  totalRunners: number | null;
  last400: number | null;
};

export function isH2hType(v: string | null | undefined): v is H2hType {
  return v === 'horse' || v === 'jockey' || v === 'trainer';
}

/**
 * 對象 id 長度上限。匯入 `personId` 後綴最多 100，加 `horse_`／`jockey_`／`trainer_` 後仍短過呢個上限。
 * tianxi-web `h2hInput` 另外收緊到 64，呢度只擋過長字串。
 */
export const MAX_ENTITY_ID_LENGTH = 128;

/** 後綴：Unicode 字母（含中文 name_ch）、ASCII 數字、底線、連字號。`trainer_` 同 `jockey_`。 */
const ENTITY_ID_SUFFIX_RE = /^[\p{L}0-9_-]+$/u;

const ENTITY_PREFIX: Record<H2hType, string> = {
  horse: 'horse_',
  jockey: 'jockey_',
  trainer: 'trainer_',
};

export function validateEntityId(type: H2hType, id: string): boolean {
  if (id.length < 1 || id.length > MAX_ENTITY_ID_LENGTH) return false;
  const prefix = ENTITY_PREFIX[type];
  if (!id.startsWith(prefix)) return false;
  return ENTITY_ID_SUFFIX_RE.test(id.slice(prefix.length));
}

export function drawBand(draw: number | null | undefined): string | null {
  if (draw == null || !Number.isFinite(draw)) return null;
  if (draw <= 4) return '1-4';
  if (draw <= 8) return '5-8';
  if (draw <= 12) return '9-12';
  return '13+';
}

export function drawBandLabel(band: string): string {
  return `檔位 ${band}`;
}

function validFinish(pos: number | null | undefined): pos is number {
  return pos != null && Number.isFinite(pos) && pos > 0 && pos < 999;
}

export function emptyStats(): ConditionSliceStats {
  return { starts: 0, wins: 0, top3: 0, avgPlace: null, sample: 0, lowSample: true };
}

export function statsFromPositions(positions: number[]): ConditionSliceStats {
  const valid = positions.filter(validFinish);
  const starts = valid.length;
  if (!starts) return emptyStats();
  let wins = 0;
  let top3 = 0;
  let sum = 0;
  for (const p of valid) {
    if (p === 1) wins++;
    if (p <= 3) top3++;
    sum += p;
  }
  return {
    starts,
    wins,
    top3,
    avgPlace: Math.round((sum / starts) * 100) / 100,
    sample: starts,
    lowSample: starts < LOW_SAMPLE_THRESHOLD,
  };
}

/** 條件對照：同程／同地況／同馬場／同檔位區間。 */
export function buildConditionRows(
  rowsA: ResultRow[],
  rowsB: ResultRow[],
  filters: { distance?: number | null; going?: string | null; venue?: string | null } = {},
): ConditionRow[] {
  const applyFilters = (rows: ResultRow[]) =>
    rows.filter((r) => {
      if (filters.distance != null && r.distance !== filters.distance) return false;
      if (filters.going && r.going !== filters.going) return false;
      if (filters.venue && r.venue !== filters.venue) return false;
      return true;
    });

  const a = applyFilters(rowsA);
  const b = applyFilters(rowsB);

  const group = (
    key: string,
    label: string,
    keyFn: (r: ResultRow) => string | null,
    labelFn: (k: string) => string,
  ): ConditionRow[] => {
    const keys = new Set<string>();
    const mapA = new Map<string, number[]>();
    const mapB = new Map<string, number[]>();
    for (const r of a) {
      const k = keyFn(r);
      if (!k || !validFinish(r.position)) continue;
      keys.add(k);
      const arr = mapA.get(k) ?? [];
      arr.push(r.position);
      mapA.set(k, arr);
    }
    for (const r of b) {
      const k = keyFn(r);
      if (!k || !validFinish(r.position)) continue;
      keys.add(k);
      const arr = mapB.get(k) ?? [];
      arr.push(r.position);
      mapB.set(k, arr);
    }
    return [...keys]
      .sort((x, y) => {
        const sa = (mapA.get(x)?.length ?? 0) + (mapB.get(x)?.length ?? 0);
        const sb = (mapA.get(y)?.length ?? 0) + (mapB.get(y)?.length ?? 0);
        return sb - sa || x.localeCompare(y, 'zh-Hant');
      })
      .map((k) => ({
        key: `${key}:${k}`,
        label: labelFn(k),
        a: statsFromPositions(mapA.get(k) ?? []),
        b: statsFromPositions(mapB.get(k) ?? []),
      }))
      .filter((row) => row.a.starts > 0 || row.b.starts > 0)
      .slice(0, 12)
      .map((row) => ({ ...row, key: key === 'meta' ? row.key : row.key }));
  };

  // 頂層「篩選後整體」一行
  const overall: ConditionRow = {
    key: 'overall',
    label: '篩選後整體',
    a: statsFromPositions(a.map((r) => r.position!).filter(validFinish)),
    b: statsFromPositions(b.map((r) => r.position!).filter(validFinish)),
  };

  const byDistance = group(
    'distance',
    '途程',
    (r) => (r.distance != null ? String(r.distance) : null),
    (k) => `${k}m`,
  );
  const byGoing = group(
    'going',
    '地況',
    (r) => r.going,
    (k) => k,
  );
  const byVenue = group(
    'venue',
    '馬場',
    (r) => r.venue,
    (k) => (k === 'ST' ? '沙田' : k === 'HV' ? '跑馬地' : k),
  );
  const byDraw = group('draw', '檔位區間', (r) => drawBand(r.draw), drawBandLabel);

  return [overall, ...byDistance, ...byGoing, ...byVenue, ...byDraw];
}

export function buildRunningStyle(rows: ResultRow[]): RunningStyleSummary {
  const norms: number[] = [];
  const early: number[] = [];
  const last400: number[] = [];
  const counts: Record<RunningStyleCode, number> = {
    leader: 0,
    prominent: 0,
    midfield: 0,
    'held-up': 0,
  };

  // 最近優先；最多取 20 場有走位樣本
  const ordered = [...rows].sort((x, y) => String(y.date).localeCompare(String(x.date)));
  for (const r of ordered) {
    if (norms.length >= 20) break;
    const first = parseFirstPosition(r.runningPosition);
    const n = normalisePosition(first, r.totalRunners);
    if (n == null) continue;
    norms.push(n);
    early.push(n);
    const code = classifyStyleFromNorm(n);
    counts[code]++;
    if (r.last400 != null && Number.isFinite(r.last400) && r.last400 > 0) {
      last400.push(r.last400);
    }
  }

  const sample = norms.length;
  const buckets: StyleBucket[] = (Object.keys(counts) as RunningStyleCode[]).map((code) => ({
    code,
    label: STYLE_LABELS[code],
    count: counts[code],
    share: sample > 0 ? Math.round((counts[code] / sample) * 1000) / 10 : 0,
  }));

  const median = (vals: number[]): number | null => {
    if (!vals.length) return null;
    const s = [...vals].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  return {
    sample,
    lowSample: sample < LOW_SAMPLE_THRESHOLD,
    buckets,
    earlyMedian: median(early) == null ? null : Math.round(median(early)! * 1000) / 1000,
    last400Avg:
      last400.length === 0
        ? null
        : Math.round((last400.reduce((s, v) => s + v, 0) / last400.length) * 100) / 100,
  };
}

function groupByRace(rows: ResultRow[]): Map<string, ResultRow[]> {
  const map = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const list = map.get(r.raceId);
    if (list) list.push(r);
    else map.set(r.raceId, [r]);
  }
  return map;
}

/**
 * 同場多駒（練馬師／騎師）取最低有效名次。
 * 平名次時取較細檔位，結果唔受查詢次序影響。
 */
function bestFinishRow(rows: ResultRow[]): ResultRow | null {
  let best: ResultRow | null = null;
  let bestPos = Number.POSITIVE_INFINITY;
  let bestDraw = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (!validFinish(r.position)) continue;
    const draw = r.draw ?? Number.POSITIVE_INFINITY;
    if (r.position < bestPos || (r.position === bestPos && draw < bestDraw)) {
      best = r;
      bestPos = r.position;
      bestDraw = draw;
    }
  }
  return best;
}

/**
 * 直接交手：每場一次。
 * 練馬師／騎師同場可有多駒。以前 `mapB.set(raceId)` 只留最後一列，
 * 再逐列掃 A，會配到較差名次或 999（PU／WV），`ahead` 變成 null，
 * 同一場亦會出多行。而家兩邊都用最佳有效名次；只有一邊有效時
 * 另一邊名次為 null、ahead 為 null。
 */
export function buildDirectMeetings(rowsA: ResultRow[], rowsB: ResultRow[]): DirectMeeting[] {
  const mapA = groupByRace(rowsA);
  const mapB = groupByRace(rowsB);
  const out: DirectMeeting[] = [];
  for (const [raceId, listA] of mapA) {
    const listB = mapB.get(raceId);
    if (!listB) continue;
    const bestA = bestFinishRow(listA);
    const bestB = bestFinishRow(listB);
    const rowA = bestA ?? listA[0];
    const rowB = bestB ?? listB[0];
    const posA = bestA ? bestA.position : null;
    const posB = bestB ? bestB.position : null;
    let ahead: DirectMeeting['ahead'] = null;
    if (posA != null && posB != null) {
      if (posA < posB) ahead = 'a';
      else if (posB < posA) ahead = 'b';
      else ahead = 'tie';
    }
    out.push({
      date: rowA.date,
      raceId,
      venue: rowA.venue,
      raceNumber: rowA.raceNumber,
      distance: rowA.distance,
      going: rowA.going,
      a: { position: posA, draw: rowA.draw },
      b: { position: posB, draw: rowB.draw },
      ahead,
    });
  }
  return out.sort((x, y) => String(y.date).localeCompare(String(x.date)));
}

/** 同場日出賽標註（兩邊 Elo 序列交集日期，或直接交手日）。 */
export function meetingMarkersFrom(
  meetings: DirectMeeting[],
  eloA: EloPoint[],
  eloB: EloPoint[],
): MeetingMarker[] {
  const dates = new Set<string>();
  for (const m of meetings) dates.add(m.date);
  const setA = new Set(eloA.map((p) => p.date));
  for (const p of eloB) {
    if (setA.has(p.date)) dates.add(p.date);
  }
  const byDate = new Map<string, MeetingMarker>();
  for (const m of meetings) {
    byDate.set(m.date, {
      date: m.date,
      raceId: m.raceId,
      venue: m.venue,
      raceNumber: m.raceNumber,
    });
  }
  for (const d of dates) {
    if (!byDate.has(d)) byDate.set(d, { date: d, raceId: '', venue: null, raceNumber: null });
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

export function collectWarnings(parts: { lowSample: boolean }[]): string[] {
  if (parts.some((p) => p.lowSample)) return [LOW_SAMPLE_NOTE];
  return [];
}

export function parseDistanceFilter(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function canonicalH2hCacheKey(opts: {
  type: H2hType;
  a: string;
  b: string;
  distance: number | null;
  going: string | null;
  venue: string | null;
}): string {
  // 對調 a/b 共用同一 cache（回應會標明請求順序）
  const [x, y] = [opts.a, opts.b].sort();
  return [
    'lab-h2h',
    opts.type,
    x,
    y,
    opts.distance ?? '',
    opts.going ?? '',
    opts.venue ?? '',
  ].join('|');
}
