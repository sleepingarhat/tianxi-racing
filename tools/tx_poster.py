#!/usr/bin/env python3
"""Locked posters: approved artwork as base, Noto text in data slots only."""
from __future__ import annotations

import json, os, sys, urllib.error, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

PAPER = (252, 246, 232)
INK = (58, 38, 20)
MUTE = (118, 94, 60)
GOLD = (176, 138, 48)
GOLD_DEEP = (130, 98, 32)
GREEN = (14, 108, 56)
LINE = (186, 152, 82)

def _font_pick(*cands):
    for c in cands:
        if Path(c).exists():
            return c
    return cands[0]

SERIF_B = _font_pick("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSerifCJKtc-Bold.otf")
SERIF_R = _font_pick("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSerifCJKtc-Regular.otf", SERIF_B)
SANS_R = _font_pick("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJKtc-Regular.otf", SERIF_R)
HK = 4
OUT = Path(os.environ.get("TX_POSTER_OUT", "/tmp/tx-posters"))
ASSETS = Path(os.environ.get("TX_POSTER_ASSETS", str(Path(__file__).resolve().parent / "locked")))

def F(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=HK)

def _blank(w, h):
    im = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(im)
    d.rectangle([36, 36, w - 36, h - 36], outline=GOLD_DEEP, width=4)
    d.rectangle([46, 46, w - 46, h - 46], outline=LINE, width=1)
    return im

def load_base(name: str) -> Image.Image:
    p = ASSETS / name
    if p.exists():
        return Image.open(p).convert("RGB")
    try:
        from locked_assets import LOCKED
        import base64, io
        key = name.replace(".jpg", "")
        return Image.open(io.BytesIO(base64.b64decode(LOCKED[key]))).convert("RGB")
    except Exception:
        if name.startswith("day"):
            return _blank(1600, 900)
        return _blank(1080, 1440)

def cover(d: ImageDraw.ImageDraw, box, color=PAPER):
    d.rectangle(box, fill=color)

def save(im: Image.Image, dest: str):
    OUT.mkdir(parents=True, exist_ok=True)
    png, pdf = OUT / f"{dest}.png", OUT / f"{dest}.pdf"
    im.save(png)
    im.convert("RGB").save(pdf, "PDF", resolution=150)
    return png, pdf

def render_pre(race: dict, dest: str = "tx_poster_pre"):
    im = load_base("pre.jpg")
    d = ImageDraw.Draw(im)
    w, h = im.size
    d.text((w / 2, int(h * 0.07)), "TX-ORACLE\u5929\u559c\u5f15\u64ce \u00b7 \u8cfd\u524d\u9810\u6e2c", font=F(SERIF_B, 36), fill=INK, anchor="mt")
    cover(d, (int(w * 0.08), int(h * 0.155), int(w * 0.92), int(h * 0.30)))
    d.text((w / 2, int(h * 0.175)), race.get("date_line", ""), font=F(SERIF_B, 46), fill=INK, anchor="mt")
    d.text((w / 2, int(h * 0.235)), race.get("meta", ""), font=F(SERIF_R, 28), fill=MUTE, anchor="mt")
    picks = race.get("picks") or []
    cover(d, (int(w * 0.12), int(h * 0.30), int(w * 0.92), int(h * 0.94)))
    row_top = [0.32, 0.48, 0.64, 0.80]
    for i, p in enumerate(picks[:4]):
        y0 = int(h * row_top[i])
        d.text((int(w * 0.16), y0 + 12), str(i + 1), font=F(SERIF_B, 40), fill=GOLD)
        d.text((int(w * 0.26), y0 + 8), str(p.get("no", "")), font=F(SERIF_B, 52), fill=INK)
        d.text((int(w * 0.38), y0 + 12), p.get("name", ""), font=F(SERIF_B, 48), fill=INK)
        if i == 0:
            tw = d.textlength(p.get("name", ""), font=F(SERIF_B, 48))
            d.text((int(w * 0.38) + tw + 16, y0 + 20), "\u2605", font=F(SERIF_B, 32), fill=GOLD)
        d.text((int(w * 0.38), y0 + 72), p.get("sub", ""), font=F(SANS_R, 24), fill=MUTE)
    return save(im, dest)

