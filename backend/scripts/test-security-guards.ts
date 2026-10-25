// 安全修補測試：Supabase JWT 核實、Pro 權限、D1 速率限制、/api/chat 防護、lounge 發帖登入。
// 所有金鑰都喺測試入面即時產生（唔會寫入任何檔案）。執行：bun scripts/test-security-guards.ts
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { bearerJwt, resetSupabaseAuthCache, verifySupabaseJwt } from '../src/lib/supabase-auth';
import { loadProStatus, parseEntitlement, resetProEntitlementCache } from '../src/lib/pro-entitlement';
import { consumeRateLimits, peekRateLimit, rateLimitCount, resetRateLimitTableCache } from '../src/lib/rate-limit';
import { CHAT_LIMITS, chatGlobalRule, chatRateRules, commitChatGlobalQuota, validateChatBody } from '../src/lib/chat-guard';
import { proEntitlementEnabled, hasVerifiedProJwt } from '../src/lib/pro-gate';
import { capMaxTokens } from '../src/services/ai';
import { loungeRoutes, LOUNGE_LIMITS } from '../src/routes/lounge';
import { chatRoutes } from '../src/routes/chat';

let failures = 0;
function check(name: string, cond: unknown) {
  if (cond) console.log(`ok - ${name}`);
  else { failures++; console.error(`FAIL - ${name}`); }
}

