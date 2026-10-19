#!/usr/bin/env tsx
/**
 * Elo v1.2 batch compute driver — HK-Native Time-Weighted Multi-Axis
 *
 * Upgrades over v1.1 (full spec: see engine_v12.ts header):
 *   1. Time-weighted pairwise K per (entity × race) using exp(-Δt/τ)
 *   2. Per-axis K base (Horse 28 / Jockey 18 / Trainer 11)
 *   3. Provisional boost for games_played < 6
 *   4. Burn-in 2016-2017 hard gate (writes is_burnin=1, does NOT suppress snapshot)
 *   5. Foreign-import priors (resolvePriorRating via horse_profiles.import_type +
 *      jockey_profile visiting flag)
 *   6. Freeze (not decay) on idle — configurable per axis
 *   7. End-of-season (7/31) mean regression with α per axis
 *   8. Confidence score stored per snapshot
 *
 * Usage:
 *   tsx scripts/elo/compute_v12.ts [--db=<path>] [--run-label=<str>]
 *                                   [--from=<YYYY-MM-DD>] [--to=<YYYY-MM-DD>]
 *                                   [--reset]
 */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, ensureSchema } from '../ingest/lib/db.js';
import {
  V12_DEFAULTS,
  IMPORT_PRIORS,
  resolvePriorRating,
  classifyIdle,
  applySeasonEndRegressionIfNeeded,
  computeV12RaceDeltas,
  computeConfidence,
  isBurnInRace,
  type V12AxisState,
  type V12Config,
  type V12Runner,
  type AxisType,
} from './engine_v12.js';
import { normalizeSurface, distanceBucket } from '../ingest/lib/parsers.js';
import { readChangesManifest } from '../backtest/withdrawal-input';
import { officialWithdrawal } from '../../src/lib/hkjc-changes';
import { assertChangeResultConsistent } from '../../src/lib/racing-change-records';

interface Args {
  db: string;
  runLabel: string;
  fromDate: string;
  toDate: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a: Args = {
    db: resolve(process.cwd(), 'bulk-local.db'),
    runLabel: `v12_${now}_${randomUUID()}`,
    fromDate: '2016-01-01',
    toDate: '9999-12-31',
    reset: false,
  };
  for (const x of argv.slice(2)) {
    if (x.startsWith('--db=')) a.db = resolve(x.slice('--db='.length));
    else if (x.startsWith('--run-label=')) a.runLabel = x.slice('--run-label='.length);
    else if (x.startsWith('--from=')) a.fromDate = x.slice('--from='.length);
    else if (x.startsWith('--to=')) a.toDate = x.slice('--to='.length);
    else if (x === '--reset') a.reset = true;
    else throw new Error(`Unknown v12 argument: ${x}`);
  }
  if (a.fromDate !== '2016-01-01') throw new Error('v12 requires full history replay; filter publication, not state initialization');
  return a;
}

