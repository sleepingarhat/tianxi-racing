// Supabase 登入身份核實（Worker 端）。
//
// 天喜 Supabase 專案用非對稱簽名（ES256，JWKS 公開喺 /auth/v1/.well-known/jwks.json），
// 所以 Worker 只需要公開金鑰就可以離線核實 access token —— 唔需要任何 Supabase 密鑰。
// 亦支援 RS256（以防將來換 key 類型）。HS256（舊式共享密鑰）唔喺本地核實，改為交 Supabase /auth/v1/user 核實（需要 SUPABASE_PUBLISHABLE_KEY）。
//
// 核實項目：簽名、exp/nbf、iss = <SUPABASE_URL>/auth/v1、aud 含 authenticated、role = authenticated、sub 為 UUID。

import { presentedUserJwt } from './admin-auth';

export interface SupabaseAuthEnv {
  SUPABASE_URL?: string;
  /** 只用作 HS256（舊式）token 後備：交由 Supabase /auth/v1/user 核實。公開 key。 */
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export interface SupabaseUser {
  userId: string;
  email: string | null;
  exp: number;
  token: string;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MISS_COOLDOWN_MS = 60_000;
const CLOCK_SKEW_S = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const keyCache = new Map<string, CryptoKey>();

export function resetSupabaseAuthCache(): void {
  jwksCache.clear();
  keyCache.clear();
  authServerCache.clear();
}

function b64urlBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

export function supabaseBaseUrl(env: SupabaseAuthEnv): string | null {
  const raw = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(raw) ? raw : null;
}

/** 由 Authorization header 值取出「似 JWT」嘅 token；admin token 唔會誤當用戶。（測試／工具用） */
export function bearerJwt(header: string | undefined | null): string | null {
  return presentedUserJwt({ req: { header: () => header ?? undefined } });
}

async function loadJwks(base: string, fetchImpl: FetchLike, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(base);
  const now = Date.now();
  if (cached && (now - cached.fetchedAt < JWKS_TTL_MS) && !(force && now - cached.fetchedAt > JWKS_MISS_COOLDOWN_MS)) return cached.keys;
  const res = await fetchImpl(`${base}/auth/v1/.well-known/jwks.json`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('jwks unavailable');
  const body = await res.json() as { keys?: Jwk[] };
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(base, { keys, fetchedAt: now });
  return keys;
}

async function importKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
  const cacheKey = `${alg}:${jwk.kid ?? ''}:${jwk.x ?? jwk.n ?? ''}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const params = alg === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const { kid: _kid, alg: _alg, ...material } = jwk as any;
  const key = await crypto.subtle.importKey('jwk', material, params, false, ['verify']);
  keyCache.set(cacheKey, key);
  return key;
}

export async function verifySupabaseJwt(
  token: string,
  env: SupabaseAuthEnv,
  opts: { fetchImpl?: FetchLike; nowSeconds?: number } = {},
): Promise<SupabaseUser | null> {
  const base = supabaseBaseUrl(env);
  if (!base) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: any; let payload: any;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { return null; }
  const alg = header?.alg;
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  if (alg === 'HS256') return verifyViaAuthServer(token, payload, base, env, fetchImpl, opts.nowSeconds);
  if (alg !== 'ES256' && alg !== 'RS256') return null;

  let keys: Jwk[];
  try { keys = await loadJwks(base, fetchImpl, false); } catch { return null; }
  let jwk = keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === alg));
  if (!jwk) {
    try { keys = await loadJwks(base, fetchImpl, true); } catch { return null; }
    jwk = keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === alg));
  }
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await importKey(jwk, alg);
    const algo = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
    ok = await crypto.subtle.verify(algo, key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { ok = false; }
  if (!ok) return null;

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > now) return null;
  if (payload.iss !== `${base}/auth/v1`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes('authenticated')) return null;
  if (payload.role !== 'authenticated') return null;
  if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) return null;
  return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null, exp: payload.exp, token };
}

// HS256 後備：Worker 冇（亦唔應該有）共享 JWT 密鑰，所以交由 Supabase Auth 伺服器核實。
const authServerCache = new Map<string, { until: number; user: SupabaseUser }>();
async function verifyViaAuthServer(
  token: string, payload: any, base: string, env: SupabaseAuthEnv, fetchImpl: FetchLike, nowSeconds?: number,
): Promise<SupabaseUser | null> {
  const apikey = (env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!apikey) return null;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) return null;
  if (payload?.iss !== `${base}/auth/v1` || payload?.role !== 'authenticated') return null;
  const hit = authServerCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  try {
    const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey, authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!r.ok) return null;
    const u = await r.json() as any;
    if (typeof u?.id !== 'string' || !UUID_RE.test(u.id) || u.id !== payload.sub) return null;
    const user: SupabaseUser = { userId: u.id, email: typeof u.email === 'string' ? u.email : null, exp: payload.exp, token };
    authServerCache.set(token, { until: Date.now() + 60_000, user });
    if (authServerCache.size > 2000) authServerCache.delete(authServerCache.keys().next().value as string);
    return user;
  } catch { return null; }
}

/** 方便 route 用：由請求 header 核實用戶；無 token／無效一律回 null。 */
export async function supabaseUserFromRequest(
  c: { req: { header(name: string): string | undefined }; env: SupabaseAuthEnv },
  opts: { fetchImpl?: FetchLike; nowSeconds?: number } = {},
): Promise<SupabaseUser | null> {
  const token = presentedUserJwt(c);
  if (!token) return null;
  return verifySupabaseJwt(token, c.env, opts);
}
