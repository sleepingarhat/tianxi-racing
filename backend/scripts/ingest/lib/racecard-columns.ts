/**
 * Runner columns that the whitelisted racecard GraphQL query does not return.
 * HKJC rejects added fields, so 評分+/−, 排位體重+/−, 最佳時間 and 上賽距今日數
 * are read from the public RaceCard HTML table, including cells the page hides.
 * 可能超磅 and 分齡讓磅 are the same table. A blank cell stays null. A present
 * cell that is not the official shape fails the card. These values are display
 * fields, not a model input and not a frozen-pick input.
 */

export class RacecardColumnError extends Error {}

export interface RacecardColumnRow {
  horseNo: number;
  brand: string;
  horseId: string;
  ratingChange: number | null;
  bodyWeightChange: number | null;
  bestTime: string | null;
  daysSinceRun: number | null;
  /** 可能超磅, pounds. Null when the cell is blank. */
  possibleOverweight: number | null;
  /** 分齡讓磅, pounds. Null when the cell is blank or "-". */
  ageAllowance: number | null;
}

const HEADERS = [
  '馬匹編號', '6次近績', '綵衣', '馬名', '烙號', '負磅', '騎師', '可能超磅', '檔位', '練馬師',
  '國際評分', '評分', '評分+/-', '排位體重', '排位體重+/-', '最佳時間', '馬齡', '分齡讓磅',
  '性別', '今季獎金', '優先參賽次序', '上賽距今日數', '配備', '馬主', '父系', '母系', '進口類別',
] as const;

const POSSIBLE_OVERWEIGHT = 7;
const RATING_CHANGE = 12;
const BODY_CHANGE = 14;
const BEST_TIME = 15;
const AGE_ALLOWANCE = 17;
const DAYS_SINCE = 21;
const HORSE_ID = /^HK_\d{4}_([A-Z]\d{3})$/;
const BEST_TIME_TEXT = /^\d{1,2}\.\d{2}\.\d{2}$/;

function cellText(inner: string): string {
  return inner
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsOf(rowHtml: string): Array<{ text: string; html: string }> {
  const cells: Array<{ text: string; html: string }> = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rowHtml))) cells.push({ text: cellText(match[1]), html: match[1] });
  return cells;
}

function rowsOf(tableHtml: string): string[] {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
}

function signed(value: string, label: string): number | null {
  if (value === '' || value === '-') return null;
  const text = value.startsWith('+') ? value.slice(1) : value;
  if (!/^-?\d+$/.test(text)) throw new RacecardColumnError(`${label} ${value} is not an official change`);
  const number = Number(text);
  if (!Number.isInteger(number) || number < -400 || number > 400) {
    throw new RacecardColumnError(`${label} ${value} is outside the official change range`);
  }
  return number;
}

function bestTime(value: string): string | null {
  if (value === '' || value === '-') return null;
  if (!BEST_TIME_TEXT.test(value)) throw new RacecardColumnError(`best time ${value} is not m.ss.hs`);
  return value;
}

function daysSince(value: string): number | null {
  if (value === '' || value === '-') return null;
  if (!/^\d{1,3}$/.test(value)) throw new RacecardColumnError(`days since last run ${value} is not a count`);
  return Number(value);
}

/** A blank or dash cell is null. A printed 0 stays 0. */
function pounds(value: string, label: string): number | null {
  if (value === '' || value === '-' || value === '--') return null;
  const text = value.startsWith('+') ? value.slice(1) : value;
  if (!/^\d{1,2}$/.test(text)) throw new RacecardColumnError(`${label} ${value} is not official pounds`);
  const number = Number(text);
  if (number > 40) throw new RacecardColumnError(`${label} ${value} is outside 0 to 40`);
  return number;
}

/**
 * Starter-table rows keyed by saddle number. Null when this HTML has no starter
 * table (the card is not declared on the page). Throws when the table is present
 * but a header or cell is not the official shape.
 */
