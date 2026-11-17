"""Official single-race cancellation on an HKJC local results page.

A cancelled race has no finishing table. The page still names the meeting date
and states the official refund sentence. That race is a real slot: persist it,
do not drop it, and do not treat a different race's header as this race.
"""
import re

# 2026-11-14 Sha Tin race 6, HTTP 200 local results page.
OFFICIAL_RACE_CANCELLED = (
    "此場賽事宣佈取消。根據賽馬博彩規例，若此賽事設有單場彩池，有關注項將予以退款。"
)
_COMPACT = re.sub(r"\s+", "", OFFICIAL_RACE_CANCELLED)
_HEADER = re.compile(r"第\s*(\d+)\s*場\s*\(\d+\)")


def _compact(text):
    return re.sub(r"\s+", "", str(text or ""))


def official_cancellation_message(page_text):
    """Return the canonical official sentence, or None when it is not on the page."""
    if _COMPACT not in _compact(page_text):
        return None
    if "退款" not in str(page_text or ""):
        return None
    return OFFICIAL_RACE_CANCELLED


def conflicting_race_header(page_text, requested_race_no):
    """True when the page's 第 N 場 header is a different race than the one requested.

    A cancelled race often has no 第 N 場 header at all (2026-11-14 ST race 6).
    Absence is not a conflict. A header for another race is: do not relabel it.
    """
    try:
        requested = int(requested_race_no)
    except (TypeError, ValueError):
        return True
    match = _HEADER.search(str(page_text or ""))
    if not match:
        return False
    return int(match.group(1)) != requested


def cancelled_result_row(page_text, requested_race_no, date, venue):
    """A results-CSV row for a cancelled race, or None.

    `date` is YYYY-MM-DD. `venue` is the Chinese meeting label already used in
    results CSVs (沙田 / 跑馬地). The row has no horse: place 取消, empty horse_no.
    """
    if conflicting_race_header(page_text, requested_race_no):
        return None
    message = official_cancellation_message(page_text)
    if not message:
        return None
    try:
        race_no = str(int(requested_race_no))
    except (TypeError, ValueError):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(date or "")):
        return None
    if venue not in ("沙田", "跑馬地"):
        return None
    return {
        "date": date,
        "venue": venue,
        "race_no": race_no,
        "race_meeting_no": "",
        "race_name": "",
        "race_class": "",
        "distance_m": "",
        "rating_range": "",
        "going": "",
        "course": "",
        "prize_hkd": "",
        "race_finish_time": "",
        "sectional_times_header": "",
        "place": "取消",
        "horse_no": "",
        "horse_name": "",
        "jockey": "",
        "trainer": "",
        "actual_wt_lbs": "",
        "declared_wt_lbs": "",
        "draw": "",
        "lbw": "",
        "running_position": "",
        "finish_time": "",
        "win_odds": "",
        "race_status": "cancelled",
        "official_message": message,
    }


def is_void_result_row(row):
    """A stored results row that records a cancelled/void race and no runner."""
    if not row:
        return False
    status = str(row.get("race_status") or "").strip().lower()
    place = str(row.get("place") or "").strip()
    horse = str(row.get("horse_no") or "").strip()
    if horse:
        return False
    if status in ("cancelled", "void"):
        return True
    return place in ("取消", "VOID", "void")


def void_race_numbers(rows):
    out = set()
    for row in rows or []:
        if not is_void_result_row(row):
            continue
        try:
            out.add(int(str(row.get("race_no") or "").strip()))
        except ValueError:
            continue
    return out


def accounted_race_numbers(rows):
    """Race numbers that are either placed or officially cancelled.

    Skip-completeness must count a void race. A numeric place is still required
    for a race that was run; 取消 with no horse is the void slot.
    """
    out = set()
    for row in rows or []:
        try:
            race_no = int(float(str(row.get("race_no") or "").strip()))
        except ValueError:
            continue
        place = str(row.get("place") or "")
        if is_void_result_row(row) or re.match(r"^\s*\d+", place):
            out.add(race_no)
    return out
