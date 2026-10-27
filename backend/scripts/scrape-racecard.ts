#!/usr/bin/env tsx
  /**
   * Race card enrichment — HKJC whitelisted GraphQL → enrich entries_upcoming
   *
   * Replaces sentinel race_number=0 rows (written by ingest/sources/entries.ts)
   * with real race_number, draw, jockey, trainer, weight, rating data.
   *
   * Uses the exact query HKJC's own bet site sends (the generic hkjc-api
   * getAllRaces() query has been rejected with WHITELIST_ERROR since
   * 2026-10-23). Any HKJC error fails the job; it is never "no meeting".
   *
   * Run AFTER capy_entries (horse stubs seeded) and BEFORE push-delta --include=entries.
   *
   * Usage:
   *   tsx scripts/scrape-racecard.ts [--db=bulk-local.db] [--date=YYYY-MM-DD] [--venue=ST|HV] [--dry-run]
   */
  import Database from 'better-sqlite3';
  import { resolve } from 'node:path';
  import { fetchLocalRacecards, mapWeights } from './ingest/lib/hkjc-racecard.js';
  import { emptyRaceMeta, fetchRaceMeta, meetingTrackCondition, raceLevelAssignment, RACECARD_HEADER_MISS_EXIT, type RaceMeta } from './ingest/lib/racecard-meta.js';
  import { entryId } from './ingest/lib/ids.js';
    import { ensureSchema } from './ingest/lib/db.js';
    import { resolve as resolvePath } from 'node:path';

  function arg(name: string, fallback = ''): string {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  }

  async function main(): Promise<void> {
    const dbPath = resolve(arg('db', 'bulk-local.db'));
    const dateFilter = arg('date', '');
    const venueFilter = arg('venue', '').toUpperCase();
    const dryRun = process.argv.includes('--dry-run');
    const sourceCommit = process.env.GITHUB_SHA ?? null;

    // Whitelisted HKJC query only. HKJC falls back to a default (often
    // overseas simulcast) card for dates/venues without a local meeting, so
    // fetchLocalRacecards keeps only cards whose every runner has a local HK
    // horse id and drops identical fallback cards. This engine covers ONLY
    // Sha Tin (ST) and Happy Valley (HV).
    const hkToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const dates = dateFilter ? [dateFilter] : [hkToday];
    const venues = venueFilter ? [venueFilter] : ['ST', 'HV'];
    const meetings = await fetchLocalRacecards(dates, venues);
    if (!meetings.length) {
      console.error(`[racecard] no active HK (ST/HV) meeting for ${dates.join(',')} — skipping`);
      // Explicit --date is a backfill/re-run intent: fail closed.
      process.exit(dateFilter ? 1 : 0);
    }

    let meeting: any = meetings[0];
    if (dateFilter || venueFilter) {
      const matched = meetings.find((m: any) => {
        const dOk = !dateFilter || (m.date ?? '') === dateFilter;
        const vOk = !venueFilter || (m.venueCode ?? '').toUpperCase() === venueFilter;
        return dOk && vOk;
      });
      if (!matched) {
        const avail = meetings.map((m: any) => `${m.date}@${m.venueCode}`).join(', ');
        console.error(`[racecard] no meeting for date=${dateFilter} venue=${venueFilter}. Available: ${avail}`);
        process.exit(dateFilter ? 1 : 0);
      }
      meeting = matched;
    }

    const meetingDate: string = meeting.date ?? '';
    const venueCode: string = (meeting.venueCode ?? '').toUpperCase();
    const races: any[] = meeting.races ?? [];

    if (!meetingDate || !venueCode) {
      console.error('[racecard] meeting missing date or venueCode:', JSON.stringify(meeting).substring(0, 200));
      process.exit(1);
    }
    if (!races.length) {
      console.error(`[racecard] no races in meeting ${meetingDate}@${venueCode}`);
      process.exit(0);
    }

    // Log meeting summary
    let totalRunners = 0;
    for (const r of races) totalRunners += (r.runners ?? []).length;
    console.error(`[racecard] ${meetingDate}@${venueCode} · ${races.length} races · ${totalRunners} runners`);

    if (dryRun) {
      for (const race of races) {
        const raceNo = Number(race.no ?? 0);
        const runners: any[] = race.runners ?? [];
        console.error(`  R${raceNo} · ${runners.length} runners`);
        runners.slice(0, 3).forEach((r: any) => {
          const w = mapWeights(r);
          console.error(`    #${r.no} ${r.name_ch ?? r.name_en} draw=${r.barrierDrawNumber} jockey=${r.jockey?.name_ch} 負磅=${w.declaredWeight} 實際負磅=${w.actualWeight} 體重=${w.bodyWeight}`);
        });
      }
      process.exit(0);
    }

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = OFF;'); // scratch DB: FK off, push-delta handles referential ordering

    // Ensure schema exists (safe to re-run; handles cache-miss / fresh-DB scenario)
    const schemaDir = resolvePath(process.cwd(), 'src', 'db');
    ensureSchema(db, [
      resolvePath(schemaDir, 'schema.sql'),
      resolvePath(schemaDir, 'schema_v2.sql'),
      resolvePath(schemaDir, 'schema_silks.sql'),
      resolvePath(schemaDir, 'migrations', '20261027_entries_upcoming_race_meta.sql'),
    ]);

    const deleteSentinels = db.prepare(
      'DELETE FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number = 0',
    );

    const upsert = db.prepare(
      `INSERT INTO entries_upcoming
         (id, race_date, venue, race_number, race_class, distance, track, course,
          race_name, prize, rating_range, going,
          horse_id, horse_number, horse_code, draw, jockey_name, jockey_id,
          trainer_name, trainer_id, actual_weight, declared_weight, gear,
          rating, priority_order, post_time, scraped_at, source_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(race_date, venue, race_number, horse_number) DO UPDATE SET
         -- Race-level meta comes from RaceCard.aspx; an unparseable page must
         -- never wipe values already stored. A header that visibly contains
         -- 米 and 全天候/草地 but still yields empty distance/track fails the
         -- process after this write (see RACECARD_HEADER_MISS_EXIT) so the
         -- racecard job cannot stay green on a permanent COALESCE-to-empty.
         race_class      = COALESCE(excluded.race_class, entries_upcoming.race_class),
         distance        = COALESCE(excluded.distance, entries_upcoming.distance),
         track           = COALESCE(excluded.track, entries_upcoming.track),
         -- A parsed all-weather line has a null course (no quoted 賽道). That null
         -- is the value, so it must replace a stale course. An unparsed line
         -- leaves distance null and keeps the stored course.
         course          = CASE WHEN excluded.distance IS NOT NULL THEN excluded.course ELSE COALESCE(excluded.course, entries_upcoming.course) END,
         race_name       = COALESCE(excluded.race_name, entries_upcoming.race_name),
         prize           = COALESCE(excluded.prize, entries_upcoming.prize),
         rating_range    = COALESCE(excluded.rating_range, entries_upcoming.rating_range),
         going           = COALESCE(excluded.going, entries_upcoming.going),
         horse_id        = excluded.horse_id,
         horse_code      = excluded.horse_code,
         draw            = excluded.draw,
         jockey_name     = excluded.jockey_name,
         jockey_id       = excluded.jockey_id,
         trainer_name    = excluded.trainer_name,
         trainer_id      = excluded.trainer_id,
         actual_weight   = excluded.actual_weight,
         declared_weight = excluded.declared_weight,
         gear            = excluded.gear,
         rating          = excluded.rating,
         priority_order  = excluded.priority_order,
         post_time       = COALESCE(excluded.post_time, entries_upcoming.post_time),
         scraped_at      = excluded.scraped_at,
         source_commit   = excluded.source_commit`,
    );

    const upsertHorse = db.prepare(
      `INSERT INTO horses (id, code, name_en, name_ch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         code    = excluded.code,
         name_en = COALESCE(excluded.name_en, name_en),
         name_ch = COALESCE(excluded.name_ch, name_ch)`,
    );

    // jockeys table has (id, name_en, name_ch) — no code column
    const upsertJockey = db.prepare(
      `INSERT INTO jockeys (id, name_en, name_ch)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name_en = COALESCE(excluded.name_en, name_en),
         name_ch = COALESCE(excluded.name_ch, name_ch)`,
    );

    // trainers table has (id, name_en, name_ch) — no code column
    const upsertTrainer = db.prepare(
      `INSERT INTO trainers (id, name_en, name_ch)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name_en = COALESCE(excluded.name_en, name_en),
         name_ch = COALESCE(excluded.name_ch, name_ch)`,
    );

    const upsertMeeting = db.prepare(
      'INSERT INTO race_meetings (id, date, venue) VALUES (?, ?, ?) ON CONFLICT(date, venue) DO NOTHING',
    );

    // Also update track_condition on race_meetings from the going if available
    const updateMeetingGoing = db.prepare(
      `UPDATE race_meetings SET track_condition = ? WHERE date = ? AND venue = ? AND track_condition IS NULL`,
    );

    let deleted = 0;
    let inserted = 0;
    // Race-level meta (post time, distance, track, course, going, class) is not
    // in the whitelisted GraphQL query — HKJC rejects added fields. Parse it
    // from the classic RaceCard.aspx pages instead; unparseable races keep
    // existing database values via COALESCE in the upsert below.
    const metaByRace = new Map<number, RaceMeta>();
    const headerMisses: number[] = [];
    for (const race of races) {
      const rn = Number(race.no ?? 0);
      if (!rn) continue;
      const fetched = await fetchRaceMeta(meetingDate, venueCode, rn);
      metaByRace.set(rn, fetched.meta);
      if (fetched.headerUnparsed) headerMisses.push(rn);
    }
    // 官方退出（Scratched）：只喺鎖點（首場前90分鐘）前從排位剔走；鎖後唔郁，原凍結保持不變。
    const postTimes = [...metaByRace.values()].map(m => m.postTime ? Date.parse(`${meetingDate}T${m.postTime}:00+08:00`) : NaN).filter(Number.isFinite);
    const lockAtMs = postTimes.length ? Math.min(...postTimes) - 90 * 60_000 : NaN;
    const preLock = Number.isFinite(lockAtMs) && Date.now() < lockAtMs;
    const scratched: Array<{ raceNo: number; horseNo: number }> = [];
    const deleteScratched = db.prepare(
      'DELETE FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number = ? AND horse_number = ?',
    );

    // Guard against phantom meetings: skip only if HKJC returned no actual runners.
    // Previously checked local bulk-local.db evidence, but the local DB lags fresh
    // entries-sync (Capy Entries txt → entries-sync → D1) and falsely blocked valid
    // meetings like 2026-05-27_HV with 122 runners. If runners scraped > 0, it's real.
    // totalRunners already computed at function top (line 69) — reuse it for guard
    if (totalRunners === 0) {
      console.warn(`[scrape-racecard] SKIP empty meeting ${meetingDate}_${venueCode} — 0 runners scraped`);
      return;
    }

    const tx = db.transaction(() => {
      upsertMeeting.run(`${meetingDate}_${venueCode}`, meetingDate, venueCode);

      // Uniform cards record the shared going. Mixed goings stay off the
      // meeting row; each race keeps its own entries_upcoming.going.
      const sharedGoing = meetingTrackCondition(metaByRace.values());
      if (sharedGoing) updateMeetingGoing.run(sharedGoing, meetingDate, venueCode);

      const del = deleteSentinels.run(meetingDate, venueCode);
      deleted = del.changes;

      for (const race of races) {
        const raceNo: number = Number(race.no ?? 0);
        if (!raceNo) continue;

        const meta = metaByRace.get(raceNo);
        const level = raceLevelAssignment(meta ?? emptyRaceMeta());
        const postTime: string | null = meta?.postTime ? `${meetingDate}T${meta.postTime}:00+08:00` : null;
        const runners: any[] = race.runners ?? [];

        for (const runner of runners) {
          const horseNo: number = Number(runner.no ?? runner.saddleClothNo ?? 0);
          if (!horseNo) continue;
          if (String(runner.status ?? '').toLowerCase() === 'scratched' && preLock) {
            deleteScratched.run(meetingDate, venueCode, raceNo, horseNo);
            scratched.push({ raceNo, horseNo });
            continue;
          }

          const horseCode: string = runner.horse?.code ?? '';
          const horseId: string | null = horseCode ? horseCode : null; // bare code, push-delta prefixes for D1
          const draw: number | null = runner.barrierDrawNumber ?? null;
          // Weight mapping verified 2026-10-24: handicapWeight is 負磅,
          // currentWeight is 排位體重 (body weight, ~900-1300) and must never
          // be stored as a carried weight. actual_weight = 負磅 - 見習減磅,
          // matching race_results.actual_weight semantics.
          const { declaredWeight, actualWeight } = mapWeights(runner);
          const rating: number | null = runner.currentRating ?? null;
          const gear: string | null = runner.gearInfo ?? null;
          const standbyNo: string = String(runner.standbyNo ?? '');
          const priorityOrder: string =
            standbyNo && standbyNo !== '0' && standbyNo !== '' ? `後備${standbyNo}` : '正選';

          const jCode: string = runner.jockey?.code ?? '';
          const jNameCh: string = runner.jockey?.name_ch ?? '';
          const jNameEn: string = runner.jockey?.name_en ?? '';
          const jId: string | null = jCode ? `jockey_${jCode}` : null;

          const tCode: string = runner.trainer?.code ?? '';
          const tNameCh: string = runner.trainer?.name_ch ?? '';
          const tNameEn: string = runner.trainer?.name_en ?? '';
          const tId: string | null = tCode ? `trainer_${tCode}` : null;

          // Horse stub uses prefixed id 'horse_CODE' so push-delta horseRef ('horse_' || horse_id) matches
          if (horseCode) {
            upsertHorse.run(`horse_${horseCode}`, horseCode, runner.name_en ?? horseCode, runner.name_ch ?? null);
          }
          if (jId) upsertJockey.run(jId, jNameEn || jCode, jNameCh || null);
          if (tId) upsertTrainer.run(tId, tNameEn || tCode, tNameCh || null);

          const id = entryId(meetingDate, venueCode, raceNo, horseNo);
          upsert.run(
            id, meetingDate, venueCode, raceNo,
            level.race_class, level.distance, level.track, level.course,
            level.race_name, level.prize, level.rating_range, level.going,
            horseId, horseNo, horseCode,
            draw, jNameCh || null, null, // jockey_id = null (avoids FK; name kept for display)
            tNameCh || null, null, // trainer_id = null (avoids FK; name kept for display)
            actualWeight, declaredWeight, gear,
            rating, priorityOrder, postTime,
            new Date().toISOString(), sourceCommit,
          );
          inserted++;
        }
      }
    });

    tx();
    // 交俾工作流程喺 D1 刪除同一批退出馬（push-delta 只會新增／覆寫，唔會刪）。
    const sqlOut = process.env.SCRATCHED_SQL_OUT;
    if (sqlOut) {
      const { writeFileSync } = await import('node:fs');
      const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
      writeFileSync(sqlOut, scratched.map(x => `DELETE FROM entries_upcoming WHERE race_date = ${q(meetingDate)} AND venue = ${q(venueCode)} AND race_number = ${x.raceNo} AND horse_number = ${x.horseNo};`).join('\n') + (scratched.length ? '\n' : ''));
    }
    console.error(`[racecard] scratched pre-lock=${preLock} removed=${scratched.map(x => `R${x.raceNo}#${x.horseNo}`).join(',') || 'none'}`);
    console.error(`[racecard] ✓ deleted ${deleted} sentinels · wrote ${inserted} enriched entries for ${meetingDate}@${venueCode}`);
    if (headerMisses.length) {
      console.error(`[racecard] header has 米 and 全天候/草地 but distance/track empty for races ${headerMisses.join(',')} — failing closed`);
      process.exit(RACECARD_HEADER_MISS_EXIT);
    }
  }

  main().catch((err) => {
    console.error('[racecard] fatal:', err);
    process.exit(1);
  });
  
