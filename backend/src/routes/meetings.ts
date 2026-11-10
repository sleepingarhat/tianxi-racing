import { Hono } from 'hono';
import type { Env, RaceMeetingRow } from '../types';
import { hhmmFromPostTime, fetchPostTimeMap } from '../lib/race-time';
import { fetchLatestWinOddsByRace, normHorseKey } from '../lib/market-blend';
import { selectDeclaredRunners, upcomingRaceHeaderView } from '../lib/upcoming-race-header';
import {
  positiveInt,
  cardDeltas,
  publicWeights,
  resolveCardStatus,
  type CardSignals,
} from '../lib/meeting-card';

export const meetingsRoutes = new Hono<{ Bindings: Env }>();

function venueName(v: string | null | undefined) {
  return v === 'ST' ? '沙田' : v === 'HV' ? '跑馬地' : v;
}

function isGhost(m: { total_races?: number | null }) {
  const n = Number(m.total_races);
  return Number.isFinite(n) && n > 0 && n < 4;
}

function missingTable(err: unknown): boolean {
  return /no such table|no such column/i.test(String((err as { message?: string })?.message ?? err));
}

async function selectAll<T = any>(db: Env['DB'], sql: string, params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...params).all<T>();
  return results ?? [];
}

async function optionalAll<T = any>(db: Env['DB'], sql: string, params: unknown[]): Promise<T[] | null> {
  try {
    return await selectAll<T>(db, sql, params);
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

async function declaredRaceCount(db: Env['DB'], date: string, venue: string): Promise<number> {
  try {
    const row = await db
      .prepare(
        'SELECT COUNT(DISTINCT race_number) AS n FROM entries_upcoming WHERE race_date = ? AND venue = ? AND race_number > 0'
      )
      .bind(date, venue)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

type ProfileExtra = { horse_id: string; owner: string | null; import_type: string | null; season_stakes_int: number | null };

async function profileExtras(db: Env['DB'], horseIds: string[]): Promise<Map<string, ProfileExtra>> {
  const map = new Map<string, ProfileExtra>();
  const ids = [...new Set(horseIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await optionalAll<ProfileExtra>(
      db,
      `SELECT horse_id, owner, import_type, season_stakes_int FROM horse_profile_extra WHERE horse_id IN (${marks})`,
      chunk,
    );
    if (!rows) return map;
    for (const row of rows) map.set(row.horse_id, row);
  }
  return map;
}

function runnerProfile(row: any, extra: ProfileExtra | undefined) {
  const seasonFromHorse = positiveInt(row?.season_stakes);
  return {
    age: row?.age ?? null,
    sex: row?.sex ?? null,
    owner: extra?.owner ?? null,
    importType: extra?.import_type ?? row?.import_type ?? null,
    seasonStakes: extra?.season_stakes_int ?? seasonFromHorse,
    recentForm: row?.last6run ?? null,
    silkFile: row?.silk_file ?? null,
    silksCode: row?.silks_code ?? row?.code ?? row?.horse_code ?? null,
    internationalRating: row?.international_rating ?? null,
    allowance: row?.allowance ?? null,
    priorityOrder: row?.priority_order ?? null,
    gear: row?.gear ?? null,
    sire: row?.sire ?? null,
    dam: row?.dam ?? null,
    damSire: row?.dam_sire ?? null,
  };
}

function signalsFrom(
  raceRow: { races?: number; results?: number } | undefined,
  declared: { runners?: number; draws?: number } | undefined,
  officialCount: number,
): CardSignals {
  return {
    resulted: Number(raceRow?.results ?? 0) > 0,
    hasRaces: Number(raceRow?.races ?? 0) > 0,
    declaredRunners: Number(declared?.runners ?? 0),
    declaredDraws: Number(declared?.draws ?? 0),
    officialEntries: officialCount,
  };
}

async function cardSignalsForRange(db: Env['DB'], from: string, to: string) {
  const races = await optionalAll<any>(
    db,
    `SELECT rm.date AS date, rm.venue AS venue,
            COUNT(DISTINCT r.id) AS races,
            COUNT(rr.id) AS results
       FROM race_meetings rm
       LEFT JOIN races r ON r.meeting_id = rm.id
       LEFT JOIN race_results rr ON rr.race_id = r.id
      WHERE rm.date >= ? AND rm.date <= ? AND rm.venue IN ('ST','HV')
      GROUP BY rm.date, rm.venue`,
    [from, to],
  );
  const declared = await optionalAll<any>(
    db,
    `SELECT race_date AS date, venue,
            SUM(CASE WHEN race_number > 0 THEN 1 ELSE 0 END) AS runners,
            SUM(CASE WHEN race_number > 0 AND draw IS NOT NULL THEN 1 ELSE 0 END) AS draws
       FROM entries_upcoming
      WHERE race_date >= ? AND race_date <= ? AND venue IN ('ST','HV')
      GROUP BY race_date, venue`,
    [from, to],
  );
  const official = await optionalAll<any>(
    db,
    `SELECT race_date AS date, venue, COUNT(*) AS n
       FROM official_race_entries
      WHERE race_date >= ? AND race_date <= ?
      GROUP BY race_date, venue`,
    [from, to],
  );
  const raceMap = new Map<string, any>();
  const declaredMap = new Map<string, any>();
  const officialMap = new Map<string, number>();
  for (const row of races ?? []) raceMap.set(`${row.date}|${row.venue}`, row);
  for (const row of declared ?? []) declaredMap.set(`${row.date}|${row.venue}`, row);
  for (const row of official ?? []) officialMap.set(`${row.date}|${row.venue}`, Number(row.n) || 0);
  return { raceMap, declaredMap, officialMap };
}

async function buildRacecardFromEntries(
  db: Env['DB'],
  date: string,
  venue: string,
  trackCondition: string | null,
): Promise<any[]> {
  const rows = await selectDeclaredRunners<any>(db, date, venue);
  const ptMap = await fetchPostTimeMap(db, date, venue);
  const oddsByRace = await fetchLatestWinOddsByRace(db, date, venue);
  const profiles = await profileExtras(db, rows.map((row) => row.horse_id));

  const byRace = new Map<number, any[]>();
  for (const row of rows) {
    if (!byRace.has(row.race_number)) byRace.set(row.race_number, []);
    byRace.get(row.race_number)!.push(row);
  }

  return Array.from(byRace.keys()).sort((a, b) => a - b).map((rn) => {
    const entries = byRace.get(rn)!;
    const header = upcomingRaceHeaderView(entries[0], trackCondition);
    return {
      id: `race_${date}_${venue}_${rn}`,
      raceNumber: rn,
      title: header.title,
      class: header.class,
      distance: header.distance,
      going: header.going,
      track: header.track,
      course: header.course,
      prize: header.prize,
      ratingRange: header.ratingRange,
      startTime: hhmmFromPostTime(ptMap.get(rn)) ?? null,
      videoUrl: null,
      isDeclaredCard: true,
      cardStatus: 'declared',
      horses: entries.map((e: any) => {
        const weights = publicWeights('upcoming', e);
        return {
          id: e.horse_id,
          horseNumber: e.horse_number,
          name: e.name_en,
          nameCh: e.name_ch,
          code: e.code ?? e.horse_code,
          draw: e.draw,
          jockey: e.jockey_name,
          jockeyCh: e.jockey_name,
          trainer: e.trainer_name,
          trainerCh: e.trainer_name,
          finishingPosition: null,
          finishTime: null,
          winOdds: oddsByRace.get(rn)?.odds.get(normHorseKey(e.horse_number)) ?? null,
          runningPosition: null,
          lbw: null,
          rating: e.current_rating ?? e.rating,
          ...weights,
          ...cardDeltas(e),
          ...runnerProfile(e, profiles.get(e.horse_id)),
        };
      }),
    };
  });
}

async function buildEntriesOnlyCard(db: Env['DB'], date: string, venue: string): Promise<any[]> {
  const rows = await optionalAll<any>(
    db,
    `SELECT e.*, h.id AS horse_id, h.name_en, h.sire, h.dam, h.dam_sire,
            h.age, h.sex, h.import_type, h.season_stakes, h.current_rating, h.code
       FROM official_race_entries e
       LEFT JOIN horses h ON h.code = e.horse_code
      WHERE e.race_date = ? AND e.venue = ?
      ORDER BY e.race_number, e.horse_code`,
    [date, venue],
  );
  if (!rows?.length) return [];
  const profiles = await profileExtras(db, rows.map((row) => row.horse_id).filter(Boolean));
  const byRace = new Map<number, any[]>();
  for (const row of rows) {
    if (!byRace.has(row.race_number)) byRace.set(row.race_number, []);
    byRace.get(row.race_number)!.push(row);
  }
  return Array.from(byRace.keys()).sort((a, b) => a - b).map((rn) => {
    const entries = byRace.get(rn)!;
    const first = entries[0];
    return {
      id: `entries_${date}_${venue}_${rn}`,
      raceNumber: rn,
      title: first.race_name ?? null,
      class: first.race_class ?? null,
      distance: first.distance ?? null,
      going: null,
      track: first.track ?? null,
      course: null,
      prize: null,
      ratingRange: first.rating_range ?? null,
      startTime: null,
      videoUrl: null,
      isDeclaredCard: false,
      cardStatus: 'entries',
      drawStatus: 'unavailable',
      horses: entries.map((e: any) => ({
        id: e.horse_id ?? null,
        horseNumber: null,
        name: e.name_en ?? null,
        nameCh: e.horse_name,
        code: e.horse_code,
        draw: null,
        jockey: null,
        jockeyCh: null,
        trainer: e.trainer_name ?? null,
        trainerCh: e.trainer_name ?? null,
        finishingPosition: null,
        finishTime: null,
        winOdds: null,
        runningPosition: null,
        lbw: null,
        rating: e.current_rating ?? null,
        ...publicWeights('upcoming', {}),
        ...cardDeltas(null),
        ...runnerProfile(e, e.horse_id ? profiles.get(e.horse_id) : undefined),
      })),
    };
  });
}

function dateFilters(from?: string, to?: string, venue?: string, month?: string) {
  let sql = '';
  const params: unknown[] = [];
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  if (venue) { sql += ' AND venue = ?'; params.push(venue.toUpperCase()); }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    sql += ' AND substr(date, 1, 7) = ?';
    params.push(month);
  }
  return { sql, params };
}

// GET /api/meetings — list. A month/from/to window also includes official
// fixture days that do not yet have a race_meetings row. Those days are
// cardStatus=fixture or entries, not a declared racecard.
meetingsRoutes.get('/', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const venue = c.req.query('venue');
  const month = c.req.query('month');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 200);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  const bounded = Boolean((month && /^\d{4}-\d{2}$/.test(month)) || from || to);

  const loadMeetings = async (heavy: boolean) => {
    let sql =
      'SELECT m.id, m.date, m.venue, m.track_condition, m.weather, m.total_races ' +
      "FROM race_meetings m WHERE m.venue IN ('ST','HV') ";
    const params: unknown[] = [];
    if (heavy) sql += 'AND (m.total_races IS NULL OR m.total_races >= 4) ';
    if (from) { sql += ' AND m.date >= ?'; params.push(from); }
    if (to) { sql += ' AND m.date <= ?'; params.push(to); }
    if (venue) { sql += ' AND m.venue = ?'; params.push(venue.toUpperCase()); }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      sql += ' AND substr(m.date, 1, 7) = ?';
      params.push(month);
    }
    sql += bounded
      ? ' ORDER BY m.date DESC LIMIT 400'
      : ' ORDER BY m.date DESC LIMIT ? OFFSET ?';
    if (!bounded) params.push(limit + 16, offset);
    const rows = await selectAll<RaceMeetingRow>(c.env.DB, sql, params);
    return rows.filter((row) => !isGhost(row));
  };

  try {
    const meetingRows = await loadMeetings(true);
    const filter = dateFilters(from, to, venue, month);
    const fixtures = bounded
      ? await optionalAll<any>(
        c.env.DB,
        `SELECT date, venue, weekday, timing, race_count, surface, captured_at
           FROM official_fixtures WHERE venue IN ('ST','HV') ${filter.sql}
          ORDER BY date DESC LIMIT 400`,
        filter.params,
      )
      : [];

    const byKey = new Map<string, { meeting?: RaceMeetingRow; fixture?: any }>();
    for (const meeting of meetingRows) {
      byKey.set(`${meeting.date}|${meeting.venue}`, { meeting });
    }
    for (const fixture of fixtures ?? []) {
      const key = `${fixture.date}|${fixture.venue}`;
      const slot = byKey.get(key) ?? {};
      slot.fixture = fixture;
      byKey.set(key, slot);
    }
    let merged = [...byKey.values()].sort((a, b) => {
      const ad = a.meeting?.date ?? a.fixture.date;
      const bd = b.meeting?.date ?? b.fixture.date;
      if (ad !== bd) return ad < bd ? 1 : -1;
      const av = a.meeting?.venue ?? a.fixture.venue;
      const bv = b.meeting?.venue ?? b.fixture.venue;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (bounded) merged = merged.slice(offset, offset + limit);
    else merged = merged.slice(0, limit);

    const dates = merged.map((row) => row.meeting?.date ?? row.fixture.date);
    const spanFrom = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : '';
    const spanTo = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : '';
    const signals = dates.length
      ? await cardSignalsForRange(c.env.DB, spanFrom, spanTo)
      : { raceMap: new Map(), declaredMap: new Map(), officialMap: new Map() };

    const meetings = merged.map((row) => {
      const meeting = row.meeting;
      const fixture = row.fixture;
      const date = meeting?.date ?? fixture.date;
      const venueCode = meeting?.venue ?? fixture.venue;
      const key = `${date}|${venueCode}`;
      const view = resolveCardStatus(signalsFrom(
        signals.raceMap.get(key),
        signals.declaredMap.get(key),
        signals.officialMap.get(key) ?? 0,
      ));
      const fixtureCount = fixture?.race_count == null ? null : Number(fixture.race_count);
      return {
        id: meeting?.id ?? `fixture_${date}_${venueCode}`,
        date,
        venue: venueCode,
        venueName: venueName(venueCode),
        trackCondition: meeting?.track_condition ?? null,
        weather: meeting?.weather ?? null,
        totalRaces: meeting?.total_races || (Number.isFinite(fixtureCount) ? fixtureCount : null) || null,
        timing: fixture?.timing ?? null,
        surface: fixture?.surface ?? null,
        source: meeting
          ? 'race_meetings'
          : view.cardStatus === 'entries'
            ? 'official_race_entries'
            : 'official_fixtures',
        ...view,
      };
    });
    return c.json({ meetings, total: meetings.length });
  } catch (err) {
    console.error('[meetings.list]', err);
    try {
      const meetings = (await loadMeetings(false)).slice(bounded ? offset : 0, bounded ? offset + limit : limit).map((m) => ({
        id: m.id,
        date: m.date,
        venue: m.venue,
        venueName: venueName(m.venue),
        trackCondition: m.track_condition,
        weather: m.weather,
        totalRaces: m.total_races,
      }));
      return c.json({ meetings, total: meetings.length, degraded: true });
    } catch (err2) {
      console.error('[meetings.list.fallback]', err2);
      return c.json({ meetings: [], total: 0, error: 'meetings_unavailable' }, 200);
    }
  }
});

meetingsRoutes.get('/next', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    let meeting = await c.env.DB.prepare(
      "SELECT * FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV') ORDER BY date ASC LIMIT 1"
    ).bind(today).first<RaceMeetingRow>();

    let fallback = false;
    if (!meeting) {
      meeting = await c.env.DB.prepare(
        "SELECT * FROM race_meetings WHERE venue IN ('ST','HV') ORDER BY date DESC LIMIT 1"
      ).first<RaceMeetingRow>();
      fallback = true;
    }

    if (!meeting) {
      return c.json({ error: '資料庫冇賽事紀錄' }, 404);
    }

    const { results: races } = await c.env.DB.prepare(
      'SELECT id, race_number, title, class, distance, going, track, course, start_time FROM races WHERE meeting_id = ? ORDER BY race_number'
    ).bind(meeting.id).all<any>();

    let totalRaces = (races ?? []).length || meeting.total_races;
    if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, meeting.date, meeting.venue);

    return c.json({
      id: meeting.id,
      date: meeting.date,
      venue: meeting.venue,
      venueName: venueName(meeting.venue),
      trackCondition: meeting.track_condition,
      weather: meeting.weather,
      totalRaces,
      fallback,
      races: (races ?? []).map((r) => ({
        id: r.id,
        raceNumber: r.race_number,
        title: r.title,
        className: r.class,
        distanceM: r.distance,
        going: r.going,
        track: r.track,
        course: r.course,
        startTime: r.start_time,
        handicapType: r.title || null,
      })),
    });
  } catch (err) {
    console.error('[meetings.next]', err);
    return c.json({ error: 'meetings_unavailable' }, 200);
  }
});

