#!/usr/bin/env python3
"""Parse HKJC 更易事項 into structured rows and entry updates.

The public board is server-rendered HTML at
https://racing.hkjc.com/zh-hk/local/information/changes
(the /info/changes menu path is a shell; this page is the same table).

Snapshots under data/racing-changes/ stay append-only. changes.csv is a
projection of the latest snapshot per meeting. Overseas simulcast blocks
are ignored. A requested date or venue that the page does not show is not
written. A non-dash cell that does not match a known clause fails the job
after the raw snapshot is kept.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

SOURCE_URL = "https://racing.hkjc.com/zh-hk/local/information/changes"
VENUE_CODE = {"沙田": "ST", "跑馬地": "HV"}
CSV_COLUMNS = [
    "race_date", "venue", "race_number", "horse_number", "horse_name",
    "change_type", "before_value", "after_value", "announced_at", "raw_text",
    "source_sha256", "snapshot_path",
]
BLOCK_RE = re.compile(
    r'class="margin_top10 f_fs13 font_wb">(.*?)</div>\s*<div class="margin_top10">\s*<table class="change_detail">(.*?)</table>',
    re.S | re.I,
)
ROW_RE = re.compile(
    r'<td class="f_tac">\s*第\s*(\d+)\s*場\s*</td>\s*<td[^>]*>(.*?)</td>',
    re.S | re.I,
)
ANNOUNCED = r'(?:\s*\((\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2})\))?'
SCRATCH_RE = re.compile(
    rf'^(\d+)\s*號馬\s*(\S+?)\s*退出競賽(?:\s*[,，]\s*由後備馬\s*(\S+?)\s*補上)?\s*。?{ANNOUNCED}\s*$'
)
JOCKEY_BY_RE = re.compile(rf'^(\d+)\s*號馬\s*(\S+?)\s*由騎師\s*(\S+?)\s*策騎\s*。?{ANNOUNCED}\s*$')
JOCKEY_CHG_RE = re.compile(rf'^(\d+)\s*號馬\s*(\S+?)\s*(?:的)?騎師由\s*(\S+?)\s*改為\s*(\S+?)\s*。?{ANNOUNCED}\s*$')
WEIGHT_SET_RE = re.compile(rf'^(\d+)\s*號馬\s*(\S+?)\s*將負\s*(\d+)\s*磅\s*。?{ANNOUNCED}\s*$')
WEIGHT_CHG_RE = re.compile(
    rf'^(\d+)\s*號馬\s*(\S+?)\s*(?:的)?負磅由\s*(\d+)\s*磅?\s*改為\s*(\d+)\s*磅?\s*。?{ANNOUNCED}\s*$'
)
GEAR_CHG_RE = re.compile(rf'^(\d+)\s*號馬\s*(\S+?)\s*(?:的)?配備由\s*(\S+?)\s*改為\s*(\S+?)\s*。?{ANNOUNCED}\s*$')
DRAW_CHG_RE = re.compile(rf'^(\d+)\s*號馬\s*(\S+?)\s*(?:的)?檔位由\s*(\d+)\s*改為\s*(\d+)\s*。?{ANNOUNCED}\s*$')

# Scratch updates the card only while the race is still before the lock
# (first post time minus 90 minutes). Jockey and weight corrections are the
# official runner record and are applied whenever the horse identity matches.
PRELOCK_SQL = (
    "EXISTS (SELECT 1 FROM entries_upcoming p "
    "WHERE p.race_date = entries_upcoming.race_date AND p.venue = entries_upcoming.venue "
    "AND p.race_number = entries_upcoming.race_number AND p.post_time IS NOT NULL "
    "AND p.post_time > strftime('%Y-%m-%dT%H:%M:%S+08:00', 'now', '+8 hours', '+90 minutes'))"
)


class IdentityError(ValueError):
    """Page date or venue does not match. Do not stamp the request onto the page."""


class ParseMiss(ValueError):
    """A visible change clause did not match a known pattern."""


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def html_text(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'")
    return re.sub(r"\s+", " ", text).strip()


def clauses(cell_html: str) -> list[str]:
    parts = re.split(r"<br\s*/?>", cell_html, flags=re.I)
    out = []
    for part in parts:
        text = html_text(part)
        if text in ("", "--", "-", "—"):
            continue
        out.append(text)
    return out


def _event(race_number, horse_number, horse_name, change_type, before, after, announced, raw) -> dict:
    return {
        "race_number": int(race_number),
        "horse_number": int(horse_number) if horse_number not in (None, "") else None,
        "horse_name": horse_name or "",
        "change_type": change_type,
        "before_value": before or "",
        "after_value": after or "",
        "announced_at": announced or "",
        "raw_text": raw,
    }


def parse_clause(race_number: int, raw: str) -> list[dict]:
    scratch = SCRATCH_RE.match(raw)
    if scratch:
        events = [_event(race_number, scratch.group(1), scratch.group(2), "scratch", scratch.group(2), "退出", scratch.group(4), raw)]
        if scratch.group(3):
            events.append(_event(race_number, scratch.group(1), scratch.group(3), "reserve", scratch.group(2), scratch.group(3), scratch.group(4), raw))
        return events
    jockey_chg = JOCKEY_CHG_RE.match(raw)
    if jockey_chg:
        return [_event(race_number, jockey_chg.group(1), jockey_chg.group(2), "jockey", jockey_chg.group(3), jockey_chg.group(4), jockey_chg.group(5), raw)]
    jockey = JOCKEY_BY_RE.match(raw)
    if jockey:
        return [_event(race_number, jockey.group(1), jockey.group(2), "jockey", "", jockey.group(3), jockey.group(4), raw)]
    weight_chg = WEIGHT_CHG_RE.match(raw)
    if weight_chg:
        return [_event(race_number, weight_chg.group(1), weight_chg.group(2), "weight", weight_chg.group(3), weight_chg.group(4), weight_chg.group(5), raw)]
    weight = WEIGHT_SET_RE.match(raw)
    if weight:
        return [_event(race_number, weight.group(1), weight.group(2), "weight", "", weight.group(3), weight.group(4), raw)]
    gear = GEAR_CHG_RE.match(raw)
    if gear:
        return [_event(race_number, gear.group(1), gear.group(2), "gear", gear.group(3), gear.group(4), gear.group(5), raw)]
    draw = DRAW_CHG_RE.match(raw)
    if draw:
        return [_event(race_number, draw.group(1), draw.group(2), "draw", draw.group(3), draw.group(4), draw.group(5), raw)]
    return [_event(race_number, None, "", "unparsed", "", "", "", raw)]


def parse_changes_html(html: str) -> list[dict]:
    """Return local meetings only. Overseas blocks are skipped, not relabelled."""
    if "更易事項" not in html and "change_detail" not in html:
        raise IdentityError("page is not the official changes board")
    meetings = []
    blocks = BLOCK_RE.findall(html)
    if not blocks:
        raise IdentityError("changes page has no dated board")
    for heading_html, table_html in blocks:
        heading = html_text(heading_html)
        if "海外" in heading:
            continue
        match = re.match(r"^(\d{2})/(\d{2})/(\d{4})\s+(沙田|跑馬地)$", heading)
        if not match:
            raise IdentityError(f"unreadable changes heading: {heading}")
        day, month, year, venue_name = match.groups()
        race_date = f"{year}-{month}-{day}"
        venue = VENUE_CODE[venue_name]
        rows = ROW_RE.findall(table_html)
        if not rows:
            raise ParseMiss(f"{race_date} {venue} changes table has no race rows")
        events = []
        for race_no, cell in rows:
            race_number = int(race_no)
            if not 1 <= race_number <= 14:
                raise IdentityError(f"race number out of range: {race_number}")
            for raw in clauses(cell):
                events.extend(parse_clause(race_number, raw))
        meetings.append({"date": race_date, "venue": venue, "events": events})
    if not meetings:
        raise IdentityError("changes page has no local ST/HV board")
    return meetings


def select_meetings(meetings: list[dict], race_date: str = "", venue: str = "") -> list[dict]:
    if not race_date and not venue:
        return meetings
    chosen = [
        meeting for meeting in meetings
        if (not race_date or meeting["date"] == race_date)
        and (not venue or meeting["venue"] == venue)
    ]
    if not chosen:
        shown = [(meeting["date"], meeting["venue"]) for meeting in meetings]
        raise IdentityError(f"page shows {shown}, not {race_date or '*'} {venue or '*'}")
    return chosen


def event_id(race_date: str, venue: str, event: dict) -> str:
    blob = "|".join([
        race_date, venue, str(event["race_number"]), str(event["horse_number"] or ""),
        event["change_type"], event["raw_text"], event["announced_at"],
    ])
    return hashlib.sha256(blob.encode()).hexdigest()


def sql_literal(value) -> str:
    if value is None or value == "":
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def name_match_sql(horse_name: str) -> str:
    name = sql_literal(horse_name)
    return (
        "EXISTS (SELECT 1 FROM horses h WHERE h.name_ch = "
        + name
        + " AND (h.code = entries_upcoming.horse_code "
        "OR h.id = entries_upcoming.horse_id "
        "OR h.id = 'horse_' || COALESCE(entries_upcoming.horse_code, '') "
        "OR h.id = 'horse_' || COALESCE(entries_upcoming.horse_id, '')))"
    )


def entry_update_sql(race_date: str, venue: str, event: dict) -> str | None:
    """Write back only when horse number and Chinese name both match. Reserve lines stay raw."""
    if event["change_type"] in ("unparsed", "reserve"):
        return None
    if not event["horse_number"] or not event["horse_name"] or not event["after_value"]:
        return None
    where = (
        f"race_date = {sql_literal(race_date)} AND venue = {sql_literal(venue)} "
        f"AND race_number = {int(event['race_number'])} AND horse_number = {int(event['horse_number'])} "
        f"AND {name_match_sql(event['horse_name'])}"
    )
    kind = event["change_type"]
    before = event["before_value"]
    after = event["after_value"]
    if kind == "scratch":
        return (
            "UPDATE entries_upcoming SET priority_order = '退出' WHERE "
            + where
            + " AND (priority_order IS NULL OR priority_order = '' OR priority_order = '正選') AND "
            + PRELOCK_SQL
            + ";"
        )
    if kind == "jockey":
        guard = ""
        if before:
            guard = (
                f" AND (jockey_name IS NULL OR jockey_name = '' OR jockey_name = {sql_literal(before)} "
                f"OR jockey_name = {sql_literal(after)})"
            )
        return f"UPDATE entries_upcoming SET jockey_name = {sql_literal(after)} WHERE {where}{guard};"
    if kind == "weight":
        if not str(after).isdigit():
            return None
        guard = ""
        if before:
            guard = (
                f" AND (actual_weight IS NULL OR actual_weight = {int(before)} OR actual_weight = {int(after)})"
            )
        return f"UPDATE entries_upcoming SET actual_weight = {int(after)} WHERE {where}{guard};"
    if kind == "gear":
        guard = ""
        if before:
            guard = f" AND (gear IS NULL OR gear = '' OR gear = {sql_literal(before)} OR gear = {sql_literal(after)})"
        return f"UPDATE entries_upcoming SET gear = {sql_literal(after)} WHERE {where}{guard};"
    if kind == "draw":
        if not str(after).isdigit():
            return None
        guard = ""
        if before:
            guard = f" AND (draw IS NULL OR draw = {int(before)} OR draw = {int(after)})"
        return f"UPDATE entries_upcoming SET draw = {int(after)} WHERE {where}{guard};"
    return None


def projection_sql(rows: list[dict], captured_at: str) -> str:
    statements = []
    meetings = {(row["race_date"], row["venue"]) for row in rows}
    for race_date, venue in sorted(meetings):
        statements.append(
            f"DELETE FROM racing_changes WHERE race_date = {sql_literal(race_date)} AND venue = {sql_literal(venue)};"
        )
    for row in rows:
        statements.append(
            "INSERT INTO racing_changes (id, race_date, venue, race_number, horse_number, horse_name, "
            "change_type, before_value, after_value, announced_at, raw_text, source_sha256, snapshot_path, captured_at) VALUES ("
            + ", ".join([
                sql_literal(event_id(row["race_date"], row["venue"], row)),
                sql_literal(row["race_date"]),
                sql_literal(row["venue"]),
                str(int(row["race_number"])),
                "NULL" if row["horse_number"] in ("", None) else str(int(row["horse_number"])),
                sql_literal(row["horse_name"]),
                sql_literal(row["change_type"]),
                sql_literal(row["before_value"]),
                sql_literal(row["after_value"]),
                sql_literal(row["announced_at"]),
                sql_literal(row["raw_text"]),
                sql_literal(row["source_sha256"]),
                sql_literal(row["snapshot_path"]),
                sql_literal(captured_at),
            ])
            + ");"
        )
        update = entry_update_sql(row["race_date"], row["venue"], row)
        if update:
            statements.append(update)
    return "\n".join(statements) + ("\n" if statements else "")


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {"snapshots": []}
    return json.loads(path.read_text(encoding="utf-8"))


def append_manifest(path: Path, entry: dict) -> bool:
    """Append one snapshot object. Existing entries stay byte-for-byte."""
    if not path.exists():
        path.write_text(json.dumps({"snapshots": [entry]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return True
    text = path.read_text(encoding="utf-8")
    if entry["path"] in text:
        return False
    idx = text.rfind("\n  ]")
    if idx < 0:
        raise RuntimeError("racing-changes manifest is not an append-only snapshots array")
    blob = json.dumps(entry, ensure_ascii=False, indent=2)
    indented = "\n".join(("    " + line) if line else line for line in blob.splitlines())
    path.write_text(text[:idx] + ",\n" + indented + text[idx:], encoding="utf-8")
    return True


def save_snapshot(root: Path, race_date: str, venue: str, raw: bytes) -> tuple[str, str, bool]:
    digest = sha256(raw)
    rel = f"data/racing-changes/{race_date}/{venue}-{digest}.html"
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(raw)
    added = append_manifest(root / "data/racing-changes/manifest.json", {
        "path": rel,
        "sha256": digest,
        "sourceUrl": SOURCE_URL,
        "date": race_date,
        "kind": "racing-changes",
        "venue": venue,
    })
    return rel, digest, added


def rows_from_meeting(meeting: dict, digest: str, snapshot_path: str) -> list[dict]:
    rows = []
    for event in meeting["events"]:
        rows.append({
            "race_date": meeting["date"],
            "venue": meeting["venue"],
            "race_number": event["race_number"],
            "horse_number": "" if event["horse_number"] is None else event["horse_number"],
            "horse_name": event["horse_name"],
            "change_type": event["change_type"],
            "before_value": event["before_value"],
            "after_value": event["after_value"],
            "announced_at": event["announced_at"],
            "raw_text": event["raw_text"],
            "source_sha256": digest,
            "snapshot_path": snapshot_path,
        })
    return rows


def project_snapshots(root: Path) -> list[dict]:
    manifest = load_manifest(root / "data/racing-changes/manifest.json")
    latest: dict[tuple[str, str], dict] = {}
    for snap in manifest.get("snapshots", []):
        latest[(snap["date"], snap["venue"])] = snap
    rows = []
    for snap in latest.values():
        html = (root / snap["path"]).read_text(encoding="utf-8", errors="replace")
        meetings = select_meetings(parse_changes_html(html), snap["date"], snap["venue"])
        for meeting in meetings:
            rows.extend(rows_from_meeting(meeting, snap["sha256"], snap["path"]))
    rows.sort(key=lambda row: (
        row["race_date"], row["venue"], int(row["race_number"]),
        int(row["horse_number"] or 0), row["change_type"], row["raw_text"],
    ))
    return rows


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def fetch_board() -> bytes:
    request = Request(SOURCE_URL, headers={
        "User-Agent": "Mozilla/5.0 (compatible; tianxi-racing/1.0)",
        "Accept-Language": "zh-HK,zh;q=0.9",
    })
    with urlopen(request, timeout=30) as response:
        return response.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--date", default="", help="Accept only this page date YYYY-MM-DD")
    parser.add_argument("--venue", default="", help="Accept only ST or HV")
    parser.add_argument("--html", default="", help="Parse this file instead of fetching")
    parser.add_argument("--rebuild-only", action="store_true", help="Rebuild changes.csv from snapshots")
    parser.add_argument("--sql-out", default="")
    args = parser.parse_args()
    root = Path(args.root)
    venue = args.venue.upper()
    if venue and venue not in ("ST", "HV"):
        print(f"[changes] invalid venue {args.venue}", file=sys.stderr)
        return 2

    if not args.rebuild_only:
        raw = Path(args.html).read_bytes() if args.html else fetch_board()
        try:
            meetings = select_meetings(parse_changes_html(raw.decode("utf-8", "replace")), args.date, venue)
        except (IdentityError, ParseMiss) as exc:
            print(f"[changes] refused: {exc}", file=sys.stderr)
            return 2
        for meeting in meetings:
            rel, digest, added = save_snapshot(root, meeting["date"], meeting["venue"], raw)
            print(f"[changes] snapshot {rel} {'added' if added else 'exists'}")

    try:
        rows = project_snapshots(root)
    except (IdentityError, ParseMiss) as exc:
        print(f"[changes] projection refused: {exc}", file=sys.stderr)
        return 2
    csv_path = root / "data/racing-changes/changes.csv"
    write_csv(csv_path, rows)
    misses = [row for row in rows if row["change_type"] == "unparsed"]
    print(f"[changes] {len(rows)} structured rows, {len(misses)} unparsed -> {csv_path}")
    if args.sql_out:
        captured = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        Path(args.sql_out).write_text(projection_sql(rows, captured), encoding="utf-8")
    if misses:
        print("[changes] visible clause left unparsed — failing closed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
