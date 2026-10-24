// Pro 會籍判斷（Worker 端）—— 鏡像 tianxi-web 嘅 src/lib/entitlement.ts + src/lib/tier.server.ts。
//
// 資料來源（全部用「用戶自己嘅 JWT」經 Supabase PostgREST 讀，受 RLS 保護，Worker 唔持有 service role）：
//   rpc my_membership()                → rank / total / gate_open_at / threshold / founding_slots
//   subscriptions（最新一筆，按 environment） → Stripe 訂閱
//   rpc crypto_pass_until(uid, env)    → 加密貨幣通行證
//   rpc has_role(uid, 'admin')         → 管理員一律當 Pro
//
// 規則同網站一致：未開閘（free stage）註冊會員享 Pro；開閘後首 founding_slots 名 52 週；
// 訂閱 active/trialing（或已取消但未到期）；扣款失敗即時停權；有效 crypto pass。
// 任何查詢失敗 → fail closed（當非 Pro）。結果每用戶喺 isolate 記憶體快取 60 秒。

import { supabaseBaseUrl, type SupabaseUser } from './supabase-auth';

export const DEFAULT_PAYWALL_THRESHOLD = 200;
export const FOUNDING_SLOTS = DEFAULT_PAYWALL_THRESHOLD;
export const FOUNDING_PRO_WEEKS = 52;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type SubRow = { status: string; current_period_end: string | null; cancel_at_period_end: boolean };

export type MembershipInput = {
  rank: number | null;
  total: number;
  gateOpenAt: string | null;
  subscription: SubRow | null;
  threshold?: number;
  foundingSlots?: number;
  cryptoPassUntil?: string | null;
  now?: Date;
};

export type EntitlementKind = 'free_stage' | 'founding' | 'founding_expired' | 'subscribed' | 'crypto_pass' | 'payment_failed' | 'none';

export function resolveEntitlement(input: MembershipInput): { kind: EntitlementKind; hasPro: boolean } {
  const now = input.now ?? new Date();
  const foundingSlots = input.foundingSlots ?? FOUNDING_SLOTS;
  const sub = input.subscription;
  if (sub && ['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'].includes(sub.status)) {
    return { kind: 'payment_failed', hasPro: false };
  }
  if (sub) {
    const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
    const future = !end || end > now;
    if ((sub.status === 'active' || sub.status === 'trialing') && future) return { kind: 'subscribed', hasPro: true };
    if (sub.status === 'canceled' && end && end > now) return { kind: 'subscribed', hasPro: true };
  }
  if (input.cryptoPassUntil && new Date(input.cryptoPassUntil) > now) return { kind: 'crypto_pass', hasPro: true };
  if (!input.gateOpenAt) return { kind: 'free_stage', hasPro: true };
  if (input.rank !== null && input.rank <= foundingSlots) {
    const until = new Date(new Date(input.gateOpenAt).getTime() + FOUNDING_PRO_WEEKS * WEEK_MS);
    if (until > now) return { kind: 'founding', hasPro: true };
    if (!sub) return { kind: 'founding_expired', hasPro: false };
  }
  return { kind: 'none', hasPro: false };
}

export interface ProEntitlementEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** 'live' | 'sandbox'，要同網站 VITE_PAYMENTS_CLIENT_TOKEN（pk_live_ → live）一致。預設 live。 */
  PAYMENTS_ENVIRONMENT?: string;
}

export interface ProStatus { hasPro: boolean; isAdmin: boolean; kind: EntitlementKind | 'admin' | 'unverified' }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; exp: number; status: ProStatus }>();
export function resetProEntitlementCache(): void { cache.clear(); }

export async function loadProStatus(
  env: ProEntitlementEnv,
  user: SupabaseUser,
  opts: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<ProStatus> {
  const unverified: ProStatus = { hasPro: false, isAdmin: false, kind: 'unverified' };
  const base = supabaseBaseUrl(env);
  const apikey = (env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!base || !apikey) return unverified;
  const hit = cache.get(user.userId);
  const nowMs = (opts.now ?? new Date()).getTime();
  if (hit && nowMs - hit.at < CACHE_TTL_MS && hit.exp === user.exp) return hit.status;

  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const environment = env.PAYMENTS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
  const headers = { apikey, authorization: `Bearer ${user.token}`, accept: 'application/json', 'content-type': 'application/json' };
  const rpc = async (name: string, body: unknown) => {
    const r = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`rpc ${name} ${r.status}`);
    return r.json();
  };
  try {
    const subUrl = `${base}/rest/v1/subscriptions?select=status,current_period_end,cancel_at_period_end`
      + `&user_id=eq.${encodeURIComponent(user.userId)}&environment=eq.${environment}&order=created_at.desc&limit=1`;
    const [membershipRaw, subRes, admin, cryptoPass] = await Promise.all([
      rpc('my_membership', {}),
      fetchImpl(subUrl, { headers }),
      rpc('has_role', { _user_id: user.userId, _role: 'admin' }),
      rpc('crypto_pass_until', { uid: user.userId, env: environment }),
    ]);
    if (!subRes.ok) throw new Error(`subscriptions ${subRes.status}`);
    const subs = await subRes.json() as SubRow[];
    const m = (Array.isArray(membershipRaw) ? membershipRaw[0] : membershipRaw) as any;
    if (!m || typeof m !== 'object') throw new Error('membership missing');
    let status: ProStatus;
    if (admin === true) status = { hasPro: true, isAdmin: true, kind: 'admin' };
    else {
      const e = resolveEntitlement({
        rank: m.rank ?? null, total: Number(m.total ?? 0), gateOpenAt: m.gate_open_at ?? null,
        threshold: m.threshold ?? undefined, foundingSlots: m.founding_slots ?? undefined,
        subscription: Array.isArray(subs) && subs[0] ? subs[0] : null,
        cryptoPassUntil: typeof cryptoPass === 'string' ? cryptoPass : null,
        now: opts.now,
      });
      status = { hasPro: e.hasPro, isAdmin: false, kind: e.kind };
    }
    cache.set(user.userId, { at: nowMs, exp: user.exp, status });
    if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
    return status;
  } catch {
    return unverified;
  }
}
