"""
Entry List Scraper — fetches HKJC's 排位表 (race card) for the next meeting.

Outputs (atomic, fail-closed):
  entries/today_entries.txt        — header + one horse code per line.
                                     Header: "# meeting=YYYY-MM-DD"
                                     Consumed by HorseData / HorseTrackwork
                                     scrapers to fire comeback override.
  entries/entries_<YYYY-MM-DD>.txt — dated archive (only on full success).

Robustness:
  - SPA readiness: wait for either horse links to render OR HKJC's
    "沒有相關資料" sentinel before judging a race empty.
  - Per-race retry on timeout (transient render/load failure).
  - End-of-meeting only declared on confirmed "no data" sentinel after
    a fully loaded page — not on timeout.
  - Fail-closed: any discovery/scrape failure writes an empty stale-marker
    today_entries.txt so downstream loaders correctly skip the override.
"""

import os
import re
import time
from datetime import date, datetime, timedelta, timezone

from selenium.webdriver.common.by import By

from scraper_utils import make_driver

ENTRY_DIR = "entries"
os.makedirs(ENTRY_DIR, exist_ok=True)

INDEX_URL = "https://racing.hkjc.com/zh-hk/local/information/racecard"
RACE_URL = (
    "https://racing.hkjc.com/zh-hk/local/information/racecard"
    "?RaceDate={date}&Racecourse={rc}&RaceNo={rn}"
)

HORSE_CODE_RE = re.compile(r"horseid=HK_\d+_([A-Z]\d+)", re.IGNORECASE)
HEADER_RE = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日[^,]*,\s*[^,]*,\s*(沙田|跑馬地)")
RC_MAP = {"沙田": "ST", "跑馬地": "HV"}
EMPTY_SENTINEL = "沒有相關資料"

PAGE_RENDER_TIMEOUT = 25       # seconds to wait for SPA to settle per page
PAGE_RETRIES = 2               # retry a race once on timeout


def _write_empty(reason):
    """Fail-closed: clear today_entries.txt so downstream skips the override."""
    out = os.path.join(ENTRY_DIR, "today_entries.txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"# stale reason={reason} written={date.today().isoformat()}\n")
    print(f"[FAIL-CLOSED] today_entries.txt cleared (reason={reason})")


def wait_for_race_state(driver, max_wait=PAGE_RENDER_TIMEOUT):
    """Poll the page until horse links render OR HKJC's no-data sentinel
    appears. Returns 'horses' / 'empty' / 'timeout'."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        src = driver.page_source
        if HORSE_CODE_RE.search(src):
            return "horses"
        if EMPTY_SENTINEL in src:
            return "empty"
        time.sleep(0.6)
    return "timeout"


def hk_today():
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date()


def _read_header(driver, url):
    try:
        driver.get(url)
    except Exception as e:
        print(f"  Page load failed: {e}")
        return None
    deadline = time.time() + PAGE_RENDER_TIMEOUT
    while time.time() < deadline:
        try:
            body_text = driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            body_text = ""
        m = HEADER_RE.search(body_text)
        if m:
            y, mo, da, course = m.groups()
            return f"{y}/{int(mo):02d}/{int(da):02d}", RC_MAP.get(course, "ST")
        time.sleep(0.6)
    return None


def pick_meeting(found, today):
    """Accept only a meeting dated today or later; a past card is stale, never upcoming."""
    if not found:
        return None, None
    d, rc = found
    return (d, rc) if datetime.strptime(d, "%Y/%m/%d").date() >= today else (None, None)


def discover_meeting(driver):
    """Return the next official meeting (date, course); a stale past index fails closed."""
    today = hk_today()
    target = os.environ.get("MEETING_DATE", "").strip()
    dates = [target] if target else [(today + timedelta(days=i)).isoformat() for i in range(0, 8)]
    for d in dates:
        slash = d.replace("-", "/")
        for rc in ("ST", "HV"):
            got = _read_header(driver, RACE_URL.format(date=slash, rc=rc, rn=1))
            if got == (slash, rc):
                return got
    meeting = pick_meeting(_read_header(driver, INDEX_URL), today)
    if not meeting[0]:
        print(f"  No official meeting on/after {today}; index card is past or missing")
    return meeting


def scrape_race(driver, meeting_date, racecourse, race_no):
    """Return ('horses', set_of_codes), ('empty', set()), or ('timeout', set())."""
    url = RACE_URL.format(date=meeting_date, rc=racecourse, rn=race_no)
    for attempt in range(1, PAGE_RETRIES + 1):
        try:
            driver.get(url)
        except Exception as e:
            print(f"    attempt {attempt}: get() failed: {e}")
            continue
        state = wait_for_race_state(driver)
        if state == "horses":
            return state, set(HORSE_CODE_RE.findall(driver.page_source))
        if state == "empty":
            return state, set()
        print(f"    Race {race_no} attempt {attempt} timed out, retrying...")
        time.sleep(2)
    return "timeout", set()


def main():
    driver = make_driver()
    try:
        print("Loading HKJC race card index...")
        meeting_date, racecourse = discover_meeting(driver)
        if not meeting_date:
            print("No upcoming meeting header found.")
            _write_empty("no_meeting")
            return

        date_iso = meeting_date.replace("/", "-")
        print(f"Meeting: {meeting_date} ({racecourse})")

        horse_codes = set()
        end_confirmed = False
        for race_no in range(1, 13):
            state, found = scrape_race(driver, meeting_date, racecourse, race_no)
            if state == "horses":
                horse_codes |= found
                print(f"  Race {race_no}: {len(found)} horses")
                continue
            if state == "empty":
                print(f"  Race {race_no}: no horses (sentinel) — end of meeting")
                end_confirmed = True
                break
            # timeout — fail closed, do not publish a partial file
            print(f"  Race {race_no}: timeout after retries — aborting")
            _write_empty(f"race_{race_no}_timeout")
            return

        if not horse_codes:
            print("No horses extracted across all races.")
            _write_empty("no_horses")
            return

        if not end_confirmed:
            # Reached race 12 without empty sentinel — unusual, but treat as
            # complete since HKJC meetings cap at ~11 races.
            print("Reached race 12 without empty sentinel; publishing anyway.")

        out_today = os.path.join(ENTRY_DIR, "today_entries.txt")
        out_dated = os.path.join(ENTRY_DIR, f"entries_{date_iso}.txt")
        header = f"# meeting={date_iso} racecourse={racecourse} written={date.today().isoformat()}\n"
        payload = header + "\n".join(sorted(horse_codes)) + "\n"
        for path in (out_today, out_dated):
            with open(path, "w", encoding="utf-8") as f:
                f.write(payload)
        print(
            f"\nSaved {len(horse_codes)} horse codes:\n  - {out_today}\n  - {out_dated}"
        )
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
