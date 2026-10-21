import { assertOriginalFreezeReadable, digest, FreezeBlockedError } from './freeze-recovery';
/**
 * 凍結對帳表 (freeze ledger) — MEASURE ONLY.
 *
 * Approved scope:
 *   • reads ONLY locked `prediction_log` rows (variant=baseline). No backtest,
 *     no live recompute, no α/τ refit, no feature work.
 *   • primary ruler = Top-4 selection (per-race intersect / coverage / mean),
 *     Top-3 as a side note.
 *   • secondary = place hits (top-4 landing in the place slots).
 *   • market columns (win favourite hit, WIN/PLA take-out implied log-loss,
 *     flat-stake simulated EV) are SIDE NOTES ONLY — they exist to show how hard
 *     the market is, never to steer the tree or the version fingerprint.
 *   • no conclusion ("edge / no edge") is drawn here; the caller renders the
 *     table and the sample size next to it.
 */
import { dateHasSettledResults } from './prediction-lock-db';
import { getMeetingLockState, POST_LOCK_EXCLUDED } from './lock-window';

export type LedgerRace = {
  raceNumber: number;
  runners: number;
  predictedTop4: number[];
  actualTop4: number[];
  top4Intersect: number | null;
  top3Intersect: number | null;
  top3AnyHit: boolean | null;
  placeSlots: number;
  placeHits: number | null;
  winnerHit: boolean | null;
  modelWinLogloss: number | null;
  marketWinLogloss: number | null;
  marketOverround: number | null;
  favouriteHit: boolean | null;
  flatWinPnl: number | null; // $10 flat on model rank 1, final WIN odds
  plaCoverage: number | null; // fraction of runners with a PLA implied price
};

export type LedgerMeeting = {
  date: string;
  venue: string | null;
  locked: boolean;
  /**
   * blocked    = frozen evidence blocked / failed verification for this meeting only (see blockedReason).
   * read-error = transient read failure for this meeting only; never cached.
   * Neither contributes to any metric; the rest of the ledger is still served.
   */
  source: 'prediction_log' | 'not-locked' | 'missing-log' | 'no-results' | 'blocked' | 'read-error';
  blockedReason?: string | null;
  racesEvaluated: number;
  top4AvgIntersect: number | null;
  top4CoveragePct: number | null;
  top4FullHits: number;
  top3AvgIntersect: number | null;
  top3AnyHitPct: number | null;
  placeHitPct: number | null;
  winnerHitPct: number | null;
  modelWinLogloss: number | null;
  marketWinLogloss: number | null;
  favouriteHitPct: number | null;
  flatWinRoiPct: number | null;
  races: LedgerRace[];
  /** 鎖後先寫入嘅場次：只作對帳參考，「鎖後、唔計分」，唔入任何凍結指標。 */
  postLockRaces: number[];
  postLockNote: string | null;
};

/** 鎖點 tick 每 5 分鐘一次，所以鎖點後 10 分鐘內寫入嘅首份快照仍算鎖點快照。 */
const LOCK_TICK_GRACE_MS = 10 * 60_000;

const ln = (x: number) => Math.log(Math.max(x, 1e-12));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

async function loadPlaImplied(
  db: D1Database,
  date: string,
  venue: string | null,
): Promise<Set<string>> {
  // Which race/horse pairs ever had a positive PLA price. odds_snapshots keeps
  // the newest day, odds_archive keeps sampled history — read both. Only key
  // presence feeds plaCoverage, so DISTINCT (no ORDER BY / per-snapshot rows)
  // is equivalent and much lighter. The venue filter lets SQLite use the
  // (race_date, venue, race_number, pool_type, ...) index prefix.
  const out = new Set<string>();
  const hk = venue === 'ST' || venue === 'HV' ? venue : null;
  const sql = (table: string) =>
    `SELECT DISTINCT race_number, combination FROM ${table}
      WHERE race_date = ?${hk ? ' AND venue = ?' : ''} AND pool_type = 'PLA' AND odds IS NOT NULL AND odds > 0`;
  const reads = ['odds_archive', 'odds_snapshots'].map(async (table) => {
    try {
      const stmt = db.prepare(sql(table));
      const res = await (hk ? stmt.bind(date, hk) : stmt.bind(date)).all<any>();
      for (const r of res?.results ?? []) out.add(`${r.race_number}:${String(r.combination).trim()}`);
    } catch { /* table may not exist on this env */ }
  });
  await Promise.all(reads);
  return out;
}