def render_post(race: dict, dest: str = "tx_poster_post"):
    im = load_base("post.jpg")
    d = ImageDraw.Draw(im)
    w, h = im.size
    d.text((w / 2, int(h * 0.07)), "TX-ORACLE\u5929\u559c\u5f15\u64ce \u00b7 \u9810\u6e2c\u8207\u8cfd\u679c\u6bd4\u5c0d", font=F(SERIF_B, 32), fill=INK, anchor="mt")
    cover(d, (int(w * 0.08), int(h * 0.155), int(w * 0.92), int(h * 0.25)))
    d.text((w / 2, int(h * 0.175)), race.get("date_line", ""), font=F(SERIF_B, 46), fill=INK, anchor="mt")
    pred = [str(x) for x in (race.get("pred") or [])][:4]
    actual = [str(x) for x in (race.get("actual") or [])][:4]
    hit = set(pred) & set(actual)
    cover(d, (int(w * 0.10), int(h * 0.32), int(w * 0.90), int(h * 0.80)))
    lx, rx = w * 0.32, w * 0.70
    d.text((lx, int(h * 0.39)), "\u6a21\u578b\u9996\u56db", font=F(SERIF_B, 28), fill=INK, anchor="mt")
    d.text((rx, int(h * 0.39)), "\u8cfd\u679c\u982d\u56db", font=F(SERIF_B, 28), fill=INK, anchor="mt")
    yy = int(h * 0.45)
    for i in range(4):
        a = pred[i] if i < len(pred) else "\u2014"
        b = actual[i] if i < len(actual) else "\u2014"
        d.text((lx, yy), a, font=F(SERIF_B, 80), fill=GOLD if a in hit else INK, anchor="mt")
        d.text((rx, yy), b, font=F(SERIF_B, 80), fill=GOLD if b in hit else INK, anchor="mt")
        if i == 1:
            d.text((w / 2, yy + 32), f"\u547d\u4e2d {len(hit)}/4", font=F(SERIF_B, 28), fill=GOLD, anchor="mt")
        yy += int(h * 0.075)
    cover(d, (int(w * 0.12), int(h * 0.82), int(w * 0.88), int(h * 0.92)))
    rows = race.get("payouts") or []
    mid = int(h * 0.87)
    if rows:
        row = rows[0]
        d.text((w * 0.22, mid), f"\u547d\u4e2d{row['pool']}", font=F(SERIF_B, 28), fill=GOLD, anchor="mm")
        d.text((w * 0.50, mid), "$10\u4e00\u6ce8", font=F(SANS_R, 26), fill=MUTE, anchor="mm")
        d.text((w * 0.76, mid), f"\u6d3e\u5f69{row['payout']}", font=F(SERIF_B, 30), fill=GREEN, anchor="mm")
    return save(im, dest)

