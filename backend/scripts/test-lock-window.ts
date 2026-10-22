import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { findMeetingForLockTick, selectMeetingForLockTick, getMeetingLockState } from '../src/lib/lock-window';

// D1-shaped wrapper over bun:sqlite (same pattern as test-freeze-recovery.ts).
const sqlite = new Database(':memory:');
class Statement {
  params: any[] = [];
  constructor(public sql: string) {}
  bind(...params: any[]) { this.params = params; return this; }
  async all() { return { results: sqlite.query(this.sql).all(...this.params) }; }
  async first() { return sqlite.query(this.sql).get(...this.params); }
  async run() { return sqlite.query(this.sql).run(...this.params); }
}
const db = { prepare: (sql: string) => new Statement(sql) } as any;
sqlite.exec(`CREATE TABLE entries_upcoming(race_date TEXT, venue TEXT, race_number INTEGER, horse_id TEXT, post_time TEXT)`);

const hk = (s: string) => Date.parse(`${s}+08:00`);
function addMeeting(date: string, venue: string, times: string[]) {
  times.forEach((t, i) => {
    for (const h of ['A', 'B', 'C']) {
      sqlite.query('INSERT INTO entries_upcoming VALUES (?,?,?,?,?)').run(date, venue, i + 1, `${date}-${i + 1}-${h}`, `${date}T${t}:00+08:00`);
    }
  });
}
// Night meeting: Wed 2026-10-21 Happy Valley, 18:40 → 22:55 HKT.
addMeeting('2026-10-21', 'HV', ['18:40', '19:10', '19:40', '20:10', '20:40', '21:10', '21:45', '22:20', '22:55']);
// Day meeting: Sun 2026-10-25 Sha Tin, 12:30 → 17:40 HKT.
addMeeting('2026-10-25', 'ST', ['12:30', '13:00', '13:30', '14:05', '14:40', '15:15', '15:50', '16:25', '17:00', '17:40']);
// Cancelled fixture must never be selected.
addMeeting('2026-09-19', 'ST', ['13:00']);

const at = async (s: string) => (await findMeetingForLockTick(db, hk(s)))?.date ?? null;
let n = 0;
const ok = (label: string) => { n++; console.log('PASS', label); };

// ── Night meeting 10-21 HV ──
assert.equal(await at('2026-10-21T12:00:00'), '2026-10-21'); ok('HV: morning of race day is current');
const hv = await findMeetingForLockTick(db, hk('2026-10-21T20:00:00'));
assert.deepEqual(hv, { date: '2026-10-21', venue: 'HV', firstPostAt: '2026-10-21T18:40:00+08:00' }); ok('HV: firstPostAt is the TRUE first post (not a later race)');
assert.equal(await at('2026-10-21T23:30:00'), '2026-10-21'); ok('HV: after last race (22:55) still current');
assert.equal(await at('2026-10-21T23:59:59'), '2026-10-21'); ok('HV: just before HKT midnight still current');
assert.equal(await at('2026-10-22T00:00:01'), '2026-10-21'); ok('HV: just after HKT midnight still current');
assert.equal(await at('2026-10-22T02:39:59'), '2026-10-21'); ok('HV: 1s before first post + 8h (02:40 HKT) still current');
assert.equal(await at('2026-10-22T02:40:00'), '2026-10-21'); ok('HV: exactly first post + 8h still current (inclusive)');
assert.equal(await at('2026-10-22T02:40:01'), '2026-10-25'); ok('HV: after 02:40 HKT rolls to next meeting (10-25 ST)');
// Regression: old lexicographic +08:00-vs-Z compare kept 10-21 until last race + 16h (10-22 14:55 HKT).
assert.equal(await at('2026-10-22T13:45:00'), '2026-10-25'); ok('HV: 10-22 13:45 HKT (bug report time) no longer current');
assert.equal(await at('2026-10-22T14:54:00'), '2026-10-25'); ok('HV: old buggy boundary (10-22 14:55 HKT) no longer current');

// ── Day meeting 10-25 ST ──
assert.equal(await at('2026-10-25T00:00:00'), '2026-10-25'); ok('ST: HKT midnight of race day is current');
const lock = await getMeetingLockState(db, '2026-10-25', 'ST', { now: hk('2026-10-25T10:59:59') });
assert.equal(lock.locked, false); assert.equal(lock.lockAt, '2026-10-25T03:00:00.000Z'); ok('ST: lockAt = 11:00 HKT (T-90), unlocked 1s before');
assert.equal((await getMeetingLockState(db, '2026-10-25', 'ST', { now: hk('2026-10-25T11:00:00') })).locked, true); ok('ST: locked at exactly T-90');
assert.equal(await at('2026-10-25T17:40:00'), '2026-10-25'); ok('ST: last race 17:40 still current');
assert.equal(await at('2026-10-25T20:30:00'), '2026-10-25'); ok('ST: exactly first post + 8h (20:30 HKT) still current');
assert.equal(await at('2026-10-25T20:30:01'), null); ok('ST: after 20:30 HKT no fixture (nothing later loaded)');
assert.equal(await at('2026-10-26T01:00:00'), null); ok('ST: after HKT midnight not current (old bug kept it until 10-26 09:40 HKT)');

// ── Pure selector robustness ──
assert.deepEqual(
  selectMeetingForLockTick([
    { date: '2026-10-21', venue: 'HV', post_time: '2026-10-21T10:40:00Z' }, // same instant as 18:40+08:00, UTC form
    { date: '2026-10-21', venue: 'HV', post_time: '2026-10-21T22:55:00+08:00' },
  ], hk('2026-10-22T02:30:00')),
  { date: '2026-10-21', venue: 'HV', firstPostAt: '2026-10-21T10:40:00Z' },
); ok('selector: mixed Z / +08:00 inputs compared as instants');
assert.equal(selectMeetingForLockTick([{ date: '2026-10-21', venue: 'HV', post_time: 'garbage' }], hk('2026-10-21T12:00:00')), null); ok('selector: unparseable post_time ignored');
assert.equal(selectMeetingForLockTick([{ date: '2026-09-19', venue: 'ST', post_time: '2026-09-19T13:00:00+08:00' }], hk('2026-09-19T10:00:00')), null); ok('selector: cancelled meeting ignored');

console.log(`ALL ${n} lock-window checks passed`);
