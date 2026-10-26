/**
 * Public read-only API v1（/api/v1/*）.
 * Auth: Authorization: Bearer tx_live_…（D1 SHA-256 hash）.
 * 只開放天喜衍生數據；未鎖今日預測唔開放。
 * Admin key 管理：SITE_READER／TG reader secret 或 ADMIN Bearer。
 *
 * 獨立路由檔，唔改 lab.ts，減少合併衝突。
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { dateIsLocked, loadFrozenPicksForDate } from '../lib/prediction-lock-db';
import {
  API_V1_DEFAULT_SCOPES,
  API_V1_DISCLAIMER,
  API_V1_RATE_PER_DAY,
  API_V1_RATE_PER_MIN,
  API_V1_KEY_PREFIX,
  authenticateApiKey,
  ensureApiV1Tables,
  extractBearer,
  hasApiKeyAdminCredential,
  mintApiKey,
  requireScope,
  type ApiKeyRow,
} from '../lib/api-v1-keys';

export const apiV1Routes = new Hono<{ Bindings: Env }>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENGINE = 'v12';

function bad(c: any, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ error, message, disclaimer: API_V1_DISCLAIMER, ...extra }, status);
}

async function requireApiAuth(c: any, scope?: string) {
  // Fail closed on missing Bearer before DB probe so clients get 401 not 503.
  const header = c.req.header('Authorization');
  const token = extractBearer(header);
  if (!token || !token.startsWith(API_V1_KEY_PREFIX)) {
    return { res: bad(c, 401, 'unauthorized', '需要 Authorization: Bearer tx_live_… API key') };
  }
  const db = c.env.DB;
  if (!db) return { res: bad(c, 503, 'unavailable', '資料庫未就緒') };
  const auth = await authenticateApiKey(db, header);
  if (!auth.ok) {
    if (auth.retryAfter) c.header('Retry-After', String(auth.retryAfter));
    return { res: bad(c, auth.status, auth.error, auth.message) };
  }
  if (scope) {
    const sc = requireScope(auth.scopes, scope);
    if (!sc.ok) return { res: bad(c, sc.status, sc.error, sc.message) };
  }
  return { auth };
}

function parseDateParam(raw: string | undefined, name: string): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  return raw;
}

/** Resolve horse id：接受 horses.id 或 code；Elo 表可能存 code（無 horse_ 前綴）。 */
async function resolveHorse(db: D1Database, id: string): Promise<{ id: string; code: string | null; nameCh: string | null; nameEn: string | null } | null> {
  const row = await db
    .prepare(`SELECT id, code, name_ch, name_en FROM horses WHERE id = ? OR code = ? LIMIT 1`)
    .bind(id, id)
    .first<{ id: string; code: string | null; name_ch: string | null; name_en: string | null }>();
  if (!row) return null;
  return { id: row.id, code: row.code, nameCh: row.name_ch, nameEn: row.name_en };
}

function eloHorseKeys(horse: { id: string; code: string | null }): string[] {
  const keys = new Set<string>();
  keys.add(horse.id);
  if (horse.code) keys.add(horse.code);
  // snapshots often store code without horse_ prefix
  if (horse.id.startsWith('horse_')) keys.add(horse.id.slice(6));
  return [...keys];
}

// ── Health / meta ──────────────────────────────────────────────
const metaHandler = (c: any) =>
  c.json({
    name: 'tianxi-api-v1',
    auth: 'Authorization: Bearer tx_live_…',
    limits: { perMinute: API_V1_RATE_PER_MIN, perDay: API_V1_RATE_PER_DAY },
    disclaimer: API_V1_DISCLAIMER,
    docs: 'https://tianxi.racing/developers',
    endpoints: [
      'GET /api/v1/elo/horses/:id?from=&to=',
      'GET /api/v1/elo/snapshot?date=',
      'GET /api/v1/picks/frozen?date=',
      'GET /api/v1/picks/history?from=&to=',
      'GET /api/v1/features/:raceId',
    ],
  });
apiV1Routes.get('/', metaHandler);
apiV1Routes.get('', metaHandler);

