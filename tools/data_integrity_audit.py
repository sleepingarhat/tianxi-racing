#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tianxi-database · Data Integrity Audit
======================================

檢查全數據庫每個 category 嘅完整性。

原則:「100% 齊全唔可以遺漏，呢個係命根。」

Output:
  audit_reports/integrity_YYYY-MM-DD.json     # 機器讀
  audit_reports/integrity_latest.json         # 同上 (symlink-style copy)
  audit_reports/SUMMARY.md                    # 人類讀 (gets included in SANITY)

Exit codes:
  0  全綠
  1  有 warning（non-critical gaps）
  2  有 critical gaps（應該 block cutover）

Usage:
  python tools/data_integrity_audit.py [--repo-root .]
"""
from __future__ import annotations
import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
import importlib.util
import hashlib
import re
from typing import Dict, List, Set

# ---------- CONSTANTS ----------

RECENT_WINDOW_DAYS = 180          # "recent" = last N days for cohort sizing
ACTIVE_WINDOW_DAYS = 90           # "active" horse/jockey/trainer definition
STALE_THRESHOLD_DAYS = 14         # profile_last_scraped stale after N days
# Pool A (capy_pool_a.yml, 20:00 UTC) discovers horses ONLY from results CSVs,
# so a debutant who first ran on scan_date cannot have a profile/form file until
# that night's Pool A run. Such horses are reported as pending (warn), never
# hidden; from the next scan_date on, the same gap is critical again.
SAME_DAY_GRACE_DAYS = 0           # 0 = only horses whose FIRST recent run is scan_date
ARTEFACT_TYPES = [
    "results", "commentary", "dividends", "sectional_times", "video_links",
]

# ---------- DATA CLASSES ----------

@dataclass
class CategoryResult:
    name: str
    expected: int = 0
    present: int = 0
    missing: List[str] = field(default_factory=list)
    stale: List[str] = field(default_factory=list)
    pending: List[str] = field(default_factory=list)   # visible, not yet overdue
    notes: List[str] = field(default_factory=list)
    severity: str = "ok"   # ok | warn | critical

    @property
    def gap(self) -> int:
        return len(self.missing) + len(self.stale)

    def summary(self) -> str:
        return (
            f"{self.name}: expected={self.expected} present={self.present} "
            f"missing={len(self.missing)} stale={len(self.stale)} "
            f"pending={len(self.pending)} severity={self.severity}"
        )


@dataclass
class AuditReport:
    scan_date: str
    repo_root: str
    categories: Dict[str, CategoryResult] = field(default_factory=dict)
    overall_severity: str = "ok"
    critical_gap_count: int = 0
    warn_gap_count: int = 0
    recommendation: str = "all_green"

    def to_json(self) -> str:
        return json.dumps(
            {
                "scan_date": self.scan_date,
                "repo_root": self.repo_root,
                "overall_severity": self.overall_severity,
                "critical_gap_count": self.critical_gap_count,
                "warn_gap_count": self.warn_gap_count,
                "recommendation": self.recommendation,
                "categories": {k: asdict(v) for k, v in self.categories.items()},
            },
            ensure_ascii=False,
            indent=2,
        )


# ---------- HELPERS ----------

def _parse_date(s: str) -> date | None:
    s = (s or "").strip()
    if len(s) < 10:
        return None
    try:
        return datetime.fromisoformat(s[:10]).date()
    except ValueError:
        return None


def _read_csv_rows(path: Path) -> List[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _iter_result_rows(data_dir: Path, since: date):
    """Yield rows from results_*.csv with date >= since."""
    for year_dir in sorted(data_dir.iterdir()):
        if not year_dir.is_dir() or not year_dir.name.isdigit():
            continue
        year = int(year_dir.name)
        if year < since.year:
            continue
        for f in sorted(year_dir.glob("results_*.csv")):
            file_date_str = f.stem.replace("results_", "")
            fdate = _parse_date(file_date_str)
            if fdate is None or fdate < since:
                continue
            yield fdate, f


# ---------- AUDITS ----------

def _pending_deadline(today):
    spec = importlib.util.spec_from_file_location('results_readiness', Path(__file__).resolve().parents[1] / 'scripts/results_readiness.py')
    timing = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(timing)
    now = datetime.now(timing.HKT)
    return timing.read_pending(today.isoformat(), now) if today == now.date() else None


def verified_cancelled_dates(repo):
    """Only archived official notices with intact SHA and dated wording exempt artefacts."""
    path = repo / 'data/cancellations/verified.json'
    if not path.exists():
        return set()
    rows = json.loads(path.read_text())
    cancelled = set()
    for row in rows:
        raw_path = Path(row['raw_path'])
        if raw_path.is_absolute() or '..' in raw_path.parts or not row['url'].startswith('https://racingnews.hkjc.com/'):
            raise ValueError('Invalid cancellation evidence path or source')
        raw = (repo / raw_path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise ValueError('Cancellation evidence SHA mismatch')
        text = re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', ' ', raw.decode('utf-8')))
        if row['verified_phrase'] not in text or row['venue'] not in ('ST', 'HV'):
            raise ValueError('Cancellation notice identity not verified')
        cancelled.add(date.fromisoformat(row['date']))
    return cancelled


def audit_race_artefacts(repo: Path, fixtures: Set[date], today: date) -> CategoryResult:
    """Each race day in fixtures should have all 5 artefact files (up to today)."""
    r = CategoryResult(name="race_artefacts")
    data = repo / "data"
    cancelled = verified_cancelled_dates(repo)
    past_fixtures = sorted(d for d in fixtures if d <= today and d not in cancelled)
    if cancelled & fixtures:
        r.notes.append('Official cancellation notices verified: ' + ', '.join(sorted(d.isoformat() for d in cancelled & fixtures)))
    r.expected = len(past_fixtures) * len(ARTEFACT_TYPES)
    seen = 0
    missing_days = Counter()
    deadline = _pending_deadline(today)
    for d in past_fixtures:
        year_dir = data / str(d.year)
        for t in ARTEFACT_TYPES:
            f = year_dir / f"{t}_{d.isoformat()}.csv"
            if f.exists() and f.stat().st_size > 0:
                seen += 1
            else:
                if d == today and deadline:
                    r.pending.append(f"{t}_{d.isoformat()}")
                else:
                    r.missing.append(f"{t}_{d.isoformat()}")
                    missing_days[d.isoformat()] += 1
    r.present = seen
    if r.pending:
        r.notes.append(f"same-day artefacts pending until verified final start +30m: {deadline.isoformat()}")
        r.severity = 'warn'
    if r.missing:
        r.severity = "critical" if len(r.missing) > 5 else "warn"
        r.notes.append(f"days with any missing artefact: {len(missing_days)}")
    return r


def audit_fixtures(repo: Path, today: date) -> CategoryResult:
    """Fixture cache must cover current year + should have upcoming 30-day."""
    r = CategoryResult(name="fixtures_cache")
    f = repo / "data" / "fixtures" / "fixtures.csv"
    rows = _read_csv_rows(f)
    dates = {_parse_date(r_["date"]) for r_ in rows if _parse_date(r_["date"])}
    r.expected = 1  # at least must be non-empty
    r.present = len(dates)
    if not dates:
        r.severity = "critical"
        r.missing.append("fixtures.csv is empty")
        return r
    cy = today.year
    has_current_year = any(d.year == cy for d in dates)
    upcoming = [d for d in dates if today <= d <= today + timedelta(days=30)]
    if not has_current_year:
        r.severity = "critical"
        r.missing.append(f"no fixtures for year {cy}")
    if len(upcoming) < 1 and today.month <= 10:  # allow gap in off-season
        r.severity = "warn" if r.severity == "ok" else r.severity
        r.notes.append("no upcoming fixtures in next 30 days")
    r.notes.append(f"total cached race days: {len(dates)}")
    return r


def audit_horse_profiles(repo: Path, today: date) -> tuple[CategoryResult, Set[str]]:
    """Every horse that appeared in recent race_results MUST have a profile."""
    r = CategoryResult(name="horse_profiles")
    since = today - timedelta(days=RECENT_WINDOW_DAYS)
    # horses in recent races
    recent_horses: Set[str] = set()
    first_seen: Dict[str, date] = {}
    for fdate, f in _iter_result_rows(repo / "data", since):
        for row in _read_csv_rows(f):
            hn = (row.get("horse_no") or "").strip()
            # horse_no format like "4" (number) OR horse_name "鐵甲驌龍 (J459)" has the code
            name = (row.get("horse_name") or "")
            # extract code in parens
            if "(" in name and ")" in name:
                code = name[name.rfind("(") + 1 : name.rfind(")")]
                if code:
                    recent_horses.add(code)
                    if code not in first_seen or fdate < first_seen[code]:
                        first_seen[code] = fdate
    # current profile set
    prof_rows = _read_csv_rows(repo / "horses" / "profiles" / "horse_profiles.csv")
    profile_codes: Set[str] = set()
    profile_meta: Dict[str, dict] = {}
    for row in prof_rows:
        name = row.get("name") or ""
        # horse_profiles.csv uses horse_no column which is actually the code
        code = (row.get("horse_no") or "").strip()
        if not code and "(" in name:
            code = name[name.rfind("(") + 1 : name.rfind(")")]
        if code:
            profile_codes.add(code)
            profile_meta[code] = row
    r.expected = len(recent_horses)
    r.present = len(recent_horses & profile_codes)
    missing = recent_horses - profile_codes
    pending_cutoff = today - timedelta(days=SAME_DAY_GRACE_DAYS)
    pending = {c for c in missing if first_seen.get(c) and pending_cutoff <= first_seen[c] <= today}
    r.missing = sorted(missing - pending)
    # stale check (a horse that ran on scan_date is refreshed by tonight's Pool A)
    stale_pending = []
    for code, row in profile_meta.items():
        lrd = _parse_date(row.get("last_race_date", ""))
        pls = _parse_date(row.get("profile_last_scraped", ""))
        if lrd and pls and pls < lrd:
            if pending_cutoff <= lrd <= today:
                stale_pending.append(code)
            else:
                r.stale.append(code)
    if r.missing:
        r.severity = "critical"
        r.notes.append(f"{len(r.missing)} horses raced in last {RECENT_WINDOW_DAYS}d have NO profile")
    if not r.missing and (r.stale or pending or stale_pending):
        r.severity = "warn"
    if r.stale:
        r.notes.append(f"{len(r.stale)} profiles are stale (profile_last_scraped < last_race_date)")
    r.pending = sorted(pending | set(stale_pending))
    if pending:
        r.notes.append(f"{len(pending)} debutants first ran on {today.isoformat()} — profile pending tonight's Pool A (critical if still missing next scan)")
    if stale_pending:
        r.notes.append(f"{len(stale_pending)} profiles ran on {today.isoformat()} — refresh pending tonight's Pool A")
    r.notes.append(f"total profiles in DB: {len(profile_codes)}")
    return r, recent_horses


def audit_horse_form_records(repo: Path, cohort: Set[str], pending_codes: Set[str] = frozenset()) -> CategoryResult:
    """Every horse in recent cohort MUST have a form_records/form_XXXX.csv."""
    r = CategoryResult(name="horse_form_records")
    form_dir = repo / "horses" / "form_records"
    existing = set()
    if form_dir.exists():
        for f in form_dir.glob("form_*.csv"):
            code = f.stem.replace("form_", "")
            existing.add(code)
    r.expected = len(cohort)
    r.present = len(cohort & existing)
    absent = cohort - existing
    # same-day debutants (see SAME_DAY_GRACE_DAYS): pending, not critical yet
    r.pending = sorted(absent & set(pending_codes))
    missing = sorted(absent - set(pending_codes))
    r.missing = missing
    if missing:
        r.severity = "critical"
        r.notes.append(f"{len(missing)} recent-cohort horses have NO form_records file")
    elif r.pending:
        r.severity = "warn"
    if r.pending:
        r.notes.append(f"{len(r.pending)} same-day debutants — form_records pending tonight's Pool A")
    r.notes.append(f"total form_records files: {len(existing)}")
    return r


def audit_jockey_profiles(repo: Path, today: date) -> CategoryResult:
    """Every jockey in recent races MUST have a profile."""
    r = CategoryResult(name="jockey_profiles")
    since = today - timedelta(days=RECENT_WINDOW_DAYS)
    recent_jockeys: Set[str] = set()
    for fdate, f in _iter_result_rows(repo / "data", since):
        for row in _read_csv_rows(f):
            j = (row.get("jockey") or "").strip()
            if j and j.strip("-") and j != "-":
                recent_jockeys.add(j)
    prof_rows = _read_csv_rows(repo / "jockeys" / "jockey_profiles.csv")
    profile_names = {(r_.get("jockey_name") or "").strip() for r_ in prof_rows}
    profile_names.discard("")
    r.expected = len(recent_jockeys)
    r.present = len(recent_jockeys & profile_names)
    missing = sorted(recent_jockeys - profile_names)
    r.missing = missing
    if missing:
        r.severity = "critical"
        r.notes.append(f"{len(missing)} jockeys raced recently but NO profile")
    r.notes.append(f"total jockey profiles: {len(profile_names)}")
    return r


def audit_jockey_records(repo: Path) -> CategoryResult:
    """Every jockey profile should have matching records file."""
    r = CategoryResult(name="jockey_records")
    prof_rows = _read_csv_rows(repo / "jockeys" / "jockey_profiles.csv")
    codes = {(r_.get("jockey_code") or "").strip() for r_ in prof_rows}
    codes.discard("")
    rec_dir = repo / "jockeys" / "records"
    existing = set()
    if rec_dir.exists():
        for f in rec_dir.glob("jockey_*.csv"):
            existing.add(f.stem.replace("jockey_", ""))
    r.expected = len(codes)
    r.present = len(codes & existing)
    missing = sorted(codes - existing)
    r.missing = missing
    if missing:
        r.severity = "warn"
        r.notes.append(f"{len(missing)} jockey profiles have no records file")
    return r


def audit_trainer_profiles(repo: Path, today: date) -> CategoryResult:
    """Every trainer in recent races MUST have a profile."""
    r = CategoryResult(name="trainer_profiles")
    since = today - timedelta(days=RECENT_WINDOW_DAYS)
    recent_trainers: Set[str] = set()
    for fdate, f in _iter_result_rows(repo / "data", since):
        for row in _read_csv_rows(f):
            t = (row.get("trainer") or "").strip()
            if t and t.strip("-") and t != "-":
                recent_trainers.add(t)
    prof_rows = _read_csv_rows(repo / "trainers" / "trainer_profiles.csv")
    profile_names = {(r_.get("trainer_name") or "").strip() for r_ in prof_rows}
    profile_names.discard("")
    r.expected = len(recent_trainers)
    r.present = len(recent_trainers & profile_names)
    missing = sorted(recent_trainers - profile_names)
    r.missing = missing
    if missing:
        r.severity = "critical"
        r.notes.append(f"{len(missing)} trainers active recently but NO profile")
    r.notes.append(f"total trainer profiles: {len(profile_names)}")
    return r


def audit_trainer_records(repo: Path) -> CategoryResult:
    r = CategoryResult(name="trainer_records")
    prof_rows = _read_csv_rows(repo / "trainers" / "trainer_profiles.csv")
    codes = {(r_.get("trainer_code") or "").strip() for r_ in prof_rows}
    codes.discard("")
    rec_dir = repo / "trainers" / "records"
    existing = set()
    if rec_dir.exists():
        for f in rec_dir.glob("trainer_*.csv"):
            existing.add(f.stem.replace("trainer_", ""))
    r.expected = len(codes)
    r.present = len(codes & existing)
    missing = sorted(codes - existing)
    r.missing = missing
    if missing:
        r.severity = "warn"
        r.notes.append(f"{len(missing)} trainer profiles have no records file")
    return r


def audit_trial_results(repo: Path, today: date) -> CategoryResult:
    """Trial results file should exist + be recent."""
    r = CategoryResult(name="trial_results")
    f = repo / "trials" / "trial_results.csv"
    if not f.exists():
        r.severity = "critical"
        r.missing.append("trials/trial_results.csv missing")
        return r
    rows = _read_csv_rows(f)
    r.expected = 1
    r.present = 1 if rows else 0
    if not rows:
        r.severity = "critical"
        r.missing.append("trial_results.csv empty")
    else:
        # check recency — look for trial_date or date column
        date_col = None
        for c in ("trial_date", "date", "試閘日期"):
            if c in rows[0]:
                date_col = c
                break
        if date_col:
            max_d = max(
                (_parse_date(r_[date_col]) for r_ in rows if _parse_date(r_[date_col])),
                default=None,
            )
            if max_d:
                age = (today - max_d).days
                r.notes.append(f"latest trial: {max_d} ({age} days ago)")
                if age > 30:
                    r.severity = "warn"
                    r.notes.append("trial data stale >30d")
    r.notes.append(f"trial rows: {len(rows)}")
    return r


def audit_entries(repo: Path, fixtures: Set[date], today: date) -> CategoryResult:
    """Upcoming race days (today .. +7d) should have entry files."""
    r = CategoryResult(name="entries_upcoming")
    upcoming = sorted(d for d in fixtures if today <= d <= today + timedelta(days=7))
    r.expected = len(upcoming)
    entries_dir = repo / "entries"
    if not entries_dir.exists():
        r.severity = "warn" if upcoming else "ok"
        r.missing = [d.isoformat() for d in upcoming]
        return r
    for d in upcoming:
        # allow several naming conventions
        candidates = [
            entries_dir / f"entries_{d.isoformat()}.txt",
            entries_dir / f"entries_{d.isoformat()}.csv",
            entries_dir / f"racecard_{d.isoformat()}.csv",
        ]
        if any(c.exists() and c.stat().st_size > 0 for c in candidates):
            r.present += 1
        else:
            r.missing.append(d.isoformat())
    if r.missing:
        r.severity = "warn"
        r.notes.append(f"{len(r.missing)} upcoming race days lack entries file")
    return r


# ---------- MAIN ----------

def load_fixtures(repo: Path) -> Set[date]:
    rows = _read_csv_rows(repo / "data" / "fixtures" / "fixtures.csv")
    return {d for r_ in rows if (d := _parse_date(r_.get("date", "")))}


def classify(r: AuditReport) -> None:
    sev_rank = {"ok": 0, "warn": 1, "critical": 2}
    worst = "ok"
    warn_gap = 0
    crit_gap = 0
    for c in r.categories.values():
        if sev_rank[c.severity] > sev_rank[worst]:
            worst = c.severity
        warn_gap += len(c.pending)  # pending is never critical
        if c.severity == "warn":
            warn_gap += c.gap
        elif c.severity == "critical":
            crit_gap += c.gap
    r.overall_severity = worst
    r.warn_gap_count = warn_gap
    r.critical_gap_count = crit_gap
    if worst == "critical":
        if crit_gap > 500:
            r.recommendation = "replit_fallback_required"
        elif crit_gap > 100:
            r.recommendation = "gha_dispatch_backfill"
        else:
            r.recommendation = "gha_next_delta_will_fix"
    elif worst == "warn":
        r.recommendation = "monitor_no_block"
    else:
        r.recommendation = "all_green"


def write_summary_md(repo: Path, r: AuditReport) -> None:
    lines: List[str] = []
    lines.append(f"# Data Integrity Audit · {r.scan_date}")
    lines.append("")
    badge = {"ok": "🟢", "warn": "🟡", "critical": "🔴"}[r.overall_severity]
    lines.append(f"**Overall:** {badge} `{r.overall_severity}`  ·  "
                 f"critical gaps: **{r.critical_gap_count}**  ·  "
                 f"warn gaps: {r.warn_gap_count}")
    lines.append("")
    lines.append(f"**Recommendation:** `{r.recommendation}`")
    lines.append("")
    lines.append("## Per-category")
    lines.append("")
    lines.append("| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for name, c in r.categories.items():
        sev_badge = {"ok": "🟢", "warn": "🟡", "critical": "🔴"}[c.severity]
        notes = "; ".join(c.notes[:2]) if c.notes else ""
        lines.append(
            f"| {name} | {sev_badge} {c.severity} | {c.expected} | {c.present} | "
            f"{len(c.missing)} | {len(c.stale)} | {len(c.pending)} | {notes} |"
        )
    lines.append("")
    # detail for critical
    for name, c in r.categories.items():
        if c.severity == "critical" and (c.missing or c.stale):
            lines.append(f"### 🔴 {name} — sample missing (first 20)")
            lines.append("")
            lines.append("```")
            for x in c.missing[:20]:
                lines.append(str(x))
            lines.append("```")
            lines.append("")
    out = repo / "audit_reports" / "SUMMARY.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo-root", default=".")
    p.add_argument("--today", default=None, help="ISO date override for testing")
    args = p.parse_args()

    repo = Path(args.repo_root).resolve()
    today = _parse_date(args.today) if args.today else date.today()
    assert today is not None

    fixtures = load_fixtures(repo)
    report = AuditReport(scan_date=today.isoformat(), repo_root=str(repo))

    # Run categories
    cat_race = audit_race_artefacts(repo, fixtures, today)
    cat_fix = audit_fixtures(repo, today)
    cat_hp, cohort = audit_horse_profiles(repo, today)
    cat_hf = audit_horse_form_records(repo, cohort, set(cat_hp.pending))
    cat_jp = audit_jockey_profiles(repo, today)
    cat_jr = audit_jockey_records(repo)
    cat_tp = audit_trainer_profiles(repo, today)
    cat_tr = audit_trainer_records(repo)
    cat_tl = audit_trial_results(repo, today)
    cat_en = audit_entries(repo, fixtures, today)

    for c in [cat_race, cat_fix, cat_hp, cat_hf, cat_jp, cat_jr,
              cat_tp, cat_tr, cat_tl, cat_en]:
        report.categories[c.name] = c

    classify(report)

    out_dir = repo / "audit_reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"integrity_{today.isoformat()}.json").write_text(
        report.to_json(), encoding="utf-8"
    )
    (out_dir / "integrity_latest.json").write_text(report.to_json(), encoding="utf-8")
    write_summary_md(repo, report)

    # Stdout summary for CI log
    print(f"[audit] scan_date={today.isoformat()}")
    print(f"[audit] overall={report.overall_severity} "
          f"critical={report.critical_gap_count} warn={report.warn_gap_count} "
          f"recommend={report.recommendation}")
    for name, c in report.categories.items():
        print(f"[audit]   {c.summary()}")

    if report.overall_severity == "critical":
        return 2
    if report.overall_severity == "warn":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
