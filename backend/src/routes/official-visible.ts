/**
 * Read APIs for official boards already ingested by capy_wave5_visible,
 * capy_wave6_surfaces, and capy_wave7_surfaces. Public JSON, same visibility
 * as /api/meetings. These routes do not crawl HKJC and do not write D1.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { alignFwb, type FwbIdentity } from '../lib/fwb-align';

export const officialVisibleRoutes = new Hono<{ Bindings: Env }>();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VENUE = /^(ST|HV)$/;
const SEASON = /^\d{4}-\d{4}$/;
const BRAND = /^[A-Z]\d{3}$/;
const HEADERS = { 'Cache-Control': 'public, max-age=120' };

function missingTable(err: unknown): boolean {
  return /no such table/i.test(String((err as { message?: string })?.message ?? err));
}

async function rows<T>(db: Env['DB'], sql: string, params: unknown[]): Promise<T[] | null> {
  try {
    const { results } = await db.prepare(sql).bind(...params).all<T>();
    return results ?? [];
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

function unavailable(c: { json: (body: unknown, status?: number, headers?: Record<string, string>) => Response }, source: string) {
  return c.json({ source, available: false, rows: [] }, 200, HEADERS);
}

function requireMeeting(c: { req: { query: (name: string) => string | undefined }; json: Function }): { date: string; venue: string } | Response {
  const date = c.req.query('date') ?? '';
  const venue = c.req.query('venue') ?? '';
  if (!DATE.test(date) || !VENUE.test(venue)) {
    return c.json({ error: 'date=YYYY-MM-DD and venue=ST|HV are required' }, 400) as Response;
  }
  return { date, venue };
}

officialVisibleRoutes.get('/ove-database', async (c) => {
  const asOf = c.req.query('asOf') ?? '';
  if (asOf && !DATE.test(asOf)) return c.json({ error: 'asOf must be YYYY-MM-DD' }, 400);
  try {
    const chosen = asOf || (await c.env.DB.prepare(
      'SELECT MAX(as_of_date) AS as_of_date FROM official_ove_database',
    ).first<{ as_of_date: string | null }>())?.as_of_date || '';
    if (!chosen) return c.json({ source: 'official_ove_database', available: true, asOf: null, rows: [] }, 200, HEADERS);
    const list = await rows<Record<string, unknown>>(
      c.env.DB,
      `SELECT line_no, horse_code, horse_name, injury_date, detail, passed_date, not_race_result
         FROM official_ove_database WHERE as_of_date = ? ORDER BY line_no`,
      [chosen],
    );
    if (!list) return unavailable(c, 'official_ove_database');
    return c.json({
      source: 'official_ove_database',
      available: true,
      asOf: chosen,
      rows: list.map((row) => ({
        lineNo: row.line_no,
        horseCode: row.horse_code,
        horseName: row.horse_name,
        injuryDate: row.injury_date,
        detail: row.detail,
        passedDate: row.passed_date,
        notRaceResult: true,
      })),
    }, 200, HEADERS);
  } catch (err) {
    if (missingTable(err)) return unavailable(c, 'official_ove_database');
    throw err;
  }
});

officialVisibleRoutes.get('/ove-record', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, line_no, horse_no, is_reserve, horse_code, horse_name, injury_date, detail, passed_date
       FROM official_ove_record WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, line_no`,
    [meeting.date, meeting.venue],
  );
  if (!list) return unavailable(c, 'official_ove_record');
  return c.json({
    source: 'official_ove_record',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rows: list.map((row) => ({
      raceNo: row.race_no,
      lineNo: row.line_no,
      horseNo: row.horse_no,
      reserve: row.is_reserve === 1,
      horseCode: row.horse_code,
      horseName: row.horse_name,
      injuryDate: row.injury_date,
      detail: row.detail,
      passedDate: row.passed_date,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/ppo-performance', async (c) => {
  const season = c.req.query('season') ?? '';
  const brand = c.req.query('brand') ?? '';
  if (season && !SEASON.test(season)) return c.json({ error: 'season must be YYYY-YYYY' }, 400);
  if (brand && !BRAND.test(brand)) return c.json({ error: 'brand must be a local brand such as L518' }, 400);
  const filters = ['1 = 1'];
  const params: unknown[] = [];
  if (season) { filters.push('season_code = ?'); params.push(season); }
  if (brand) { filters.push('brand_no = ?'); params.push(brand); }
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT season_code, brand_no, horse_name_ch, former_name, notes, show_play, season_enabled
       FROM official_ppo_performance WHERE ${filters.join(' AND ')}
      ORDER BY season_code, brand_no LIMIT 5000`,
    params,
  );
  if (!list) return unavailable(c, 'official_ppo_performance');
  return c.json({
    source: 'official_ppo_performance',
    available: true,
    season: season || null,
    brand: brand || null,
    rows: list.map((row) => ({
      season: row.season_code,
      brand: row.brand_no,
      horseNameCh: row.horse_name_ch,
      formerName: row.former_name,
      notes: row.notes,
      showPlay: row.show_play === 1,
      seasonEnabled: row.season_enabled === 1,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/conghua-movement', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, line_no, horse_no, is_reserve, horse_name_ch, horse_name_en, arrived_date, returned_date
       FROM official_conghua_movement WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, line_no`,
    [meeting.date, meeting.venue],
  );
  if (!list) return unavailable(c, 'official_conghua_movement');
  return c.json({
    source: 'official_conghua_movement',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rows: list.map((row) => ({
      raceNo: row.race_no,
      lineNo: row.line_no,
      horseNo: row.horse_no,
      reserve: row.is_reserve === 1,
      horseNameCh: row.horse_name_ch,
      horseNameEn: row.horse_name_en,
      arrivedDate: row.arrived_date,
      returnedDate: row.returned_date,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/jt-combo', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const section = c.req.query('section') ?? '';
  if (section && section !== 'combo' && section !== 'debut') {
    return c.json({ error: 'section must be combo or debut' }, 400);
  }
  const filters = ['meeting_date = ?', 'venue = ?'];
  const params: unknown[] = [meeting.date, meeting.venue];
  if (section) { filters.push('section = ?'); params.push(section); }
  // Reserve debutants share a bare number with a starter; only callers that
  // render the 後備 flag ask for them, older readers keep seeing starters only.
  const includeReserve = c.req.query('includeReserve') === '1';
  const select = (hasReserveColumn: boolean) =>
    `SELECT section, race_no, horse_no, ${hasReserveColumn ? 'is_reserve' : '0 AS is_reserve'}, horse_name, import_type,
            trainer_name, win_rate, place_rate, as_of_text
       FROM official_jt_combo
      WHERE ${[...filters, ...(hasReserveColumn && !includeReserve ? ['is_reserve = 0'] : [])].join(' AND ')}
      ORDER BY section, race_no, ${hasReserveColumn ? 'is_reserve, ' : ''}horse_no`;
  let list: Record<string, unknown>[] | null;
  try {
    list = await rows<Record<string, unknown>>(c.env.DB, select(true), params);
  } catch (err) {
    // Before the collector adds is_reserve, the table can only hold starters.
    if (!/no such column: is_reserve/i.test(String((err as { message?: string })?.message ?? err))) throw err;
    list = await rows<Record<string, unknown>>(c.env.DB, select(false), params);
  }
  if (!list) return unavailable(c, 'official_jt_combo');
  return c.json({
    source: 'official_jt_combo',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    section: section || null,
    rows: list.map((row) => ({
      section: row.section,
      raceNo: row.race_no,
      horseNo: row.horse_no,
      reserve: row.is_reserve === 1,
      horseName: row.horse_name,
      importType: row.import_type,
      trainerName: row.trainer_name,
      winRate: row.win_rate,
      placeRate: row.place_rate,
      asOfText: row.as_of_text,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/challenge-odds', async (c) => {
  const pool = c.req.query('pool') ?? '';
  const date = c.req.query('date') ?? '';
  const venue = c.req.query('venue') ?? '';
  if (pool && pool !== 'jkc' && pool !== 'tnc') return c.json({ error: 'pool must be jkc or tnc' }, 400);
  if (date && !DATE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  if (venue && !VENUE.test(venue)) return c.json({ error: 'venue must be ST or HV' }, 400);
  const filters = ['1 = 1'];
  const params: unknown[] = [];
  if (pool) { filters.push('pool = ?'); params.push(pool); }
  if (date) { filters.push('meeting_date = ?'); params.push(date); }
  if (venue) { filters.push('venue = ?'); params.push(venue); }
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT pool, meeting_date, venue, winner_code, winner_name, points, race_no, odds_text, chart_updated_at
       FROM official_challenge_odds WHERE ${filters.join(' AND ')}
      ORDER BY pool, meeting_date, venue, winner_code, race_no LIMIT 5000`,
    params,
  );
  if (!list) return unavailable(c, 'official_challenge_odds');
  return c.json({
    source: 'official_challenge_odds',
    available: true,
    pool: pool || null,
    date: date || null,
    venue: venue || null,
    rows: list.map((row) => ({
      pool: row.pool,
      date: row.meeting_date,
      venue: row.venue,
      winnerCode: row.winner_code,
      winnerName: row.winner_name,
      points: row.points,
      raceNo: row.race_no,
      oddsText: row.odds_text,
      chartUpdatedAt: row.chart_updated_at,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/horse-former-name', async (c) => {
  const brand = c.req.query('brand') ?? '';
  if (brand && !BRAND.test(brand)) return c.json({ error: 'brand must be a local brand such as K444' }, 400);
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT horse_id, horse_code, name_en, name_ch, former_name, sire, dam, import_type, import_type_ch,
            origin_code, origin_ch, age, foaling_date
       FROM official_horse_former_name ${brand ? 'WHERE horse_code = ?' : ''}
      ORDER BY horse_id LIMIT 5000`,
    brand ? [brand] : [],
  );
  if (!list) return unavailable(c, 'official_horse_former_name');
  return c.json({
    source: 'official_horse_former_name',
    available: true,
    brand: brand || null,
    rows: list.map((row) => ({
      horseId: row.horse_id,
      brand: row.horse_code,
      nameEn: row.name_en,
      nameCh: row.name_ch,
      formerName: row.former_name,
      sire: row.sire,
      dam: row.dam,
      importType: row.import_type,
      importTypeCh: row.import_type_ch,
      originCode: row.origin_code,
      originCh: row.origin_ch,
      age: row.age,
      foalingDate: row.foaling_date,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/fwb-declared', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, horse_no, is_reserve, horse_name_en, horse_name_ch, brand_no, bonus_en, bonus_ch
       FROM official_fwb_declared WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, is_reserve, horse_no`,
    [meeting.date, meeting.venue],
  );
  if (!list) return unavailable(c, 'official_fwb_declared');
  // Racecard identity is optional. A missing card leaves the list number in place
  // and does not invent a saddle. Alignment never keys off horse_no.
  const card = await rows<FwbIdentity>(
    c.env.DB,
    `SELECT race_no, horse_no, is_reserve, horse_id, brand_no
       FROM official_racecard_runner WHERE meeting_date = ? AND venue = ?`,
    [meeting.date, meeting.venue],
  );
  const runners = card ?? [];
  return c.json({
    source: 'official_fwb_declared',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rows: list.map((row) => {
      const aligned = alignFwb(row, runners);
      return {
        raceNo: row.race_no,
        horseNo: row.horse_no,
        reserve: row.is_reserve === 1,
        horseNameEn: row.horse_name_en,
        horseNameCh: row.horse_name_ch,
        brand: row.brand_no,
        bonusEn: row.bonus_en,
        bonusCh: row.bonus_ch,
        cardHorseNo: aligned.cardHorseNo,
        cardReserve: aligned.cardReserve,
        cardHorseId: aligned.cardHorseId,
        cardBrand: aligned.cardBrand,
        alignedBy: aligned.alignedBy,
        notRaceResult: true,
      };
    }),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/finish-photos', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const raceNo = c.req.query('raceNo') ?? '';
  if (raceNo && !/^\d{1,2}$/.test(raceNo)) return c.json({ error: 'raceNo must be a race number' }, 400);
  const filters = ['meeting_date = ?', 'venue = ?'];
  const params: unknown[] = [meeting.date, meeting.venue];
  if (raceNo) { filters.push('race_no = ?'); params.push(Number(raceNo)); }
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, photo_code, season_code, image_path
       FROM official_finish_photo WHERE ${filters.join(' AND ')}
      ORDER BY race_no, photo_code`,
    params,
  );
  if (!list) return unavailable(c, 'official_finish_photo');
  return c.json({
    source: 'official_finish_photo',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    raceNo: raceNo ? Number(raceNo) : null,
    rows: list.map((row) => ({
      raceNo: row.race_no,
      photoCode: row.photo_code,
      seasonCode: row.season_code,
      imagePath: row.image_path,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/special-index', async (c) => {
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    'SELECT code, line_no, note_ch FROM official_special_index ORDER BY line_no',
    [],
  );
  if (!list) return unavailable(c, 'official_special_index');
  return c.json({
    source: 'official_special_index',
    available: true,
    rows: list.map((row) => ({
      code: row.code,
      lineNo: row.line_no,
      noteCh: row.note_ch,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/stats-centre', async (c) => {
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT slot, poster_date, window_end, last_update, image_path
       FROM official_stats_centre_image ORDER BY slot`,
    [],
  );
  if (!list) return unavailable(c, 'official_stats_centre_image');
  return c.json({
    source: 'official_stats_centre_image',
    available: true,
    rows: list.map((row) => ({
      slot: row.slot,
      posterDate: row.poster_date,
      windowEnd: row.window_end,
      lastUpdate: row.last_update,
      imagePath: row.image_path,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/horse-ratings', async (c) => {
  const board = c.req.query('board') ?? '';
  if (!/^(clas|csum|tp50)$/.test(board)) return c.json({ error: 'board=clas|csum|tp50 is required' }, 400);
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT line_no, horse_code, name_en, name_ch, rating, change_text, mark_text, trainer_name
       FROM official_horse_rating WHERE board = ? ORDER BY line_no`,
    [board],
  );
  if (!list) return unavailable(c, 'official_horse_rating');
  return c.json({
    source: 'official_horse_rating',
    available: true,
    board,
    rows: list.map((row) => ({
      lineNo: row.line_no,
      brand: row.horse_code,
      nameEn: row.name_en,
      nameCh: row.name_ch,
      rating: row.rating,
      changeText: row.change_text,
      markText: row.mark_text,
      trainerName: row.trainer_name,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/horse-news', async (c) => {
  const view = c.req.query('view') ?? '';
  if (view && !/^(Horses|List)\/[A-Za-z0-9_]+$/.test(view)) {
    return c.json({ error: 'view must be Horses/… or List/…' }, 400);
  }
  const filters = view ? 'WHERE view_code = ?' : '';
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT view_code, line_no, title_ch, published_at, artifact_path, file_date, file_tag, venue, simulcast_code
       FROM official_horse_news ${filters} ORDER BY view_code, line_no`,
    view ? [view] : [],
  );
  if (!list) return unavailable(c, 'official_horse_news');
  return c.json({
    source: 'official_horse_news',
    available: true,
    view: view || null,
    rows: list.map((row) => ({
      view: row.view_code,
      lineNo: row.line_no,
      title: row.title_ch,
      publishedAt: row.published_at,
      artifactPath: row.artifact_path,
      fileDate: row.file_date,
      fileTag: row.file_tag,
      venue: row.venue,
      simulcastCode: row.simulcast_code,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/import-policy', async (c) => {
  const page = c.req.query('page') ?? '';
  if (page && !/^(pps|ppgs)$/.test(page)) return c.json({ error: 'page=pps|ppgs' }, 400);
  const filters = page ? 'WHERE page_code = ?' : '';
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT page_code, kind, block_no, row_no, col_no, text_ch, asset_path
       FROM official_import_policy ${filters}
      ORDER BY page_code, kind, block_no, row_no, col_no`,
    page ? [page] : [],
  );
  if (!list) return unavailable(c, 'official_import_policy');
  return c.json({
    source: 'official_import_policy',
    available: true,
    page: page || null,
    rows: list.map((row) => ({
      page: row.page_code,
      kind: row.kind,
      blockNo: row.block_no,
      rowNo: row.row_no,
      colNo: row.col_no,
      text: row.text_ch,
      assetPath: row.asset_path,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/racecard-profile', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, horse_no, is_reserve, horse_id, brand_no, horse_name, age, sex,
            season_stakes, owner, sire, dam, import_type
       FROM official_racecard_runner WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, is_reserve, horse_no`,
    [meeting.date, meeting.venue],
  );
  if (!list) return unavailable(c, 'official_racecard_runner');
  return c.json({
    source: 'official_racecard_runner',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rows: list.map((row) => ({
      raceNo: row.race_no,
      horseNo: row.horse_no,
      reserve: row.is_reserve === 1,
      horseId: row.horse_id,
      brand: row.brand_no,
      horseName: row.horse_name,
      age: row.age,
      sex: row.sex,
      seasonStakes: row.season_stakes,
      owner: row.owner,
      sire: row.sire,
      dam: row.dam,
      importType: row.import_type,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

const RESULT_VENUE = /^(ST|HV|S\d{1,2})$/;
const SIRE = /^[A-Za-z][A-Za-z0-9 .'()\-]{0,40}$/;
const LIST_KIND = /^(location|stable|age|char)$/;
const PERSON_ROLE = /^(jockey|trainer)$/;
const PERSON_ID = /^[A-Z][A-Z0-9]{1,5}$/;

officialVisibleRoutes.get('/fixture-lines', async (c) => {
  const date = c.req.query('date') ?? '';
  if (!DATE.test(date)) return c.json({ error: 'date=YYYY-MM-DD is required' }, 400);
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT venue, line_no, class_code, distance, race_count, course_text, rating_band
       FROM official_fixture_line WHERE meeting_date = ?
      ORDER BY venue, line_no`,
    [date],
  );
  if (!list) return unavailable(c, 'official_fixture_line');
  return c.json({
    source: 'official_fixture_line',
    available: true,
    date,
    rows: list.map((row) => ({
      venue: row.venue,
      lineNo: row.line_no,
      classCode: row.class_code,
      distance: row.distance,
      raceCount: row.race_count,
      courseText: row.course_text,
      ratingBand: row.rating_band,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/results-all', async (c) => {
  const date = c.req.query('date') ?? '';
  const venue = c.req.query('venue') ?? '';
  if (!DATE.test(date) || !RESULT_VENUE.test(venue)) {
    return c.json({ error: 'date=YYYY-MM-DD and venue=ST|HV|S1 are required' }, 400);
  }
  const runners = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT section, place_label, race_no, line_no, placing_text, horse_no, horse_name,
            jockey_name, trainer_name, actual_weight, draw
       FROM official_results_all_runner WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, line_no`,
    [date, venue],
  );
  const dividends = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, line_no, pool_name, combination, dividend_text
       FROM official_results_all_dividend WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, line_no`,
    [date, venue],
  );
  if (!runners || !dividends) return unavailable(c, 'official_results_all_runner');
  return c.json({
    source: 'official_results_all',
    available: true,
    date,
    venue,
    runners: runners.map((row) => ({
      section: row.section,
      placeLabel: row.place_label,
      raceNo: row.race_no,
      lineNo: row.line_no,
      placing: row.placing_text,
      horseNo: row.horse_no,
      horseName: row.horse_name,
      jockey: row.jockey_name,
      trainer: row.trainer_name,
      actualWeight: row.actual_weight,
      draw: row.draw,
      notRaceResult: true,
    })),
    dividends: dividends.map((row) => ({
      raceNo: row.race_no,
      lineNo: row.line_no,
      pool: row.pool_name,
      combination: row.combination,
      dividend: row.dividend_text,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/same-sire', async (c) => {
  const sire = c.req.query('sire') ?? '';
  if (!SIRE.test(sire)) return c.json({ error: 'sire is required' }, 400);
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT line_no, horse_name, retired, wins, seconds, thirds, starts, winning_distance
       FROM official_same_sire WHERE sire_name = ?
      ORDER BY line_no`,
    [sire],
  );
  if (!list) return unavailable(c, 'official_same_sire');
  return c.json({
    source: 'official_same_sire',
    available: true,
    sire,
    rows: list.map((row) => ({
      lineNo: row.line_no,
      horseName: row.horse_name,
      retired: row.retired === 1,
      wins: row.wins,
      seconds: row.seconds,
      thirds: row.thirds,
      starts: row.starts,
      winningDistance: row.winning_distance,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/horse-directory', async (c) => {
  const listKind = c.req.query('list') ?? '';
  const key = c.req.query('key') ?? '';
  if (!LIST_KIND.test(listKind) || !key || key.length > 40) {
    return c.json({ error: 'list=location|stable|age|char and key are required' }, 400);
  }
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT line_no, horse_id, horse_name, rating, list_label
       FROM official_horse_directory WHERE list_kind = ? AND list_key = ?
      ORDER BY line_no`,
    [listKind, key],
  );
  if (!list) return unavailable(c, 'official_horse_directory');
  return c.json({
    source: 'official_horse_directory',
    available: true,
    list: listKind,
    key,
    rows: list.map((row) => ({
      lineNo: row.line_no,
      horseId: row.horse_id,
      horseName: row.horse_name,
      rating: row.rating,
      label: row.list_label,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/person', async (c) => {
  const role = c.req.query('role') ?? '';
  const id = c.req.query('id') ?? '';
  if (!PERSON_ROLE.test(role) || !PERSON_ID.test(id)) {
    return c.json({ error: 'role=jockey|trainer and id are required' }, 400);
  }
  const season = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT person_name, season_label, as_of_date, nationality, wins, seconds, thirds, fourths,
            starts, stakes_hkd, win_rate, last10_wins
       FROM official_person_season WHERE role = ? AND person_id = ?`,
    [role, id],
  );
  const grid = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT line_no, venue_label, venue_code, surface_label, surface_code, distance,
            wins, seconds, thirds, starts
       FROM official_person_winstat WHERE role = ? AND person_id = ?
      ORDER BY line_no`,
    [role, id],
  );
  if (!season || !grid) return unavailable(c, 'official_person_season');
  return c.json({
    source: 'official_person_season',
    available: true,
    role,
    id,
    season: season[0] ? {
      name: season[0].person_name,
      season: season[0].season_label,
      asOf: season[0].as_of_date,
      nationality: season[0].nationality,
      wins: season[0].wins,
      seconds: season[0].seconds,
      thirds: season[0].thirds,
      fourths: season[0].fourths,
      starts: season[0].starts,
      stakesHkd: season[0].stakes_hkd,
      winRate: season[0].win_rate,
      last10Wins: season[0].last10_wins,
      notRaceResult: true,
    } : null,
    winStat: grid.map((row) => ({
      lineNo: row.line_no,
      venue: row.venue_label,
      venueCode: row.venue_code,
      surface: row.surface_label,
      surfaceCode: row.surface_code,
      distance: row.distance,
      wins: row.wins,
      seconds: row.seconds,
      thirds: row.thirds,
      starts: row.starts,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/wind', async (c) => {
  const stations = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT racecourse, location, observed_date, observed_time, wind_direction, wind_speed,
            gust_direction, gust_speed, humidity, temperature, rain_1min, rain_10min, rain_daily,
            soil_water, soil_loss_1min, soil_loss_daily, soil_loss_24h, is_valid
       FROM official_wind_station a
      WHERE observed_date || ' ' || observed_time = (
        SELECT MAX(observed_date || ' ' || observed_time) FROM official_wind_station b
         WHERE b.racecourse = a.racecourse
      )
      ORDER BY racecourse`,
    [],
  );
  if (!stations) return unavailable(c, 'official_wind_station');
  const sections = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT racecourse, location, observed_date, observed_time, wind_direction, wind_speed,
            gust_direction, gust_speed, is_valid
       FROM official_wind_section a
      WHERE observed_date || ' ' || observed_time = (
        SELECT MAX(observed_date || ' ' || observed_time) FROM official_wind_section b
         WHERE b.racecourse = a.racecourse AND b.location = a.location
      )
      ORDER BY racecourse, location`,
    [],
  );
  const going = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT meeting_date, venue, race_no, going_ch, track_code
       FROM official_wind_going
      WHERE meeting_date = (SELECT MAX(meeting_date) FROM official_wind_going)
      ORDER BY venue, race_no`,
    [],
  );
  const probes = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT meeting_date, venue, instrument, sequence_no, reading_time, reading
       FROM official_wind_probe
      WHERE meeting_date = (SELECT MAX(meeting_date) FROM official_wind_probe)
      ORDER BY venue, instrument, sequence_no`,
    [],
  );
  return c.json({
    source: 'official_wind_station',
    available: true,
    stations: stations.map((row) => ({
      racecourse: row.racecourse,
      location: row.location,
      observedDate: row.observed_date,
      observedTime: row.observed_time,
      windDirection: row.wind_direction,
      windSpeed: row.wind_speed,
      gustDirection: row.gust_direction,
      gustSpeed: row.gust_speed,
      humidity: row.humidity,
      temperature: row.temperature,
      rain1Min: row.rain_1min,
      rain10Min: row.rain_10min,
      rainDaily: row.rain_daily,
      soilWater: row.soil_water,
      soilLoss1Min: row.soil_loss_1min,
      soilLossDaily: row.soil_loss_daily,
      soilLoss24h: row.soil_loss_24h,
      valid: row.is_valid === 1,
      notRaceResult: true,
    })),
    sections: (sections ?? []).map((row) => ({
      racecourse: row.racecourse,
      location: row.location,
      observedDate: row.observed_date,
      observedTime: row.observed_time,
      windDirection: row.wind_direction,
      windSpeed: row.wind_speed,
      gustDirection: row.gust_direction,
      gustSpeed: row.gust_speed,
      valid: row.is_valid === 1,
      notRaceResult: true,
    })),
    going: (going ?? []).map((row) => ({
      date: row.meeting_date,
      venue: row.venue,
      raceNo: row.race_no,
      going: row.going_ch,
      trackCode: row.track_code,
      notRaceResult: true,
    })),
    probes: (probes ?? []).map((row) => ({
      date: row.meeting_date,
      venue: row.venue,
      instrument: row.instrument,
      sequenceNo: row.sequence_no,
      readingTime: row.reading_time,
      reading: row.reading,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

officialVisibleRoutes.get('/racecard-files', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT race_no, kind, artifact_path, distance, surface_code
       FROM official_racecard_file WHERE meeting_date = ? AND venue = ?
      ORDER BY race_no, kind`,
    [meeting.date, meeting.venue],
  );
  if (!list) return unavailable(c, 'official_racecard_file');
  return c.json({
    source: 'official_racecard_file',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rows: list.map((row) => ({
      raceNo: row.race_no,
      kind: row.kind,
      artifactPath: row.artifact_path,
      distance: row.distance,
      surfaceCode: row.surface_code,
      notRaceResult: true,
    })),
  }, 200, HEADERS);
});

const SNAPSHOT_KIND = /^(freeze|post_race|card_status|pre_freeze_safety)$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const ROW_CAP = 200;

function gapList(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

officialVisibleRoutes.get('/snapshots', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const kind = c.req.query('kind') ?? '';
  if (kind && !SNAPSHOT_KIND.test(kind)) {
    return c.json({ error: 'kind must be freeze|post_race|card_status|pre_freeze_safety' }, 400);
  }
  const includeRows = c.req.query('includeRows') === '1';
  const manifest = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT snapshot_id, snapshot_kind, card_status, captured_at, completeness, content_sha256,
            lock_at, first_post_at, last_post_at, gaps_json
       FROM official_snapshot_manifest
      WHERE meeting_date = ? AND venue = ? AND (? = '' OR snapshot_kind = ?)
      ORDER BY captured_at`,
    [meeting.date, meeting.venue, kind, kind],
  );
  if (!manifest) return c.json({ source: 'official_snapshot_manifest', available: false, snapshots: [] }, 200, NO_STORE);
  const snapshots = [];
  let remaining = ROW_CAP;
  let rowsTruncated = false;
  for (const header of manifest) {
    const surfaces = await rows<Record<string, unknown>>(
      c.env.DB,
      `SELECT surface, row_count, captured_at, source_sha256, status, gap_reason
         FROM official_snapshot_surface WHERE snapshot_id = ? ORDER BY surface`,
      [header.snapshot_id],
    );
    const item: Record<string, unknown> = {
      snapshotId: header.snapshot_id,
      kind: header.snapshot_kind,
      cardStatus: header.card_status,
      capturedAt: header.captured_at,
      completeness: header.completeness,
      contentSha256: header.content_sha256,
      lockAt: header.lock_at,
      firstPostAt: header.first_post_at,
      lastPostAt: header.last_post_at,
      gapCount: gapList(header.gaps_json).length,
      gaps: gapList(header.gaps_json),
      surfaces: (surfaces ?? []).map((surface) => ({
        surface: surface.surface,
        rowCount: surface.row_count,
        capturedAt: surface.captured_at,
        sourceSha256: surface.source_sha256,
        status: surface.status,
        gapReason: surface.gap_reason,
      })),
    };
    if (includeRows && remaining > 0) {
      const payload = await rows<Record<string, unknown>>(
        c.env.DB,
        `SELECT surface, row_no, payload_json FROM official_snapshot_row
          WHERE snapshot_id = ? ORDER BY surface, row_no LIMIT ?`,
        [header.snapshot_id, remaining],
      );
      const listed = payload ?? [];
      item.rows = listed.map((row) => ({
        surface: row.surface,
        rowNo: row.row_no,
        payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
      }));
      remaining -= listed.length;
      if (listed.length === ROW_CAP || remaining === 0) rowsTruncated = true;
    }
    snapshots.push(item);
  }
  return c.json({
    source: 'official_snapshot_manifest',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rowsTruncated,
    snapshots,
  }, 200, NO_STORE);
});

officialVisibleRoutes.get('/snapshot-health', async (c) => {
  const meeting = requireMeeting(c);
  if (meeting instanceof Response) return meeting;
  const manifest = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT snapshot_kind, completeness, captured_at, lock_at, first_post_at, gaps_json
       FROM official_snapshot_manifest
      WHERE meeting_date = ? AND venue = ? AND snapshot_kind IN ('freeze', 'post_race')`,
    [meeting.date, meeting.venue],
  );
  if (!manifest) {
    return c.json({
      source: 'official_snapshot_manifest',
      available: false,
      date: meeting.date,
      venue: meeting.venue,
      freeze: { exists: false },
      postRace: { exists: false },
    }, 200, NO_STORE);
  }
  const pick = (kind: string) => manifest.find((row) => row.snapshot_kind === kind);
  const shape = (row: Record<string, unknown> | undefined) => row ? {
    exists: true,
    completeness: row.completeness,
    gapCount: gapList(row.gaps_json).length,
    capturedAt: row.captured_at,
    lockAt: row.lock_at ?? null,
    firstPostAt: row.first_post_at ?? null,
  } : {
    exists: false,
    completeness: null,
    gapCount: 0,
    capturedAt: null,
    lockAt: null,
    firstPostAt: null,
  };
  return c.json({
    source: 'official_snapshot_manifest',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    freeze: shape(pick('freeze')),
    postRace: shape(pick('post_race')),
  }, 200, NO_STORE);
});
