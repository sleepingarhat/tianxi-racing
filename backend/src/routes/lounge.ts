import { Hono } from 'hono';
import type { Env } from '../types';
import { clientIp, consumeRateLimits, type RateRule } from '../lib/rate-limit';
import { supabaseUserFromRequest, type SupabaseUser } from '../lib/supabase-auth';

export const loungeRoutes = new Hono<{ Bindings: Env }>();

// ---------- helpers ----------

function ulid(): string {
  // Simple ULID-like id (time-sortable, 26 chars).
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36)).join('');
  return (t + r).toUpperCase();
}

// Reject posts that look like HKJC bet-code shortcuts or are spammy URL dumps.
// Also reject obvious stake-advice phrases per constitutional platform scope.
const BET_CODE_RE = /\b[WPQTSFDCGHRKL]{1,2}[\s:\-]*\d{1,2}[\s,\-]+\d{1,2}\b/i;
const URL_RE = /https?:\/\/[^\s]+/gi;
const STAKE_RE = /(落|下注|買入|投注|買佢|買呢|買 ?\$)/;

export const LOUNGE_LIMITS = {
  maxBodyChars: 2000,
  maxTitleChars: 140,
  maxHandleChars: 24,
  maxUrls: 3,
  threadsPerUserHour: 5,
  threadsPerIpHour: 10,
  postsPerUserMinute: 5,
  postsPerUserHour: 30,
  postsPerIpHour: 60,
} as const;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;
const CATEGORIES = new Set(['race_day', 'horse_chat', 'general', 'jockey', 'analysis']);

export function rejectContent(body: unknown): string | null {
  if (typeof body !== 'string' || !body.trim()) return '內容不能為空';
  if (body.length > LOUNGE_LIMITS.maxBodyChars) return `內容過長（上限 ${LOUNGE_LIMITS.maxBodyChars} 字）`;
  if (CONTROL_RE.test(body)) return '內容包含無效字元';
  if (BET_CODE_RE.test(body)) return '請勿分享投注碼（天喜為分析平台，不提供投注服務）';
  const urls = body.match(URL_RE) ?? [];
  if (urls.length > LOUNGE_LIMITS.maxUrls) return `外部連結過多（上限 ${LOUNGE_LIMITS.maxUrls} 條）`;
  if (STAKE_RE.test(body)) return '請避免下注建議語句（用「睇好／分析／機率」代替）';
  return null;
}

export function rejectHandle(handle: unknown): string | null {
  if (typeof handle !== 'string' || !handle.trim()) return '請提供顯示名稱';
  if (handle.trim().length > LOUNGE_LIMITS.maxHandleChars) return `顯示名稱過長（上限 ${LOUNGE_LIMITS.maxHandleChars} 字）`;
  if (CONTROL_RE.test(handle) || /[\r\n\t]/.test(handle)) return '顯示名稱包含無效字元';
  return null;
}

export function rejectTitle(title: unknown): string | null {
  if (typeof title !== 'string' || !title.trim()) return '缺少 title';
  if (title.trim().length > LOUNGE_LIMITS.maxTitleChars) return `標題過長（上限 ${LOUNGE_LIMITS.maxTitleChars} 字）`;
  if (CONTROL_RE.test(title) || /[\r\n]/.test(title)) return '標題包含無效字元';
  return null;
}

/**
 * 發帖必須登入：Supabase JWT（Authorization: Bearer）。author_id 一律取自 JWT sub，
 * 唔再信任客戶端傳入嘅 authorId。速率限制用 D1（api_rate_limits），唔再依賴未綁定嘅 KV。
 */
async function requireLoungeWriter(
  c: any,
  kind: 'thread' | 'post',
): Promise<{ ok: true; user: SupabaseUser } | { ok: false; res: Response }> {
  const user = await supabaseUserFromRequest(c);
  if (!user) return { ok: false, res: c.json({ error: '請先登入天喜會員再發言' }, 401) };
  const ip = clientIp(c);
  const rules: RateRule[] = kind === 'thread'
    ? [
        { key: `lounge:thread:user:${user.userId}`, limit: LOUNGE_LIMITS.threadsPerUserHour, windowSeconds: 3600 },
        { key: `lounge:thread:ip:${ip}`, limit: LOUNGE_LIMITS.threadsPerIpHour, windowSeconds: 3600 },
      ]
    : [
        { key: `lounge:post:user-min:${user.userId}`, limit: LOUNGE_LIMITS.postsPerUserMinute, windowSeconds: 60 },
        { key: `lounge:post:user:${user.userId}`, limit: LOUNGE_LIMITS.postsPerUserHour, windowSeconds: 3600 },
        { key: `lounge:post:ip:${ip}`, limit: LOUNGE_LIMITS.postsPerIpHour, windowSeconds: 3600 },
      ];
  const rl = await consumeRateLimits(c.env.DB, rules);
  if (!rl.ok) {
    if (rl.retryAfterSeconds) c.header('Retry-After', String(rl.retryAfterSeconds));
    return { ok: false, res: c.json({ error: kind === 'thread' ? '速率限制：發主題過於頻繁，請稍後再試' : '速率限制：發言過於頻繁，請稍後再試' }, 429) };
  }
  return { ok: true, user };
}