meetingsRoutes.get('/:date', async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: '找不到該日期的賽事' }, 404);
  }
  try {
    const { results: bestMeeting } = await c.env.DB.prepare(
      `SELECT rm.*, COUNT(r.id) AS _race_count
         FROM race_meetings rm
         LEFT JOIN races r ON r.meeting_id = rm.id
        WHERE rm.date = ? AND rm.venue IN ('ST','HV')
        GROUP BY rm.id
        ORDER BY _race_count DESC, rm.id DESC
        LIMIT 1`
    ).bind(date).all<RaceMeetingRow & { _race_count: number }>();
    const meeting = bestMeeting?.[0];
    const fixtures = await optionalAll<any>(
      c.env.DB,
      `SELECT date, venue, weekday, timing, race_count, surface
         FROM official_fixtures WHERE date = ? AND venue IN ('ST','HV')`,
      [date],
    );
    const fixture = (fixtures ?? []).find((row) => !meeting || row.venue === meeting.venue) ?? fixtures?.[0] ?? null;
    const entryVenueRows = await optionalAll<any>(
      c.env.DB,
      `SELECT venue, COUNT(*) AS n FROM official_race_entries
        WHERE race_date = ? GROUP BY venue ORDER BY n DESC LIMIT 1`,
      [date],
    );
    if (!meeting && !fixture && !(entryVenueRows && entryVenueRows.length)) {
      return c.json({ error: '找不到該日期的賽事' }, 404);
    }

    const venueCode = meeting?.venue ?? fixture?.venue ?? entryVenueRows?.[0]?.venue;
    const { results: races } = meeting
      ? await c.env.DB.prepare('SELECT * FROM races WHERE meeting_id = ? ORDER BY race_number').bind(meeting.id).all()
      : { results: [] as any[] };

    const ptMap = await fetchPostTimeMap(c.env.DB, date, venueCode);
    const raceRows = races ?? [];
    const resultIds = raceRows.map((race: any) => race.id);
    let resultCount = 0;
    if (resultIds.length) {
      const marks = resultIds.map(() => '?').join(',');
      const counted = await optionalAll<{ n: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS n FROM race_results WHERE race_id IN (${marks})`,
        resultIds,
      );
      resultCount = Number(counted?.[0]?.n ?? 0);
    }

    const profilesFor = async (ids: string[]) => profileExtras(c.env.DB, ids);
    let racesOut: any[] = [];
    if (raceRows.length) {
      racesOut = await Promise.all(raceRows.map(async (race: any) => {
        const { results: entries } = await c.env.DB.prepare(`
          SELECT
            rr.*,
            h.name_en, h.name_ch, h.code, h.sire, h.dam, h.dam_sire,
            h.current_rating, h.age, h.sex, h.import_type, h.season_stakes,
            j.name_en AS jockey_en, j.name_ch AS jockey_ch,
            t.name_en AS trainer_en, t.name_ch AS trainer_ch
          FROM race_results rr
          JOIN horses h ON h.id = rr.horse_id
          LEFT JOIN jockeys j ON j.id = rr.jockey_id
          LEFT JOIN trainers t ON t.id = rr.trainer_id
          WHERE rr.race_id = ?
          ORDER BY rr.finishing_position ASC
        `).bind(race.id).all();
        const profiles = await profilesFor((entries ?? []).map((e: any) => e.horse_id));
        return {
          id: race.id,
          raceNumber: race.race_number,
          title: race.title,
          class: race.class,
          distance: race.distance,
          going: race.going,
          track: race.track,
          course: race.course,
          prize: race.prize,
          ratingRange: race.rating_range ?? null,
          startTime: hhmmFromPostTime(ptMap.get(race.race_number)) ?? race.start_time,
          videoUrl: race.video_url,
          isDeclaredCard: true,
          horses: (entries ?? []).map((e: any) => ({
            id: e.horse_id,
            horseNumber: e.horse_number,
            name: e.name_en,
            nameCh: e.name_ch,
            code: e.code,
            draw: e.draw,
            jockey: e.jockey_en,
            jockeyCh: e.jockey_ch,
            trainer: e.trainer_en,
            trainerCh: e.trainer_ch,
            finishingPosition: e.finishing_position,
            finishTime: e.finish_time,
            winOdds: e.win_odds,
            runningPosition: e.running_position,
            lbw: e.lbw,
            rating: e.race_class_rating ?? e.current_rating,
            ...publicWeights('results', e),
            ...cardDeltas(null),
            ...runnerProfile(e, profiles.get(e.horse_id)),
          })),
        };
      }));
    }
    if (racesOut.length === 0) {
      racesOut = await buildRacecardFromEntries(
        c.env.DB, date, venueCode, meeting?.track_condition ?? null,
      );
    }
    if (racesOut.length === 0) {
      racesOut = await buildEntriesOnlyCard(c.env.DB, date, venueCode);
    }

    const declared = await optionalAll<any>(
      c.env.DB,
      `SELECT SUM(CASE WHEN race_number > 0 THEN 1 ELSE 0 END) AS runners,
              SUM(CASE WHEN race_number > 0 AND draw IS NOT NULL THEN 1 ELSE 0 END) AS draws
         FROM entries_upcoming WHERE race_date = ? AND venue = ?`,
      [date, venueCode],
    );
    const officialCount = racesOut.some((race) => race.cardStatus === 'entries')
      ? racesOut.reduce((sum, race) => sum + (race.horses?.length ?? 0), 0)
      : 0;
    const view = resolveCardStatus(signalsFrom(
      { races: raceRows.length, results: resultCount },
      declared?.[0],
      officialCount,
    ));
    // A declared racecard built from entries_upcoming wins over an older entries list.
    if (racesOut.some((race) => race.isDeclaredCard) && view.cardStatus === 'entries') {
      view.cardStatus = 'declared';
      view.isDeclaredCard = true;
      view.drawNote = null;
    }

    const fixtureCount = fixture?.race_count == null ? null : Number(fixture.race_count);
    let totalRaces = racesOut.length || meeting?.total_races || (Number.isFinite(fixtureCount) ? fixtureCount : null);
    if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, date, venueCode);

    return c.json({
      id: meeting?.id ?? (view.cardStatus === 'entries' ? `entries_${date}_${venueCode}` : `fixture_${date}_${venueCode}`),
      date,
      venue: venueCode,
      venueName: venueName(venueCode),
      trackCondition: meeting?.track_condition ?? null,
      weather: meeting?.weather ?? null,
      totalRaces: totalRaces || null,
      timing: fixture?.timing ?? null,
      surface: fixture?.surface ?? null,
      source: meeting ? 'race_meetings' : view.cardStatus === 'entries' ? 'official_race_entries' : 'official_fixtures',
      ...view,
      races: racesOut,
    });
  } catch (err) {
    console.error('[meetings.date]', err);
    return c.json({ error: '找不到該日期的賽事' }, 404);
  }
});

meetingsRoutes.get('/next/upcoming', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  try {
  const meeting = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV') ORDER BY date ASC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  if (!meeting) {
    return c.json({ error: '暫時冇即將舉行的賽事' }, 404);
  }

  let totalRaces = meeting.total_races;
  if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, meeting.date, meeting.venue);

  return c.json({
    id: meeting.id,
    date: meeting.date,
    venue: meeting.venue,
    venueName: venueName(meeting.venue),
    trackCondition: meeting.track_condition,
    weather: meeting.weather,
    totalRaces,
  });
  } catch (err) {
    console.error('[meetings.upcoming]', err);
    return c.json({ error: '暫時冇即將舉行的賽事' }, 404);
  }
});

meetingsRoutes.get('/smart/current', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  try {
  const upcoming = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date >= ? AND venue IN ('ST','HV') ORDER BY date ASC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  const latest = await c.env.DB.prepare(
    "SELECT * FROM race_meetings WHERE date < ? AND venue IN ('ST','HV') ORDER BY date DESC LIMIT 1"
  ).bind(today).first<RaceMeetingRow>();

  const pick = upcoming ?? latest;
  if (!pick) {
    return c.json({ error: '資料庫冇賽事紀錄' }, 404);
  }

  const isFuture = upcoming != null;
  let totalRaces = pick.total_races;
  if (!totalRaces) totalRaces = await declaredRaceCount(c.env.DB, pick.date, pick.venue);
  return c.json({
    id: pick.id,
    date: pick.date,
    venue: pick.venue,
    venueName: venueName(pick.venue),
    trackCondition: pick.track_condition,
    weather: pick.weather,
    totalRaces,
    mode: isFuture ? 'upcoming' : 'historical',
    isEntryListOnly: isFuture,
  });
  } catch (err) {
    console.error('[meetings.smart]', err);
    return c.json({ error: '資料庫冇賽事紀錄' }, 404);
  }
});
