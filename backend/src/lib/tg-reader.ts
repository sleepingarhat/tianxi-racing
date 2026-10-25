// TG 通知腳本專用唯讀憑證 + 匿名全日卡模式（ANON_FULL_CARD_MODE）。
//
// 背景：FEATURE_TIERS 規定訪客（未登入）只可以睇 cards.race1；reconcile.full（全日對帳）要 registered。
// 但現況 /api/analyze/today-picks 喺成個賽日完賽之後，對匿名請求回全部場次（公開投影）。
// 生產 TG 腳本（tools/tg_notify.py、tools/tg_race_cards.py）係匿名讀，所以唔可以直接收緊。
//
// 做法：
//   TG_READER_TOKEN（Worker secret，未設定 = 冇任何請求可以用呢條路）
//     - 只喺 header `X-TG-Reader-Token` 出示，常數時間比較（secretMatches）。
//     - 只影響 GET /api/analyze/today-picks：效果 = 「legacy 匿名視圖」——已完賽 → 公開投影（全部場次）；
//       未完賽 → 免費投影（第一場）。永遠唔係管理員：唔會令 hasAdminAccess 成立，唔解鎖 engine／fresh／venue，
//       唔會拎到原始 payload、管理員欄位，亦唔會寫任何嘢。
//     - 支援 TG_READER_TOKEN_PREVIOUS／TG_READER_TOKEN_NEXT 做零停機輪換。
//   ANON_FULL_CARD_MODE（Worker 變數）
//     - legacy（預設；未設定／打錯字都當 legacy）：同現況一模一樣。
//     - restricted：已完賽賽日，匿名請求只得第一場（免費投影）；
//       全部場次只派畀 TG 讀取憑證、已核實 Supabase 登入用戶（registered）或 Pro。
//   SITE_READER_TOKEN（Worker secret；網站伺服器函數用，header `X-Tianxi-Site-Token`）
//     - 權限同 TG_READER_TOKEN 完全一樣（唯讀、非管理員），只係分開一條，方便獨立輪換／撤銷。
//     - 永遠唔可以送去瀏覽器：只喺網站伺服器端（Lovable server function）出示。
// 密鑰值只喺記憶體比較，永遠唔會寫入回應或日誌。

import { secretMatches } from './shared-secret';
import { supabaseUserFromRequest } from './supabase-auth';
import { hasVerifiedProJwt } from './pro-gate';

export const TG_READER_HEADER = 'X-TG-Reader-Token';
export const SITE_READER_HEADER = 'X-Tianxi-Site-Token';
/** restricted 模式下，回應會因呢啲 request header 而異。 */
export const READER_VARY = 'Authorization, X-TG-Reader-Token, X-Tianxi-Site-Token, Origin';

export interface TgReaderEnv {
  TG_READER_TOKEN?: string;
  TG_READER_TOKEN_PREVIOUS?: string;
  TG_READER_TOKEN_NEXT?: string;
  ANON_FULL_CARD_MODE?: string;
  SITE_READER_TOKEN?: string;
  SITE_READER_TOKEN_PREVIOUS?: string;
  SITE_READER_TOKEN_NEXT?: string;
}

export type AnonFullCardMode = 'legacy' | 'restricted';

export function anonFullCardMode(env: TgReaderEnv | undefined): AnonFullCardMode {
  return (env?.ANON_FULL_CARD_MODE ?? '').trim().toLowerCase() === 'restricted' ? 'restricted' : 'legacy';
}

/** true = 請求出示咗有效 TG 讀取憑證。Worker 未設定 TG_READER_TOKEN 時永遠 false。 */
export async function hasTgReaderToken(c: { req: { header(name: string): string | undefined }; env: TgReaderEnv }): Promise<boolean> {
  const given = c.req.header(TG_READER_HEADER);
  if (!given) return false;
  const env = c.env ?? {};
  return secretMatches(given.trim(), [env.TG_READER_TOKEN, env.TG_READER_TOKEN_PREVIOUS, env.TG_READER_TOKEN_NEXT]);
}

/** true = 請求出示咗有效網站伺服器憑證。Worker 未設定 SITE_READER_TOKEN 時永遠 false。 */
export async function hasSiteReaderToken(c: { req: { header(name: string): string | undefined }; env: TgReaderEnv }): Promise<boolean> {
  const given = c.req.header(SITE_READER_HEADER);
  if (!given) return false;
  const env = c.env ?? {};
  return secretMatches(given.trim(), [env.SITE_READER_TOKEN, env.SITE_READER_TOKEN_PREVIOUS, env.SITE_READER_TOKEN_NEXT]);
}

/** 任何一條唯讀伺服器憑證（TG 或網站）。兩條權限相同，都唔係管理員。 */
export async function hasReaderCredential(c: { req: { header(name: string): string | undefined }; env: TgReaderEnv }): Promise<boolean> {
  return (await hasTgReaderToken(c)) || (await hasSiteReaderToken(c));
}

export type TodayPicksView = 'public' | 'free';

export interface TodayPicksViewInput {
  settled: boolean;
  mode: AnonFullCardMode;
  pro: () => Promise<boolean>;
  reader: () => Promise<boolean>;
  registered: () => Promise<boolean>;
}

/**
 * 非管理員 today-picks 視圖（純邏輯，方便測試）：
 *   Pro → public（全部場次）
 *   legacy：已完賽 → public；未完賽 → free（同現況）
 *   restricted：未完賽 → free；已完賽 → TG 憑證／registered 先 public，其餘匿名 → free（第一場）
 * TG 憑證永遠唔會超過 legacy 匿名視圖（未完賽都只係第一場）。
 */
export async function resolveTodayPicksView(input: TodayPicksViewInput): Promise<TodayPicksView> {
  if (input.settled) {
    if (input.mode === 'legacy') return 'public';
    if (await input.reader()) return 'public';
    if (await input.pro()) return 'public';
    if (await input.registered()) return 'public';
    return 'free';
  }
  return (await input.pro()) ? 'public' : 'free';
}

/** 已核實 Supabase 登入（任何會籍）。無 token／無效／未設定 Supabase 一律 false。 */
export async function hasVerifiedUserJwt(c: any): Promise<boolean> {
  try {
    return (await supabaseUserFromRequest(c)) !== null;
  } catch {
    return false;
  }
}

/**
 * Route 用：非管理員 today-picks 應該派邊個視圖。restricted 模式下回應會因憑證而異，
 * 所以加 Vary，並且非免費視圖一律 private, no-store（唔畀共享快取混派）。
 */
export async function todayPicksViewForRequest(c: any, settled: boolean): Promise<TodayPicksView> {
  const mode = anonFullCardMode(c.env);
  let reader = false;
  const view = await resolveTodayPicksView({
    settled,
    mode,
    pro: () => hasVerifiedProJwt(c),
    reader: async () => (reader = await hasReaderCredential(c)),
    registered: () => hasVerifiedUserJwt(c),
  });
  if (mode === 'restricted') {
    c.header('Vary', READER_VARY);
    if (reader || view === 'public') c.header('Cache-Control', 'private, no-store');
  }
  return view;
}
