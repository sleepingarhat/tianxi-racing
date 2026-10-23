#!/usr/bin/env python3
"""Telegram free-channel auto-poster for Tianxi (@tianxi_racing_pro, @tianxi_racing).

Zero third-party deps (stdlib only) for CI robustness.

Subcommands:
  prerace   Post the race-day preview + 1 free featured pick (morning of a HK race day).
  postrace  Post the post-race hit-rate recap (after results land).

Reads only the public backend API (workers.dev; tianxi.racing/api/* is served by the site and 404s). Posts via Telegram Bot API.

Env:
  TELEGRAM_BOT_TOKEN  (required)  bot token; bot must be admin of the channel.
  TG_CHANNEL          (optional)  comma-separated chat ids/@usernames;
                                  default @tianxi_racing_pro,@tianxi_racing
  TX_API_BASE         (optional)  default https://tianxi-backend.tianxi-entertainment.workers.dev
  TX_SITE_BASE        (optional)  default https://tianxi-site.pages.dev
"""
import os
import sys
import json
import html
import argparse
import time
import urllib.request
import urllib.error
import re
from datetime import datetime, timezone, timedelta

HK_TZ = timezone(timedelta(hours=8))
API_BASE = os.environ.get("TX_API_BASE", "https://tianxi-backend.tianxi-entertainment.workers.dev").rstrip("/")
SITE_BASE = os.environ.get("TX_SITE_BASE", "https://tianxi-site.pages.dev").rstrip("/")
DEFAULT_TG_CHANNEL = "@tianxi_racing_pro,@tianxi_racing"


def tg_channels(raw=None):
    """Parse TG_CHANNEL (comma/whitespace-separated), de-duplicated, order kept."""
    if raw is None:
        raw = os.environ.get("TG_CHANNEL") or DEFAULT_TG_CHANNEL
    out = []
    for part in raw.replace("\n", ",").replace(" ", ",").split(","):
        part = part.strip()
        if part and part not in out:
            out.append(part)
    return out or tg_channels(DEFAULT_TG_CHANNEL)


CHANNELS = tg_channels()
CHANNEL = ",".join(CHANNELS)
MEMBERSHIP_URL = SITE_BASE + "/membership/"
RESULTS_URL = SITE_BASE + "/results/"

WEEKDAY_CH = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]
VENUE_CH = {"ST": "沙田", "HV": "跑馬地"}
HKJC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

DISCLAIMER = "免責：數據分析展示，非投注建議。只供 18 歲或以上人士，請量力而為，只透過合法渠道（香港賽馬會）進行。"
CTA = '解鎖全卡預測、模型搏冷 + 市場穩陣雙欄、pWin 信心分：<a href="{url}">升級天喜 Pro</a>'.format(url=MEMBERSHIP_URL)


def hk_today():
    return datetime.now(HK_TZ).date()


def fmt_date(iso):
    try:
        d = datetime.strptime(iso, "%Y-%m-%d").date()
        return "%d月%d日（%s）" % (d.month, d.day, WEEKDAY_CH[d.weekday()])
    except Exception:
        return iso