export async function computeFreezeLedgerForDate(
  db: D1Database,
  date: string,
  engine: string = 'v12',
): Promise<LedgerMeeting> {
  const meeting = await db
    .prepare(
      `SELECT m.date AS date, m.venue AS venue FROM race_meetings m
        WHERE m.date = ? AND m.venue IN ('ST','HV')
        ORDER BY (SELECT COUNT(*) FROM races r WHERE r.meeting_id = m.id) DESC, m.id LIMIT 1`,
    )
    .bind(date)
    .first<{ date: string; venue: string }>()
    .catch(() => null);
  const venue = meeting?.venue ?? null;
  const base: LedgerMeeting = {
    date,
    venue,
    locked: false,
    source: 'no-results',
    racesEvaluated: 0,
    top4AvgIntersect: null,
    top4CoveragePct: null,
    top4FullHits: 0,
    top3AvgIntersect: null,
    top3AnyHitPct: null,
    placeHitPct: null,
    winnerHitPct: null,
    modelWinLogloss: null,
    marketWinLogloss: null,
    favouriteHitPct: null,
    flatWinRoiPct: null,
    races: [],
    postLockRaces: [],
    postLockNote: null,
  };

  // Same rule as dateIsLocked(): settled results lock the date, otherwise the
  // T−1.5h lock state decides. One lock-state read now serves both the locked
  // check and the post-lock integrity window below (was read twice).
  const [settled, lock, completionOk] = await Promise.all([
    dateHasSettledResults(db, date, venue),
    getMeetingLockState(db, date, venue),
    (async () => {
      try {
        return !!(await db.prepare(`SELECT 1 AS x FROM lock_completion_log WHERE date = ? AND engine = ?`).bind(date, engine).first());
      } catch { return false; }
    })(),
  ]);
  const locked = settled || lock.locked;
  base.locked = locked;
  if (!locked) {
    base.source = 'not-locked';
    return base; // 未鎖一律唔入表：呢張表只讀已鎖凍結
  }

  const [verifyError, frozen, results] = await Promise.all([
    assertOriginalFreezeReadable(db, date, engine).then(() => null, (e: unknown) => e),
    db
      .prepare(
        `SELECT race_number, horse_number, predicted_rank, p_win, generated_at
           FROM prediction_log
          WHERE date = ? AND engine = ? AND variant = 'baseline' AND predicted_rank IS NOT NULL
          ORDER BY race_number ASC, predicted_rank ASC`,
      )
      .bind(date, engine)
      .all<any>()
      .catch(() => ({ results: [] as any[] })),
    db
      .prepare(
        `SELECT r.race_number AS race_number, rr.horse_number AS horse_number,
                rr.finishing_position AS pos, rr.win_odds AS win_odds
           FROM race_results rr
           JOIN races r ON r.id = rr.race_id
           JOIN race_meetings rm ON rm.id = r.meeting_id
          WHERE rm.date = ? AND rm.venue IN ('ST','HV')
          ORDER BY r.race_number, rr.finishing_position`,
      )
      .bind(date)
      .all<any>()
      .catch(() => ({ results: [] as any[] })),
  ]);
  if (verifyError) {
    // 單日凍結證據被阻截：只標呢一日，唔拖低成張表。
    if (verifyError instanceof FreezeBlockedError) {
      base.source = 'blocked';
      base.blockedReason = verifyError.message;
      return base;
    }
    throw verifyError; // transient read error → caller marks this meeting read-error
  }
  const frozenByRace = new Map<number, any[]>();
  for (const r of frozen?.results ?? []) {
    if (!frozenByRace.has(r.race_number)) frozenByRace.set(r.race_number, []);
    frozenByRace.get(r.race_number)!.push(r);
  }
  // 鎖點完整性：只計鎖點快照（lockAt+10 分鐘內）或者 T−90 補寫一次
  // （lock_completion_log 有紀錄、且喺首場開跑前）。其餘一律「鎖後、唔計分」。
  const lockMs = lock.lockAt ? Date.parse(lock.lockAt) : NaN;
  const firstMs = lock.firstPostAt ? Date.parse(lock.firstPostAt) : NaN;
  if (Number.isFinite(lockMs)) {
    const limit = completionOk && Number.isFinite(firstMs) ? firstMs : lockMs + LOCK_TICK_GRACE_MS;
    for (const [rn, rows] of [...frozenByRace.entries()]) {
      const ts = rows.map((r) => Date.parse(String(r.generated_at ?? ''))).filter(Number.isFinite);
      const earliest = ts.length ? Math.min(...ts) : NaN;
      if (Number.isFinite(earliest) && earliest > limit) {
        frozenByRace.delete(rn);
        base.postLockRaces.push(rn);
      }
    }
    for (const rn of POST_LOCK_EXCLUDED[date] ?? []) {
      if (frozenByRace.delete(rn) && !base.postLockRaces.includes(rn)) base.postLockRaces.push(rn);
    }
    base.postLockRaces.sort((a, b) => a - b);
    if (base.postLockRaces.length) base.postLockNote = '鎖後、唔計分';
  }
  if (!frozenByRace.size) {
    base.source = 'missing-log';
    return base;
  }

  const resByRace = new Map<number, any[]>();
  for (const r of results?.results ?? []) {
    if (!resByRace.has(r.race_number)) resByRace.set(r.race_number, []);
    resByRace.get(r.race_number)!.push(r);
  }
  if (!resByRace.size) {
    base.source = 'missing-log';
    base.races = [...frozenByRace.keys()].sort((a, b) => a - b).map((rn) => ({
      raceNumber: rn,
      runners: 0,
      predictedTop4: (frozenByRace.get(rn) ?? []).slice(0, 4).map((p) => Number(p.horse_number)),
      actualTop4: [],
      top4Intersect: null,
      top3Intersect: null,
      top3AnyHit: null,
      placeSlots: 0,
      placeHits: null,
      winnerHit: null,
      modelWinLogloss: null,
      marketWinLogloss: null,
      marketOverround: null,
      favouriteHit: null,
      flatWinPnl: null,
      plaCoverage: null,
    }));
    base.source = 'prediction_log';
    return base; // 已鎖但未完場：出殼、指標留空
  }

  const plaImplied = await loadPlaImplied(db, date, venue);
  const races: LedgerRace[] = [];
  for (const rn of [...frozenByRace.keys()].sort((a, b) => a - b)) {
    const picks = frozenByRace.get(rn) ?? [];
    const actual = (resByRace.get(rn) ?? []).filter((r) => Number(r.pos) > 0);
    const predictedTop4 = picks.slice(0, 4).map((p) => Number(p.horse_number));
    const predictedTop3 = predictedTop4.slice(0, 3);
    const finished = actual.slice().sort((a, b) => Number(a.pos) - Number(b.pos));
    const actualTop4 = finished.slice(0, 4).map((r) => Number(r.horse_number));
    const actualTop3 = actualTop4.slice(0, 3);
    const runners = actual.length;
    const placeSlots = runners >= 7 ? 3 : 2;
    const placedSet = new Set(finished.slice(0, placeSlots).map((r) => Number(r.horse_number)));

    if (!runners || predictedTop4.length < 4) {
      races.push({
        raceNumber: rn, runners, predictedTop4, actualTop4,
        top4Intersect: null, top3Intersect: null, top3AnyHit: null,
        placeSlots, placeHits: null, winnerHit: null,
        modelWinLogloss: null, marketWinLogloss: null, marketOverround: null,
        favouriteHit: null, flatWinPnl: null, plaCoverage: null,
      });
      continue;
    }

    const top4Intersect = predictedTop4.filter((h) => actualTop4.includes(h)).length;
    const top3Intersect = predictedTop3.filter((h) => actualTop3.includes(h)).length;
    const placeHits = predictedTop4.filter((h) => placedSet.has(h)).length;
    const winnerNo = Number(finished[0]?.horse_number);
    const winnerHit = predictedTop4[0] === winnerNo;

    // Model WIN log-loss on the frozen p_win, renormalised over the runners
    // that actually started (scratchings must not shift the frozen ranking).
    const pwByHorse = new Map<number, number>();
    for (const p of picks) {
      const v = Number(p.p_win);
      if (Number.isFinite(v) && v > 0) pwByHorse.set(Number(p.horse_number), v);
    }
    let modelWinLogloss: number | null = null;
    const pwSum = actual.reduce((s, r) => s + (pwByHorse.get(Number(r.horse_number)) ?? 0), 0);
    if (pwSum > 0 && pwByHorse.has(winnerNo)) {
      modelWinLogloss = -ln((pwByHorse.get(winnerNo) as number) / pwSum);
    }

    // Market side note: final WIN odds carry the take-out. Report both the raw
    // overround and the renormalised (take-out removed) log-loss.
    let marketWinLogloss: number | null = null;
    let marketOverround: number | null = null;
    let favouriteHit: boolean | null = null;
    let flatWinPnl: number | null = null;
    const oddsByHorse = new Map<number, number>();
    for (const r of actual) {
      const o = Number(r.win_odds);
      if (Number.isFinite(o) && o > 1) oddsByHorse.set(Number(r.horse_number), o);
    }
    if (oddsByHorse.size >= 2) {
      let sum = 0;
      for (const o of oddsByHorse.values()) sum += 1 / o;
      marketOverround = sum;
      const qWinner = oddsByHorse.has(winnerNo) ? (1 / (oddsByHorse.get(winnerNo) as number)) / sum : null;
      if (qWinner != null) marketWinLogloss = -ln(qWinner);
      let favNo: number | null = null;
      let best = Infinity;
      for (const [h, o] of oddsByHorse) if (o < best) { best = o; favNo = h; }
      favouriteHit = favNo != null ? favNo === winnerNo : null;
      const myOdds = oddsByHorse.get(predictedTop4[0]);
      if (myOdds != null) flatWinPnl = winnerHit ? (myOdds - 1) * 10 : -10;
    }
    const plaKnown = actual.filter((r) => plaImplied.has(`${rn}:${String(r.horse_number)}`)).length;

    races.push({
      raceNumber: rn, runners, predictedTop4, actualTop4,
      top4Intersect, top3Intersect, top3AnyHit: top3Intersect > 0,
      placeSlots, placeHits, winnerHit,
      modelWinLogloss: r3(modelWinLogloss), marketWinLogloss: r3(marketWinLogloss),
      marketOverround: r3(marketOverround), favouriteHit,
      flatWinPnl: r3(flatWinPnl),
      plaCoverage: runners ? r3(plaKnown / runners) : null,
    });
  }

  const scored = races.filter((r) => r.top4Intersect != null);
  const bets = races.filter((r) => r.flatWinPnl != null);
  base.source = 'prediction_log';
  base.races = races;
  base.racesEvaluated = scored.length;
  base.top4AvgIntersect = r3(avg(scored.map((r) => r.top4Intersect as number)));
  base.top4CoveragePct = r1(scored.length ? (avg(scored.map((r) => (r.top4Intersect as number) / 4)) as number) * 100 : null);
  base.top4FullHits = scored.filter((r) => r.top4Intersect === 4).length;
  base.top3AvgIntersect = r3(avg(scored.map((r) => r.top3Intersect as number)));
  base.top3AnyHitPct = r1(scored.length ? (scored.filter((r) => r.top3AnyHit).length / scored.length) * 100 : null);
  base.placeHitPct = r1(scored.length ? (avg(scored.map((r) => (r.placeHits as number) / 4)) as number) * 100 : null);
  base.winnerHitPct = r1(scored.length ? (scored.filter((r) => r.winnerHit).length / scored.length) * 100 : null);
  base.modelWinLogloss = r3(avg(races.filter((r) => r.modelWinLogloss != null).map((r) => r.modelWinLogloss as number)));
  base.marketWinLogloss = r3(avg(races.filter((r) => r.marketWinLogloss != null).map((r) => r.marketWinLogloss as number)));
  base.favouriteHitPct = r1(
    races.filter((r) => r.favouriteHit != null).length
      ? (races.filter((r) => r.favouriteHit).length / races.filter((r) => r.favouriteHit != null).length) * 100
      : null,
  );
  base.flatWinRoiPct = r1(bets.length ? (bets.reduce((s, r) => s + (r.flatWinPnl as number), 0) / (bets.length * 10)) * 100 : null);
  return base;
}

