/**
 * Pro 研究室 API（/api/lab/*）。
 * 必須帶網站／服務唯讀 secret（X-Tianxi-Site-Token 或 X-TG-Reader-Token）；冇 → 401。
 * 會籍閘喺網站 serverFn（requireTier('pro')）；Worker 只驗 machine secret。
 * 含 h2h / search（type = horse／jockey／trainer）。
 * 已下架（410 Gone）：/backtest、/compare*、/pace*、/pace-forecast*、/going、/weather*。
 * 彩池優化器（/pools*）喺 lab-pools，同樣 410。
 * Trainer Elo 讀 trainer_elo_snapshots；表唔存在時 elo 陣列為空，唔假造 rating。
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { cachedJson, jsonEtag } from '../lib/edge-cache';
import { coerceFinishingPosition } from '../lib/finishing-position';
import { hasReaderCredential, READER_VARY, SITE_READER_HEADER, TG_READER_HEADER } from '../lib/tg-reader';
import {
  buildConditionRows,
  buildDirectMeetings,
  buildRunningStyle,
  canonicalH2hCacheKey,
  collectWarnings,
  isH2hType,
  meetingMarkersFrom,
  parseDistanceFilter,
  validateEntityId,
  type EloPoint,
  type H2hType,
  type ResultRow,
} from '../lib/lab-h2h';

export const labRoutes = new Hono<{ Bindings: Env }>();

/** h2h／search 共用。 */
const H2H_TYPE_ERROR = 'type 只接受 horse／jockey／trainer';

const FRESH_MS = 10 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const CACHE_CONTROL = 'private, max-age=60, stale-while-revalidate=86400';

async function requireLabSecret(c: any): Promise<Response | null> {
  if (await hasReaderCredential(c)) return null;
  c.header('Vary', READER_VARY);
  c.header('Cache-Control', 'private, no-store');
  return c.json(
    { error: 'unauthorized', message: '此研究室 API 需要服務憑證' },
    401,
  );
}

function isMissingSqlTable(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
  return /no such table/i.test(msg);
}

function entityCol(type: H2hType): string {
  if (type === 'horse') return 'rr.horse_id';
  if (type === 'trainer') return 'rr.trainer_id';
  return 'rr.jockey_id';
}

async function loadEntity(db: D1Database, type: H2hType, id: string) {
  if (type === 'horse') {
    const row = await db
      .prepare(
        `SELECT id, name_ch, name_en, code, status FROM horses WHERE id = ? LIMIT 1`,
      )
      .bind(id)
      .first<any>();
    if (!row) return null;
    return {
      id: row.id as string,
      nameCh: (row.name_ch as string) ?? null,
      nameEn: (row.name_en as string) ?? null,
      code: (row.code as string) ?? null,
      status: (row.status as string) ?? null,
    };
  }
  const personSql =
    type === 'trainer'
      ? `SELECT id, name_ch, name_en, is_active FROM trainers WHERE id = ? LIMIT 1`
      : `SELECT id, name_ch, name_en, is_active FROM jockeys WHERE id = ? LIMIT 1`;
  const row = await db.prepare(personSql).bind(id).first<any>();
  if (!row) return null;
  return {
    id: row.id as string,
    nameCh: (row.name_ch as string) ?? null,
    nameEn: (row.name_en as string) ?? null,
    code: null as string | null,
    status: row.is_active ? 'active' : 'inactive',
  };
}

