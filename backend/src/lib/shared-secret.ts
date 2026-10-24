// 共享密鑰（machine-to-machine）工具 —— 一個用途一個密鑰。
//
//   WATCH_FEED_SECRET  : Lovable（tianxi-web）→ Worker  GET /api/watch/events
//   ALERT_HOOK_SECRET  : Worker → tianxi-web  POST /api/public/telegram-alert
//   WEATHER_CRON_SECRET: 舊共用密鑰，只喺過渡期作後備（見下）。
//
// 每個密鑰都支援 *_PREVIOUS，輪換時可以先加新值、保留舊值，零停機。
// LEGACY_CRON_SECRET_FALLBACK=off 之後，WATCH feed 唔再接受 WEATHER_CRON_SECRET。
// 密鑰值只會喺記憶體比較，永遠唔會寫入回應或日誌。

export interface SharedSecretEnv {
  WEATHER_CRON_SECRET?: string;
  WATCH_FEED_SECRET?: string;
  WATCH_FEED_SECRET_PREVIOUS?: string;
  ALERT_HOOK_SECRET?: string;
  LEGACY_CRON_SECRET_FALLBACK?: string;
}

const enc = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

/** 常數時間比較：先 hash 成固定長度再逐 byte XOR，唔會因長度或前綴洩漏資訊。 */
export async function secretMatches(given: string | null | undefined, candidates: Array<string | undefined>): Promise<boolean> {
  const valid = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (!given || !valid.length) return false;
  const g = await digest(given);
  let ok = 0;
  for (const candidate of valid) {
    const d = await digest(candidate);
    let diff = 0;
    for (let i = 0; i < d.length; i++) diff |= d[i] ^ g[i];
    ok |= diff === 0 ? 1 : 0;
  }
  return ok === 1;
}

export function legacyFallbackEnabled(env: SharedSecretEnv): boolean {
  return (env.LEGACY_CRON_SECRET_FALLBACK ?? '').trim().toLowerCase() !== 'off';
}

/** WATCH feed 接受嘅密鑰清單（目前值 + 上一個值 + 過渡期舊共用密鑰）。 */
export function watchFeedSecrets(env: SharedSecretEnv): string[] {
  const out = [env.WATCH_FEED_SECRET, env.WATCH_FEED_SECRET_PREVIOUS];
  // 未設定專用密鑰時保持舊行為；設定咗之後，只有 fallback 未關先接受舊值。
  if (!env.WATCH_FEED_SECRET || legacyFallbackEnabled(env)) out.push(env.WEATHER_CRON_SECRET);
  return out.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Worker → 網站 telegram-alert 用嘅密鑰：優先專用 ALERT_HOOK_SECRET，未設定先用舊共用值。 */
export function alertHookSecret(env: SharedSecretEnv): string | undefined {
  return env.ALERT_HOOK_SECRET || env.WEATHER_CRON_SECRET || undefined;
}
