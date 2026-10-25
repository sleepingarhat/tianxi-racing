/**
 * Shared HKJC race-card fetch via the whitelisted GraphQL query.
 *
 * The generic hkjc-api getAllRaces() query has been rejected with
 * WHITELIST_ERROR since 2026-10-23. HKJC's own bet site sends the query in
 * hkjc-racecard-query.graphql to https://info.cld.hkjc.com/graphql/base/;
 * that exact query is accepted. Any HKJC error throws — callers must fail
 * the job, never report it as "no meeting".
 *
 * The response carries no date/venue: HKJC falls back to a default (often
 * overseas simulcast) meeting for dates/venues without a local card. Keep
 * only cards whose every runner has a local HK horse id AND whose runner ids
 * carry the requested date + venue + race number (HKJC runner id format
 * YYYYMMDD + venue + 2-digit race no + horse code, e.g. 20261025ST01L245;
 * verified 2026-10-25). HKJC ignores the variables and returns the current
 * local card for every date/venue, so the earlier "drop any card returned
 * identically for two venues/dates" rule threw away the real card too and
 * left odds/racecard/snapshot jobs green-but-empty on race days.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://info.cld.hkjc.com/graphql/base/';
const LOCAL_HORSE_ID = /^HK_\d{4}_[A-Z]\d{3}$/;

export interface RacecardMeeting {
  date: string;
  venueCode: string;
  races: any[];
  [key: string]: any;
}

export function loadRacecardQuery(): string {
  return readFileSync(fileURLToPath(new URL('./hkjc-racecard-query.graphql', import.meta.url)), 'utf8');
}

/** Stable content signature for fallback detection (date/venue-independent). */
function cardSignature(meeting: any): string {
  const parts: string[] = [];
  for (const race of meeting?.races ?? []) {
    for (const r of race?.runners ?? []) {
      parts.push(`${race?.no}:${r?.no}:${r?.horse?.id ?? ''}:${r?.handicapWeight ?? ''}:${r?.currentWeight ?? ''}`);
    }
  }
  return parts.join('|');
}

export function isLocalCard(meeting: any): boolean {
  const races = meeting?.races ?? [];
  if (!races.length) return false;
  return races.every((r: any) => (r?.runners ?? []).length > 0 && (r?.runners ?? []).every((x: any) => LOCAL_HORSE_ID.test(String(x?.horse?.id ?? ''))));
}

/** True when every runner id carries this exact date + venue + race number. */
export function matchesMeeting(meeting: any, date: string, venueCode: string): boolean {
  const races = meeting?.races ?? [];
  if (!races.length) return false;
  const prefix = `${date.replace(/-/g, '')}${venueCode}`;
  return races.every((r: any) => {
    const raceNo = String(r?.no ?? '').padStart(2, '0');
    const runners = r?.runners ?? [];
    return runners.length > 0 && runners.every((x: any) => String(x?.id ?? '').startsWith(`${prefix}${raceNo}`));
  });
}

/**
 * Fetch the local HK card for each (date, venue) pair. Returns only verified
 * local meetings. Throws on any HKJC HTTP/GraphQL error.
 */
export async function fetchLocalRacecards(dates: string[], venues: string[]): Promise<RacecardMeeting[]> {
  const query = loadRacecardQuery();
  const meetings: RacecardMeeting[] = [];
  for (const date of dates) {
    for (const venueCode of venues) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { date, venueCode } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HKJC HTTP ${res.status} for ${date}@${venueCode}`);
      const body = (await res.json()) as any;
      if (body.errors?.length) throw new Error(`HKJC error for ${date}@${venueCode}: ${JSON.stringify(body.errors).slice(0, 200)}`);
      for (const m of body.data?.raceMeetings ?? []) {
        if ((m.races ?? []).some((r: any) => (r.runners ?? []).length)) meetings.push({ ...m, date, venueCode });
      }
    }
  }
  const localOnly = meetings.filter(m => isLocalCard(m) && matchesMeeting(m, m.date, m.venueCode));
  const counts = new Map<string, number>();
  // Defence in depth: a verified card can match only one (date, venue) pair.
  for (const m of localOnly) counts.set(cardSignature(m), (counts.get(cardSignature(m)) ?? 0) + 1);
  return localOnly.filter(m => counts.get(cardSignature(m)) === 1);
}

/**
 * Weight mapping verified 2026-10-24 against HKJC's own bet-site code, which
 * renders handicapWeight as 負磅 and currentWeight as body weight, and the live
 * 2026-10-25 ST R1 card (handicapWeight 132, currentWeight 921/1151):
 *   handicapWeight -> declared_weight (負磅, before apprentice allowance)
 *   allowance      -> 見習減磅
 *   actual_weight  =  handicapWeight - allowance (實際負磅, matches race_results.actual_weight)
 *   currentWeight  -> 排位體重 (body weight, 900-1300) — never stored as a carried weight
 */
export function mapWeights(runner: any): { declaredWeight: number | null; actualWeight: number | null; bodyWeight: number | null } {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const handicap = num(runner?.handicapWeight);
  const allowance = num(runner?.allowance);
  return {
    declaredWeight: handicap,
    actualWeight: handicap !== null ? handicap - (allowance ?? 0) : null,
    bodyWeight: num(runner?.currentWeight),
  };
}
