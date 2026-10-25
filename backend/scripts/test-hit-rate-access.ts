#!/usr/bin/env tsx
// ANON_HITRATE_MODE + SITE_READER_TOKEN（網站伺服器唯讀憑證）測試。
// 所有憑證值都喺執行時即場隨機產生，唔會寫入任何檔案或輸出。執行：npx tsx scripts/test-hit-rate-access.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  hasReaderCredential,
  hasSiteReaderToken,
  hasTgReaderToken,
  SITE_READER_HEADER,
  TG_READER_HEADER,
  todayPicksViewForRequest,
} from '../src/lib/tg-reader';
import {
  anonHitRateMode,
  hitRateBodyForNonAdmin,
  projectHitRateForAnonymous,
  resolveHitRateView,
} from '../src/lib/hit-rate-access';
import { projectHitRateForPublic, projectHitRateRollupForPublic } from '../src/lib/public-today-picks';
import { ADMIN_AUTH_POLICY, hasAdminAccess } from '../src/lib/admin-auth';
import worker from '../src/index';

const SITE = `s-${randomUUID()}`;
const SITE_PREV = `sp-${randomUUID()}`;
const SITE_NEXT = `sn-${randomUUID()}`;
const TG = `t-${randomUUID()}`;
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

const race = (n: number) => ({
  raceNumber: n, title: `第${n}場`, distance: 1200, going: '好地', raceId: `R${n}`,
  top1Hit: true, top3IntersectCount: 2, top3AnyHit: true, top4IntersectCount: 3,
  quinellaHit: true, qpHit: true, trioHit: false, tierceHit: false, first4Hit: false,
  scoreSource: 'ensemble', ensembleAlpha: 0.6, debugBlend: { w: 1 },
  predictedTop4: [1, 2, 3, 4].map((r) => ({ rank: r, horseNumber: r + 3, nameCh: `馬${r}`, hit: r < 3, draw: r, scoreSource: 'x', horseId: `H${r}`, rawScore: 0.9 })),
  predictedFifth: { rank: 5, horseNumber: 9, frozen: true },
  actualTop4: [1, 2, 3, 4].map((p) => ({ position: p, horseNumber: p + 3, nameCh: `馬${p}`, winOdds: 3.5, hit: true, horseId: `H${p}` })),
  boxPayouts: [{ pool: 'QIN', name: '連贏', units: 6, cost: 60, dividend: 100, net: 40 }],
});
const PAYLOAD = {
  date: '2026-10-25', venue: 'ST', trackCondition: '好地', engine: 'v12', generatedAt: 'x', fromCache: true,
  summary: { totalRaces: 3, top1Hits: 3, top1Rate: 1 },
  races: [1, 2, 3].map(race),
};

