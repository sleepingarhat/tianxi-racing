/**
 * Official published ranking SSOT helpers.
 *
 * Live LGB / ensemble recompute is allowed to drift as future results land.
 * Anything shown as "the prediction" for a settled HK meeting must come from
 * prediction_log (the pre-race freeze), not from that live path.
 */

export function horseNoKey(value: unknown): string {
  if (value == null || value === '') return '';
  return String(value).trim();
}

export function predictedTop4Key(picks: unknown): string {
  if (!Array.isArray(picks)) return '';
  const nums = picks
    .slice()
    .sort((a: any, b: any) => (Number(a?.rank) || 99) - (Number(b?.rank) || 99))
    .slice(0, 4)
    .map((p: any) => horseNoKey(p?.horseNumber ?? p?.horse_number))
    .filter(Boolean);
  return nums.length ? nums.join('-') : '';
}

export function top4Mismatch(a: unknown, b: unknown): boolean {
  const left = predictedTop4Key(a);
  const right = predictedTop4Key(b);
  if (!left || !right) return false;
  return left !== right;
}

/**
 * Analytical fields are frozen-owned: a frozen NULL stays NULL and is never
 * hydrated from the live recompute. Live identity/display fields (names,
 * jockey, trainer) may still fill gaps because they are not predictions.
 */
const FROZEN_OWNED_FIELDS = [
  'horseElo', 'eloComposite', 'factorBonus', 'finalScore',
  'pWin', 'pTop3', 'pTop4', 'rank', 'lgbScore', 'lgbModelVersion', 'scoreSource',
] as const;

export function mergeFrozenPick(live: Record<string, any> | null | undefined, frozen: Record<string, any>): Record<string, any> {
  const rc = live && typeof live === 'object' ? live : {};
  const merged: Record<string, any> = {
    ...rc,
    horseId: frozen.horseId ?? rc.horseId ?? null,
    horseNumber: frozen.horseNumber ?? rc.horseNumber,
    draw: frozen.draw ?? rc.draw ?? null,
    nameCh: rc.nameCh ?? frozen.nameCh,
    nameEn: rc.nameEn ?? frozen.nameEn ?? null,
    jockeyCh: rc.jockeyCh ?? frozen.jockeyCh ?? null,
    trainerCh: rc.trainerCh ?? frozen.trainerCh ?? null,
  };
  for (const field of FROZEN_OWNED_FIELDS) {
    merged[field] = field in frozen ? frozen[field] : null;
  }
  return merged;
}

/**
 * Apply the frozen ranking to a live payload. Fail-closed: the frozen set must
 * have unique horses and unique positive ranks, and every frozen horse must
 * exist in the live field. Ranks are never renumbered — the frozen rank is
 * the record. Returns applied:false when the frozen evidence is not intact.
 */
export function applyFrozenOrder(
  livePicks: any[] | null | undefined,
  frozenPicks: any[] | null | undefined,
): { picks: any[]; applied: boolean; reason?: string } {
  if (!Array.isArray(frozenPicks) || frozenPicks.length < 4) {
    return { picks: Array.isArray(livePicks) ? livePicks : [], applied: false, reason: 'frozen-incomplete' };
  }
  const seenHorses = new Set<string>();
  const seenRanks = new Set<number>();
  for (const fp of frozenPicks) {
    const key = fp?.horseId ? `id:${fp.horseId}` : `no:${horseNoKey(fp?.horseNumber)}`;
    const rank = Number(fp?.rank);
    if (!key || key === 'no:' || seenHorses.has(key)) return { picks: [], applied: false, reason: 'frozen-duplicate-horse' };
    if (!Number.isInteger(rank) || rank < 1 || seenRanks.has(rank)) return { picks: [], applied: false, reason: 'frozen-duplicate-rank' };
    seenHorses.add(key);
    seenRanks.add(rank);
  }
  const byNo = new Map<string, any>();
  const byId = new Map<string, any>();
  for (const p of livePicks || []) {
    const no = horseNoKey(p?.horseNumber);
    if (no) byNo.set(no, p);
    if (p?.horseId) byId.set(String(p.horseId), p);
  }
  const picks = frozenPicks.map((fp) => {
    const live = (fp?.horseId && byId.get(String(fp.horseId))) || byNo.get(horseNoKey(fp?.horseNumber)) || null;
    return mergeFrozenPick(live, fp);
  });
  picks.sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
  return { picks, applied: true };
}

export type LockRaceAudit = {
  raceNumber: number;
  frozenTop4: string;
  comparedTop4: string;
  ok: boolean;
};

export function auditTop4Pairs(
  frozenByRace: Map<number, any[]>,
  comparedByRace: Map<number, any[]>,
): { ok: boolean; races: LockRaceAudit[]; mismatches: LockRaceAudit[] } {
  const races: LockRaceAudit[] = [];
  for (const [rn, frozen] of frozenByRace) {
    const compared = comparedByRace.get(rn) || [];
    const frozenTop4 = predictedTop4Key(frozen);
    const comparedTop4 = predictedTop4Key(compared);
    if (!frozenTop4) continue;
    const row = {
      raceNumber: rn,
      frozenTop4,
      comparedTop4,
      ok: !!comparedTop4 && frozenTop4 === comparedTop4,
    };
    races.push(row);
  }
  const mismatches = races.filter((r) => !r.ok);
  return { ok: mismatches.length === 0 && races.length > 0, races, mismatches };
}
