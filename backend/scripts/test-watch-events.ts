#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { alertHookSecret, watchFeedSecrets } from '../src/lib/shared-secret';
import { parseWatchQuery, watchRoutes, MAX_HORSE_IDS } from '../src/routes/watch';
import type { Env } from '../src/types';

class Stmt {
  private params: unknown[] = [];
  constructor(private readonly db: Database.Database, private readonly sql: string) {}
  bind(...params: unknown[]) {
    if (params.length > 100) throw new Error('D1 limit: too many bound parameters');
    this.params = params; return this;
  }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[] }; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null; }
}
class D1 { constructor(private readonly db: Database.Database) {} prepare(sql: string) { return new Stmt(this.db, sql); } }

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE entries_upcoming (id TEXT PRIMARY KEY, race_date TEXT, venue TEXT, race_number INTEGER, race_class TEXT,
    distance INTEGER, horse_id TEXT, horse_number INTEGER, draw INTEGER, jockey_name TEXT, trainer_name TEXT,
    actual_weight REAL, rating INTEGER, priority_order TEXT, scraped_at TEXT);
  CREATE TABLE horse_trackwork (id TEXT PRIMARY KEY, horse_id TEXT, trackwork_date TEXT, venue TEXT, batch TEXT,
    distance TEXT, time_text TEXT, time_sec REAL, partner TEXT, comment TEXT, work_type TEXT, track TEXT, rider TEXT,
    splits TEXT, gear TEXT, placing TEXT, details TEXT, ingested_at TEXT);
  CREATE TABLE trial_sessions (id TEXT PRIMARY KEY, trial_date TEXT, venue TEXT, session_number INTEGER, distance INTEGER,
    going TEXT, track TEXT, total_runners INTEGER);
  CREATE TABLE trial_runners (id TEXT PRIMARY KEY, session_id TEXT, horse_id TEXT, horse_number INTEGER,
    finishing_position INTEGER, time_text TEXT, time_sec REAL, jockey_name TEXT, lbw TEXT, gear TEXT, comment TEXT);
  CREATE TABLE horse_injury (id TEXT PRIMARY KEY, horse_id TEXT, injury_date TEXT, injury_type TEXT,
    resolution_date TEXT, days_out INTEGER, description TEXT);

  INSERT INTO entries_upcoming VALUES
    ('e1','2026-10-25','ST',3,'4',1200,'horse_J062',5,7,'潘頓','呂健威',126,60,'正選','2026-10-22T12:43:00Z'),
    ('e2','2026-10-25','ST',5,'4',1400,'horse_H117',14,0,NULL,NULL,115,52,'後備1','2026-10-22T12:43:00Z'),
    ('e_old','2026-10-19','ST',1,'4',1200,'horse_J062',1,1,'x','y',120,60,'正選','2026-10-17T12:43:00Z'),
    ('e_other','2026-10-25','ST',1,'4',1200,'horse_Z999',1,1,'x','y',120,60,'正選','2026-10-22T12:43:00Z');
  INSERT INTO horse_trackwork (id,horse_id,trackwork_date,venue,work_type,track,details) VALUES
    ('tw1','horse_J062','2026-10-21','沙田','快操','草地','快操 800m'),
    ('tw2','horse_J062','2026-10-21','沙田','踱步','內圈','快踱一圈'),
    ('tw_old','horse_J062','2026-10-01','沙田','快操','草地','old');
  INSERT INTO trial_sessions VALUES ('ts1','2026-10-21','沙田',2,1050,'好','全天候',10);
  INSERT INTO trial_runners VALUES ('tr1','ts1','horse_H117',3,2,'0.58.9',58.9,'布文','1-1/4','B','走勢暢順');
  INSERT INTO horse_injury VALUES
    ('inj1','horse_H117','2026-10-20','右前腿不良於行',NULL,NULL,NULL),
    ('inj2','horse_J062','2026-09-01','流鼻血','2026-10-22',51,NULL),
    ('inj_old','horse_J062','2025-01-01','舊傷','2025-03-01',59,NULL);
