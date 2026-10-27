/**
 * Pro 研究室 API（/api/lab/*）。
 * 必須帶網站／服務唯讀 secret（X-Tianxi-Site-Token 或 X-TG-Reader-Token）；冇 → 401。
 * 會籍閘喺網站 serverFn（requireTier('pro')）；Worker 只驗 machine secret。
 * 含 h2h / search / going / weather。
 * 已下架（410 Gone）：/backtest、/compare*、/pace*、/pace-forecast*。
 * 彩池優化器（/pools*）喺 lab-pools，同樣 410。
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

import {
  GOING_DISCLAIMER,
  HISTORY_SINCE,
  MIN_SAMPLE_RACES,
  PENDING_GOING,
  RESEARCH_LAYER_NOTE as RESEARCH_LAYER_NOTE_GOING,
  buildDrawHeatmap,
  buildStyleBias,
  buildSuitedHorses,
  normalizeGoingBucket,
  parseCourse,
  parseDistance,
  parseVenue,
  type FieldHorse,
  type HorseGoingStat,
  type RawGoingResult,
} from '../lib/lab-going';

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
    '自訂回測、策略比較器、走位／節奏預測同彩池優化器已下架。請改用研究室其他工具（頭對頭／場地）。',
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

/** GET /api/lab/going?venue=&course=&distance=&going=&meetingId= */
labRoutes.get('/going', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;

  const venue = parseVenue(c.req.query('venue'));
  if (!venue) {
    return c.json({ error: 'venue 必須係 ST 或 HV' }, 400);
  }
  const course = parseCourse(c.req.query('course'));
  const distance = parseDistance(c.req.query('distance'));
  const goingRaw = c.req.query('going')?.trim() || null;
  const goingBucket = normalizeGoingBucket(goingRaw);
  const meetingId = (c.req.query('meetingId') || '').trim() || null;

  const db = c.env.DB;
  if (!db) {
    return c.json({ error: 'database unavailable' }, 503);
  }

  const cacheKey = `lab:going:v1:${venue}:${course ?? ''}:${distance ?? ''}:${goingBucket ?? ''}:${meetingId ?? ''}`;

  return cachedJson({
    request: c.req.raw,
    key: cacheKey,
    waitUntil: (p) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        /* test stub may lack executionCtx */
      }
    },
    compute: async () => {
      let effectiveGoing = goingBucket;
      let goingStatus: 'ok' | 'pending' | 'fallback' = goingBucket ? 'ok' : 'pending';
      let fallbackGoing: string | null = null;

      if (!effectiveGoing) {
        const last = await db
          .prepare(
            `SELECT r.going
             FROM races r
             JOIN race_meetings rm ON rm.id = r.meeting_id
             WHERE rm.venue = ?
               AND r.going IS NOT NULL
               AND TRIM(r.going) != ''
               AND r.going != ?
             ORDER BY rm.date DESC, r.race_number DESC
             LIMIT 1`,
          )
          .bind(venue, PENDING_GOING)
          .first<{ going: string }>()
          .catch(() => null);
        fallbackGoing = last?.going ? normalizeGoingBucket(last.going) : null;
        effectiveGoing = fallbackGoing;
        goingStatus = fallbackGoing ? 'fallback' : 'pending';
      }

      const clauses: string[] = [
        'rm.date >= ?',
        'rm.venue = ?',
        'rr.finishing_position IS NOT NULL',
        'rr.finishing_position >= 1',
        'rr.finishing_position < 90',
        'rr.draw IS NOT NULL',
        'rr.draw BETWEEN 1 AND 14',
      ];
      const binds: unknown[] = [HISTORY_SINCE, venue];

      if (course) {
        clauses.push('r.course = ?');
        binds.push(course);
      }
      if (distance != null) {
        clauses.push('r.distance = ?');
        binds.push(distance);
      }
      if (effectiveGoing) {
        clauses.push('r.going IS NOT NULL');
      }

      const where = clauses.join(' AND ');
      const sql =
        `SELECT rr.draw AS draw,
               r.distance AS distance,
               rr.finishing_position AS finishing_position,
               rr.running_position AS running_position,
               rr.horse_id AS horse_id,
               r.id AS race_id,
               r.going AS going,
               (SELECT COUNT(*) FROM race_results rr2 WHERE rr2.race_id = r.id) AS field_size
        FROM race_results rr
        JOIN races r ON r.id = rr.race_id
        JOIN race_meetings rm ON rm.id = r.meeting_id
        WHERE ` + where;

      const { results } = await db
        .prepare(sql)
        .bind(...binds)
        .all<any>()
        .catch(() => ({ results: [] as any[] }));

      const filtered: RawGoingResult[] = [];
      for (const row of results ?? []) {
        if (effectiveGoing) {
          const bucket = normalizeGoingBucket(row.going);
          if (bucket !== effectiveGoing) continue;
        }
        filtered.push({
          draw: row.draw == null ? null : Number(row.draw),
          distance: row.distance == null ? null : Number(row.distance),
          finishingPosition:
            row.finishing_position == null ? null : Number(row.finishing_position),
          runningPosition: row.running_position ?? null,
          horseId: String(row.horse_id ?? ''),
          raceId: String(row.race_id ?? ''),
          fieldSize: row.field_size == null ? null : Number(row.field_size),
        });
      }

      const heatmap = buildDrawHeatmap(filtered, { minSample: MIN_SAMPLE_RACES });
      const styleBias = buildStyleBias(filtered, { minSample: MIN_SAMPLE_RACES });

      let suited: ReturnType<typeof buildSuitedHorses> = [];
      let suitedNote: string | null = null;
      if (meetingId && effectiveGoing) {
        const fieldRows = await db
          .prepare(
            `SELECT rr.horse_id, rr.horse_number, rr.draw, h.name_ch, h.name_en
             FROM race_results rr
             JOIN horses h ON h.id = rr.horse_id
             JOIN races r ON r.id = rr.race_id
             WHERE r.meeting_id = ?
             ORDER BY r.race_number ASC, rr.horse_number ASC`,
          )
          .bind(meetingId)
          .all<any>()
          .catch(() => ({ results: [] as any[] }));

        let field: FieldHorse[] = (fieldRows.results ?? []).map((r) => ({
          horseId: String(r.horse_id),
          horseNumber: r.horse_number == null ? null : Number(r.horse_number),
          nameCh: r.name_ch ?? null,
          nameEn: r.name_en ?? null,
          draw: r.draw == null ? null : Number(r.draw),
        }));

        if (field.length === 0) {
          const meetMeta = await db
            .prepare(`SELECT date, venue FROM race_meetings WHERE id = ? LIMIT 1`)
            .bind(meetingId)
            .first<{ date: string; venue: string }>()
            .catch(() => null);
          if (meetMeta) {
            const ent = await db
              .prepare(
                `SELECT e.horse_id, e.horse_number, e.draw, h.name_ch, h.name_en
                 FROM entries_upcoming e
                 LEFT JOIN horses h ON h.id = e.horse_id
                 WHERE e.race_date = ? AND e.venue = ?
                   AND e.horse_id IS NOT NULL
                 ORDER BY e.race_number ASC, e.horse_number ASC`,
              )
              .bind(meetMeta.date, meetMeta.venue)
              .all<any>()
              .catch(() => ({ results: [] as any[] }));
            field = (ent.results ?? []).map((r) => ({
              horseId: String(r.horse_id),
              horseNumber: r.horse_number == null ? null : Number(r.horse_number),
              nameCh: r.name_ch ?? null,
              nameEn: r.name_en ?? null,
              draw: r.draw == null ? null : Number(r.draw),
            }));
          }
        }

        const horseIds = [...new Set(field.map((f) => f.horseId))];
        if (horseIds.length > 0) {
          const placeholders = horseIds.map(() => '?').join(',');
          const histSql =
            `SELECT rr.horse_id AS horse_id,
                    r.going AS going,
                    rr.finishing_position AS finishing_position
             FROM race_results rr
             JOIN races r ON r.id = rr.race_id
             JOIN race_meetings rm ON rm.id = r.meeting_id
             WHERE rm.date >= ?
               AND rr.horse_id IN (` +
            placeholders +
            `)
               AND rr.finishing_position IS NOT NULL
               AND rr.finishing_position >= 1
               AND rr.finishing_position < 90`;
          const { results: hist } = await db
            .prepare(histSql)
            .bind(HISTORY_SINCE, ...horseIds)
            .all<any>()
            .catch(() => ({ results: [] as any[] }));

          const statsMap = new Map<string, HorseGoingStat>();
          for (const id of horseIds) {
            statsMap.set(id, {
              horseId: id,
              goingStarts: 0,
              goingTop3: 0,
              overallStarts: 0,
              overallTop3: 0,
            });
          }
          for (const row of hist ?? []) {
            const id = String(row.horse_id);
            const s = statsMap.get(id);
            if (!s) continue;
            const pos = Number(row.finishing_position);
            s.overallStarts += 1;
            if (pos <= 3) s.overallTop3 += 1;
            if (normalizeGoingBucket(row.going) === effectiveGoing) {
              s.goingStarts += 1;
              if (pos <= 3) s.goingTop3 += 1;
            }
          }
          suited = buildSuitedHorses(field, [...statsMap.values()]);
        } else {
          suitedNote = '此賽日尚未有出賽名單';
        }
      } else if (!meetingId) {
        suitedNote = '提供 meetingId 可生成「今日合地」研究名單';
      } else {
        suitedNote = '地況待公佈，暫未能計合地名單';
      }

      const payload = {
        filters: {
          venue,
          course,
          distance,
          goingRequested: goingRaw,
          goingEffective: effectiveGoing,
          goingStatus,
          fallbackGoing,
          since: HISTORY_SINCE,
          meetingId,
        },
        heatmap,
        styleBias,
        suited,
        suitedNote,
        notes: {
          disclaimer: GOING_DISCLAIMER,
          research: RESEARCH_LAYER_NOTE_GOING,
          pendingGoing: goingStatus !== 'ok' ? PENDING_GOING : null,
          sparseRule: `樣本少於 ${MIN_SAMPLE_RACES} 場嘅格呈灰色`,
        },
        metaGeneratedAt: new Date().toISOString(),
        layer: 'research' as const,
        source: 'on_demand' as const,
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

/** GET /api/lab/weather/:meetingId — 快照序列（D1 weather_snapshots；冇表／冇資料 → 空陣列＋會議地況） */
labRoutes.get('/weather/:meetingId', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;

  const meetingId = String(c.req.param('meetingId') || '').trim();
  if (!meetingId || meetingId.length > 64) {
    return c.json({ error: 'meetingId 唔啱' }, 400);
  }

  const db = c.env.DB;
  if (!db) {
    return c.json({ error: 'database unavailable' }, 503);
  }

  const meeting = await db
    .prepare(
      `SELECT id, date, venue, track_condition, weather, total_races
       FROM race_meetings WHERE id = ? LIMIT 1`,
    )
    .bind(meetingId)
    .first<any>()
    .catch(() => null);

  if (!meeting) {
    return c.json({ error: 'not_found', message: '搵唔到該賽日' }, 404);
  }

  const goingPending =
    !meeting.track_condition ||
    String(meeting.track_condition).trim() === '' ||
    String(meeting.track_condition).trim() === PENDING_GOING;

  let lastSameVenueGoing: string | null = null;
  if (goingPending) {
    const last = await db
      .prepare(
        `SELECT track_condition FROM race_meetings
         WHERE venue = ? AND id != ?
           AND track_condition IS NOT NULL
           AND TRIM(track_condition) != ''
           AND track_condition != ?
         ORDER BY date DESC LIMIT 1`,
      )
      .bind(meeting.venue, meetingId, PENDING_GOING)
      .first<{ track_condition: string }>()
      .catch(() => null);
    lastSameVenueGoing = last?.track_condition
      ? normalizeGoingBucket(last.track_condition)
      : null;
  }

  let snapshots: any[] = [];
  let weatherError: string | null = null;
  try {
    const { results } = await db
      .prepare(
        `SELECT meeting_id, ts, temp, rh, rain_mm, wind_dir, wind_kmh, soil_moisture, source
         FROM weather_snapshots
         WHERE meeting_id = ?
         ORDER BY ts ASC`,
      )
      .bind(meetingId)
      .all<any>();
    snapshots = (results ?? []).map((r) => ({
      meetingId: r.meeting_id,
      ts: r.ts,
      temp: r.temp == null ? null : Number(r.temp),
      rh: r.rh == null ? null : Number(r.rh),
      rainMm: r.rain_mm == null ? null : Number(r.rain_mm),
      windDir: r.wind_dir ?? null,
      windKmh: r.wind_kmh == null ? null : Number(r.wind_kmh),
      soilMoisture: r.soil_moisture == null ? null : Number(r.soil_moisture),
      source: r.source ?? null,
    }));
  } catch {
    weatherError = '天氣快照表尚未就緒；只顯示歷史地況統計';
    snapshots = [];
  }

  const payload = {
    meetingId,
    meeting: {
      date: meeting.date,
      venue: meeting.venue,
      trackCondition: meeting.track_condition ?? null,
      weather: meeting.weather ?? null,
      totalRaces: meeting.total_races ?? null,
      goingStatus: goingPending ? ('pending' as const) : ('ok' as const),
      goingDisplay: goingPending ? PENDING_GOING : meeting.track_condition,
      lastSameVenueGoing,
    },
    snapshots,
    weatherError,
    notes: {
      disclaimer: GOING_DISCLAIMER,
      research: RESEARCH_LAYER_NOTE_GOING,
      liveHint:
        '即時天氣可經網站公開 /api/public/hkjc-weather；失敗時只顯示歷史',
    },
    metaGeneratedAt: new Date().toISOString(),
    layer: 'research' as const,
  };

  c.header('Cache-Control', CACHE_CONTROL);
  c.header('Vary', READER_VARY);
  return c.json(payload);
});

export { SITE_READER_HEADER, TG_READER_HEADER };
