/**
 * Official results course sentence → races.track + races.course.
 *
 * CSV `course` is the whole HKJC sentence (`草地 - "A" 賽道` or `全天候跑道`).
 * `track` is the surface. `course` becomes the 賽道 code, or `全天候` when
 * there is no quoted rail, so existing rail readers still see an all-weather
 * token. Empty or unknown sentences throw: a page that clearly has a course
 * must not import as a blank track.
 */

export class OfficialFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficialFieldError';
  }
}

export interface OfficialCourse {
  track: string;
  course: string;
}

export function splitOfficialCourse(raw: string | null | undefined): OfficialCourse {
  const text = String(raw ?? '').trim().replace(/[“”]/g, '"');
  if (!text) throw new OfficialFieldError('course empty');
  const turf = /^(草地|泥地|沙地)\s*-\s*"([^"]+)"\s*賽道\s*$/.exec(text);
  if (turf?.[1] && turf[2]) return { track: turf[1], course: turf[2] };
  if (text === '全天候跑道' || text === '全天候') return { track: '全天候', course: '全天候' };
  throw new OfficialFieldError(`course unparsed: ${text}`);
}

/** Blank rating is allowed (462 historical races have none). Any other shape fails. */
export function normalizeRatingRange(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim();
  if (!text || text === '-' || text === '---') return null;
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(text);
  if (!match) throw new OfficialFieldError(`rating_range unparsed: ${text}`);
  return `${match[1]}-${match[2]}`;
}

/**
 * Rail key used by draw layers. Accepts the historical full sentence, the
 * split rail (`A`, `C+3`), and an all-weather token.
 */
export function railKey(course: string | null | undefined): string {
  const text = String(course ?? '').trim();
  if (!text) return 'NA';
  if (text.includes('全天候')) return 'AWT';
  const quoted = text.match(/["“]([^"”]+)["”]/);
  if (quoted?.[1]) return quoted[1].toUpperCase();
  if (/^[A-C](?:\+\d)?$/i.test(text)) return text.toUpperCase();
  return 'NA';
}