function log(section: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${section}] ${msg}`);
}

interface FormRow {
  horse_id: string;
  race_date: string;
  venue: string | null;
  race_number: number | null;
  distance: number | null;
  track: string | null;
  jockey_name: string | null;
  trainer_name: string | null;
  finishing_position_num: number;
}

interface RaceKey { date: string; venue: string; raceNo: number; }

interface HorseImportFlags {
  isForeignImport: boolean;
  isPrivatePurchase: boolean;
}

function daysBetweenIso(fromDate: string, toDate: string): number {
  const ms = Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z');
  return Math.round(ms / 86_400_000);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  log('elo12', `db=${args.db}`);
  log('elo12', `run=${args.runLabel} from=${args.fromDate} to=${args.toDate} reset=${args.reset}`);

  const db = openDb(args.db);
  const changePages = readChangesManifest(process.env.HKJC_CHANGES_MANIFEST ?? '');
  const pageByMeeting = new Map(changePages.map(p => [p.date + ':' + p.venue, p]));
  ensureSchema(db, [
    resolve(process.cwd(), 'src', 'db', 'schema.sql'),
    resolve(process.cwd(), 'src', 'db', 'schema_v2.sql'),
    resolve(process.cwd(), 'src', 'db', 'schema_v12.sql'),
  ]);

  // === Backfill horse_form_records.jockey_name / trainer_name from race_results ===
  // The HKJC source CSV occasionally leaves the jockey/trainer column blank, which
  // dropped affected runners (e.g. 布浩榮) from the ELO compute. race_results has
  // the authoritative jockey_name / trainer_name keyed on (horse_id, race_date) so
  // use that as the recovery source before we read horse_form_records.
  const beforeJ = (db.prepare('SELECT COUNT(*) AS n FROM horse_form_records WHERE jockey_name IS NULL').get() as { n: number }).n;
  const beforeT = (db.prepare('SELECT COUNT(*) AS n FROM horse_form_records WHERE trainer_name IS NULL').get() as { n: number }).n;
  // race_results stores only jockey_id / trainer_id, so JOIN through the
  // jockeys / trainers master tables to recover the name column.
  db.exec(`
    UPDATE horse_form_records
       SET jockey_name = (
         SELECT j.name_ch FROM race_results rr
         JOIN jockeys j ON j.id = rr.jockey_id
         JOIN races r ON r.id = rr.race_id
         JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id = horse_form_records.horse_id
           AND rm.date = horse_form_records.race_date
           AND rr.jockey_id IS NOT NULL
         LIMIT 1
       )
     WHERE jockey_name IS NULL;
    UPDATE horse_form_records
       SET trainer_name = (
         SELECT t.name_ch FROM race_results rr
         JOIN trainers t ON t.id = rr.trainer_id
         JOIN races r ON r.id = rr.race_id
         JOIN race_meetings rm ON rm.id = r.meeting_id
         WHERE rr.horse_id = horse_form_records.horse_id
           AND rm.date = horse_form_records.race_date
           AND rr.trainer_id IS NOT NULL
         LIMIT 1
       )
     WHERE trainer_name IS NULL;
  `);
  const afterJ = (db.prepare('SELECT COUNT(*) AS n FROM horse_form_records WHERE jockey_name IS NULL').get() as { n: number }).n;
  const afterT = (db.prepare('SELECT COUNT(*) AS n FROM horse_form_records WHERE trainer_name IS NULL').get() as { n: number }).n;
  log('elo', `backfill jockey_name: ${beforeJ} -> ${afterJ} NULL  (recovered ${beforeJ - afterJ})`);
  log('elo', `backfill trainer_name: ${beforeT} -> ${afterT} NULL  (recovered ${beforeT - afterT})`);


  db.pragma('synchronous = OFF');
  db.pragma('journal_mode = MEMORY');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -262144');

  // Participant validation below must finish before resetting any Elo snapshots.

  db.prepare(
    `INSERT INTO elo_runs (id, run_label, k_factor, initial_rating, burn_in_from, engine_version,
       tau_horse_days, tau_jockey_days, tau_trainer_days, freeze_threshold_horse, season_alpha_horse, started_at)
     VALUES (?, ?, ?, ?, ?, 'v1.2', ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    args.runLabel,
    args.runLabel,
    V12_DEFAULTS.horse.k,
    V12_DEFAULTS.horse.initialRating,
    V12_DEFAULTS.horse.burnInToDate,
    V12_DEFAULTS.horse.tauDays,
    V12_DEFAULTS.jockey.tauDays,
    V12_DEFAULTS.trainer.tauDays,
    V12_DEFAULTS.horse.freezeThresholdDays,
    V12_DEFAULTS.horse.seasonAlpha,
  );
  const runFinish = db.prepare(
    `UPDATE elo_runs SET finished_at = datetime('now'), races_processed = ?, results_processed = ?, success = ?, error_message = ? WHERE id = ?`,
  );

  // Preload import flags from horse_profiles if it exists
  const horseImportFlags = new Map<string, HorseImportFlags>();
  try {
    const profiles = db.prepare(
      `SELECT id AS horse_id, import_type FROM horse_profiles WHERE import_type IS NOT NULL`,
    ).all() as Array<{ horse_id: string; import_type: string }>;
    for (const p of profiles) {
      const t = (p.import_type || '').toUpperCase();
      horseImportFlags.set(p.horse_id, {
        isForeignImport: ['GR', 'ISG', 'PPG', 'IMPORTED'].some((x) => t.includes(x)),
        isPrivatePurchase: t === 'PP',
      });
    }
    log('elo12', `preloaded ${horseImportFlags.size} horse import flags`);
  } catch (e) {
    log('elo12', `horse_profiles unavailable or empty — all horses default to 1500`);
  }

  const rows = db.prepare(
    `SELECT horse_id, race_date, venue, race_number, distance, track,
            jockey_name, trainer_name, finishing_position_num
       FROM horse_form_records
       WHERE race_date >= ? AND race_date <= ?
         AND venue IS NOT NULL AND race_number IS NOT NULL
       ORDER BY race_date ASC, venue ASC, race_number ASC`,
  ).all(args.fromDate, args.toDate) as FormRow[];
  log('elo12', `loaded ${rows.length} form rows`);

  const races = new Map<string, { key: RaceKey; runners: FormRow[] }>();
  for (const r of rows) {
    if (!r.venue || r.race_number == null) continue;
    const page = pageByMeeting.get(r.race_date + ':' + r.venue);
    if(r.race_date >= '2026-10-19' && !page) throw new Error('elo-official-meeting-coverage-missing');
    const horse = db.prepare('SELECT id,name_ch FROM horses WHERE id=? OR code=?').get(r.horse_id,r.horse_id) as {id:string;name_ch:string}|undefined;
    const result = horse ? db.prepare(`SELECT rr.horse_number,rr.finishing_position,j.name_ch AS jockey_name FROM race_results rr JOIN races ra ON ra.id=rr.race_id JOIN race_meetings m ON m.id=ra.meeting_id LEFT JOIN jockeys j ON j.id=rr.jockey_id WHERE m.date=? AND m.venue=? AND ra.race_number=? AND rr.horse_id=?`).get(r.race_date,r.venue,r.race_number,horse.id) as {horse_number:number;finishing_position:number|null;jockey_name:string|null}|undefined : undefined;
    if(page?.changes.some(c=>c.raceNumber===r.race_number) && (!horse || !result)) throw new Error('elo-change-runner-identity-unverified');
    if(result && horse && officialWithdrawal(page?.changes ?? [],r.race_number,result.horse_number,horse.name_ch)) {
      assertChangeResultConsistent(true,result.finishing_position); continue;
    }
    if(result?.jockey_name) r.jockey_name = result.jockey_name;
    else if(page?.changes.some(c=>c.raceNumber===r.race_number&&c.kind==='other'&&/騎師|策騎/.test(c.text))) throw new Error('elo-actual-jockey-unverified');
    const ks = `${r.race_date}|${r.venue}|${r.race_number}`;
    if (!races.has(ks)) races.set(ks, { key: { date: r.race_date, venue: r.venue, raceNo: r.race_number }, runners: [] });
    const race = races.get(ks);
    if (race) race.runners.push(r);
  }
  const sortedRaces = Array.from(races.values()).sort((a, b) => {
    if (a.key.date !== b.key.date) return a.key.date < b.key.date ? -1 : 1;
    if (a.key.venue !== b.key.venue) return a.key.venue < b.key.venue ? -1 : 1;
    return a.key.raceNo - b.key.raceNo;
  });
  log('elo12', `reconstructed ${sortedRaces.length} races`);
  if (args.reset) {
    db.transaction(() => {
      db.prepare(`DELETE FROM horse_elo_snapshots WHERE id LIKE 'v12:%'`).run();
      db.prepare(`DELETE FROM jockey_elo_snapshots WHERE id LIKE 'v12:%'`).run();
      db.prepare(`DELETE FROM trainer_elo_snapshots WHERE id LIKE 'v12:%'`).run();
    })();
    log('elo12', 'validated participants; reset v12 snapshots only');
  }

  // State stores: key = `${entityId}|${axisKey}`
  const horseStore = new Map<string, V12AxisState>();
  const jockeyStore = new Map<string, V12AxisState>();
  const trainerStore = new Map<string, V12AxisState>();

  const getOrInitV12 = (
    store: Map<string, V12AxisState>,
    entityId: string,
    axisKey: string,
    axisType: AxisType,
    flags?: HorseImportFlags,
  ): V12AxisState => {
    const k = `${entityId}|${axisKey}`;
    let s = store.get(k);
    if (!s) {
      const prior = resolvePriorRating(axisType, {
        isForeignImport: flags?.isForeignImport,
        isPrivatePurchase: flags?.isPrivatePurchase,
      });
      s = {
        rating: prior,
        gamesPlayed: 0,
        recencyWeightedGames: 0,
        lastRaceDate: null,
        priorRating: prior,
        lastSeasonEndApplied: null,
        isFrozen: false,
        isRetired: false,
      };
      store.set(k, s);
    }
    return s;
  };

  const insertHorseSnap = db.prepare(
    `INSERT OR REPLACE INTO horse_elo_snapshots
       (id, horse_id, axis_key, surface, distance_bucket, as_of_race_id, as_of_date,
        rating, games_played, days_since_last_race, last_decay_applied_days,
        prior_rating, is_burnin, is_frozen, is_retired, is_provisional, is_season_end,
        confidence, recency_weighted_games, computed_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const insertJockeySnap = db.prepare(
    `INSERT OR REPLACE INTO jockey_elo_snapshots
       (id, jockey_id, as_of_race_id, as_of_date, rating, games_played,
        prior_rating, is_burnin, is_frozen, is_retired, is_provisional, is_season_end,
        confidence, recency_weighted_games, computed_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const insertTrainerSnap = db.prepare(
    `INSERT OR REPLACE INTO trainer_elo_snapshots
       (id, trainer_id, as_of_race_id, as_of_date, rating, games_played,
        prior_rating, is_burnin, is_frozen, is_retired, is_provisional, is_season_end,
        confidence, recency_weighted_games, computed_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  let processedRaces = 0;
  let processedResults = 0;
  let frozenCount = 0;
  let retiredCount = 0;
  let seasonEndCount = 0;
  let burnInCount = 0;

  const processLayerV12 = (
    raceKey: RaceKey,
    axisType: AxisType,
    store: Map<string, V12AxisState>,
    axisKey: string,
    layerRunners: Array<{ entityId: string; finish: number; flags?: HorseImportFlags }>,
    surface: 'turf' | 'awt' | null,
    bucket: string | null,
  ): void => {
    if (layerRunners.length < 2) return;
    const cfg = V12_DEFAULTS[axisType];
    const burnIn = isBurnInRace(cfg, raceKey.date);

    // Build V12Runner[] + per-entity idle metadata, applying freeze/retire/season-end
    const v12Runners: V12Runner[] = [];
    const meta = new Map<string, {
      gapDays: number | null;
      isFrozen: boolean;
      isRetired: boolean;
      isSeasonEnd: boolean;
      isProvisional: boolean;
      priorRating: number;
    }>();

    for (const lr of layerRunners) {
      const s = getOrInitV12(store, lr.entityId, axisKey, axisType, lr.flags);
      const idleCls = classifyIdle(cfg, s, raceKey.date);
      // Apply season-end regression BEFORE using current rating
      const seasonEnd = applySeasonEndRegressionIfNeeded(cfg, s, raceKey.date);
      if (seasonEnd.applied) seasonEndCount++;

      // If frozen, rating stays put — but we still let them participate (rating carries over)
      // If retired, we exclude from rating-changes (but still snapshot their last-known rating)
      if (idleCls.isRetired) retiredCount++;
      else if (idleCls.isFrozen) frozenCount++;

      v12Runners.push({
        entityId: lr.entityId,
        finish: lr.finish,
        currentRating: s.rating,
        gamesPlayed: s.gamesPlayed,
        daysSinceLastRace: idleCls.gapDays,
      });
      meta.set(lr.entityId, {
        gapDays: idleCls.gapDays,
        isFrozen: idleCls.isFrozen,
        isRetired: idleCls.isRetired,
        isSeasonEnd: seasonEnd.applied,
        isProvisional: s.gamesPlayed < cfg.provisionalGamesThreshold,
        priorRating: s.priorRating,
      });
    }

    // Retired entities: don't update their rating this race
    const activeRunners = v12Runners.filter((r) => !meta.get(r.entityId)?.isRetired);
    const deltas = activeRunners.length >= 2
      ? computeV12RaceDeltas(activeRunners, cfg)
      : new Map<string, number>();

    // Apply deltas + write snapshots (all entities, even retired, get a snapshot row
    // so we can show their last-known rating in the UI)
    for (const lr of layerRunners) {
      const s = store.get(`${lr.entityId}|${axisKey}`);
      const m = meta.get(lr.entityId);
      if (!s || !m) throw new Error('Missing v12 runner state');
      const delta = deltas.get(lr.entityId) ?? 0;

      if (!m.isRetired && !m.isFrozen) {
        s.rating += delta;
        s.gamesPlayed += 1;
        // Recency-weighted games: decay prior + 1 for this race
        const gapTau = m.gapDays != null ? Math.exp(-m.gapDays / cfg.tauDays) : 1;
        s.recencyWeightedGames = s.recencyWeightedGames * gapTau + 1;
        s.lastRaceDate = raceKey.date;
      } else if (m.isFrozen) {
        // Frozen: update lastRaceDate so we start counting idle fresh,
        // but don't change rating or games
        s.lastRaceDate = raceKey.date;
        // NOTE: frozen horse that comes back should probably be marked provisional
      }

      if (burnIn) burnInCount++;

      const confidence = computeConfidence(cfg, s);
      const snapId = `v12:${lr.entityId}|${axisKey}|${raceKey.date}|${raceKey.venue}|${raceKey.raceNo}`;

      if (axisType === 'horse') {
        insertHorseSnap.run(
          snapId, lr.entityId, axisKey, surface, bucket, raceKey.date,
          s.rating, s.gamesPlayed, m.gapDays,
          m.priorRating,
          burnIn ? 1 : 0,
          m.isFrozen ? 1 : 0,
          m.isRetired ? 1 : 0,
          m.isProvisional ? 1 : 0,
          m.isSeasonEnd ? 1 : 0,
          confidence,
          s.recencyWeightedGames,
        );
      } else if (axisType === 'jockey') {
        insertJockeySnap.run(
          snapId, lr.entityId, raceKey.date, s.rating, s.gamesPlayed,
          m.priorRating,
          burnIn ? 1 : 0,
          m.isFrozen ? 1 : 0,
          m.isRetired ? 1 : 0,
          m.isProvisional ? 1 : 0,
          m.isSeasonEnd ? 1 : 0,
          confidence,
          s.recencyWeightedGames,
        );
      } else {
        insertTrainerSnap.run(
          snapId, lr.entityId, raceKey.date, s.rating, s.gamesPlayed,
          m.priorRating,
          burnIn ? 1 : 0,
          m.isFrozen ? 1 : 0,
          m.isRetired ? 1 : 0,
          m.isProvisional ? 1 : 0,
          m.isSeasonEnd ? 1 : 0,
          confidence,
          s.recencyWeightedGames,
        );
      }
    }
  };

  const raceTx = db.transaction((runners: FormRow[], raceKey: RaceKey) => {
    const surface = normalizeSurface(runners[0]?.track ?? null);
    const bucket = distanceBucket(runners[0]?.distance ?? null);
    const axisKey = surface && bucket ? `${surface}_${bucket}` : null;

    // Layer A — horse OVERALL (axis_key = 'overall')
    processLayerV12(
      raceKey, 'horse', horseStore, 'overall',
      runners.map((r) => ({
        entityId: r.horse_id,
        finish: r.finishing_position_num,
        flags: horseImportFlags.get(r.horse_id),
      })),
      null, null,
    );

    // Layer B — horse per-axis (surface × bucket) if known
    if (axisKey) {
      processLayerV12(
        raceKey, 'horse', horseStore, axisKey,
        runners.map((r) => ({
          entityId: r.horse_id,
          finish: r.finishing_position_num,
          flags: horseImportFlags.get(r.horse_id),
        })),
        surface, bucket,
      );
    }

    // Layer C — jockey
    processLayerV12(
      raceKey, 'jockey', jockeyStore, 'overall',
      runners.filter((r) => r.jockey_name).map((r) => ({
        entityId: r.jockey_name ?? '',
        finish: r.finishing_position_num,
      })),
      null, null,
    );

    // Layer D — trainer
    processLayerV12(
      raceKey, 'trainer', trainerStore, 'overall',
      runners.filter((r) => r.trainer_name).map((r) => ({
        entityId: r.trainer_name ?? '',
        finish: r.finishing_position_num,
      })),
      null, null,
    );

    processedResults += runners.length;
  });

  log('elo12', `starting race loop; first race = ${sortedRaces[0]?.key.date}|${sortedRaces[0]?.key.venue}|${sortedRaces[0]?.key.raceNo}`);
  const t0 = Date.now();
  for (const race of sortedRaces) {
    try {
      raceTx(race.runners, race.key);
      processedRaces++;
      if (processedRaces <= 3 || processedRaces % 200 === 0) {
        log('elo12', `progress ${processedRaces}/${sortedRaces.length} · ${processedResults} results · frozen=${frozenCount} retired=${retiredCount} seasonEnd=${seasonEndCount} burnIn=${burnInCount} · ${Date.now() - t0}ms`);
      }
    } catch (err) {
      runFinish.run(processedRaces, processedResults, 0, String(err), args.runLabel);
      db.close();
      throw err;
    }
  }
  const ms = Date.now() - t0;
  log('elo12', `done: ${processedRaces} races · ${processedResults} results · frozen=${frozenCount} retired=${retiredCount} seasonEnd=${seasonEndCount} burnIn=${burnInCount} · ${ms}ms`);
  log('elo12', `horse axes=${horseStore.size} jockeys=${jockeyStore.size} trainers=${trainerStore.size}`);

  runFinish.run(processedRaces, processedResults, 1, null, args.runLabel);
  db.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
