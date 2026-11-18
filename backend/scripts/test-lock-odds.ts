// Lock-time odds: only pre-lock prices, append-only, fingerprint verified on read.
// Run: bun scripts/test-lock-odds.ts
import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { captureLockOdds, readLockOdds, pickLockRows, summariseLockRows } from '../src/lib/lock-odds';

function makeDb() {
  const sqlite = new Database(':memory:');
  class Statement {
    params: any[] = [];
    constructor(public sql: string) {}
    bind(...params: any[]) { this.params = params; return this; }
    async all() { return { results: sqlite.query(this.sql).all(...this.params) }; }
    async first() { return sqlite.query(this.sql).get(...this.params) ?? null; }
    async run() { return sqlite.query(this.sql).run(...this.params); }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (stmts: Statement[]) => sqlite.transaction(() => stmts.map((s) => sqlite.query(s.sql).run(...s.params)))(),
  } as any;
  sqlite.exec(`CREATE TABLE odds_snapshots (id TEXT PRIMARY KEY, race_date TEXT, venue TEXT, race_number INTEGER, pool_type TEXT, combination TEXT, odds REAL, snapshot_at TEXT, source_commit TEXT);`);
  return { db, sqlite };
}

const LOCK = '2026-11-18T09:10:00.000Z';
const { db, sqlite } = makeDb();
const ins = sqlite.query('INSERT INTO odds_snapshots VALUES (?,?,?,?,?,?,?,?,NULL)');
let id = 0;
const add = (race: number, pool: string, combo: string, odds: number | null, at: string) => ins.run(String(++id), '2026-11-18', 'HV', race, pool, combo, odds, at);
// Race 1: three snapshots; the 09:10:15 one is after lock and must be ignored.
add(1, 'WIN', '01', 5.0, '2026-11-18T08:55:15.000Z');
add(1, 'WIN', '01', 4.2, '2026-11-18T09:05:15.000Z');
add(1, 'WIN', '01', 2.1, '2026-11-18T09:10:15.000Z');
add(1, 'WIN', '02', 3.0, '2026-11-18T09:05:15.000Z');
add(1, 'WIN', '03', 9.0, '2026-11-18T09:05:15.000Z');
add(1, 'WIN', '04', null, '2026-11-18T09:05:15.000Z'); // scratched: kept, excluded from favourites
add(1, 'WIN', '05', 12.0, '2026-11-18T09:05:15.000Z');
add(1, 'WIN', '06', 12.0, '2026-11-18T09:05:15.000Z');
add(1, 'PLA', '01', 1.6, '2026-11-18T09:05:15.000Z');
add(1, 'QIN', '01-02', 8.0, '2026-11-18T09:05:15.000Z'); // other pools are not lock-odds
// Race 2: last pre-lock snapshot 40 minutes old → partial.
add(2, 'WIN', '01', 6.0, '2026-11-18T08:30:00.000Z');

// Pure selection: post-lock row ignored, keys normalised.
const picked = pickLockRows(sqlite.query('SELECT race_number, pool_type, combination, odds, snapshot_at FROM odds_snapshots').all() as any, LOCK);
assert.equal(picked.find((r) => r.race_number === 1 && r.pool_type === 'WIN' && r.combination === '1')?.odds, 4.2, 'latest pre-lock price, not the post-lock 2.1');
assert.ok(!picked.some((r) => r.pool_type === 'QIN'), 'only WIN/PLA');
assert.deepEqual(summariseLockRows(picked, LOCK).stale, [2], 'race 2 older than 20 minutes at lock');

// Capture before lock is refused.
const early = await captureLockOdds(db, '2026-11-18', 'HV', LOCK, new Date('2026-11-18T09:00:00Z'));
assert.equal(early.ok, false);
assert.equal(early.error, 'before-lock');

// Capture after lock (even hours late) still only keeps pre-lock prices.
const first = await captureLockOdds(db, '2026-11-18', 'HV', LOCK, new Date('2026-11-18T13:00:00Z'));
assert.equal(first.action, 'captured');
assert.equal(first.status, 'partial');
assert.equal(first.rows, 8);
assert.match(String(first.sha256), /^[0-9a-f]{64}$/);

// Append-only: a later capture (with new odds rows arriving) does not change anything.
add(1, 'WIN', '07', 1.5, '2026-11-18T09:09:00.000Z');
const second = await captureLockOdds(db, '2026-11-18', 'HV', LOCK, new Date('2026-11-18T14:00:00Z'));
assert.equal(second.action, 'already-captured');
assert.equal(second.sha256, first.sha256);
assert.equal((sqlite.query('SELECT COUNT(*) n FROM lock_odds_snapshots').get() as any).n, 8);

// Read-back verifies the fingerprint and orders favourites by lock-time WIN odds.
const read = await readLockOdds(db, '2026-11-18', 'HV');
assert.equal(read.verified, true);
const race1 = read.races.find((r: any) => r.raceNumber === 1);
assert.deepEqual(race1.marketTop4, [2, 1, 3, 5], 'lowest odds first; tie 5/6 keeps horse-number order; scratched 4 excluded');

// Tampering is detected.
sqlite.query(`UPDATE lock_odds_snapshots SET odds = 99 WHERE race_number = 1 AND combination = '2' AND pool_type = 'WIN'`).run();
assert.equal((await readLockOdds(db, '2026-11-18', 'HV')).verified, false, 'edited row fails verification');

// No odds at all → manifest says missing (honest, no fabricated rows).
const empty = makeDb();
const none = await captureLockOdds(empty.db, '2026-11-22', 'ST', '2026-11-22T03:00:00.000Z', new Date('2026-11-22T03:05:00Z'));
assert.equal(none.status, 'missing');
assert.equal(none.rows, 0);
assert.equal((await readLockOdds(empty.db, '2026-11-22')).manifest?.status, 'missing');

console.log('test-lock-odds: all assertions passed');
