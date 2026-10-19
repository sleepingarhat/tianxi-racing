/** Parse HKJC official "更易事項" (changes) page. Pure; no network. */
export const HKJC_CHANGES_URL = 'https://racing.hkjc.com/zh-hk/local/information/changes';

export type HkjcChange = { raceNumber: number; horseNumber: number; horseName: string; kind: 'scratched' | 'replaced' | 'other'; replacement: string | null; text: string; announcedAt: string; announcedAtIso: string | null };
export type HkjcChangesPage = { date: string; venue: 'ST' | 'HV'; changes: HkjcChange[] };

function toText(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/** "18/10 10:03" HKT in the meeting's season → UTC ISO. Announcements precede the meeting, so roll back a year if needed. */
export function announcedIso(stamp: string, meetingDate: string): string | null {
  const m = stamp.match(/^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  let year = Number(meetingDate.slice(0, 4));
  const meetingMonth = Number(meetingDate.slice(5, 7));
  if (Number(m[2]) > meetingMonth + 1) year -= 1;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(m[3]) - 8, Number(m[4]))).toISOString();
}

export function parseHkjcChangesPage(html: string): HkjcChangesPage | null {
  const text = toText(html);
  const head = text.match(/(\d{2})\/(\d{2})\/(\d{4}) (沙田|跑馬地) 場次 更易事項/);
  if (!head) return null;
  const date = `${head[3]}-${head[2]}-${head[1]}`;
  const venue = head[4] === '沙田' ? 'ST' : 'HV';
  const section = text.slice(text.indexOf(head[0]) + head[0].length).split(/ 1\) 中文| 賽期表 /)[0] ?? '';
  return { date, venue, changes: parseHkjcChanges(section, date) };
}

export function parseHkjcChanges(htmlOrText: string, meetingDate = ''): HkjcChange[] {
  const text = toText(htmlOrText);
  const out: HkjcChange[] = [];
  const races = text.split(/第 (\d+) 場/);
  for (let i = 1; i < races.length; i += 2) {
    const raceNumber = Number(races[i]);
    const body = races[i + 1] ?? '';
    for (const m of body.matchAll(/(\d+) 號馬 (\S+) ([^()]*?)\s*\((\d{2}\/\d{2} \d{2}:\d{2})\)/g)) {
      const [, no = '', name = '', raw = '', stamp = ''] = m;
      const t = raw.trim();
      const rep = t.match(/由後備馬 (\S+) 補上/);
      out.push({ raceNumber, horseNumber: Number(no), horseName: name, kind: rep ? 'replaced' : /退出競賽/.test(t) ? 'scratched' : 'other', replacement: rep?.[1] ?? null, text: t, announcedAt: stamp, announcedAtIso: meetingDate ? announcedIso(stamp, meetingDate) : null });
    }
  }
  return out;
}

/** Withdrawal-type change for this frozen runner, matched by race, number and the original horse name. */
export function officialWithdrawal(changes: HkjcChange[], raceNumber: number, horseNumber: number, horseName: string | null | undefined) {
  if (!horseName) return undefined;
  return changes.find(c => c.raceNumber === raceNumber && c.horseNumber === horseNumber && c.horseName === horseName && (c.kind === 'scratched' || c.kind === 'replaced'));
}
