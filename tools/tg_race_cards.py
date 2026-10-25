#!/usr/bin/env python3
"""Per-race + meeting PDF posters for the TG_CHANNEL chats (sendDocument; default @tianxi_racing_pro,@tianxi_racing)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tx_poster import render_meeting, render_post, render_pre, tg_channels, tg_send_document
from tx_reader_auth import reader_headers

HK_TZ = timezone(timedelta(hours=8))
API_BASE = os.environ.get("TX_API_BASE", "https://tianxi-backend.tianxi-entertainment.workers.dev").rstrip("/")
CHANNEL = ",".join(tg_channels())
VENUE_CH = {"ST": "沙田", "HV": "跑馬地"}
WEEKDAY_CH = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]


def hk_today():
    return datetime.now(HK_TZ).date()


def fmt_date(iso):
    try:
        d = datetime.strptime(iso, "%Y-%m-%d").date()
        return "%d月%d日（%s）" % (d.month, d.day, WEEKDAY_CH[d.weekday()])
    except Exception:
        return iso


def api_get(path):
    req = urllib.request.Request(
        API_BASE + path,
        headers=reader_headers(API_BASE, path, {"User-Agent": "tx-tg-cards", "Accept": "application/json"}),
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


def venue_name(venue, fallback=None):
    return VENUE_CH.get(venue, fallback or venue or "")


def horse_meta(p):
    bits = []
    if p.get("jockeyCh") or p.get("jockey"):
        bits.append(p.get("jockeyCh") or p.get("jockey"))
    if p.get("trainerCh") or p.get("trainer"):
        bits.append(p.get("trainerCh") or p.get("trainer"))
    if p.get("draw") not in (None, ""):
        bits.append("檔%s" % p.get("draw"))
    wt = p.get("actualWeight") or p.get("declaredWeight") or p.get("weight")
    if wt not in (None, ""):
        bits.append("%s磅" % str(wt).replace("磅", ""))
    st = p.get("runningStyle") or p.get("styleLabel") or p.get("style") or ""
    if st and str(st)[:1] in "放前中後":
        bits.append(str(st)[:1])
    return " · ".join(str(x) for x in bits)


def nums(items, key="horseNumber"):
    out = []
    for p in items or []:
        v = p.get(key) if isinstance(p, dict) else p
        if v not in (None, ""):
            out.append(str(v))
    return out


def payout_rows(race):
    rows = []
    raw = race.get("boxPayouts") or []
    if isinstance(raw, dict):
        raw = [{"pool": k, "payout": v} for k, v in raw.items()]
    for item in raw:
        if not isinstance(item, dict):
            continue
        pool = item.get("pool") or item.get("name") or item.get("code")
        pay = item.get("payout") or item.get("dividend") or item.get("win")
        if pool and pay not in (None, "", 0, "0"):
            s = str(pay)
            if not s.startswith("$"):
                s = "$" + s
            rows.append({"pool": str(pool), "payout": s})
    if rows:
        return rows
    flags = [
        (race.get("qpHit"), "位置Q"),
        (race.get("quinellaHit"), "連贏"),
        (race.get("top1Hit"), "獨贏"),
        (race.get("trioHit"), "單T"),
        (race.get("first4Hit"), "四連環"),
    ]
    for hit, name in flags:
        if hit:
            rows.append({"pool": name, "payout": "—"})
            break
    return rows


def send_pre_races(data, date, only_first=False):
    vname = venue_name(data.get("venue"), data.get("venueName"))
    date_line_base = "%s　%s" % (fmt_date(date), vname)
    races = data.get("races") or []
    if only_first:
        races = races[:1]
    for r in races:
        picks = r.get("picks") or r.get("predictedTop4") or []
        picks = sorted(picks, key=lambda p: p.get("rank") or 99)[:4]
        if len(picks) < 1:
            continue
        meta = []
        if r.get("distance"):
            meta.append("%s米" % r.get("distance"))
        if r.get("class"):
            meta.append("第%s班" % r.get("class"))
        if r.get("going"):
            meta.append(r.get("going"))
        payload = {
            "date_line": "%s　第 %s 場" % (date_line_base, r.get("raceNumber")),
            "meta": " · ".join(str(x) for x in meta),
            "picks": [
                {
                    "no": p.get("horseNumber"),
                    "name": p.get("nameCh") or p.get("nameEn") or "",
                    "sub": horse_meta(p),
                }
                for p in picks
            ],
        }
        _png, pdf = render_pre(payload, dest="TX-R%s-pre" % r.get("raceNumber"))
        tg_send_document(pdf, "TX-ORACLE · 第%s場" % r.get("raceNumber"))
        time.sleep(1.2)


def cmd_prerace(args):
    if getattr(args, "date", None):
        data = load_hit(args.date)
        send_pre_races(data, args.date, only_first=True)
        return
    data = api_get("/api/analyze/today-picks")
    date = data.get("date")
    if not date:
        print("no meeting")
        return
    if date != hk_today().isoformat() and not args.force:
        print("not today", date)
        return
    send_pre_races(data, date, only_first=False)


def latest_settled(today):
    data = api_get("/api/meetings")
    for m in data.get("meetings") or []:
        if m.get("totalRaces") and m.get("date") and m.get("date") <= today:
            return m.get("date"), m.get("venue")
    return None, None


def load_hit(date):
    return api_get("/api/analyze/hit-rate?date=%s" % date)


def cmd_postrace(args):
    today = hk_today().isoformat()
    date = args.date or latest_settled(today)[0]
    if not date:
        print("no settled")
        return
    try:
        data = load_hit(date)
    except urllib.error.HTTPError as ex:
        if ex.code == 404:
            return
        raise
    vname = venue_name(data.get("venue"))
    date_line_base = "%s　%s" % (fmt_date(date), vname)
    races = data.get("races") or []
    if getattr(args, "one", False):
        races = races[:1]
    for r in races:
        pred = nums(r.get("predictedTop4"))
        act4 = nums(r.get("actualTop4"))
        if not pred and not act4:
            continue
        payload = {
            "date_line": "%s　第 %s 場" % (date_line_base, r.get("raceNumber")),
            "pred": pred,
            "actual": act4,
            "payouts": payout_rows(r),
        }
        _png, pdf = render_post(payload, dest="TX-R%s-post" % r.get("raceNumber"))
        tg_send_document(pdf, "TX-ORACLE · 第%s場 比對" % r.get("raceNumber"))
        time.sleep(1.2)


def cmd_day(args):
    today = hk_today().isoformat()
    date = args.date or latest_settled(today)[0]
    if not date:
        print("no settled")
        return
    try:
        data = load_hit(date)
    except urllib.error.HTTPError as ex:
        if ex.code == 404:
            return
        raise
    vname = venue_name(data.get("venue"))
    races = []
    for r in data.get("races") or []:
        picks = []
        hits = []
        for p in (r.get("predictedTop4") or [])[:4]:
            no = str(p.get("horseNumber"))
            picks.append({"no": no, "name": p.get("nameCh") or p.get("nameEn") or ""})
            if p.get("hit"):
                hits.append(no)
        if not picks:
            continue
        races.append({"n": r.get("raceNumber"), "picks": picks, "hits": hits})
    if not races:
        print("no races")
        return
    _png, pdf = render_meeting(
        {"date_line": "%s　%s" % (fmt_date(date), vname), "races": races},
        dest="TX-%s-day" % date,
    )
    tg_send_document(pdf, "TX-ORACLE · %s 全日比對" % date)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("prerace-races")
    p1.add_argument("--force", action="store_true")
    p1.add_argument("--date")
    p1.set_defaults(func=cmd_prerace)
    p2 = sub.add_parser("postrace-races")
    p2.add_argument("--date")
    p2.add_argument("--one", action="store_true")
    p2.set_defaults(func=cmd_postrace)
    p3 = sub.add_parser("day")
    p3.add_argument("--date")
    p3.set_defaults(func=cmd_day)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
