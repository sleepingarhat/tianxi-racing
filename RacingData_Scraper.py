"""
HKJC Race Data Scraper — Traditional Chinese.

Two modes:
  1. Backfill (default): parallel workers across historical year ranges.
  2. Daily (--daily):    scrape today's race date only, exit 0 fast if no meet.
                         Designed for GHA cron; honours fixture_guard if present.

CLI flags:
  --daily                     scrape today's HK date only
  --date YYYY-MM-DD[,...]     scrape one or more explicit dates (no workers)
  --backfill                  run the legacy multi-worker historical backfill (default
                              when no flags given, for backwards compat)

Captures per-race-day, per-race:
  1. Race results + metadata
  2. Dividends
  3. Sectional times per horse
  4. Running commentary per horse
  5. Video replay links
"""

import argparse
import pandas as pd
import os, re, time, sys, traceback
from datetime import date, datetime, timedelta, timezone
from multiprocessing import Process
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.chrome.service import Service as ChromeService

# Honor env overrides; fall back to Replit Nix paths, then common Linux/macOS
# locations so local contributors do not have to set env vars manually.
_DEFAULT_CHROMIUM = "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium"
_DEFAULT_CHROMEDRIVER = "/nix/store/8zj50jw4w0hby47167kqqsaqw4mm5bkd-chromedriver-unwrapped-138.0.7204.100/bin/chromedriver"

def _resolve_binary(env_key, default_path, candidates):
    v = os.environ.get(env_key)
    if v and os.path.exists(v):
        return v
    for c in candidates:
        if os.path.exists(c):
            return c
    return default_path

