// 愛駒追蹤（horse watchlist）事件 feed — 唯讀。
//
// GET /api/watch/events?horse_ids=horse_J062,horse_H117&since=2026-10-20[&types=entry,trackwork,trial,injury][&trackwork=gallop|all]
//   header: x-cron-secret: <WATCH_FEED_SECRET（或 _PREVIOUS／_NEXT；只有 WATCH_FEED_SECRET 未設定時先接受 WEATHER_CRON_SECRET）>
//
// 用途：Lovable 嘅 cron job（/api/public/jobs/horse-watch）每隔一段時間讀取所有會員
// 追蹤緊嘅馬匹，叫呢個 endpoint 攞新事件，再喺 Supabase 去重（watch_notifications）
// 之後發 Telegram DM / Web Push。用戶身份同追蹤清單全部喺 Supabase，Worker 唔知
// 邊個追蹤邊匹馬；呢度只回傳公開賽馬資料。
//
// 去重注意：ingest upsert 每次都會重設 ingested_at，所以唔可以用 ingested_at
// 判斷「新」事件。每個事件都有穩定嘅 event_key（基於事件本身日期 + 來源行 id），
// 由接收方用 event_key 去重。`since` 只按「事件日期」過濾（排位用賽日 ≥ 今日）。
//
// 數據時效（2026-10-23 實測）：晨操 / 傷患每日 04:00 HKT 抓取、05:17 HKT 同步入 D1，
// 而馬會本身晨操頁亦有延遲，實際落後約 1–3 日；試閘每日 02:00 HKT；排位表賽前約
// 2–3 日（排位表公佈後當晚 20:43 HKT 同步）。即係「每日批次提示」，唔係即時。

import { Hono } from 'hono';
import type { Env } from '../types';
import { secretMatches, watchFeedSecrets } from '../lib/shared-secret';

export type WatchEventType = 'entry' | 'trackwork' | 'trial' | 'injury';
export const WATCH_EVENT_TYPES: readonly WatchEventType[] = ['entry', 'trackwork', 'trial', 'injury'];

