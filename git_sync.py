"""
git_sync.py — Push accumulated CSV data from prod ephemeral disk to GitHub.

Usage:
  Standalone (Step A — manual one-shot, runs in prod console):
      python git_sync.py
      python git_sync.py --message "manual phase1+2 backfill"

  Library (Step B — called at end of RunAll_Scrapers.py):
      from git_sync import push_data_safely
      push_data_safely(stats={"horses": 4119, "entries": 159, "results": 11})

Environment:
  GH_TOKEN   — GitHub Personal Access Token (scope: repo)
               Required to push from prod. Stored in Replit Secrets.

Behaviour:
  - Tracks: horses/, entries/, trial_data/, results/, jockeys/, trainers/
  - Skips push if `git diff --quiet` reports no changes.
  - Commit author: 天喜 Bot <bot@tianxi.ai>
  - Commit message format:
        [data][skip ci] RunAll YYYY-MM-DDTHH:MMZ · Nh Me Rr Tt
  - 3-retry with exponential backoff (5s, 15s, 45s).
  - Never raises — any push failure is logged and swallowed so RunAll
    keeps running. Failures are visible via [DATA-SYNC] log lines.
  - Writes last_sync.json on success.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DATA_DIRS = ["horses", "entries", "trials", "results", "jockeys", "trainers", "data"]
LAST_SYNC_FILE = "last_sync.json"
GIT_USER_NAME = "天喜 Bot"
GIT_USER_EMAIL = "bot@tianxi.ai"
REPO_PATH = "sleepingarhat/hkjc-horse-racing-results"  # legacy fallback when GITHUB_REPOSITORY is unset
# Tracked side file written by the pool-a merge. It is not under DATA_DIRS, so
# leaving it unstaged makes `git rebase` refuse with "unstaged changes" after a
# non-fast-forward push (capy_pool_a 2026-11-10, run 42743435880).
EXTRA_COMMIT_FILES = ["audit_reports/horse_profile_coverage_latest.json"]
REBASE_COMMAND = ["git", "rebase", "--autostash", "origin/main"]


def repo_path() -> str:
    """Repo the workflow checked out. Actions sets GITHUB_REPOSITORY."""
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if repo.count("/") == 1 and " " not in repo:
        return repo
    return REPO_PATH


def files_to_commit(existing_dirs: list[str]) -> list[str]:
    extra = [path for path in EXTRA_COMMIT_FILES if os.path.exists(path)]
    return existing_dirs + extra
RETRY_DELAYS = [5, 15, 45]


def _log(msg: str) -> None:
    print(f"[DATA-SYNC] {msg}", flush=True)


def _run(cmd, check=True, capture=False):
    """Run a shell command list. Returns CompletedProcess."""
    return subprocess.run(
        cmd, check=check, text=True,
        capture_output=capture,
    )


def _has_changes(paths) -> bool:
    """True if there is anything new/modified to push for `paths`.

    Combines two checks (both are robust regardless of whether files are
    gitignored or whether the parent dirs were previously tracked):

      1. `git ls-files -o -- <paths>`  (no --exclude-standard, so ignored
         untracked files are included) — picks up brand-new data files.
      2. `git status --porcelain -- <paths>` — picks up modifications to
         already-tracked files.

    Logs git's own stderr if anything goes wrong (e.g. .git missing).
    """
    existing = [p for p in paths if os.path.exists(p)]
    if not existing:
        return False
    try:
        new_p = subprocess.run(
            ["git", "ls-files", "-o", "--", *existing],
            text=True, capture_output=True, check=False,
        )
        mod_p = subprocess.run(
            ["git", "status", "--porcelain", "--", *existing],
            text=True, capture_output=True, check=False,
        )
    except FileNotFoundError:
        _log("`git` binary not found — cannot detect changes.")
        return False
    if new_p.returncode != 0:
        _log(f"git ls-files failed (rc={new_p.returncode}): {new_p.stderr.strip()[:200]}")
    if mod_p.returncode != 0:
        _log(f"git status failed (rc={mod_p.returncode}): {mod_p.stderr.strip()[:200]}")
    has = bool(new_p.stdout.strip()) or bool(mod_p.stdout.strip())
    if not has:
        _log(f"  ls-files-out=0  status-out=0  paths={existing}")
    else:
        n_new = len(new_p.stdout.splitlines())
        n_mod = len(mod_p.stdout.splitlines())
        _log(f"  detected {n_new} new + {n_mod} modified paths")
    return has


def _ensure_git_repo() -> bool:
    """Ensure CWD is a usable git repo. If `.git/` is missing (Replit
    Reserved VM may not deploy hidden dirs), bootstrap one and connect to
    GitHub so subsequent add/commit/push work. Returns True on success."""
    if os.path.isdir(".git"):
        return True
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        _log("No .git/ and no GH_TOKEN — cannot bootstrap repo.")
        return False
    _log("No .git/ on disk — bootstrapping repo and connecting to GitHub...")
    url = f"https://x-access-token:{token}@github.com/{repo_path()}.git"
    try:
        subprocess.run(["git", "init", "-q"], check=True)
        subprocess.run(
            ["git", "config", "user.name", GIT_USER_NAME],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.email", GIT_USER_EMAIL],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "remote", "add", "origin", url],
            check=True, capture_output=True,
        )
        # Fetch main so we can build commits on top of remote history.
        subprocess.run(
            ["git", "fetch", "origin", "main", "--depth=1"],
            check=True, capture_output=True, text=True, timeout=120,
        )
        # Point local `main` at origin/main and switch HEAD to it WITHOUT a
        # checkout — prod disk already contains tracked files (shipped by
        # the deploy) and `git checkout` would refuse to overwrite them.
        subprocess.run(
            ["git", "update-ref", "refs/heads/main", "origin/main"],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
            check=True, capture_output=True,
        )
        # Populate the index from HEAD so future `git add` produces correct
        # diffs (without --mixed, the index is empty and every tracked file
        # would appear as a deletion).
        subprocess.run(
            ["git", "reset", "--mixed", "-q"],
            check=True, capture_output=True,
        )
        _log("Repo bootstrap OK (branch=main, tracking origin, working tree intact).")
        return True
    except subprocess.CalledProcessError as e:
        _log(f"Repo bootstrap failed: {e.stderr.decode() if isinstance(e.stderr, bytes) else e.stderr}")
        return False
    except Exception as e:
        _log(f"Repo bootstrap unexpected error: {e}")
        return False


def _count_stats() -> dict:
    """Count files per data directory for the commit message."""
    stats = {}
    if os.path.isdir("horses/profiles"):
        try:
            import pandas as pd
            df = pd.read_csv("horses/profiles/horse_profiles.csv")
            stats["horses"] = len(df)
        except Exception:
            stats["horses"] = sum(1 for _ in Path("horses/form_records").glob("form_*.csv")) \
                if os.path.isdir("horses/form_records") else 0
    if os.path.isdir("entries"):
        stats["entries"] = sum(
            1 for f in Path("entries").glob("entries_*.txt")
        )
    if os.path.isdir("results"):
        stats["results"] = sum(1 for _ in Path("results").glob("*.csv"))
    if os.path.isdir("trial_data"):
        stats["trials"] = sum(1 for _ in Path("trial_data").glob("*.csv"))
    return stats


def _format_message(stats: dict, override: str | None = None) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    if override:
        return f"[data][skip ci] {ts} · {override}"
    parts = []
    if "horses" in stats:  parts.append(f"{stats['horses']}h")
    if "entries" in stats: parts.append(f"{stats['entries']}e")
    if "results" in stats: parts.append(f"{stats['results']}r")
    if "trials" in stats:  parts.append(f"{stats['trials']}t")
    return f"[data][skip ci] RunAll {ts} · {' '.join(parts) or 'no-stats'}"


def _ensure_remote_with_token(token: str) -> None:
    """Set origin URL to embed PAT for push auth. Idempotent."""
    url = f"https://x-access-token:{token}@github.com/{repo_path()}.git"
    subprocess.run(
        ["git", "remote", "set-url", "origin", url],
        check=True, text=True, capture_output=True,
    )


def _ensure_identity() -> None:
    subprocess.run(
        ["git", "config", "user.name", GIT_USER_NAME],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.email", GIT_USER_EMAIL],
        check=True, capture_output=True,
    )


def _write_last_sync(stats: dict) -> None:
    payload = {
        "synced_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats": stats,
    }
    with open(LAST_SYNC_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def push_data_safely(stats: dict | None = None,
                     message_override: str | None = None,
                     dry_run: bool = False) -> bool:
    """Add → commit → push data dirs. Never raises. Returns True on success."""
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        _log("GH_TOKEN missing — skipping push (data stays local only).")
        return False

    if not _ensure_git_repo():
        _log("Cannot proceed without a usable .git/ repo.")
        return False

    if not _has_changes(DATA_DIRS + [LAST_SYNC_FILE]):
        _log("No data changes to push.")
        return True

    stats = stats or _count_stats()
    msg = _format_message(stats, message_override)

    if dry_run:
        _log(f"[DRY-RUN] would commit: {msg}")
        return True

    try:
        _ensure_identity()
        existing_dirs = [d for d in DATA_DIRS if os.path.exists(d)]
        # -f because data dirs (horses/, entries/, results/, ...) are
        # gitignored to prevent dev redeploys from overwriting prod data.
        subprocess.run(
            ["git", "add", "-f", "--"] + files_to_commit(existing_dirs), check=True,
        )
        # Refresh last_sync.json after add so it gets included next push cycle.
        _write_last_sync(stats)
        subprocess.run(["git", "add", "-f", LAST_SYNC_FILE], check=True)

        # Empty commit guard (e.g. all changes were ignored).
        diff = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
        ).returncode
        if diff == 0:
            _log("Nothing staged after add — skipping commit.")
            return True

        subprocess.run(
            ["git", "commit", "-m", msg],
            check=True,
        )
        _log(f"Commit ready: {msg}")
    except subprocess.CalledProcessError as e:
        _log(f"Commit step failed: {e}; aborting push.")
        return False

    _ensure_remote_with_token(token)

    last_err = None
    for attempt, delay in enumerate([0] + RETRY_DELAYS):
        if delay:
            _log(f"Retrying push in {delay}s (attempt {attempt + 1})...")
            time.sleep(delay)
            # Concurrent pushes (parallel GHA workflows) can win the race and
            # reject ours with non-fast-forward. Rebase our local commit onto
            # the latest remote main before each retry so a one-shot job does
            # not lose data.
            stashed = False
            try:
                dirty = subprocess.run(
                    ["git", "status", "--porcelain"],
                    capture_output=True, text=True, check=False,
                )
                if dirty.stdout.strip():
                    _log("stashing leftover tracked edits before rebase: "
                         + " | ".join(dirty.stdout.splitlines()[:6]))
                    stashed_run = subprocess.run(
                        ["git", "stash", "push", "-u", "-m", "git-sync-pre-rebase"],
                        capture_output=True, text=True, check=False,
                    )
                    stashed = stashed_run.returncode == 0
                    if not stashed:
                        _log(f"stash skipped: {(stashed_run.stderr or stashed_run.stdout)[:200]}")
                subprocess.run(["git", "fetch", "origin", "main"],
                               check=True, capture_output=True, text=True, timeout=120)
                subprocess.run(REBASE_COMMAND,
                               check=True, capture_output=True, text=True, timeout=120)
                _log("Rebased onto latest origin/main.")
            except subprocess.CalledProcessError as re:
                _log(f"Rebase failed (attempt {attempt + 1}): {(re.stderr or str(re))[:300]}")
                subprocess.run(["git", "rebase", "--abort"], capture_output=True)
            finally:
                if stashed:
                    popped = subprocess.run(
                        ["git", "stash", "pop"],
                        capture_output=True, text=True, check=False,
                    )
                    if popped.returncode != 0:
                        _log(f"stash pop left conflicts; commit is still rebased: {(popped.stderr or popped.stdout)[:200]}")
        try:
            subprocess.run(
                ["git", "push", "origin", "HEAD:main"],
                check=True, capture_output=True, text=True, timeout=300,
            )
            _log("Push succeeded.")
            return True
        except subprocess.CalledProcessError as e:
            last_err = e.stderr or str(e)
        except subprocess.TimeoutExpired:
            last_err = "push timed out after 5min"
    _log(f"Push failed after {len(RETRY_DELAYS) + 1} attempts: {last_err}")
    _log("Commit is preserved locally; next RunAll will retry the push.")
    return False


def _cli() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Push HKJC scraper data to GitHub.")
    ap.add_argument("--message", help="Override commit suffix.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    ok = push_data_safely(message_override=args.message, dry_run=args.dry_run)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(_cli())