// ── Elo: horse series ──────────────────────────────────────────
apiV1Routes.get('/elo/horses/:id', async (c) => {
  const gate = await requireApiAuth(c, 'elo');
  if ('res' in gate && gate.res) return gate.res;
  const db = c.env.DB;
  const id = c.req.param('id');
  const from = parseDateParam(c.req.query('from'), 'from');
  const to = parseDateParam(c.req.query('to'), 'to');
  if (c.req.query('from') && !from) return bad(c, 400, 'bad_request', 'from 須為 YYYY-MM-DD');
  if (c.req.query('to') && !to) return bad(c, 400, 'bad_request', 'to 須為 YYYY-MM-DD');

  const horse = await resolveHorse(db, id);
  if (!horse) return bad(c, 404, 'not_found', '找不到該馬匹');

  const keys = eloHorseKeys(horse);
  const ph = keys.map(() => '?').join(',');
  const binds: unknown[] = [...keys];
  let dateClause = '';
  if (from) {
    dateClause += ' AND as_of_date >= ?';
    binds.push(from);
  }
  if (to) {
    dateClause += ' AND as_of_date <= ?';
    binds.push(to);
  }

  const { results } = await db
    .prepare(
      `SELECT as_of_date, rating, games_played, confidence, axis_key
       FROM horse_elo_snapshots
       WHERE horse_id IN (${ph}) AND axis_key = 'overall' ${dateClause}
       ORDER BY as_of_date ASC
       LIMIT 2000`,
    )
    .bind(...binds)
    .all<{
      as_of_date: string;
      rating: number;
      games_played: number | null;
      confidence: number | null;
      axis_key: string;
    }>()
    .catch(() => ({ results: [] as any[] }));

  c.header('Cache-Control', 'private, max-age=3600');
  return c.json({
    horseId: horse.id,
    code: horse.code,
    nameCh: horse.nameCh,
    nameEn: horse.nameEn,
    axis: 'overall',
    from: from ?? null,
    to: to ?? null,
    points: (results ?? []).map((r) => ({
      date: r.as_of_date,
      rating: r.rating,
      gamesPlayed: r.games_played,
      confidence: r.confidence,
    })),
    disclaimer: API_V1_DISCLAIMER,
  });
apiV1Routes.get('/', metaHandler);
apiV1Routes.get('', metaHandler);
});

// ── Elo: day snapshot ──────────────────────────────────────────
apiV1Routes.get('/elo/snapshot', async (c) => {
  const gate = await requireApiAuth(c, 'elo');
  if ('res' in gate && gate.res) return gate.res;
  const db = c.env.DB;
  const date = parseDateParam(c.req.query('date'), 'date');
  if (!date) return bad(c, 400, 'bad_request', 'date 必填（YYYY-MM-DD）');

  // Latest overall rating per horse with as_of_date <= date (active-ish).
  const { results } = await db
    .prepare(
      `SELECT s.horse_id, s.rating, s.as_of_date, s.games_played, s.confidence,
              h.name_ch, h.name_en, h.code, h.status
       FROM horse_elo_snapshots s
       LEFT JOIN horses h ON (h.id = s.horse_id OR h.code = s.horse_id OR h.id = ('horse_' || s.horse_id))
       WHERE s.axis_key = 'overall'
         AND s.as_of_date = (
           SELECT MAX(s2.as_of_date) FROM horse_elo_snapshots s2
           WHERE s2.horse_id = s.horse_id AND s2.axis_key = 'overall' AND s2.as_of_date <= ?
         )
         AND (h.status IS NULL OR h.status != 'retired' OR s.as_of_date >= date(?, '-365 days'))
       ORDER BY s.rating DESC
       LIMIT 5000`,
    )
    .bind(date, date)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));

  c.header('Cache-Control', 'private, max-age=86400');
  return c.json({
    date,
    count: (results ?? []).length,
    horses: (results ?? []).map((r) => ({
      horseId: r.horse_id,
      code: r.code ?? null,
      nameCh: r.name_ch ?? null,
      nameEn: r.name_en ?? null,
      rating: r.rating,
      asOfDate: r.as_of_date,
      gamesPlayed: r.games_played ?? null,
      confidence: r.confidence ?? null,
      status: r.status ?? null,
    })),
    disclaimer: API_V1_DISCLAIMER,
  });
});

