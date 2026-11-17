/**
 * Official single-race void (HKJC local results).
 *
 * 2026-11-14 Sha Tin race 6, HTTP 200:
 * 「此場賽事宣佈取消。根據賽馬博彩規例，若此賽事設有單場彩池，有關注項將予以退款。」
 * Every single-race pool on that page is 退款.
 *
 * tianxi-web MeetingCancellationNotice renders a meeting notice from
 * `label` + `reason`. A void race uses the same words at race level:
 * label 「取消」, reason / officialMessage = the official sentence, refund = true.
 * cardStatus 「cancelled」 is not one of fixture/entries/declared/resulted;
 * clients that only know those four values should read `cancelled` / `label`.
 * Do not show this race as 待核.
 */

export const OFFICIAL_RACE_CANCELLED =
  '此場賽事宣佈取消。根據賽馬博彩規例，若此賽事設有單場彩池，有關注項將予以退款。';

const COMPACT = OFFICIAL_RACE_CANCELLED.replace(/\s+/g, '');
const RACE_HEADER = /第\s*(\d+)\s*場\s*\(\d+\)/;

export function isVoidStatus(status: unknown): boolean {
  const value = String(status ?? '').trim().toLowerCase();
  return value === 'cancelled' || value === 'void';
}

export function officialCancellationMessage(pageText: string | null | undefined): string | null {
  const compact = String(pageText ?? '').replace(/\s+/g, '');
  if (!compact.includes(COMPACT)) return null;
  if (!String(pageText ?? '').includes('退款')) return null;
  return OFFICIAL_RACE_CANCELLED;
}

/** A 第 N 場 header for a different race is not this request. No header is not a conflict. */
export function conflictingRaceHeader(pageText: string | null | undefined, requestedRaceNo: number): boolean {
  if (!Number.isInteger(requestedRaceNo) || requestedRaceNo < 1) return true;
  const match = RACE_HEADER.exec(String(pageText ?? ''));
  if (!match) return false;
  return Number(match[1]) !== requestedRaceNo;
}

export function cancelledRaceFromPage(
  pageText: string | null | undefined,
  requestedRaceNo: number,
): { raceNumber: number; status: 'cancelled'; officialMessage: string; refund: true } | null {
  if (conflictingRaceHeader(pageText, requestedRaceNo)) return null;
  const officialMessage = officialCancellationMessage(pageText);
  if (!officialMessage) return null;
  return { raceNumber: requestedRaceNo, status: 'cancelled', officialMessage, refund: true };
}

export function isVoidResultRow(row: {
  race_status?: string | null;
  place?: string | null;
  horse_no?: string | null;
} | null | undefined): boolean {
  if (!row) return false;
  const horse = String(row.horse_no ?? '').trim();
  if (horse) return false;
  if (isVoidStatus(row.race_status)) return true;
  const place = String(row.place ?? '').trim();
  return place === '取消' || place === 'VOID' || place === 'void';
}

/** Fields /api/meetings and /api/races add on top of a race row. */
export function publicVoidRaceFields(race: {
  status?: string | null;
  official_note?: string | null;
} | null | undefined): Record<string, unknown> {
  if (!isVoidStatus(race?.status)) {
    return { status: 'resulted', cancelled: false, void: false, refund: false };
  }
  const officialMessage = String(race?.official_note || '').trim() || OFFICIAL_RACE_CANCELLED;
  return {
    status: 'cancelled',
    cardStatus: 'cancelled',
    cancelled: true,
    void: true,
    refund: true,
    officialMessage,
    // Same words MeetingCancellationNotice already renders for a 停賽 notice.
    label: '取消',
    reason: officialMessage,
  };
}
