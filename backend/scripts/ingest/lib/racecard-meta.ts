/**
 * Race-level meta (post time, distance, track, course, going, class) parsed
 * from HKJC's classic RaceCard.aspx page. The whitelisted GraphQL race-card
 * query carries runner data only — HKJC rejects any added race-level fields
 * with WHITELIST_ERROR — so race meta comes from this public page instead.
 *
 * Fail-closed: a page that does not parse yields nulls; callers must keep
 * existing database values (COALESCE) rather than overwrite with null.
 */

export interface RaceMeta {
  postTime: string | null;   // "HH:MM" HK time
  distance: number | null;   // metres
  track: string | null;      // 草地 / 全天候
  course: string | null;     // A / B / C+3 …
  going: string | null;      // 好地 …
  raceClass: string | null;  // 第四班 …
  raceName: string | null;
}

const VENUE_NAME: Record<string, string> = { ST: '沙田', HV: '跑馬地' };

export function racecardPageUrl(date: string, venue: string, raceNo: number): string {
  const slash = date.replaceAll('-', '/');
  return `https://racing.hkjc.com/racing/information/Chinese/racing/RaceCard.aspx?RaceDate=${slash}&Racecourse=${venue}&RaceNo=${raceNo}`;
}

/** Parse the race meta div. Returns nulls for anything not found. */
export function parseRaceMeta(html: string, date: string, venue: string, raceNo: number): RaceMeta {
  const out: RaceMeta = { postTime: null, distance: null, track: null, course: null, going: null, raceClass: null, raceName: null };
  const venueName = VENUE_NAME[venue] ?? '';
  // Identity guard: the page must be the requested date + venue + race.
  const head = new RegExp(`第\\s*${raceNo}\\s*場\\s*-\\s*([^<]+)`).exec(html);
  if (!head) return out;
  out.raceName = head[1].trim() || null;
  const dateLine = new RegExp(`${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日[^<]*${venueName}[^<]*?(\\d{1,2}:\\d{2})`).exec(html);
  if (!dateLine) return { postTime: null, distance: null, track: null, course: null, going: null, raceClass: null, raceName: null };
  out.postTime = dateLine[1] ?? null;
  const trackLine = /(草地|全天候|泥地|沙地)[^<]*?"([^"]+)"\s*賽道[^<]*?(\d{3,4})\s*米[^<]*?([好黏軟爛快地偏重]+)/.exec(html);
  if (trackLine) {
    out.track = trackLine[1] ?? null;
    out.course = trackLine[2] ?? null;
    out.distance = Number(trackLine[3]);
    out.going = trackLine[4] ?? null;
  }
  // Class follows the 獎金/評分 line; a bare search hits navigation text
  // (e.g. 國際賽事) earlier in the page.
  const cls = /評分[^<]*?(第[一二三四五]班|新馬賽)/.exec(html);
  if (cls) out.raceClass = (cls[1] ?? '').trim() || null;
  return out;
}

/** Fetch one race's meta; network/HTTP failure returns all-null meta. */
export async function fetchRaceMeta(date: string, venue: string, raceNo: number): Promise<RaceMeta> {
  try {
    const res = await fetch(racecardPageUrl(date, venue, raceNo), {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; tianxi-racing/1.0)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { postTime: null, distance: null, track: null, course: null, going: null, raceClass: null, raceName: null };
    return parseRaceMeta(await res.text(), date, venue, raceNo);
  } catch {
    return { postTime: null, distance: null, track: null, course: null, going: null, raceClass: null, raceName: null };
  }
}
