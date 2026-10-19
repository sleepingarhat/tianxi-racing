"""
Trainer Data Scraper (requests-based, 2026-05-02 rewrite)

HKJC redesigned trainer pages as Next.js SPA. The ranking page is
client-side rendered; however the trainerpastrec page is server-side
rendered and works fine with plain HTTP GET.

Strategy:
  1. Load trainer codes from trainers/trainer_profiles.csv
  2. For each trainer scrape Current + Previous season records from
     https://racing.hkjc.com/zh-hk/local/information/trainerpastrec?trainerid={CODE}&season={SEASON}
  3. Parse the HTML table (BeautifulSoup) — date-header rows interleaved
  4. Save to trainers/records/trainer_{CODE}.csv

Output:
  trainers/records/trainer_{CODE}.csv  — full past race records per trainer
"""

import os, re, time
import requests
from bs4 import BeautifulSoup
import pandas as pd
from scraper_utils import log_failed

PROFILES_FILE = os.path.join("trainers", "trainer_profiles.csv")
RECORDS_DIR   = os.path.join("trainers", "records")
FAILED_LOG    = "failed_trainers.log"
SEASONS       = ["Current", "Previous"]

PASTREC_URL = (
    "https://racing.hkjc.com/zh-hk/local/information/trainerpastrec"
    "?trainerid={code}&season={season}"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-HK,zh;q=0.9,en;q=0.8",
    "Referer": "https://racing.hkjc.com/",
}

os.makedirs(RECORDS_DIR, exist_ok=True)

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

RECORD_COLS = [
    "trainer_code", "season",
    "date", "venue",
    "race_index",
    "horse_name",
    "place", "total_starters",
    "track", "course",
    "distance_m", "going",
    "draw", "rating", "win_odds",
    "jockey", "gear",
    "horse_weight_lbs", "actual_wt_lbs",
    "top1", "top2", "top3",
]


def _parse_records(html, trainer_code, season):
    """Parse the HTML for one trainer/season into list of record dicts."""
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")

    rec_table = None
    for t in tables:
        rows = t.find_all("tr")
        if len(rows) > 5:
            header_text = rows[0].get_text()
            if "場" in header_text or "馬匹" in header_text:
                rec_table = t
                break

    if rec_table is None:
        return []

    records = []
    current_date = ""
    current_venue = ""
    rows = rec_table.find_all("tr")

    for row in rows[1:]:  # skip header
        cells = row.find_all("td")
        if not cells:
            continue

        # Date/venue header row (merged cell)
        if len(cells) <= 2:
            raw = cells[0].get_text(separator=" ", strip=True)
            m = re.match(r"(\d{2}/\d{2}/\d{4})\s+(.+?)(?:\s+練馬師|$)", raw)
            if m:
                current_date = m.group(1)
                current_venue = m.group(2).strip()
            elif re.match(r"\d{2}/\d{2}/\d{4}", raw):
                parts = raw.split(None, 1)
                current_date = parts[0]
                current_venue = parts[1].strip() if len(parts) > 1 else ""
            continue

        if len(cells) < 10:
            continue

        def cell(i):
            try:
                return cells[i].get_text(strip=True)
            except Exception:
                return ""

        race_idx = cell(0)
        if not race_idx.isdigit():
            continue

        placing_raw = cell(2)
        place = ""
        total = ""
        if "/" in placing_raw:
            p, t2 = placing_raw.split("/", 1)
            place = p.strip()
            total = t2.strip()
        else:
            place = placing_raw

        track_raw = cell(3)
        course_m = re.search(r'"([^"]+)"', track_raw)
        course_str = course_m.group(1) if course_m else ""
        track_str = re.sub(r'"[^"]*"', "", track_raw).strip()

        top_raw = [cell(13), cell(14), cell(15)] if len(cells) >= 16 else ["", "", ""]

        records.append({
            "trainer_code":     trainer_code,
            "season":           season,
            "date":             current_date,
            "venue":            current_venue,
            "race_index":       race_idx,
            "horse_name":       cell(1),
            "place":            place,
            "total_starters":   total,
            "track":            track_str,
            "course":           course_str,
            "distance_m":       cell(4),
            "going":            cell(5),
            "draw":             cell(6),
            "rating":           cell(7),
            "win_odds":         cell(8),
            "jockey":           cell(9),
            "gear":             cell(10),
            "horse_weight_lbs": cell(11),
            "actual_wt_lbs":    cell(12),
            "top1":             top_raw[0],
            "top2":             top_raw[1],
            "top3":             top_raw[2],
        })

    return records


def merge_verified_records(existing, fresh):
    """Refresh adds evidence; never replace a previously saved historical row."""
    import pandas as pd
    return pd.concat([existing, fresh], ignore_index=True).drop_duplicates(
        subset=['trainer_code', 'date', 'race_index', 'horse_name'], keep='first')


# ── 1. Load trainer codes ─────────────────────────────────────────────────────

trainer_map = {}  # code -> name
if os.path.exists(PROFILES_FILE):
    try:
        df_prof = pd.read_csv(PROFILES_FILE, encoding="utf-8-sig")
        for _, row in df_prof.iterrows():
            code = str(row.get("trainer_code", "")).strip()
            name = str(row.get("trainer_name", "")).strip()
            if code:
                trainer_map[code] = name
        print(f"Loaded {len(trainer_map)} trainer codes from profiles CSV")
    except Exception as e:
        print(f"Warning: could not load profiles CSV: {e}")

if not trainer_map:
    print("No trainer codes found — exiting")
    raise SystemExit(0)

# Existing files are not proof that the latest official records were collected.
todo = list(trainer_map)
print(f"Refreshing {len(todo)} known trainers; existing records remain on failed reads")

if not todo:
    print("All trainers already scraped.")
    raise SystemExit(0)

# ── 2. Scrape ─────────────────────────────────────────────────────────────────

for i, code in enumerate(todo, 1):
    name = trainer_map.get(code, code)
    print(f"\n[{i}/{len(todo)}] Trainer: {name} ({code})")
    out_file = os.path.join(RECORDS_DIR, f"trainer_{code}.csv")

    all_records = []

    for season in SEASONS:
        url = PASTREC_URL.format(code=code, season=season)
        try:
            resp = SESSION.get(url, timeout=20)
            resp.raise_for_status()
        except Exception as e:
            print(f"  Fetch error ({season}): {e}")
            log_failed(FAILED_LOG, code, f"fetch {season}: {e}")
            continue

        if not name or name == code or name not in BeautifulSoup(resp.text, 'html.parser').get_text():
            log_failed(FAILED_LOG, code, f"identity unavailable {season}; preserving existing records")
            continue
        recs = _parse_records(resp.text, code, season)
        print(f"  {season}: {len(recs)} records")
        all_records.extend(recs)
        time.sleep(0.4)

    if all_records:
        fresh = pd.DataFrame(all_records)
        if os.path.exists(out_file):
            existing = pd.read_csv(out_file, encoding='utf-8-sig', dtype=str).fillna('')
            fresh = merge_verified_records(existing, fresh)
        fresh.to_csv(out_file, index=False, encoding="utf-8-sig")
        print(f"  Saved {len(all_records)} total records")
    else:
        print(f"  No verified records found; existing file untouched, no empty file created")

print("\nTrainer data scraping complete!")