// ── Frozen picks for a date ────────────────────────────────────
apiV1Routes.get('/picks/frozen', async (c) => {
  const gate = await requireApiAuth(c, 'picks');
  if ('res' in gate && gate.res) return gate.res;
  const db = c.env.DB;
  const date = parseDateParam(c.req.query('date'), 'date');
  if (!date) return bad(c, 400, 'bad_request', 'date 必填（YYYY-MM-DD）');

  const locked = await dateIsLocked(db, date);
  if (!locked) {
    return bad(c, 403, 'not_frozen', '該日預測尚未凍結；未鎖今日預測不經公開 API 開放');
  }

  const frozen = await loadFrozenPicksForDate(db, date, ENGINE);
  if (!frozen.ok) {
    return bad(c, 404, 'not_found', frozen.error || '找不到凍結預測');
  }

  const races: any[] = [];
  for (const [raceNumber, picks] of [...frozen.byRace.entries()].sort((a, b) => a[0] - b[0])) {
    const top4 = picks.filter((p) => Number(p.rank) >= 1 && Number(p.rank) <= 4);
    const fifth = picks.find((p) => Number(p.rank) === 5) ?? null;
    races.push({
      raceNumber,
      top4: top4.map((p) => ({
        rank: p.rank,
        horseId: p.horseId,
        horseNumber: p.horseNumber,
        nameCh: p.nameCh ?? null,
        draw: p.draw ?? null,
        pWin: p.pWin ?? null,
        pTop3: p.pTop3 ?? null,
        finalScore: p.finalScore ?? null,
      })),
      fifth: fifth
        ? {
            rank: fifth.rank,
            horseId: fifth.horseId,
            horseNumber: fifth.horseNumber,
            nameCh: fifth.nameCh ?? null,
          }
        : null,
    });
  }

  // Version fingerprint from generated_at / engine
  const meta = await db
    .prepare(
      `SELECT MIN(generated_at) AS first_at, MAX(generated_at) AS last_at, COUNT(*) AS n
       FROM prediction_log WHERE date = ? AND engine = ? AND variant = 'baseline'`,
    )
    .bind(date, ENGINE)
    .first<{ first_at: string | null; last_at: string | null; n: number }>()
    .catch(() => null);

  c.header('Cache-Control', 'private, max-age=86400');
  return c.json({
    date,
    engine: ENGINE,
    variant: 'baseline',
    locked: true,
    fingerprint: {
      engine: ENGINE,
      rowCount: meta?.n ?? null,
      generatedAtMin: meta?.first_at ?? null,
      generatedAtMax: meta?.last_at ?? null,
    },
    races,
    disclaimer: API_V1_DISCLAIMER,
  });
});

