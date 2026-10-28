#!/usr/bin/env tsx
/**
 * Backfill races.rating_range / track / course for OLD meetings already in D1.
 *
 * Source of truth: the archived official results CSVs (data/YYYY/results_*.csv),
 * which already carry rating_range + the full course sentence. No re-scrape of
 * HKJC pages is needed and none is done here.
 *
 * Safety:
 *   - UPDATE-only output. Never INSERTs, never touches race_results.
 *   - COALESCE(rating_range, …): only fills columns that are currently NULL;
 *     existing values are never overwritten (frozen/display data stays put).
 *   - WHERE clause re-checks at least one target column IS NULL, so re-runs
 *     are no-ops once a race is complete.
 *   - Fail-closed per race: an unparsable course sentence or rating range
 *     skips that race (counted + logged), never emits a blank/guessed value.
 *   - Chunked output files for `wrangler d1 execute --remote --file=...`.
 *
 * Usage:
 *   tsx scripts/backfill-race-meta.ts --data-dir=../data \
 *     --since=2025-09-01 --until=2026-10-27 --out=/tmp/race-meta-backfill \
 *     [--chunk=400]
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRatingRange, splitOfficialCourse, OfficialFieldError } from '../src/lib/result-course';

interface Args {
  dataDir: string;
  since: string;
  until: string;
  out: string;
  chunk: number;
}

function parseArgs(): Args {
  const get = (k: string, d = '') => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const since = get('since');
  const until = get('until');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`bad --since: ${since}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error(`bad --until: ${until}`);
  if (since > until) throw new Error(`--since ${since} is after --until ${until}`);
  return {
    dataDir: get('data-dir', '../data'),
    since,
    until,
    out: get('out', '/tmp/race-meta-backfill'),
    chunk: Number(get('chunk', '400')),
  };
}

function esc(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** CSV venue column is Chinese; D1 race ids use ST/HV. */
function venueCode(zh: string): string | null {
  const t = zh.trim();
  if (t === '沙田') return 'ST';
  if (t === '跑馬地') return 'HV';
  return null;
}

/** Minimal RFC-4180-ish CSV parse (handles quoted commas/quotes, BOM). */
function parseCsv(content: string): Record<string, string>[] {
  const text = content.replace(/^﻿/, '');
  const lines: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') lines.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    lines.push(row);
  }
  if (lines.length < 2) return [];
  const header = lines[0];
  return lines.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = cells[i] ?? '';
    });
    return rec;
  });
}

interface RaceMeta {
  raceId: string;
  ratingRange: string | null;
  track: string | null;
  course: string | null;
}

function main() {
  const a = parseArgs();
  const y0 = Number(a.since.slice(0, 4));
  const y1 = Number(a.until.slice(0, 4));
  const files: string[] = [];
  for (let y = y0; y <= y1; y++) {
    const year = String(y);
    let names: string[] = [];
    try {
      names = readdirSync(join(a.dataDir, year));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^results_(\d{4}-\d{2}-\d{2})\.csv$/.exec(name);
      if (!m) continue;
      if (m[1] < a.since || m[1] > a.until) continue;
      files.push(join(a.dataDir, year, name));
    }
  }
  files.sort();
  console.error(`[backfill] ${files.length} results CSV(s) in ${a.since}..${a.until}`);

  const metas = new Map<string, RaceMeta>();
  let skippedRaces = 0;
  let skippedVenue = 0;
  for (const file of files) {
    const rows = parseCsv(readFileSync(file, 'utf-8'));
    const byRace = new Map<string, Record<string, string>>();
    for (const row of rows) {
      const key = `${row.date}|${row.venue}|${row.race_no}`;
      if (!byRace.has(key)) byRace.set(key, row);
    }
    for (const first of byRace.values()) {
      const venue = venueCode(first.venue ?? '');
      if (!venue) {
        skippedVenue++;
        console.error(`[backfill] skip: unknown venue "${first.venue}" (${first.date} race ${first.race_no})`);
        continue;
      }
      const raceNo = Number(first.race_no);
      if (!Number.isInteger(raceNo) || raceNo < 1 || raceNo > 14) {
        skippedRaces++;
        console.error(`[backfill] skip: bad race_no "${first.race_no}" (${first.date} ${venue})`);
        continue;
      }
      try {
        const split = splitOfficialCourse(first.course);
        const rating = normalizeRatingRange(first.rating_range);
        const raceId = `race_${first.date}_${venue}_${raceNo}`;
        if (!metas.has(raceId)) {
          metas.set(raceId, { raceId, ratingRange: rating, track: split.track, course: split.course });
        }
      } catch (err) {
        skippedRaces++;
        if (err instanceof OfficialFieldError) {
          console.error(`[backfill] skip: ${err.message} (${first.date} ${venue} race ${raceNo})`);
        } else {
          throw err;
        }
      }
    }
  }

  const sql: string[] = [];
  for (const m of metas.values()) {
    const sets: string[] = [];
    if (m.ratingRange) sets.push(`rating_range = COALESCE(rating_range, ${esc(m.ratingRange)})`);
    if (m.track) sets.push(`track = COALESCE(track, ${esc(m.track)})`);
    if (m.course) sets.push(`course = COALESCE(course, ${esc(m.course)})`);
    if (!sets.length) continue;
    sql.push(
      `UPDATE races SET ${sets.join(', ')} WHERE id = ${esc(m.raceId)} ` +
        `AND (rating_range IS NULL OR track IS NULL OR course IS NULL);`
    );
  }

  mkdirSync(a.out, { recursive: true });
  const chunks: string[] = [];
  for (let i = 0; i < sql.length; i += a.chunk) {
    const name = join(a.out, `race-meta-${String(chunks.length + 1).padStart(3, '0')}.sql`);
    writeFileSync(name, sql.slice(i, i + a.chunk).join('\n') + '\n');
    chunks.push(name);
  }

  console.error(
    `[backfill] races seen=${metas.size} statements=${sql.length} skipped_race=${skippedRaces} skipped_venue=${skippedVenue} chunks=${chunks.length}`
  );
  console.log(
    JSON.stringify({
      ok: true,
      since: a.since,
      until: a.until,
      csv_files: files.length,
      races: metas.size,
      statements: sql.length,
      skipped_races: skippedRaces,
      skipped_venue: skippedVenue,
      chunks: chunks.length,
      out: a.out,
    })
  );
}

main();
