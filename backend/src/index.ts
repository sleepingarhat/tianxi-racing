import { collectDisplayOdds } from './lib/odds-collection';
import { recoverOriginalFreeze, recentlyVerifiedOriginal } from './lib/freeze-recovery';
import { computeFreezeLedger } from './lib/freeze-ledger';
import { Hono } from 'hono';
import { corsPolicy } from './lib/cors-policy';
import { logger } from 'hono/logger';
import type { Env } from './types';
import { meetingsRoutes } from './routes/meetings';
import { racesRoutes } from './routes/races';
import { horsesRoutes } from './routes/horses';
import { jockeysRoutes } from './routes/jockeys';
import { trainersRoutes } from './routes/trainers';
import { chatRoutes } from './routes/chat';
import { analyzeRoutes } from './routes/analyze';
import { oddsRoutes } from './routes/odds';
import { loungeRoutes } from './routes/lounge';
import { silksRoutes } from './routes/silks';
import { silksSvgRoutes } from './routes/silks_svg';
import { adminRoutes } from './routes/admin';
import { adminGateRoutes } from './routes/admin-gate';
import { opsRoutes } from './routes/ops';
import { membershipRoutes, proRoutes } from './routes/membership';
import { watchRoutes } from './routes/watch';
import { getSeasonStatus } from './lib/season';
import { refreshDataStats } from './lib/data-stats';
import { countPredictionLogRows, findMeetingForLockTick, getMeetingLockState, LOCK_LEAD_MINUTES, lockCompletionAllowed } from './lib/lock-window';
import { buildEngineHealth, engineHealthHtml } from './lib/engine-health';

import { ADMIN_AUTH_POLICY, buildAdminBearerHeaders, hasAdminAccess } from './lib/admin-auth';
import { alertHookSecret } from './lib/shared-secret';
import { auditPredictionLock, freezeExplainPayload, freezeMeetingPayload, freezeTopPicksPayload } from './lib/prediction-lock-db';
  import { computeHitRateStats, ensureHitRateCacheTable, writeHitRateCache, readHitRateCache, hitRateCacheBehindResults, ensureRaceDayReportCacheTable, joinPredictionResults, ensurePredictionLogTable, hitRateEngineKey } from './routes/analyze';

const app = new Hono<{ Bindings: Env }>();

app.use('*', corsPolicy());
app.use('*', logger((message, ...rest) => {
  const match = message.match(/^((?:<--|-->)\s+\S+\s+)(\S+)(.*)$/);
  const safeMessage = match
    ? `${match[1]}${match[2].split('?')[0]}${match[3]}`
    : message;
  console.log(safeMessage, ...rest);
}));

app.get('/', (c) => {
  return c.json({
    name: '天喜娛樂 Tianxi Entertainment API',
    version: '1.0.0',
    status: 'ok',
  });
});

app.get('/api/season', async (c) => {
  const s = await getSeasonStatus(c.env.DB);
  return c.json({
    ...s,
    label: s.status === 'off_season' ? '休季中' : '賽季進行中',
    checkedAt: new Date().toISOString(),
  });
});

app.post('/admin/api/set-season-mode', async (c) => {
  if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.BEARER_ONLY))) {
    return c.json({ error: 'unauthorized (Bearer required)' }, 401);
  }
  const mode = c.req.query('mode');
  if (mode !== 'auto' && mode !== 'in' && mode !== 'off') {
    return c.json({ error: "mode must be 'auto' | 'in' | 'off'", got: mode ?? null }, 400);
  }
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run().catch(() => {});
  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('season_mode', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(mode).run();
  const s = await getSeasonStatus(c.env.DB);
  return c.json({ ok: true, ...s, setAt: new Date().toISOString() });
});