// ── History of frozen picks + hit summary ──────────────────────
apiV1Routes.get('/picks/history', async (c) => {
  const gate = await requireApiAuth(c, 'picks');
  if ('res' in gate && gate.res) return gate.res;
  const db = c.env.DB;
  const from = parseDateParam(c.req.query('from'), 'from');
  const to = parseDateParam(c.req.query('to'), 'to');
  if (!from || !to) return bad(c, 400, 'bad_request', 'from 同 to 必填（YYYY-MM-DD）');
  if (from > to) return bad(c, 400, 'bad_request', 'from 不可晚過 to');

  // Cap range to ~120 days to protect Worker CPU
  const fromT = Date.parse(from + 'T00:00:00Z');
  const toT = Date.parse(to + 'T00:00:00Z');
  if (Number.isFinite(fromT) && Number.isFinite(toT) && toT - fromT > 120 * 86400_000) {
    return bad(c, 400, 'bad_request', '日期範圍最長 120 日');
  }

  const { results } = await db
    .prepare(
      `SELECT pl.date, pl.race_number, pl.horse_id, pl.horse_number, pl.predicted_rank,
              pl.p_win, pl.is_hit_top1, pl.is_hit_top3, pl.is_hit_top4, pl.actual_finish,
              h.name_ch
       FROM prediction_log pl
       LEFT JOIN horses h ON h.id = pl.horse_id
       WHERE pl.date >= ? AND pl.date <= ?
         AND pl.engine = ? AND pl.variant = 'baseline'
         AND pl.predicted_rank IS NOT NULL AND pl.predicted_rank BETWEEN 1 AND 4
       ORDER BY pl.date ASC, pl.race_number ASC, pl.predicted_rank ASC
       LIMIT 20000`,
    )
    .bind(from, to, ENGINE)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));

  type DayAcc = {
    date: string;
    races: Map<number, { raceNumber: number; picks: any[]; hitsTop4: number | null }>;
  };
  const byDate = new Map<string, DayAcc>();
  let racesWithResult = 0;
  let racesHitAtLeast1 = 0;
  let totalTop4Hits = 0;

  for (const r of results ?? []) {
    let day = byDate.get(r.date);
    if (!day) {
      day = { date: r.date, races: new Map() };
      byDate.set(r.date, day);
    }
    let race = day.races.get(r.race_number);
    if (!race) {
      race = { raceNumber: r.race_number, picks: [], hitsTop4: null };
      day.races.set(r.race_number, race);
    }
    race.picks.push({
      rank: r.predicted_rank,
      horseId: r.horse_id,
      horseNumber: r.horse_number,
      nameCh: r.name_ch ?? null,
      pWin: r.p_win ?? null,
      actualFinish: r.actual_finish ?? null,
      hitTop4: r.is_hit_top4 == null ? null : r.is_hit_top4 === 1,
    });
  }

  const days = [];
  for (const day of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const raceList = [];
    for (const race of [...day.races.values()].sort((a, b) => a.raceNumber - b.raceNumber)) {
      const settled = race.picks.some((p) => p.actualFinish != null);
      const hits = race.picks.filter((p) => p.hitTop4 === true).length;
      if (settled) {
        racesWithResult += 1;
        totalTop4Hits += hits;
        if (hits >= 1) racesHitAtLeast1 += 1;
      }
      raceList.push({
        raceNumber: race.raceNumber,
        top4: race.picks,
        hitCount: settled ? hits : null,
      });
    }
    days.push({ date: day.date, races: raceList });
  }

  c.header('Cache-Control', 'private, max-age=86400');
  return c.json({
    from,
    to,
    engine: ENGINE,
    summary: {
      raceDays: days.length,
      racesWithResult,
      racesHitAtLeast1,
      avgTop4Hits: racesWithResult ? Math.round((totalTop4Hits / racesWithResult) * 1000) / 1000 : null,
    },
    days,
    disclaimer: API_V1_DISCLAIMER,
  });
});

