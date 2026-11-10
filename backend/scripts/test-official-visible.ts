#!/usr/bin/env tsx
/** Public read shape for official boards already stored in D1. */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { officialVisibleRoutes } from '../src/routes/official-visible';

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

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE official_ove_record (
    meeting_date TEXT, venue TEXT, race_no INTEGER, line_no INTEGER, horse_no INTEGER, is_reserve INTEGER,
    horse_code TEXT, horse_name TEXT, injury_date TEXT, detail TEXT, passed_date TEXT, not_race_result INTEGER,
    source_sha256 TEXT, scraped_at TEXT
  );
  INSERT INTO official_ove_record VALUES (
    '2026-11-11','HV',1,1,1,0,'K308','電路一百','2026-10-01','賽後內窺鏡檢查發現氣管內有大量血液','2026-11-03',1,'abc','2026-11-10T12:49:56+00:00'
  );
  CREATE TABLE official_challenge_odds (
    pool TEXT, meeting_date TEXT, venue TEXT, winner_code TEXT, winner_name TEXT, points INTEGER,
    race_no INTEGER, odds_text TEXT, chart_updated_at TEXT, not_race_result INTEGER, source_sha256 TEXT, scraped_at TEXT
  );
  INSERT INTO official_challenge_odds VALUES (
    'jkc','2026-11-08','ST','AA','艾兆禮',40,0,'3.00','2026-11-08T18:03:00+08:00',1,'abc','2026-11-10T12:49:56+00:00'
  );
  CREATE TABLE official_jt_combo (
    meeting_date TEXT, venue TEXT, section TEXT, race_no INTEGER, horse_no INTEGER, horse_name TEXT,
    import_type TEXT, trainer_name TEXT, win_rate TEXT, place_rate TEXT, as_of_text TEXT,
    not_race_result INTEGER, source_sha256 TEXT, scraped_at TEXT
  );
  INSERT INTO official_jt_combo VALUES (
    '2026-11-11','HV','combo',1,1,NULL,NULL,NULL,'0.0000','0.0900','10/11/2026 12:00',1,'abc','2026-11-10T12:49:56+00:00'
  );
`);

async function main(): Promise<void> {
  const app = new Hono();
  app.route('/api/official', officialVisibleRoutes);
  const env = { DB: new D1(db) };

  const record = await app.request('/api/official/ove-record?date=2026-11-11&venue=HV', {}, env);
  assert.equal(record.status, 200);
  const recordBody = await record.json() as { source: string; rows: Array<{ horseCode: string; reserve: boolean; notRaceResult: boolean }> };
  assert.equal(recordBody.source, 'official_ove_record');
  assert.equal(recordBody.rows[0].horseCode, 'K308');
  assert.equal(recordBody.rows[0].reserve, false);
  assert.equal(recordBody.rows[0].notRaceResult, true);

  const odds = await app.request('/api/official/challenge-odds?pool=jkc&date=2026-11-08&venue=ST', {}, env);
  const oddsBody = await odds.json() as { rows: Array<{ oddsText: string; raceNo: number }> };
  assert.equal(oddsBody.rows[0].oddsText, '3.00');
  assert.equal(oddsBody.rows[0].raceNo, 0);

  const combo = await app.request('/api/official/jt-combo?date=2026-11-11&venue=HV&section=combo', {}, env);
  const comboBody = await combo.json() as { rows: Array<{ winRate: string; placeRate: string }> };
  assert.equal(comboBody.rows[0].winRate, '0.0000');
  assert.equal(comboBody.rows[0].placeRate, '0.0900');

  const bad = await app.request('/api/official/ove-record?date=11-11&venue=HV', {}, env);
  assert.equal(bad.status, 400);

  const missing = await app.request('/api/official/finish-photos?date=2026-11-08&venue=ST', {}, env);
  const missingBody = await missing.json() as { available: boolean; rows: unknown[] };
  assert.equal(missing.status, 200);
  assert.equal(missingBody.available, false);
  assert.deepEqual(missingBody.rows, []);

  console.log('official visible read api ok');
}

main();
