// 通知事件 feed（Pro P1 / 計劃 f6）— 唯讀。
//
// GET /api/notify/events?since=ISO8601[&types=lock_complete,top4_lock,daily_pnl][&limit=500]
//   header: x-cron-secret: <WATCH_FEED_SECRET（同愛駒 feed；或 _PREVIOUS／_NEXT；
//           只有 WATCH_FEED_SECRET 未設定時先接受 WEATHER_CRON_SECRET）>
//
// 用途：Lovable cron 拉新事件 → join Supabase prefs／愛駒 → 按 event_key 去重 → Telegram／Web Push。
// Worker 只存公開賽馬事件，唔知用戶。

import { Hono } from 'hono';
import type { Env } from '../types';
import { secretMatches, watchFeedSecrets } from '../lib/shared-secret';
import {
  NOTIFY_EVENT_TYPES,
  loadNotifyEvents,
  type NotifyEventType,
} from '../lib/notify-events';

const DATE_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.+-Z]+)?$/;
const MAX_SINCE_DAYS = 14;

function addDaysIso(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function parseNotifyQuery(params: URLSearchParams, now: Date = new Date()):
  { ok: true; since: string; types: NotifyEventType[]; limit: number } | { ok: false; error: string } {
  const minSince = addDaysIso(now, -MAX_SINCE_DAYS);
  let since = params.get('since') || addDaysIso(now, -2);
  if (!DATE_OR_ISO_RE.test(since) || Number.isNaN(Date.parse(since))) {
    return { ok: false, error: 'since 要係 YYYY-MM-DD 或 ISO8601' };
  }
  // 允許 date-only：當日 00:00Z
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) since = `${since}T00:00:00.000Z`;
  if (since < minSince) since = minSince;

  const typesParam = params.get('types');
  const types = typesParam
    ? [...new Set(typesParam.split(',').map((s) => s.trim()))].filter(
        (t): t is NotifyEventType => (NOTIFY_EVENT_TYPES as readonly string[]).includes(t),
      )
    : [...NOTIFY_EVENT_TYPES];
  if (!types.length) return { ok: false, error: 'types 只可以係 lock_complete,top4_lock,daily_pnl' };

  const limRaw = params.get('limit');
  let limit = 500;
  if (limRaw != null && limRaw !== '') {
    const n = Number(limRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return { ok: false, error: 'limit 要係 1–1000' };
    limit = n;
  }
  return { ok: true, since, types, limit };
}

export const notifyRoutes = new Hono<{ Bindings: Env }>();

notifyRoutes.get('/events', async (c) => {
  c.header('Cache-Control', 'no-store');
  const secrets = watchFeedSecrets(c.env);
  if (!secrets.length) return c.json({ error: 'notify feed disabled' }, 503);
  const given = c.req.header('x-cron-secret') || '';
  if (!(await secretMatches(given, secrets))) return c.json({ error: 'unauthorized' }, 401);

  const parsed = parseNotifyQuery(new URL(c.req.url).searchParams);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const events = await loadNotifyEvents(c.env.DB, parsed);
    return c.json({
      generatedAt: new Date().toISOString(),
      since: parsed.since,
      types: parsed.types,
      count: events.length,
      events,
      note: 'Worker 唔知用戶；去重同派送喺網站 job。top4_lock 只會喺 edition=final 寫入。',
    });
  } catch (e) {
    console.error('[notify/events] failed', String(e));
    return c.json({ error: 'notify feed unavailable' }, 503);
  }
});