app.route('/api/meetings', meetingsRoutes);
app.route('/api/races', racesRoutes);
app.route('/api/horses', horsesRoutes);
app.route('/api/jockeys', jockeysRoutes);
app.route('/api/trainers', trainersRoutes);
app.route('/api/chat', chatRoutes);
// Frozen-prediction overlay: once a meeting's picks are locked (final edition),
// analyze responses must serve the frozen snapshot, never a fresh recompute.
async function overlayFrozenAnalyzeJson(
  c: any,
  next: () => Promise<void>,
  transform: (db: D1Database, data: any) => Promise<any>,
) {
  await next();
  if (c.res.status !== 200) return;
  const ct = c.res.headers.get('content-type') || '';
  if (!ct.includes('json')) return;
  const data = await c.res.clone().json().catch(() => null);
  if (!data || data.error) return;
  try {
    const out = await transform(c.env.DB, data);
    if (out?.freezeError) {
      // Locked meeting without intact frozen evidence: fail closed, never
      // serve the post-lock live recompute as if it were the prediction.
      return c.json(
        { error: '凍結預測紀錄唔完整，暫時未能提供呢場嘅預測。', freezeSource: out.freezeSource ?? null, frozen: false },
        503,
        { 'Cache-Control': 'no-store' },
      );
    }
    return c.json(out);
  } catch (err) {
    console.warn('[prediction-lock] overlay failed', err);
    return c.json({ error: '凍結預測暫時未能讀取，請稍後再試。' }, 503, { 'Cache-Control': 'no-store' });
  }
}

app.get('/api/analyze/prediction-lock', async (c) => {
  const date = c.req.query('date');
  if (!date) return c.json({ error: '請提供 date' }, 400);
  const engine = c.req.query('engine') === 'v11' ? 'v11' : 'v12';
  const audit = await auditPredictionLock(c.env.DB, date, engine);
  return c.json(audit);
});

analyzeRoutes.use('/top-picks', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) => freezeTopPicksPayload(db, data)),
);
analyzeRoutes.use('/today-picks', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) => freezeMeetingPayload(db, data)),
);
analyzeRoutes.use('/picks-by-date', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) => freezeMeetingPayload(db, data)),
);
analyzeRoutes.use('/explain', (c, next) =>
  overlayFrozenAnalyzeJson(c, next, (db, data) =>
    freezeExplainPayload(db, data, c.req.query('raceId'), c.req.query('horseId')),
  ),
);

// 引擎健康：JSON 供監控／公開說明，?format=html 出人讀版。季節同 live 曲線即時讀 DB。
app.get('/api/analyze/engine-health', async (c) => {
  const health = await buildEngineHealth(c.env.DB);
  if (c.req.query('format') === 'html') {
    return c.html(engineHealthHtml(health), 200, { 'Cache-Control': 'no-store' });
  }
  return c.json(health, 200, { 'Cache-Control': 'public, max-age=60' });
});
app.get('/engine/health.json', async (c) => c.json(await buildEngineHealth(c.env.DB), 200, {
  'Cache-Control': 'public, max-age=60',
}));
app.get('/admin/engine-health', async (c) => {
  if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
  return c.html(engineHealthHtml(await buildEngineHealth(c.env.DB)), 200, { 'Cache-Control': 'no-store' });
});

app.route('/api/analyze', analyzeRoutes);

app.route('/api/odds', oddsRoutes);
app.route('/api/lounge', loungeRoutes);
app.route('/api/silks', silksRoutes);
app.route('/api/silks-svg', silksSvgRoutes);
app.route('/api/membership', membershipRoutes);
app.route('/api/watch', watchRoutes);
app.route('/ops', opsRoutes);
app.route('/admin', adminGateRoutes);
app.route('/admin', adminRoutes);