// ---------- routes ----------

// GET /api/lounge/threads?category=&limit=20&offset=0
loungeRoutes.get('/threads', async (c) => {
  const category = c.req.query('category');
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);

  const where = category ? 'WHERE category = ?' : '';
  const binds: any[] = category ? [category] : [];

  const listStmt = c.env.DB.prepare(
    `SELECT id, title, category, race_date, horse_id, author_handle, reply_count,
            last_post_at, created_at, is_pinned, is_locked
     FROM lounge_threads
     ${where}
     ORDER BY is_pinned DESC, last_post_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset);

  const countStmt = c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lounge_threads ${where}`,
  ).bind(...binds);

  const [{ results }, total] = await Promise.all([
    listStmt.all(),
    countStmt.first<{ n: number }>(),
  ]);

  return c.json({
    threads: (results ?? []).map((r: any) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      raceDate: r.race_date,
      horseId: r.horse_id,
      authorHandle: r.author_handle,
      replyCount: r.reply_count,
      lastPostAt: r.last_post_at,
      createdAt: r.created_at,
      isPinned: !!r.is_pinned,
      isLocked: !!r.is_locked,
    })),
    total: total?.n ?? 0,
    limit,
    offset,
  });
});

// GET /api/lounge/threads/:id
loungeRoutes.get('/threads/:id', async (c) => {
  const id = c.req.param('id');
  const thread = await c.env.DB.prepare(
    `SELECT * FROM lounge_threads WHERE id = ?`,
  ).bind(id).first<any>();
  if (!thread) return c.json({ error: '主題不存在' }, 404);

  const { results: posts } = await c.env.DB.prepare(
    `SELECT id, body, author_handle, author_id, created_at
     FROM lounge_posts
     WHERE thread_id = ? AND is_hidden = 0
     ORDER BY created_at ASC
     LIMIT 500`,
  ).bind(id).all();

  return c.json({
    thread: {
      id: thread.id,
      title: thread.title,
      category: thread.category,
      raceDate: thread.race_date,
      horseId: thread.horse_id,
      authorHandle: thread.author_handle,
      replyCount: thread.reply_count,
      lastPostAt: thread.last_post_at,
      createdAt: thread.created_at,
      isPinned: !!thread.is_pinned,
      isLocked: !!thread.is_locked,
    },
    posts: (posts ?? []).map((p: any) => ({
      id: p.id,
      body: p.body,
      authorHandle: p.author_handle,
      authorId: p.author_id,
      createdAt: p.created_at,
    })),
  });
});

// POST /api/lounge/threads
loungeRoutes.post('/threads', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: '無效 JSON' }, 400); }

  const { title, category, body: postBody, authorHandle, raceDate, horseId } = body ?? {};
  const tErr = rejectTitle(title);
  if (tErr) return c.json({ error: tErr }, 400);
  const hErr = rejectHandle(authorHandle);
  if (hErr) return c.json({ error: hErr }, 400);
  const cErr = rejectContent(postBody);
  if (cErr) return c.json({ error: cErr }, 400);
  if (category != null && !CATEGORIES.has(category)) return c.json({ error: '無效分類' }, 400);
  if (raceDate != null && (typeof raceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate))) return c.json({ error: 'raceDate 格式錯誤' }, 400);
  if (horseId != null && (typeof horseId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(horseId))) return c.json({ error: 'horseId 格式錯誤' }, 400);

  const auth = await requireLoungeWriter(c, 'thread');
  if (!auth.ok) return auth.res;
  const authorId = auth.user.userId;

  const threadId = ulid();
  const postId = ulid();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lounge_threads (id, title, category, race_date, horse_id, author_handle, author_id, reply_count, last_post_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
    ).bind(threadId, title.trim(), category ?? 'general', raceDate ?? null, horseId ?? null, authorHandle.trim(), authorId),
    c.env.DB.prepare(
      `INSERT INTO lounge_posts (id, thread_id, body, author_handle, author_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(postId, threadId, postBody, authorHandle.trim(), authorId),
  ]);

  return c.json({ threadId, postId });
});

// ---------- Single global chatroom (simplified UX) ----------
// Uses a fixed thread id so existing schema is reused without migration.
const GLOBAL_ROOM_ID = 'GLOBAL_CHATROOM_0000000001';

async function ensureGlobalRoom(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO lounge_threads
       (id, title, category, author_handle, author_id, reply_count, last_post_at)
     VALUES (?, '馬圈聊天室', 'general', '系統', 'system', 0, datetime('now'))`,
  ).bind(GLOBAL_ROOM_ID).run();
}