def api_get(path):
    url = API_BASE + path
    req = urllib.request.Request(url, headers={"User-Agent": "tx-tg-notify", "Accept": "application/json"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last = err
            if err.code < 500 and err.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
        time.sleep(5 * (2 ** attempt))
    raise last


def _tg_send_one(token, channel, text):
    """Send to one chat. Returns (message_id, None) or (None, error_message). Never includes the token."""
    url = "https://api.telegram.org/bot%s/sendMessage" % token
    payload = json.dumps({
        "chat_id": channel,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            desc = json.loads(body).get("description") or body
        except (ValueError, AttributeError):
            desc = body[:300]
        return None, "ERROR: telegram sendMessage HTTP %s (chat_id=%s): %s" % (e.code, channel, desc)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, "ERROR: telegram sendMessage network error (chat_id=%s): %s" % (channel, type(e).__name__)
    if not resp.get("ok"):
        return None, "ERROR: telegram sendMessage not-ok (chat_id=%s): %s" % (
            channel, resp.get("description") or json.dumps(resp))
    return resp.get("result", {}).get("message_id"), None


def tg_send(text, channels=None):
    channels = channels or tg_channels()
    if os.environ.get("TX_DRY_RUN"):
        print("----- DRY RUN (would post to %s) -----" % ",".join(channels))
        print(text)
        print("----- END DRY RUN -----")
        return
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        print("ERROR: TELEGRAM_BOT_TOKEN not set", file=sys.stderr)
        sys.exit(2)
    failed = 0
    for channel in channels:
        mid, err = _tg_send_one(token, channel, text)
        if err:
            failed += 1
            print(err, file=sys.stderr, flush=True)
        else:
            print("posted ok, chat_id=%s, message_id=%s" % (channel, mid), flush=True)
    if failed == len(channels):
        print("ERROR: sendMessage failed for all %d chat(s)" % len(channels), file=sys.stderr)
        sys.exit(3)
    if failed:
        print("WARNING: sendMessage failed for %d/%d chat(s); continuing" % (failed, len(channels)), file=sys.stderr)


def e(s):
    return html.escape(str(s if s is not None else ""))


def venue_name(venue, fallback=None):
    return VENUE_CH.get(venue, fallback or venue or "")


def race_confidence(r):
    picks = r.get("picks") or []
    if len(picks) < 2:
        return -1.0
    def sc(p):
        v = p.get("eloComposite")
        return float(v) if v is not None else 0.0
    return sc(picks[0]) - sc(picks[1])


def pick_label(p):
    num = p.get("horseNumber")
    name = p.get("nameCh") or p.get("nameEn") or "?"
    return "%s號 %s" % (e(num), e(name))


def cmd_prerace(args):
    data = api_get("/api/analyze/today-picks")
    date = data.get("date")
    if not date:
        print("no upcoming meeting; skip")
        return
    today = hk_today().isoformat()
    if date != today and not args.force:
        print("upcoming meeting %s is not today (%s); skip" % (date, today))
        return

    venue = data.get("venue")
    vname = venue_name(venue, data.get("venueName"))
    races = [r for r in (data.get("races") or []) if (r.get("picks"))]
    if not races:
        print("no races with picks; skip")
        return

    best = max(races, key=race_confidence)
    picks = best.get("picks") or []
    top = picks[0]

    lines = []
    lines.append("<b>【天喜 TIANXI · 賽日預告】</b>")
    head = "%s　%s" % (fmt_date(date), e(vname))
    nrace = len(data.get("races") or [])
    if nrace:
        head += " — 共 %d 場" % nrace
    lines.append(head)
    lines.append("")

    rno = best.get("raceNumber")
    dist = best.get("distance")
    rcls = best.get("class")
    meta = []
    if dist:
        meta.append("%sm" % e(dist))
    if rcls:
        meta.append("第%s班" % e(rcls))
    meta_s = ("（%s）" % "．".join(meta)) if meta else ""
    lines.append("<b>今日免費精選 · 第 %s 場%s</b>" % (e(rno), meta_s))
    lines.append("本場模型首選：<b>%s</b>" % pick_label(top))
    jt = []
    if top.get("jockeyCh"):
        jt.append("騎師 " + e(top.get("jockeyCh")))
    if top.get("trainerCh"):
        jt.append("練馬 " + e(top.get("trainerCh")))
    if jt:
        lines.append("　" + "　".join(jt))
    if len(picks) >= 3:
        ref = "　／　".join(pick_label(p) for p in picks[1:3])
        lines.append("參考位置：%s" % ref)

    lines.append("")
    lines.append(CTA)
    lines.append("")
    lines.append("<i>%s</i>" % e(DISCLAIMER))
    tg_send("\n".join(lines))


def latest_settled_date(today):
    data = api_get("/api/meetings")
    for m in (data.get("meetings") or []):
        tr = m.get("totalRaces")
        d = m.get("date")
        if tr and tr > 0 and d and d <= today:
            return d, m.get("venue")
    return None, None


def pct(v):
    try:
        return "%g%%" % float(v)
    except Exception:
        return "—"


def hkjc_dividends(date_iso, venue, race_no):
    """Official HKJC dividends for one race -> {pool: amount_per_$10}.

    The site's own D1 dividends are unreliable (amounts >= $1,000 get truncated
    at the thousands comma), so the recap reads HKJC official directly.
    Best-effort: raises on network error (caller catches).
    """
    d = date_iso.replace("-", "/")
    url = ("https://racing.hkjc.com/racing/information/English/Racing/LocalResults.aspx"
           "?RaceDate=%s&Racecourse=%s&RaceNo=%d" % (d, venue, race_no))
    req = urllib.request.Request(url, headers={"User-Agent": HKJC_UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read().decode("utf-8", "replace")
    t = re.sub(r"<script.*?</script>", " ", raw, flags=re.S)
    t = re.sub(r"<style.*?</style>", " ", t, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace("&nbsp;", " ")
    t = re.sub(r"\s+", " ", t)
    out = {}
    for label, pool in (("TRIO", "TRIO"), ("FIRST 4", "FF"),
                        ("QUARTET", "QUARTET"), ("TIERCE", "TIERCE")):
        m = re.search(re.escape(label) + r"\s+[\d,]+\s+([\d,]+\.\d{2})", t)
        if m:
            try:
                out[pool] = float(m.group(1).replace(",", ""))
            except ValueError:
                pass
    return out


def build_extras(date, venue, data):
    """Coverage distribution (4/4, 4-of-3, 4-of-2, order-agnostic) + box-bet
    payouts for the model top-4, shown only where boxing the 4 picks won.
    """
    races = data.get("races") or []
    if not races:
        return []

    def nums(key, r):
        out = []
        for p in (r.get(key) or []):
            v = p.get("horseNumber")
            if v not in (None, ""):
                out.append(v)
        return out

    cov_counts = {4: 0, 3: 0, 2: 0}
    payout_races = []
    for r in races:
        m4 = nums("predictedTop4", r)
        a4 = nums("actualTop4", r)
        a3 = nums("actualTop3", r)
        if not m4 or not a4:
            continue
        mset = set(m4)
        if len(mset) != 4:
            continue
        cov4 = len([x for x in a4 if x in mset])
        if cov4 in cov_counts:
            cov_counts[cov4] += 1
        trio_win = len(a3) == 3 and all(x in mset for x in a3)
        ff_win = len(a4) == 4 and all(x in mset for x in a4)
        if trio_win or ff_win:
            payout_races.append((r.get("raceNumber"), cov4, trio_win, ff_win))

    out = []
    if cov_counts[4] or cov_counts[3] or cov_counts[2]:
        out.append("<b>模型四揀覆蓋</b>（唔分名次）")
        if cov_counts[4]:
            out.append("全中 4/4：<b>%d</b> 場" % cov_counts[4])
        if cov_counts[3]:
            out.append("4 中 3：%d 場" % cov_counts[3])
        if cov_counts[2]:
            out.append("4 中 2：%d 場" % cov_counts[2])

    pools = [
        ("FF", "四連環（任序首4）", 1),
        ("TRIO", "單T（任序首3）", 4),
        ("TIERCE", "三重彩（依序首3）", 24),
        ("QUARTET", "四重彩（依序首4）", 24),
    ]
    win_of = {"FF": lambda tr, ff: ff, "TRIO": lambda tr, ff: tr,
              "TIERCE": lambda tr, ff: tr, "QUARTET": lambda tr, ff: ff}

    body = []
    for race_no, cov4, trio_win, ff_win in payout_races:
        try:
            divs = hkjc_dividends(date, venue, race_no)
        except Exception as ex:
            print("dividend fetch failed R%s: %s" % (race_no, ex), file=sys.stderr)
            continue
        sub = []
        for pool, name, units in pools:
            if not win_of[pool](trio_win, ff_win):
                continue
            amt = divs.get(pool)
            if amt is None:
                continue
            cost = units * 10
            net = int(round(amt - cost))
            gain = ("賺 $%s" % format(net, ",")) if net >= 0 else ("蝕 $%s" % format(-net, ","))
            sub.append("　%s 箱 %d 注 $%d → 派 <b>$%s</b>（%s）" % (
                name, units, cost,
                format(int(round(amt)), ","),
                gain))
        if sub:
            tag = "全中" if cov4 == 4 else ("4 中 %d" % cov4)
            body.append("第%s場（%s）：" % (e(race_no), tag))
            body.extend(sub)

    if body:
        if out:
            out.append("")
        out.append("<b>四揀複式・每注 $10 派幾多</b>（HKJC 官方派彩）")
        out.extend(body)
        out.append("買中嗰 4 隻打複式，一注 $10 起，本小利大。")

    if out:
        out.append("")
    return out

def cmd_postrace(args):
    today_date = hk_today()
    today = today_date.isoformat()
    # Results land in D1 via the parallel D1-sync workflow, which can finish
    # slightly after this recap starts (both fire off the scraper). Poll until
    # the settled meeting hit-rate is available; never crash red on a 404.
    #
    # Recency guard: the workflow_run trigger fires on EVERY results-scraper
    # completion (incl. re-confirm runs on later days), so in auto mode only a
    # meeting dated today or yesterday (HKT) is a fresh race day worth a recap.
    # A stale latest-settled meeting is treated like "results not ready yet": we
    # keep polling (so a race day landing mid-poll is still caught) and never
    # post a stale recap. A manual --date dispatch bypasses the guard.
    attempts = 1 if args.date else 12
    date = args.date
    data = None
    for i in range(attempts):
        if not args.date:
            date, _ = latest_settled_date(today)
            if date:
                try:
                    age = (today_date - datetime.strptime(date, "%Y-%m-%d").date()).days
                except Exception:
                    age = None
                if age is None or age < 0 or age > 1:
                    date = None  # stale/invalid: not a fresh race day to recap
        if date:
            try:
                data = api_get("/api/analyze/hit-rate?date=%s" % date)
                break
            except urllib.error.HTTPError as ex:
                if ex.code != 404:
                    raise
                data = None
        if i < attempts - 1:
            time.sleep(30)
    if not date:
        print("no fresh settled meeting (today/yesterday HKT) found; skip")
        return
    if data is None:
        print("hit-rate not ready for %s after %d attempt(s); skip" % (date, attempts))
        return

    summary = data.get("summary") or {}
    n = summary.get("racesEvaluated") or 0
    if not n:
        print("no races evaluated for %s; skip" % date)
        return

    venue = data.get("venue")
    vname = venue_name(venue)

    lines = []
    lines.append("<b>【天喜 TIANXI · 賽後復盤】</b>")
    lines.append("%s　%s — 評估 %d 場" % (fmt_date(date), e(vname), n))
    lines.append("")
    lines.append("<b>模型命中率</b>")
    t1 = summary.get("top1HitRate")
    t1h = summary.get("top1Hits")
    lines.append("單場首選命中：<b>%s</b>（%s/%d）" % (pct(t1), e(t1h), n))
    t3 = summary.get("top3AnyHitRate")
    t3h = summary.get("top3AnyHits")
    lines.append("前三選任一入位：<b>%s</b>（%s/%d）" % (pct(t3), e(t3h), n))
    qp = summary.get("qpHitRate")
    if qp is not None:
        lines.append("位置 Q（QP）命中：%s" % pct(qp))
    q = summary.get("quinellaHitRate")
    if q is not None:
        lines.append("連贏命中：%s" % pct(q))

    lines.append("")
    lines.extend(build_extras(date, venue, data))
    lines.append('全卡逐場對賬：<a href="%s">預測與賽果</a>' % RESULTS_URL)
    lines.append(CTA)
    lines.append("")
    lines.append("<i>%s</i>" % e(DISCLAIMER))
    tg_send("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description="Tianxi Telegram free-channel poster")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("prerace")
    p1.add_argument("--force", action="store_true", help="post even if upcoming meeting is not today")
    p1.set_defaults(func=cmd_prerace)
    p2 = sub.add_parser("postrace")
    p2.add_argument("--date", help="YYYY-MM-DD override (default: latest settled)")
    p2.set_defaults(func=cmd_postrace)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
