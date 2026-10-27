/**
 * 官方名次文字 → 數字名次。
 * 完成賽事：「3」、「1 DH」、「3 平頭馬」、中文數字「三」「第十一」。
 * 未完成（PU／WV／WV-A／UR／DNF／---）→ null。純數字「999」保留，
 * 之後由 validFinish（< 999）當 DNF 哨兵拒收。
 */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseNumeral(raw: string): number | null {
  if (!raw) return null;
  if (raw === '十') return 10;
  const tens = raw.match(/^([一二三四五六七八九兩])?十([一二三四五六七八九])?$/);
  if (tens) {
    const hi = tens[1] ? CN_DIGIT[tens[1]] : 1;
    const lo = tens[2] ? CN_DIGIT[tens[2]] : 0;
    if (hi == null || lo == null) return null;
    return hi * 10 + lo;
  }
  if (raw.length === 1 && CN_DIGIT[raw] != null && CN_DIGIT[raw] > 0) return CN_DIGIT[raw];
  return null;
}

export function parseFinishingPositionText(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let text = String(raw).normalize('NFKC').replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text === '---' || text === '--' || text === '-' || text === '—' || text === '–') return null;
  text = text.replace(/^第/, '').replace(/名$/, '').trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 0 ? n : null;
  }

  const dh = text.match(/^(\d+)\s*(?:DH|D\.H\.|平頭馬)/i);
  if (dh) {
    const n = Number(dh[1]);
    return n > 0 ? n : null;
  }

  const zhBody = text.replace(/\s*(?:DH|D\.H\.|平頭馬)\s*$/i, '').trim();
  const zh = parseChineseNumeral(zhBody);
  if (zh != null && zh > 0 && zh < 999) return zh;
  return null;
}

/** 賽果 scrape：完成名次入庫；非數字未完成維持 999，避免改動現有 DNF 查詢。 */
export function parseScrapedFinishingPosition(raw: string | null | undefined): number {
  const n = parseFinishingPositionText(raw);
  return n == null ? 999 : n;
}

/** D1／路由：數字照用；「1 DH」、中文數字等文字先解析，再退回 Number。 */
export function coerceFinishingPosition(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const parsed = parseFinishingPositionText(String(raw));
  if (parsed != null) return parsed;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}
