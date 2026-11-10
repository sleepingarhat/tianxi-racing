/**
 * Read APIs for official boards already ingested by capy_wave5_visible,
 * capy_wave6_surfaces, and capy_wave7_surfaces. Public JSON, same visibility
 * as /api/meetings. These routes do not crawl HKJC and do not write D1.
 */
import { Hono } from 'hono';
import type { Env } from '../types';

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
  const list = await rows<Record<string, unknown>>(
    c.env.DB,
    `SELECT section, race_no, horse_no, horse_name, import_type, trainer_name, win_rate, place_rate, as_of_text
       FROM official_jt_combo WHERE ${filters.join(' AND ')}
      ORDER BY section, race_no, horse_no`,
    params,
  );
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
  return c.json({
    source: 'official_fwb_declared',
    available: true,
    date: meeting.date,
    venue: meeting.venue,
    rows: list.map((row) => ({
      raceNo: row.race_no,
      horseNo: row.horse_no,
      reserve: row.is_reserve === 1,
      horseNameEn: row.horse_name_en,
      horseNameCh: row.horse_name_ch,
      brand: row.brand_no,
      bonusEn: row.bonus_en,
      bonusCh: row.bonus_ch,
      notRaceResult: true,
    })),
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
