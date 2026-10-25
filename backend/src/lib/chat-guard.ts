// /api/chat 濫用防護：必須登入（Supabase JWT）、D1 速率限制、輸入長度上限。
// 每次成功請求會觸發 2 次付費 AI 呼叫（意圖解析 + 回答），所以全部檢查都喺呼叫 AI 之前完成。

import type { ChatRequest } from '../types';
import { clientIp, consumeRateLimits, peekRateLimit, type RateRule } from './rate-limit';
import { supabaseUserFromRequest, type SupabaseUser } from './supabase-auth';

export const CHAT_LIMITS = {
  maxBodyBytes: 32 * 1024,
  maxMessageChars: 1000,
  maxHistoryTurns: 10,
  maxHistoryItemChars: 2000,
  maxHistoryTotalChars: 8000,
  perUser10Min: 10,
  perUserDay: 50,
  perIp10Min: 30,
  globalDay: 2000,
} as const;

export type ChatValidation =
  | { ok: true; value: Required<Pick<ChatRequest, 'message'>> & Omit<ChatRequest, 'message'> }
  | { ok: false; error: string };

export function validateChatBody(body: unknown): ChatValidation {
  if (!body || typeof body !== 'object') return { ok: false, error: '無效請求' };
  const b = body as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) return { ok: false, error: '請輸入問題' };
  if (message.length > CHAT_LIMITS.maxMessageChars) return { ok: false, error: `問題過長（上限 ${CHAT_LIMITS.maxMessageChars} 字）` };
  let raceDate: string | undefined;
  if (b.raceDate !== undefined && b.raceDate !== null && b.raceDate !== '') {
    if (typeof b.raceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.raceDate)) return { ok: false, error: 'raceDate 格式錯誤' };
    raceDate = b.raceDate;
  }
  let raceNumber: number | undefined;
  if (b.raceNumber !== undefined && b.raceNumber !== null && b.raceNumber !== '') {
    const n = Number(b.raceNumber);
    if (!Number.isInteger(n) || n < 1 || n > 14) return { ok: false, error: 'raceNumber 超出範圍' };
    raceNumber = n;
  }
  let conversationHistory: ChatRequest['conversationHistory'];
  if (b.conversationHistory !== undefined && b.conversationHistory !== null) {
    if (!Array.isArray(b.conversationHistory)) return { ok: false, error: 'conversationHistory 格式錯誤' };
    const recent = b.conversationHistory.slice(-CHAT_LIMITS.maxHistoryTurns);
    let total = 0;
    conversationHistory = [];
    for (const item of recent) {
      const role = (item as any)?.role;
      const content = (item as any)?.content;
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return { ok: false, error: 'conversationHistory 格式錯誤' };
      if (content.length > CHAT_LIMITS.maxHistoryItemChars) return { ok: false, error: `對話紀錄單條過長（上限 ${CHAT_LIMITS.maxHistoryItemChars} 字）` };
      total += content.length;
      conversationHistory.push({ role, content });
    }
    if (total > CHAT_LIMITS.maxHistoryTotalChars) return { ok: false, error: '對話紀錄過長，請開新對話' };
  }
  return { ok: true, value: { message, raceDate, raceNumber, conversationHistory } };
}

/** 個人／IP 限制：每個請求（包括之後被拒絕嘅）都計入自己嘅 bucket。 */
export function chatRateRules(user: SupabaseUser, ip: string): RateRule[] {
  return [
    { key: `chat:user:${user.userId}`, limit: CHAT_LIMITS.perUser10Min, windowSeconds: 600 },
    { key: `chat:user-day:${user.userId}`, limit: CHAT_LIMITS.perUserDay, windowSeconds: 86400 },
    { key: `chat:ip:${ip}`, limit: CHAT_LIMITS.perIp10Min, windowSeconds: 600 },
  ];
}

/**
 * 全站每日額度：只喺請求通過所有個人／IP 限制之後先「睇」，
 * 並且只喺上游 AI 成功回答之後先「扣」（commitChatGlobalQuota）。
 * 所以一個濫用者被個人限制拒絕嘅請求唔會令其他會員用唔到。
 */
export function chatGlobalRule(nowMs = Date.now()): RateRule {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return { key: `chat:global:${day}`, limit: CHAT_LIMITS.globalDay, windowSeconds: 86400 };
}

export async function commitChatGlobalQuota(db: D1Database, nowMs = Date.now()): Promise<void> {
  await consumeRateLimits(db, [chatGlobalRule(nowMs)], nowMs).catch(() => undefined);
}

export type ChatGuardResult =
  | { ok: true; user: SupabaseUser; body: Extract<ChatValidation, { ok: true }>['value'] }
  | { ok: false; status: 400 | 401 | 413 | 429 | 503; error: string; retryAfter?: number };

export async function guardChatRequest(c: any): Promise<ChatGuardResult> {
  if (String(c.env?.CHAT_DISABLED ?? '').trim() === '1') return { ok: false, status: 503, error: 'AI 對話暫停服務' };
  const user = await supabaseUserFromRequest(c);
  if (!user) return { ok: false, status: 401, error: '請先登入天喜會員再使用 AI 對話' };

  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > CHAT_LIMITS.maxBodyBytes) return { ok: false, status: 413, error: '請求過大' };
  let raw: string;
  try { raw = await c.req.text(); } catch { return { ok: false, status: 400, error: '無效請求' }; }
  if (new TextEncoder().encode(raw).length > CHAT_LIMITS.maxBodyBytes) return { ok: false, status: 413, error: '請求過大' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, status: 400, error: '無效 JSON' }; }
  const v = validateChatBody(parsed);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  // 1) 先個人／IP（會加一）；被拒絕就即刻返回，唔掂全站額度。
  const rl = await consumeRateLimits(c.env.DB, chatRateRules(user, clientIp(c)));
  if (!rl.ok) return { ok: false, status: 429, error: '使用過於頻繁，請稍後再試', retryAfter: rl.retryAfterSeconds };
  // 2) 再只讀檢查全站額度；真正扣減喺上游成功之後（routes/chat.ts）。
  const global = await peekRateLimit(c.env.DB, chatGlobalRule());
  if (!global.ok) return { ok: false, status: 429, error: 'AI 對話今日使用量已滿，請明日再試', retryAfter: global.retryAfterSeconds };
  return { ok: true, user, body: v.value };
}
