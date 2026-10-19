"""
Jockey Data Scraper
Scrapes all jockey profiles and full past race records from HKJC.

Steps:
  1. Load the Jockey Ranking page to get all jockey name→code mappings
  2. For each jockey, scrape profile stats and full past records (all seasons)

Output:
  jockeys/jockey_profiles.csv           — one row per jockey (stats summary)
  jockeys/records/jockey_CODE.csv       — full past race records per jockey

Record columns (from jockeypastrec page):
  Race Index | Placing | Track/Course | Dist | Race Class | Going |
  Horse | Draw | Rtg | Trainer | Gear | Body Wt | Act Wt
"""

import os, re, time
import pandas as pd
from selenium.webdriver.common.by import By
from scraper_utils import make_driver, load_page, safe_cell, log_failed, parse_zh_location

PROFILES_DIR = "jockeys"
RECORDS_DIR  = os.path.join("jockeys", "records")
FAILED_LOG   = "failed_jockeys.log"

RANKING_URL = "https://racing.hkjc.com/racing/information/Chinese/Jockey/JockeyRanking.aspx"
PROFILE_URL = "https://racing.hkjc.com/zh-hk/local/information/jockeypastrec?jockeyid={code}&season={season}"
SEASONS     = ["Current", "Previous"]

os.makedirs(PROFILES_DIR, exist_ok=True)
os.makedirs(RECORDS_DIR, exist_ok=True)

RECORD_COLS = [
    "jockey_code", "jockey_name", "season",
    "race_index", "place", "total_starters",
    "track", "course", "distance_m", "race_class",
    "going", "horse_name", "draw", "rating",
    "trainer", "gear", "body_wt_lbs", "actual_wt_lbs"
]

# ── 1. Get all jockey codes ──────────────────────────────────────────────────

driver = make_driver()
print("Loading jockey ranking page...")
if not load_page(driver, RANKING_URL):
    print("Failed to load jockey ranking page.")
    driver.quit()
    exit(1)

time.sleep(2)
jockeys = {}  # code -> name

def extract_jockeys_from_page(driver, jockeys):
    links = driver.find_elements(
        By.XPATH,
        "//table//a[contains(@href,'jockeypastrec') or contains(@href,'jockeyprofile')]"
    )
    for l in links:
        href = l.get_attribute("href") or ""
        m = re.search(r"jockeyid=([A-Z]+)", href, re.IGNORECASE)
        if m:
            code = m.group(1).upper()
            name = l.text.strip()
            if name and code not in jockeys:
                jockeys[code] = name

extract_jockeys_from_page(driver, jockeys)

# Try to load previous season too (Chinese: 上季資料)
try:
    prev_btn = driver.find_element(By.XPATH, "//a[contains(text(),'上季資料') or contains(text(),'Previous Season')]")
    prev_btn.click()
    time.sleep(2)
    extract_jockeys_from_page(driver, jockeys)
except Exception:
    pass

print(f"Found {len(jockeys)} jockeys: {list(jockeys.items())[:5]}...")

# ── 2. Determine what still needs scraping ───────────────────────────────────

def needs_records_retry(code, known_profiles, records_file):
    from pathlib import Path
    path = Path(records_file)
    return code not in known_profiles or not path.exists() or path.stat().st_size < 250

profiles_file = os.path.join(PROFILES_DIR, "jockey_profiles.csv")
done = set()
if os.path.exists(profiles_file):
    try:
        existing_profiles = pd.read_csv(profiles_file, encoding="utf-8-sig").fillna('')
        done = set(existing_profiles["jockey_code"].astype(str))
        for _, row in existing_profiles.iterrows():
            code = str(row.get('jockey_code', '')).strip()
            name = str(row.get('jockey_name', '')).strip()
            if code and name:
                jockeys.setdefault(code, name)
    except Exception:
        pass

todo = [c for c in jockeys if needs_records_retry(c, done, os.path.join(RECORDS_DIR, f'jockey_{c}.csv'))]
print(f"Already done: {len(done)} | Remaining: {len(todo)}")

# ── 3. Scrape ────────────────────────────────────────────────────────────────

all_profiles = []

