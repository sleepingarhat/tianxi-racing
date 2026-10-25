// Pro 會籍判斷（Worker 端）—— 唯一真相來源喺 Supabase：rpc my_entitlement()。
//
// my_entitlement() 由 tianxi-web 新 migration（drizzle/migrations/0044_membership_entitlement_single_source.sql）提供，
// 網站（src/lib/tier.server.ts）同 Worker 都只係呼叫佢，唔再各自計：
//   - 付款環境：讀資料庫 app_settings.membership_payment_environment（唔再由 Worker／網站自己估）
//   - 規則：扣款失敗 → 訂閱 → crypto pass → 未開閘免費期 → 創始 52 週 → 無
//   - 管理員一律當 Pro（tier = 'pro'）
//
// 用「用戶自己嘅 JWT」經 PostgREST 呼叫（Worker 唔持有 service role）。
// 任何失敗（包括 migration 未套用、函數唔存在）→ fail closed（unverified，當非 Pro）。
// 結果每用戶喺 isolate 記憶體快取 60 秒。

import { supabaseBaseUrl, type SupabaseUser } from './supabase-auth';

export type EntitlementKind = 'free_stage' | 'founding' | 'founding_expired' | 'subscribed' | 'crypto_pass' | 'payment_failed' | 'none';
const KINDS: ReadonlySet<string> = new Set(['free_stage', 'founding', 'founding_expired', 'subscribed', 'crypto_pass', 'payment_failed', 'none']);

export interface ProEntitlementEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export interface ProStatus { hasPro: boolean; isAdmin: boolean; kind: EntitlementKind | 'admin' | 'unverified' }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; exp: number; status: ProStatus }>();
export function resetProEntitlementCache(): void { cache.clear(); }

/** 將 my_entitlement() 回應轉成 ProStatus；形狀唔啱一律 unverified。 */
export function parseEntitlement(raw: unknown): ProStatus {
  const unverified: ProStatus = { hasPro: false, isAdmin: false, kind: 'unverified' };
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null;
  if (!row || typeof row !== 'object') return unverified;
  const kind = String(row.kind ?? '');
  if (!KINDS.has(kind) || typeof row.has_pro !== 'boolean' || typeof row.is_admin !== 'boolean') return unverified;
  if (row.is_admin) return { hasPro: true, isAdmin: true, kind: 'admin' };
  return { hasPro: row.has_pro === true && row.tier === 'pro', isAdmin: false, kind: kind as EntitlementKind };
}

export async function loadProStatus(
  env: ProEntitlementEnv,
  user: SupabaseUser,
  opts: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<ProStatus> {
  const unverified: ProStatus = { hasPro: false, isAdmin: false, kind: 'unverified' };
  const base = supabaseBaseUrl(env);
  const apikey = (env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!base || !apikey) return unverified;
  const nowMs = (opts.now ?? new Date()).getTime();
  const hit = cache.get(user.userId);
  if (hit && nowMs - hit.at < CACHE_TTL_MS && hit.exp === user.exp) return hit.status;

  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  try {
    const r = await fetchImpl(`${base}/rest/v1/rpc/my_entitlement`, {
      method: 'POST',
      headers: { apikey, authorization: `Bearer ${user.token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) return unverified;
    const status = parseEntitlement(await r.json());
    if (status.kind === 'unverified') return unverified;
    cache.set(user.userId, { at: nowMs, exp: user.exp, status });
    if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
    return status;
  } catch {
    return unverified;
  }
}