async function loadElo(db: D1Database, type: H2hType, id: string): Promise<EloPoint[]> {
  if (type === 'horse') {
    const { results } = await db
      .prepare(
        `SELECT as_of_date AS date, rating
         FROM horse_elo_snapshots
         WHERE horse_id = ? AND axis_key = 'overall'
         ORDER BY as_of_date ASC`,
      )
      .bind(id)
      .all<any>();
    return (results ?? []).map((r: any) => ({
      date: String(r.date),
      rating: Number(r.rating),
    }));
  }
  if (type === 'trainer') {
    // 冇 trainer_elo_snapshots（或查詢因缺表失敗）→ 空陣列。唔假造 rating。
    try {
      const { results } = await db
        .prepare(
          `SELECT as_of_date AS date, rating
           FROM trainer_elo_snapshots
           WHERE trainer_id = ?
           ORDER BY as_of_date ASC`,
        )
        .bind(id)
        .all<any>();
      return (results ?? []).map((r: any) => ({
        date: String(r.date),
        rating: Number(r.rating),
      }));
    } catch (err) {
      if (isMissingSqlTable(err)) return [];
      throw err;
    }
  }
  const { results } = await db
    .prepare(
      `SELECT as_of_date AS date, rating
       FROM jockey_elo_snapshots
       WHERE jockey_id = ?
       ORDER BY as_of_date ASC`,
    )
    .bind(id)
    .all<any>();
  return (results ?? []).map((r: any) => ({
    date: String(r.date),
    rating: Number(r.rating),
  }));
}

async function loadResultRows(
  db: D1Database,
  type: H2hType,
  id: string,
): Promise<ResultRow[]> {
  const col = entityCol(type);
  // horse_sectional_times：用最大 section_number 當末段近似（多數為末 400／最後一段）
  const { results } = await db
    .prepare(
      `SELECT
         ${col} AS entity_id,
         rr.race_id AS race_id,
         rm.date AS date,
         rm.venue AS venue,
         r.race_number AS race_number,
         r.distance AS distance,
         r.going AS going,
         r.track AS track,
         rr.draw AS draw,
         rr.finishing_position AS position,
         rr.running_position AS running_position,
         (
           SELECT COUNT(*) FROM race_results rr2 WHERE rr2.race_id = rr.race_id
         ) AS total_runners,
         (
           SELECT hst.section_time
           FROM horse_sectional_times hst
           WHERE hst.race_id = rr.race_id AND hst.horse_id = rr.horse_id
           ORDER BY hst.section_number DESC
           LIMIT 1
         ) AS last400
       FROM race_results rr
       JOIN races r ON r.id = rr.race_id
       JOIN race_meetings rm ON rm.id = r.meeting_id
       WHERE ${col} = ?
       ORDER BY rm.date DESC
       LIMIT 400`,
    )
    .bind(id)
    .all<any>();

  return (results ?? []).map((r: any) => ({
    entityId: String(r.entity_id),
    raceId: String(r.race_id),
    date: String(r.date),
    venue: r.venue ?? null,
    raceNumber: r.race_number != null ? Number(r.race_number) : null,
    distance: r.distance != null ? Number(r.distance) : null,
    going: r.going ?? null,
    track: r.track ?? null,
    draw: r.draw != null ? Number(r.draw) : null,
    position: coerceFinishingPosition(r.position),
    runningPosition: r.running_position ?? null,
    totalRunners: r.total_runners != null ? Number(r.total_runners) : null,
    last400: r.last400 != null ? Number(r.last400) : null,
  }));
}