async function main(): Promise<void> {
  // ---------- 旗標 ----------
  assert.equal(anonHitRateMode({}), 'legacy', 'unset → legacy');
  assert.equal(anonHitRateMode(undefined), 'legacy');
  assert.equal(anonHitRateMode({ ANON_HITRATE_MODE: 'legacy' }), 'legacy');
  assert.equal(anonHitRateMode({ ANON_HITRATE_MODE: ' RESTRICTED ' }), 'restricted');
  assert.equal(anonHitRateMode({ ANON_HITRATE_MODE: 'restrict' }), 'legacy', 'typo fails to legacy (current behaviour)');
  assert.equal(anonHitRateMode({ ANON_FULL_CARD_MODE: 'restricted' } as any), 'legacy', 'independent of ANON_FULL_CARD_MODE');

  // ---------- 網站憑證比較 ----------
  const env = { SITE_READER_TOKEN: SITE, SITE_READER_TOKEN_PREVIOUS: SITE_PREV, SITE_READER_TOKEN_NEXT: SITE_NEXT, TG_READER_TOKEN: TG };
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: SITE })), true, 'valid site token');
  assert.equal(await hasSiteReaderToken(ctx(env, { 'x-tianxi-site-token': SITE })), true, 'header case-insensitive');
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: SITE_PREV })), true, 'previous accepted');
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: SITE_NEXT })), true, 'next accepted');
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: SITE + 'x' })), false, 'invalid');
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: SITE.slice(0, 8) })), false, 'prefix rejected');
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: '' })), false, 'empty header');
  assert.equal(await hasSiteReaderToken(ctx(env, { authorization: `Bearer ${SITE}` })), false, 'Bearer not accepted');
  assert.equal(await hasSiteReaderToken(ctx(env, { [SITE_READER_HEADER]: TG })), false, 'TG token is not a site token');
  assert.equal(await hasTgReaderToken(ctx(env, { [TG_READER_HEADER]: SITE })), false, 'site token is not a TG token');
  assert.equal(await hasSiteReaderToken(ctx({}, { [SITE_READER_HEADER]: SITE })), false, 'secret unset → nobody');
  assert.equal(await hasSiteReaderToken(ctx({ SITE_READER_TOKEN: '' }, { [SITE_READER_HEADER]: '' })), false, 'empty secret never matches');
  assert.equal(await hasReaderCredential(ctx(env, { [SITE_READER_HEADER]: SITE })), true, 'site counts as reader');
  assert.equal(await hasReaderCredential(ctx(env, { [TG_READER_HEADER]: TG })), true, 'TG counts as reader');
  assert.equal(await hasReaderCredential(ctx(env, {})), false);

  // ---------- 視圖矩陣 ----------
  const yes = async () => true;
  const no = async () => false;
  const boom = async (): Promise<boolean> => { throw new Error('must not be called'); };
  const v = (mode: 'legacy' | 'restricted', who: { pro?: boolean; reader?: boolean; registered?: boolean } = {}) =>
    resolveHitRateView({ mode, pro: who.pro ? yes : no, reader: who.reader ? yes : no, registered: who.registered ? yes : no });
  assert.equal(await resolveHitRateView({ mode: 'legacy', reader: boom, pro: boom, registered: boom }), 'public', 'legacy: no lookups, unchanged');
  assert.equal(await v('restricted'), 'aggregate', 'restricted anon → aggregate');
  assert.equal(await v('restricted', { reader: true }), 'public', 'restricted reader → public');
  assert.equal(await v('restricted', { registered: true }), 'public', 'restricted registered → public (reconcile.full)');
  assert.equal(await v('restricted', { pro: true }), 'public', 'restricted pro → public');

  // ---------- 匿名投影 ----------
  const pub = projectHitRateForPublic(PAYLOAD) as any;
  const anon = projectHitRateForAnonymous(PAYLOAD) as any;
  assert.equal(anon.access, 'aggregate');
  assert.deepEqual(anon.summary, pub.summary, 'aggregate stats preserved');
  assert.equal(anon.date, '2026-10-25');
  assert.equal(anon.races.length, 3, 'race list kept (results are public HKJC data)');
  assert.deepEqual(anon.races[0], pub.races[0], 'race 1 = full public projection (cards.race1 = guest)');
  for (const r of anon.races.slice(1)) {
    assert.equal(r.redacted, true);
    assert.deepEqual(Object.keys(r).sort(), ['actualTop4', 'distance', 'going', 'raceNumber', 'redacted', 'title']);
    for (const h of r.actualTop4) assert.deepEqual(Object.keys(h).sort(), ['horseNumber', 'nameCh', 'position', 'winOdds'], 'no hit flag on results');
  }
  const laterJson = JSON.stringify(anon.races.slice(1));
  for (const k of ['predictedTop4', 'predictedFifth', 'boxPayouts', 'Hit', 'IntersectCount', 'scoreSource', 'ensembleAlpha', 'rawScore', 'debugBlend', '"hit"', 'horseId']) {
    assert.ok(!laterJson.includes(k), `anon races 2+ omit ${k}`);
  }
  assert.ok(!JSON.stringify(anon).includes('rawScore') && !JSON.stringify(anon).includes('debugBlend'), 'raw fields never leak');
  assert.deepEqual(projectHitRateForAnonymous(null).races, [], 'garbage in → empty races');

  // ---------- rollup 本身已經係彙總 ----------
  const rollup = projectHitRateRollupForPublic({
    days: 30, meetings: 1, summary: { top1Hits: 3 },
    perMeeting: [{ date: '2026-10-25', venue: 'ST', summary: { top1Hits: 3 }, races: PAYLOAD.races }],
  }) as any;
  const rollJson = JSON.stringify(rollup);
  for (const k of ['predictedTop4', 'predictedFifth', 'boxPayouts', 'actualTop4', 'races']) assert.ok(!rollJson.includes(k), `rollup public projection omits ${k}`);

  // ---------- route 接駁 ----------
  const renv = { ...env, ANON_HITRATE_MODE: 'restricted' };
  let c = ctx(renv);
  let body: any = await hitRateBodyForNonAdmin(c, PAYLOAD);
  assert.equal(body.access, 'aggregate', 'restricted anon → aggregate body');
  assert.match(c.set.Vary ?? '', /X-Tianxi-Site-Token/);
  assert.match(c.set.Vary ?? '', /X-TG-Reader-Token/);
  assert.equal(c.set['Cache-Control'], undefined, 'anon aggregate stays cacheable as before');
  for (const headers of [{ [SITE_READER_HEADER]: SITE }, { [TG_READER_HEADER]: TG }]) {
    c = ctx(renv, headers);
    body = await hitRateBodyForNonAdmin(c, PAYLOAD);
    assert.deepEqual(body, pub, 'reader → exactly today\'s public response');
    assert.equal(c.set['Cache-Control'], 'private, no-store');
  }
  c = ctx(renv, { [SITE_READER_HEADER]: 'wrong' });
  assert.equal((await hitRateBodyForNonAdmin(c, PAYLOAD) as any).access, 'aggregate', 'bad token → aggregate');
  c = ctx(renv, { authorization: 'Bearer eyJx.eyJ.sig' });
  assert.equal((await hitRateBodyForNonAdmin(c, PAYLOAD) as any).access, 'aggregate', 'unverifiable JWT → aggregate');
  c = ctx(env);
  assert.deepEqual(await hitRateBodyForNonAdmin(c, PAYLOAD), pub, 'legacy anon → unchanged public projection');
  assert.deepEqual(c.set, {}, 'legacy sets no headers');

  // today-picks 都接受網站憑證（同 TG 一樣嘅權限）
  c = ctx({ ...env, ANON_FULL_CARD_MODE: 'restricted' }, { [SITE_READER_HEADER]: SITE });
  assert.equal(await todayPicksViewForRequest(c, true), 'public', 'site token reads settled today-picks');
  assert.match(c.set.Vary ?? '', /X-Tianxi-Site-Token/);

  // ---------- 網站憑證唔係管理員 ----------
  const aenv = { ...env, ADMIN_TOKEN: ADMIN, SESSION_HMAC_SECRET: `h-${randomUUID()}`, DB: makeDbShim(), ANON_HITRATE_MODE: 'restricted' };
  for (const policy of [ADMIN_AUTH_POLICY.SESSION_OR_BEARER, ADMIN_AUTH_POLICY.BEARER_ONLY]) {
    assert.equal(await hasAdminAccess(ctx(aenv, { [SITE_READER_HEADER]: SITE }) as any, policy), false, `site header not admin (${policy})`);
    assert.equal(await hasAdminAccess(ctx(aenv, { authorization: `Bearer ${SITE}` }) as any, policy), false, `site as Bearer not admin (${policy})`);
    assert.equal(await hasAdminAccess(ctx(aenv, { authorization: `Bearer ${ADMIN}` }) as any, policy), true, `sanity admin (${policy})`);
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
    ['GET', '/api/analyze/picks-by-date?date=2026-10-25'],
  ];
  for (const [method, path] of adminPaths) {
    const anonR = await snap(await call(method, path));
    for (const headers of [{ [SITE_READER_HEADER]: SITE }, { authorization: `Bearer ${SITE}` }]) {
      assert.deepEqual(await snap(await call(method, path, headers)), anonR, `${method} ${path}: site token = anonymous`);
    }
    const adminR = await snap(await call(method, path, { authorization: `Bearer ${ADMIN}` }));
    console.log(`  ${method} ${path}: anon=${anonR.status} site=same admin=${adminR.status}`);
    if (path.startsWith('/admin/')) assert.notDeepEqual(adminR, anonR, `sanity: ${path} distinguishes admin`);
  }

  console.log('test-hit-rate-access: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