// 舊 Whop 會員中心已停用 → 永久轉去 tianxi.racing 會員頁
app.route('/pro', proRoutes);

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

  async function refreshHitRateCache(env: Env): Promise<{ refreshed: number; errors: number; behind: number }> {
    await ensureHitRateCacheTable(env.DB);
    const today = new Date().toISOString().substring(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT m.date FROM race_meetings m
         LEFT JOIN meeting_hit_rate_cache c ON c.date = m.date AND c.engine = ?
        WHERE m.date < ?
          AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id
                       WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
          AND (c.date IS NULL OR c.payload_json NOT LIKE '%quinellaHits%')
        ORDER BY m.date DESC LIMIT 12`
    ).bind(hitRateEngineKey('v12'), today).all<{ date: string }>();
    const todo: { date: string }[] = [...(results ?? [])];
    const seen = new Set(todo.map((r) => r.date));
    // 補件：最近 8 個有賽果賽日，如快取落後賽果（場數或筆數）就追加重算
    const recent = await env.DB.prepare(
      `SELECT m.date FROM race_meetings m
        WHERE m.date <= ? AND m.venue IN ('ST','HV')
          AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id
                       WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
        ORDER BY m.date DESC LIMIT 8`
    ).bind(today).all<{ date: string }>().catch(() => ({ results: [] as { date: string }[] }));
    let behind = 0;
    for (const row of (recent.results ?? [])) {
      if (seen.has(row.date)) continue;
      const cached = await readHitRateCache(env.DB, row.date, 'v12');
      if (cached && await hitRateCacheBehindResults(env.DB, row.date, cached)) {
        todo.push(row); seen.add(row.date); behind++;
      }
    }
    let refreshed = 0, errors = 0;
    for (const row of todo) {
      try {
        const r = await computeHitRateStats(env.DB, row.date, 'v12', undefined, { boxPayouts: true });
        if ('error' in r) { errors++; continue; }
        await writeHitRateCache(env.DB, row.date, 'v12', r);
        refreshed++;
      } catch { errors++; }
    }
    return { refreshed, errors, behind };
  }

  app.post('/admin/api/refresh-hit-cache', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await refreshHitRateCache(c.env);
    return c.json({ ok: true, ...out, ranAt: new Date().toISOString() });
  });
  void readHitRateCache;

    async function backfillPredictionResults(env: Env): Promise<{ daysProcessed: number; totalUpdated: number }> {
      try {
        await ensurePredictionLogTable(env.DB);
        const today = new Date().toISOString().substring(0, 10);
        const { results } = await env.DB.prepare(
          `SELECT m.date FROM race_meetings m
             WHERE m.date < ?
               AND m.date >= date(?, '-7 days')
               AND EXISTS (SELECT 1 FROM races r JOIN race_results rr ON rr.race_id = r.id WHERE r.meeting_id = m.id AND rr.finishing_position > 0)
             ORDER BY m.date DESC`
        ).bind(today, today).all<{ date: string }>().catch(() => ({ results: [] as { date: string }[] }));
        let totalUpdated = 0;
        for (const row of (results ?? [])) {
          try { const r = await joinPredictionResults(env.DB, row.date); totalUpdated += r.updated; } catch {}
        }
        return { daysProcessed: results?.length ?? 0, totalUpdated };
      } catch (e: any) { return { daysProcessed: 0, totalUpdated: 0 }; }
    }

    app.post('/admin/api/backfill-prediction-results', async (c) => {
      if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
      const out = await backfillPredictionResults(c.env);
      return c.json({ ok: true, ...out, ranAt: new Date().toISOString() });
    });

  async function refreshRaceDayReport(env: Env): Promise<{ ok: boolean; date?: string; venue?: string; races?: number; computeMs?: number; seedSummary?: any; error?: string }> {
    try {
      await ensureRaceDayReportCacheTable(env.DB);
      const url = new URL('https://internal/api/analyze/today-picks?fresh=1');
      const req = new Request(url.toString(), {
        method: 'GET',
        headers: buildAdminBearerHeaders(env),
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
      const data: any = await res.json().catch(() => ({}));
      if (data?.error) return { ok: false, error: data.error };
      return { ok: true, date: data.date, venue: data.venue, races: data.races?.length ?? 0, computeMs: data.computeMs, seedSummary: data.seedSummary };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  // ── T−1.5h LOCK TICK ─────────────────────────────────────────────────
  // Approved spec: the day's Top-4 freezes 90 minutes before the first race.
  // This light tick (every 5 minutes) makes sure a frozen prediction_log
  // snapshot exists AT the lock instant; from then on writePredictionLog
  // refuses every further prediction write, so the public payload can no
  // longer drift with live LGB. Never triggered by results.
  async function lockMeetingIfDue(env: Env): Promise<{ ok: boolean; date?: string; lockAt?: string | null; action: string; rows?: number; error?: string }> {
    try {
      const meeting = await findMeetingForLockTick(env.DB);
      if (!meeting) return { ok: true, action: 'no-fixture' };
      const lock = await getMeetingLockState(env.DB, meeting.date, meeting.venue);
      if (!lock.locked) return { ok: true, action: 'pre-lock', date: meeting.date, lockAt: lock.lockAt };
      if (lock.source === 'error' || !lock.lockAt || !meeting.venue) return { ok: false, action: 'blocked', error: 'lock-state-unavailable' };
      // Already verified within the last hour and the baseline row count still matches the
      // immutable snapshot → skip the full re-verification this tick (re-checked hourly, or
      // immediately if any row is added/removed). Status stays ok=1, so lock-state is unchanged.
      if (await recentlyVerifiedOriginal(env.DB, meeting.date, 'v12')) {
        return { ok: true, action: 'verified-recent', date: meeting.date, lockAt: lock.lockAt, rows: 0 };
      }
      const recovery = await recoverOriginalFreeze(env.DB,meeting.date,meeting.venue,lock.lockAt);
      if (!recovery.ok || recovery.action === 'restored-original') {
        // Event-driven delivery from the existing lock tick; never another poller.
        try {
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS prediction_recovery_notifications (date TEXT NOT NULL, event_key TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY(date,event_key))`).run();
          const eventKey = `${recovery.action}:${recovery.error ?? ''}:${recovery.restored}`;
          const sent = await env.DB.prepare(`SELECT sent_at FROM prediction_recovery_notifications WHERE date=? AND event_key=?`).bind(meeting.date,eventKey).first();
          const hookSecret = alertHookSecret(env);
          if (!sent && hookSecret) {
            const response = await fetch('https://tianxi.racing/api/public/telegram-alert', { method:'POST', headers:{'content-type':'application/json','x-cron-secret':hookSecret}, body:JSON.stringify({kind:'freeze-recovery',date:meeting.date,action:recovery.action,restored:recovery.restored,error:recovery.error??null}), signal:AbortSignal.timeout(8000) });
            const receipt = await response.json() as {sent?:boolean};
            if (response.ok && receipt.sent === true) await env.DB.prepare(`INSERT OR IGNORE INTO prediction_recovery_notifications(date,event_key,sent_at) VALUES (?,?,?)`).bind(meeting.date,eventKey,new Date().toISOString()).run();
          }
        } catch { console.warn('freeze notification pending; original predictions remain blocked or unchanged'); }
      }
      return { ...recovery, date: meeting.date, lockAt: lock.lockAt };

    } catch (e: any) {
      return { ok: false, action: 'error', error: e?.message ?? String(e) };
    }
  }

  app.get('/api/analyze/lock-state', async (c) => {
    const meeting = await findMeetingForLockTick(c.env.DB);
    if (!meeting) return c.json({ locked: false, source: 'no-fixture', lockLeadMinutes: LOCK_LEAD_MINUTES });
    const lock = await getMeetingLockState(c.env.DB, meeting.date, meeting.venue);
    const rows = await countPredictionLogRows(c.env.DB, meeting.date);
    const recovery = lock.locked ? await c.env.DB.prepare(`SELECT ok,action FROM prediction_recovery_status WHERE date=? AND engine='v12'`).bind(meeting.date).first<{ok:number;action:string}>() : null;
    return c.json({ ...lock, frozenRows: rows, lockLeadMinutes: LOCK_LEAD_MINUTES, recovery, edition: lock.locked ? (recovery?.ok === 1 ? 'final' : 'unavailable') : 'draft' },200,{'Cache-Control':'no-store'});
  });

  app.get('/api/analyze/freeze-recovery-status', async (c) => {
    const meeting = await findMeetingForLockTick(c.env.DB);
    c.header('Cache-Control','no-store');
    const historyTable=await c.env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='prediction_recovery_history'`).first();
    const historyResult = historyTable ? await c.env.DB.prepare(`SELECT date,engine,checked_at,ok,action,restored,error FROM prediction_recovery_history ORDER BY id DESC LIMIT 40`).all<any>() : null;
    const history=historyResult?.results ?? [];
    const auditTable=await c.env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='prediction_race_audit_history'`).first();
    const raceAuditResult=auditTable ? await c.env.DB.prepare(`SELECT date,engine,race_number,checked_at,expected,actual,ok,fingerprint,error FROM prediction_race_audit_history ORDER BY id DESC LIMIT 80`).all<any>() : null;
    const race_audits=raceAuditResult?.results ?? [];
    if (!meeting) return c.json({ok:true,action:'no-fixture',history,race_audits});
    const lock = await getMeetingLockState(c.env.DB,meeting.date,meeting.venue);
    if (!lock.locked) return c.json({ok:true,action:'pre-lock',date:meeting.date,history,race_audits});
    const status = await c.env.DB.prepare(`SELECT checked_at,ok,action,restored,error FROM prediction_recovery_status WHERE date=? AND engine='v12'`).bind(meeting.date).first<any>();
    const snapshot=await c.env.DB.prepare(`SELECT sha256 FROM prediction_original_snapshots WHERE date=? AND engine='v12'`).bind(meeting.date).first<{sha256:string}>();
    return c.json({date:meeting.date,...status,history,race_audits,fingerprint:snapshot?.sha256??null,ok:status?.ok===1,action:status?.action??'not-checked'},status?.ok===1?200:503);
  });

  app.post('/admin/api/lock-tick', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await lockMeetingIfDue(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  app.post('/admin/api/refresh-race-day-report', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await refreshRaceDayReport(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  async function pruneOddsToLatestDay(env: Env): Promise<{
    ok: boolean;
    keptDate: string | null;
    snapshotsDeleted: number;
    poolTotalsDeleted: number;
    error?: string;
  }> {
    try {
      const latest = await env.DB.prepare(`SELECT MAX(race_date) AS d FROM odds_snapshots`).first<{ d: string | null }>();
      const keptDate = latest?.d ?? null;
      if (!keptDate) {
        return { ok: true, keptDate: null, snapshotsDeleted: 0, poolTotalsDeleted: 0 };
      }
      const r1 = await env.DB.prepare(`DELETE FROM odds_snapshots WHERE race_date < ?`).bind(keptDate).run();
      const r2 = await env.DB.prepare(`DELETE FROM pool_totals WHERE race_date < ?`).bind(keptDate).run().catch(() => ({ meta: { changes: 0 } } as any));
      return {
        ok: true,
        keptDate,
        snapshotsDeleted: (r1 as any)?.meta?.changes ?? 0,
        poolTotalsDeleted: (r2 as any)?.meta?.changes ?? 0,
      };
    } catch (e: any) {
      return { ok: false, keptDate: null, snapshotsDeleted: 0, poolTotalsDeleted: 0, error: e?.message ?? String(e) };
    }
  }

  async function archiveOddsBeforePrune(env: Env): Promise<{
    ok: boolean;
    oddsArchived: number;
    poolTotalsArchived: number;
    error?: string;
  }> {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS odds_archive (id TEXT PRIMARY KEY, race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL, combination TEXT NOT NULL, odds REAL, snapshot_at TEXT NOT NULL, source_commit TEXT)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_odds_archive_lookup ON odds_archive (race_date, venue, race_number, pool_type, combination, snapshot_at)`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pool_totals_archive (id TEXT PRIMARY KEY, race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL, total_investment REAL, snapshot_at TEXT NOT NULL, source_commit TEXT)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pool_totals_archive_lookup ON pool_totals_archive (race_date, venue, race_number, pool_type, snapshot_at)`).run();
      const a1 = await env.DB.prepare(`INSERT OR IGNORE INTO odds_archive (id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit)
         SELECT id, race_date, venue, race_number, pool_type, combination, odds, snapshot_at, source_commit FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type,combination ORDER BY snapshot_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type,combination ORDER BY snapshot_at DESC) AS rn_desc
           FROM odds_snapshots
           WHERE pool_type IN ('WIN','PLA') AND race_date < (SELECT MAX(race_date) FROM odds_snapshots)
         )
         WHERE rn_asc = 1 OR rn_desc <= 6`).run();
      const a2 = await env.DB.prepare(`INSERT OR IGNORE INTO pool_totals_archive (id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit)
         SELECT id, race_date, venue, race_number, pool_type, total_investment, snapshot_at, source_commit FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type ORDER BY snapshot_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (PARTITION BY race_date,venue,race_number,pool_type ORDER BY snapshot_at DESC) AS rn_desc
           FROM pool_totals
           WHERE race_date < (SELECT MAX(race_date) FROM pool_totals)
         )
         WHERE rn_asc = 1 OR rn_desc <= 6`).run();
      return { ok: true, oddsArchived: (a1 as any)?.meta?.changes ?? 0, poolTotalsArchived: (a2 as any)?.meta?.changes ?? 0 };
    } catch (e: any) {
      return { ok: false, oddsArchived: 0, poolTotalsArchived: 0, error: e?.message ?? String(e) };
    }
  }

  app.post('/admin/api/prune-odds', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await pruneOddsToLatestDay(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  app.post('/admin/api/archive-odds', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await archiveOddsBeforePrune(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  /** Pre-build the public hit-rate rollups the track-record page reads (cache key is the UTC day). */
  async function warmHitRateRollups(env: Env): Promise<{ days: number; ok: boolean; status?: number }[]> {
    const out: { days: number; ok: boolean; status?: number }[] = [];
    for (const days of [90, 30, 60, 180]) {
      try {
        const res = await app.fetch(new Request(`https://internal/api/analyze/hit-rate-rollup?days=${days}`), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
        await res.arrayBuffer().catch(() => null);
        out.push({ days, ok: res.ok, status: res.status });
      } catch { out.push({ days, ok: false }); }
    }
    return out;
  }

  /** Compute the season freeze ledger once so settled meetings get their freeze_ledger_meeting snapshot. */
  async function warmFreezeLedgerSnapshots(env: Env) {
    try {
      const r = await computeFreezeLedger(env.DB);
      return { ok: true, ...r.snapshot, meetings: r.meetings.length };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  async function warmStrategyPnl(env: Env): Promise<{ ok: boolean; pending: number; cached?: boolean; error?: string }> {
    try {
      const req = new Request('https://internal/api/analyze/strategy-pnl?refresh=1', {
        method: 'GET',
        headers: buildAdminBearerHeaders(env),
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
      const data: any = await res.json().catch(() => ({}));
      if (data?.error) return { ok: false, pending: -1, error: data.error };
      return { ok: true, pending: Number(data?.pending ?? 0), cached: data?.cached === true };
    } catch (e: any) { return { ok: false, pending: -1, error: e?.message ?? String(e) }; }
  }

  app.post('/admin/api/warm-strategy-pnl', async (c) => {
    if (!(await hasAdminAccess(c, ADMIN_AUTH_POLICY.SESSION_OR_BEARER))) return c.json({ error: 'Not found' }, 404);
    const out = await warmStrategyPnl(c.env);
    return c.json({ ...out, ranAt: new Date().toISOString() });
  });

  export default {
    fetch: app.fetch,
    async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
      // T−1.5h lock tick runs on EVERY trigger (including the 5-minute tick).
      ctx.waitUntil(lockMeetingIfDue(env).then((r) => console.log('[cron] lock tick', r)));
      // The 5-minute tick does nothing else — heavy jobs stay on their own slots.
      if (String(_event?.cron ?? '') === '*/5 * * * *') {
        ctx.waitUntil(collectDisplayOdds(env).then(r => console.log('[cron] display odds', r)).catch(e => console.error('[cron] display odds failed', String(e))));
        return;
      }
      const cron = String(_event?.cron ?? '');
      ctx.waitUntil(
        refreshHitRateCache(env)
          .then((r) => console.log('[cron] hit-rate refresh', r))
          .then(() => warmStrategyPnl(env))
          .then((r) => console.log('[cron] strategy-pnl warmup', r))
          // 11:00 HKT (03:00 UTC) is the first slot after the UTC day roll-over that keys the rollup cache.
          .then(() => (cron === '0 3 * * *' ? warmHitRateRollups(env).then((r) => console.log('[cron] hit-rate rollup warmup', r)) : undefined)),
      );
      // 03:00 HKT: write freeze_ledger_meeting snapshots for newly settled meetings (no-op until the migration is applied).
      if (cron === '0 19 * * *') {
        ctx.waitUntil(warmFreezeLedgerSnapshots(env).then((r) => console.log('[cron] freeze-ledger snapshots', r)));
      }
      // 06:00 HKT: exact D1 data-volume counts for /api/analyze/data-stats (after the 00:23 results and 05:17 Pool-A syncs).
      if (cron === '0 22 * * *') {
        ctx.waitUntil(refreshDataStats(env.DB).then((r) => console.log('[cron] data-stats', { generatedAt: r.generatedAt, missing: r.missing })).catch((e) => console.error('[cron] data-stats failed', String(e))));
      }
      ctx.waitUntil(refreshRaceDayReport(env).then((r) => console.log('[cron] race-day report refresh', r)));
      ctx.waitUntil(backfillPredictionResults(env).then((r) => console.log('[cron] prediction backfill', r)));
      ctx.waitUntil(
        archiveOddsBeforePrune(env)
          .then((a) => console.log('[cron] odds archive', a))
          .then(() => pruneOddsToLatestDay(env))
          .then((r) => console.log('[cron] odds prune', r)),
      );
    },
  };