for i, code in enumerate(todo, 1):
    name = jockeys[code]
    print(f"\n[{i}/{len(todo)}] Jockey: {name} ({code})")
    records_file = os.path.join(RECORDS_DIR, f"jockey_{code}.csv")

    all_records = []
    profile = {"jockey_code": code, "jockey_name": name}

    for season in SEASONS:
        url = PROFILE_URL.format(code=code, season=season)
        if not load_page(driver, url):
            log_failed(FAILED_LOG, code, f"load failed season={season}")
            continue
        time.sleep(1)

        if not name or name not in driver.find_element(By.TAG_NAME, 'body').text:
            log_failed(FAILED_LOG, code, f'identity unavailable season={season}; checking next season')
            continue

        tables = driver.find_elements(By.TAG_NAME, "table")
        if not tables:
            continue

        # ── Stats table (Table 0) ─────────────────────────────────────────
        try:
            for row in tables[0].find_elements(By.TAG_NAME, "tr"):
                text = row.text.strip()
                # Lines like "Nationality : AUS  No. of Wins : 96"
                for chunk in re.split(r"\s{2,}", text):
                    if ":" in chunk:
                        parts = chunk.split(":", 1)
                        key = parts[0].strip().lower().replace(" ", "_").replace(".", "").replace("#", "no").replace("/", "_")
                        val = parts[1].strip()
                        profile[f"{season.lower()}_{key}"] = val
        except Exception as e:
            print(f"  Warning stats: {e}")

        # ── Records table (Table 1) ───────────────────────────────────────
        # Columns: Race Index | Placing | Track/Course | Dist | Class | Going |
        #          Horse | Draw | Rtg | Trainer | Gear | Body Wt | Act Wt
        try:
            if len(tables) < 2:
                continue

            rows = tables[1].find_elements(By.TAG_NAME, "tr")
            current_date = ""
            current_venue = ""

            for row in rows:
                cells = row.find_elements(By.TAG_NAME, "td")
                if not cells:
                    continue

                first = cells[0].text.strip()

                # Date/venue banner row (has colspan, few cells, contains date)
                if len(cells) <= 3 and re.search(r"\d{2}/\d{2}/\d{4}", first):
                    m = re.match(r"(\d{2}/\d{2}/\d{4})\s+(.*)", first)
                    if m:
                        current_date = m.group(1)
                        current_venue = m.group(2).split("\n")[0].strip()
                    continue

                # Valid race record rows: first cell is a digit (race index)
                if not first.isdigit():
                    continue
                if len(cells) < 10:
                    continue

                # Placing: "6/12"
                placing_raw = safe_cell(cells, 1)
                if "/" in placing_raw:
                    p_parts = placing_raw.split("/", 1)
                    place = p_parts[0].strip()
                    total = p_parts[1].strip()
                else:
                    place, total = placing_raw, ""

                # Track/Course: Chinese format e.g. '草地"C"'
                _, track, course = parse_zh_location(safe_cell(cells, 2))

                all_records.append({
                    "jockey_code":    code,
                    "jockey_name":    name,
                    "season":         season,
                    "date":           current_date,
                    "venue":          current_venue,
                    "race_index":     first,
                    "place":          place,
                    "total_starters": total,
                    "track":          track,
                    "course":         course,
                    "distance_m":     safe_cell(cells, 3),
                    "race_class":     safe_cell(cells, 4),
                    "going":          safe_cell(cells, 5),
                    "horse_name":     safe_cell(cells, 6),
                    "draw":           safe_cell(cells, 7),
                    "rating":         safe_cell(cells, 8),
                    "trainer":        safe_cell(cells, 9),
                    "gear":           safe_cell(cells, 10),
                    "body_wt_lbs":    safe_cell(cells, 11),
                    "actual_wt_lbs":  safe_cell(cells, 12),
                })
        except Exception as e:
            print(f"  Warning records (season={season}): {e}")

    if all_records:
        all_profiles.append(profile)
    print(f"  {name}: {len(all_records)} race records across seasons")

    if all_records:
        full_cols = RECORD_COLS + ["date", "venue"]
        save_df = pd.DataFrame(all_records)
        for col in full_cols:
            if col not in save_df.columns:
                save_df[col] = ""
        if os.path.exists(records_file):
            existing_records = pd.read_csv(records_file, encoding='utf-8-sig', dtype=str).fillna('')
            save_df = pd.concat([existing_records, save_df], ignore_index=True).drop_duplicates(subset=['jockey_code', 'date', 'race_index', 'horse_name'], keep='first')
        save_df.to_csv(records_file, index=False, encoding="utf-8-sig")

    if i % 10 == 0 and all_profiles:
        df = pd.DataFrame(all_profiles)
        if os.path.exists(profiles_file):
            existing = pd.read_csv(profiles_file, encoding="utf-8-sig")
            df = pd.concat([existing, df], ignore_index=True).drop_duplicates(subset="jockey_code")
        df.to_csv(profiles_file, index=False, encoding="utf-8-sig")
        all_profiles = []
        print("  [Checkpoint] Profiles saved.")

if all_profiles:
    df = pd.DataFrame(all_profiles)
    if os.path.exists(profiles_file):
        existing = pd.read_csv(profiles_file, encoding="utf-8-sig")
        df = pd.concat([existing, df], ignore_index=True).drop_duplicates(subset="jockey_code")
    df.to_csv(profiles_file, index=False, encoding="utf-8-sig")

driver.quit()
print("\nJockey data scraping complete!")
