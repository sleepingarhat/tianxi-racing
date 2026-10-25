#!/usr/bin/env tsx
// TG_READER_TOKEN（TG 通知腳本唯讀憑證）+ ANON_FULL_CARD_MODE 測試。
// 所有憑證值都喺執行時即場隨機產生，唔會寫入任何檔案或輸出。執行：npx tsx scripts/test-tg-reader.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  anonFullCardMode,
  hasTgReaderToken,
  hasVerifiedUserJwt,
  resolveTodayPicksView,
  todayPicksViewForRequest,
  TG_READER_HEADER,
} from '../src/lib/tg-reader';
import { ADMIN_AUTH_POLICY, hasAdminAccess } from '../src/lib/admin-auth';
import { projectTodayPicksForFree, projectTodayPicksForPublic } from '../src/lib/public-today-picks';
import worker from '../src/index';

const READER = `r-${randomUUID()}`;
const READER_PREV = `p-${randomUUID()}`;
const ADMIN = `a-${randomUUID()}`;

function ctx(env: Record<string, unknown>, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const set: Record<string, string> = {};
  return {
    env,
    set,
    req: { header: (n: string) => lower[n.toLowerCase()] },
    header: (n: string, v: string) => { set[n] = v; },
  };
}

function makeDbShim(): D1Database {
  const statement: any = {
    bind() { return statement; },
    async first() { return null; },
    async all() { return { results: [] }; },
    async run() { return { results: [], meta: { changes: 0 } }; },
  };
  return { prepare() { return statement; }, async batch(s: unknown[]) { return s.map(() => ({ results: [] })); } } as any;
}

