export const ODDS_STALE_MS = 20 * 60_000;
export function oddsStale(snapshot: string | null, now = Date.now()): boolean {
  const at = snapshot ? Date.parse(snapshot) : NaN;
  return !Number.isFinite(at) || at > now || now - at > ODDS_STALE_MS;
}
export function parseOdds(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
