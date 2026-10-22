#!/usr/bin/env tsx
/**
 * End-to-end check of the D1 daily-sync gap fix (sectionals + barrier trials):
 * real import-csv / ingest → real push-delta → apply the emitted SQL, in the
 * workflow's FK order (and with its INSERT OR IGNORE rewrite), to a local SQLite
 * "D1" with foreign keys ON. Runs twice to prove re-runs never duplicate.
 */
import Database from 'better-sqlite3';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSchema } from './ingest/lib/db';
import { remoteColumns, missingColumns } from './d1-schema-guard';

const BACKEND = resolve(__dirname, '..');
const REPO = resolve(BACKEND, '..');
const DATE = '2026-10-21';
const tmp = mkdtempSync(join(tmpdir(), 'pd-sync-'));
const tsx = (args: string[]) => execFileSync('npx', ['tsx', ...args], { cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function freshD1(): Database.Database {
  const d1 = new Database(':memory:');
  ensureSchema(d1 as any, [join(BACKEND, 'src/db/schema.sql'), join(BACKEND, 'src/db/schema_v2.sql')]);
  d1.pragma('foreign_keys = ON');
  return d1;
}
/** Mirrors the workflow push loop: ORDER, and (when asked) the INSERT OR IGNORE rewrite. */
function apply(d1: Database.Database, dir: string, order: string[], orIgnore: (t: string) => boolean) {
  const files = readdirSync(dir);
  for (const t of order) {
    for (const f of files.filter((n) => n.startsWith(`${t}-`) && n.endsWith('.sql')).sort()) {
      let sql = readFileSync(join(dir, f), 'utf8');
      if (orIgnore(t)) sql = sql.replace(/^INSERT INTO /gm, 'INSERT OR IGNORE INTO ');
      d1.exec(sql);
    }
  }
}
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;
let n = 0;
const ok = (m: string) => { n++; console.log('PASS', m); };

// ── 1. Race sync: sectionals now reach D1 ───────────────────────────────────
const raceDb = join(tmp, 'race.db');
tsx(['scripts/import-csv.ts', '--data-dir', join(REPO, 'data'), '--db', raceDb, '--date', DATE]);
const local = new Database(raceDb, { readonly: true });
const localSect = count(local, `SELECT COUNT(*) n FROM horse_sectional_times`);
assert.ok(localSect > 100, `import-csv should load sectionals (${localSect})`);
const raceOut = join(tmp, 'race-delta');
tsx(['scripts/push-delta.ts', `--db=${raceDb}`, `--since=${DATE}`, '--include=race', `--out=${raceOut}`]);
assert.ok(readdirSync(raceOut).some((f) => f.startsWith('horse_sectional_times-')), 'race plan must emit horse_sectional_times');
ok(`race plan emits horse_sectional_times (${localSect} local rows)`);

const RACE_ORDER = ['horses', 'jockeys', 'trainers', 'race_meetings', 'races', 'race_results', 'horse_sectional_times', 'running_comments', 'dividends', 'horse_elo_snapshots', 'jockey_elo_snapshots', 'trainer_elo_snapshots'];
const d1 = freshD1();
apply(d1, raceOut, RACE_ORDER, () => true);
assert.equal(count(d1, `SELECT COUNT(*) n FROM horse_sectional_times`), localSect);
assert.equal(count(d1, `SELECT COUNT(*) n FROM horse_sectional_times hst LEFT JOIN races r ON r.id = hst.race_id LEFT JOIN horses h ON h.id = hst.horse_id WHERE r.id IS NULL OR h.id IS NULL`), 0);
ok('sectionals land in D1 with FK parents resolved (FK ON)');
apply(d1, raceOut, RACE_ORDER, () => true);
assert.equal(count(d1, `SELECT COUNT(*) n FROM horse_sectional_times`), localSect);
ok('re-running the race push does not duplicate sectionals');
// Same natural key under a different surrogate id (legacy row) → ignored, not duplicated.
const one = d1.prepare(`SELECT * FROM horse_sectional_times LIMIT 1`).get() as Record<string, unknown>;
d1.prepare(`DELETE FROM horse_sectional_times WHERE id = ?`).run(one.id);
d1.prepare(`INSERT INTO horse_sectional_times (id, race_id, horse_id, section_number, section_time, position_at_section) VALUES ('legacy_x', ?, ?, ?, ?, ?)`).run(one.race_id, one.horse_id, one.section_number, one.section_time, one.position_at_section);
apply(d1, raceOut, RACE_ORDER, () => true);
assert.equal(count(d1, `SELECT COUNT(*) n FROM horse_sectional_times`), localSect);
ok('legacy row with same (race, horse, section) but other id is not duplicated');

// ── 2. One-off sectional backfill mode ──────────────────────────────────────
const d1b = freshD1();
apply(d1b, raceOut, RACE_ORDER.filter((t) => t !== 'horse_sectional_times'), () => true); // D1 has races/horses, no sectionals
// Drop one horse's parents to prove the D1-side guard skips instead of failing the batch.
const victim = (d1b.prepare(`SELECT horse_id FROM race_results LIMIT 1`).get() as { horse_id: string }).horse_id;
d1b.pragma('foreign_keys = OFF'); d1b.prepare(`DELETE FROM horses WHERE id = ?`).run(victim); d1b.pragma('foreign_keys = ON');
const victimRows = count(local, `SELECT COUNT(*) n FROM horse_sectional_times WHERE horse_id = '${victim}'`);
const bfOut = join(tmp, 'bf-delta');
tsx(['scripts/push-delta.ts', `--db=${raceDb}`, `--since=${DATE}`, `--until=${DATE}`, '--include=sectionals', '--batch-statements=10', `--out=${bfOut}`]);
const bfFiles = readdirSync(bfOut).filter((f) => f.endsWith('.sql'));
assert.ok(bfFiles.length >= 1 && bfFiles.every((f) => f.startsWith('horse_sectional_times-')), 'backfill emits only sectionals');
assert.ok(!readFileSync(join(bfOut, bfFiles[0]), 'utf8').includes('DO UPDATE'), 'backfill is insert-only');
apply(d1b, bfOut, ['horse_sectional_times'], () => false); // no rewrite needed: DO NOTHING + guard
assert.equal(count(d1b, `SELECT COUNT(*) n FROM horse_sectional_times`), localSect - victimRows);
apply(d1b, bfOut, ['horse_sectional_times'], () => false);
assert.equal(count(d1b, `SELECT COUNT(*) n FROM horse_sectional_times`), localSect - victimRows);
ok(`backfill: insert-only, batched, idempotent; ${victimRows} rows of a horse missing in D1 skipped (no FK failure)`);

// ── 3. Pool A: barrier trials ───────────────────────────────────────────────
const dataDir = join(tmp, 'repo');
mkdirSync(join(dataDir, 'trials'), { recursive: true });
for (const f of ['trial_sessions.csv', 'trial_results.csv']) copyFileSync(join(REPO, 'trials', f), join(dataDir, 'trials', f));
const poolDb = join(tmp, 'pool.db');
tsx(['scripts/ingest/index.ts', 'trials', `--data-dir=${dataDir}`, `--db=${poolDb}`]);
const pl = new Database(poolDb, { readonly: true });
const SINCE = '2026-09-01';
const localSessions = count(pl, `SELECT COUNT(*) n FROM trial_sessions WHERE trial_date >= '${SINCE}'`);
const localRunners = count(pl, `SELECT COUNT(*) n FROM trial_runners WHERE session_id IN (SELECT id FROM trial_sessions WHERE trial_date >= '${SINCE}')`);
assert.ok(localSessions > 0 && localRunners > 0, 'trials ingested');
const poolOut = join(tmp, 'pool-delta');
tsx(['scripts/push-delta.ts', `--db=${poolDb}`, `--since=${SINCE}`, '--include=pool-a', `--out=${poolOut}`]);
const POOL_ORDER = ['horses', 'horse_profile_extra', 'horse_trackwork', 'horse_injury', 'horse_form_records', 'trial_sessions', 'trial_runners'];
const d1p = freshD1();
// D1 knows only some of the trial horses (canonical ids); the rest must be skipped safely.
const codes = (pl.prepare(`SELECT DISTINCT horse_id AS c FROM trial_runners WHERE session_id IN (SELECT id FROM trial_sessions WHERE trial_date >= '${SINCE}') ORDER BY horse_id`).all() as { c: string }[]).map((r) => r.c);
const known = codes.filter((_, i) => i % 2 === 0);
const ins = d1p.prepare(`INSERT INTO horses (id, code, name_en) VALUES (?, ?, ?)`);
for (const c of known) ins.run(`horse_${c}`, c, c);
const expectedRunners = count(pl, `SELECT COUNT(*) n FROM trial_runners WHERE session_id IN (SELECT id FROM trial_sessions WHERE trial_date >= '${SINCE}') AND horse_id IN (${known.map((c) => `'${c}'`).join(',')})`);
const trialIgnore = (t: string) => t.startsWith('trial_');
apply(d1p, poolOut, POOL_ORDER, trialIgnore);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_sessions`), localSessions);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_runners`), expectedRunners);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_runners WHERE horse_id NOT LIKE 'horse_%'`), 0);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_sessions WHERE trial_date < '${SINCE}'`), 0);
ok(`trials: ${localSessions} sessions (trial_date >= since) + ${expectedRunners}/${localRunners} runners with known horses; horse_id prefixed; unknown horses skipped`);
apply(d1p, poolOut, POOL_ORDER, trialIgnore);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_sessions`), localSessions);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_runners`), expectedRunners);
ok('re-running the pool-a push does not duplicate trials');
// Horse registered later → next run picks up its runners.
for (const c of codes.filter((_, i) => i % 2 === 1)) ins.run(`horse_${c}`, c, c);
apply(d1p, poolOut, POOL_ORDER, trialIgnore);
assert.equal(count(d1p, `SELECT COUNT(*) n FROM trial_runners`), localRunners);
ok('skipped runners are filled in on a later run once the horse exists');
// --trials-since widens only the trial window (one-off backfill) without widening trackwork/form.
const wideOut = join(tmp, 'pool-wide');
tsx(['scripts/push-delta.ts', `--db=${poolDb}`, '--since=2026-10-20', `--trials-since=${SINCE}`, '--include=pool-a', `--out=${wideOut}`]);
const d1w = freshD1();
for (const c of codes) d1w.prepare(`INSERT INTO horses (id, code, name_en) VALUES (?, ?, ?)`).run(`horse_${c}`, c, c);
apply(d1w, wideOut, POOL_ORDER, trialIgnore);
assert.equal(count(d1w, `SELECT COUNT(*) n FROM trial_sessions`), localSessions);
assert.equal(count(d1w, `SELECT COUNT(*) n FROM trial_runners`), localRunners);
ok('--trials-since widens only the trials window');

assert.ok(existsSync(raceDb));
console.log(`push-delta sync tests passed (${n} checks)`);

// ── 4. Schema guard used by the workflows before pushing the new tables ─────
const pragma = JSON.stringify([{ results: [{ cid: 0, name: 'id' }, { cid: 1, name: 'session_id' }], success: true }]);
assert.deepEqual(remoteColumns(pragma), ['id', 'session_id']);
assert.deepEqual(missingColumns(['id', 'session_id', 'horse_id'], remoteColumns(pragma)), ['horse_id']);
assert.deepEqual(remoteColumns(JSON.stringify([{ results: [], success: true }])), []);
console.log('PASS d1-schema-guard parses wrangler PRAGMA JSON and reports missing columns');
