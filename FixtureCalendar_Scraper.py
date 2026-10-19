"""
HKJC Fixture Calendar Scraper — extracts annual race-day calendar.

Source: https://racing.hkjc.com/racing/information/Chinese/Racing/Fixture.aspx?calyear=Y&calmonth=M

Key insight: the calendar IS rendered server-side (no JS needed).
Race-day cells are <td class="calendar">DD ...</td>.
Non-race weekdays are <td class="font_wb ">DD</td>.
Other-month fillers are <td class="color_H font_wb">DD</td>.

We fetch each month with httpx and regex-extract td.calendar cells.

Output: data/fixtures/fixtures.csv with columns:
    date (YYYY-MM-DD), season_year, month, day, weekday, captured_at

Run:
    python FixtureCalendar_Scraper.py                 # current year + next year
    python FixtureCalendar_Scraper.py --year 2026     # specific year
    python FixtureCalendar_Scraper.py --years 2025,2026
"""

import argparse
import os
import re
import sys
from datetime import date, datetime, timezone
from typing import List, Dict

import httpx
import pandas as pd

FIXTURE_URL = "https://racing.hkjc.com/racing/information/Chinese/Racing/Fixture.aspx"
OUTPUT_DIR = os.path.join("data", "fixtures")
OUTPUT_CSV = os.path.join(OUTPUT_DIR, "fixtures.csv")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/138.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-HK,zh;q=0.9,en;q=0.8",
}

# Race-day cells look like (verified via browser DOM inspection 2026-04-24):
#   <td class="calendar"> DD <img alt="ST|HV"> ... </td>
# Non-race cells:
#   <td class="font_wb ">DD</td>  (normal weekday)
#   <td class="color_H font_wb">DD</td> (other-month filler)
#
# We match td.calendar specifically and grab the first 1-2 digit number appearing
# within the cell (may or may not be wrapped in <span> or <p>). We then use the
# presence of a venue marker (ST/HV/AWT/st-ch/hv-ch) as a sanity gate.
CALENDAR_CELL_RE = re.compile(
    r'<td[^>]*class="calendar"[^>]*>(.*?)</td>',
    re.IGNORECASE | re.DOTALL,
)
DAY_IN_CELL_RE = re.compile(r'>\s*(\d{1,2})\s*<|^\s*(\d{1,2})\b', re.DOTALL)
VENUE_MARKER_RE = re.compile(r'(?:alt="(?:ST|HV|AWT)"|/(?:st-ch|hv-ch|awt)\.(?:gif|png))', re.IGNORECASE)