// D1 每條 query 最多 100 個 bound parameters；trackwork query 另加 4 個。
export const MAX_HORSE_IDS = 90;
export const MAX_SINCE_DAYS = 14;
const HORSE_ID_RE = /^horse_[A-Z]{1,2}\d{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 「快操」級別嘅晨操先值得通知；踱步 / 游水 幾乎每日都有，太嘈。 */
export const GALLOP_WORK_TYPES = ['快操', '試閘', '出賽'];

export interface WatchEvent {
  event_key: string;
  type: WatchEventType;
  horse_id: string;
  event_date: string;
  title: string;
  detail: Record<string, unknown>;
}

export interface WatchQuery {
  horseIds: string[];
  since: string;
  today: string;
  types: WatchEventType[];
  trackworkMode: 'gallop' | 'all';
}

export function hkToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function parseWatchQuery(params: URLSearchParams, now: Date = new Date()):
  { ok: true; query: WatchQuery } | { ok: false; error: string } {
  const today = hkToday(now);
  const raw = (params.get('horse_ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const horseIds = [...new Set(raw)];
  if (!horseIds.length) return { ok: false, error: 'horse_ids 必填（以逗號分隔，例如 horse_J062）' };
  if (horseIds.length > MAX_HORSE_IDS) return { ok: false, error: `horse_ids 最多 ${MAX_HORSE_IDS} 個，請分批` };
  const bad = horseIds.find((id) => !HORSE_ID_RE.test(id));
  if (bad) return { ok: false, error: `horse_id 格式唔啱：${bad.slice(0, 40)}` };

  const minSince = addDays(today, -MAX_SINCE_DAYS);
  let since = params.get('since') || addDays(today, -2);
  if (!DATE_RE.test(since) || Number.isNaN(Date.parse(since))) return { ok: false, error: 'since 要係 YYYY-MM-DD' };
  if (since < minSince) since = minSince;

  const typesParam = params.get('types');
  const types = typesParam
    ? [...new Set(typesParam.split(',').map((s) => s.trim()))].filter((t): t is WatchEventType => (WATCH_EVENT_TYPES as readonly string[]).includes(t))
    : [...WATCH_EVENT_TYPES];
  if (!types.length) return { ok: false, error: 'types 只可以係 entry,trackwork,trial,injury' };

  const trackworkMode = params.get('trackwork') === 'all' ? 'all' : 'gallop';
  return { ok: true, query: { horseIds, since, today, types, trackworkMode } };
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

type Row = Record<string, unknown>;

export async function loadWatchEvents(db: D1Database, q: WatchQuery): Promise<WatchEvent[]> {
  const ids = q.horseIds;
  const ph = placeholders(ids.length);
  const events: WatchEvent[] = [];
  const tasks: Promise<void>[] = [];

  if (q.types.includes('entry')) {
    tasks.push(db.prepare(`
      SELECT id, race_date, venue, race_number, horse_id, horse_number, draw, jockey_name,
             trainer_name, actual_weight, rating, priority_order, race_class, distance
      FROM entries_upcoming
      WHERE horse_id IN (${ph}) AND race_date >= ? AND race_number > 0
      ORDER BY race_date, race_number, horse_number
    `).bind(...ids, q.today).all<Row>().then(({ results }) => {
      for (const r of results || []) {
        const priority = s(r.priority_order) || '正選';
        const reserve = priority !== '正選';
        events.push({
          event_key: `entry:${r.race_date}:${r.venue}:${r.race_number}:${r.horse_id}:${reserve ? 'R' : 'D'}`,
          type: 'entry',
          horse_id: String(r.horse_id),
          event_date: String(r.race_date),
          title: reserve ? '列入後備' : '已排位出賽',
          detail: {
            venue: r.venue, raceNumber: r.race_number, horseNumber: r.horse_number, draw: r.draw,
            jockey: r.jockey_name, trainer: r.trainer_name, weight: r.actual_weight, rating: r.rating,
            priority, raceClass: r.race_class, distance: r.distance,
          },
        });
      }
    }));
  }

  if (q.types.includes('trackwork')) {
    const gallopOnly = q.trackworkMode === 'gallop';
    tasks.push(db.prepare(`
      SELECT id, horse_id, trackwork_date, venue, work_type, track, distance, time_text, splits,
             rider, partner, comment, gear, details
      FROM horse_trackwork
      WHERE horse_id IN (${ph}) AND trackwork_date >= ?
        ${gallopOnly ? `AND work_type IN (${placeholders(GALLOP_WORK_TYPES.length)})` : ''}
      ORDER BY trackwork_date
    `).bind(...ids, q.since, ...(gallopOnly ? GALLOP_WORK_TYPES : [])).all<Row>().then(({ results }) => {
      for (const r of results || []) {
        events.push({
          event_key: `trackwork:${r.id}`,
          type: 'trackwork',
          horse_id: String(r.horse_id),
          event_date: String(r.trackwork_date),
          title: `晨操：${s(r.work_type) || '操練'}`,
          detail: {
            venue: r.venue, workType: r.work_type, track: r.track, distance: r.distance, time: r.time_text,
            splits: r.splits, rider: r.rider, partner: r.partner, comment: r.comment, gear: r.gear, details: r.details,
          },
        });
      }
    }));
  }

  if (q.types.includes('trial')) {
    tasks.push(db.prepare(`
      SELECT tr.id, tr.horse_id, tr.finishing_position, tr.time_text, tr.jockey_name, tr.lbw, tr.gear, tr.comment,
             ts.trial_date, ts.venue, ts.session_number, ts.distance, ts.going, ts.track, ts.total_runners
      FROM trial_runners tr
      JOIN trial_sessions ts ON ts.id = tr.session_id
      WHERE tr.horse_id IN (${ph}) AND ts.trial_date >= ?
      ORDER BY ts.trial_date
    `).bind(...ids, q.since).all<Row>().then(({ results }) => {
      for (const r of results || []) {
        events.push({
          event_key: `trial:${r.id}`,
          type: 'trial',
          horse_id: String(r.horse_id),
          event_date: String(r.trial_date),
          title: '試閘',
          detail: {
            venue: r.venue, session: r.session_number, distance: r.distance, going: r.going, track: r.track,
            position: r.finishing_position, runners: r.total_runners, time: r.time_text, jockey: r.jockey_name,
            lbw: r.lbw, gear: r.gear, comment: r.comment,
          },
        });
      }
    }));
  }

  if (q.types.includes('injury')) {
    tasks.push(db.prepare(`
      SELECT id, horse_id, injury_date, injury_type, resolution_date, description
      FROM horse_injury
      WHERE horse_id IN (${ph}) AND (injury_date >= ? OR resolution_date >= ?)
      ORDER BY injury_date
    `).bind(...ids, q.since, q.since).all<Row>().then(({ results }) => {
      for (const r of results || []) {
        const resolvedRecently = !!r.resolution_date && String(r.resolution_date) >= q.since;
        const newInjury = String(r.injury_date) >= q.since;
        // 同一條紀錄：新傷患 一個 key；之後「已康復／已通過檢驗」再一個 key。
        if (newInjury) {
          events.push({
            event_key: `injury:${r.id}:open`,
            type: 'injury', horse_id: String(r.horse_id), event_date: String(r.injury_date),
            title: '新傷患／獸醫紀錄',
            detail: { injuryType: r.injury_type, description: r.description, resolutionDate: r.resolution_date },
          });
        }
        if (resolvedRecently) {
          events.push({
            event_key: `injury:${r.id}:resolved`,
            type: 'injury', horse_id: String(r.horse_id), event_date: String(r.resolution_date),
            title: '傷患紀錄更新：已通過／已解除',
            detail: { injuryType: r.injury_type, injuryDate: r.injury_date, description: r.description, resolutionDate: r.resolution_date },
          });
        }
      }
    }));
  }

  await Promise.all(tasks);
  events.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.event_key.localeCompare(b.event_key));
  return events;
}

async function freshness(db: D1Database): Promise<Record<string, string | null>> {
  const one = (sql: string) => db.prepare(sql).first<{ v: string | null }>().then((r) => r?.v ?? null).catch(() => null);
  const [entries, trackwork, trial, injury] = await Promise.all([
    one('SELECT MAX(scraped_at) AS v FROM entries_upcoming'),
    one('SELECT MAX(trackwork_date) AS v FROM horse_trackwork'),
    one('SELECT MAX(trial_date) AS v FROM trial_sessions'),
    one('SELECT MAX(injury_date) AS v FROM horse_injury'),
  ]);
  return { entriesScrapedAt: entries, latestTrackworkDate: trackwork, latestTrialDate: trial, latestInjuryDate: injury };
}

export const watchRoutes = new Hono<{ Bindings: Env }>();

watchRoutes.get('/events', async (c) => {
  c.header('Cache-Control', 'no-store');
  const secrets = watchFeedSecrets(c.env);
  if (!secrets.length) return c.json({ error: 'watch feed disabled' }, 503);
  const given = c.req.header('x-cron-secret') || '';
  if (!(await secretMatches(given, secrets))) return c.json({ error: 'unauthorized' }, 401);

  const parsed = parseWatchQuery(new URL(c.req.url).searchParams);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const [events, fresh] = await Promise.all([loadWatchEvents(c.env.DB, parsed.query), freshness(c.env.DB)]);
    return c.json({
      generatedAt: new Date().toISOString(),
      since: parsed.query.since,
      today: parsed.query.today,
      types: parsed.query.types,
      trackworkMode: parsed.query.trackworkMode,
      freshness: fresh,
      freshnessNote: '晨操／傷患／試閘為每日批次同步（約落後 1–3 日）；排位於馬會公佈排位表後當晚同步。非即時。',
      count: events.length,
      events,
    });
  } catch (e) {
    console.error('[watch/events] failed', String(e));
    return c.json({ error: 'watch feed unavailable' }, 503);
  }
});