/** GET /api/lab/h2h?type=&a=&b=&distance=&going=&venue= */
labRoutes.get('/h2h', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;

  const typeRaw = c.req.query('type') ?? 'horse';
  if (!isH2hType(typeRaw)) {
    return c.json({ error: H2H_TYPE_ERROR }, 400);
  }
  const type: H2hType = typeRaw;
  const a = (c.req.query('a') ?? '').trim();
  const b = (c.req.query('b') ?? '').trim();
  if (!a || !b) return c.json({ error: '請提供 a 同 b' }, 400);
  if (a === b) return c.json({ error: '請揀兩個唔同對象' }, 400);
  if (!validateEntityId(type, a) || !validateEntityId(type, b)) {
    return c.json({ error: '對象 id 格式唔啱' }, 400);
  }

  const distance = parseDistanceFilter(c.req.query('distance'));
  const going = (c.req.query('going') ?? '').trim() || null;
  const venueRaw = (c.req.query('venue') ?? '').trim().toUpperCase();
  let venue: string | null = null;
  if (venueRaw) {
    if (venueRaw !== 'ST' && venueRaw !== 'HV') {
      return c.json({ error: 'venue 只接受 ST 或 HV' }, 400);
    }
    venue = venueRaw;
  }

  c.header('Vary', `${READER_VARY}`);

  const db = c.env.DB;
  const [entA, entB] = await Promise.all([
    loadEntity(db, type, a),
    loadEntity(db, type, b),
  ]);
  if (!entA || !entB) {
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      {
        error: '找不到對象',
        missing: [!entA ? a : null, !entB ? b : null].filter(Boolean),
      },
      404,
    );
  }

  const cacheKey = canonicalH2hCacheKey({ type, a, b, distance, going, venue });
  const swapped = a > b;
  const reqA = a;
  const reqB = b;
  // 實體已確認存在；快取只存成功 payload
  const entityA = entA;
  const entityB = entB;

  return cachedJson({
    request: c.req.raw,
    key: cacheKey,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
    compute: async () => {
      const [eloA, eloB, rowsA, rowsB] = await Promise.all([
        loadElo(db, type, reqA),
        loadElo(db, type, reqB),
        loadResultRows(db, type, reqA),
        loadResultRows(db, type, reqB),
      ]);

      const filters = { distance, going, venue };
      const conditions = buildConditionRows(rowsA, rowsB, filters);
      const meetings = buildDirectMeetings(rowsA, rowsB);
      const styleA = buildRunningStyle(rowsA);
      const styleB = buildRunningStyle(rowsB);
      const markers = meetingMarkersFrom(meetings, eloA, eloB);
      const overall = conditions.find((x) => x.key === 'overall');
      const warnings = collectWarnings([
        overall?.a ?? { lowSample: false },
        overall?.b ?? { lowSample: false },
        styleA,
        styleB,
        { lowSample: meetings.length > 0 && meetings.length < 5 },
      ]);

      const payload = {
        type,
        a: reqA,
        b: reqB,
        filters: { distance, going, venue },
        entities: { a: entityA, b: entityB },
        elo: {
          a: eloA,
          b: eloB,
          meetings: markers,
        },
        conditions,
        runningStyle: { a: styleA, b: styleB },
        meetings,
        warnings,
        meta: {
          swappedForCache: swapped,
          rowCounts: { a: rowsA.length, b: rowsB.length },
          generatedAt: new Date().toISOString(),
        },
      };
      const body = JSON.stringify(payload);
      return {
        body,
        etag: await jsonEtag(body),
        cacheControl: CACHE_CONTROL,
        cacheable: true,
        freshMs: FRESH_MS,
        staleMs: STALE_MS,
      };
    },
  });
});

