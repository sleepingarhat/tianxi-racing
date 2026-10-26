/**
 * Pro P1 通知事件（計劃 f6）：Worker 只寫穩定 event_key，唔知用戶。
 * 類型：lock_complete / top4_lock（只 final）/ daily_pnl（凍結日起 2026-10-04）。
 * high_conf 未納入今次 PR。
 */

export const NOTIFY_EVENT_TYPES = ['lock_complete', 'top4_lock', 'daily_pnl'] as const;
export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

/** 公開通知正式戰績起點（跟產品裁決；唔用舊文件 2026-06-03／06-01）。 */
export const DAILY_PNL_FREEZE_START = '2026-10-04';

export const NOTIFY_DISCLAIMER = '數據模型預測 僅供參考 · 理性投注';

const COST_FF = 10, COST_TRIO = 40, COST_TIERCE = 240, COST_QUARTET = 240;
export const PER_RACE_STRATEGY_COST = COST_FF + COST_TRIO + COST_TIERCE + COST_QUARTET; // 530

export function lockCompleteKey(date: string, venue: string, engine = 'v12'): string {
  return `lock_complete:${date}:${venue}:${engine}`;
}

export function top4LockKey(date: string, venue: string, raceNumber: number, horseId: string): string {
  return `top4_lock:${date}:${venue}:${raceNumber}:${horseId}`;
}

export function dailyPnlKey(date: string, venue: string, engine = 'v12'): string {
  return `daily_pnl:${date}:${venue}:${engine}`;
}

/** draft／未核實 final 永遠唔寫 top4_lock 同 lock_complete（只接受 edition=final）。 */
export function shouldEmitFinalLockEvents(edition: 'draft' | 'final' | 'unavailable' | string): boolean {
  return edition === 'final';
}

