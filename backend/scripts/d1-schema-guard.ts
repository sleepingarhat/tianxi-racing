#!/usr/bin/env tsx
/**
 * Pre-push schema guard: are all columns that push-delta will INSERT for --table
 * present in the remote D1 table? Input is the JSON printed by
 *   wrangler d1 execute <db> --remote --json --command="PRAGMA table_info(<table>)"
 * Exit 0 = compatible, 3 = table missing / columns missing (prints which).
 * Workflows use it to skip (with a warning) instead of failing a whole sync run
 * when a newly synced table's D1 shape differs from the local schema.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

export function remoteColumns(wranglerJson: string): string[] {
  const parsed = JSON.parse(wranglerJson) as Array<{ results?: Array<{ name?: string }> }> | { results?: Array<{ name?: string }> };
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  return blocks.flatMap((b) => (b.results ?? []).map((r) => r.name).filter((x): x is string => typeof x === 'string'));
}

export function missingColumns(localCols: string[], remoteCols: string[]): string[] {
  const have = new Set(remoteCols);
  return localCols.filter((c) => !have.has(c));
}

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

if (process.argv[1] && /d1-schema-guard\.ts$/.test(process.argv[1])) {
  const table = arg('table');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) { console.error('invalid --table'); process.exit(2); }
  const db = new Database(arg('db') || 'bulk-local.db', { readonly: true });
  const local = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  const remote = remoteColumns(readFileSync(arg('pragma-json'), 'utf8'));
  if (!remote.length) { console.log(`D1 table ${table} missing`); process.exit(3); }
  const missing = missingColumns(local, remote);
  if (missing.length) { console.log(`D1 ${table} lacks columns: ${missing.join(', ')}`); process.exit(3); }
  console.log(`D1 ${table} compatible (${local.length} columns)`);
}
