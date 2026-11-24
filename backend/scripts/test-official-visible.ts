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
  // The table above predates is_reserve: starters are served, flagged as not reserve.
  const legacyDebut = await app.request('/api/official/jt-combo?date=2026-11-11&venue=HV&includeReserve=1', {}, env);
  assert.equal(legacyDebut.status, 200);
  assert.equal(((await legacyDebut.json()) as { rows: Array<{ reserve: boolean }> }).rows[0].reserve, false);

  const reserveDb = new Database(':memory:');
  reserveDb.exec(`
    CREATE TABLE official_jt_combo (
      meeting_date TEXT, venue TEXT, section TEXT, race_no INTEGER, horse_no INTEGER, is_reserve INTEGER NOT NULL DEFAULT 0,
      horse_name TEXT, import_type TEXT, trainer_name TEXT, win_rate TEXT, place_rate TEXT, as_of_text TEXT,
      not_race_result INTEGER, source_sha256 TEXT, scraped_at TEXT
    );
    INSERT INTO official_jt_combo VALUES
      ('2026-11-18','HV','debut',7,6,0,'獅子精神','自購馬','徐雨石','0.0000','0.0700','17/11/2026 12:00',1,'abc','2026-11-18T06:00:00+00:00'),
      ('2026-11-18','HV','debut',7,2,1,'川河靈駒','自購馬','方嘉柏','0.1000','0.3000','17/11/2026 12:00',1,'abc','2026-11-18T06:00:00+00:00');
  `);
  const reserveEnv = { DB: new D1(reserveDb) };
  const starters = await app.request('/api/official/jt-combo?date=2026-11-18&venue=HV&section=debut', {}, reserveEnv);
  const startersBody = await starters.json() as { rows: Array<{ horseNo: number; reserve: boolean }> };
  assert.deepEqual(startersBody.rows.map((row) => [row.horseNo, row.reserve]), [[6, false]]);
  const withReserve = await app.request('/api/official/jt-combo?date=2026-11-18&venue=HV&section=debut&includeReserve=1', {}, reserveEnv);
  const withReserveBody = await withReserve.json() as { rows: Array<{ horseNo: number; reserve: boolean; horseName: string }> };
  assert.deepEqual(withReserveBody.rows.map((row) => [row.horseNo, row.reserve, row.horseName]), [[6, false, '獅子精神'], [2, true, '川河靈駒']]);

  const bad = await app.request('/api/official/ove-record?date=11-11&venue=HV', {}, env);
  assert.equal(bad.status, 400);

  const missing = await app.request('/api/official/finish-photos?date=2026-11-08&venue=ST', {}, env);
  const missingBody = await missing.json() as { available: boolean; rows: unknown[] };
  assert.equal(missing.status, 200);
  assert.equal(missingBody.available, false);
  assert.deepEqual(missingBody.rows, []);

  const statsMissing = await app.request('/api/official/stats-centre', {}, env);
  const statsMissingBody = await statsMissing.json() as { available: boolean; rows: unknown[] };
  assert.equal(statsMissing.status, 200);
  assert.equal(statsMissingBody.available, false);
  assert.deepEqual(statsMissingBody.rows, []);

  db.exec(`
    CREATE TABLE official_stats_centre_image (
      slot TEXT, poster_date TEXT, window_end TEXT, last_update TEXT, image_path TEXT,
      not_race_result INTEGER, source_sha256 TEXT, scraped_at TEXT
    );
    INSERT INTO official_stats_centre_image VALUES (
      'whos_hot','2026-11-11','2026-11-12T01:00:00+08:00','2026-11-10T12:00:00+08:00',
      'https://consvc.hkjc.com/-/media/Sites/JCRW/Page/stats_centre/202611/statcentre_hot_261111_ch.jpg?rev=aa&sc_lang=zh-HK',
      1,'abc','2026-11-10T00:00:00+00:00'
    );
    CREATE TABLE official_racecard_runner (
      meeting_date TEXT, venue TEXT, race_no INTEGER, horse_no INTEGER, is_reserve INTEGER,
      horse_id TEXT, brand_no TEXT, horse_name TEXT, age INTEGER, sex TEXT, season_stakes INTEGER,
      owner TEXT, sire TEXT, dam TEXT, import_type TEXT, not_race_result INTEGER, source_sha256 TEXT, scraped_at TEXT
    );
    INSERT INTO official_racecard_runner VALUES (
      '2026-11-11','HV',1,1,0,'HK_2024_K308','K308','電路一百',5,'閹',134550,'何燕生與曾建華','Zoustar','Reconstruct','PPG',1,'abc','2026-11-10T00:00:00+00:00'
    );
  `);
  const stats = await app.request('/api/official/stats-centre', {}, env);
  const statsBody = await stats.json() as { available: boolean; rows: Array<{ slot: string; posterDate: string; imagePath: string }> };
  assert.equal(stats.status, 200);
  assert.equal(stats.headers.get('cache-control'), 'public, max-age=120');
  assert.equal(statsBody.available, true);
  assert.equal(statsBody.rows[0].slot, 'whos_hot');
  assert.equal(statsBody.rows[0].posterDate, '2026-11-11');
  assert.match(statsBody.rows[0].imagePath, /statcentre_hot_261111_ch\.jpg/);

  const profile = await app.request('/api/official/racecard-profile?date=2026-11-11&venue=HV', {}, env);
  const profileBody = await profile.json() as { rows: Array<{ age: number; sex: string; seasonStakes: number; importType: string; reserve: boolean }> };
  assert.equal(profileBody.rows[0].age, 5);
  assert.equal(profileBody.rows[0].sex, '閹');
  assert.equal(profileBody.rows[0].seasonStakes, 134550);
  assert.equal(profileBody.rows[0].importType, 'PPG');
  assert.equal(profileBody.rows[0].reserve, false);

  db.exec(`
    CREATE TABLE official_fixture_line (
      meeting_date TEXT, venue TEXT, line_no INTEGER, class_code TEXT, distance INTEGER,
      race_count INTEGER, course_text TEXT, rating_band TEXT, not_race_result INTEGER,
      source_sha256 TEXT, scraped_at TEXT
    );
    INSERT INTO official_fixture_line VALUES
      ('2026-11-01','HV',1,'G3',1800,1,'-C',NULL,1,'abc','2026-11-24T16:00:00+00:00');
    CREATE TABLE official_same_sire (
      sire_name TEXT, line_no INTEGER, horse_name TEXT, retired INTEGER, wins INTEGER,
      seconds INTEGER, thirds INTEGER, starts INTEGER, winning_distance TEXT,
      not_race_result INTEGER, source_sha256 TEXT, scraped_at TEXT
    );
    INSERT INTO official_same_sire VALUES
      ('Zoustar',1,'好友精神 (已退役)',1,0,0,0,13,NULL,1,'abc','2026-11-24T16:00:00+00:00');
    CREATE TABLE official_wind_station (
      racecourse TEXT, location TEXT, observed_date TEXT, observed_time TEXT,
      wind_direction TEXT, wind_speed TEXT, gust_direction TEXT, gust_speed TEXT,
      humidity TEXT, temperature TEXT, rain_1min TEXT, rain_10min TEXT, rain_daily TEXT,
      soil_water TEXT, soil_loss_1min TEXT, soil_loss_daily TEXT, soil_loss_24h TEXT, is_valid INTEGER
    );
    INSERT INTO official_wind_station VALUES
      ('HV','E','2026-11-25','00:02:58.7','S14W','4','S6W','6','70','22.5','0','0',NULL,'12.5',NULL,NULL,NULL,1);
  `);
  const lines = await app.request('/api/official/fixture-lines?date=2026-11-01', {}, env);
  assert.equal(lines.status, 200);
  const lineBody = await lines.json() as { rows: { classCode: string; ratingBand: string | null }[] };
  assert.equal(lineBody.rows[0].classCode, 'G3');
  assert.equal(lineBody.rows[0].ratingBand, null);
  const sire = await app.request('/api/official/same-sire?sire=Zoustar', {}, env);
  assert.equal(sire.status, 200);
  const sireBody = await sire.json() as { rows: { horseName: string; retired: boolean; winningDistance: string | null }[] };
  assert.equal(sireBody.rows[0].horseName, '好友精神 (已退役)');
  assert.equal(sireBody.rows[0].retired, true);
  assert.equal(sireBody.rows[0].winningDistance, null);
  const wind = await app.request('/api/official/wind', {}, env);
  assert.equal(wind.status, 200);
  const windBody = await wind.json() as { stations: { windDirection: string; rainDaily: string | null }[] };
  assert.equal(windBody.stations[0].windDirection, 'S14W');
  assert.equal(windBody.stations[0].rainDaily, null);
  const badSire = await app.request('/api/official/same-sire', {}, env);
  assert.equal(badSire.status, 400);

  const badBoard = await app.request('/api/official/horse-ratings?board=made-up', {}, env);
  assert.equal(badBoard.status, 400);
  const badCard = await app.request('/api/official/racecard-files?date=2026-11-11', {}, env);
  assert.equal(badCard.status, 400);

  console.log('official visible read api ok');
}

main();