// ---------- D1 shim ----------
function makeDb() {
  const sqlite = new Database(':memory:');
  class Stmt {
    params: any[] = [];
    constructor(public sql: string) {}
    bind(...p: any[]) { this.params = p; return this; }
    async all() { return { results: sqlite.query(this.sql).all(...this.params) }; }
    async first() { return sqlite.query(this.sql).get(...this.params) ?? null; }
    async run() { sqlite.query(this.sql).run(...this.params); return { success: true }; }
  }
  return {
    sqlite,
    prepare: (sql: string) => new Stmt(sql),
    batch: async (stmts: Stmt[]) => {
      const out: any[] = [];
      sqlite.exec('BEGIN');
      try { for (const s of stmts) out.push(await s.all()); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
      return out;
    },
  } as any;
}

// ---------- JWT helpers ----------
const BASE = 'https://testref.supabase.co';
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const otherKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' };
const USER = '11111111-2222-4333-8444-555555555555';
const now = Math.floor(Date.now() / 1000);
async function sign(payload: Record<string, unknown>, key = kp.privateKey, kid = 'k1') {
  const h = enc({ alg: 'ES256', typ: 'JWT', kid });
  const p = enc(payload);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}
const claims = (o: Record<string, unknown> = {}) => ({ sub: USER, iss: `${BASE}/auth/v1`, aud: 'authenticated', role: 'authenticated', exp: now + 600, email: 'a@b.c', ...o });

let jwksCalls = 0;
// my_entitlement() 回應（模擬 Supabase 唯一真相來源）
let ent: any = { kind: 'free_stage', has_pro: true, is_admin: false, tier: 'pro' };
let entCalls = 0;
const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const u = String(url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/auth/v1/.well-known/jwks.json')) { jwksCalls++; return json({ keys: [pubJwk] }); }
  if (u.endsWith('/rest/v1/rpc/my_entitlement')) { entCalls++; return json(ent); }
  if (u.endsWith('/auth/v1/user')) return json({ id: USER, email: 'a@b.c' });
  return json({ error: 'unexpected ' + u }, 500);
};
(globalThis as any).fetch = fakeFetch;
const env = { SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'public-test-key' };

// ---------- supabase-auth ----------
const good = await sign(claims());
check('valid ES256 token verifies', (await verifySupabaseJwt(good, env))?.userId === USER);
check('expired token rejected', (await verifySupabaseJwt(await sign(claims({ exp: now - 120 })), env)) === null);
check('wrong issuer rejected', (await verifySupabaseJwt(await sign(claims({ iss: 'https://evil.supabase.co/auth/v1' })), env)) === null);
check('wrong audience rejected', (await verifySupabaseJwt(await sign(claims({ aud: 'other' })), env)) === null);
check('anon role rejected', (await verifySupabaseJwt(await sign(claims({ role: 'anon' })), env)) === null);
check('non-uuid sub rejected', (await verifySupabaseJwt(await sign(claims({ sub: 'x' })), env)) === null);
check('wrong signing key rejected', (await verifySupabaseJwt(await sign(claims(), otherKp.privateKey), env)) === null);
const [h, p, s] = good.split('.');
check('tampered payload rejected', (await verifySupabaseJwt(`${h}.${enc(claims({ sub: '99999999-2222-4333-8444-555555555555' }))}.${s}`, env)) === null);
check('alg none rejected', (await verifySupabaseJwt(`${enc({ alg: 'none', kid: 'k1' })}.${p}.`, env)) === null);
const callsBefore = jwksCalls;
await verifySupabaseJwt(await sign(claims(), kp.privateKey, 'unknown-kid'), env);
await verifySupabaseJwt(await sign(claims(), kp.privateKey, 'unknown-kid'), env);
check('unknown kid refetch is rate-limited (cooldown)', jwksCalls - callsBefore <= 1);
check('missing SUPABASE_URL fails closed', (await verifySupabaseJwt(good, {})) === null);
check('non-supabase URL rejected', (await verifySupabaseJwt(good, { SUPABASE_URL: 'https://evil.example.com' })) === null);
check('admin token is not treated as JWT', bearerJwt('Bearer tx_admin_abcdef0123456789') === null);
check('bearerJwt extracts JWT', bearerJwt(`Bearer ${good}`) === good);
const hsTok = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims())}.sig`;
check('HS256 token verified via auth server fallback', (await verifySupabaseJwt(hsTok, env))?.userId === USER);
check('HS256 without publishable key fails closed', (await verifySupabaseJwt(hsTok, { SUPABASE_URL: BASE })) === null);

// ---------- entitlement（只讀 Supabase rpc my_entitlement，唔再喺 Worker 重複計） ----------
check('parse: admin → pro', parseEntitlement({ kind: 'none', has_pro: false, is_admin: true, tier: 'pro' }).kind === 'admin');
check('parse: founding → pro', parseEntitlement({ kind: 'founding', has_pro: true, is_admin: false, tier: 'pro' }).hasPro);
check('parse: none → not pro', !parseEntitlement({ kind: 'none', has_pro: false, is_admin: false, tier: 'registered' }).hasPro);
check('parse: unknown kind → unverified', parseEntitlement({ kind: 'weird', has_pro: true, is_admin: false, tier: 'pro' }).kind === 'unverified');
check('parse: missing fields → unverified', parseEntitlement({ kind: 'founding' }).kind === 'unverified');
check('parse: array row accepted', parseEntitlement([{ kind: 'subscribed', has_pro: true, is_admin: false, tier: 'pro' }]).kind === 'subscribed');

const user = (await verifySupabaseJwt(good, env))!;
resetProEntitlementCache();
ent = { kind: 'none', has_pro: false, is_admin: false, tier: 'registered' };
check('loadProStatus: rpc none → not pro', !(await loadProStatus(env, user)).hasPro);
resetProEntitlementCache();
ent = { kind: 'none', has_pro: false, is_admin: true, tier: 'pro' };
check('loadProStatus: admin → pro', (await loadProStatus(env, user)).kind === 'admin');
resetProEntitlementCache();
ent = { kind: 'subscribed', has_pro: true, is_admin: false, tier: 'pro' };
check('loadProStatus: subscriber → pro', (await loadProStatus(env, user)).kind === 'subscribed');
const before = entCalls; await loadProStatus(env, user);
check('loadProStatus: cached 60s', entCalls === before);
resetProEntitlementCache();
check('loadProStatus: rpc missing (404) fails closed', (await loadProStatus(env, user, { fetchImpl: async () => new Response('{"code":"PGRST202"}', { status: 404 }) })).kind === 'unverified');
resetProEntitlementCache();
check('loadProStatus: PostgREST failure fails closed', (await loadProStatus(env, user, { fetchImpl: async () => new Response('x', { status: 500 }) })).kind === 'unverified');
check('loadProStatus: no publishable key → unverified', (await loadProStatus({ SUPABASE_URL: BASE }, user)).kind === 'unverified');
ent = { kind: 'free_stage', has_pro: true, is_admin: false, tier: 'pro' };
resetProEntitlementCache();

// ---------- pro gate flag ----------
check('PRO_ENTITLEMENT_MODE default off', !proEntitlementEnabled({}) && !proEntitlementEnabled({ PRO_ENTITLEMENT_MODE: 'off' }));
check('PRO_ENTITLEMENT_MODE on', proEntitlementEnabled({ PRO_ENTITLEMENT_MODE: 'on' }));
const fakeCtx = (e: any, auth?: string) => ({ env: e, req: { header: (n: string) => (n.toLowerCase() === 'authorization' ? auth : undefined) }, header: () => {} });
check('gate off ignores valid pro JWT', !(await hasVerifiedProJwt(fakeCtx({ ...env }, `Bearer ${good}`))));
resetProEntitlementCache();
check('gate on accepts pro JWT', await hasVerifiedProJwt(fakeCtx({ ...env, PRO_ENTITLEMENT_MODE: 'on' }, `Bearer ${good}`)));
check('gate on rejects missing JWT', !(await hasVerifiedProJwt(fakeCtx({ ...env, PRO_ENTITLEMENT_MODE: 'on' }))));

// ---------- max tokens ----------
check('capMaxTokens default 1500', capMaxTokens({}, 3000) === 1500);
check('capMaxTokens respects lower request', capMaxTokens({}, 500) === 500);
check('capMaxTokens env cannot exceed ceiling', capMaxTokens({ AI_MAX_TOKENS: '99999' }, 99999) === 3000);

// ---------- rate limit ----------
{
  const db = makeDb(); resetRateLimitTableCache();
  const rule = { key: 't:1', limit: 3, windowSeconds: 60 };
  const r = [] as boolean[];
  for (let i = 0; i < 5; i++) r.push((await consumeRateLimits(db, [rule], 1_000_000)).ok);
  check('rate limit allows up to limit then blocks', JSON.stringify(r) === JSON.stringify([true, true, true, false, false]));
  check('rate limit resets next window', (await consumeRateLimits(db, [rule], 1_000_000 + 60_000)).ok);
  const broken = { prepare: () => { throw new Error('d1 down'); }, batch: async () => { throw new Error('d1 down'); } } as any;
  resetRateLimitTableCache();
  check('rate limit fails closed on storage error', !(await consumeRateLimits(broken, [rule])).ok);
  resetRateLimitTableCache();
}

// ---------- chat validation ----------
check('chat: empty message rejected', !validateChatBody({ message: '  ' }).ok);
check('chat: long message rejected', !validateChatBody({ message: 'x'.repeat(CHAT_LIMITS.maxMessageChars + 1) }).ok);
check('chat: bad role rejected', !validateChatBody({ message: 'hi', conversationHistory: [{ role: 'system', content: 'x' }] }).ok);
check('chat: long history item rejected', !validateChatBody({ message: 'hi', conversationHistory: [{ role: 'user', content: 'x'.repeat(CHAT_LIMITS.maxHistoryItemChars + 1) }] }).ok);
check('chat: bad raceNumber rejected', !validateChatBody({ message: 'hi', raceNumber: 99 }).ok);
const okBody = validateChatBody({ message: 'R3 點睇？', raceDate: '2026-10-25', raceNumber: 3, conversationHistory: Array.from({ length: 20 }, () => ({ role: 'user', content: 'a' })) });
check('chat: valid body accepted, history trimmed to 10', okBody.ok && okBody.value.conversationHistory!.length === 10);

{
  const db = makeDb(); resetRateLimitTableCache();
  const app = new Hono<any>(); app.route('/api/chat', chatRoutes);
  const cenv = { ...env, DB: db };
  const post = (body: unknown, auth?: string) => app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }, cenv);
  check('chat: unauthenticated → 401', (await post({ message: 'hi' })).status === 401);
  check('chat: admin-style bearer is not a session → 401', (await post({ message: 'hi' }, 'Bearer not-a-jwt')).status === 401);
  check('chat: oversize message → 400', (await post({ message: 'x'.repeat(5000) }, `Bearer ${good}`)).status === 400);
  const big = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${good}` }, body: JSON.stringify({ message: 'x', pad: 'y'.repeat(40_000) }) }, cenv);
  check('chat: oversize body → 413', big.status === 413);
  check('chat: disabled flag → 503', (await app.request('/api/chat', { method: 'POST', body: '{}' }, { ...cenv, CHAT_DISABLED: '1' })).status === 503);
  // 用已滿嘅 bucket 驗證 429（唔會呼叫 AI）
  const minute = Math.floor(Date.now() / 1000);
  db.sqlite.exec(`CREATE TABLE IF NOT EXISTS api_rate_limits (bucket TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (bucket, window_start))`);
  db.sqlite.query('INSERT INTO api_rate_limits VALUES (?, ?, ?, ?)').run(`chat:user:${USER}`, minute - (minute % 600), 999, minute + 600);
  const limited = await post({ message: 'hi' }, `Bearer ${good}`);
  check('chat: over per-user limit → 429 with Retry-After', limited.status === 429 && !!limited.headers.get('retry-after'));
  // 被個人限制拒絕嘅請求唔可以扣全站額度
  const g = chatGlobalRule();
  check('chat: per-user 429 does not touch global quota', (await rateLimitCount(db, g)) === 0);
  for (let i = 0; i < 3; i++) await post({ message: 'hi' }, `Bearer ${good}`);
  check('chat: repeated rejected requests leave global quota at 0', (await rateLimitCount(db, g)) === 0);
  // 全站額度用完 → 429（個人未超）
  db.sqlite.query('DELETE FROM api_rate_limits').run();
  const day = Math.floor(Date.now() / 1000); 
  db.sqlite.query('INSERT INTO api_rate_limits VALUES (?, ?, ?, ?)').run(g.key, day - (day % 86400), CHAT_LIMITS.globalDay, day + 86400);
  const gl = await post({ message: 'hi' }, `Bearer ${good}`);
  check('chat: exhausted global quota → 429', gl.status === 429);
  check('chat: global-exhausted rejection does not increment global', (await rateLimitCount(db, g)) === CHAT_LIMITS.globalDay);
  resetRateLimitTableCache();
}

