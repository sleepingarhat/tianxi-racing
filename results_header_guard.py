"""Fail-closed check for an official results header. No browser imports."""
import re


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