// ── Features for a drawn/locked race ───────────────────────────
apiV1Routes.get('/features/:raceId', async (c) => {
  const gate = await requireApiAuth(c, 'features');
  if ('res' in gate && gate.res) return gate.res;
  const db = c.env.DB;
  const raceId = c.req.param('raceId');
  if (!raceId || raceId.length > 64) return bad(c, 400, 'bad_request', 'raceId 無效');

  const race = await db
    .prepare(
      `SELECT r.id, r.race_number, r.distance, r.class, r.going, r.course,
              rm.date AS meeting_date, rm.venue
       FROM races r
       JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE r.id = ?
       LIMIT 1`,
    )
    .bind(raceId)
    .first<any>();
  if (!race) return bad(c, 404, 'not_found', '找不到該場次');

  // Must be drawn (entries or results) AND meeting locked
  const drawn = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM race_results WHERE race_id = ?) AS result_n,
         (SELECT COUNT(*) FROM entries_upcoming
           WHERE race_date = ? AND venue = ? AND race_number = ?) AS entry_n`,
    )
    .bind(raceId, race.meeting_date, race.venue, race.race_number)
    .first<{ result_n: number; entry_n: number }>()
    .catch(() => ({ result_n: 0, entry_n: 0 }));

  if (!drawn || (Number(drawn.result_n) + Number(drawn.entry_n) < 1)) {
    return bad(c, 403, 'not_drawn', '只開放已排位／已有賽果場次的特徵');
  }

  const locked = await dateIsLocked(db, race.meeting_date, race.venue);
  if (!locked) {
    return bad(c, 403, 'not_frozen', '該日尚未凍結；未鎖特徵不開放');
  }

  const { results } = await db
    .prepare(
      `SELECT pl.horse_id, pl.horse_number, pl.draw, pl.horse_elo, pl.jockey_elo, pl.trainer_elo,
              pl.elo_composite, pl.factor_bonus, pl.final_score, pl.p_win, pl.p_top3,
              pl.predicted_rank, pl.lgb_score, pl.lgb_model_version, pl.score_source,
              pl.factor_scores, pl.pace_estimate, h.name_ch, h.name_en
       FROM prediction_log pl
       LEFT JOIN horses h ON h.id = pl.horse_id
       WHERE pl.date = ? AND pl.engine = ? AND pl.variant = 'baseline'
         AND pl.race_number = ?
       ORDER BY CASE WHEN pl.predicted_rank IS NULL THEN 1 ELSE 0 END, pl.predicted_rank ASC, pl.horse_number ASC`,
    )
    .bind(race.meeting_date, ENGINE, race.race_number)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));

  c.header('Cache-Control', 'private, max-age=86400');
  return c.json({
    raceId,
    date: race.meeting_date,
    venue: race.venue,
    raceNumber: race.race_number,
    distance: race.distance,
    class: race.class,
    going: race.going,
    course: race.course,
    runners: (results ?? []).map((r) => ({
      horseId: r.horse_id,
      horseNumber: r.horse_number,
      nameCh: r.name_ch ?? null,
      nameEn: r.name_en ?? null,
      draw: r.draw ?? null,
      horseElo: r.horse_elo ?? null,
      jockeyElo: r.jockey_elo ?? null,
      trainerElo: r.trainer_elo ?? null,
      eloComposite: r.elo_composite ?? null,
      factorBonus: r.factor_bonus ?? null,
      finalScore: r.final_score ?? null,
      pWin: r.p_win ?? null,
      pTop3: r.p_top3 ?? null,
      predictedRank: r.predicted_rank ?? null,
      lgbScore: r.lgb_score ?? null,
      lgbModelVersion: r.lgb_model_version ?? null,
      scoreSource: r.score_source ?? null,
      paceEstimate: r.pace_estimate ?? null,
      // factor_scores 係天喜衍生 JSON；可能係字串
      factorScores: (() => {
        if (r.factor_scores == null) return null;
        if (typeof r.factor_scores === 'object') return r.factor_scores;
        try {
          return JSON.parse(String(r.factor_scores));
        } catch {
          return null;
        }
      })(),
    })),
    disclaimer: API_V1_DISCLAIMER,
  });
});

// ── Admin: create / list / revoke keys ─────────────────────────
apiV1Routes.post('/admin/keys', async (c) => {
  if (!(await hasApiKeyAdminCredential(c))) {
    return bad(c, 401, 'unauthorized', '需要 SITE_READER／TG reader secret 或 ADMIN Bearer');
  }
  const db = c.env.DB;
  if (!db) return bad(c, 503, 'unavailable', '資料庫未就緒');
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return bad(c, 400, 'bad_request', '需要 JSON body');
  }
  const userId = String(body.userId ?? body.user_id ?? '').trim();
  if (!userId || userId.length > 128) return bad(c, 400, 'bad_request', 'userId 必填');
  const scopes = String(body.scopes ?? API_V1_DEFAULT_SCOPES).trim() || API_V1_DEFAULT_SCOPES;
  const entitlementUntil =
    body.entitlementUntil != null
      ? String(body.entitlementUntil)
      : body.entitlement_until != null
        ? String(body.entitlement_until)
        : null;
  const label = body.label != null ? String(body.label).slice(0, 64) : null;

  await ensureApiV1Tables(db);
  const minted = await mintApiKey();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO api_keys (id, key_prefix, key_hash, user_id, scopes, entitlement_until, revoked_at, last_used_at, created_at, label)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      minted.id,
      minted.keyPrefix,
      minted.keyHash,
      userId,
      scopes,
      entitlementUntil,
      now,
      label,
    )
    .run();

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    id: minted.id,
    keyPrefix: minted.keyPrefix,
    /** 只喺建立時回傳一次 */
    apiKey: minted.plaintext,
    userId,
    scopes,
    entitlementUntil,
    createdAt: now,
    label,
    note: '請立即保存 apiKey；之後無法再讀取明文。',
    disclaimer: API_V1_DISCLAIMER,
  });
});

apiV1Routes.get('/admin/keys', async (c) => {
  if (!(await hasApiKeyAdminCredential(c))) {
    return bad(c, 401, 'unauthorized', '需要 SITE_READER／TG reader secret 或 ADMIN Bearer');
  }
  const db = c.env.DB;
  if (!db) return bad(c, 503, 'unavailable', '資料庫未就緒');
  const userId = (c.req.query('userId') ?? c.req.query('user_id') ?? '').trim();
  if (!userId) return bad(c, 400, 'bad_request', 'userId 必填');
  await ensureApiV1Tables(db);
  const { results } = await db
    .prepare(
      `SELECT id, key_prefix, user_id, scopes, entitlement_until, revoked_at, last_used_at, created_at, label
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<ApiKeyRow>();

  const usageRows = await db
    .prepare(
      `SELECT key_id, date, count FROM api_usage_daily
       WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ?)
       ORDER BY date DESC LIMIT 200`,
    )
    .bind(userId)
    .all<{ key_id: string; date: string; count: number }>()
    .catch(() => ({ results: [] as any[] }));

  return c.json({
    keys: (results ?? []).map((k) => ({
      id: k.id,
      keyPrefix: k.key_prefix,
      scopes: k.scopes,
      entitlementUntil: k.entitlement_until,
      revokedAt: k.revoked_at,
      lastUsedAt: k.last_used_at,
      createdAt: k.created_at,
      label: k.label,
    })),
    usage: (usageRows.results ?? []).map((u) => ({
      keyId: u.key_id,
      date: u.date,
      count: u.count,
    })),
    limits: { perMinute: API_V1_RATE_PER_MIN, perDay: API_V1_RATE_PER_DAY },
  });
});