// GET /api/lounge/chat?since=<iso>&limit=100
loungeRoutes.get('/chat', async (c) => {
  await ensureGlobalRoom(c.env);
  const since = c.req.query('since');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 200);

  const stmt = since
    ? c.env.DB.prepare(
        `SELECT id, body, author_handle, author_id, created_at
         FROM lounge_posts
         WHERE thread_id = ? AND is_hidden = 0 AND created_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      ).bind(GLOBAL_ROOM_ID, since, limit)
    : c.env.DB.prepare(
        `SELECT id, body, author_handle, author_id, created_at
         FROM lounge_posts
         WHERE thread_id = ? AND is_hidden = 0
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(GLOBAL_ROOM_ID, limit);

  const { results } = await stmt.all();
  const posts = (results ?? []).map((p: any) => ({
    id: p.id,
    body: p.body,
    authorHandle: p.author_handle,
    authorId: p.author_id,
    createdAt: p.created_at,
  }));
  // When not using `since`, we fetched newest first — flip back to chronological.
  if (!since) posts.reverse();

  return c.json({ posts, roomId: GLOBAL_ROOM_ID });
});

// POST /api/lounge/chat
loungeRoutes.post('/chat', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: '無效 JSON' }, 400); }

  const { body: postBody, authorHandle } = body ?? {};
  const hErr = rejectHandle(authorHandle);
  if (hErr) return c.json({ error: hErr }, 400);
  const cErr = rejectContent(postBody);
  if (cErr) return c.json({ error: cErr }, 400);

  const auth = await requireLoungeWriter(c, 'post');
  if (!auth.ok) return auth.res;
  const authorId = auth.user.userId;

  await ensureGlobalRoom(c.env);
  const postId = ulid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lounge_posts (id, thread_id, body, author_handle, author_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(postId, GLOBAL_ROOM_ID, postBody, authorHandle.trim(), authorId),
    c.env.DB.prepare(
      `UPDATE lounge_threads SET reply_count = reply_count + 1, last_post_at = datetime('now')
       WHERE id = ?`,
    ).bind(GLOBAL_ROOM_ID),
  ]);

  return c.json({ postId });
});

// POST /api/lounge/threads/:id/posts
loungeRoutes.post('/threads/:id/posts', async (c) => {
  const threadId = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: '無效 JSON' }, 400); }

  const { body: postBody, authorHandle } = body ?? {};

  const hErr = rejectHandle(authorHandle);
  if (hErr) return c.json({ error: hErr }, 400);
  const cErr = rejectContent(postBody);
  if (cErr) return c.json({ error: cErr }, 400);

  const thread = await c.env.DB.prepare(
    `SELECT id, is_locked FROM lounge_threads WHERE id = ?`,
  ).bind(threadId).first<any>();
  if (!thread) return c.json({ error: '主題不存在' }, 404);
  if (thread.is_locked) return c.json({ error: '主題已鎖定' }, 403);

  const auth = await requireLoungeWriter(c, 'post');
  if (!auth.ok) return auth.res;
  const authorId = auth.user.userId;

  const postId = ulid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lounge_posts (id, thread_id, body, author_handle, author_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(postId, threadId, postBody, authorHandle.trim(), authorId),
    c.env.DB.prepare(
      `UPDATE lounge_threads SET reply_count = reply_count + 1, last_post_at = datetime('now')
       WHERE id = ?`,
    ).bind(threadId),
  ]);

  return c.json({ postId });
});
