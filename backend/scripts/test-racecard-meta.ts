#!/usr/bin/env tsx
/** RaceCard.aspx header parsing: turf, all-weather, identity gate, storage. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureSchema } from './ingest/lib/db.js';
import {
  meetingTrackCondition,
  parseRaceMeta,
  raceLevelAssignment,
  racecardPageUrl,
  RACECARD_HEADER_MISS_EXIT,
  trackLineUnparsed,
  type RaceMeta,
} from './ingest/lib/racecard-meta.js';
import {
  allEntriesOrLegacy,
  upcomingRaceHeaderView,
} from '../src/lib/upcoming-race-header.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TURF = `
<div class="f_fs13" style="line-height: 20px;"><span class="font_wb" />第 1 場 - 六福珠寶洛神水賦系列讓賽</span><br>2026年10月25日, 星期日, 沙田, 12:40<br>草地, "A" 賽道, 1200米, 好地<br>獎金: $1,170,000, 評分: 60-40, 第四班（條件限制）</div>
`;

const AWT = `
<div class="f_fs13" style="line-height: 20px;"><span class="font_wb">第 1 場 - 畫眉山讓賽</span><br>2026年10月28日, 星期三, 沙田, 18:45<br>全天候跑道, 1650米, 好地<br>獎金: $875,000, 評分: 40-0, 第五班</div>
`;

const AWT_R7 = `
<div class="f_fs13" style="line-height: 20px;"><span class="font_wb">第 7 場 - 石屋山讓賽</span><br>2026年10月28日, 星期三, 沙田, 21:45<br>全天候跑道, 1200米, 好地<br>獎金: $1,170,000, 評分: 60-40, 第四班</div>
`;

const turf = parseRaceMeta(TURF, '2026-10-25', 'ST', 1);
assert.equal(turf.postTime, '12:40', 'post time parsed');
assert.equal(turf.distance, 1200, 'distance parsed');
assert.equal(turf.track, '草地', 'track parsed');
assert.equal(turf.course, 'A', 'course parsed');
assert.equal(turf.going, '好地', 'going parsed');
assert.equal(turf.raceClass, '第四班', 'class parsed');
assert.equal(turf.raceName, '六福珠寶洛神水賦系列讓賽', 'race name parsed');
assert.equal(turf.prize, '1170000', 'prize digits parsed');
assert.equal(turf.ratingRange, '60-40', 'rating range parsed');
assert.equal(trackLineUnparsed(TURF, turf), false, 'parsed turf header is not a miss');

const awt = parseRaceMeta(AWT, '2026-10-28', 'ST', 1);
assert.equal(awt.raceName, '畫眉山讓賽');
assert.equal(awt.postTime, '18:45');
assert.equal(awt.distance, 1650);
assert.equal(awt.track, '全天候');
assert.equal(awt.course, null, 'all-weather card has no quoted 賽道');
assert.equal(awt.going, '好地');
assert.equal(awt.raceClass, '第五班');
assert.equal(awt.prize, '875000');
assert.equal(awt.ratingRange, '40-0');
assert.equal(trackLineUnparsed(AWT, awt), false, 'parsed all-weather header is not a miss');

const awt7 = parseRaceMeta(AWT_R7, '2026-10-28', 'ST', 7);
assert.equal(awt7.raceName, '石屋山讓賽');
assert.equal(awt7.postTime, '21:45');
assert.equal(awt7.distance, 1200);
assert.equal(awt7.track, '全天候');
assert.equal(awt7.prize, '1170000');
assert.equal(awt7.ratingRange, '60-40');
assert.equal(awt7.raceClass, '第四班');

const encoded = TURF.replace('"A"', '&quot;A&quot;');
assert.equal(parseRaceMeta(encoded, '2026-10-25', 'ST', 1).course, 'A', 'encoded quotes still parse');

const fast = TURF.replace('好地', '好地至快地');
assert.equal(parseRaceMeta(fast, '2026-10-25', 'ST', 1).going, '好地至快地');

function assertDiscarded(meta: RaceMeta, label: string): void {
  assert.equal(meta.postTime, null, label);
  assert.equal(meta.raceName, null, `${label} race name`);
  assert.equal(meta.distance, null, `${label} distance`);
  assert.equal(meta.track, null, `${label} track`);
  assert.equal(meta.going, null, `${label} going`);
  assert.equal(meta.prize, null, `${label} prize`);
  assert.equal(meta.ratingRange, null, `${label} rating`);
  assert.equal(meta.raceClass, null, `${label} class`);
}

assertDiscarded(parseRaceMeta(TURF, '2026-10-25', 'ST', 2), 'wrong race number');
assertDiscarded(parseRaceMeta(TURF, '2026-10-25', 'HV', 1), 'wrong venue');
assertDiscarded(parseRaceMeta(TURF, '2026-10-26', 'ST', 1), 'wrong date');
assert.equal(trackLineUnparsed(TURF, parseRaceMeta(TURF, '2026-10-26', 'ST', 1)), false, 'identity discard is not a header miss');

const NO_TRACK = `<div>第 3 場 - 測試讓賽</span><br>2026年10月25日, 星期日, 沙田, 14:10<br></div>`;
const bare = parseRaceMeta(NO_TRACK, '2026-10-25', 'ST', 3);
assert.equal(bare.postTime, '14:10');
assert.equal(bare.distance, null);
assert.equal(bare.raceName, '測試讓賽');
assert.equal(trackLineUnparsed(NO_TRACK, bare), false, 'header without 米/surface is not a miss');

const BROKEN = `
<div class="f_fs13">第 4 場 - 格式漂移讓賽</span><br>2026年10月28日, 星期三, 沙田, 20:15<br>草地跑道, 一千二百米, 好地<br></div>
`;
const broken = parseRaceMeta(BROKEN, '2026-10-28', 'ST', 4);
assert.equal(broken.postTime, '20:15', 'identity still matches');
assert.equal(broken.distance, null);
assert.equal(broken.track, null);
assert.equal(trackLineUnparsed(BROKEN, broken), true, 'visible 米 + 草地 with empty distance fails closed');

const uniform = meetingTrackCondition([awt, awt7]);
assert.equal(uniform, '好地', 'uniform card records the shared going');
const mixed = meetingTrackCondition([
  awt,
  { ...awt7, going: '黏地' },
]);
assert.equal(mixed, null, 'mixed card does not copy the first race going');
const partial = meetingTrackCondition([awt, { ...awt7, going: null }]);
assert.equal(partial, null, 'an accepted race with no going does not stamp the meeting');
assert.equal(meetingTrackCondition([parseRaceMeta(TURF, '2026-10-26', 'ST', 1)]), null);

const view = upcomingRaceHeaderView(
  { ...raceLevelAssignment(awt), race_class: awt.raceClass },
  '黏地',
);
assert.equal(view.title, '畫眉山讓賽');
assert.equal(view.distance, 1650);
assert.equal(view.track, '全天候');
assert.equal(view.going, '好地', 'per-race going wins over the meeting');
assert.equal(view.prize, '875000');
assert.equal(view.ratingRange, '40-0');
assert.equal(view.class, '第五班');
const fallback = upcomingRaceHeaderView({ race_class: '第四班', distance: 1200 }, '好地');
assert.equal(fallback.going, '好地');
assert.equal(fallback.title, null);
assert.equal(fallback.prize, null);

async function assertLegacyFallback(): Promise<void> {
let legacyCalls = 0;
const fakeDb = {
  prepare(sql: string) {
    return {
      bind() {
        return {
          async all() {
            if (sql.includes('e.race_name')) {
              throw new Error('D1_ERROR: no such column: race_name');
            }
            legacyCalls += 1;
            return { results: [{ race_name: null, prize: null, going: null, race_class: '第五班', distance: 1650 }] };
          },
        };
      },
    };
  },
};
const legacyRows = await allEntriesOrLegacy(fakeDb, 'SELECT e.race_name FROM entries_upcoming', 'SELECT NULL AS race_name FROM entries_upcoming', []);
assert.equal(legacyCalls, 1);
assert.equal(legacyRows[0].race_class, '第五班');
assert.equal(upcomingRaceHeaderView(legacyRows[0], null).title, null);
}

const db = new Database(':memory:');
db.pragma('foreign_keys = OFF');
db.exec(`
  CREATE TABLE entries_upcoming (
    id TEXT PRIMARY KEY,
    race_date TEXT NOT NULL,
    venue TEXT NOT NULL,
    race_number INTEGER NOT NULL,
    race_class TEXT,
    distance INTEGER,
    track TEXT,
    course TEXT,
    horse_id TEXT,
    horse_number INTEGER,
    post_time TEXT,
    UNIQUE(race_date, venue, race_number, horse_number)
  );
`);
ensureSchema(db, [join(root, 'src/db/migrations/20261027_entries_upcoming_race_meta.sql')]);
ensureSchema(db, [join(root, 'src/db/migrations/20261027_entries_upcoming_race_meta.sql')]);
const cols = new Set((db.prepare('PRAGMA table_info(entries_upcoming)').all() as Array<{ name: string }>).map((c) => c.name));
for (const col of ['race_name', 'prize', 'rating_range', 'going']) {
  assert.equal(cols.has(col), true, `migration adds ${col}`);
}

const fresh = new Database(':memory:');
fresh.pragma('foreign_keys = OFF');
ensureSchema(fresh, [
  join(root, 'src/db/schema.sql'),
  join(root, 'src/db/schema_v2.sql'),
  join(root, 'src/db/migrations/20261027_entries_upcoming_race_meta.sql'),
]);
const insert = fresh.prepare(`
  INSERT INTO entries_upcoming
    (id, race_date, venue, race_number, race_class, distance, track, course,
     race_name, prize, rating_range, going, horse_number)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const [meta, raceNo, horseNo] of [[awt, 1, 1], [turf, 1, 2]] as const) {
  const level = raceLevelAssignment(meta);
  insert.run(
    `row-${raceNo}-${horseNo}`,
    meta === awt ? '2026-10-28' : '2026-10-25',
    'ST',
    raceNo,
    level.race_class,
    level.distance,
    level.track,
    level.course,
    level.race_name,
    level.prize,
    level.rating_range,
    level.going,
    horseNo,
  );
}
const storedAwt = fresh.prepare(`SELECT race_name, distance, track, course, going, prize, rating_range, race_class FROM entries_upcoming WHERE race_name = '畫眉山讓賽'`).get() as RaceMeta & Record<string, unknown>;
assert.equal(storedAwt.race_name, '畫眉山讓賽');
assert.equal(storedAwt.distance, 1650);
assert.equal(storedAwt.track, '全天候');
assert.equal(storedAwt.course, null);
assert.equal(storedAwt.going, '好地');
assert.equal(storedAwt.prize, '875000');
assert.equal(storedAwt.rating_range, '40-0');
const storedTurf = fresh.prepare(`SELECT race_name, distance, track, course, going, prize, rating_range FROM entries_upcoming WHERE track = '草地'`).get() as Record<string, unknown>;
assert.equal(storedTurf.race_name, '六福珠寶洛神水賦系列讓賽');
assert.equal(storedTurf.distance, 1200);
assert.equal(storedTurf.course, 'A');
assert.equal(storedTurf.prize, '1170000');
assert.equal(storedTurf.rating_range, '60-40');

fresh.prepare(`UPDATE entries_upcoming SET course = 'A' WHERE race_name = '畫眉山讓賽'`).run();
fresh.prepare(`
  UPDATE entries_upcoming
     SET course = CASE WHEN ? IS NOT NULL THEN ? ELSE COALESCE(?, course) END
   WHERE race_name = '畫眉山讓賽'
`).run(1650, null, null);
assert.equal(
  (fresh.prepare(`SELECT course AS course FROM entries_upcoming WHERE race_name = '畫眉山讓賽'`).get() as { course: string | null }).course,
  null,
  'parsed all-weather distance clears a stale turf course',
);

const scraper = readFileSync(join(root, 'scripts/scrape-racecard.ts'), 'utf8');
const values = /INSERT INTO entries_upcoming[\s\S]*?VALUES \(([^)]+)\)/.exec(scraper);
assert.ok(values, 'scraper insert has a VALUES list');
assert.equal(values[1].split(',').filter((p) => p.trim() === '?').length, 28, 'insert placeholders match race-meta columns');
assert.match(scraper, /RACECARD_HEADER_MISS_EXIT/);
assert.equal(RACECARD_HEADER_MISS_EXIT, 2);

assert.equal(
  racecardPageUrl('2026-10-25', 'ST', 1),
  'https://racing.hkjc.com/racing/information/Chinese/racing/RaceCard.aspx?RaceDate=2026/10/25&Racecourse=ST&RaceNo=1',
);

assertLegacyFallback().then(() => {
  console.log('test-racecard-meta: all assertions passed');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
