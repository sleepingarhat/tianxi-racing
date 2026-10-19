/** Read-only HKJC Rule 3.10 accounting. Model replacements are NOT ticket replacements. */
export const WITHDRAWAL_ACCOUNTING_POLICY = 'official-withdrawals-v3-split';
export const WITHDRAWAL_RULE_SOURCE = 'https://www.hkjc.com/english/betting/template_betting_rule_files/pdf/Horse_Race_Rule_3_Eng_20260330.pdf';
export type SinglePool = 'FF' | 'TRIO' | 'TIERCE' | 'QUARTET';
export type Dividend = { nums: string[]; div: number };
export type Leg = { selections: number[]; withdrawals: number[]; favourites?: number[]; favouriteSource?: string };
const specs: Record<SinglePool, { size: number; ordered: boolean; code: string }> = {
  FF: { size: 4, ordered: false, code: 'FF' }, TRIO: { size: 3, ordered: false, code: 'TRI' },
  TIERCE: { size: 3, ordered: true, code: 'TCE' }, QUARTET: { size: 4, ordered: true, code: 'QTT' },
};
function validNumbers(ns: number[]) { return ns.every(n => Number.isInteger(n) && n > 0) && new Set(ns).size === ns.length; }
export function combinations(ns: number[], size: number, ordered = false): number[][] {
  if (!validNumbers(ns)) throw new Error('invalid-selection-identity');
  if (!size) return [[]];
  return ns.flatMap((n, i) => combinations(ordered ? ns.filter((_, j) => j !== i) : ns.slice(i + 1), size - 1, ordered).map(rest => [n, ...rest]));
}
function key(ns: number[], ordered: boolean) { return (ordered ? ns : [...ns].sort((a,b)=>a-b)).join('-'); }
/** Original hypothetical units were placed at lock. Effective units are a separate scenario. */
export function settleSingleBox(pool: SinglePool, selections: number[], withdrawals: number[], dividends: Dividend[] | null, unit = 10, poolRefunded = false) {
  if (!Number.isFinite(unit) || unit <= 0 || !validNumbers(withdrawals)) throw new Error('invalid-accounting-input');
  const spec = specs[pool], units = combinations(selections, spec.size, spec.ordered);
  const refunded = units.filter(ns => poolRefunded || ns.some(n => withdrawals.includes(n)));
  const active = units.filter(ns => !poolRefunded && !ns.some(n => withdrawals.includes(n)));
  const grossCost = units.length * unit, refund = refunded.length * unit, cost = grossCost - refund;
  let payout: number | null = active.length === 0 ? 0 : dividends === null ? null : 0;
  let hits: number | null = payout === null ? null : 0;
  if (dividends !== null) for (const d of dividends) {
    const ns = d.nums.map(Number);
    if (!validNumbers(ns) || ns.length !== spec.size || !Number.isFinite(d.div) || d.div < 0) throw new Error('invalid-official-dividend');
    if (active.some(u => key(u,spec.ordered) === key(ns,spec.ordered))) { payout = (payout ?? 0) + d.div * unit / 10; hits = (hits ?? 0) + 1; }
  }
  return { pool, units: units.length, activeUnits: active.length, refundedUnits: refunded.length, grossCost, refund, cost, payout, hits, net: payout === null ? null : payout - cost, status: payout === null ? 'pending-official-dividend' : 'settled', ruleSource: WITHDRAWAL_RULE_SOURCE };
}
/** Rule 3.10(b)(iii)(a-f): first available official favourites, excluding retained selections.
 * Never use engine rank, approximate odds or deduplicate resulting ticket units.
 */
export function substituteTrioLeg(leg: Leg) {
  if (leg.selections.length !== 3 || !validNumbers(leg.selections) || !validNumbers(leg.withdrawals)) throw new Error('invalid-trio-leg');
  const kept = leg.selections.filter(n => !leg.withdrawals.includes(n));
  const count = 3 - kept.length;
  if (!count) return { status: 'valid' as const, selections: [...leg.selections], replacements: [] as number[] };
  const fs = leg.favourites;
  if (!fs || fs.length < 3 || !leg.favouriteSource || !validNumbers(fs) || fs.some(n => leg.withdrawals.includes(n))) return { status: 'pending-official-favourites' as const, selections: [] as number[], replacements: [] as number[] };
  const replacements = fs.slice(0,3).filter(n => !kept.includes(n)).slice(0,count);
  if (replacements.length !== count) return { status: 'pending-official-favourites' as const, selections: [] as number[], replacements: [] as number[] };
  return { status: 'valid' as const, selections: [...kept,...replacements], replacements };
}
export function settleCrossTrioTicket(pool: 'DT' | 'TT', legs: Leg[], dividends: { legs: number[][]; div: number }[] | null, unit = 10, poolRefunded = false) {
  if (legs.length !== (pool === 'DT' ? 2 : 3) || !Number.isFinite(unit) || unit <= 0) throw new Error('invalid-cross-ticket');
  if (poolRefunded) return { pool, status: 'settled', grossCost: unit, refund: unit, cost: 0, payout: 0, net: 0, legs: [], ruleSource: WITHDRAWAL_RULE_SOURCE };
  const mapped = legs.map(substituteTrioLeg);
  if (mapped.some(l => l.status !== 'valid')) return { pool, status: 'pending-official-favourites', grossCost: unit, refund: 0, cost: unit, payout: null, net: null, legs: mapped, ruleSource: WITHDRAWAL_RULE_SOURCE };
  let payout: number | null = dividends === null ? null : 0;
  for (const d of dividends ?? []) {
    if (d.legs.length !== legs.length || d.legs.some(l => l.length !== 3 || !validNumbers(l)) || !Number.isFinite(d.div) || d.div < 0) throw new Error('invalid-cross-dividend');
    if (d.legs.every((l,i) => key(l,false) === key(mapped[i]?.selections ?? [],false))) payout = (payout ?? 0) + d.div * unit / 10;
  }
  return { pool, status: payout === null ? 'pending-official-dividend' : 'settled', grossCost: unit, refund: 0, cost: unit, payout, net: payout === null ? null : payout - unit, legs: mapped, ruleSource: WITHDRAWAL_RULE_SOURCE };
}
export function raceAccounting(original: number[], effective: number[], withdrawals: number[], eligible: boolean, divs: Record<string,Dividend[]> | null, poolRefunds: Partial<Record<SinglePool,boolean>> = {}) {
  const settle = (ns: number[]) => Object.entries(specs).map(([pool,spec]) => settleSingleBox(pool as SinglePool,ns,withdrawals,divs === null ? null : divs[spec.code] ?? [],10,poolRefunds[pool as SinglePool] === true));
  return { policy: WITHDRAWAL_ACCOUNTING_POLICY, hasWithdrawal: withdrawals.length > 0, withdrawnHorseNumbers: withdrawals,
    originalTop4: original, effectiveTop4: eligible ? effective : [], scoringEligible: eligible && effective.length === 4,
    original: { basis: 'hypothetical-original-at-lock', pools: eligible ? settle(original) : [], status: eligible ? 'available' : 'excluded-invalid-input' },
    effective: { basis: 'hypothetical-effective-not-an-actual-bet', pools: eligible && effective.length === 4 ? settle(effective) : [], status: eligible && effective.length === 4 ? 'available' : 'excluded-invalid-input' },
    crossRace: { pools: ['DT','TT'], rule: 'official-favourite-per-ticket-not-engine-substitute', status: withdrawals.length ? 'requires-official-favourites-and-ticket-legs' : 'no-withdrawal' }, ruleSource: WITHDRAWAL_RULE_SOURCE };
}
