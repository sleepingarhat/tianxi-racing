"""HKJC 報名表 (entries) for every upcoming fixture, including meetings after
the next one and days whose barrier draw is not published yet.

The page is server-rendered HTML. A row is written only when the displayed
賽事日期 and venue match the fixture we asked for. An unpublished day is
skipped and does not erase a previously stored list. A page that shows a
different meeting is a hard failure.

Outputs (repo files, then D1 via capy_d1_sync_entries):
  entries/official/entries_<YYYY-MM-DD>_<ST|HV>.csv

This list is card_stage=entries and draw_status=unavailable. It is not a
declared racecard and it does not invent horse numbers or barrier draws.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_CSV = ROOT / "data" / "fixtures" / "fixtures.csv"
OUT_DIR = ROOT / "entries" / "official"
ENTRIES_URL = (
    "https://racing.hkjc.com/zh-hk/local/information/entries"
    "?racedate={slash}&Racecourse={venue}"
)
VENUE_NAME = {"沙田": "ST", "跑馬地": "HV"}
NAME_VENUE = {"ST": "沙田", "HV": "跑馬地"}
FIELDS = [
    "race_date", "venue", "race_number", "horse_code", "horse_name", "trainer_name",
    "race_class", "distance", "track", "rating_range", "race_name", "section_label",
    "card_stage", "draw_status", "source_sha256", "scraped_at",
]
RACE_LINK = re.compile(
    r"^(?P<klass>第.+?班(?:（條件限制）)?)\s+(?P<distance>\d+)米\s+組別(?P<section>\S+)\s+"
    r"(?P<name>.+?)\s+\(評分\s+(?P<rating>\d+\s*-\s*\d+)\)$"
)
HORSE_ID = re.compile(r"horseid=HK_\d{4}_([A-Z]\d+)", re.I)
DATE_LINE = re.compile(r"賽事日期:\s*(\d{2})/(\d{2})/(\d{4})\s*(沙田|跑馬地)")
HEADER_LABELS = ("賽事班次", "評分幅度", "途程", "組別", "賽道")


class EntriesParseError(Exception):
    pass


def hk_today():
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date()


def _text(fragment: str) -> str:
    cleaned = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", unescape(cleaned)).strip()


def _cells(row_html: str) -> list[str]:
    return re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row_html, flags=re.I)


def fixture_targets(horizon_days: int, today=None) -> list[tuple[str, str]]:
    """Official ST/HV fixtures from today through the horizon, CSV order."""
    if not FIXTURE_CSV.is_file():
        raise EntriesParseError(f"fixture calendar missing: {FIXTURE_CSV}")
    start = today or hk_today()
    end = start + timedelta(days=horizon_days)
    out: list[tuple[str, str]] = []
    with FIXTURE_CSV.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            raw = (row.get("date") or "").strip()
            venue = (row.get("venue") or "").strip().upper()
            try:
                day = datetime.strptime(raw, "%Y-%m-%d").date()
            except ValueError:
                raise EntriesParseError(f"fixture date is not YYYY-MM-DD: {raw!r}")
            if venue not in ("ST", "HV"):
                raise EntriesParseError(f"fixture {raw} has no ST/HV venue")
            if start <= day <= end:
                out.append((raw, venue))
    return out


def parse_entries_html(html: str, race_date: str, venue: str, scraped_at: str) -> list[dict]:
    """Return entry rows, or [] when this fixture has no published list yet.

    Raises EntriesParseError when the page claims to be a list but the date,
    venue, or grid does not match the request.
    """
    if venue not in NAME_VENUE:
        raise EntriesParseError(f"venue must be ST or HV, got {venue}")
    want = datetime.strptime(race_date, "%Y-%m-%d")
    dated = DATE_LINE.search(_text(html))
    table = re.search(r'<table id="trainersInfo"[\s\S]*?</table>', html, flags=re.I)
    if not dated:
        if "沒有相關資料" in html or table is None:
            return []
        raise EntriesParseError(f"{race_date} {venue}: entries page has no 賽事日期")
    dd, mm, yyyy, course = dated.groups()
    shown = f"{yyyy}-{mm}-{dd}"
    shown_venue = VENUE_NAME[course]
    if shown != race_date or shown_venue != venue:
        raise EntriesParseError(
            f"entries page shows {shown} {shown_venue}, requested {race_date} {venue}"
        )
    if table is None:
        if "沒有相關資料" in html:
            return []
        raise EntriesParseError(f"{race_date} {venue}: 賽事日期 matches but the trainers table is missing")

    table_html = table.group(0)
    thead = re.search(r"<thead>([\s\S]*?)</thead>", table_html, flags=re.I)
    tbody = re.search(r"<tbody>([\s\S]*?)</tbody>", table_html, flags=re.I)
    if not thead or not tbody:
        raise EntriesParseError(f"{race_date} {venue}: trainers table has no head/body")

    header_rows = []
    for row_html in re.findall(r"<tr[\s\S]*?</tr>", thead.group(1), flags=re.I):
        cells = [_text(cell) for cell in _cells(row_html)]
        if cells:
            header_rows.append(cells)
    by_label = {}
    for cells in header_rows:
        if cells[0] in HEADER_LABELS:
            by_label[cells[0]] = cells[1:]
    missing = [label for label in HEADER_LABELS if label not in by_label]
    if missing:
        raise EntriesParseError(f"{race_date} {venue}: missing header rows {missing}")
    width = len(by_label["途程"])
    if width < 1 or any(len(by_label[label]) != width for label in HEADER_LABELS):
        raise EntriesParseError(f"{race_date} {venue}: header columns are uneven")

    links = []
    for raw in re.findall(r"ProvRaceNo=P\d+[^>]*>([^<]+)", html, flags=re.I):
        label = _text(raw)
        matched = RACE_LINK.match(label)
        if not matched:
            raise EntriesParseError(f"{race_date} {venue}: unreadable race link {label!r}")
        links.append(matched.groupdict())
    if len(links) != width:
        raise EntriesParseError(
            f"{race_date} {venue}: {len(links)} race links for {width} columns"
        )

    races = []
    for index, link in enumerate(links):
        distance = by_label["途程"][index].replace("米", "").strip()
        rating = by_label["評分幅度"][index].strip("() ").replace(" ", "")
        link_rating = re.sub(r"\s+", "", link["rating"])
        track = by_label["賽道"][index]
        if distance != link["distance"] or rating != link_rating:
            raise EntriesParseError(
                f"{race_date} {venue}: column {index + 1} does not match {link['name']}"
            )
        if track not in ("草地", "全天候"):
            raise EntriesParseError(f"{race_date} {venue}: race {index + 1} track {track!r}")
        try:
            distance_m = int(distance)
        except ValueError as exc:
            raise EntriesParseError(f"{race_date} {venue}: bad distance {distance}") from exc
        if not (800 <= distance_m <= 4000):
            raise EntriesParseError(f"{race_date} {venue}: distance {distance_m} out of range")
        races.append({
            "race_number": index + 1,
            "race_class": link["klass"],
            "distance": distance_m,
            "track": track,
            "rating_range": link_rating,
            "race_name": link["name"],
            "section_label": by_label["組別"][index],
        })

    digest = hashlib.sha256(html.encode("utf-8")).hexdigest()
    rows: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for row_html in re.findall(r"<tr[\s\S]*?</tr>", tbody.group(1), flags=re.I):
        cells = _cells(row_html)
        if len(cells) != width + 1:
            raise EntriesParseError(
                f"{race_date} {venue}: trainer row has {len(cells)} cells, expected {width + 1}"
            )
        trainer = _text(cells[0])
        if not trainer:
            raise EntriesParseError(f"{race_date} {venue}: horse row without a trainer")
        for index, cell in enumerate(cells[1:]):
            for horse_html in re.findall(r"<a\b[^>]*horseid=[^>]*>[\s\S]*?</a>", cell, flags=re.I):
                code_m = HORSE_ID.search(horse_html)
                name = _text(horse_html)
                if not code_m or not name:
                    raise EntriesParseError(f"{race_date} {venue}: horse cell missing code or name")
                code = code_m.group(1).upper()
                key = (index + 1, code)
                if key in seen:
                    raise EntriesParseError(f"{race_date} {venue}: duplicate {code} in race {index + 1}")
                seen.add(key)
                race = races[index]
                rows.append({
                    "race_date": race_date,
                    "venue": venue,
                    "race_number": race["race_number"],
                    "horse_code": code,
                    "horse_name": name,
                    "trainer_name": trainer,
                    "race_class": race["race_class"],
                    "distance": race["distance"],
                    "track": race["track"],
                    "rating_range": race["rating_range"],
                    "race_name": race["race_name"],
                    "section_label": race["section_label"],
                    "card_stage": "entries",
                    "draw_status": "unavailable",
                    "source_sha256": digest,
                    "scraped_at": scraped_at,
                })
    if not rows:
        raise EntriesParseError(f"{race_date} {venue}: dated entries table has no horses")
    # The requested date must be the one we were asked for, not a rewritten want.
    if want.strftime("%Y-%m-%d") != race_date:
        raise EntriesParseError("internal date mismatch")
    return rows


def fetch_entries(race_date: str, venue: str, timeout: int = 40) -> str:
    slash = race_date.replace("-", "/")
    url = ENTRIES_URL.format(slash=slash, venue=venue)
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; tianxi-racing/1.0)"})
    with urlopen(request, timeout=timeout) as response:
        if getattr(response, "status", 200) != 200:
            raise EntriesParseError(f"HTTP {response.status} for {race_date} {venue}")
        return response.read().decode("utf-8", "replace")


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    tmp.replace(path)


def read_official_csvs(csv_dir: Path) -> list[dict]:
    rows: list[dict] = []
    if not csv_dir.is_dir():
        return rows
    for path in sorted(csv_dir.glob("entries_*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                if row.get("card_stage") != "entries" or row.get("draw_status") != "unavailable":
                    raise EntriesParseError(f"{path.name} is not an entries-only list")
                datetime.strptime(row.get("race_date") or "", "%Y-%m-%d")
                if (row.get("venue") or "").upper() not in ("ST", "HV"):
                    raise EntriesParseError(f"{path.name} venue is not ST/HV")
                if not row.get("horse_code") or not row.get("horse_name"):
                    raise EntriesParseError(f"{path.name} row missing horse identity")
                rows.append(row)
    return rows


def sql_literal(value) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, int):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def emit_replace_sql(rows: list[dict]) -> str:
    """Replace each parsed meeting. Dates absent from `rows` are left untouched."""
    if not rows:
        return ""
    meetings: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        key = (row["race_date"], row["venue"])
        meetings.setdefault(key, []).append(row)
    lines = [
        "-- official entries lists; card_stage stays entries; barrier draw is not invented",
    ]
    int_fields = {"race_number", "distance"}
    for (race_date, venue), group in sorted(meetings.items()):
        if venue not in ("ST", "HV"):
            raise EntriesParseError(f"refuse SQL for venue {venue}")
        datetime.strptime(race_date, "%Y-%m-%d")
        lines.append(
            "DELETE FROM official_race_entries "
            f"WHERE race_date = {sql_literal(race_date)} AND venue = {sql_literal(venue)};"
        )
        for row in group:
            values = []
            for field in FIELDS:
                raw = row.get(field)
                if field in int_fields:
                    values.append(str(int(raw)))
                else:
                    values.append(sql_literal(raw))
            lines.append(
                "INSERT INTO official_race_entries (" + ", ".join(FIELDS) + ") VALUES ("
                + ", ".join(values) + ");"
            )
    return "\n".join(lines) + "\n"


def scrape_horizon(horizon_days: int) -> int:
    scraped_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    targets = fixture_targets(horizon_days)
    if not targets:
        print(f"[entries] no official fixtures in the next {horizon_days} days")
        return 0
    written = 0
    for race_date, venue in targets:
        print(f"[entries] fetch {race_date} {venue}")
        try:
            html = fetch_entries(race_date, venue)
        except EntriesParseError:
            raise
        except Exception as exc:
            raise EntriesParseError(f"{race_date} {venue}: fetch failed: {exc}") from exc
        rows = parse_entries_html(html, race_date, venue, scraped_at)
        path = OUT_DIR / f"entries_{race_date}_{venue}.csv"
        if not rows:
            print(f"[entries] {race_date} {venue}: not published; leaving {path.name} unchanged")
            continue
        write_rows(path, rows)
        races = len({row["race_number"] for row in rows})
        print(f"[entries] {race_date} {venue}: {races} races, {len(rows)} horses, draw unavailable")
        written += 1
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="HKJC official entries lists")
    parser.add_argument("--horizon-days", type=int, default=14)
    parser.add_argument("--csv-dir", default="")
    parser.add_argument("--emit-sql", default="")
    args = parser.parse_args(argv)
    if args.emit_sql:
        csv_dir = Path(args.csv_dir) if args.csv_dir else OUT_DIR
        rows = read_official_csvs(csv_dir)
        sql = emit_replace_sql(rows)
        Path(args.emit_sql).write_text(sql, encoding="utf-8")
        print(f"[entries] sql rows={len(rows)} -> {args.emit_sql}")
        return 0
    try:
        scrape_horizon(args.horizon_days)
    except EntriesParseError as exc:
        print(f"[entries] FAIL {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
