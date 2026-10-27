#!/usr/bin/env tsx
/** backfill-race-meta.ts: UPDATE-only, NULL-fill, fail-closed parsing, date filter. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'backfill-race-meta.ts');

const HEADER =
  'date,venue,race_no,race_meeting_no,race_name,race_class,distance_m,rating_range,going,course,prize_hkd,race_finish_time,sectional_times_header,place,horse_no,horse_name,jockey,trainer,actual_wt_lbs,declared_wt_lbs,draw,lbw,running_position,finish_time,win_odds';

function csvRow(over: Partial<Record<string, string>>): string {
  const base: Record<string, string> = {
    date: '2025-12-17',
    venue: '跑馬地',
    race_no: '1',
    race_name: '蒼鷺讓賽',
    rating_range: '40-0',
    course: '草地 - "B" 賽道',
    ...over,
  };
  const cols = HEADER.split(',');
  return cols
    .map((c) => {
      const v = base[c] ?? 'x';
      return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(',');
}

function run(dataDir: string, since: string, until: string): { out: string; summary: any } {
  const out = mkdtempSync(join(tmpdir(), 'race-meta-out-'));
  const stdout = execFileSync(
    'npx',
    ['tsx', script, `--data-dir=${dataDir}`, `--since=${since}`, `--until=${until}`, `--out=${out}`, '--chunk=2'],
    { cwd: here, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return { out, summary: JSON.parse(stdout.trim().split('\n').pop()!) };
}

function allSql(out: string): string {
  return readdirSync(out)
    .sort()
    .map((f) => readFileSync(join(out, f), 'utf-8'))
    .join('');
}

// Fixture: two races on 2025-12-17 (HV turf + ST AWT), one out-of-range file,
// one race with a blank rating, one race with an unparsable course sentence.
const dataDir = mkdtempSync(join(tmpdir(), 'race-meta-data-'));
mkdirSync(join(dataDir, '2025'));
writeFileSync(
  join(dataDir, '2025', 'results_2025-12-17.csv'),
  '﻿' +
    [
      HEADER,
      csvRow({}),
      csvRow({ horse_no: '2' }),
      csvRow({ venue: '沙田', race_no: '3', rating_range: '60-40', course: '全天候跑道' }),
      csvRow({ race_no: '5', rating_range: '', course: '草地 - "A" 賽道' }),
      csvRow({ race_no: '7', rating_range: '80-60', course: '唔知咩跑道' }),
    ].join('\n') + '\n'
);
writeFileSync(
  join(dataDir, '2025', 'results_2025-12-20.csv'),
  [HEADER, csvRow({ date: '2025-12-20', race_no: '2' })].join('\n') + '\n'
);

const { out, summary } = run(dataDir, '2025-12-17', '2025-12-17');
const sql = allSql(out);

// 1. Out-of-range file excluded; in-range file parsed.
assert.equal(summary.csv_files, 1, 'only the in-range CSV is read');

// 2. Turf race: fills all three columns, UPDATE-only, NULL-guarded.
assert.ok(
  sql.includes(
    "UPDATE races SET rating_range = COALESCE(rating_range, '40-0'), track = COALESCE(track, '草地'), course = COALESCE(course, 'B') WHERE id = 'race_2025-12-17_HV_1' AND (rating_range IS NULL OR track IS NULL OR course IS NULL);"
  ),
  'turf race emits NULL-fill UPDATE'
);

// 3. AWT race: track and course both 全天候.
assert.ok(
  sql.includes("course = COALESCE(course, '全天候') WHERE id = 'race_2025-12-17_ST_3'"),
  'AWT race maps venue + course'
);

// 4. Blank rating: still backfills track/course, no rating_range in SET.
const r5 = sql.split('\n').find((l) => l.includes("race_2025-12-17_HV_5"));
assert.ok(r5, 'blank-rating race still emitted');
assert.ok(!r5!.includes('rating_range ='), 'blank rating omitted from SET');
assert.ok(r5!.includes("track = COALESCE(track, '草地')"), 'blank-rating race still fills track');

// 5. Unparsable course sentence: race skipped entirely, counted.
assert.ok(!sql.includes('race_2025-12-17_HV_7'), 'unparsable course race skipped');
assert.equal(summary.skipped_races, 1, 'skip counted');

// 6. No INSERT anywhere; every statement is an UPDATE.
const statements = sql.split('\n').filter(Boolean);
assert.ok(statements.length > 0, 'statements emitted');
assert.ok(statements.every((s) => s.startsWith('UPDATE races SET')), 'UPDATE-only output');
assert.ok(!sql.includes('INSERT'), 'no INSERTs');

// 7. Chunking: --chunk=2 → ceil(3/2) = 2 files.
assert.equal(readdirSync(out).length, 2, 'chunked output files');

// 8. Quote escaping: a single quote inside a value is doubled, never breaks the literal.
const dataDir2 = mkdtempSync(join(tmpdir(), 'race-meta-data2-'));
mkdirSync(join(dataDir2, '2025'));
writeFileSync(
  join(dataDir2, '2025', 'results_2025-12-17.csv'),
  [HEADER, csvRow({ course: '草地 - "A\'B" 賽道' })].join('\n') + '\n'
);
const res2 = run(dataDir2, '2025-12-17', '2025-12-17');
const sql2 = allSql(res2.out);
assert.ok(sql2.includes("course = COALESCE(course, 'A''B')"), 'single quote doubled in SQL literal');
assert.ok(!sql2.includes("'''B'"), 'no unescaped quote sequence');

// 9. Multi-year range: every year directory between since and until is read,
//    not just the first and last (regression: 2016..2026 must include 2017).
const dataDir3 = mkdtempSync(join(tmpdir(), 'race-meta-data3-'));
for (const y of ['2024', '2025', '2026']) {
  mkdirSync(join(dataDir3, y));
  writeFileSync(
    join(dataDir3, y, `results_${y}-01-05.csv`),
    [HEADER, csvRow({ date: `${y}-01-05`, race_no: '2' })].join('\n') + '\n'
  );
}
const res3 = run(dataDir3, '2024-01-01', '2026-12-31');
assert.equal(res3.summary.csv_files, 3, 'middle year directory is read');
assert.ok(allSql(res3.out).includes('race_2025-01-05_HV_2'), 'middle-year race emitted');

console.log('test-backfill-race-meta: all assertions passed');
