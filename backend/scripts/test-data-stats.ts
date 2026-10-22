import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { computeDataStats, refreshDataStats, getDataStats, readStoredDataStats, resetDataStatsThrottle, DATA_STATS_MAX_AGE_MS } from '../src/lib/data-stats';

const sqlite = new Database(':memory:');
let reads = 0;
class Statement {
  params: any[] = [];
  constructor(public sql: string) {}
  bind(...params: any[]) { this.params = params; return this; }
  async all() { reads++; return { results: sqlite.query(this.sql).all(...this.params) }; }
  async first() { reads++; return sqlite.query(this.sql).get(...this.params); }
  async run() { return sqlite.query(this.sql).run(...this.params); }
}
const db = { prepare: (sql: string) => new Statement(sql) } as any;
sqlite.exec(`
CREATE TABLE race_meetings(id TEXT PRIMARY KEY, date TEXT, venue TEXT);
CREATE TABLE races(id TEXT PRIMARY KEY, meeting_id TEXT, race_number INT);
CREATE TABLE race_results(id TEXT PRIMARY KEY, race_id TEXT, horse_id TEXT);
CREATE TABLE horses(id TEXT); CREATE TABLE jockeys(id TEXT); CREATE TABLE trainers(id TEXT);
CREATE TABLE horse_form_records(id TEXT, race_date TEXT); CREATE TABLE horse_trackwork(id TEXT, trackwork_date TEXT);
CREATE TABLE dividends(id TEXT); CREATE TABLE horse_injury(id TEXT, injury_date TEXT);
CREATE TABLE trial_sessions(id TEXT, trial_date TEXT); CREATE TABLE trial_runners(id TEXT);
CREATE TABLE running_comments(id TEXT); CREATE TABLE odds_snapshots(id TEXT); CREATE TABLE odds_archive(id TEXT);
`);
// 3 meetings (one future fixture with no results), 2 + 1 races with results.
sqlite.exec(`INSERT INTO race_meetings VALUES ('m1','2016-01-01','ST'),('m2','2026-10-21','HV'),('m3','2026-10-25','ST');
INSERT INTO races VALUES ('r1','m1',1),('r2','m1',2),('r3','m2',1),('r4','m3',1);
INSERT INTO race_results VALUES ('a','r1','h1'),('b','r1','h2'),('c','r2','h1'),('d','r3','h3');
INSERT INTO horses VALUES ('h1'),('h2'),('h3'); INSERT INTO jockeys VALUES ('j1'); INSERT INTO trainers VALUES ('t1'),('t2');
INSERT INTO horse_form_records VALUES ('f1','2026-10-21'); INSERT INTO horse_trackwork VALUES ('w1','2026-10-20'),('w2','2026-10-22');
INSERT INTO dividends VALUES ('d1'),('d2'); INSERT INTO horse_injury VALUES ('i1','2026-10-01');
INSERT INTO trial_sessions VALUES ('s1','2026-10-14'); INSERT INTO trial_runners VALUES ('tr1'),('tr2');
INSERT INTO odds_archive VALUES ('o1'),('o2'),('o3'); INSERT INTO odds_snapshots VALUES ('l1');`);
// horse_sectional_times deliberately absent → reported missing, not fatal.

const now = Date.parse('2026-10-22T22:00:00Z');
const s = await computeDataStats(db, now);
assert.deepEqual([s.counts.raceDays, s.counts.races, s.counts.runnerResults], [2, 3, 4]); console.log('PASS core counts only count meetings/races with results (future fixture excluded)');
assert.deepEqual(s.range, { first: '2016-01-01', last: '2026-10-21' }); console.log('PASS range from results-backed meetings');
assert.equal(s.counts.horses, 3); assert.equal(s.counts.trainers, 2); assert.equal(s.counts.trackwork, 2); assert.equal(s.counts.dividends, 2);
assert.equal(s.counts.trialRunners, 2); assert.equal(s.counts.oddsArchive, 3); assert.equal(s.counts.oddsLive, 1); console.log('PASS exact per-table counts');
assert.equal(s.counts.sectionals, null); assert.deepEqual(s.missing, ['horse_sectional_times']); console.log('PASS missing table → null + listed, rest still served');
assert.equal(s.latest.trackwork, '2026-10-22'); assert.equal(s.latest.results, '2026-10-21'); console.log('PASS latest dates');

// Request path: no stored row → one compute, persisted.
resetDataStatsThrottle();
const first = await getDataStats(db, now);
assert.equal(first.state, 'computed'); assert.ok(await readStoredDataStats(db)); console.log('PASS cold miss computes once and stores');
// Next request reads exactly one row, no big-table scans.
reads = 0;
const second = await getDataStats(db, now + 60_000);
assert.equal(second.state, 'stored'); assert.equal(reads, 1); console.log('PASS warm request = 1 D1 read (no COUNT scans)');
// Stored row past max age → recompute (throttled per isolate).
sqlite.exec(`INSERT INTO race_results VALUES ('e','r3','h1')`);
resetDataStatsThrottle();
const later = now + DATA_STATS_MAX_AGE_MS + 1;
const third = await getDataStats(db, later);
assert.equal(third.state, 'computed'); assert.equal(third.stats?.counts.runnerResults, 5); console.log('PASS stale row recomputed with new counts');
// Core read failure never overwrites a good row; the request serves the stored copy as stale.
const good = await readStoredDataStats(db);
sqlite.exec('ALTER TABLE race_results RENAME TO race_results_x');
const later2 = later + DATA_STATS_MAX_AGE_MS + 1;
const failed = await getDataStats(db, later2);
assert.equal(failed.state, 'stale'); assert.deepEqual(await readStoredDataStats(db), good); console.log('PASS failed core read keeps stored stats, served as stale');
// Within the throttle window no further heavy recompute is attempted.
reads = 0;
const throttled = await getDataStats(db, later2 + 60_000);
assert.equal(throttled.state, 'stale'); assert.equal(reads, 1); console.log('PASS recompute throttled per isolate (1 read, no scans)');
const direct = await refreshDataStats(db, later2 + 5);
assert.equal(direct.counts.runnerResults, null); assert.deepEqual(await readStoredDataStats(db), good); console.log('PASS refresh with broken core never persists');
// No stored row and no data → unavailable (route answers 503).
sqlite.exec('DELETE FROM public_data_stats'); resetDataStatsThrottle();
assert.equal((await getDataStats(db, later2)).state, 'unavailable'); console.log('PASS nothing stored + compute failed → unavailable');
console.log('data-stats tests passed');
