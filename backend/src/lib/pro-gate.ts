// Pro 權限閘（Worker 直接入口）。
//
// 現況（未改動）：未完賽場次對「非管理員」只回免費投影（today-picks 只得第一場；top-picks/explain
// 只容許第一場或已完賽場次）。網站伺服器用 TIANXI_ADMIN_TOKEN 讀全日，再喺網站端按會籍投影。
//
// 新增：PRO_ENTITLEMENT_MODE（Worker 變數，預設 off）
//   off     → 完全同現況一樣，Supabase JWT 一律忽略（零行為改動）。
//   on      → 帶有效 Supabase JWT 而且係 Pro（訂閱／首 200 創始／crypto pass／免費階段／管理員）
//             嘅用戶，可以直接喺 Worker 讀到全部場次嘅「公開欄位投影」（唔係管理員原始 payload）。
// 管理員專用參數（engine=v11、fresh、venue）仍然只限 ADMIN_TOKEN／admin session。

import { supabaseUserFromRequest } from './supabase-auth';
import { loadProStatus, type ProEntitlementEnv } from './pro-entitlement';

export interface ProGateEnv extends ProEntitlementEnv {
  PRO_ENTITLEMENT_MODE?: string;
}

export function proEntitlementEnabled(env: ProGateEnv | undefined): boolean {
  return (env?.PRO_ENTITLEMENT_MODE ?? '').trim().toLowerCase() === 'on';
}

const proCache = new WeakMap<object, Promise<boolean>>();

/** 回傳 true = 已核實 Pro 會員（JWT + 會籍）。旗標 off 時永遠 false，唔會發出任何 Supabase 請求。 */
export async function hasVerifiedProJwt(c: any): Promise<boolean> {
  if (!proEntitlementEnabled(c.env)) return false;
  // 同一個請求只查一次 Supabase。
  const key = c.req?.raw ?? c;
  const cached = proCache.get(key);
  if (cached) return cached;
  const pending = verifyPro(c);
  proCache.set(key, pending);
  return pending;
}

/**
 * poolodds.value（pro）：PRO_ENTITLEMENT_MODE=off → true（同現況一樣）；
 * on → 只有已核實 Pro（或管理員，由呼叫方處理）先派 marketRank／blendProb／value／valueEdge。
 */
export async function mayReadValueFields(c: any): Promise<boolean> {
  if (!proEntitlementEnabled(c.env)) return true;
  return hasVerifiedProJwt(c);
}

async function verifyPro(c: any): Promise<boolean> {
  const user = await supabaseUserFromRequest(c);
  if (!user) return false;
  const status = await loadProStatus(c.env, user);
  if (status.hasPro) {
    // 個人化回應：唔可以畀共享快取保存後派畀其他人。
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Authorization, Origin');
  }
  return status.hasPro;
}
