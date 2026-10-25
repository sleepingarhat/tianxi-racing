"""TG 通知腳本讀 Worker 用嘅唯讀憑證（TG_READER_TOKEN）。

- 只喺 GET /api/analyze/today-picks 加 header `X-TG-Reader-Token`，而且只送去 https 嘅 API_BASE。
- 憑證值只會放喺 HTTP header，永遠唔會 print／寫入檔案。
- 未設定 TG_READER_TOKEN：照舊匿名讀（Worker ANON_FULL_CARD_MODE=legacy 時同現況一樣），
  並喺 stderr 印一行警告：Worker 轉咗 restricted 之後，已完賽賽日匿名只得第一場。
"""
from __future__ import annotations

import os
import sys

TG_READER_HEADER = "X-TG-Reader-Token"
READER_PATHS = ("/api/analyze/today-picks",)
_warned = set()


def _warn_once(key, message):
    if key in _warned:
        return
    _warned.add(key)
    print(message, file=sys.stderr)


def reader_headers(api_base, path, headers=None):
    """回傳加咗（或冇加）TG 讀取憑證嘅 headers dict；唔會改動傳入嘅 dict。"""
    out = dict(headers or {})
    if not any(path == p or path.startswith(p + "?") for p in READER_PATHS):
        return out
    value = (os.environ.get("TG_READER_TOKEN") or "").strip()
    if not value:
        _warn_once(
            "missing",
            "[tg-reader] TG_READER_TOKEN 未設定：today-picks 用匿名讀取"
            "（Worker ANON_FULL_CARD_MODE=restricted 時，已完賽賽日只會得第一場）。",
        )
        return out
    if not str(api_base).lower().startswith("https://"):
        _warn_once("insecure", "[tg-reader] API_BASE 唔係 https：唔會送出 TG_READER_TOKEN，改用匿名讀取。")
        return out
    out[TG_READER_HEADER] = value
    return out
