// /api/analyze/hit-rate 匿名範圍（ANON_HITRATE_MODE）。
//
// 背景：FEATURE_TIERS 規定 reconcile.full（全日逐場對帳）要 registered，訪客只有 cards.race1。
// 但現況 hit-rate 對匿名請求回每一場嘅凍結四揀（predictedTop4／predictedFifth）、命中旗標同箱形派彩。
//
// ANON_HITRATE_MODE（Worker 變數）
//   - legacy（預設；未設定／打錯字都當 legacy）：同現況一模一樣（projectHitRateForPublic）。
//   - restricted：非管理員請求按身份派：
//       唯讀伺服器憑證（X-TG-Reader-Token／X-Tianxi-Site-Token）、已核實 Supabase 登入（registered）、Pro
//         → 同現況一樣嘅公開投影（全部場次）
//       其餘匿名 → 彙總投影：全日 summary（命中數／命中率）＋第一場完整公開投影（同 cards.race1 一致）；
//         第二場起只留場次資料同 HKJC 公開賽果（冇四揀、冇第五揀、冇命中旗標、冇箱形派彩、冇模型標籤）。
// hit-rate-rollup 嘅公開投影本身已經只係彙總（projectHitRateRollupForPublic，冇任何四揀），唔受呢個旗標影響。
// 管理員分支（完整 payload、engine／refresh／alpha）完全唔變；唯讀憑證永遠唔會令 hasAdminAccess 成立。

import { projectHitRateForPublic } from './public-today-picks';
import { hasVerifiedProJwt } from './pro-gate';
import { hasReaderCredential, hasVerifiedUserJwt, READER_VARY } from './tg-reader';

export type AnonHitRateMode = 'legacy' | 'restricted';
export type HitRateView = 'public' | 'aggregate';

export function anonHitRateMode(env: { ANON_HITRATE_MODE?: string } | undefined): AnonHitRateMode {
  return (env?.ANON_HITRATE_MODE ?? '').trim().toLowerCase() === 'restricted' ? 'restricted' : 'legacy';
}

export interface HitRateViewInput {
  mode: AnonHitRateMode;
  reader: () => Promise<boolean>;
  pro: () => Promise<boolean>;
  registered: () => Promise<boolean>;
}

/** 純邏輯：legacy 一律 public（唔做任何憑證查詢）；restricted 要憑證／登入／Pro 先 public。 */
export async function resolveHitRateView(input: HitRateViewInput): Promise<HitRateView> {
  if (input.mode === 'legacy') return 'public';
  if (await input.reader()) return 'public';
  if (await input.pro()) return 'public';
  if (await input.registered()) return 'public';
  return 'aggregate';
}

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const RACE_META_KEYS = ['raceNumber', 'title', 'distance', 'going'] as const;
const ACTUAL_KEYS = ['position', 'horseNumber', 'nameCh', 'winOdds'] as const;

function copy(value: JsonRecord, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const k of keys) {
    const v = value[k];
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

/**
 * 匿名彙總投影（由公開投影再收窄，允許清單逐欄抄）。第一場 = 公開投影原樣；
 * 第二場起只有場次資料＋HKJC 公開賽果（賽果唔帶 hit，因為 hit 會反推我哋嘅四揀）。
 */
export function projectHitRateForAnonymous(value: unknown): JsonRecord {
  const pub = projectHitRateForPublic(value);
  const races = Array.isArray(pub.races) ? (pub.races as unknown[]).filter(isRecord) : [];
  const out: JsonRecord = { ...pub, access: 'aggregate' };
  out.races = races.map((race) => {
    if (race.raceNumber === 1) return race;
    const r = copy(race, RACE_META_KEYS);
    r.actualTop4 = Array.isArray(race.actualTop4)
      ? (race.actualTop4 as unknown[]).filter(isRecord).map((h) => copy(h, ACTUAL_KEYS))
      : [];
    r.redacted = true;
    return r;
  });
  return out;
}

/** Route 用：非管理員 hit-rate 回應。restricted 時加 Vary；非彙總視圖一律 private, no-store。 */
export async function hitRateBodyForNonAdmin(c: any, payload: unknown): Promise<JsonRecord> {
  const mode = anonHitRateMode(c.env);
  const view = await resolveHitRateView({
    mode,
    reader: () => hasReaderCredential(c),
    pro: () => hasVerifiedProJwt(c),
    registered: () => hasVerifiedUserJwt(c),
  });
  if (mode === 'restricted') {
    c.header('Vary', READER_VARY);
    if (view === 'public') c.header('Cache-Control', 'private, no-store');
  }
  return view === 'public' ? projectHitRateForPublic(payload) : projectHitRateForAnonymous(payload);
}