export function parseRacecardColumns(html: string): Map<number, RacecardColumnRow> | null {
  const table = /<table\b[^>]*class="[^"]*\bstarter\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) return null;
  const parsedRows = rowsOf(table[1]).map(cellsOf).filter((cells) => cells.length > 0);
  const header = parsedRows.find((cells) => cells[0]?.text === '馬匹編號');
  if (!header) throw new RacecardColumnError('racecard starter table has no horse-number header');
  const titles = header.map((cell) => cell.text);
  if (titles.length !== HEADERS.length || titles.some((title, index) => title !== HEADERS[index])) {
    throw new RacecardColumnError(`racecard columns changed: ${titles.join('|')}`);
  }
  const out = new Map<number, RacecardColumnRow>();
  for (const cells of parsedRows) {
    if (cells[0]?.text === '馬匹編號') continue;
    if (!/^\d+$/.test(cells[0]?.text ?? '')) continue;
    if (cells.length !== HEADERS.length) {
      throw new RacecardColumnError(`racecard row has ${cells.length} cells`);
    }
    const horseNo = Number(cells[0].text);
    const brand = cells[4].text;
    const link = /horseid=(HK_\d{4}_[A-Z]\d{3})/.exec(cells[3].html);
    if (!HORSE_ID.test(`HK_2000_${brand}`) || !/^[A-Z]\d{3}$/.test(brand)) {
      throw new RacecardColumnError(`racecard brand ${brand} is not a local brand`);
    }
    if (!link) throw new RacecardColumnError(`racecard horse ${horseNo} has no horse link`);
    const horseId = link[1];
    if (!horseId.endsWith(`_${brand}`)) {
      throw new RacecardColumnError(`racecard horse ${horseNo} link ${horseId} disagrees with brand ${brand}`);
    }
    if (out.has(horseNo)) throw new RacecardColumnError(`racecard horse number ${horseNo} is repeated`);
    out.set(horseNo, {
      horseNo,
      brand,
      horseId,
      ratingChange: signed(cells[RATING_CHANGE].text, 'rating change'),
      bodyWeightChange: signed(cells[BODY_CHANGE].text, 'body-weight change'),
      bestTime: bestTime(cells[BEST_TIME].text),
      daysSinceRun: daysSince(cells[DAYS_SINCE].text),
      possibleOverweight: pounds(cells[POSSIBLE_OVERWEIGHT].text, 'possible overweight'),
      ageAllowance: pounds(cells[AGE_ALLOWANCE].text, 'age allowance'),
    });
  }
  if (!out.size) throw new RacecardColumnError('racecard starter table has a header and no runners');
  return out;
}

function standby(runner: any): boolean {
  const standbyNo = String(runner?.standbyNo ?? '');
  return standbyNo !== '' && standbyNo !== '0';
}

/**
 * Every non-reserve GraphQL runner must be the same horse as the HTML row.
 * Reserve runners are not on this table; their four cells stay empty.
 */
export function assertRacecardColumns(rows: Map<number, RacecardColumnRow>, runners: any[]): void {
  columnRowForRunner(rows, runners, { standbyNo: '1' });
}

export function columnRowForRunner(
  rows: Map<number, RacecardColumnRow>,
  runners: any[],
  runner: any,
): RacecardColumnRow | null {
  const active = runners.filter((item) => !standby(item));
  const expected = new Set<number>();
  for (const item of active) {
    const horseNo = Number(item?.no ?? item?.saddleClothNo ?? 0);
    if (!horseNo || expected.has(horseNo)) {
      throw new RacecardColumnError(`racecard runner number ${horseNo} is missing or repeated`);
    }
    expected.add(horseNo);
    const id = String(item?.horse?.id ?? '');
    const brand = HORSE_ID.exec(id);
    if (!brand) throw new RacecardColumnError(`runner ${horseNo} horse id ${id} is not local`);
    const code = item?.horse?.code;
    if (code != null && code !== '' && String(code) !== brand[1]) {
      throw new RacecardColumnError(`runner ${horseNo} code ${code} disagrees with ${brand[1]}`);
    }
    const row = rows.get(horseNo);
    if (!row || row.horseId !== id) {
      throw new RacecardColumnError(`runner ${horseNo} ${id} is not on the racecard table`);
    }
  }
  for (const horseNo of rows.keys()) {
    if (!expected.has(horseNo)) {
      throw new RacecardColumnError(`racecard table horse ${horseNo} is not in the declared card`);
    }
  }
  if (standby(runner)) return null;
  const horseNo = Number(runner?.no ?? runner?.saddleClothNo ?? 0);
  return rows.get(horseNo) ?? null;
}