`);

const env = { DB: new D1(db) as unknown as D1Database, WEATHER_CRON_SECRET: 'test-secret' } as Env;
const app = new Hono<{ Bindings: Env }>();
app.route('/api/watch', watchRoutes);
const now = new Date('2026-10-23T04:00:00Z');

async function main(): Promise<void> {
  // 參數驗證
  assert.equal(parseWatchQuery(new URLSearchParams(''), now).ok, false);
  assert.equal(parseWatchQuery(new URLSearchParams('horse_ids=DROP TABLE'), now).ok, false);
  const tooMany = Array.from({ length: MAX_HORSE_IDS + 1 }, (_, i) => `horse_A${String(i).padStart(3, '0')}`).join(',');
  assert.equal(parseWatchQuery(new URLSearchParams(`horse_ids=${tooMany}`), now).ok, false);
  const clamped = parseWatchQuery(new URLSearchParams('horse_ids=horse_J062&since=2020-01-01'), now);
  assert.ok(clamped.ok && clamped.query.since === '2026-10-09', 'since clamps to 14 days');

  // 認證
  assert.equal((await app.request('/api/watch/events?horse_ids=horse_J062', {}, env)).status, 401);
  assert.equal((await app.request('/api/watch/events?horse_ids=horse_J062', { headers: { 'x-cron-secret': 'nope' } }, env)).status, 401);
  assert.equal((await app.request('/api/watch/events?horse_ids=horse_J062', { headers: { 'x-cron-secret': 'x' } }, { ...env, WEATHER_CRON_SECRET: undefined })).status, 503);

  // 密鑰拆分：專用 WATCH_FEED_SECRET + PREVIOUS；LEGACY_CRON_SECRET_FALLBACK=off 後舊共用值失效
  const wq = '/api/watch/events?horse_ids=horse_J062';
  const split = { ...env, WATCH_FEED_SECRET: 'watch-new', WATCH_FEED_SECRET_PREVIOUS: 'watch-old' } as Env;
  assert.equal((await app.request(wq, { headers: { 'x-cron-secret': 'watch-new' } }, split)).status, 200);
  assert.equal((await app.request(wq, { headers: { 'x-cron-secret': 'watch-old' } }, split)).status, 200);
  assert.equal((await app.request(wq, { headers: { 'x-cron-secret': 'test-secret' } }, split)).status, 200, 'legacy accepted during transition');
  const strict = { ...split, LEGACY_CRON_SECRET_FALLBACK: 'off' } as Env;
  assert.equal((await app.request(wq, { headers: { 'x-cron-secret': 'test-secret' } }, strict)).status, 401, 'legacy rejected after cut-over');
  assert.equal((await app.request(wq, { headers: { 'x-cron-secret': 'watch-new' } }, strict)).status, 200);
  assert.equal((await app.request(wq, { headers: { 'x-cron-secret': 'watch-new-x' } }, strict)).status, 401);
  assert.equal(alertHookSecret({ WEATHER_CRON_SECRET: 'legacy' }), 'legacy');
  assert.equal(alertHookSecret({ WEATHER_CRON_SECRET: 'legacy', ALERT_HOOK_SECRET: 'alert' }), 'alert');
  assert.equal(alertHookSecret({ WEATHER_CRON_SECRET: 'legacy', LEGACY_CRON_SECRET_FALLBACK: 'off' }), undefined);
  assert.deepEqual(watchFeedSecrets({ WEATHER_CRON_SECRET: 'legacy', LEGACY_CRON_SECRET_FALLBACK: 'off' }), []);

  const res = await app.request('/api/watch/events?horse_ids=horse_J062,horse_H117&since=2026-10-20', { headers: { 'x-cron-secret': 'test-secret' } }, env);
  assert.equal(res.status, 200);
  const body = await res.json() as { events: Array<{ event_key: string; type: string }>; freshness: Record<string, string> };
  const keys = body.events.map((e) => e.event_key).sort();
  // hkToday(new Date()) is used by the route, so entries depend on the real date: only assert stable non-entry keys here.
  for (const k of ['trackwork:tw1', 'trial:tr1', 'injury:inj1:open', 'injury:inj2:resolved']) assert.ok(keys.includes(k), `missing ${k}`);
  assert.ok(!keys.includes('trackwork:tw2'), '踱步 filtered by default');
  assert.ok(!keys.includes('trackwork:tw_old'));
  assert.ok(!keys.some((k) => k.includes('inj_old') || k.includes('injury:inj2:open')));
  assert.ok(!keys.some((k) => k.includes('horse_Z999')));
  assert.equal(body.freshness.latestTrialDate, '2026-10-21');

  const all = await app.request('/api/watch/events?horse_ids=horse_J062&since=2026-10-20&trackwork=all&types=trackwork', { headers: { 'x-cron-secret': 'test-secret' } }, env);
  const allBody = await all.json() as { events: Array<{ event_key: string }> };
  assert.deepEqual(allBody.events.map((e) => e.event_key).sort(), ['trackwork:tw1', 'trackwork:tw2']);

  // 排位：用 loadWatchEvents 直接測（固定 today）
  const { loadWatchEvents } = await import('../src/routes/watch');
  const q = parseWatchQuery(new URLSearchParams('horse_ids=horse_J062,horse_H117&types=entry'), now);
  assert.ok(q.ok);
  const entries = await loadWatchEvents(env.DB, q.query);
  assert.deepEqual(entries.map((e) => e.event_key), [
    'entry:2026-10-25:ST:3:horse_J062:D',
    'entry:2026-10-25:ST:5:horse_H117:R',
  ]);
  assert.equal(entries[1].title, '列入後備');

  // 90 匹馬都唔會爆 D1 100 個 parameter 上限
  const many = Array.from({ length: MAX_HORSE_IDS }, (_, i) => `horse_A${String(i).padStart(3, '0')}`).join(',');
  const big = await app.request(`/api/watch/events?horse_ids=${many}`, { headers: { 'x-cron-secret': 'test-secret' } }, env);
  assert.equal(big.status, 200);
}

main()
  .then(() => console.log('watch events tests passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
