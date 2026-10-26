#!/usr/bin/env tsx
/**
 * P1 notify_events：event_key 去重、draft 唔發 top4、無 secret 401、daily_pnl 凍結日起計。
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import {
  DAILY_PNL_FREEZE_START,
  NOTIFY_DISCLAIMER,
  dailyPnlKey,
  dayPnlFromHitRateCache,
  emitFinalLockEvents,
  emitSettledDailyPnlEvents,
  ensureNotifyEventsTable,
  lockCompleteKey,
  shouldEmitFinalLockEvents,
  top4LockKey,
} from '../src/lib/notify-events';
import { parseNotifyQuery, notifyRoutes } from '../src/routes/notify';
import type { Env } from '../src/types';

class Stmt {
  private params: unknown[] = [];
  constructor(private readonly db: Database.Database, private readonly sql: string) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[] }; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: info.changes } };
  }
}
class D1 {
  constructor(private readonly db: Database.Database) {}
  prepare(sql: string) { return new Stmt(this.db, sql); }
}

const sqlite = new Database(':memory:');
sqlite.exec(`
  CREATE TABLE horses (id TEXT PRIMARY KEY, name_ch TEXT);
  CREATE TABLE prediction_log (
    date TEXT, race_number INTEGER, horse_id TEXT, engine TEXT, variant TEXT,
    horse_number INTEGER, predicted_rank INTEGER, p_win REAL, generated_at TEXT
  );
  CREATE TABLE race_meetings (id TEXT PRIMARY KEY, date TEXT, venue TEXT);
  CREATE TABLE races (id TEXT PRIMARY KEY, meeting_id TEXT);
  CREATE TABLE race_results (id TEXT PRIMARY KEY, race_id TEXT, finishing_position INTEGER);
  CREATE TABLE meeting_hit_rate_cache (date TEXT, engine TEXT, payload_json TEXT, computed_at TEXT, PRIMARY KEY(date,engine));

  INSERT INTO horses VALUES ('horse_J062','金鑽貴人'),('horse_H117','嘉應高昇'),('horse_K001','測試一'),('horse_K002','測試二');
  INSERT INTO prediction_log VALUES
    ('2026-10-26',1,'horse_J062','v12','baseline',5,1,0.25,'2026-10-26T04:00:00Z'),
    ('2026-10-26',1,'horse_H117','v12','baseline',7,2,0.18,'2026-10-26T04:00:00Z'),
    ('2026-10-26',1,'horse_K001','v12','baseline',3,3,0.12,'2026-10-26T04:00:00Z'),
    ('2026-10-26',1,'horse_K002','v12','baseline',9,4,0.10,'2026-10-26T04:00:00Z'),
    ('2026-10-26',1,'horse_Z999','v12','baseline',1,5,0.05,'2026-10-26T04:00:00Z');
`);

const db = new D1(sqlite) as unknown as D1Database;
const env = { DB: db, WATCH_FEED_SECRET: 'notify-secret' } as Env;
const app = new Hono<{ Bindings: Env }>();
app.route('/api/notify', notifyRoutes);

async function main(): Promise<void> {
  assert.equal(shouldEmitFinalLockEvents('draft'), false);
  assert.equal(shouldEmitFinalLockEvents('unavailable'), false);
  assert.equal(shouldEmitFinalLockEvents('final'), true);
  assert.equal(DAILY_PNL_FREEZE_START, '2026-10-04');
  assert.ok(NOTIFY_DISCLAIMER.includes('僅供參考'));

  // draft → 零寫入（先建表再驗）
  await ensureNotifyEventsTable(db);
  const draft = await emitFinalLockEvents(db, { date: '2026-10-26', venue: 'ST', edition: 'draft' });
  assert.deepEqual(draft, { lockComplete: false, top4: 0 });
  const count0b = sqlite.prepare('SELECT COUNT(*) AS n FROM notify_events').get() as { n: number };
  assert.equal(count0b.n, 0, 'draft must not write events');

  // final → lock_complete + 4 top4（rank≤4；第5名唔寫）
  const fin = await emitFinalLockEvents(db, { date: '2026-10-26', venue: 'ST', edition: 'final' });
  assert.equal(fin.lockComplete, true);
  assert.equal(fin.top4, 4);
  const keys = sqlite.prepare('SELECT event_key, type FROM notify_events ORDER BY event_key').all() as { event_key: string; type: string }[];
  assert.ok(keys.some((k) => k.event_key === lockCompleteKey('2026-10-26', 'ST')));
  assert.ok(keys.some((k) => k.event_key === top4LockKey('2026-10-26', 'ST', 1, 'horse_J062')));
  assert.ok(!keys.some((k) => k.event_key.includes('horse_Z999')), 'rank 5 never top4_lock');

  // event_key 去重：再 emit 唔加倍
  const again = await emitFinalLockEvents(db, { date: '2026-10-26', venue: 'ST', edition: 'final' });
  assert.equal(again.lockComplete, false);
  assert.equal(again.top4, 0);
  const count1 = sqlite.prepare('SELECT COUNT(*) AS n FROM notify_events').get() as { n: number };
  assert.equal(count1.n, 5, '1 lock + 4 top4');

  // daily_pnl：凍結日前唔寫；有 boxDivs 先寫
  sqlite.prepare(`INSERT INTO race_meetings VALUES ('m1','2026-10-03','ST'),('m2','2026-10-05','HV')`).run();
  sqlite.prepare(`INSERT INTO races VALUES ('r1','m1'),('r2','m2')`).run();
  sqlite.prepare(`INSERT INTO race_results VALUES ('rr1','r1',1),('rr2','r2',1)`).run();
  const payload = {
    summary: { boxDivsFetched: true },
    races: [{
      actualTop4: [1, 2, 3, 4],
      predictedTop4: [{ horseNumber: 5 }, { horseNumber: 7 }, { horseNumber: 3 }, { horseNumber: 9 }],
      boxPayouts: [{ pool: 'FF', dividend: 100 }],
    }],
  };
  sqlite.prepare(`INSERT INTO meeting_hit_rate_cache VALUES ('2026-10-03','v12',?,?)`).run(JSON.stringify(payload), '2026-10-03T12:00:00Z');
  sqlite.prepare(`INSERT INTO meeting_hit_rate_cache VALUES ('2026-10-05','v12',?,?)`).run(JSON.stringify(payload), '2026-10-05T12:00:00Z');

  const day = dayPnlFromHitRateCache(payload, '2026-10-05', 'HV');
  assert.ok(day);
  assert.equal(day!.racesBet, 1);
  assert.equal(day!.cost, 530);
  assert.equal(day!.payout, 100);
  assert.equal(day!.net, -430);

  const pnl = await emitSettledDailyPnlEvents(db, { now: new Date('2026-10-10T00:00:00Z'), lookbackDays: 30 });
  assert.equal(pnl.written, 1, 'only ≥ 2026-10-04');
  const pnlRow = sqlite.prepare(`SELECT event_key, payload_json FROM notify_events WHERE type='daily_pnl'`).get() as any;
  assert.equal(pnlRow.event_key, dailyPnlKey('2026-10-05', 'HV'));
  const pj = JSON.parse(pnlRow.payload_json);
  assert.equal(pj.net, -430);
  assert.equal(pj.disclaimer, NOTIFY_DISCLAIMER);
  assert.ok(!('roiPct' in pj) && !('hitRate' in pj), 'no hit-rate / ROI in payload');

  // 去重
  const pnl2 = await emitSettledDailyPnlEvents(db, { now: new Date('2026-10-10T00:00:00Z'), lookbackDays: 30 });
  assert.equal(pnl2.written, 0);

  // API auth
  assert.equal((await app.request('/api/notify/events', {}, env)).status, 401);
  assert.equal((await app.request('/api/notify/events', { headers: { 'x-cron-secret': 'wrong' } }, env)).status, 401);
  assert.equal((await app.request('/api/notify/events', { headers: { 'x-cron-secret': 'x' } }, { ...env, WATCH_FEED_SECRET: undefined } as Env)).status, 503);

  const ok = await app.request('/api/notify/events?since=2026-10-01&types=lock_complete,top4_lock,daily_pnl', {
    headers: { 'x-cron-secret': 'notify-secret' },
  }, env);
  assert.equal(ok.status, 200);
  const body = await ok.json() as any;
  assert.ok(body.count >= 5);
  assert.ok(body.events.every((e: any) => e.event_key && e.type && e.created_at));

  // parse
  const bad = parseNotifyQuery(new URLSearchParams('since=nope'));
  assert.equal(bad.ok, false);
  const good = parseNotifyQuery(new URLSearchParams('since=2026-10-20&types=lock_complete'), new Date('2026-10-26T00:00:00Z'));
  assert.ok(good.ok && good.types.length === 1);

  // types filter
  const onlyLock = await app.request('/api/notify/events?since=2026-10-01&types=lock_complete', {
    headers: { 'x-cron-secret': 'notify-secret' },
  }, env);
  const onlyBody = await onlyLock.json() as any;
  assert.ok(onlyBody.events.every((e: any) => e.type === 'lock_complete'));

  console.log('test-notify-events: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