CHROMIUM_PATH = _resolve_binary(
    "CHROMIUM_PATH",
    _DEFAULT_CHROMIUM,
    [
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
)
CHROMEDRIVER_PATH = _resolve_binary(
    "CHROMEDRIVER_PATH",
    _DEFAULT_CHROMEDRIVER,
    ["/usr/bin/chromedriver", "/usr/local/bin/chromedriver"],
)

BASE_URL  = "https://racing.hkjc.com/racing/information/Chinese/Racing/LocalResults.aspx"
SECT_URL  = "https://racing.hkjc.com/racing/information/Chinese/Racing/DisplaySectionalTime.aspx"
COMM_URL  = "https://racing.hkjc.com/zh-hk/local/information/corunning"

OUTPUT_DIR  = "data"
FAILED_LOG  = "failed_dates.log"
MAX_RETRIES = 2
PAGE_TIMEOUT= 15

NUM_WORKERS = 6
WORKER_RANGES = [
    (date(2020, 1, 1),  date(2020, 6, 30)),
    (date(2020, 7, 1),  date(2020, 12, 31)),
    (date(2022, 1, 1),  date(2022, 12, 31)),
    (date(2024, 1, 1),  date(2024, 12, 31)),
    (date(2025, 1, 1),  date(2025, 12, 31)),
    (date(2026, 1, 1),  date(2026, 4, 16)),
]

os.makedirs(OUTPUT_DIR, exist_ok=True)


def make_driver():
    opts = webdriver.ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1920,1080")
    opts.add_argument("--disable-extensions")
    opts.add_argument("--disable-background-networking")
    opts.add_argument("--disable-default-apps")
    opts.add_argument("--disable-sync")
    opts.add_argument("--disable-translate")
    # Replit-specific memory flags (--single-process, --max-old-space-size=128) are only
    # safe on ~1GB-constrained runners. On GHA (7GB) they cause renderer disconnects.
    # Opt-in via LOW_MEMORY=1 env for Replit parity.
    if os.environ.get("LOW_MEMORY") == "1":
        opts.add_argument("--single-process")
        opts.add_argument("--js-flags=--max-old-space-size=128")
    if CHROMIUM_PATH and os.path.exists(CHROMIUM_PATH):
        opts.binary_location = CHROMIUM_PATH
    service_kwargs = {}
    if CHROMEDRIVER_PATH and os.path.exists(CHROMEDRIVER_PATH):
        service_kwargs["executable_path"] = CHROMEDRIVER_PATH
    return webdriver.Chrome(
        service=ChromeService(**service_kwargs),
        options=opts
    )


def daterange(start, end):
    for n in range(int((end - start).days) + 1):
        yield start + timedelta(n)


def log_failed(date_str, reason=""):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(FAILED_LOG, "a") as f:
        f.write(f"{date_str}  # {reason}  [{ts}]\n")


MEET_DATE_RE = re.compile(r"賽事日期\s*[:：]\s*(\d{2}/\d{2}/\d{4})")


def extract_meet_date_text(text):
    """Official results page heading date (dd/mm/yyyy), or None.

    HKJC silently falls back to the last completed meeting when the requested
    date has no results yet. The 賽事日期 heading is the only reliable page-date
    marker — the navigation strip lists many other dates, so never match the
    whole page."""
    m = MEET_DATE_RE.search(text or "")
    return m.group(1) if m else None


def page_meet_date(driver):
    try:
        return extract_meet_date_text(driver.find_element(By.TAG_NAME, "body").text)
    except Exception:
        return None


def load_page(driver, url):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            driver.get(url)
            WebDriverWait(driver, PAGE_TIMEOUT).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
            return True
        except TimeoutException:
            if attempt < MAX_RETRIES:
                time.sleep(2)
    return False


def safe_cell(cells, idx, default=""):
    try:
        return cells[idx].text.strip()
    except Exception:
        return default


def parse_race_header(race_tab):
    info = {
        "race_no": "", "race_meeting_no": "",
        "race_class": "", "distance_m": "", "rating_range": "",
        "going": "", "race_name": "", "course": "",
        "prize_hkd": "", "finish_time": "", "sectional_times": ""
    }
    try:
        tables = race_tab.find_elements(By.TAG_NAME, "table")
        if not tables:
            return info
        rows = tables[0].find_elements(By.TAG_NAME, "tr")
        if rows:
            m = re.match(r"第\s*(\d+)\s*場\s*\((\d+)\)", rows[0].text.strip())
            if m:
                info["race_no"] = m.group(1)
                info["race_meeting_no"] = m.group(2)
        if len(rows) > 2:
            row2 = rows[2].text.strip()
            m = re.match(r"(.+?)\s*-\s*(\d+)米\s*-\s*\(([\d\-]+)\)", row2)
            if m:
                info["race_class"] = m.group(1).strip()
                info["distance_m"] = m.group(2).strip()
                info["rating_range"] = m.group(3).strip()
            m2 = re.search(r"場地狀況\s*:\s*(.+)", row2)
            if m2:
                info["going"] = m2.group(1).strip()
        if len(rows) > 3:
            m = re.match(r"(.+?)\s+賽道\s*:\s*(.+)", rows[3].text.strip())
            if m:
                info["race_name"] = m.group(1).strip()
                info["course"] = m.group(2).strip()
        if len(rows) > 4:
            m = re.match(r"HK\$\s*([\d,]+)\s+時間\s*:\s*(.+)", rows[4].text.strip())
            if m:
                info["prize_hkd"] = m.group(1).replace(",", "")
                info["finish_time"] = m.group(2).strip()
        if len(rows) > 5:
            m = re.search(r"分段時間\s*:\s*(.+)", rows[5].text.strip())
            if m:
                info["sectional_times"] = m.group(1).strip()
    except Exception:
        pass
    return info


def parse_results_table(driver):
    rows_data = []
    try:
        tbl = driver.find_element(
            By.XPATH, "//table[contains(@class,'table_bd') and contains(@class,'draggable')]"
        )
        for row in tbl.find_elements(By.TAG_NAME, "tr")[1:]:
            cells = row.find_elements(By.TAG_NAME, "td")
            if len(cells) < 12:
                continue
            rows_data.append({
                "place": safe_cell(cells, 0), "horse_no": safe_cell(cells, 1),
                "horse_name": safe_cell(cells, 2), "jockey": safe_cell(cells, 3),
                "trainer": safe_cell(cells, 4), "actual_wt_lbs": safe_cell(cells, 5),
                "declared_wt_lbs": safe_cell(cells, 6), "draw": safe_cell(cells, 7),
                "lbw": safe_cell(cells, 8), "running_position": safe_cell(cells, 9),
                "finish_time": safe_cell(cells, 10), "win_odds": safe_cell(cells, 11),
            })
    except NoSuchElementException:
        pass
    except Exception:
        pass
    return rows_data


def parse_dividends(driver):
    dividends = []
    try:
        tbl = driver.find_element(
            By.XPATH, "//table[contains(@class,'f_fs13') and contains(@class,'f_fl')]"
        )
        current_pool = ""
        for row in tbl.find_elements(By.TAG_NAME, "tr"):
            cells = row.find_elements(By.TAG_NAME, "td")
            text = row.text.strip()
            if not text or text in ("派彩", "彩池 勝出組合 派彩 (HK$)"):
                continue
            if len(cells) == 3:
                pool = safe_cell(cells, 0)
                combination = safe_cell(cells, 1)
                dividend = safe_cell(cells, 2)
                if pool:
                    current_pool = pool
                else:
                    pool = current_pool
                dividends.append({"pool": pool, "combination": combination, "dividend_hkd": dividend})
            elif len(cells) == 2:
                # Dead-heat continuation row: the pool-label <td> carries a
                # rowspan, so a 2nd+ winning combination renders with only
                # (combination, dividend) and no label. Reuse current_pool so
                # multi-combo dividends (ties for a place) are not dropped.
                combination = safe_cell(cells, 0)
                dividend = safe_cell(cells, 1)
                if current_pool and combination:
                    dividends.append({"pool": current_pool, "combination": combination, "dividend_hkd": dividend})
    except NoSuchElementException:
        pass
    except Exception:
        pass
    return dividends


def extract_video_links(driver):
    src = driver.page_source
    videos = {}
    for vtype, key in [("replay-full", "video_full_url"), ("passthrough", "video_passthrough_url"), ("replay-aerial", "video_aerial_url")]:
        m = re.search(rf'href="([^"]*type={re.escape(vtype)}[^"]*)"', src)
        videos[key] = ("https://racing.hkjc.com" + m.group(1).replace("&amp;", "&")
                       if m and m.group(1).startswith("/") else
                       m.group(1).replace("&amp;", "&") if m else "")
    return videos


def parse_sectional_times(driver, meet_date, race_no):
    url = f"{SECT_URL}?RaceDate={meet_date}&RaceNo={race_no}"
    if not load_page(driver, url):
        return []
    time.sleep(0.2)
    records = []
    try:
        tables = driver.find_elements(By.TAG_NAME, "table")
        if len(tables) <= 3:
            return []
        t3 = tables[3]
        rows = t3.find_elements(By.TAG_NAME, "tr")
        for row in rows[3:]:
            cells = row.find_elements(By.TAG_NAME, "td")
            if len(cells) < 5:
                continue
            finish_pos = safe_cell(cells, 0)
            if not finish_pos.isdigit():
                continue
            rec = {
                "finish_pos": finish_pos,
                "horse_no": safe_cell(cells, 1),
                "horse_name": safe_cell(cells, 2),
                "finish_time": safe_cell(cells, len(cells) - 1),
            }
            for si, sc in enumerate(cells[3:len(cells) - 1], 1):
                parts = [p.strip() for p in sc.text.split("\n") if p.strip()]
                rec[f"sec{si}_running_pos"] = parts[0] if len(parts) > 0 else ""
                rec[f"sec{si}_margin"]      = parts[1] if len(parts) > 1 else ""
                rec[f"sec{si}_time"]        = parts[2] if len(parts) > 2 else ""
            records.append(rec)
    except Exception:
        pass
    return records


def parse_commentary(driver, date_compact, race_no):
    url = f"{COMM_URL}?Date={date_compact}&RaceNo={race_no}"
    if not load_page(driver, url):
        return []
    time.sleep(0.2)
    records = []
    try:
        tables = driver.find_elements(By.TAG_NAME, "table")
        for t in tables:
            rows = t.find_elements(By.TAG_NAME, "tr")
            if not rows or "走勢評述" not in rows[0].text:
                continue
            for row in rows[1:]:
                cells = row.find_elements(By.TAG_NAME, "td")
                if len(cells) < 5:
                    continue
                records.append({
                    "place": safe_cell(cells, 0), "horse_no": safe_cell(cells, 1),
                    "horse_name": safe_cell(cells, 2), "jockey": safe_cell(cells, 3),
                    "gear": safe_cell(cells, 4), "commentary": safe_cell(cells, 5),
                })
            break
    except Exception:
        pass
    return records


def get_race_urls(driver, meet_date):
        # Fix (2026-05-13 v2): always probe R1..R14 unconditionally. Earlier
        # heuristics that read RaceNo anchors from the js_racecard widget were
        # unreliable: HKJC sometimes returns N anchors all pointing to RaceNo=1
        # (handled in v1 by dedupe + fallback probe), but other times returns
        # only R1..R8 anchors when R9 actually exists, causing R9 to be missed
        # silently. Per-race dedupe in scrape_one_date by parsed race_no
        # already drops bogus pages, so blanket probing is safe.
        _ = driver  # parameter kept for signature compatibility
        return [f"{BASE_URL}?RaceDate={meet_date}&RaceNo={rn}" for rn in range(1, 15)]


def extract_venue(driver):
    try:
        td = driver.find_element(By.XPATH, "//table[contains(@class,'js_racecard')]//td[contains(@class,'f_tar')]")
        return td.text.strip().rstrip(":")
    except Exception:
        return ""


def scrape_one_date(driver, single_date):
    meet_date      = single_date.strftime("%d/%m/%Y")
    formatted_date = single_date.strftime("%Y-%m-%d")
    date_compact   = single_date.strftime("%Y%m%d")

    year_folder = os.path.join(OUTPUT_DIR, str(single_date.year))
    os.makedirs(year_folder, exist_ok=True)

    results_file    = os.path.join(year_folder, f"results_{formatted_date}.csv")
    dividends_file  = os.path.join(year_folder, f"dividends_{formatted_date}.csv")
    sectional_file  = os.path.join(year_folder, f"sectional_times_{formatted_date}.csv")
    commentary_file = os.path.join(year_folder, f"commentary_{formatted_date}.csv")
    video_file      = os.path.join(year_folder, f"video_links_{formatted_date}.csv")

    # Fix (2026-05-13): partial scrapes (e.g. R1 only when R2-R9 not yet posted)
    # left tiny CSVs that caused all subsequent runs to skip the date forever.
    # HKJC meetings always have 8-11 races x 10-14 horses = 80-150 rows + header,
    # so a results file with <30 rows is a partial scrape that must be retried.
    # Fix (2026-09-24 v2): skip decision is a race-number SET comparison, never a
    # row count or link count (HKJC's page always yields 14 probe links vs 8-11
    # real races). A race counts as "have" only if at least one row carries a
    # numeric finishing place.
    def _csv_placed_race_nos(path):
        try:
            df = pd.read_csv(path, encoding="utf-8-sig", usecols=["race_no", "place"], dtype=str)
        except Exception:
            return set()
        out = set()
        for rn, pl in zip(df["race_no"], df["place"]):
            try:
                rn_i = int(float(rn))
            except Exception:
                continue
            if re.match(r"^\s*\d+", str(pl or "")):
                out.add(rn_i)
        return out

    def _probe_is_real_race(rn, known):
        """True if HKJC renders a genuine race rn (not a silent R1 fallback)."""
        url = f"{BASE_URL}?RaceDate={meet_date}&RaceNo={rn}"
        if not load_page(driver, url):
            return None  # unknown
        tabs = driver.find_elements(By.CLASS_NAME, "race_tab")
        if not tabs:
            return False
        try:
            got = int(str(parse_race_header(tabs[0]).get("race_no") or "").strip())
        except Exception:
            return False
        return got == rn and got not in known

    files_exist = all(os.path.exists(f) for f in [results_file, dividends_file, sectional_file, commentary_file, video_file])

    main_url = f"{BASE_URL}?RaceDate={meet_date}"
    if not load_page(driver, main_url):
        log_failed(formatted_date, "page load failed")
        return "fail"  # cannot confirm HKJC race set -> retry next run, never skip blind

    if not driver.find_elements(By.CLASS_NAME, "race_tab"):
        return "norace"

    # Date guard (2026-10-25): HKJC falls back to the last completed meeting
    # when the requested date has no results yet; the 01:30 backup run stamped
    # 2026-10-21 HV race 1 as 2026-10-25. Pending results are NOT no-race
    # evidence: log and let later scheduled runs retry, never write files.
    got_date = page_meet_date(driver)
    if got_date != meet_date:
        log_failed(formatted_date, f"page date {got_date or 'unreadable'} != requested {meet_date}; results pending")
        print(f"[date-guard] {formatted_date}: page shows {got_date or 'unreadable'}, not {meet_date} -> pending, no write", flush=True)
        return "pending"

    # Fix (2026-05-13 v2): venue is read per race below (the index page's
    # js_racecard widget can show the wrong venue when multiple meetings are
    # listed). Initialize as empty here.
    venue     = ""
    race_urls = get_race_urls(driver, meet_date)

    # Skip iff set(CSV placed race_no) == set(HKJC actual race numbers).
    # HKJC numbers races contiguously 1..N, so the actual set is confirmed by
    # (a) the CSV holding exactly 1..max with placings, and (b) HKJC NOT
    # rendering a genuine race max+1. One extra page load, no link counting.
    if files_exist:
        have = _csv_placed_race_nos(results_file)
        if have and have == set(range(1, max(have) + 1)):
            nxt = _probe_is_real_race(max(have) + 1, have)
            if nxt is False:
                print(f"[skip-check] {formatted_date} complete: races {sorted(have)} == HKJC set -> skip", flush=True)
                return "skip"
            print(f"[skip-check] {formatted_date} CSV races {sorted(have)}; HKJC R{max(have)+1} probe={nxt} -> re-scraping", flush=True)
        else:
            print(f"[skip-check] {formatted_date} CSV placed races {sorted(have)} not contiguous/complete -> re-scraping", flush=True)

    all_results, all_dividends, all_sectional, all_commentary, all_videos = [], [], [], [], []

    seen_race_nos = set()
    for race_url in race_urls:
        if not load_page(driver, race_url):
            continue
        tabs = driver.find_elements(By.CLASS_NAME, "race_tab")
        if not tabs:
            continue
        if page_meet_date(driver) != meet_date:
            print(f"[date-guard] {formatted_date}: race page date mismatch -> skip race url {race_url}", flush=True)
            continue
        header  = parse_race_header(tabs[0])
        race_no = header["race_no"]
        # Re-extract venue from the actual race page; the index page's widget
        # may misreport venue when HKJC lists upcoming meetings on the strip.
        race_venue = extract_venue(driver)
        if race_venue:
            venue = race_venue
        # Fix (2026-05-10): even after URL dedupe, HKJC may silently render R1's
        # data when probed for a non-existent race. Trust parse_race_header's
        # race_no over the URL and skip duplicates.
        if not race_no or race_no in seen_race_nos:
            continue
        seen_race_nos.add(race_no)

        results = parse_results_table(driver)
        if not results:
            continue
        divs    = parse_dividends(driver)
        video_rec = extract_video_links(driver)
        video_rec.update({"date": formatted_date, "venue": venue, "race_no": race_no})
        all_videos.append(video_rec)

        meta = {
            "date": formatted_date, "venue": venue,
            "race_no": race_no, "race_meeting_no": header["race_meeting_no"],
            "race_name": header["race_name"], "race_class": header["race_class"],
            "distance_m": header["distance_m"], "rating_range": header["rating_range"],
            "going": header["going"], "course": header["course"],
            "prize_hkd": header["prize_hkd"],
            "race_finish_time": header["finish_time"],
            "sectional_times_header": header["sectional_times"],
        }
        for row in results:
            row.update(meta)
        for d in divs:
            d.update({"date": formatted_date, "venue": venue, "race_no": race_no})
        all_results.extend(results)
        all_dividends.extend(divs)

        sect_rows = parse_sectional_times(driver, meet_date, race_no)
        for r in sect_rows:
            r.update({"date": formatted_date, "venue": venue, "race_no": race_no})
        all_sectional.extend(sect_rows)

        comm_rows = parse_commentary(driver, date_compact, race_no)
        for r in comm_rows:
            r.update({"date": formatted_date, "venue": venue, "race_no": race_no})
        all_commentary.extend(comm_rows)

    if all_results:
        assert all(r["date"] == formatted_date for r in all_results), "row date must equal requested date"
        cols = ["date","venue","race_no","race_meeting_no","race_name","race_class",
                "distance_m","rating_range","going","course","prize_hkd",
                "race_finish_time","sectional_times_header","place","horse_no",
                "horse_name","jockey","trainer","actual_wt_lbs","declared_wt_lbs",
                "draw","lbw","running_position","finish_time","win_odds"]
        pd.DataFrame(all_results)[cols].to_csv(results_file, index=False, encoding="utf-8-sig")

    if all_dividends:
        pd.DataFrame(all_dividends)[["date","venue","race_no","pool","combination","dividend_hkd"]].to_csv(dividends_file, index=False, encoding="utf-8-sig")

    if all_sectional:
        df = pd.DataFrame(all_sectional)
        base = ["date","venue","race_no","finish_pos","horse_no","horse_name","finish_time"]
        extra = sorted([c for c in df.columns if c.startswith("sec")])
        df[base + extra].to_csv(sectional_file, index=False, encoding="utf-8-sig")
    else:
        pd.DataFrame(columns=["date","venue","race_no","finish_pos","horse_no","horse_name","finish_time"]).to_csv(sectional_file, index=False, encoding="utf-8-sig")

    if all_commentary:
        pd.DataFrame(all_commentary)[["date","venue","race_no","place","horse_no","horse_name","jockey","gear","commentary"]].to_csv(commentary_file, index=False, encoding="utf-8-sig")
    else:
        pd.DataFrame(columns=["date","venue","race_no","place","horse_no","horse_name","jockey","gear","commentary"]).to_csv(commentary_file, index=False, encoding="utf-8-sig")

    if all_videos:
        pd.DataFrame(all_videos)[["date","venue","race_no","video_full_url","video_passthrough_url","video_aerial_url"]].to_csv(video_file, index=False, encoding="utf-8-sig")
    else:
        pd.DataFrame(columns=["date","venue","race_no","video_full_url","video_passthrough_url","video_aerial_url"]).to_csv(video_file, index=False, encoding="utf-8-sig")

    return f"{venue} {len(race_urls)}場 {len(all_results)}行"


def worker(worker_id, start_dt, end_dt):
    tag = f"[W{worker_id}]"
    print(f"{tag} 啟動: {start_dt} → {end_dt}", flush=True)

    while True:
        driver = None
        try:
            driver = make_driver()
            print(f"{tag} 瀏覽器已啟動", flush=True)
            done = 0
            for single_date in daterange(start_dt, end_dt):
                result = scrape_one_date(driver, single_date)
                if result in ("skip", "norace", "pending"):
                    continue
                elif result == "fail":
                    print(f"{tag} {single_date} 失敗", flush=True)
                else:
                    done += 1
                    print(f"{tag} {single_date} ✓ {result}", flush=True)
            print(f"{tag} 完成！共 {done} 個賽馬日", flush=True)
            break
        except KeyboardInterrupt:
            print(f"{tag} 中斷", flush=True)
            break
        except Exception as e:
            print(f"{tag} 出錯: {e}", flush=True)
            print(f"{tag} 10秒後自動重啟...", flush=True)
            time.sleep(10)
        finally:
            try:
                if driver:
                    driver.quit()
            except Exception:
                pass


def _hk_today() -> date:
    """Return today's date in HKT (UTC+8)."""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date()


def run_single_dates(dates: list) -> int:
    """Scrape explicit list of dates in one driver. Returns count of successful days."""
    ok = 0
    driver = None
    try:
        driver = make_driver()
        for d in dates:
            result = scrape_one_date(driver, d)
            if result in ("skip", "norace", "pending"):
                print(f"[single] {d} {result}", flush=True)
            elif result == "fail":
                print(f"[single] {d} FAIL", flush=True)
            else:
                ok += 1
                print(f"[single] {d} ✓ {result}", flush=True)
    finally:
        try:
            if driver:
                driver.quit()
        except Exception:
            pass
    return ok


def run_daily() -> int:
    """Scrape the most recent HK race day on or before today.

    GHA cron fires at UTC 15:30 (= HK 23:30) but with Chrome/dep setup
    overhead the scraper often starts after HK midnight. Strict "today" HK
    therefore misses the just-finished race day. We consider both today
    and yesterday HK and scrape any race-day in that window.
    """
    from datetime import timedelta as _td
    hk_now = _hk_today()
    candidates = [hk_now, hk_now - _td(days=1)]
    print(f"[daily] HK now = {hk_now}; candidates = {[str(c) for c in candidates]}", flush=True)

    targets = []
    try:
        from fixture_guard import is_race_day, cache_status
        st = cache_status()
        print(f"[daily] fixture cache: exists={st['exists']}, rows={st['rows']}, age={st['age_days']}d, stale={st['stale']}", flush=True)
        for c in candidates:
            if is_race_day(c):
                targets.append(c)
        if not targets:
            print(f"[daily] fixture_guard: no race day in window {[str(c) for c in candidates]} — exiting cleanly", flush=True)
            return 0
    except ImportError:
        print("[daily] fixture_guard not available; scraping today only", flush=True)
        targets = [hk_now]

    print(f"[daily] scraping race day(s): {[str(t) for t in targets]}", flush=True)
    ok = run_single_dates(targets)
    if ok == 0:
        print(f"[daily] no data written for {targets} (empty pages?)", flush=True)
    return 0
def run_backfill():
    """Legacy multi-worker historical backfill."""
    print(f"啟動 {NUM_WORKERS} 個並行擷取器...", flush=True)
    processes = []
    for i, (s, e) in enumerate(WORKER_RANGES):
        p = Process(target=worker, args=(i + 1, s, e))
        p.start()
        processes.append(p)
        time.sleep(2)

    for p in processes:
        p.join()

    print("\n所有擷取器均已完成！")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="HKJC Race Data Scraper")
    ap.add_argument("--daily", action="store_true", help="Scrape today's HK date only (GHA daily mode)")
    ap.add_argument("--date", type=str, help="Comma-separated YYYY-MM-DD dates to scrape")
    ap.add_argument("--backfill", action="store_true", help="Force legacy multi-worker historical backfill")
    args = ap.parse_args()

    if args.daily:
        sys.exit(run_daily())
    elif args.date:
        dates = []
        for s in args.date.split(","):
            s = s.strip()
            if not s:
                continue
            try:
                dates.append(datetime.strptime(s, "%Y-%m-%d").date())
            except ValueError:
                print(f"[error] invalid date: {s}", flush=True)
                sys.exit(2)
        run_single_dates(dates)
    elif args.backfill:
        run_backfill()
    else:
        # No flags = legacy behavior (backfill) to preserve manual invocation parity
        run_backfill()
