/**
 * Clock for the official T-90 snapshot workflow.
 *
 * Cloudflare counts each string in a Worker's `crons` array as one account
 * trigger. Workers Free allows 5 triggers per account; Workers Paid allows
 * 1,000. This pager uses one expression so four race-day pokes cost one slot.
 *
 * Cron fields are UTC. Hong Kong has no daylight-saving time (UTC+8).
 */

/** Workers Free account cap. The reader Worker already declares more than this. */
export const FREE_ACCOUNT_CRON_CAP = 5;

/**
 * 03:35, 08:35, 09:35, and 22:35 UTC.
 * Minute 35 is offset from the GitHub snapshot arms at minute 10 and minute 20.
 */
export const PAGER_CRON = '35 3,8,9,22 * * *';

/**
 * Second free clock (cron-job.org). Minute 50 avoids the Worker pager and the
 * GitHub arms. Same UTC hours, still zero Cloudflare cron slots.
 */
export const CRON_JOB_ORG_CRON = '50 3,8,9,22 * * *';

/** Best-effort arms in `.github/workflows/capy_official_snapshot.yml`. */
export const GITHUB_SNAPSHOT_CRONS = [
  '20 22 * * *',
  '20 3 * * *',
  '10 4 * * *',
  '10 8 * * *',
  '20 9 * * *',
] as const;

/** The Action waits at most this long before lockAt. The pager itself does not sleep. */
export const ARM_HORIZON_MINUTES = 330;

/** 2026-11-29 Sha Tin: lockAt 11:15 HKT, first post 12:45 HKT. */
export const SHA_TIN_DAY_WINDOW_HKT = { lock: '11:15', firstPost: '12:45' } as const;

/** Happy Valley night example, including 2026-11-25: lockAt 17:10 HKT, first post 18:40 HKT. */
export const HAPPY_VALLEY_NIGHT_WINDOW_HKT = { lock: '17:10', firstPost: '18:40' } as const;

export function expandUtcTimes(expr: string): string[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 cron fields: ${expr}`);
  const [minuteField, hourField, day, month, dow] = parts;
  if (day !== '*' || month !== '*' || dow !== '*') {
    throw new Error(`expected a daily cron: ${expr}`);
  }
  const minutes = expandField(minuteField, 0, 59);
  const hours = expandField(hourField, 0, 23);
  const out: string[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      out.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  return out;
}

function expandField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(',')) {
    if (!/^\d{1,2}$/.test(part)) throw new Error(`unsupported cron field: ${field}`);
    const value = Number(part);
    if (value < min || value > max) throw new Error(`cron field out of range: ${part}`);
    values.push(value);
  }
  return values;
}

/** Add minutes to a same-day HH:MM clock. dayDelta is the civil-date shift. */
export function addMinutes(hhmm: string, minutes: number): { hhmm: string; dayDelta: number } {
  const total = clockMinutes(hhmm) + minutes;
  const dayDelta = Math.floor(total / 1440);
  const mod = ((total % 1440) + 1440) % 1440;
  return { hhmm: formatClock(mod), dayDelta };
}

export function minutesBetween(earlier: string, later: string): number {
  return clockMinutes(later) - clockMinutes(earlier);
}

/** Half-open range [start, end), matching lockAt <= now < firstPostAt. */
export function clockInHalfOpenRange(start: string, end: string, poke: string): boolean {
  const at = clockMinutes(poke);
  return at >= clockMinutes(start) && at < clockMinutes(end);
}

function clockMinutes(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`expected HH:MM: ${hhmm}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`clock out of range: ${hhmm}`);
  return hour * 60 + minute;
}

function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