/** GET /api/lab/search?type=&q= — Pro 研究室搜尋（馬／騎師／練馬師；items 同形） */
labRoutes.get('/search', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;

  const typeRaw = c.req.query('type') ?? 'horse';
  if (!isH2hType(typeRaw)) return c.json({ error: H2H_TYPE_ERROR }, 400);
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json({ error: '請提供搜索關鍵字' }, 400);
  if (q.length > 40) return c.json({ error: '關鍵字過長' }, 400);

  c.header('Vary', READER_VARY);
  c.header('Cache-Control', 'private, max-age=30');

  if (typeRaw === 'horse') {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name_ch, name_en, code, status
       FROM horses
       WHERE name_ch LIKE ? OR name_en LIKE ? OR code LIKE ?
       ORDER BY status = 'active' DESC, name_ch ASC
       LIMIT 20`,
    )
      .bind(`%${q}%`, `%${q}%`, `%${q}%`)
      .all<any>();
    return c.json({
      type: 'horse',
      items: (results ?? []).map((h: any) => ({
        id: h.id,
        nameCh: h.name_ch ?? null,
        nameEn: h.name_en ?? null,
        code: h.code ?? null,
        status: h.status ?? null,
      })),
    });
  }

  if (typeRaw === 'trainer') {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name_ch, name_en, is_active
       FROM trainers
       WHERE name_ch LIKE ? OR name_en LIKE ? OR id LIKE ? OR REPLACE(id, 'trainer_', '') LIKE ?
       ORDER BY is_active DESC, name_ch ASC
       LIMIT 20`,
    )
      .bind(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
      .all<any>();
    return c.json({
      type: 'trainer',
      items: (results ?? []).map((t: any) => ({
        id: t.id,
        nameCh: t.name_ch ?? null,
        nameEn: t.name_en ?? null,
        code: String(t.id).replace(/^trainer_/, ''),
        status: t.is_active ? 'active' : 'inactive',
      })),
    });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, name_ch, name_en, is_active
     FROM jockeys
     WHERE name_ch LIKE ? OR name_en LIKE ? OR id LIKE ? OR REPLACE(id, 'jockey_', '') LIKE ?
     ORDER BY is_active DESC, name_ch ASC
     LIMIT 20`,
  )
    .bind(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    .all<any>();

  return c.json({
    type: 'jockey',
    items: (results ?? []).map((j: any) => ({
      id: j.id,
      nameCh: j.name_ch ?? null,
      nameEn: j.name_en ?? null,
      code: String(j.id).replace(/^jockey_/, ''),
      status: j.is_active ? 'active' : 'inactive',
    })),
  });
});

// re-export header names for tests

/** 走位／節奏預測已下架（產品面移除）。舊客戶端呼叫回 410 Gone。 */
labRoutes.all('/pace', (c) => labFeatureGone(c));
labRoutes.all('/pace/:raceId', (c) => labFeatureGone(c));
labRoutes.all('/pace/*', (c) => labFeatureGone(c));
labRoutes.all('/pace-forecast', (c) => labFeatureGone(c));
labRoutes.all('/pace-forecast/:raceId', (c) => labFeatureGone(c));
labRoutes.all('/pace-forecast/*', (c) => labFeatureGone(c));

/** 已下架嘅研究室功能。舊客戶端呼叫回 410 Gone（唔再驗 secret）。 */
const LAB_FEATURE_GONE = {
  error: 'gone',
  message:
    '自訂回測、策略比較器、走位／節奏預測同彩池優化器已下架。請改用研究室其他工具（頭對頭）。',
  redirect: '/lab',
} as const;

export function labFeatureGone(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json(LAB_FEATURE_GONE, 410);
}

/** POST /api/lab/backtest — gone */
labRoutes.post('/backtest', async (c) => labFeatureGone(c));

/** GET /api/lab/backtest/:hash — gone */
labRoutes.get('/backtest/:hash', async (c) => labFeatureGone(c));

/** GET /api/lab/compare — gone */
labRoutes.get('/compare', async (c) => labFeatureGone(c));

/** POST /api/lab/compare — gone */
labRoutes.post('/compare', async (c) => labFeatureGone(c));

/** GET /api/lab/compare/baselines — gone */
labRoutes.get('/compare/baselines', async (c) => labFeatureGone(c));

/** 場地狀況／天氣研究室已下架。舊客戶端呼叫回 410 Gone（唔再驗 secret）。 */
labRoutes.all('/going', (c) => labFeatureGone(c));
labRoutes.all('/going/:rest', (c) => labFeatureGone(c));
labRoutes.all('/going/*', (c) => labFeatureGone(c));
labRoutes.all('/weather', (c) => labFeatureGone(c));
labRoutes.all('/weather/:meetingId', (c) => labFeatureGone(c));
labRoutes.all('/weather/*', (c) => labFeatureGone(c));

export { SITE_READER_HEADER, TG_READER_HEADER };