def render_meeting(meet: dict, dest: str = "tx_poster_day"):
    im = load_base("day.jpg")
    d = ImageDraw.Draw(im)
    w, h = im.size
    d.text((w / 2, int(h * 0.06)), "TX-ORACLE\u5929\u559c\u5f15\u64ce \u00b7 \u5168\u65e5\u9810\u6e2c\u8207\u8cfd\u679c\u6bd4\u5c0d", font=F(SERIF_B, 30), fill=INK, anchor="mt")
    cover(d, (int(w * 0.18), int(h * 0.14), int(w * 0.82), int(h * 0.24)))
    d.text((w / 2, int(h * 0.16)), meet.get("date_line", ""), font=F(SERIF_B, 32), fill=INK, anchor="mt")
    races = meet.get("races") or []
    left, top, right, bot = int(w * 0.07), int(h * 0.28), int(w * 0.93), int(h * 0.92)
    cover(d, (left, top, right, bot))
    headers = ["\u5834\u6b21", "\u7b2c\u4e00\u540d", "\u7b2c\u4e8c\u540d", "\u7b2c\u4e09\u540d", "\u7b2c\u56db\u540d"]
    cols = 5
    rows_n = 1 + max(len(races), 1)
    cw = (right - left) / cols
    rh = (bot - top) / rows_n
    d.rectangle([left, top, right, top + rh], fill=(138, 106, 36))
    for i, hd in enumerate(headers):
        d.text((left + cw * i + cw / 2, top + rh / 2), hd, font=F(SERIF_B, 18), fill=PAPER, anchor="mm")
    for r_i, race in enumerate(races):
        y0 = top + rh * (r_i + 1)
        y1 = y0 + rh
        d.text((left + cw / 2, (y0 + y1) / 2), str(race.get("n", "")), font=F(SERIF_B, 18), fill=INK, anchor="mm")
        picks = race.get("picks") or []
        hits = set(str(x) for x in (race.get("hits") or []))
        for c, p in enumerate(picks[:4]):
            x = left + cw * (c + 1)
            no = str(p.get("no", ""))
            name = p.get("name", "")
            is_hit = no in hits
            if is_hit:
                d.rectangle([x + 3, y0 + 3, x + cw - 3, y1 - 3], fill=(245, 230, 190))
            color = GOLD_DEEP if is_hit else INK
            d.text((x + cw / 2, (y0 + y1) / 2), f"{no}{name}", font=F(SERIF_B if is_hit else SERIF_R, 16), fill=color, anchor="mm")
            if is_hit:
                d.text((x + cw - 14, y0 + 10), "\u2605", font=F(SERIF_B, 11), fill=GOLD, anchor="mm")
    for i in range(cols + 1):
        d.line([(left + cw * i, top), (left + cw * i, bot)], fill=GOLD, width=1)
    for r_i in range(rows_n + 1):
        d.line([(left, top + rh * r_i), (right, top + rh * r_i)], fill=GOLD, width=1)
    return save(im, dest)

def fmt_div(n) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "\u2014"
    if v >= 100:
        return "$%s" % int(round(v))
    if v == int(v):
        return "$%s" % int(v)
    return "$%s" % ("%0.1f" % v).rstrip("0").rstrip(".")

def pick_hit_payout(pred, actual, dividends):
    pred = [str(x) for x in pred]
    actual = [str(x) for x in actual]
    pred_set = set(pred)
    by = {}
    for row in dividends or []:
        by.setdefault(str(row.get("poolType") or ""), []).append(row)
    def combo_set(row):
        return set(s.strip() for s in str(row.get("combination") or "").replace("/", ",").split(",") if s.strip())
    for row in by.get("QPL", []):
        c = combo_set(row)
        if len(c) == 2 and c <= pred_set:
            return {"pool": "\u4f4d\u7f6eQ", "payout": fmt_div(row.get("dividend"))}
    for row in by.get("WIN", []):
        if pred and actual and str(pred[0]) == str(actual[0]) and str(pred[0]) in combo_set(row):
            return {"pool": "\u7368\u8d0f", "payout": fmt_div(row.get("dividend"))}
    for row in by.get("QIN", []):
        c = combo_set(row)
        if c <= pred_set:
            return {"pool": "\u9023\u8d0f", "payout": fmt_div(row.get("dividend"))}
    for row in by.get("TRI", []):
        c = combo_set(row)
        if c <= pred_set:
            return {"pool": "\u55aeT", "payout": fmt_div(row.get("dividend"))}
    for row in by.get("FF", []):
        c = combo_set(row)
        if c <= pred_set:
            return {"pool": "\u56db\u9023\u74b0", "payout": fmt_div(row.get("dividend"))}
    return None

def style_from_rp(rp: str) -> str:
    first = (rp or "").split()[0] if rp else ""
    try:
        n = int(first)
    except ValueError:
        return ""
    if n <= 3: return "\u524d"
    if n <= 7: return "\u4e2d"
    return "\u5f8c"