// ---------- global quota 只喺上游成功後先扣 ----------
{
  const db = makeDb(); resetRateLimitTableCache();
  const t = 1_700_000_000_000;
  const g = chatGlobalRule(t);
  const u = { userId: USER, token: 'x', exp: 0 } as any;
  check('chat rules: per-user/ip rules exclude global', chatRateRules(u, '1.1.1.1').every((r) => !r.key.startsWith('chat:global:')));
  check('global peek is read-only', (await peekRateLimit(db, g, t)).ok && (await rateLimitCount(db, g, t)) === 0);
  await commitChatGlobalQuota(db, t);
  check('global commit increments by 1', (await rateLimitCount(db, g, t)) === 1);
  const broken = { prepare: () => { throw new Error('x'); }, batch: async () => { throw new Error('x'); } } as any;
  resetRateLimitTableCache();
  check('global peek fails closed on storage error', !(await peekRateLimit(broken, g, t)).ok);
  resetRateLimitTableCache();
  resetRateLimitTableCache();
}

// ---------- lounge ----------
{
  const db = makeDb(); resetRateLimitTableCache();
  db.sqlite.exec(await Bun.file(new URL('../src/db/schema_lounge.sql', import.meta.url)).text());
  const app = new Hono<any>(); app.route('/api/lounge', loungeRoutes);
  const lenv = { ...env, DB: db };
  const post = (path: string, body: unknown, auth?: string, ip = '7.7.7.7') => app.request(`/api/lounge${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }, lenv);
  const thread = { title: '沙田 R1 討論', category: 'race_day', body: '睇好一號', authorHandle: '阿天', authorId: 'spoofed-id' };
  check('lounge: anonymous thread → 401', (await post('/threads', thread)).status === 401);
  check('lounge: anonymous chat → 401', (await post('/chat', { body: 'hi', authorHandle: 'x', authorId: 'y' })).status === 401);
  const created = await post('/threads', thread, `Bearer ${good}`);
  const cj: any = await created.json();
  check('lounge: authenticated thread → 200', created.status === 200 && !!cj.threadId);
  const row: any = db.sqlite.query('SELECT author_id FROM lounge_threads WHERE id = ?').get(cj.threadId);
  check('lounge: author_id comes from JWT, not body', row?.author_id === USER);
  check('lounge: anonymous reply → 401', (await post(`/threads/${cj.threadId}/posts`, { body: 'hi', authorHandle: 'x' })).status === 401);
  check('lounge: authenticated reply → 200', (await post(`/threads/${cj.threadId}/posts`, { body: '同意', authorHandle: '阿天' }, `Bearer ${good}`)).status === 200);
  check('lounge: body over limit → 400', (await post('/chat', { body: 'x'.repeat(LOUNGE_LIMITS.maxBodyChars + 1), authorHandle: 'x' }, `Bearer ${good}`)).status === 400);
  check('lounge: non-string body → 400', (await post('/chat', { body: { evil: 1 }, authorHandle: 'x' }, `Bearer ${good}`)).status === 400);
  check('lounge: control chars in handle → 400', (await post('/chat', { body: 'hi', authorHandle: 'a\u202Eb' }, `Bearer ${good}`)).status === 400);
  check('lounge: bad category → 400', (await post('/threads', { ...thread, category: 'spam' }, `Bearer ${good}`)).status === 400);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await post('/chat', { body: `msg ${i}`, authorHandle: '阿天' }, `Bearer ${good}`)).status);
  // 已用 1 次回覆（上面），每分鐘上限 5 → 第 5 次起 429
  check('lounge: per-user burst limit enforced via D1', statuses.includes(429) && statuses.filter((x) => x === 200).length === LOUNGE_LIMITS.postsPerUserMinute - 1);
  const list = await app.request('/api/lounge/threads', {}, lenv);
  check('lounge: GET threads stays public', list.status === 200);
}

resetSupabaseAuthCache();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall security guard tests passed');
