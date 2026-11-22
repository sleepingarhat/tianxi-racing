/**
 * One definition of "this runner starts" for every pre-race scoring path and for
 * the freeze capture that checks it. entries_upcoming.priority_order is null/''
 * or 正選 for declared starters; 退出 (official scratching written by the changes
 * job) and 後備N (reserves) are not starters.
 *
 * 2026-11-22: the predictor scored R9 #3 after it was marked 退出 while the freeze
 * capture compared against starters only, so the counts differed and the whole
 * meeting was blocked (fixture-original-incomplete). Both sides now share this rule.
 */
export function starterPredicate(alias?: string): string {
  const col = alias ? `${alias}.priority_order` : 'priority_order';
  return `(${col} IS NULL OR ${col}='' OR ${col}='正選')`;
}

export function isStarterPriority(value: string | null | undefined): boolean {
  return value == null || value === '' || value === '正選';
}
