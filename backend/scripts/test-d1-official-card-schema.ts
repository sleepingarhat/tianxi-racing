#!/usr/bin/env tsx
/** Remote D1 plan for official fixtures, pre-draw entries, and runner columns. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureSchema } from './ingest/lib/db.js';
import {
  applyOfficialCardStatements,
  columnNamesFromCreateBody,
  columnsFromWranglerJson,
  isDuplicateColumnError,
  planOfficialCardMigration,
  splitSqlStatements,
  type OfficialCardRemote,
} from './d1-official-card-schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = join(root, 'src/db/migrations/20261110_official_fixtures_entries.sql');
const headerMigrationPath = join(root, 'src/db/migrations/20261027_entries_upcoming_race_meta.sql');
const migration = readFileSync(migrationPath, 'utf8');
const headerMigration = readFileSync(headerMigrationPath, 'utf8');
const ensureScript = readFileSync(join(root, 'scripts/d1-ensure-official-card-schema.sh'), 'utf8');
assert.match(ensureScript, /20261027_entries_upcoming_race_meta\.sql/);
assert.match(ensureScript, /20261110_official_fixtures_entries\.sql/);
const schemaV2 = readFileSync(join(root, 'src/db/schema_v2.sql'), 'utf8');

const RUNNER_COLUMNS = [
  'body_weight',
  'allowance',
  'international_rating',
  'last6run',
  'silk_file',
  'card_stage',
];

function createBody(sql: string, table: string): string {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  assert.ok(match, `${table} CREATE TABLE`);
  return match[1];
}

function sameColumns(left: string, right: string, table: string): void {
  assert.deepEqual(
    columnNamesFromCreateBody(createBody(left, table)),
    columnNamesFromCreateBody(createBody(right, table)),
    `${table} columns match schema_v2`,
  );
}

sameColumns(schemaV2, migration, 'official_fixtures');
sameColumns(schemaV2, migration, 'official_race_entries');
const upcomingBody = createBody(schemaV2, 'entries_upcoming');
for (const column of RUNNER_COLUMNS) {
  assert.match(upcomingBody, new RegExp(`\\b${column}\\b`), `schema_v2 entries_upcoming.${column}`);
}

const statements = splitSqlStatements(migration);
assert.equal(statements.length, 12, 'creates, indexes, runner alters, identity repairs');
assert.equal(
  statements.filter((statement) => statement.startsWith('ALTER TABLE entries_upcoming')).length,
  6,
);

function names(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function indexes(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('official_fixtures','official_race_entries')`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function remoteFrom(db: Database.Database): OfficialCardRemote {
  const table = (name: string) => {
    const hit = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    return hit ? names(db, name) : [];
  };
  return {
    entriesUpcoming: table('entries_upcoming'),
    officialFixtures: table('official_fixtures'),
    officialRaceEntries: table('official_race_entries'),
    indexes: indexes(db),
  };
}

const legacy = new Database(':memory:');
legacy.exec(`
  CREATE TABLE entries_upcoming (
    id TEXT PRIMARY KEY,
    race_date TEXT NOT NULL,
    venue TEXT NOT NULL,
    race_number INTEGER NOT NULL,
    declared_weight REAL,
    actual_weight REAL
  );
`);
const legacyPlan = planOfficialCardMigration(migration, remoteFrom(legacy));
assert.deepEqual(
  legacyPlan.map((statement) => statement.split('\n')[0]),
  [
    'CREATE TABLE IF NOT EXISTS official_fixtures (',
    'CREATE INDEX IF NOT EXISTS idx_official_fixtures_month',
    'CREATE TABLE IF NOT EXISTS official_race_entries (',
    'CREATE INDEX IF NOT EXISTS idx_official_race_entries_date',
    'ALTER TABLE entries_upcoming ADD COLUMN body_weight INTEGER',
    'ALTER TABLE entries_upcoming ADD COLUMN allowance REAL',
    'ALTER TABLE entries_upcoming ADD COLUMN international_rating INTEGER',
    'ALTER TABLE entries_upcoming ADD COLUMN last6run TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN silk_file TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN card_stage TEXT',
  ],
);
assert.equal(
  legacyPlan.some((statement) => statement.includes('ADD COLUMN card_stage TEXT NOT NULL')),
  false,
  'new official_race_entries gets card_stage from CREATE, not a second ALTER',
);
for (const statement of legacyPlan) legacy.exec(statement);
legacy.prepare(
  `INSERT INTO entries_upcoming
     (id, race_date, venue, race_number, declared_weight, body_weight, card_stage)
   VALUES ('e1', '2026-11-14', 'ST', 1, 126, 1151, 'declared')`,
).run();
assert.deepEqual(legacy.prepare(`SELECT body_weight FROM entries_upcoming`).get(), { body_weight: 1151 });
assert.deepEqual(planOfficialCardMigration(migration, remoteFrom(legacy)), []);

const headerLegacy = new Database(':memory:');
headerLegacy.exec(`CREATE TABLE entries_upcoming (id TEXT PRIMARY KEY, declared_weight REAL)`);
const headerPlan = planOfficialCardMigration(`${headerMigration}\n${migration}`, remoteFrom(headerLegacy));
assert.deepEqual(
  headerPlan.slice(0, 4).map((statement) => statement.split('\n')[0]),
  [
    'ALTER TABLE entries_upcoming ADD COLUMN race_name TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN prize TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN rating_range TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN going TEXT',
  ],
);
assert.ok(headerPlan.some((statement) => statement.includes('ADD COLUMN body_weight INTEGER')));

const partialRunner = new Database(':memory:');
partialRunner.exec(`CREATE TABLE entries_upcoming (id TEXT, body_weight INTEGER)`);
partialRunner.exec(`CREATE TABLE official_fixtures (date TEXT, venue TEXT)`);
partialRunner.exec(`CREATE TABLE official_race_entries (race_date TEXT, horse_code TEXT)`);
partialRunner.exec(`CREATE INDEX idx_official_fixtures_month ON official_fixtures(date)`);
partialRunner.exec(`CREATE INDEX idx_official_race_entries_date ON official_race_entries(race_date)`);
const partialPlan = planOfficialCardMigration(migration, remoteFrom(partialRunner));
assert.deepEqual(
  partialPlan.map((statement) => statement.split('\n')[0]),
  [
    'ALTER TABLE entries_upcoming ADD COLUMN allowance REAL',
    'ALTER TABLE entries_upcoming ADD COLUMN international_rating INTEGER',
    'ALTER TABLE entries_upcoming ADD COLUMN last6run TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN silk_file TEXT',
    'ALTER TABLE entries_upcoming ADD COLUMN card_stage TEXT',
    'ALTER TABLE official_race_entries ADD COLUMN card_stage TEXT NOT NULL DEFAULT \'entries\' CHECK (card_stage = \'entries\')',
    'ALTER TABLE official_race_entries ADD COLUMN draw_status TEXT NOT NULL DEFAULT \'unavailable\' CHECK (draw_status = \'unavailable\')',
  ],
);
for (const statement of partialPlan) partialRunner.exec(statement);
partialRunner.prepare(
  `INSERT INTO official_race_entries (race_date, horse_code, card_stage, draw_status) VALUES ('2026-11-14', 'A001', 'entries', 'unavailable')`,
).run();
assert.throws(() => {
  partialRunner.prepare(
    `INSERT INTO official_race_entries (race_date, horse_code, card_stage, draw_status) VALUES ('2026-11-14', 'A002', 'declared', 'unavailable')`,
  ).run();
}, /CHECK/);
assert.deepEqual(planOfficialCardMigration(migration, remoteFrom(partialRunner)), []);

const fresh = new Database(':memory:');
ensureSchema(fresh, [
  join(root, 'src/db/schema.sql'),
  join(root, 'src/db/schema_v2.sql'),
  migrationPath,
]);
ensureSchema(fresh, [migrationPath]);
assert.deepEqual(planOfficialCardMigration(migration, remoteFrom(fresh)), []);
assert.ok(names(fresh, 'entries_upcoming').includes('body_weight'));
assert.ok(names(fresh, 'official_race_entries').includes('card_stage'));
assert.ok(names(fresh, 'official_race_entries').includes('draw_status'));
assert.ok(indexes(fresh).includes('idx_official_fixtures_month'));

assert.equal(isDuplicateColumnError('duplicate column name: body_weight: SQLITE_ERROR'), true);
assert.equal(isDuplicateColumnError('table entries_upcoming has no column named body_weight: SQLITE_ERROR'), false);

const seen: string[] = [];
const summary = applyOfficialCardStatements(
  ['ALTER TABLE entries_upcoming ADD COLUMN body_weight INTEGER', 'ALTER TABLE entries_upcoming ADD COLUMN allowance REAL'],
  (sql) => {
    seen.push(sql);
    if (sql.includes('body_weight')) return { ok: false, output: 'duplicate column name: body_weight' };
    return { ok: true, output: '' };
  },
);
assert.deepEqual(summary, { applied: 1, alreadyPresent: 1 });
assert.equal(seen.length, 2, 'a duplicate column does not skip the next ALTER');
assert.throws(
  () => applyOfficialCardStatements(['ALTER TABLE entries_upcoming ADD COLUMN allowance REAL'], () => ({
    ok: false,
    output: 'table entries_upcoming has no column named body_weight: SQLITE_ERROR',
  })),
  /no column named body_weight/,
);

assert.throws(
  () => planOfficialCardMigration(migration, {
    entriesUpcoming: [],
    officialFixtures: [],
    officialRaceEntries: [],
    indexes: [],
  }),
  /entries_upcoming missing/,
);

const pragma = JSON.stringify([{
  success: true,
  results: [{ name: 'id' }, { name: 'body_weight' }],
}]);
assert.deepEqual(columnsFromWranglerJson(pragma), ['id', 'body_weight']);
assert.throws(() => columnsFromWranglerJson('not json'), /not JSON/);
assert.throws(
  () => columnsFromWranglerJson(JSON.stringify([{ success: false, error: 'auth failed' }])),
  /auth failed/,
);

console.log('d1 official card schema plan ok');