# The calendar header renders the month actually displayed, e.g.
#   <td colspan="7">二0二六年九月</td>
# HKJC silently falls back to the CURRENT month when the requested month has no
# fixtures at all (e.g. the August off-season), which previously injected phantom
# race days into fixtures.csv. We therefore verify the rendered month before
# accepting any day from the page.
HEADER_RE = re.compile(r'<td[^>]*colspan="7"[^>]*>\s*([^<]+?)\s*</td>')
CN_DIGIT = {"0": 0, "〇": 0, "零": 0, "O": 0, "o": 0,
            "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9}
CN_MONTH = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
            "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}


def _cn_year(s: str) -> int | None:
    out = 0
    for ch in s.strip():
        if ch not in CN_DIGIT:
            return None
        out = out * 10 + CN_DIGIT[ch]
    return out if 1900 < out < 2200 else None


def rendered_month(html: str) -> tuple[int, int] | None:
    """Return (year, month) as rendered by the calendar header, or None."""
    for raw in HEADER_RE.findall(html):
        m = re.match(r"(.+?)年(.+?)月", raw)
        if not m:
            continue
        y = _cn_year(m.group(1))
        mo = CN_MONTH.get(m.group(2).strip())
        if y and mo:
            return y, mo
    return None


def fetch_month(client: httpx.Client, year: int, month: int) -> List[int]:
    """Return list of race-day day-of-month integers for the given (year, month).

    Note: HKJC accepts both lowercase (calyear/calmonth) and CamelCase
    (CalYear/CalMonth). The page redirects to /zh-hk/local/information/fixture,
    so follow_redirects=True is required.
    """
    url = f"{FIXTURE_URL}?CalYear={year}&CalMonth={month:02d}"
    r = client.get(url, timeout=20.0)
    r.raise_for_status()

    shown = rendered_month(r.text)
    if shown is None:
        print(f"[fixture] {year}-{month:02d} WARN: cannot read calendar header — skipping month",
              file=sys.stderr)
        return []
    if shown != (year, month):
        # Off-season / unavailable month: HKJC served a different month instead.
        print(f"[fixture] {year}-{month:02d} no fixtures (page showed "
              f"{shown[0]}-{shown[1]:02d}) — skipping month", file=sys.stderr)
        return []

    days = []
    for cell_html in CALENDAR_CELL_RE.findall(r.text):
        # Require a venue marker to qualify as race day
        if not VENUE_MARKER_RE.search(cell_html):
            continue
        m = DAY_IN_CELL_RE.search(cell_html)
        if m:
            d = int(m.group(1) or m.group(2))
            if 1 <= d <= 31:
                days.append(d)
    return sorted(set(days))


def scrape_year(year: int) -> List[Dict]:
    rows: List[Dict] = []
    captured = datetime.now(timezone.utc).isoformat()
    with httpx.Client(headers=HEADERS, follow_redirects=True) as client:
        for month in range(1, 13):
            try:
                days = fetch_month(client, year, month)
            except Exception as e:
                print(f"[fixture] {year}-{month:02d} error: {e}", file=sys.stderr)
                continue
            print(f"[fixture] {year}-{month:02d}  race days: {days}")
            for d in days:
                try:
                    dt = date(year, month, d)
                except ValueError:
                    continue
                rows.append({
                    "date": dt.isoformat(),
                    "season_year": year,
                    "month": month,
                    "day": d,
                    "weekday": dt.strftime("%a"),
                    "captured_at": captured,
                })
    return rows


def merge_fixture_rows(old_rows, new_rows):
    """Calendar disappearance is not cancellation evidence; retain original dates."""
    merged = {row['date']: dict(row) for row in old_rows}
    for row in new_rows:
        merged[row['date']] = {**merged.get(row['date'], {}), **row}
    return [merged[key] for key in sorted(merged)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=None)
    ap.add_argument("--years", type=str, default=None, help="comma-separated years")
    args = ap.parse_args()

    today = date.today()
    if args.years:
        years = [int(y) for y in args.years.split(",") if y.strip()]
    elif args.year:
        years = [args.year]
    else:
        years = [today.year, today.year + 1]

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    all_rows: List[Dict] = []
    for y in years:
        all_rows.extend(scrape_year(y))

    if not all_rows:
        print("[fixture] WARN: zero dates scraped — keeping existing cache untouched",
              file=sys.stderr)
        sys.exit(1)

    df_new = pd.DataFrame(all_rows).drop_duplicates(subset=["date"]).sort_values("date")

    # Preserve historical scheduled dates; cancellations require separate evidence.
    if os.path.exists(OUTPUT_CSV):
        df_old = pd.read_csv(OUTPUT_CSV)
        df_final = pd.DataFrame(merge_fixture_rows(df_old.to_dict('records'), df_new.to_dict('records')))
    else:
        df_final = df_new

    df_final.to_csv(OUTPUT_CSV, index=False)
    print(f"[fixture] wrote {len(df_final)} total rows ({len(df_new)} new) -> {OUTPUT_CSV}")

    # Also emit per-year file for convenience
    for y in years:
        sub = df_final[df_final["season_year"] == y]
        per = os.path.join(OUTPUT_DIR, f"{y}_fixtures.csv")
        sub.to_csv(per, index=False)
        print(f"[fixture] wrote {len(sub)} rows -> {per}")


if __name__ == "__main__":
    main()
