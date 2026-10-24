/**
 * Append-only racecard snapshot helpers (research data only).
 *
 * Each capture of the HKJC race card is written as a new immutable CSV file
 * plus a manifest line holding its SHA-256. Nothing is ever overwritten; the
 * production freeze still uses the T-90 frozen card, never these snapshots.
 *
 * Weight naming (verified 2026-10-24 against live card 2026-10-25 ST R1):
 *   currentWeight  -> carried_weight_lbs  (實際負磅, e.g. 132)
 *   handicapWeight -> handicap_weight_lbs (宣佈負磅, before allowance; often null)
 * The race card API does NOT carry horse body weight (排位體重); results CSV
 * `declared_wt_lbs` is body weight, a different meaning — never mix the two.
 */
import { createHash } from 'node:crypto';

export const SNAPSHOT_COLUMNS = [
  'race_date', 'venue', 'race_no', 'horse_no', 'horse_name_ch', 'horse_name_en',
  'horse_id', 'horse_code', 'draw', 'jockey_code', 'jockey_ch', 'trainer_code', 'trainer_ch',
  'carried_weight_lbs', 'handicap_weight_lbs', 'allowance', 'rating', 'prev_card_rating',
  'rating_change_vs_prev_card', 'international_rating', 'gear_raw', 'gear_first_time',
  'gear_replaced', 'gear_removed', 'is_standby', 'standby_no', 'runner_status', 'scraped_at',
] as const;

export type SnapshotRow = Record<(typeof SNAPSHOT_COLUMNS)[number], string | number | boolean | null>;

export interface GearFlags { first: string[]; replaced: string[]; removed: string[] }

/** HKJC gear: tokens joined by "/", suffix 1 = first time, 2 = replaced, "-" = removed. */
export function parseGear(raw: string | null | undefined): GearFlags {
  const out: GearFlags = { first: [], replaced: [], removed: [] };
  for (const token of String(raw ?? '').split('/').map(t => t.trim().toUpperCase()).filter(Boolean)) {
    const m = /^([A-Z]+)(1|2|-)?$/.exec(token);
    if (!m) continue;
    if (m[2] === '1') out.first.push(m[1]);
    else if (m[2] === '2') out.replaced.push(m[1]);
    else if (m[2] === '-') out.removed.push(m[1]);
  }
  return out;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** prevRatings: horse_id -> rating from the latest captured card of an EARLIER race date. */
export function buildRows(meeting: any, scrapedAt: string, prevRatings: Map<string, number>): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  const raceDate = String(meeting?.date ?? '');
  const venue = String(meeting?.venueCode ?? '').toUpperCase();
  for (const race of meeting?.races ?? []) {
    for (const r of race?.runners ?? []) {
      const horseId = String(r?.horse?.id ?? '');
      const rating = num(r?.currentRating);
      const prev = horseId ? prevRatings.get(horseId) ?? null : null;
      const gear = parseGear(r?.gearInfo);
      const standby = String(r?.standbyNo ?? '').trim();
      rows.push({
        race_date: raceDate, venue, race_no: num(race?.no), horse_no: num(r?.no),
        horse_name_ch: r?.name_ch ?? null, horse_name_en: r?.name_en ?? null,
        horse_id: horseId || null, horse_code: r?.horse?.code ?? null, draw: num(r?.barrierDrawNumber),
        jockey_code: r?.jockey?.code ?? null, jockey_ch: r?.jockey?.name_ch ?? null,
        trainer_code: r?.trainer?.code ?? null, trainer_ch: r?.trainer?.name_ch ?? null,
        carried_weight_lbs: num(r?.currentWeight), handicap_weight_lbs: num(r?.handicapWeight),
        allowance: r?.allowance ?? null, rating, prev_card_rating: prev,
        rating_change_vs_prev_card: rating !== null && prev !== null ? rating - prev : null,
        international_rating: num(r?.internationalRating), gear_raw: r?.gearInfo ?? '',
        gear_first_time: gear.first.join('/'), gear_replaced: gear.replaced.join('/'), gear_removed: gear.removed.join('/'),
        is_standby: standby !== '' && standby !== '0', standby_no: standby || null,
        runner_status: r?.status ?? null, scraped_at: scrapedAt,
      });
    }
  }
  rows.sort((a, b) => Number(a.race_no) - Number(b.race_no) || Number(a.horse_no ?? 999) - Number(b.horse_no ?? 999) || String(a.standby_no).localeCompare(String(b.standby_no)));
  return rows;
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** UTF-8 BOM CSV with fixed column order. */
export function toCsv(rows: SnapshotRow[]): string {
  return '\uFEFF' + [SNAPSHOT_COLUMNS.join(','), ...rows.map(r => SNAPSHOT_COLUMNS.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

/** Content fingerprint ignores scraped_at so identical cards are not re-saved. */
export function contentSha(rows: SnapshotRow[]): string {
  const body = rows.map(r => SNAPSHOT_COLUMNS.filter(c => c !== 'scraped_at').map(c => cell(r[c])).join(',')).join('\n');
  return createHash('sha256').update(body).digest('hex');
}

export const fileSha = (text: string): string => createHash('sha256').update(text).digest('hex');
