#!/usr/bin/env python3
"""Job heartbeat ticks — healthchecks dead-man pattern, self-hosted in-repo.

Inspired by jeffincn/hkjc-worker poll_ticks + healthchecks "expected by T":
record a JSON tick after a successful collector run; a later watchdog fails
if the tick is missing or older than --max-age-hours on an expected race day.

No SaaS dependency. Ticks live under data/job_ticks/<job>.json and ride the
same git_sync push as collector CSVs.

Usage:
  job_ticks.py record --job JOB [--status ok|fail] [--meta KEY=VAL ...]
  job_ticks.py check  --job JOB --max-age-hours N [--race-day-only]
  job_ticks.py show   --job JOB

Exit codes for check:
  0  tick fresh (or not a race day when --race-day-only)
  1  tick missing / stale / status=fail on expected race day
  2  usage error
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

ROOT = Path(__file__).resolve().parents[2]
TICK_DIR = ROOT / "data" / "job_ticks"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s: str) -> datetime:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def tick_path(job: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in job)
    return TICK_DIR / f"{safe}.json"


def record(job: str, status: str = "ok", meta: Optional[Dict[str, Any]] = None) -> Path:
    TICK_DIR.mkdir(parents=True, exist_ok=True)
    path = tick_path(job)
    payload = {
        "job": job,
        "status": status,
        "at": _iso(_now()),
        "meta": meta or {},
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "sha": os.environ.get("GITHUB_SHA"),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"::notice::job_tick recorded job={job} status={status} path={path}")
    return path


def load(job: str) -> Optional[Dict[str, Any]]:
    path = tick_path(job)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def is_race_day_today() -> bool:
    """Use fixture_guard; fail-open (treat as race day) on error/stale."""
    try:
        r = subprocess.run(
            [sys.executable, str(ROOT / "fixture_guard.py"), "check-today"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            check=False,
        )
        # 0 = race day / fail-open, 10 = not race day, 20 = stale fail-open
        return r.returncode in (0, 20)
    except Exception:
        return True


def check(job: str, max_age_hours: float, race_day_only: bool) -> int:
    if race_day_only and not is_race_day_today():
        print(f"::notice::job_tick check skipped — not a race day (job={job})")
        return 0

    tick = load(job)
    if tick is None:
        print(f"::error::job_tick missing for job={job} path={tick_path(job)}", file=sys.stderr)
        return 1

    try:
        at = _parse_iso(str(tick.get("at", "")))
    except Exception as exc:  # noqa: BLE001
        print(f"::error::job_tick unparseable at={tick.get('at')!r}: {exc}", file=sys.stderr)
        return 1

    age_h = (_now() - at).total_seconds() / 3600.0
    status = str(tick.get("status") or "")
    print(
        f"job_tick job={job} status={status} at={tick.get('at')} "
        f"age_h={age_h:.2f} max_age_h={max_age_hours}"
    )

    if status == "fail":
        print(f"::error::job_tick last status=fail for job={job}", file=sys.stderr)
        return 1
    if age_h > max_age_hours:
        print(
            f"::error::job_tick STALE job={job} age_h={age_h:.2f} > {max_age_hours}",
            file=sys.stderr,
        )
        return 1
    print(f"::notice::job_tick OK job={job}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("record", help="Write a fresh tick")
    rec.add_argument("--job", required=True)
    rec.add_argument("--status", default="ok", choices=("ok", "fail"))
    rec.add_argument(
        "--meta",
        action="append",
        default=[],
        help="KEY=VAL pairs attached to tick.meta",
    )

    chk = sub.add_parser("check", help="Fail if tick missing/stale")
    chk.add_argument("--job", required=True)
    chk.add_argument("--max-age-hours", type=float, required=True)
    chk.add_argument(
        "--race-day-only",
        action="store_true",
        help="Skip check when fixture_guard says not a race day",
    )

    show = sub.add_parser("show", help="Print tick JSON")
    show.add_argument("--job", required=True)

    args = p.parse_args(argv)
    if args.cmd == "record":
        meta: Dict[str, Any] = {}
        for item in args.meta:
            if "=" not in item:
                print(f"::error::bad --meta {item!r}, want KEY=VAL", file=sys.stderr)
                return 2
            k, v = item.split("=", 1)
            meta[k] = v
        record(args.job, args.status, meta)
        return 0
    if args.cmd == "show":
        tick = load(args.job)
        if tick is None:
            print("{}", file=sys.stderr)
            return 1
        print(json.dumps(tick, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "check":
        return check(args.job, args.max_age_hours, args.race_day_only)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