apiV1Routes.post('/admin/keys/:id/revoke', async (c) => {
  if (!(await hasApiKeyAdminCredential(c))) {
    return bad(c, 401, 'unauthorized', '需要 SITE_READER／TG reader secret 或 ADMIN Bearer');
  }
  const db = c.env.DB;
  if (!db) return bad(c, 503, 'unavailable', '資料庫未就緒');
  const id = c.req.param('id');
  await ensureApiV1Tables(db);
  const now = new Date().toISOString();
  const res = await db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now, id)
    .run();
  const changed = Number((res as any)?.meta?.changes ?? 0);
  if (!changed) {
    const exists = await db.prepare(`SELECT id, revoked_at FROM api_keys WHERE id = ?`).bind(id).first<any>();
    if (!exists) return bad(c, 404, 'not_found', '找不到該金鑰');
    return c.json({ id, revokedAt: exists.revoked_at, alreadyRevoked: true });
  }
  return c.json({ id, revokedAt: now, alreadyRevoked: false });
});

apiV1Routes.patch('/admin/keys/:id', async (c) => {
  if (!(await hasApiKeyAdminCredential(c))) {
    return bad(c, 401, 'unauthorized', '需要 SITE_READER／TG reader secret 或 ADMIN Bearer');
  }
  const db = c.env.DB;
  if (!db) return bad(c, 503, 'unavailable', '資料庫未就緒');
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return bad(c, 400, 'bad_request', '需要 JSON body');
  }
  const id = c.req.param('id');
  await ensureApiV1Tables(db);
  if ('entitlementUntil' in body || 'entitlement_until' in body) {
    const until =
      body.entitlementUntil != null
        ? String(body.entitlementUntil)
        : body.entitlement_until != null
          ? String(body.entitlement_until)
          : null;
    await db.prepare(`UPDATE api_keys SET entitlement_until = ? WHERE id = ?`).bind(until, id).run();
  }
  if ('scopes' in body && body.scopes != null) {
    await db.prepare(`UPDATE api_keys SET scopes = ? WHERE id = ?`).bind(String(body.scopes), id).run();
  }
  const row = await db
    .prepare(
      `SELECT id, key_prefix, scopes, entitlement_until, revoked_at, last_used_at, created_at, label
       FROM api_keys WHERE id = ?`,
    )
    .bind(id)
    .first<any>();
  if (!row) return bad(c, 404, 'not_found', '找不到該金鑰');
  return c.json({
    id: row.id,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    entitlementUntil: row.entitlement_until,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    label: row.label,
  });
});
