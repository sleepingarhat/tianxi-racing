#!/usr/bin/env python3
"""Send exactly 3 locked posters for one settled meeting to the TG_CHANNEL chats."""
from __future__ import annotations

import json, os, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tx_poster import pick_hit_payout, render_meeting, render_post, render_pre, style_from_rp, tg_send_document

API = os.environ.get("TX_API_BASE", "https://www.tianxi.racing").rstrip("/")
VENUE = {"ST": "\u6c99\u7530", "HV": "\u8dd1\u99ac\u5730"}

def api(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "tx-tg-test", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode())

def main():
    date = sys.argv[1] if len(sys.argv) > 1 else "2026-07-12"
    data = api("/api/analyze/hit-rate?date=%s" % date)
    meet = api("/api/meetings/%s" % date)
    venue = data.get("venue") or meet.get("venue")
    vname = meet.get("venueName") or VENUE.get(venue, venue or "")
    _y, m, d = date.split("-")
    date_line = "%s\u6708%s\u65e5\u3000%s" % (int(m), int(d), vname)
    races = data.get("races") or []
    if not races:
        raise SystemExit("no races")
    horses = {}
    for r in meet.get("races") or []:
        horses[r.get("raceNumber")] = {h.get("horseNumber"): h for h in (r.get("horses") or [])}
    r1 = races[0]
    m1 = next((x for x in meet.get("races") or [] if x.get("raceNumber") == r1.get("raceNumber")), {})
    picks = []
    idx = horses.get(r1.get("raceNumber")) or {}
    for p in (r1.get("predictedTop4") or [])[:4]:
        h = idx.get(p.get("horseNumber")) or {}
        st = style_from_rp(h.get("runningPosition") or "")
        sub = " \u00b7 ".join(x for x in [h.get("jockeyCh") or "", h.get("trainerCh") or "", ("\u6a94%s" % h["draw"]) if h.get("draw") is not None else "", ("%s\u78c5" % h["weight"]) if h.get("weight") else "", st] if x)
        picks.append({"no": p.get("horseNumber"), "name": p.get("nameCh") or "", "sub": sub})
    meta = " \u00b7 ".join(x for x in [("%s\u7c73" % m1["distance"]) if m1.get("distance") else "", m1.get("class") or "", m1.get("going") or r1.get("going") or ""] if x)
    _png, pre_pdf = render_pre({"date_line": "%s\u3000\u7b2c %s \u5834" % (date_line, r1.get("raceNumber")), "meta": meta, "picks": picks}, dest="TX-%s-R%s-pre" % (date, r1.get("raceNumber")))
    tg_send_document(pre_pdf, "TX-ORACLE \u00b7 %s \u7b2c%s\u5834 \u8cfd\u524d\u9810\u6e2c" % (date, r1.get("raceNumber")))
    post_src = next((r for r in races if r.get("qpHit") or r.get("top1Hit")), None) or races[min(1, len(races)-1)]
    pred = [str(p.get("horseNumber")) for p in (post_src.get("predictedTop4") or [])][:4]
    act = [str(p.get("horseNumber")) for p in (post_src.get("actualTop4") or [])][:4]
    rid = "race_%s_%s_%s" % (date, venue, post_src.get("raceNumber"))
    try:
        divs = api("/api/races/%s" % rid).get("dividends") or []
    except Exception as e:
        print("div fetch fail", rid, e); divs = []
    pay = pick_hit_payout(pred, act, divs)
    _png, post_pdf = render_post({"date_line": "%s\u3000\u7b2c %s \u5834" % (date_line, post_src.get("raceNumber")), "pred": pred, "actual": act, "payouts": [pay] if pay else []}, dest="TX-%s-R%s-post" % (date, post_src.get("raceNumber")))
    tg_send_document(post_pdf, "TX-ORACLE \u00b7 %s \u7b2c%s\u5834 \u9810\u6e2c\u8207\u8cfd\u679c\u6bd4\u5c0d" % (date, post_src.get("raceNumber")))
    day_races = []
    for r in races:
        picks, hits = [], []
        for p in (r.get("predictedTop4") or [])[:4]:
            no = str(p.get("horseNumber")); picks.append({"no": no, "name": p.get("nameCh") or ""})
            if p.get("hit"): hits.append(no)
        day_races.append({"n": r.get("raceNumber"), "picks": picks, "hits": hits})
    _png, day_pdf = render_meeting({"date_line": date_line, "races": day_races}, dest="TX-%s-day" % date)
    tg_send_document(day_pdf, "TX-ORACLE \u00b7 %s \u5168\u65e5\u9810\u6e2c\u8207\u8cfd\u679c\u6bd4\u5c0d" % date)
    print("sent 3 cards", date, "payout", pay)

if __name__ == "__main__":
    main()