async function main(): Promise<void> {
  // ---------- 旗標 ----------
  assert.equal(anonFullCardMode({}), 'legacy', 'unset → legacy');
  assert.equal(anonFullCardMode({ ANON_FULL_CARD_MODE: 'legacy' }), 'legacy');
  assert.equal(anonFullCardMode({ ANON_FULL_CARD_MODE: ' Restricted ' }), 'restricted');
  assert.equal(anonFullCardMode({ ANON_FULL_CARD_MODE: 'restrict' }), 'legacy', 'typo fails to legacy (current behaviour)');

  // ---------- 憑證比較 ----------
  const env = { TG_READER_TOKEN: READER, TG_READER_TOKEN_PREVIOUS: READER_PREV };
  assert.equal(await hasTgReaderToken(ctx(env, { [TG_READER_HEADER]: READER })), true, 'valid token');
  assert.equal(await hasTgReaderToken(ctx(env, { 'x-tg-reader-token': READER })), true, 'header is case-insensitive');
  assert.equal(await hasTgReaderToken(ctx(env, { [TG_READER_HEADER]: READER_PREV })), true, 'previous token accepted');
  assert.equal(await hasTgReaderToken(ctx(env, { [TG_READER_HEADER]: READER + 'x' })), false, 'invalid token');
  assert.equal(await hasTgReaderToken(ctx(env, { [TG_READER_HEADER]: READER.slice(0, 8) })), false, 'prefix rejected');
  assert.equal(await hasTgReaderToken(ctx(env, { [TG_READER_HEADER]: '' })), false, 'empty header');
  assert.equal(await hasTgReaderToken(ctx(env, {})), false, 'missing header');
  assert.equal(await hasTgReaderToken(ctx(env, { authorization: `Bearer ${READER}` })), false, 'only the dedicated header counts');
  assert.equal(await hasTgReaderToken(ctx({}, { [TG_READER_HEADER]: READER })), false, 'secret unset → nobody');
  assert.equal(await hasTgReaderToken(ctx({ TG_READER_TOKEN: '' }, { [TG_READER_HEADER]: '' })), false, 'empty secret never matches');

  // ---------- 視圖矩陣（純邏輯） ----------
  const yes = async () => true;
  const no = async () => false;
  const boom = async (): Promise<boolean> => { throw new Error('must not be called'); };
  const v = (settled: boolean, mode: 'legacy' | 'restricted', who: { pro?: boolean; reader?: boolean; registered?: boolean } = {}) =>
    resolveTodayPicksView({ settled, mode, pro: who.pro ? yes : no, reader: who.reader ? yes : no, registered: who.registered ? yes : no });
  assert.equal(await v(true, 'legacy'), 'public', 'legacy settled anon → all races (unchanged)');
  assert.equal(await resolveTodayPicksView({ settled: true, mode: 'legacy', pro: boom, reader: boom, registered: boom }), 'public', 'legacy settled does no credential lookups');
  assert.equal(await v(false, 'legacy'), 'free', 'legacy unsettled anon → race 1');
  assert.equal(await v(false, 'legacy', { reader: true }), 'free', 'reader never beats the legacy anon view pre-settlement');
  assert.equal(await v(false, 'restricted', { reader: true }), 'free', 'restricted unsettled reader → race 1');
  assert.equal(await v(false, 'restricted', { registered: true }), 'free', 'registered unsettled → race 1');
  assert.equal(await v(false, 'legacy', { pro: true }), 'public', 'pro unsettled → all');
  assert.equal(await v(true, 'restricted'), 'free', 'restricted settled anon → race 1 only');
  assert.equal(await v(true, 'restricted', { reader: true }), 'public', 'restricted settled reader → all races');
  assert.equal(await v(true, 'restricted', { registered: true }), 'public', 'restricted settled registered → all races (reconcile.full)');
  assert.equal(await v(true, 'restricted', { pro: true }), 'public', 'restricted settled pro → all races');

  // ---------- route 接駁（真 pro-gate／supabase，旗標 off） ----------
  const renv = { ...env, ANON_FULL_CARD_MODE: 'restricted' };
  let c = ctx(renv);
  assert.equal(await todayPicksViewForRequest(c, true), 'free', 'restricted anon settled → free');
  assert.match(c.set.Vary ?? '', /X-TG-Reader-Token/, 'restricted sets Vary');
  assert.equal(c.set['Cache-Control'], undefined, 'anon free view stays cacheable as before');
  c = ctx(renv, { [TG_READER_HEADER]: READER });
  assert.equal(await todayPicksViewForRequest(c, true), 'public', 'restricted reader settled → public');
  assert.equal(c.set['Cache-Control'], 'private, no-store', 'reader response is private');
  c = ctx(renv, { [TG_READER_HEADER]: 'wrong' });
  assert.equal(await todayPicksViewForRequest(c, true), 'free', 'restricted bad token → free');
  c = ctx(renv, { authorization: 'Bearer not-a-jwt' });
  assert.equal(await todayPicksViewForRequest(c, true), 'free', 'restricted non-JWT bearer → free');
  assert.equal(await hasVerifiedUserJwt(ctx(renv, { authorization: 'Bearer eyJx.eyJ.sig' })), false, 'unverifiable JWT → not registered');
  c = ctx({ ...env }, {});
  assert.equal(await todayPicksViewForRequest(c, true), 'public', 'legacy anon settled → public');
  assert.deepEqual(c.set, {}, 'legacy sets no headers (zero behaviour change)');
  c = ctx({ ...env }, { [TG_READER_HEADER]: READER });
  assert.equal(await todayPicksViewForRequest(c, false), 'free', 'reader pre-settlement → free');

  // 投影：TG 讀取者拎到嘅 public 投影都冇管理員／原始欄位
  const raw = {
    date: '2026-10-25', venue: 'ST', generatedAt: 'x', seedSummary: { secret: 1 }, predictionLog: { rows: 1 },
    races: [1, 2, 3].map((n) => ({ raceId: `R${n}`, raceNumber: n, debug: { a: 1 }, picks: [{ horseNumber: 1, nameCh: '甲', rank: 1, rawScore: 9 }] })),
  };
  const pub = projectTodayPicksForPublic(raw as any) as any;
  const free = projectTodayPicksForFree(raw as any) as any;
  assert.equal(pub.races.length, 3);
  assert.equal(free.races.length, 1);
  const pubJson = JSON.stringify(pub);
  for (const k of ['seedSummary', 'predictionLog', 'debug', 'rawScore']) assert.ok(!pubJson.includes(k), `public projection omits ${k}`);

  // ---------- 憑證唔係管理員 ----------
  const aenv = { ...env, ADMIN_TOKEN: ADMIN, SESSION_HMAC_SECRET: `s-${randomUUID()}`, DB: makeDbShim() };
  for (const policy of [ADMIN_AUTH_POLICY.SESSION_OR_BEARER, ADMIN_AUTH_POLICY.BEARER_ONLY]) {
    assert.equal(await hasAdminAccess(ctx(aenv, { [TG_READER_HEADER]: READER }) as any, policy), false, `reader header is not admin (${policy})`);
    assert.equal(await hasAdminAccess(ctx(aenv, { authorization: `Bearer ${READER}` }) as any, policy), false, `reader as Bearer is not admin (${policy})`);
    assert.equal(await hasAdminAccess(ctx(aenv, { authorization: `Bearer ${ADMIN}` }) as any, policy), true, `sanity: admin token still admin (${policy})`);
  }

  const call = (method: string, path: string, headers: Record<string, string> = {}) => worker.fetch(
    new Request(`https://tianxi.test${path}`, { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) }),
    aenv as any,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );
  const snap = async (r: Response) => ({ status: r.status, body: await r.text() });
  const adminPaths: Array<[string, string]> = [
    ['POST', '/admin/api/refresh-race-day-report'],
    ['POST', '/admin/api/refresh-hit-cache'],
    ['GET', '/api/analyze/today-picks?fresh=1&engine=v11&venue=HV'],
    ['GET', '/api/analyze/top-picks?raceId=missing'],
  ];
  for (const [method, path] of adminPaths) {
    const anon = await snap(await call(method, path));
    for (const headers of [{ [TG_READER_HEADER]: READER }, { authorization: `Bearer ${READER}` }]) {
      const withReader = await snap(await call(method, path, headers));
      assert.deepEqual(withReader, anon, `${method} ${path}: reader token gets exactly the anonymous response`);
    }
    const admin = await snap(await call(method, path, { authorization: `Bearer ${ADMIN}` }));
    console.log(`  ${method} ${path}: anon=${anon.status} reader=same admin=${admin.status}`);
    if (path.startsWith('/admin/')) assert.notDeepEqual(admin, anon, `sanity: ${path} distinguishes admin`);
  }

  console.log('test-tg-reader: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
