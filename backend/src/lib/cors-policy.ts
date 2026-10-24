// CORS 白名單 —— 只容許天喜網站、Lovable 預覽／發佈網域同本機開發。
//
// 注意：CORS 只係瀏覽器層面嘅保護（阻止第三方網站喺用戶瀏覽器入面讀我哋嘅 API 回應），
// 唔會阻止伺服器對伺服器或 curl 請求；真正嘅權限檢查仍然喺各 route（admin / Pro / 速率限制）。
//
// 額外網域可以用 Worker 變數 CORS_EXTRA_ORIGINS（逗號分隔，完整 origin，例如 https://foo.example）。

import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

export const LOVABLE_PROJECT_ID = '8be5fecb-440e-4e5c-94dc-cbdc1f31edcd';

const EXACT_ORIGINS = new Set([
  'https://tianxi.racing',
  'https://www.tianxi.racing',
  // Lovable 發佈子網域（project slug）
  'https://mark-six-joy.lovable.app',
]);

const PATTERNS: RegExp[] = [
  // Lovable 預覽／發佈：id-preview--<id>.lovable.app、project--<id>-dev.lovable.app、<id>.lovableproject.com 等
  new RegExp(`^https://(?:[a-z0-9-]+--)?${LOVABLE_PROJECT_ID}(?:-dev)?\\.(?:lovable\\.app|lovableproject\\.com)$`),
  // 本機開發
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/,
];

export function parseExtraOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter((s) => /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(s)),
  );
}

export function isAllowedOrigin(origin: string | undefined | null, extraRaw?: string): boolean {
  if (!origin) return false;
  const o = origin.trim().toLowerCase();
  if (EXACT_ORIGINS.has(o)) return true;
  if (PATTERNS.some((re) => re.test(o))) return true;
  return parseExtraOrigins(extraRaw?.toLowerCase()).has(o);
}

export function corsPolicy(): MiddlewareHandler {
  return cors({
    origin: (origin, c) => (isAllowedOrigin(origin, (c.env as any)?.CORS_EXTRA_ORIGINS) ? origin : null),
    allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
    credentials: false,
  });
}