DEFAULT_TG_CHANNEL = "@tianxi_racing_pro,@tianxi_racing"


def tg_channels(raw=None) -> list:
    """Parse TG_CHANNEL (comma/whitespace-separated chat ids / @usernames), de-duplicated, order kept."""
    if raw is None:
        raw = os.environ.get("TG_CHANNEL") or DEFAULT_TG_CHANNEL
    out = []
    for part in raw.replace("\n", ",").replace(" ", ",").split(","):
        part = part.strip()
        if part and part not in out:
            out.append(part)
    return out or tg_channels(DEFAULT_TG_CHANNEL)


def _tg_send_document_one(token: str, channel: str, pdf_path: Path, body_file: bytes, caption: str):
    """Send to one chat. Returns (message_id, None) on success or (None, error_message)."""
    boundary = "txposter"
    chunks = []
    def field(name, value):
        chunks.append(("\r\n--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n" % (boundary, name)).encode())
        chunks.append(value if isinstance(value, bytes) else str(value).encode())
    field("chat_id", channel)
    field("caption", caption)
    chunks.append(("\r\n--%s\r\nContent-Disposition: form-data; name=\"document\"; filename=\"%s\"\r\nContent-Type: application/pdf\r\n\r\n" % (boundary, pdf_path.name)).encode())
    chunks.append(body_file)
    chunks.append(("\r\n--%s--\r\n" % boundary).encode())
    req = urllib.request.Request("https://api.telegram.org/bot%s/sendDocument" % token, data=b"".join(chunks), headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # Never echo e.url / req.full_url: they contain the bot token.
        return None, tg_error_message("sendDocument", e.code, e.read(), channel, pdf_path.name)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, "ERROR: telegram sendDocument network error (chat_id=%s, file=%s): %s" % (
            channel, pdf_path.name, type(e).__name__)
    if not resp.get("ok"):
        return None, tg_error_message("sendDocument", resp.get("error_code"), resp, channel, pdf_path.name)
    return resp.get("result", {}).get("message_id"), None


def tg_send_document(pdf_path: Path, caption: str = "") -> None:
    """Send the PDF to every chat in TG_CHANNEL independently.

    A failing chat is logged (with Telegram's description) and does not stop the others;
    SystemExit is raised only if *every* chat failed.
    """
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    channels = tg_channels()
    if os.environ.get("TX_DRY_RUN"):
        print("dry-run", ",".join(channels), pdf_path, caption); return
    if not token:
        raise SystemExit("missing TELEGRAM_BOT_TOKEN")
    with open(pdf_path, "rb") as f:
        body_file = f.read()
    errors = []
    for channel in channels:
        mid, err = _tg_send_document_one(token, channel, pdf_path, body_file, caption)
        if err:
            print(err, file=sys.stderr, flush=True)
            errors.append(err)
        else:
            print("posted", channel, mid, pdf_path.name, flush=True)
    if len(errors) == len(channels):
        raise SystemExit("ERROR: sendDocument failed for all %d chat(s): %s" % (len(channels), " | ".join(errors)))
    if errors:
        print("WARNING: sendDocument failed for %d/%d chat(s); continuing" % (len(errors), len(channels)), file=sys.stderr)


def tg_error_message(method: str, status, body, chat_id: str, filename: str = "") -> str:
    """Token-free one-line error, surfacing Telegram's `description` field."""
    desc = None
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", "replace")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            desc = body.strip()[:300] or None
    if isinstance(body, dict):
        desc = body.get("description") or desc
    msg = "ERROR: telegram %s HTTP %s (chat_id=%s%s): %s" % (
        method, status, chat_id, (", file=%s" % filename) if filename else "", desc or "no description")
    if desc and "chat not found" in desc.lower():
        msg += (" -- the bot cannot see this chat: check the channel still exists with this @username"
                " (or set TG_CHANNEL to its numeric -100... id) and that the bot is an admin of it")
    return msg
