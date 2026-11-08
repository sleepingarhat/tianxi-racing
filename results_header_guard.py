"""Fail-closed check for an official results header. No browser imports."""
import re

# "第四班 - 1200米 - (60-40)" or, for group and cup races that carry no
# rating band, "三級賽 - 1800米". The band is optional; the distance is not.
CLASS_DISTANCE = re.compile(r"(.+?)\s*-\s*(\d+)米(?:\s*-\s*\(([\d\-]+)\))?")


def parse_class_distance(row_text):
    """Return (race_class, distance_m, rating_range) or None when unmatched."""
    m = CLASS_DISTANCE.match(str(row_text or "").strip())
    if not m:
        return None
    return m.group(1).strip(), m.group(2).strip(), (m.group(3) or "").strip()


def official_header_miss(header, tab_text):
    """Return a reason when the tab shows a surface but a critical field is empty.

    Call this only after the 賽事日期 guard has accepted the page. A blank
    course, distance, or visible rating band is a parse miss, not an empty meeting.
    """
    text = str(tab_text or "")[:800]
    if not any(token in text for token in ("草地", "全天候", "泥地", "沙地", "賽道")):
        return None
    if not str((header or {}).get("course") or "").strip():
        return "course empty while the page shows a surface"
    if not str(header.get("distance_m") or "").strip():
        return "distance empty while the page shows a surface"
    if re.search(r"\d+\s*-\s*\d+", text) and not str(header.get("rating_range") or "").strip():
        return "rating range visible but empty"
    return None