// ── Per-meeting snapshot (freeze_ledger_meeting) ───────────────────────────
// A meeting's ledger row is a pure function of its frozen prediction_log rows
// (immutable after lock) and its official results. Once the meeting is locked,
// verified and fully settled, the computed row is written once and re-served,
// so a ledger request is 1 query instead of ~10 per meeting.
// Table is created by backend/src/db/migrations/20261022_freeze_ledger_meeting.sql.
// Until that migration is applied every read/write here fails softly and the
// ledger is computed live exactly as before.
/** Bump when grading logic / LedgerMeeting shape changes so old rows are recomputed. */
export const LEDGER_SNAPSHOT_VERSION = 1;
/** Only meetings at least this many HKT days old are snapshotted (results imports + backfills settle first). */
const SNAPSHOT_MIN_AGE_DAYS = 2;
const LIVE_CONCURRENCY = 6;

const hkDate = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Locked, verified, every frozen race has official results, and old enough that results are final. */
export function ledgerSnapshotEligible(m: LedgerMeeting, nowMs: number = Date.now()): boolean {
  if (!m.locked || m.source !== 'prediction_log' || m.racesEvaluated <= 0 || !m.races.length) return false;
  if (m.races.some((r) => !(r.runners > 0))) return false;
  return m.date <= addDays(hkDate(nowMs), -SNAPSHOT_MIN_AGE_DAYS);
}

