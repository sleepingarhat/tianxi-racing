/**
 * Race-level meta parsed from HKJC's classic RaceCard.aspx page.
 * The whitelisted GraphQL race-card query carries runner data only — HKJC
 * rejects added race-level fields with WHITELIST_ERROR — so race meta comes
 * from this public page instead.
 *
 * Accepts both turf (`草地, "A" 賽道, 1200米, 好地`) and all-weather
 * (`全天候跑道, 1650米, 好地`). Identity is fail-closed: date, course, and
 * race number must all match or the whole block is discarded.
 *
 * An unparseable page yields nulls; callers keep existing database values
 * (COALESCE) rather than overwrite with null. If the accepted header still
 * shows 米 plus 全天候/草地 and distance or track is empty, that is a parse
 * miss (`trackLineUnparsed`) and the racecard job must exit non-zero.
 */

export interface RaceMeta {
  postTime: string | null;   // "HH:MM" HK time
  distance: number | null;   // metres
  track: string | null;      // 草地 / 全天候
  course: string | null;     // A / B / C+3 … null when the card has no quoted 賽道
  going: string | null;      // 好地 …
  raceClass: string | null;  // 第四班 …
  raceName: string | null;
  prize: string | null;      // HKD digits, same shape as races.prize ("875000")
  ratingRange: string | null; // page text, e.g. "40-0" / "60-40"
}

/** Exit code for "header visibly present, distance/track still empty". */
export const RACECARD_HEADER_MISS_EXIT = 2;

const VENUE_NAME: Record<string, string> = { ST: '沙田', HV: '跑馬地' };
const GOING = '[好黏軟爛快地偏重至濕大]+';

export function emptyRaceMeta(): RaceMeta {
  return {
    postTime: null,
    distance: null,
    track: null,
    course: null,
    going: null,
    raceClass: null,
    raceName: null,
    prize: null,
    ratingRange: null,
  };
}

export function racecardPageUrl(date: string, venue: string, raceNo: number): string {
  const slash = date.replaceAll('-', '/');
  return `https://racing.hkjc.com/racing/information/Chinese/racing/RaceCard.aspx?RaceDate=${slash}&Racecourse=${venue}&RaceNo=${raceNo}`;
}

/** The classic header div, or the whole document when a fixture has no div. */
export function raceHeaderHtml(html: string): string {
  const block = /class="f_fs13"[\s\S]{0,2000}?<\/div>/.exec(html);
  const raw = block?.[0] ?? html;
  return raw.replace(/&quot;/g, '"').replace(/&#34;/g, '"');
}

/** Columns copied onto every entries_upcoming runner for this race. */
export function raceLevelAssignment(meta: RaceMeta): {
  race_class: string | null;
  distance: number | null;
  track: string | null;
  course: string | null;
  race_name: string | null;
  prize: string | null;
  rating_range: string | null;
  going: string | null;
} {
  return {
    race_class: meta.raceClass,
    distance: meta.distance,
    track: meta.track,
    course: meta.course,
    race_name: meta.raceName,
    prize: meta.prize,
    rating_range: meta.ratingRange,
    going: meta.going,
  };
}

/**
 * Meeting-level track_condition. Uniform cards (every accepted race shares one
 * going) still record that going. Mixed cards do not copy the first race onto
 * the meeting — per-race `going` is the value readers must use.
 * Races that failed the identity gate are ignored. An accepted race with no
 * going blocks the meeting write so a partial parse cannot stamp the rest.
 */
export function meetingTrackCondition(metas: Iterable<RaceMeta>): string | null {
  const accepted = [...metas].filter((m) => m.postTime);
  if (!accepted.length) return null;
  if (accepted.some((m) => !m.going)) return null;
  const uniq = new Set(accepted.map((m) => m.going));
  return uniq.size === 1 ? accepted[0].going : null;
}

/**
 * True when this page passed the identity gate and its header clearly contains
 * a surface word plus 米, but distance or track did not parse. Discarded
 * (wrong date / venue / race) blocks are not misses.
 */
export function trackLineUnparsed(html: string, meta: RaceMeta): boolean {
  if (!meta.postTime) return false;
  const header = raceHeaderHtml(html);
  const showsSurface = /全天候|草地/.test(header);
  const showsMetres = /米/.test(header);
  if (!showsSurface || !showsMetres) return false;
  return meta.distance == null || meta.track == null;
}

/** Parse the race meta div. Returns nulls for anything not found. */
export function parseRaceMeta(html: string, date: string, venue: string, raceNo: number): RaceMeta {
  const header = raceHeaderHtml(html);
  const venueName = VENUE_NAME[venue] ?? '';
  const head = new RegExp(`第\\s*${raceNo}\\s*場\\s*-\\s*([^<]+)`).exec(header);
  if (!head) return emptyRaceMeta();
  const dateLine = new RegExp(
    `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日[^<]*${venueName}[^<]*?(\\d{1,2}:\\d{2})`,
  ).exec(header);
  if (!dateLine) return emptyRaceMeta();

  const out = emptyRaceMeta();
  out.raceName = head[1].trim() || null;
  out.postTime = dateLine[1] ?? null;

  const turf = new RegExp(
    `(草地|泥地|沙地)[^<]*?"([^"]+)"\\s*賽道[^<]*?(\\d{3,4})\\s*米[^<]*?(${GOING})`,
  ).exec(header);
  if (turf) {
    out.track = turf[1] ?? null;
    out.course = turf[2] ?? null;
    out.distance = Number(turf[3]);
    out.going = turf[4] ?? null;
  } else {
    const awt = new RegExp(`(全天候)跑道?[^<]*?(\\d{3,4})\\s*米[^<]*?(${GOING})`).exec(header);
    if (awt) {
      out.track = awt[1] ?? null;
      out.course = null;
      out.distance = Number(awt[2]);
      out.going = awt[3] ?? null;
    }
  }

  const cls = /評分[^<]*?(第[一二三四五]班|新馬賽)/.exec(header);
  if (cls) out.raceClass = (cls[1] ?? '').trim() || null;
  const prize = /獎金:\s*\$([0-9][0-9,]*)/.exec(header);
  if (prize) out.prize = prize[1].replace(/,/g, '');
  const rating = /評分:\s*(\d+)\s*-\s*(\d+)/.exec(header);
  if (rating) out.ratingRange = `${rating[1]}-${rating[2]}`;
  return out;
}

export interface FetchedRaceMeta {
  meta: RaceMeta;
  headerUnparsed: boolean;
}

/** Fetch one race's meta; network/HTTP failure returns all-null meta. */
export async function fetchRaceMeta(date: string, venue: string, raceNo: number): Promise<FetchedRaceMeta> {
  const blank = (): FetchedRaceMeta => ({ meta: emptyRaceMeta(), headerUnparsed: false });
  try {
    const res = await fetch(racecardPageUrl(date, venue, raceNo), {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; tianxi-racing/1.0)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return blank();
    const html = await res.text();
    const meta = parseRaceMeta(html, date, venue, raceNo);
    return { meta, headerUnparsed: trackLineUnparsed(html, meta) };
  } catch {
    return blank();
  }
}
