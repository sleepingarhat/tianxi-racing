// Regression tests for the 2026-10-22 freeze-ledger performance work.
// Run: bun scripts/test-freeze-ledger-perf.ts
import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { computeFreezeLedger, computeFreezeLedgerForDate, ledgerSnapshotEligible } from '../src/lib/freeze-ledger';
import { PREDICTION_COLUMNS, ensureRecoveryTables, recoverOriginalFreeze, recentlyVerifiedOriginal, assertOriginalFreezeReadable, FreezeBlockedError, resetRecoveryTablesMemo } from '../src/lib/freeze-recovery';
import { cachedJson, clearMemoryCache, jsonEtag } from '../src/lib/edge-cache';

function makeDb() {
  const sqlite = new Database(':memory:');
  let queries = 0;
  class Statement {
    params: any[] = [];
    constructor(public sql: string) {}
    bind(...params: any[]) { this.params = params; return this; }
    async all() { queries++; return { results: sqlite.query(this.sql).all(...this.params) }; }
    async first() { queries++; return sqlite.query(this.sql).get(...this.params) ?? null; }
    async run() { queries++; return sqlite.query(this.sql).run(...this.params); }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (stmts: Statement[]) => { queries++; return sqlite.transaction(() => stmts.map((s) => sqlite.query(s.sql).run(...s.params)))(); },
  } as any;
  const text = new Set(['date', 'horse_id', 'engine', 'variant', 'elo_source', 'generated_at', 'lgb_model_version', 'score_source', 'factor_scores', 'pace_estimate']);
  const ints = new Set(['race_number', 'horse_number', 'draw', 'predicted_rank']);
  sqlite.exec(`
    CREATE TABLE prediction_log(${PREDICTION_COLUMNS.map((c) => c + ' ' + (text.has(c) ? 'TEXT' : ints.has(c) ? 'INTEGER' : 'REAL')).join(',')}, PRIMARY KEY(date,race_number,horse_id,engine,variant));
    CREATE TABLE prediction_lock_meta(date TEXT, engine TEXT, venue TEXT, written_at TEXT, PRIMARY KEY(date,engine));
    CREATE TABLE entries_upcoming(race_date TEXT, venue TEXT, race_number INTEGER, horse_id TEXT, horse_number INTEGER, priority_order TEXT, post_time TEXT);
    CREATE TABLE race_meetings(id INTEGER PRIMARY KEY, date TEXT, venue TEXT);
    CREATE TABLE races(id INTEGER PRIMARY KEY, meeting_id INTEGER, race_number INTEGER);
    CREATE TABLE race_results(race_id INTEGER, horse_number INTEGER, finishing_position INTEGER, win_odds REAL);
    CREATE TABLE lock_completion_log(date TEXT, engine TEXT, done_at TEXT, rows_written INTEGER, PRIMARY KEY(date,engine));
    CREATE TABLE odds_archive(id TEXT PRIMARY KEY, race_date TEXT, venue TEXT, race_number INTEGER, pool_type TEXT, combination TEXT, odds REAL, snapshot_at TEXT, source_commit TEXT);
    CREATE TABLE odds_snapshots(id TEXT PRIMARY KEY, race_date TEXT, venue TEXT, race_number INTEGER, pool_type TEXT, combination TEXT, odds REAL, snapshot_at TEXT, source_commit TEXT);
  `);
  return { sqlite, db, count: () => queries, reset: () => { queries = 0; } };
}

let meetingId = 0, raceId = 0;
function seedMeeting(sqlite: Database, date: string, venue: string, races: number, opts: { results?: boolean } = {}) {
  const mid = ++meetingId;
  sqlite.query('INSERT INTO race_meetings VALUES(?,?,?)').run(mid, date, venue);
  const firstPost = `${date}T05:00:00.000Z`;
  for (let rn = 1; rn <= races; rn++) {
    const rid = ++raceId;
    sqlite.query('INSERT INTO races VALUES(?,?,?)').run(rid, mid, rn);
    for (let h = 1; h <= 6; h++) {
      const row: any = Object.fromEntries(PREDICTION_COLUMNS.map((c) => [c, null]));
      Object.assign(row, { date, race_number: rn, horse_id: `H${rn}_${h}`, engine: 'v12', variant: 'baseline', horse_number: h, predicted_rank: h, final_score: 1500 - h, p_win: (7 - h) / 21, generated_at: `${date}T03:20:00.000Z` });
      sqlite.query(`INSERT INTO prediction_log(${PREDICTION_COLUMNS.join(',')}) VALUES(${PREDICTION_COLUMNS.map(() => '?').join(',')})`).run(...PREDICTION_COLUMNS.map((c) => row[c]));
      sqlite.query('INSERT INTO entries_upcoming VALUES(?,?,?,?,?,?,?)').run(date, venue, rn, row.horse_id, h, '正選', firstPost);
      // finishing order: rotate so intersections vary by race
      if (opts.results !== false) sqlite.query('INSERT INTO race_results VALUES(?,?,?,?)').run(rid, h, ((h + rn - 2) % 6) + 1, 2 + h);
      sqlite.query('INSERT INTO odds_archive VALUES(?,?,?,?,?,?,?,?,?)').run(`${date}-${rn}-${h}-a`, date, venue, rn, 'PLA', String(h), 1.5 + h, `${date}T04:00:00Z`, null);
      sqlite.query('INSERT INTO odds_archive VALUES(?,?,?,?,?,?,?,?,?)').run(`${date}-${rn}-${h}-b`, date, venue, rn, 'PLA', String(h), 1.4 + h, `${date}T04:30:00Z`, null);
    }
  }
  sqlite.query('INSERT INTO prediction_lock_meta VALUES(?,?,?,?)').run(date, 'v12', venue, `${date}T03:20:00.000Z`);
}