function snapshotStillValid(m: LedgerMeeting): boolean {
  // Code-level exclusions (POST_LOCK_EXCLUDED) added after the snapshot invalidate it.
  return (POST_LOCK_EXCLUDED[m.date] ?? []).every((rn) => m.postLockRaces.includes(rn));
}

async function readLedgerSnapshots(db: D1Database, engine: string, dates: string[]): Promise<Map<string, LedgerMeeting>> {
  const out = new Map<string, LedgerMeeting>();
  if (!dates.length) return out;
  const sorted = [...dates].sort();
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const wanted = new Set(dates);
  // Skip any meeting whose recovery status is now blocked (ok=0): it is recomputed live and shown as blocked.
  const joined = `SELECT f.date AS date, f.payload_json AS payload_json, f.sha256 AS sha256
                    FROM freeze_ledger_meeting f
                    LEFT JOIN prediction_recovery_status s ON s.date = f.date AND s.engine = f.engine
                   WHERE f.engine = ? AND f.date >= ? AND f.date <= ? AND (s.ok IS NULL OR s.ok = 1)`;
  const plain = `SELECT date, payload_json, sha256 FROM freeze_ledger_meeting WHERE engine = ? AND date >= ? AND date <= ?`;
  let rows: { date: string; payload_json: string; sha256: string }[] = [];
  try {
    rows = (await db.prepare(joined).bind(engine, lo, hi).all<any>()).results ?? [];
  } catch {
    try { rows = (await db.prepare(plain).bind(engine, lo, hi).all<any>()).results ?? []; } catch { return out; } // table not migrated yet
  }
  for (const r of rows) {
    if (!wanted.has(r.date)) continue;
    try {
      if ((await digest(r.payload_json)) !== r.sha256) continue;
      const parsed = JSON.parse(r.payload_json) as { v?: number; meeting?: LedgerMeeting };
      const m = parsed?.meeting;
      if (parsed?.v !== LEDGER_SNAPSHOT_VERSION || !m || m.date !== r.date || !snapshotStillValid(m)) continue;
      out.set(r.date, m);
    } catch { /* corrupt row → recompute live */ }
  }
  return out;
}

