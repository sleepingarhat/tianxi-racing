/**
 * Pro 研究室 API（/api/lab/*）。
 * 必須帶網站／服務唯讀 secret（X-Tianxi-Site-Token 或 X-TG-Reader-Token）；冇 → 401。
 * 會籍閘喺網站 serverFn（requireTier('pro')）；Worker 只驗 machine secret。
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { cachedJson, jsonEtag } from '../lib/edge-cache';
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

function entityCol(type: H2hType): string {
  return type === 'horse' ? 'rr.horse_id' : 'rr.jockey_id';
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
  const row = await db
    .prepare(
      `SELECT id, name_ch, name_en, is_active FROM jockeys WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<any>();
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
    position: r.position != null ? Number(r.position) : null,
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
    return c.json({ error: 'type 只接受 horse 或 jockey' }, 400);
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

/** GET /api/lab/search?type=&q= — Pro 研究室搜尋（馬沿用公開邏輯；騎師補齊） */
labRoutes.get('/search', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;

  const typeRaw = c.req.query('type') ?? 'horse';
  if (!isH2hType(typeRaw)) return c.json({ error: 'type 只接受 horse 或 jockey' }, 400);
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
export { SITE_READER_HEADER, TG_READER_HEADER };