const NOW = Date.parse('2026-08-20T04:00:00Z');
const { sqlite, db, count, reset } = makeDb();
seedMeeting(sqlite, '2026-08-02', 'ST', 3);
seedMeeting(sqlite, '2026-08-05', 'HV', 2);
seedMeeting(sqlite, '2026-08-09', 'ST', 2);
seedMeeting(sqlite, '2026-08-19', 'HV', 2); // too recent to snapshot (< 2 HKT days)
await ensureRecoveryTables(db);

// 1. Per-meeting isolation: one blocked meeting no longer fails the whole ledger.
sqlite.query(`INSERT INTO prediction_recovery_status(date,engine,checked_at,ok,action,restored,error) VALUES(?,?,?,?,?,?,?)`).run('2026-08-05', 'v12', '2026-08-05T04:00:00Z', 0, 'blocked', 0, 'original-hash-mismatch');
const first = await computeFreezeLedger(db, { since: '2026-08-01', now: NOW });
assert.equal(first.meetings.length, 4);
const blocked = first.meetings.find((m) => m.date === '2026-08-05')!;
assert.equal(blocked.source, 'blocked');
assert.equal(blocked.blockedReason, 'original-hash-mismatch');
assert.equal(blocked.racesEvaluated, 0);
assert.equal(first.season.meetings, 3);
assert.equal(first.snapshot.blocked, 1);
console.log('PASS blocked meeting isolated; other meetings still graded');

// 2. Live results identical to the per-date function (concurrency changes nothing).
for (const m of first.meetings) assert.deepEqual(m, await computeFreezeLedgerForDate(db, m.date, 'v12'));
console.log('PASS concurrent ledger == per-date compute');

// 3. Snapshot table absent → live compute, nothing written, no throw.
assert.equal(first.snapshot.hits, 0);
assert.equal(first.snapshot.written, 0);
console.log('PASS works before migration (no snapshot table)');

// 4. Apply migration file, write-on-miss, then read back identically with far fewer queries.
sqlite.exec(await Bun.file(new URL('../src/db/migrations/20261022_freeze_ledger_meeting.sql', import.meta.url)).text());
const second = await computeFreezeLedger(db, { since: '2026-08-01', now: NOW });
assert.equal(second.snapshot.written, 2, JSON.stringify(second.snapshot)); // 08-02, 08-09 (08-05 blocked, 08-19 too recent)
reset();
const third = await computeFreezeLedger(db, { since: '2026-08-01', now: NOW });
const snapQueries = count();
assert.equal(third.snapshot.hits, 2);
assert.deepEqual(third.meetings, second.meetings);
assert.deepEqual(third.season, second.season);
assert.deepEqual(third.meetings, first.meetings);
reset();
await computeFreezeLedger(db, { since: '2026-08-01', now: NOW, useSnapshots: false });
const liveQueries = count();
assert.ok(snapQueries < liveQueries, `snapshot ${snapQueries} < live ${liveQueries}`);
console.log(`PASS snapshot read == live compute (queries: ${snapQueries} vs live ${liveQueries})`);

// 5. A snapshotted meeting that becomes blocked is not served from the snapshot.
sqlite.query(`INSERT INTO prediction_recovery_status(date,engine,checked_at,ok,action,restored,error) VALUES(?,?,?,?,?,?,?)`).run('2026-08-02', 'v12', '2026-08-20T00:00:00Z', 0, 'blocked', 0, 'lock-meta-conflict');
const fourth = await computeFreezeLedger(db, { since: '2026-08-01', now: NOW });
assert.equal(fourth.meetings.find((m) => m.date === '2026-08-02')!.source, 'blocked');
sqlite.query(`DELETE FROM prediction_recovery_status WHERE date='2026-08-02'`).run();
console.log('PASS blocked status overrides snapshot');

