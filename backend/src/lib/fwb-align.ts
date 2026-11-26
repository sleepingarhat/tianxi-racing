/**
 * Attach a First Wish (第一賽驹) row to a racecard runner by brand or horse id.
 *
 * The bonus list prints standby horses as STBY-N. That N reuses a declared
 * saddle number, so race + horse number is not an identity. The captured list
 * number is left as stored.
 */

const BRAND = /^[A-Z]\d{3}$/;
const HORSE_ID = /^HK_\d{4}_([A-Z]\d{3})$/;

export type FwbIdentity = {
  race_no?: unknown;
  raceNo?: unknown;
  horse_no?: unknown;
  horseNo?: unknown;
  is_reserve?: unknown;
  reserve?: unknown;
  brand_no?: unknown;
  brand?: unknown;
  horse_id?: unknown;
  horseId?: unknown;
};

export type FwbAlignment = {
  cardHorseNo: number | null;
  cardReserve: boolean | null;
  cardHorseId: string | null;
  cardBrand: string | null;
  alignedBy: 'brand' | 'horse_id' | null;
};

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function bit(value: unknown): number {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

function raceNo(row: FwbIdentity): number {
  const raw = row.race_no ?? row.raceNo;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function horseNo(row: FwbIdentity): number {
  const raw = row.horse_no ?? row.horseNo;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : NaN;
}

export function brandOf(row: FwbIdentity): string {
  const brand = text(row.brand_no ?? row.brand).toUpperCase();
  if (BRAND.test(brand)) return brand;
  const match = HORSE_ID.exec(text(row.horse_id ?? row.horseId).toUpperCase());
  return match ? match[1] : '';
}

function horseIdOf(row: FwbIdentity): string {
  const horseId = text(row.horse_id ?? row.horseId).toUpperCase();
  return HORSE_ID.test(horseId) ? horseId : '';
}

const UNALIGNED: FwbAlignment = {
  cardHorseNo: null,
  cardReserve: null,
  cardHorseId: null,
  cardBrand: null,
  alignedBy: null,
};

export function alignFwb(row: FwbIdentity, runners: FwbIdentity[]): FwbAlignment {
  const race = raceNo(row);
  const explicit = text(row.brand_no ?? row.brand).toUpperCase();
  const explicitBrand = BRAND.test(explicit) ? explicit : '';
  const brand = explicitBrand || brandOf(row);
  const horseId = horseIdOf(row);
  const sameRace = runners.filter((runner) => raceNo(runner) === race);
  const byBrand = brand ? sameRace.filter((runner) => brandOf(runner) === brand) : [];
  const byId = horseId ? sameRace.filter((runner) => horseIdOf(runner) === horseId) : [];
  let match: FwbIdentity | undefined;
  let alignedBy: FwbAlignment['alignedBy'] = null;
  if (horseId && explicitBrand) {
    const agreed = byId.filter((runner) => byBrand.includes(runner));
    if (agreed.length === 1) {
      match = agreed[0];
      alignedBy = 'horse_id';
    }
  } else if (horseId && byId.length === 1) {
    match = byId[0];
    alignedBy = 'horse_id';
  } else if (!horseId && byBrand.length === 1) {
    match = byBrand[0];
    alignedBy = 'brand';
  }
  if (!match) return UNALIGNED;
  const cardHorseNo = horseNo(match);
  const cardHorseId = horseIdOf(match);
  return {
    cardHorseNo: Number.isInteger(cardHorseNo) ? cardHorseNo : null,
    cardReserve: bit(match.is_reserve ?? match.reserve) === 1,
    cardHorseId: cardHorseId || null,
    cardBrand: brandOf(match) || null,
    alignedBy,
  };
}
