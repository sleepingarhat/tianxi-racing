#!/usr/bin/env tsx
/**
 * Plan the remote D1 statements for official fixtures, pre-draw entries, and
 * the entries_upcoming runner columns added in 20261110.
 *
 * schema_v2 CREATE TABLE does not alter an existing D1 table. A single
 * wrangler --file batch stops at the first "duplicate column" and rolls back
 * every later ALTER. This planner emits only the missing statements, and
 * --apply runs each one on its own.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { remoteColumns } from './d1-schema-guard.js';

export interface OfficialCardRemote {
  entriesUpcoming: string[];
  officialFixtures: string[];
  officialRaceEntries: string[];
  indexes: string[];
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

export function columnsFromWranglerJson(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`wrangler pragma is not JSON: ${(err as Error).message}`);
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  if (!blocks.length) throw new Error('empty wrangler response');
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { success?: boolean }).success === false) {
      const error = (block as { error?: unknown }).error;
      throw new Error(typeof error === 'string' && error ? error : 'wrangler pragma failed');
    }
  }
  return remoteColumns(json);
}

export function columnNamesFromCreateBody(body: string): string[] {
  const names: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
    if (!line) continue;
    if (/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK|FOREIGN)\b/i.test(line)) continue;
    const name = line.split(/\s+/)[0];
    if (name) names.push(name);
  }
  return names;
}

export function isDuplicateColumnError(output: string): boolean {
  return /duplicate column/i.test(output);
}

export function planOfficialCardMigration(sql: string, remote: OfficialCardRemote): string[] {
  if (!remote.entriesUpcoming.length) {
    throw new Error('entries_upcoming missing on remote D1; refusing to invent it');
  }
  const tables: Record<string, string[]> = {
    entries_upcoming: remote.entriesUpcoming,
    official_fixtures: remote.officialFixtures,
    official_race_entries: remote.officialRaceEntries,
  };
  const creating = new Set<string>();
  const planned: string[] = [];
  for (const statement of splitSqlStatements(sql)) {
    const create = /^CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/i.exec(statement);
    if (create) {
      const table = create[1];
      if (!(table in tables)) throw new Error(`unexpected CREATE TABLE ${table}`);
      if (tables[table].length === 0) {
        creating.add(table);
        planned.push(statement);
      }
      continue;
    }
    const index = /^CREATE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\b/i.exec(statement);
    if (index) {
      const indexName = index[1];
      const table = index[2];
      if (!(table in tables)) throw new Error(`unexpected CREATE INDEX on ${table}`);
      if (creating.has(table) || (tables[table].length > 0 && !remote.indexes.includes(indexName))) {
        planned.push(statement);
      }
      continue;
    }
    const alter = /^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\b/i.exec(statement);
    if (alter) {
      const table = alter[1];
      const column = alter[2];
      if (!(table in tables)) throw new Error(`unexpected ALTER TABLE ${table}`);
      if (creating.has(table)) continue;
      const columns = tables[table];
      if (!columns.length) {
        throw new Error(`${table} is missing and this migration has no CREATE TABLE before ALTER ${column}`);
      }
      if (!columns.includes(column)) planned.push(statement);
      continue;
    }
    throw new Error(`unsupported migration statement: ${statement.split('\n')[0]}`);
  }
  return planned;
}

export interface StatementResult {
  ok: boolean;
  output: string;
}

export function applyOfficialCardStatements(
  statements: string[],
  run: (sql: string) => StatementResult,
): { applied: number; alreadyPresent: number } {
  let applied = 0;
  let alreadyPresent = 0;
  for (const statement of statements) {
    const result = run(statement);
    if (result.ok) {
      applied += 1;
      continue;
    }
    if (isDuplicateColumnError(result.output)) {
      alreadyPresent += 1;
      continue;
    }
    throw new Error(result.output.trim() || `failed: ${statement.split('\n')[0]}`);
  }
  return { applied, alreadyPresent };
}

function arg(name: string): string {
  return args(name)[0] ?? '';
}

function args(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length));
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

function wranglerExecute(database: string, sql: string): StatementResult {
  const child = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', database, '--remote', '--command', sql.endsWith(';') ? sql : `${sql};`],
    { encoding: 'utf8' },
  );
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  return { ok: child.status === 0, output };
}

function main(): void {
  const migrationPaths = args('migration');
  if (!migrationPaths.length) {
    console.error('missing --migration');
    process.exit(2);
  }
  const migration = migrationPaths.map((path) => readFileSync(path, 'utf8')).join('\n');
  const remote: OfficialCardRemote = {
    entriesUpcoming: columnsFromWranglerJson(readFileSync(requireArg('entries-upcoming'), 'utf8')),
    officialFixtures: columnsFromWranglerJson(readFileSync(requireArg('official-fixtures'), 'utf8')),
    officialRaceEntries: columnsFromWranglerJson(readFileSync(requireArg('official-race-entries'), 'utf8')),
    indexes: columnsFromWranglerJson(readFileSync(requireArg('indexes'), 'utf8')),
  };
  const plan = planOfficialCardMigration(migration, remote);
  writeFileSync(requireArg('out'), plan.length ? `${plan.join(';\n')};\n` : '');
  if (!plan.length) {
    console.log('official card schema already present');
    return;
  }
  console.log(`official card schema: ${plan.length} statement(s)`);
  for (const statement of plan) console.log(statement.split('\n')[0]);
  if (!process.argv.includes('--apply')) return;
  const database = arg('database') || 'tianxi-db';
  const summary = applyOfficialCardStatements(plan, (sql) => wranglerExecute(database, sql));
  console.log(`applied ${summary.applied}, already present ${summary.alreadyPresent}`);
}

if (process.argv[1] && /(?:^|[/\\])d1-official-card-schema\.ts$/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message ?? err);
    process.exit(1);
  }
}