// 6. Eligibility: unsettled / recent / not graded meetings are never snapshotted.
const recent = first.meetings.find((m) => m.date === '2026-08-19')!;
assert.equal(ledgerSnapshotEligible(recent, NOW), false);
assert.equal(ledgerSnapshotEligible(recent, Date.parse('2026-08-21T16:00:00Z')), true);
assert.equal(ledgerSnapshotEligible({ ...recent, races: recent.races.map((r, i) => (i ? r : { ...r, runners: 0 })) }, Date.parse('2026-09-30T00:00:00Z')), false);
console.log('PASS snapshot eligibility (settled, >=2 HKT days, every race has results)');

// 7. Lock-tick shortcut + quiet re-checks.
{
  const { sqlite: s2, db: d2 } = makeDb();
  resetRecoveryTablesMemo();
  const date = '2026-10-19', lock = '2026-10-19T03:30:00.000Z';
  seedMeeting(s2, date, 'ST', 1, { results: false });
  const t0 = Date.parse(lock) + 60_000;
  // recoverOriginalFreeze captures only on the HKT day of the meeting
  let out = await recoverOriginalFreeze(d2, date, 'ST', lock, 'v12', t0);
  assert.equal(out.ok, true, JSON.stringify(out));
  const audits1 = (s2.query('SELECT COUNT(*) n FROM prediction_race_audit_history').get() as any).n;
  out = await recoverOriginalFreeze(d2, date, 'ST', lock, 'v12', t0 + 300_000);
  assert.equal(out.action, 'verified-original');
  const audits2 = (s2.query('SELECT COUNT(*) n FROM prediction_race_audit_history').get() as any).n;
  assert.equal(audits2, audits1, 'unchanged re-check must not append audit rows');
  const checkedAt = Date.parse((s2.query('SELECT checked_at FROM prediction_recovery_status').get() as any).checked_at);
  assert.equal(await recentlyVerifiedOriginal(d2, date, 'v12', checkedAt + 30 * 60_000), true);
  assert.equal(await recentlyVerifiedOriginal(d2, date, 'v12', checkedAt + 61 * 60_000), false, 'hourly re-check');
  s2.exec('DROP TRIGGER frozen_prediction_no_delete');
  s2.query(`DELETE FROM prediction_log WHERE horse_id='H1_6'`).run();
  assert.equal(await recentlyVerifiedOriginal(d2, date, 'v12', checkedAt + 60_000), false, 'row count change forces full check');
  await assert.rejects(() => assertOriginalFreezeReadable(d2, date, 'v12', checkedAt + 60_000), (e: unknown) => e instanceof FreezeBlockedError);
  out = await recoverOriginalFreeze(d2, date, 'ST', lock, 'v12', checkedAt + 120_000);
  assert.equal(out.restored, 1);
  const audits3 = (s2.query('SELECT COUNT(*) n FROM prediction_race_audit_history').get() as any).n;
  assert.ok(audits3 > audits2, 'changed state is audited');
  await assertOriginalFreezeReadable(d2, date, 'v12', checkedAt + 180_000);
  console.log('PASS lock tick: hourly re-verify, count change detected, quiet unchanged ticks, reader memo safe');
}

// 8. Edge cache helper: memory hit, 304 on matching ETag, non-cacheable never stored, SWR.
{
  clearMemoryCache();
  let computes = 0;
  const body = JSON.stringify({ a: 1 });
  const etag = await jsonEtag(body);
  const compute = async () => { computes++; return { body, etag, cacheControl: 'public, max-age=60', cacheable: true, freshMs: 1000, staleMs: 10_000 }; };
  const req = (h: Record<string, string> = {}) => new Request('https://x.test/api/analyze/freeze-ledger', { headers: h });
  let r = await cachedJson({ request: req(), key: 'k', compute, now: 0 });
  assert.equal(r.status, 200); assert.equal(r.headers.get('ETag'), etag); assert.equal(r.headers.get('X-Tx-Cache'), 'MISS');
  r = await cachedJson({ request: req({ 'If-None-Match': etag }), key: 'k', compute, now: Date.now() });
  assert.equal(r.status, 304); assert.equal(computes, 1);
  const deferred: Promise<unknown>[] = [];
  r = await cachedJson({ request: req(), key: 'k', compute, now: Date.now() + 5000, waitUntil: (p) => deferred.push(p) });
  assert.equal(r.headers.get('X-Tx-Cache'), 'STALE'); await Promise.all(deferred); assert.equal(computes, 2);
  let n = 0;
  const transient = async () => { n++; return { body, etag, cacheControl: 'no-store', cacheable: false, freshMs: 0, staleMs: 0 }; };
  await cachedJson({ request: req(), key: 't', compute: transient });
  await cachedJson({ request: req(), key: 't', compute: transient });
  assert.equal(n, 2);
  console.log('PASS edge cache: memory hit, ETag 304, stale-while-revalidate, no-store not cached');
}
console.log('freeze-ledger perf tests passed');
