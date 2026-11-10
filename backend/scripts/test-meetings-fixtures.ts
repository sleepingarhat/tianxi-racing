#!/usr/bin/env tsx
/**
 * Month/day meetings read official fixtures and entries lists.
 * Completed cards keep ratingRange and do not report 排位體重 as weight.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { meetingsRoutes } from '../src/routes/meetings';
import { bodyPounds, cardDeltas, carriedPounds, publicWeights, resolveCardStatus } from '../src/lib/meeting-card';
import type { Env } from '../src/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

class Stmt {
  private params: unknown[] = [];
  constructor(private readonly db: Database.Database, private readonly sql: string) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[] }; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null; }
}
class D1 {
  constructor(private readonly db: Database.Database) {}
  prepare(sql: string) { return new Stmt(this.db, sql); }
}

function csvMonth(month: string): Array<{ date: string; venue: string; timing: string; race_count: string; surface: string; weekday: string }> {
  const lines = readFileSync(join(root, 'data/fixtures/fixtures.csv'), 'utf8').trim().split(/\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((name, index) => { row[name] = cells[index] ?? ''; });
    return row as { date: string; venue: string; timing: string; race_count: string; surface: string; weekday: string };
  }).filter((row) => row.date.startsWith(month));
}

assert.equal(carriedPounds(1208), null);
assert.equal(bodyPounds(1208), 1208);
assert.deepEqual(publicWeights('results', { actual_weight: 126, declared_weight: 1208 }), {
  weight: 126, bodyWeight: 1208, declaredWeight: null, actualWeight: 126,
});
assert.equal(publicWeights('upcoming', { declared_weight: 132, actual_weight: 125, body_weight: 1151 }).weight, 132);
assert.deepEqual(cardDeltas({ rating_change: -1, body_weight_change: 29, best_time: '1.42.43', days_since_run: 41, possible_overweight: 1, age_allowance: null }), {
  ratingChange: -1, bodyWeightChange: 29, bestTime: '1.42.43', daysSinceRun: 41, possibleOverweight: 1, ageAllowance: null,
});
assert.equal(cardDeltas({ rating_change: 0, body_weight_change: 0, best_time: '', days_since_run: null }).ratingChange, 0);
assert.equal(cardDeltas({ best_time: '1101' }).bestTime, null);
assert.equal(cardDeltas(null).daysSinceRun, null);
assert.equal(resolveCardStatus({ resulted: false, hasRaces: false, declaredRunners: 0, declaredDraws: 0, officialEntries: 3 }).cardStatus, 'entries');
assert.equal(resolveCardStatus({ resulted: false, hasRaces: false, declaredRunners: 0, declaredDraws: 0, officialEntries: 3 }).isDeclaredCard, false);
assert.equal(resolveCardStatus({ resulted: true, hasRaces: true, declaredRunners: 0, declaredDraws: 0, officialEntries: 0 }).cardStatus, 'resulted');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE race_meetings (id TEXT PRIMARY KEY, date TEXT, venue TEXT, track_condition TEXT, weather TEXT, total_races INTEGER);
  CREATE TABLE races (id TEXT PRIMARY KEY, meeting_id TEXT, race_number INTEGER, title TEXT, class TEXT, distance INTEGER,
    going TEXT, track TEXT, course TEXT, prize TEXT, rating_range TEXT, start_time TEXT, video_url TEXT);
  CREATE TABLE horses (id TEXT PRIMARY KEY, name_en TEXT, name_ch TEXT, code TEXT, sire TEXT, dam TEXT, dam_sire TEXT,
    current_rating INTEGER, age INTEGER, sex TEXT, import_type TEXT, season_stakes INTEGER);
  CREATE TABLE jockeys (id TEXT PRIMARY KEY, name_en TEXT, name_ch TEXT);
  CREATE TABLE trainers (id TEXT PRIMARY KEY, name_en TEXT, name_ch TEXT);
  CREATE TABLE race_results (id TEXT PRIMARY KEY, race_id TEXT, horse_id TEXT, horse_number INTEGER, finishing_position INTEGER,
    draw INTEGER, jockey_id TEXT, trainer_id TEXT, actual_weight REAL, declared_weight REAL, lbw TEXT, running_position TEXT,
    finish_time REAL, win_odds REAL, gear TEXT, race_class_rating INTEGER);
  CREATE TABLE entries_upcoming (id TEXT PRIMARY KEY, race_date TEXT, venue TEXT, race_number INTEGER, race_class TEXT,
    distance INTEGER, track TEXT, course TEXT, race_name TEXT, prize TEXT, rating_range TEXT, going TEXT,
    horse_id TEXT, horse_number INTEGER, horse_code TEXT, draw INTEGER, jockey_name TEXT, trainer_name TEXT,
    actual_weight REAL, declared_weight REAL, body_weight INTEGER, allowance REAL, international_rating INTEGER,
    last6run TEXT, silk_file TEXT, card_stage TEXT, gear TEXT, rating INTEGER, priority_order TEXT, post_time TEXT);
  CREATE TABLE official_fixtures (date TEXT, venue TEXT, weekday TEXT, timing TEXT, race_count INTEGER, surface TEXT, captured_at TEXT, PRIMARY KEY (date, venue));
  CREATE TABLE official_race_entries (
    race_date TEXT, venue TEXT, race_number INTEGER, horse_code TEXT, horse_name TEXT, trainer_name TEXT,
    race_class TEXT, distance INTEGER, track TEXT, rating_range TEXT, race_name TEXT, section_label TEXT,
    card_stage TEXT, draw_status TEXT, source_sha256 TEXT, scraped_at TEXT,
    PRIMARY KEY (race_date, venue, race_number, horse_code));
  CREATE TABLE horse_profile_extra (horse_id TEXT PRIMARY KEY, owner TEXT, import_type TEXT, season_stakes_int INTEGER);
  CREATE TABLE odds_snapshots (race_date TEXT, venue TEXT, race_number INTEGER, combination TEXT, odds REAL, snapshot_at TEXT, pool_type TEXT);

  INSERT INTO horses VALUES ('horse_A1','Alpha','阿爾法','A001','Sire','Dam','DamSire',80,5,'閹','自購馬',0);
  INSERT INTO horse_profile_extra VALUES ('horse_A1','某馬主','自購馬',250000);
  INSERT INTO race_meetings VALUES
    ('m1101','2026-11-01','HV','好地',NULL,10),
    ('m1104','2026-11-04','HV','好地',NULL,9),
    ('m1108','2026-11-08','ST','好地',NULL,11),
    ('m1111','2026-11-11','HV',NULL,NULL,9);
  INSERT INTO races VALUES ('race_1108','m1108',1,'某讓賽','第三班',1200,'好地','草地','A','1000000','80-60',NULL,NULL);
  INSERT INTO race_results VALUES ('rr1','race_1108','horse_A1',1,1,4,NULL,NULL,126,1208,NULL,NULL,NULL,NULL,'B',75);
`);

const insertFixture = db.prepare(`INSERT INTO official_fixtures (date, venue, weekday, timing, race_count, surface, captured_at)
  VALUES (?, ?, ?, ?, ?, ?, '2026-11-09T00:00:00Z')`);
const nov = csvMonth('2026-11');
const dec = csvMonth('2026-12');
assert.equal(nov.length, 9, 'fixtures.csv November 2026 official days');
assert.equal(dec.length, 8, 'fixtures.csv December 2026 official days');
for (const row of [...nov, ...dec]) {
  insertFixture.run(row.date, row.venue, row.weekday, row.timing, row.race_count ? Number(row.race_count) : null, row.surface);
}
db.prepare(`INSERT INTO official_race_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  '2026-11-14', 'ST', 1, 'K014', '玩笑', '伍鵬志', '第二班', 1200, '草地', '100-80', '樂聲盃（讓賽）', '1',
  'entries', 'unavailable', 'abc', '2026-11-10T10:00:00Z',
);

const app = new Hono<{ Bindings: Env }>();
app.route('/api/meetings', meetingsRoutes);
const env = { DB: new D1(db) } as Env;

async function get(path: string) {
  const res = await app.request(`http://localhost${path}`, {}, env);
  const body = await res.json() as any;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const november = await get('/api/meetings?month=2026-11&limit=40');
  assert.equal(november.status, 200);
  const novDates = november.body.meetings.map((m: any) => m.date).sort();
  assert.deepEqual(novDates, nov.map((row) => row.date).sort());
  const day14 = november.body.meetings.find((m: any) => m.date === '2026-11-14');
  assert.equal(day14.cardStatus, 'entries');
  assert.equal(day14.isDeclaredCard, false);
  assert.equal(day14.drawStatus, 'unavailable');
  assert.equal(day14.drawNote, '已報名，正式排位未公布');
  const day18 = november.body.meetings.find((m: any) => m.date === '2026-11-18');
  assert.equal(day18.cardStatus, 'fixture');
  assert.equal(day18.isDeclaredCard, false);
  assert.equal(day18.source, 'official_fixtures');
  const day08 = november.body.meetings.find((m: any) => m.date === '2026-11-08');
  assert.equal(day08.cardStatus, 'resulted');
  assert.equal(day08.id, 'm1108');

  const december = await get('/api/meetings?month=2026-12&limit=40');
  assert.deepEqual(
    december.body.meetings.map((m: any) => m.date).sort(),
    dec.map((row) => row.date).sort(),
  );
  assert.ok(december.body.meetings.every((m: any) => m.cardStatus === 'fixture' && m.isDeclaredCard === false));

  const missing = await get('/api/meetings/2026-11-02');
  assert.equal(missing.status, 404);

  const entries = await get('/api/meetings/2026-11-14');
  assert.equal(entries.status, 200, JSON.stringify(entries.body));
  assert.equal(entries.body.cardStatus, 'entries');
  assert.equal(entries.body.isDeclaredCard, false);
  assert.equal(entries.body.drawStatus, 'unavailable');
  assert.equal(entries.body.races.length, 1);
  assert.equal(entries.body.races[0].title, '樂聲盃（讓賽）');
  assert.equal(entries.body.races[0].ratingRange, '100-80');
  assert.equal(entries.body.races[0].isDeclaredCard, false);
  assert.equal(entries.body.races[0].horses[0].horseNumber, null);
  assert.equal(entries.body.races[0].horses[0].draw, null);
  assert.equal(entries.body.races[0].horses[0].nameCh, '玩笑');
  assert.equal(entries.body.races[0].horses[0].weight, null);

  const fixture = await get('/api/meetings/2026-11-18');
  assert.equal(fixture.status, 200);
  assert.equal(fixture.body.cardStatus, 'fixture');
  assert.deepEqual(fixture.body.races, []);
  assert.equal(fixture.body.isDeclaredCard, false);
  assert.equal(fixture.body.totalRaces, 9);

  const done = await get('/api/meetings/2026-11-08');
  assert.equal(done.status, 200);
  assert.equal(done.body.races[0].ratingRange, '80-60');
  assert.equal(done.body.races[0].horses[0].weight, 126);
  assert.equal(done.body.races[0].horses[0].bodyWeight, 1208);
  assert.equal(done.body.races[0].horses[0].owner, '某馬主');
  assert.equal(done.body.races[0].horses[0].importType, '自購馬');
  assert.equal(done.body.races[0].horses[0].seasonStakes, 250000);
  assert.equal(done.body.races[0].horses[0].age, 5);
  assert.notEqual(done.body.races[0].horses[0].weight, 1208);

  console.log('meetings fixture/entries tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