export async function ensureNotifyEventsTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS notify_events (
      event_key TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('lock_complete', 'top4_lock', 'daily_pnl')),
      meeting_date TEXT,
      venue TEXT,
      race_number INTEGER,
      horse_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_notify_events_created ON notify_events (created_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_notify_events_type_created ON notify_events (type, created_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_notify_events_horse ON notify_events (horse_id, created_at)`).run();
}

async function insertEvent(
  db: D1Database,
  row: {
    event_key: string;
    type: NotifyEventType;
    meeting_date?: string | null;
    venue?: string | null;
    race_number?: number | null;
    horse_id?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const created = new Date().toISOString();
  const r = await db.prepare(
    `INSERT OR IGNORE INTO notify_events (event_key, type, meeting_date, venue, race_number, horse_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.event_key,
    row.type,
    row.meeting_date ?? null,
    row.venue ?? null,
    row.race_number ?? null,
    row.horse_id ?? null,
    JSON.stringify(row.payload),
    created,
  ).run();
  return ((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

/**
 * 鎖定完成（final 版）：寫 lock_complete + 每場頭四匹 top4_lock。
 * edition !== 'final' 時一律 no-op（draft 永遠唔通知）。
 */
export async function emitFinalLockEvents(
  db: D1Database,
  opts: { date: string; venue: string; engine?: string; edition: string },
): Promise<{ lockComplete: boolean; top4: number }> {
  if (!shouldEmitFinalLockEvents(opts.edition)) return { lockComplete: false, top4: 0 };
  const engine = opts.engine ?? 'v12';
  const { date, venue } = opts;
  await ensureNotifyEventsTable(db);

  const lockWritten = await insertEvent(db, {
    event_key: lockCompleteKey(date, venue, engine),
    type: 'lock_complete',
    meeting_date: date,
    venue,
    payload: {
      date,
      venue,
      engine,
      title: '賽前預測已鎖定（最終版）',
      disclaimer: NOTIFY_DISCLAIMER,
    },
  });

  const rows = await db.prepare(`
    SELECT pl.race_number AS race_number, pl.horse_id AS horse_id, pl.horse_number AS horse_number,
           pl.predicted_rank AS predicted_rank, pl.p_win AS p_win, h.name_ch AS name_ch
    FROM prediction_log pl
    LEFT JOIN horses h ON h.id = pl.horse_id
    WHERE pl.date = ? AND pl.engine = ? AND pl.variant = 'baseline'
      AND pl.predicted_rank IS NOT NULL AND pl.predicted_rank <= 4
    ORDER BY pl.race_number, pl.predicted_rank
  `).bind(date, engine).all<{
    race_number: number;
    horse_id: string;
    horse_number: number | null;
    predicted_rank: number;
    p_win: number | null;
    name_ch: string | null;
  }>().catch(() => ({ results: [] as any[] }));

  let top4 = 0;
  for (const r of rows.results ?? []) {
    if (!r.horse_id || !r.race_number) continue;
    const written = await insertEvent(db, {
      event_key: top4LockKey(date, venue, Number(r.race_number), String(r.horse_id)),
      type: 'top4_lock',
      meeting_date: date,
      venue,
      race_number: Number(r.race_number),
      horse_id: String(r.horse_id),
      payload: {
        date,
        venue,
        engine,
        raceNumber: Number(r.race_number),
        horseId: String(r.horse_id),
        horseNumber: r.horse_number,
        predictedRank: r.predicted_rank,
        nameCh: r.name_ch,
        title: '愛駒入四揀（鎖定最終版）',
        disclaimer: NOTIFY_DISCLAIMER,
      },
    });
    if (written) top4++;
  }
  return { lockComplete: lockWritten, top4 };
}

/** 由 hit-rate cache 一場已結算日計官方策略當日盈虧（跟 computeStrategyPnl 規則）。 */
export function dayPnlFromHitRateCache(cached: any, date: string, venue: string): {
  racesBet: number; cost: number; payout: number; net: number;
} | null {
  if (!cached?.summary || cached.summary.boxDivsFetched !== true) return null;
  let dayCost = 0, dayPayout = 0, racesBet = 0;
  for (const race of (cached.races || [])) {
    const a3 = Array.isArray(race.actualTop3) ? race.actualTop3.length : 0;
    const a4 = Array.isArray(race.actualTop4) ? race.actualTop4.length : 0;
    const settled = a3 >= 3 || a4 >= 3;
    const m4 = (race.predictedTop4 || []).map((p: any) => p.horseNumber).filter((v: any) => v != null && v !== '').map((v: any) => String(v));
    if (!settled || new Set(m4).size !== 4) continue;
    racesBet++;
    dayCost += PER_RACE_STRATEGY_COST;
    for (const bp of (race.boxPayouts || [])) {
      dayPayout += Number(bp.dividend) || 0;
    }
  }
  if (!racesBet) return null;
  return { racesBet, cost: dayCost, payout: dayPayout, net: dayPayout - dayCost };
}

/**
 * 賽後對帳完成：對最近已結算 ST/HV 日寫 daily_pnl（≥ DAILY_PNL_FREEZE_START）。
 * INSERT OR IGNORE；重跑安全。
 */
export async function emitSettledDailyPnlEvents(
  db: D1Database,
  opts?: { engine?: string; lookbackDays?: number; now?: Date },
): Promise<{ written: number; scanned: number }> {
  const engine = opts?.engine ?? 'v12';
  const lookback = opts?.lookbackDays ?? 14;
  const now = opts?.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const from = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - lookback);
    const s = d.toISOString().slice(0, 10);
    return s < DAILY_PNL_FREEZE_START ? DAILY_PNL_FREEZE_START : s;
  })();

  await ensureNotifyEventsTable(db);

  const meetings = await db.prepare(`
    SELECT m.date AS date, m.venue AS venue FROM race_meetings m
    WHERE m.date >= ? AND m.date <= ? AND m.venue IN ('ST','HV')
      AND EXISTS (
        SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id
        WHERE r.meeting_id = m.id AND rr.finishing_position > 0
      )
    ORDER BY m.date ASC
  `).bind(from, today).all<{ date: string; venue: string }>().catch(() => ({ results: [] as any[] }));

  let written = 0;
  const scanned = (meetings.results ?? []).length;
  for (const m of meetings.results ?? []) {
    const cachedRow = await db.prepare(
      `SELECT payload_json FROM meeting_hit_rate_cache WHERE date = ? AND engine = ?`,
    ).bind(m.date, engine).first<{ payload_json: string }>().catch(() => null);
    if (!cachedRow?.payload_json) continue;
    let cached: any;
    try { cached = JSON.parse(cachedRow.payload_json); } catch { continue; }
    const day = dayPnlFromHitRateCache(cached, m.date, m.venue);
    if (!day) continue;
    const ok = await insertEvent(db, {
      event_key: dailyPnlKey(m.date, m.venue, engine),
      type: 'daily_pnl',
      meeting_date: m.date,
      venue: m.venue,
      payload: {
        date: m.date,
        venue: m.venue,
        engine,
        racesBet: day.racesBet,
        cost: day.cost,
        payout: day.payout,
        net: day.net,
        unit: 10,
        title: '官方策略當日盈虧',
        disclaimer: NOTIFY_DISCLAIMER,
        // 公開訊息唔提命中率／回報％；只帶當日淨額數字供投注參考。
      },
    });
    if (ok) written++;
  }
  return { written, scanned };
}

export type NotifyEventRow = {
  event_key: string;
  type: NotifyEventType;
  meeting_date: string | null;
  venue: string | null;
  race_number: number | null;
  horse_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export async function loadNotifyEvents(
  db: D1Database,
  opts: { since: string; types: NotifyEventType[]; limit?: number },
): Promise<NotifyEventRow[]> {
  await ensureNotifyEventsTable(db);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const ph = opts.types.map(() => '?').join(',');
  const { results } = await db.prepare(`
    SELECT event_key, type, meeting_date, venue, race_number, horse_id, payload_json, created_at
    FROM notify_events
    WHERE created_at >= ? AND type IN (${ph})
    ORDER BY created_at ASC, event_key ASC
    LIMIT ?
  `).bind(opts.since, ...opts.types, limit).all<{
    event_key: string;
    type: string;
    meeting_date: string | null;
    venue: string | null;
    race_number: number | null;
    horse_id: string | null;
    payload_json: string;
    created_at: string;
  }>();

  return (results ?? []).map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload_json || '{}'); } catch { /* empty */ }
    return {
      event_key: r.event_key,
      type: r.type as NotifyEventType,
      meeting_date: r.meeting_date,
      venue: r.venue,
      race_number: r.race_number,
      horse_id: r.horse_id,
      payload,
      created_at: r.created_at,
    };
  });
}
