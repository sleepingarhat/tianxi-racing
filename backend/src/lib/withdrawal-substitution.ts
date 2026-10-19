/** Post-freeze withdrawals: fill the four from the frozen engine order. Never rewrites the frozen ranks. */
export type RankedPick = { horseNumber: number; rank: number; withdrawn?: boolean; announcedAtIso?: string | null | undefined | undefined };

export function effectiveTop4<T extends RankedPick>(picks: T[], lockAt?: string | null) {
  const ordered = picks.filter(p => Number.isFinite(p.rank)).sort((a, b) => a.rank - b.rank);
  const original = ordered.slice(0, 4).map(p => p.horseNumber);
  const withdrawals = ordered.filter(p => p.withdrawn);
  const lockTime = Date.parse(lockAt ?? '');
  // A stale input anywhere in the race invalidates its ranking. Only proven
  // after-lock announcements allow substitutions; originals remain untouched.
  const beforeLock = withdrawals.some(p => Number.isFinite(lockTime) && Number.isFinite(Date.parse(p.announcedAtIso ?? '')) && Date.parse(p.announcedAtIso ?? '') <= lockTime);
  const unknown = withdrawals.some(p => !Number.isFinite(lockTime) || !Number.isFinite(Date.parse(p.announcedAtIso ?? '')));
  if (beforeLock || unknown) {
    return { original, effective: [] as number[], removed: [] as number[], added: [] as number[], substituted: false, status: beforeLock ? 'invalid-prelock-input' as const : 'unverified-change-timing' as const };
  }
  const effective = ordered.filter(p => !p.withdrawn).slice(0, 4).map(p => p.horseNumber);
  const removed = original.filter(n => !effective.includes(n));
  const added = effective.filter(n => !original.includes(n));
  return { original, effective, removed, added, substituted: added.length > 0 || removed.length > 0, status: 'valid' as const };
}
