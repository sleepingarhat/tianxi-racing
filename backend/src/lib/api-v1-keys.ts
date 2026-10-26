/**
 * Public API v1 — API key auth (Bearer tx_live_…).
 * D1 stores SHA-256 hex only; plaintext shown once at create.
 * Rate limits: 60/min + 5000/day (suggested defaults; document on /developers).
 */

import { secretMatches } from './shared-secret';
import { hasReaderCredential, SITE_READER_HEADER } from './tg-reader';
import { consumeRateLimits } from './rate-limit';

export const API_V1_KEY_PREFIX = 'tx_live_';
export const API_V1_RATE_PER_MIN = 60;
export const API_V1_RATE_PER_DAY = 5000;
export const API_V1_DEFAULT_SCOPES = 'elo,picks,features' as const;

export const API_V1_DISCLAIMER =
  '天喜衍生數據・研究／非投注用途。未鎖今日預測不開放。馬會原始資料不作再分發。';

export const API_KEYS_DDL = `CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'elo,picks,features',
  entitlement_until TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  label TEXT
)`;

export const API_USAGE_DDL = `CREATE TABLE IF NOT EXISTS api_usage_daily (
  key_id TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, date)
)`;

export type ApiKeyRow = {
  id: string;
  key_prefix: string;
  key_hash: string;
  user_id: string;
  scopes: string;
  entitlement_until: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  label: string | null;
};

export type ApiKeyAuth =
  | { ok: true; key: ApiKeyRow; scopes: Set<string> }
  | { ok: false; status: 401 | 403 | 429; error: string; message: string; retryAfter?: number };

let tablesReady: Promise<void> | null = null;

export function resetApiV1TableCache(): void {
  tablesReady = null;
}

export async function ensureApiV1Tables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await db.prepare(API_KEYS_DDL).run();
      await db.prepare(API_USAGE_DDL).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`).run();
    })().catch((e) => {
      tablesReady = null;
      throw e;
    });
  }
  return tablesReady;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashApiKey(raw: string): Promise<string> {
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return toHex(dig);
}

/** Generate plaintext key + metadata. Caller persists hash only. */
export async function mintApiKey(): Promise<{
  plaintext: string;
  keyHash: string;
  keyPrefix: string;
  id: string;
}> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = toHex(bytes.buffer);
  const plaintext = `${API_V1_KEY_PREFIX}${body}`;
  const keyHash = await hashApiKey(plaintext);
  const id = crypto.randomUUID();
  const keyPrefix = plaintext.slice(0, 16);
  return { plaintext, keyHash, keyPrefix, id };
}

export function parseScopes(raw: string | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of String(raw ?? '').split(',')) {
    const s = part.trim().toLowerCase();
    if (s) set.add(s);
  }
  return set;
}

export function extractBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(\S+)/i.exec(authHeader.trim());
  return m?.[1] ?? null;
}

function hktDate(now = new Date()): string {
  // YYYY-MM-DD in Asia/Hong_Kong
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

export function isEntitlementActive(
  entitlementUntil: string | null | undefined,
  now = new Date(),
): boolean {
  if (entitlementUntil == null || entitlementUntil === '') return true; // null = open until revoked (admin-managed)
  const t = Date.parse(entitlementUntil);
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}

export async function authenticateApiKey(
  db: D1Database,
  authHeader: string | null | undefined,
  opts: { now?: Date; skipUsage?: boolean } = {},
): Promise<ApiKeyAuth> {
  const token = extractBearer(authHeader);
  if (!token || !token.startsWith(API_V1_KEY_PREFIX)) {
    return {
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: '需要 Authorization: Bearer tx_live_… API key',
    };
  }
  try {
    await ensureApiV1Tables(db);
  } catch {
    return { ok: false, status: 401, error: 'unauthorized', message: 'API key 服務未就緒' };
  }
  const keyHash = await hashApiKey(token);
  const row = await db
    .prepare(
      `SELECT id, key_prefix, key_hash, user_id, scopes, entitlement_until, revoked_at, last_used_at, created_at, label
       FROM api_keys WHERE key_hash = ? LIMIT 1`,
    )
    .bind(keyHash)
    .first<ApiKeyRow>();
  if (!row) {
    return { ok: false, status: 401, error: 'unauthorized', message: '無效 API key' };
  }
  if (row.revoked_at) {
    return { ok: false, status: 401, error: 'unauthorized', message: 'API key 已撤銷' };
  }
  const now = opts.now ?? new Date();
  if (!isEntitlementActive(row.entitlement_until, now)) {
    return {
      ok: false,
      status: 403,
      error: 'entitlement_expired',
      message: 'Pro 會籍已過期；請續訂後再呼叫 API（見 /membership）',
    };
  }

  if (!opts.skipUsage) {
    const rate = await consumeRateLimits(db, [
      { key: `apiv1:min:${row.id}`, limit: API_V1_RATE_PER_MIN, windowSeconds: 60 },
    ], now.getTime());
    if (!rate.ok) {
      return {
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: `超過每分鐘上限（${API_V1_RATE_PER_MIN}/min）`,
        retryAfter: rate.retryAfterSeconds ?? 60,
      };
    }
    const day = hktDate(now);
    const usage = await db
      .prepare(
        `INSERT INTO api_usage_daily (key_id, date, count) VALUES (?, ?, 1)
         ON CONFLICT(key_id, date) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(row.id, day)
      .first<{ count: number }>();
    const count = Number(usage?.count ?? Infinity);
    if (count > API_V1_RATE_PER_DAY) {
      return {
        ok: false,
        status: 429,
        error: 'quota_exceeded',
        message: `超過每日配額（${API_V1_RATE_PER_DAY}/day）`,
        retryAfter: 3600,
      };
    }
    await db
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .bind(now.toISOString(), row.id)
      .run()
      .catch(() => {});
  }

  return { ok: true, key: row, scopes: parseScopes(row.scopes) };
}

export function requireScope(
  scopes: Set<string>,
  need: string,
): { ok: true } | { ok: false; status: 403; error: string; message: string } {
  if (scopes.has(need) || scopes.has('*') || scopes.has('all')) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'scope_denied',
    message: `此 key 缺少 scope「${need}」`,
  };
}

/** Admin／網站 server：SITE_READER 或 ADMIN Bearer 可建立／撤銷 key。 */
export async function hasApiKeyAdminCredential(c: {
  req: { header: (n: string) => string | undefined };
  env: {
    SITE_READER_TOKEN?: string;
    SITE_READER_TOKEN_PREVIOUS?: string;
    SITE_READER_TOKEN_NEXT?: string;
    TG_READER_TOKEN?: string;
    TG_READER_TOKEN_PREVIOUS?: string;
    TG_READER_TOKEN_NEXT?: string;
    ADMIN_TOKEN?: string;
    ADMIN_TOKEN_2?: string;
  };
}): Promise<boolean> {
  if (await hasReaderCredential(c as any)) return true;
  const auth = c.req.header('Authorization');
  const bearer = extractBearer(auth);
  if (!bearer) return false;
  return secretMatches(bearer, [c.env.ADMIN_TOKEN, c.env.ADMIN_TOKEN_2]);
}

export { SITE_READER_HEADER, hktDate };
