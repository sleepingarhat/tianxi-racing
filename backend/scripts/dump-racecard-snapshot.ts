#!/usr/bin/env tsx
/**
 * Dump one meeting's racecard deltas to JSON for the official snapshot job.
 * Reuses the racecard fetch and column parsers. Does not open D1 and does not
 * write entries_upcoming.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchLocalRacecards, mapWeights } from './ingest/lib/hkjc-racecard.js';
import { fetchRaceMeta } from './ingest/lib/racecard-meta.js';
import { assertRacecardColumns, columnRowForRunner, parseRacecardColumns } from './ingest/lib/racecard-columns.js';

function arg(name: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

async function main(): Promise<void> {
  const date = arg('date');
  const venue = arg('venue').toUpperCase();
  const out = arg('out');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(ST|HV)$/.test(venue) || !out) {
    console.error('[racecard-snapshot] date, venue and out are required');
    process.exit(1);
  }
  const meetings = await fetchLocalRacecards([date], [venue]);
  const meeting = meetings.find((item) => item.date === date && String(item.venueCode).toUpperCase() === venue);
  if (!meeting || !(meeting.races ?? []).length) {
    writeFileSync(out, JSON.stringify({ captured_at: new Date().toISOString(), unpublished: true, rows: [] }));
    console.error(`[racecard-snapshot] ${date} ${venue} card is not published`);
    return;
  }
  const rows = [];
  const columnMisses: string[] = [];
  for (const race of meeting.races ?? []) {
    const raceNo = Number(race.no ?? 0);
    if (!raceNo) continue;
    const fetched = await fetchRaceMeta(date, venue, raceNo);
    const postTime = fetched.meta.postTime ? `${date}T${fetched.meta.postTime}:00+08:00` : null;
    let columns = null;
    if (fetched.html && fetched.meta.postTime) {
      try {
        columns = parseRacecardColumns(fetched.html);
        if (columns) assertRacecardColumns(columns, race.runners ?? []);
      } catch (err) {
        columnMisses.push(`R${raceNo} ${(err as Error).message}`);
        continue;
      }
    }
    for (const runner of race.runners ?? []) {
      const horseNo = Number(runner.no ?? runner.saddleClothNo ?? 0);
      if (!horseNo) continue;
      const standbyNo = String(runner.standbyNo ?? '');
      const reserve = standbyNo !== '' && standbyNo !== '0';
      const weights = mapWeights(runner);
      const column = columns && !reserve ? columnRowForRunner(columns, race.runners ?? [], runner) : null;
      const code = runner.horse?.code ? String(runner.horse.code) : null;
      rows.push({
        meeting_date: date,
        venue,
        race_no: raceNo,
        horse_no: horseNo,
        is_reserve: reserve ? 1 : 0,
        horse_id: column?.horseId ?? (typeof runner.horse?.id === 'string' ? runner.horse.id : null),
        brand_no: column?.brand ?? code,
        horse_code: code,
        declared_weight: weights.declaredWeight,
        actual_weight: weights.actualWeight,
        body_weight: weights.bodyWeight,
        rating_change: column?.ratingChange ?? null,
        body_weight_change: column?.bodyWeightChange ?? null,
        best_time: column?.bestTime ?? null,
        days_since_run: column?.daysSinceRun ?? null,
        possible_overweight: column?.possibleOverweight ?? null,
        age_allowance: column?.ageAllowance ?? null,
        draw: runner.barrierDrawNumber ?? null,
        post_time: postTime,
        captured_at: null as string | null,
        scraped_at: null as string | null,
      });
    }
  }
  if (columnMisses.length) {
    console.error(`[racecard-snapshot] runner columns failed: ${columnMisses.join('; ')}`);
    process.exit(1);
  }
  const capturedAt = new Date().toISOString();
  for (const row of rows) {
    row.captured_at = capturedAt;
    row.scraped_at = capturedAt;
  }
  const body = JSON.stringify({ captured_at: capturedAt, unpublished: rows.length === 0, rows });
  writeFileSync(out, body);
  const digest = createHash('sha256').update(body).digest('hex');
  console.error(`[racecard-snapshot] ${date} ${venue} rows=${rows.length} sha256=${digest}`);
}

main().catch((err) => {
  console.error('[racecard-snapshot] fatal:', err);
  process.exit(1);
});