async function writeLedgerSnapshots(db: D1Database, engine: string, meetings: LedgerMeeting[], nowMs: number): Promise<number> {
  if (!meetings.length) return 0;
  try {
    const computedAt = new Date(nowMs).toISOString();
    const stmts = await Promise.all(meetings.map(async (m) => {
      const payload = JSON.stringify({ v: LEDGER_SNAPSHOT_VERSION, meeting: m });
      return db
        .prepare(`INSERT OR REPLACE INTO freeze_ledger_meeting (date, engine, payload_json, sha256, computed_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(m.date, engine, payload, await digest(payload), computedAt);
    }));
    await db.batch(stmts);
    return stmts.length;
  } catch {
    return 0; // table not migrated yet — live compute still served
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function readErrorMeeting(date: string, e: unknown): LedgerMeeting {
  return {
    date, venue: null, locked: false, source: 'read-error',
    blockedReason: e instanceof Error ? e.message : String(e),
    racesEvaluated: 0, top4AvgIntersect: null, top4CoveragePct: null, top4FullHits: 0,
    top3AvgIntersect: null, top3AnyHitPct: null, placeHitPct: null, winnerHitPct: null,
    modelWinLogloss: null, marketWinLogloss: null, favouriteHitPct: null, flatWinRoiPct: null,
    races: [], postLockRaces: [], postLockNote: null,
  };
}

export type FreezeLedgerSnapshotInfo = { hits: number; computed: number; written: number; readErrors: number; blocked: number };

export async function computeFreezeLedger(
  db: D1Database,
  opts?: { dates?: string[]; since?: string; engine?: string; limit?: number; useSnapshots?: boolean; now?: number },
): Promise<{
  engine: string;
  generatedAt: string;
  policy: string;
  meetings: LedgerMeeting[];
  snapshot: FreezeLedgerSnapshotInfo;
  season: {
    meetings: number;
    racesEvaluated: number;
    top4AvgIntersect: number | null;
    top4CoveragePct: number | null;
    top4FullHits: number;
    top3AvgIntersect: number | null;
    top3AnyHitPct: number | null;
    placeHitPct: number | null;
    winnerHitPct: number | null;
    modelWinLogloss: number | null;
    marketWinLogloss: number | null;
    favouriteHitPct: number | null;
    flatWinRoiPct: number | null;
  };
}> {
  const engine = opts?.engine ?? 'v12';
  const nowMs = opts?.now ?? Date.now();
  const useSnapshots = opts?.useSnapshots !== false;
  let dates = opts?.dates?.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) ?? [];
  if (!dates.length) {
    const since = opts?.since ?? '2026-09-01';
    const res = await db
      .prepare(
        `SELECT DISTINCT date FROM prediction_log
          WHERE date >= ? AND engine = ? AND variant = 'baseline'
          ORDER BY date ASC LIMIT ?`,
      )
      .bind(since, engine, Math.max(1, Math.min(opts?.limit ?? 40, 200)))
      .all<{ date: string }>()
      .catch(() => ({ results: [] as { date: string }[] }));
    dates = (res?.results ?? []).map((r) => r.date);
  }

  const cached = useSnapshots ? await readLedgerSnapshots(db, engine, dates) : new Map<string, LedgerMeeting>();
  const missing = dates.filter((d) => !cached.has(d));
  // Meetings are independent: compute them concurrently (bounded) instead of one by one.
  const live = await mapLimit(missing, LIVE_CONCURRENCY, (d) =>
    computeFreezeLedgerForDate(db, d, engine).catch((e) => readErrorMeeting(d, e)),
  );
  const liveByDate = new Map(live.map((m) => [m.date, m]));
  const written = useSnapshots
    ? await writeLedgerSnapshots(db, engine, live.filter((m) => ledgerSnapshotEligible(m, nowMs)), nowMs)
    : 0;
  const meetings: LedgerMeeting[] = dates.map((d) => cached.get(d) ?? liveByDate.get(d)!);

  const graded = meetings.filter((m) => m.racesEvaluated > 0);
  const allRaces = graded.flatMap((m) => m.races).filter((r) => r.top4Intersect != null);
  const bets = graded.flatMap((m) => m.races).filter((r) => r.flatWinPnl != null);
  return {
    engine,
    generatedAt: new Date(nowMs).toISOString(),
    policy:
      '只讀已鎖 prediction_log（T−1.5h 或賽果入庫後）；禁回測、禁 live 重算。主尺＝四揀（入圍／覆蓋／平均相交），Top3 旁註；副尺＝位置命中；獨贏同市場隱含 logloss／模擬 EV 只旁註，永不回寫模型或指紋。',
    meetings,
    snapshot: {
      hits: cached.size,
      computed: live.length,
      written,
      readErrors: meetings.filter((m) => m.source === 'read-error').length,
      blocked: meetings.filter((m) => m.source === 'blocked').length,
    },
    season: {
      meetings: graded.length,
      racesEvaluated: allRaces.length,
      top4AvgIntersect: r3(avg(allRaces.map((r) => r.top4Intersect as number))),
      top4CoveragePct: r1(allRaces.length ? (avg(allRaces.map((r) => (r.top4Intersect as number) / 4)) as number) * 100 : null),
      top4FullHits: allRaces.filter((r) => r.top4Intersect === 4).length,
      top3AvgIntersect: r3(avg(allRaces.map((r) => r.top3Intersect as number))),
      top3AnyHitPct: r1(allRaces.length ? (allRaces.filter((r) => r.top3AnyHit).length / allRaces.length) * 100 : null),
      placeHitPct: r1(allRaces.length ? (avg(allRaces.map((r) => (r.placeHits as number) / 4)) as number) * 100 : null),
      winnerHitPct: r1(allRaces.length ? (allRaces.filter((r) => r.winnerHit).length / allRaces.length) * 100 : null),
      modelWinLogloss: r3(avg(allRaces.filter((r) => r.modelWinLogloss != null).map((r) => r.modelWinLogloss as number))),
      marketWinLogloss: r3(avg(allRaces.filter((r) => r.marketWinLogloss != null).map((r) => r.marketWinLogloss as number))),
      favouriteHitPct: r1(
        allRaces.filter((r) => r.favouriteHit != null).length
          ? (allRaces.filter((r) => r.favouriteHit).length / allRaces.filter((r) => r.favouriteHit != null).length) * 100
          : null,
      ),
      flatWinRoiPct: r1(bets.length ? (bets.reduce((s, r) => s + (r.flatWinPnl as number), 0) / (bets.length * 10)) * 100 : null),
    },
  };
}

/** 某日鎖後先寫入嘅場次（「鎖後、唔計分」）；同凍結對帳表同一規則。 */
export async function postLockRaceNumbers(db: D1Database, date: string, venue: string | null, engine: string = 'v12'): Promise<number[]> {
  const lock = await getMeetingLockState(db, date, venue);
  const lockMs = lock.lockAt ? Date.parse(lock.lockAt) : NaN;
  const firstMs = lock.firstPostAt ? Date.parse(lock.firstPostAt) : NaN;
  if (!Number.isFinite(lockMs)) return [];
  let completionOk = false;
  try {
    completionOk = !!(await db.prepare(`SELECT 1 AS x FROM lock_completion_log WHERE date = ? AND engine = ?`).bind(date, engine).first());
  } catch { completionOk = false; }
  const limit = completionOk && Number.isFinite(firstMs) ? firstMs : lockMs + LOCK_TICK_GRACE_MS;
  try {
    const res = await db.prepare(
      `SELECT race_number AS rn, MIN(generated_at) AS g FROM prediction_log
        WHERE date = ? AND engine = ? AND variant = 'baseline' GROUP BY race_number`,
    ).bind(date, engine).all<{ rn: number; g: string }>();
    const out = new Set((res?.results ?? []).filter((r) => { const t = Date.parse(String(r.g ?? '')); return Number.isFinite(t) && t > limit; }).map((r) => Number(r.rn)));
    for (const rn of POST_LOCK_EXCLUDED[date] ?? []) out.add(rn);
    return [...out].sort((a, b) => a - b);
  } catch { return []; }
}
