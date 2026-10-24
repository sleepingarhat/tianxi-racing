"""Read-only cross-repository policy audit. Never print fetched source or credentials."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

OWNER = "sleepingarhat"
REPOS = ("tianxi-racing", "domain-brain", "tianxi-web", "tianxi-research")
POLICY_PATH = "docs/repository-policy.json"
REVIEW = "docs/reviews/repository-consistency-2026-10-24.md"
EXTENSIONS = {".md", ".html", ".tsx", ".ts", ".json"}


def selected(path):
    """Active summaries/presentation only; original research, migrations and legacy excluded."""
    return (path in {"README.md", "backend/README.md", REVIEW}
            or path.startswith("wiki/concepts/") and path.endswith(".md")
            or path.startswith("public/mindmap/") and path.endswith(".html")
            or path.startswith(("src/routes/", "src/components/tx/")) and path.endswith(".tsx")
            or path == "src/lib/freeStage.ts")


def active_text(path, text):
    # Explicit historical heading applies only until the next same/higher heading.
    lines, historical_level = [], None
    for line in text.splitlines():
        heading = re.match(r"^(#{1,6})\s+(.+)", line)
        if heading:
            level, title = len(heading[1]), heading[2]
            if historical_level and level <= historical_level:
                historical_level = None
            if re.search(r"歷史|封存|當時草稿", title):
                historical_level = level
        if historical_level:
            continue
        # Historical changelog entries are dated evidence, not current offers.
        if path.endswith("dev-log.tsx") and re.search(r"\bdate\s*:", line):
            continue
        if re.search(r"已被.{0,30}取代|舊說法|舊句作廢|superseded|下文.{0,50}歷史", line, re.I):
            continue
        lines.append(line)
    return "\n".join(lines)


def text_issues(path, text):
    text = active_text(path, text)
    issues = []
    for match in re.finditer(r"(?:首\s*|創始(?:會員)?(?:名額)?\s*[：:=]?\s*)(\d+)\s*(?:名|人|位)", text):
        context = text[max(0, match.start() - 15):match.end() + 15]
        if int(match[1]) != 200 and re.search(r"會員|註冊|免費|Pro|創始|優惠", context, re.I):
            issues.append("founding_members")
    # Fixed obsolete offers; ordinary model counts and tests are outside this scope.
    if re.search(r"(?:累積|累积|滿|满|達到)\s*500\s*(?:人|名)|500\s*(?:名|人).{0,12}(?:免費|免费|Pro)", text, re.I):
        issues.append("founding_members")
    if re.search(r"(?:滿額|满额|達門檻|达门槛)(?:(?!不|唔|無|未|；|。).){0,8}自動開閘|(?:滿額|满额)(?:(?!不|唔|無|未|；|。).){0,5}(?:即|就)收費", text):
        issues.append("automatic_gate")
    for match in re.finditer(r"HK\$\s*([\d,]+(?:\.\d+)?)\s*[／/]\s*(?:週|星期|week)", text, re.I):
        if float(match[1].replace(",", "")) != 78:
            issues.append("stripe_weekly_hkd")
    for match in re.finditer(r"(?:Crypto|加密(?:貨幣)?).{0,30}?US\$\s*([\d,]+(?:\.\d+)?)\s*[／/]\s*(\d+)\s*週", text, re.I):
        if float(match[1].replace(",", "")) != 416 or int(match[2]) != 52:
            issues.append("crypto_offer")
    if re.search(r"(?:Crypto|加密(?:貨幣)?)(?:(?!不|唔|無|未|；|。|</p>).){0,35}自動續(?:訂|期)", text, re.I):
        issues.append("crypto_auto_renew")
    for match in re.finditer(r"weather-archive-managed.{0,15}每\s*(\d+)\s*分鐘", text):
        if int(match[1]) != 5:
            issues.append("weather_archive_interval")
    for name, expected in [("weather-sync-github-managed", {"23:50"}), ("race-results-dispatch-managed", {"23:31", "01:31"})]:
        for match in re.finditer(re.escape(name) + r"([^\n；。、]{0,90})", text):
            times = set(re.findall(r"\d{2}:\d{2}", match[1]))
            if times and times != expected:
                issues.append(name)
    if re.search(r"23:30.{0,10}主收料|主收料.{0,10}23:30", text) and path != REVIEW:
        issues.append("primary_results_time")
    if path == "src/lib/freeStage.ts":
        constants = {"DEFAULT_PAYWALL_THRESHOLD": 200, "CRYPTO_PASS_PRICE_USD": 416,
                     "CRYPTO_PASS_PRICE_HKD": 3244.8, "PRO_WEEKLY_PRICE_HKD": 78,
                     "FOUNDING_PRO_WEEKS": 52}
        for name, expected in constants.items():
            match = re.search(r"export const " + name + r"\s*=\s*([\d.]+)\s*;", text)
            if not match or float(match[1]) != expected:
                issues.append(name)
    return sorted(set(issues))


def validate_policy(policy, expected):
    # Structural equality checks every concrete number, boolean and cron expression.
    return [] if policy == expected else ["policy_manifest_drift"]


def api(path, token):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "tianxi-policy-audit"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("https://api.github.com" + path, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("GitHub read failed HTTP " + str(error.code)) from None


def inspect_repo(repo, expected, token):
    import base64
    result = {"repo": repo, "commit": None, "checked_files": 0, "issues": []}
    try:
        metadata = api(f"/repos/{OWNER}/{repo}", token)
        branch = metadata["default_branch"]
        ref = api(f"/repos/{OWNER}/{repo}/git/ref/heads/{branch}", token)
        commit = ref["object"]["sha"]
        result["commit"] = commit
        tree = api(f"/repos/{OWNER}/{repo}/git/trees/{commit}?recursive=1", token)
        if tree.get("truncated"):
            raise RuntimeError("Incomplete repository tree")
        files = {entry["path"]: entry for entry in tree["tree"] if entry["type"] == "blob"}
        required = {"README.md", POLICY_PATH, REVIEW}
        for missing in sorted(required - files.keys()):
            result["issues"].append({"path": missing, "rule": "required_file_missing"})
        paths = sorted(p for p in files if selected(p) or p == POLICY_PATH)
        def read(path):
            blob = api(f"/repos/{OWNER}/{repo}/git/blobs/{files[path]['sha']}", token)
            if blob.get("encoding") != "base64" or blob.get("size", 0) > 2_000_000:
                raise RuntimeError("Unsupported or oversized source")
            return path, base64.b64decode(blob["content"]).decode("utf-8-sig")
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for path, text in pool.map(read, paths):
                rules = validate_policy(json.loads(text), expected) if path == POLICY_PATH else text_issues(path, text)
                result["checked_files"] += 1
                result["issues"].extend({"path": path, "rule": rule} for rule in rules)
    except (RuntimeError, KeyError, ValueError, OSError) as error:
        # Do not log upstream response bodies, fetched source or credentials.
        result["issues"].append({"path": "repository", "rule": "read_failed", "reason": type(error).__name__})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="/tmp/repository-consistency.json")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    expected = json.loads((root / POLICY_PATH).read_text())
    token = os.environ.get("REPOSITORY_AUDIT_TOKEN") or os.environ.get("GITHUB_TOKEN")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda repo: inspect_repo(repo, expected, token), REPOS))
    report = {"ok": all(not row["issues"] for row in results), "repositories": results}
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for row in results:
        print(f"{row['repo']} @{row['commit'] or 'unverified'}: {row['checked_files']} files, {len(row['issues'])} issues")
        for issue in row["issues"]:
            print("  " + issue["path"] + ": " + issue["rule"])
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()