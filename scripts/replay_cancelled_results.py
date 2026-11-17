#!/usr/bin/env python3
"""Replay one official cancelled race into a results CSV.

Default is a dry-run against repo data: print the row and whether it is
already stored. --write updates the CSV only. It does not call D1, GitHub
Actions, or the prediction engine.

After merge, dispatch (do not run from this script):

  gh workflow run "Capy D1 Sync — push new race day to Cloudflare D1" -f date=2026-11-14

That workflow reads data/<year>/results_<date>.csv and pushes the delta.
"""
import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from results_cancellation import OFFICIAL_RACE_CANCELLED, cancelled_result_row, is_void_result_row  # noqa: E402

# Minimal page with the 2026-11-14 ST race 6 facts: correct date heading is
# checked by the scraper separately; this text is what the cancellation parser
# sees. No 第 N 場 header, single-race pools say 退款.
RACE6_PAGE = (
    "賽事日期: 14/11/2026 沙田\n"
    "此場賽事宣佈取消。根據賽馬博彩規例，若此賽事設有單場彩池，有關注項將予以退款。\n"
    "獨贏 - 退款\n位置 - 退款\n連贏 - 退款\n位置Q - 退款\n"
)


def race6_row():
    row = cancelled_result_row(RACE6_PAGE, 6, "2026-11-14", "沙田")
    if not row or row["official_message"] != OFFICIAL_RACE_CANCELLED:
        raise SystemExit("official cancellation phrase did not parse")
    return row


def load(path: Path):
    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(text.splitlines()))
    return rows


def already(rows, race_no: str) -> bool:
    return any(is_void_result_row(row) and str(row.get("race_no")) == race_no for row in rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default="2026-11-14")
    parser.add_argument("--csv", default="")
    parser.add_argument("--write", action="store_true", help="update the CSV; default is dry-run")
    args = parser.parse_args()
    if args.date != "2026-11-14":
        raise SystemExit("this replay only knows the 2026-11-14 ST race 6 official page")
    path = Path(args.csv) if args.csv else ROOT / "data" / "2026" / f"results_{args.date}.csv"
    row = race6_row()
    rows = load(path)
    present = already(rows, "6")
    print(f"dry-run={not args.write} path={path} race=6 void_present={present}")
    print(row["official_message"])
    if present or not args.write:
        return
    # Append only. Existing runner rows stay byte-for-byte; extra header fields
    # read back as empty on the older lines.
    text = path.read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    header = lines[0].split(",")
    for key in row:
        if key not in header:
            header.append(key)
    lines[0] = ",".join(header)
    values = []
    for key in header:
        value = row.get(key, "") or ""
        if any(ch in value for ch in ",\"\n"):
            value = '"' + value.replace('"', '""') + '"'
        values.append(value)
    lines.append(",".join(values))
    path.write_text("\ufeff" + "\n".join(lines) + "\n", encoding="utf-8")
    print("wrote cancelled race 6")


if __name__ == "__main__":
    main()
