// D1 固定時間窗速率限制 —— 用 Worker 已綁定嘅 D1（DB），唔依賴未綁定嘅 KV。
//
// 每個 bucket（例如 chat:user:<uuid>）每個時間窗一行，用單一 UPSERT ... RETURNING 原子加一，
// 所以多個 isolate／colo 同時請求都計得準。舊時間窗由 cleanup 定期刪除（亦會順手清）。

export const RATE_LIMIT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
)`;
export const RATE_LIMIT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_api_rate_limits_expires ON api_rate_limits(expires_at)`;

export interface RateRule {
  /** bucket 名，例如 chat:ip:1.2.3.4 */
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateResult {
  ok: boolean;
  /** 第一個超出嘅規則（ok=false 時） */
  rule?: RateRule;
  retryAfterSeconds?: number;
}

let tableReady: Promise<void> | null = null;

export function resetRateLimitTableCache(): void { tableReady = null; }

async function ensureTable(db: D1Database): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.prepare(RATE_LIMIT_TABLE_SQL).run();
      await db.prepare(RATE_LIMIT_INDEX_SQL).run();
    })().catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

/**
 * 逐條規則加一並檢查。任何一條超出即回 ok=false。
 * D1 出錯時 fail closed（回 ok=false），因為呢啲 endpoint 會觸發付費 AI 或公開寫入。
 */
export async function consumeRateLimits(db: D1Database, rules: RateRule[], nowMs = Date.now()): Promise<RateResult> {
  try {
    await ensureTable(db);
    const now = Math.floor(nowMs / 1000);
    const stmts = rules.map((r) => {
      const windowStart = now - (now % r.windowSeconds);
      return db.prepare(
        `INSERT INTO api_rate_limits (bucket, window_start, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
         RETURNING count`,
      ).bind(r.key.slice(0, 200), windowStart, windowStart + r.windowSeconds);
    });
    const results = await db.batch(stmts);
    for (let i = 0; i < rules.length; i++) {
      const count = Number((results[i]?.results?.[0] as any)?.count ?? Infinity);
      if (count > rules[i].limit) {
        const r = rules[i];
        const windowStart = now - (now % r.windowSeconds);
        return { ok: false, rule: r, retryAfterSeconds: Math.max(1, windowStart + r.windowSeconds - now) };
      }
    }
    // 約 1% 機會順手清理過期時間窗
    if (Math.random() < 0.01) await db.prepare(`DELETE FROM api_rate_limits WHERE expires_at < ?`).bind(now).run().catch(() => {});
    return { ok: true };
  } catch (e) {
    console.warn('[rate-limit] storage error, failing closed');
    return { ok: false, retryAfterSeconds: 60 };
  }
}

/**
 * 只讀檢查：唔加一。用嚟喺「已通過個人／IP 限制」之後先睇全站額度，
 * 等被個人限制拒絕嘅請求唔會扣全站額度。D1 出錯時 fail closed。
 */
export async function peekRateLimit(db: D1Database, rule: RateRule, nowMs = Date.now()): Promise<RateResult> {
  try {
    await ensureTable(db);
    const now = Math.floor(nowMs / 1000);
    const windowStart = now - (now % rule.windowSeconds);
    const row = await db.prepare(`SELECT count FROM api_rate_limits WHERE bucket = ? AND window_start = ?`)
      .bind(rule.key.slice(0, 200), windowStart).first<{ count: number }>();
    const count = Number(row?.count ?? 0);
    if (count >= rule.limit) return { ok: false, rule, retryAfterSeconds: Math.max(1, windowStart + rule.windowSeconds - now) };
    return { ok: true };
  } catch {
    console.warn('[rate-limit] storage error, failing closed');
    return { ok: false, retryAfterSeconds: 60 };
  }
}

/** 讀取目前計數（測試／監察用）。 */
export async function rateLimitCount(db: D1Database, rule: RateRule, nowMs = Date.now()): Promise<number> {
  await ensureTable(db);
  const now = Math.floor(nowMs / 1000);
  const windowStart = now - (now % rule.windowSeconds);
  const row = await db.prepare(`SELECT count FROM api_rate_limits WHERE bucket = ? AND window_start = ?`)
    .bind(rule.key.slice(0, 200), windowStart).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function cleanupRateLimits(db: D1Database, nowMs = Date.now()): Promise<void> {
  await ensureTable(db).catch(() => {});
  await db.prepare(`DELETE FROM api_rate_limits WHERE expires_at < ?`).bind(Math.floor(nowMs / 1000)).run().catch(() => {});
}

export function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  // 喺 Cloudflare 上 cf-connecting-ip 由邊緣設定，客戶端無法偽造；其他 header 只作本機後備。
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown';
  return ip.trim().slice(0, 64);
}
