// 共享密鑰（machine-to-machine）工具 —— 一個用途一個密鑰。
//
//   WATCH_FEED_SECRET  : Lovable（tianxi-web）→ Worker  GET /api/watch/events 同 /api/notify/events（Worker 係接收方；通知事件 feed 沿用，唔另開 secret）
//   ALERT_HOOK_SECRET  : Worker → tianxi-web  POST /api/public/telegram-alert（Worker 係發送方）
//   WEATHER_CRON_SECRET: 舊共用密鑰，只喺「該用途未設定專用密鑰」時先作後備。
//
// 後備範圍（按用途）：
//   - 某用途一旦設定咗專用「目前值」（WATCH_FEED_SECRET／ALERT_HOOK_SECRET），
//     該用途就唔再接受／唔再發送 WEATHER_CRON_SECRET —— 唔使等 LEGACY_CRON_SECRET_FALLBACK=off。
//   - *_NEXT：預先放入嘅新值（接收方額外接受，但唔會停用舊共用值），用嚟零停機切換。
//   - *_PREVIOUS：輪換後仍接受嘅上一個值。
//   - LEGACY_CRON_SECRET_FALLBACK=off：全部用途一律唔用舊共用值（總開關）。
// 密鑰值只會喺記憶體比較，永遠唔會寫入回應或日誌。

export interface SharedSecretEnv {
  WEATHER_CRON_SECRET?: string;
  WATCH_FEED_SECRET?: string;
  WATCH_FEED_SECRET_PREVIOUS?: string;
  WATCH_FEED_SECRET_NEXT?: string;
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

const present = (v: string | undefined): v is string => typeof v === 'string' && v.length > 0;

/**
 * WATCH feed 接受嘅密鑰清單：目前值 + 上一個值 + 預備新值；
 * 舊共用 WEATHER_CRON_SECRET 只喺「WATCH_FEED_SECRET 未設定」而且總開關未關時先接受。
 */
export function watchFeedSecrets(env: SharedSecretEnv): string[] {
  const out = [env.WATCH_FEED_SECRET, env.WATCH_FEED_SECRET_PREVIOUS, env.WATCH_FEED_SECRET_NEXT];
  if (!present(env.WATCH_FEED_SECRET) && legacyFallbackEnabled(env)) out.push(env.WEATHER_CRON_SECRET);
  return out.filter(present);
}

/** Worker → 網站 telegram-alert 用嘅密鑰：有專用 ALERT_HOOK_SECRET 就只用佢；未設定而總開關未關先用舊共用值。 */
export function alertHookSecret(env: SharedSecretEnv): string | undefined {
  if (present(env.ALERT_HOOK_SECRET)) return env.ALERT_HOOK_SECRET;
  return legacyFallbackEnabled(env) && present(env.WEATHER_CRON_SECRET) ? env.WEATHER_CRON_SECRET : undefined;
}
