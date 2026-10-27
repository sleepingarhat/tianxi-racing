"""
HKJC Fixture Calendar Scraper — extracts annual race-day calendar.

Source: https://racing.hkjc.com/racing/information/Chinese/Racing/Fixture.aspx?calyear=Y&calmonth=M

Key insight: the calendar IS rendered server-side (no JS needed).
Race-day cells are <td class="calendar">DD ...</td>.
Non-race weekdays are <td class="font_wb ">DD</td>.
Other-month fillers are <td class="color_H font_wb">DD</td>.

We fetch each month with httpx and regex-extract td.calendar cells.

Output: data/fixtures/fixtures.csv with columns:
    date, season_year, month, day, weekday, venue, timing, race_count, surface, captured_at

venue is ST/HV, timing is day/night/twilight, surface is turf/awt/mixed.
Twilight is the dusk.gif icon (alt T, 黃昏). race_count is the sum of the
distance(n) lines in the cell.
An empty month whose calendar title is a different month is still skipped.

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
HEADER_ICONS_RE = re.compile(r'<span class="f_fr">(.*?)</span>', re.IGNORECASE | re.DOTALL)
ALT_RE = re.compile(r'alt="([^"]*)"', re.IGNORECASE)
DAY_SPAN_RE = re.compile(r'class="[^"]*\bf_fs14\b[^"]*"[^>]*>\s*(\d{1,2})\s*<', re.IGNORECASE)
RACE_COUNT_RE = re.compile(r'\d{3,4}\((\d+)\)')
DISTANCE_TEXT_RE = re.compile(r'\d{3,4}')
# T is dusk.gif (黃昏 / twilight). Day and night stay D and N.
TIMING_ALT = {"D": "day", "N": "night", "T": "twilight"}
SURFACE_ALT = {"TURF": "turf", "AWT": "awt", "MIXED": "mixed"}
def _blank(value):
    if value is None:
        return ""
    try:
        import pandas as pd
        if pd.isna(value):
            return ""
    except TypeError:
        pass
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


FIXTURE_COLUMNS = [
    "date", "season_year", "month", "day", "weekday",
    "venue", "timing", "race_count", "surface", "captured_at",
]


class FixtureParseError(ValueError):
    """The calendar showed a race day but a critical icon or count was empty."""


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


def parse_calendar_cell(cell_html: str) -> dict | None:
    """Race-day identity from the cell's header icons, or None if it is not a race day.

    Header icons live in the first ``f_fr`` span (venue, day/night/twilight, surface).
    Later AWT dots mark individual races and are not the meeting surface.
    """
    icon_block = HEADER_ICONS_RE.search(cell_html)
    alts = [alt.upper() for alt in ALT_RE.findall(icon_block.group(1) if icon_block else "")]
    venue = next((alt for alt in alts if alt in ("ST", "HV")), None)
    if venue is None:
        if VENUE_MARKER_RE.search(cell_html):
            raise FixtureParseError("race-day cell has a venue marker but no ST/HV icon")
        return None
    timing = next((TIMING_ALT[alt] for alt in alts if alt in TIMING_ALT), None)
    surface = next((SURFACE_ALT[alt] for alt in alts if alt in SURFACE_ALT), None)
    if not timing or not surface:
        raise FixtureParseError(f"{venue} cell missing day/night/twilight or turf/AWT/mixed icons: {alts}")
    counts = [int(n) for n in RACE_COUNT_RE.findall(cell_html)]
    if counts:
        race_count = str(sum(counts))
    else:
        # A programmed card always prints distances. An icon-only cell (a future
        # season, or a day HKJC has not listed distances for) has no count to store.
        visible = re.sub(r"<[^>]+>", " ", cell_html)
        if DISTANCE_TEXT_RE.search(visible):
            raise FixtureParseError(f"{venue} cell shows a distance but no distance(count) lines: {alts}")
        race_count = ""
    day_match = DAY_SPAN_RE.search(cell_html) or DAY_IN_CELL_RE.search(cell_html)
    if not day_match:
        raise FixtureParseError(f"{venue} cell has no day number")
    day_text = next((group for group in day_match.groups() if group), None)
    if not day_text:
        raise FixtureParseError(f"{venue} cell has no day number")
    day = int(day_text)
    if not 1 <= day <= 31:
        raise FixtureParseError(f"day out of range: {day}")
    return {
        "day": day,
        "venue": venue,
        "timing": timing,
        "surface": surface,
        "race_count": race_count,
    }


def parse_month_html(html: str, year: int, month: int) -> List[dict]:
    """Race days for one month. A title for a different month yields no days.

    That empty-month guard stays: HKJC serves the current month when the
    requested month has no fixtures. Cells that are clearly race days but
    lack venue, session, or surface raise FixtureParseError. A distance that
    is on the page but does not match distance(count) fails the same way.
    A cell with no distances keeps a blank race count.
    """
    shown = rendered_month(html)
    if shown is None:
        print(f"[fixture] {year}-{month:02d} WARN: cannot read calendar header — skipping month",
              file=sys.stderr)
        return []
    if shown != (year, month):
        print(f"[fixture] {year}-{month:02d} no fixtures (page showed "
              f"{shown[0]}-{shown[1]:02d}) — skipping month", file=sys.stderr)
        return []

    cells = CALENDAR_CELL_RE.findall(html)
    parsed = []
    for cell_html in cells:
        row = parse_calendar_cell(cell_html)
        if row:
            parsed.append(row)
    if cells and not parsed:
        raise FixtureParseError(f"{year}-{month:02d} has calendar cells but no parsed race days")
    by_day = {row["day"]: row for row in parsed}
    return [by_day[day] for day in sorted(by_day)]


def fetch_month(client, year: int, month: int) -> List[dict]:
    """Return race-day records for (year, month).

    HKJC accepts both lowercase and CamelCase query keys. The page redirects
    to /zh-hk/local/information/fixture, so follow_redirects=True is required.
    """
    url = f"{FIXTURE_URL}?CalYear={year}&CalMonth={month:02d}"
    r = client.get(url, timeout=20.0)
    r.raise_for_status()
    return parse_month_html(r.text, year, month)


def scrape_year(year: int) -> List[Dict]:
    rows: List[Dict] = []
    import httpx
    captured = datetime.now(timezone.utc).isoformat()
    with httpx.Client(headers=HEADERS, follow_redirects=True) as client:
        for month in range(1, 13):
            try:
                days = fetch_month(client, year, month)
            except FixtureParseError:
                raise
            except Exception as e:
                print(f"[fixture] {year}-{month:02d} error: {e}", file=sys.stderr)
                continue
            print(f"[fixture] {year}-{month:02d}  race days: "
                  f"{[row['day'] for row in days]}")
            for row in days:
                try:
                    dt = date(year, month, row["day"])
                except ValueError:
                    continue
                if not row["venue"] or not row["timing"] or not row["surface"]:
                    raise FixtureParseError(f"{dt.isoformat()} missing venue, timing, or surface")
                rows.append({
                    "date": dt.isoformat(),
                    "season_year": year,
                    "month": month,
                    "day": row["day"],
                    "weekday": dt.strftime("%a"),
                    "venue": row["venue"],
                    "timing": row["timing"],
                    "race_count": row["race_count"],
                    "surface": row["surface"],
                    "captured_at": captured,
                })
    return rows


def merge_fixture_rows(old_rows, new_rows):
    """Calendar disappearance is not cancellation evidence; retain original dates.

    A blank new field does not erase a value already stored for that date.
    This function stays self-contained: the ingestion safety test loads it alone.
    """
    def present(value):
        if value is None:
            return False
        text = str(value).strip()
        return text != "" and text.lower() != "nan"

    merged = {row['date']: dict(row) for row in old_rows}
    for row in new_rows:
        prior = dict(merged.get(row['date'], {}))
        incoming = {}
        for key, value in row.items():
            if not present(value) and present(prior.get(key)):
                continue
            incoming[key] = value
        merged[row['date']] = {**prior, **incoming}
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

    import pandas as pd
    df_new = pd.DataFrame(all_rows).drop_duplicates(subset=["date"]).sort_values("date")

    # Preserve historical scheduled dates; cancellations require separate evidence.
    if os.path.exists(OUTPUT_CSV):
        df_old = pd.read_csv(OUTPUT_CSV)
        df_final = pd.DataFrame(merge_fixture_rows(df_old.to_dict('records'), df_new.to_dict('records')))
    else:
        df_final = df_new

    for col in ("venue", "timing", "race_count", "surface"):
        if col not in df_final.columns:
            df_final[col] = ""
        df_final[col] = df_final[col].apply(_blank)
    df_final = df_final.reindex(columns=FIXTURE_COLUMNS)
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
