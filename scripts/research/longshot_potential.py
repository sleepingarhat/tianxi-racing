"""冷門潛力研究（只讀、只出報告；不寫凍結、預測、模型或戰績）。

問題：獨贏 >=20 倍嘅馬，用「賽前已知」官方資料，能否揀出較易入前四嘅一批？
資料：horses/form_records（逐匹往績）、trials/trial_results.csv（試閘）。
賽前時間核實：每個特徵只用嚴格早於該場日期嘅紀錄（試閘／往績日期 < 賽日）。
評估：按年份逐年前推（只用之前年份訓練），每場冷門馬按模型分數排名，
  比較「模型第一」vs「冷門入面賠率最低」（市場基準）嘅入前四率、
  同埋 $10 獨贏注回報（只用往績已有獨贏賠率；位置派彩未收，唔計）。
用法：python3 scripts/research/longshot_potential.py [--out report.json]
"""
import csv
import glob
import json
import math
import os
import random
import sys
from collections import defaultdict
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LONGSHOT = 20.0
FEATURES = [
    "log_odds", "days_since", "last_place", "last_lbw", "last3_avg_place", "wt_change", "rating_change",
    "gear_changed", "class_drop", "runs_count", "trial_30d", "trial_best_pos", "trial_pass", "long_rest_with_trial",
]


def d(s):
    s = (s or "").strip()
    for f in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, f)
        except ValueError:
            pass
    return None


def num(s):
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return None


def lbw(s):
    s = (s or "").strip().upper()
    if not s or s in ("-", "---"):
        return 0.0
    words = {"NOSE": 0.05, "SH": 0.1, "HD": 0.2, "N": 0.3, "鼻位": 0.05, "短馬頭位": 0.1, "馬頭位": 0.2, "頸位": 0.3}
    if s in words:
        return words[s]
    tot = 0.0
    for part in s.replace("-", " ").split():
        if "/" in part:
            a, b = part.split("/", 1)
            if num(a) is not None and num(b):
                tot += num(a) / num(b)
        elif num(part) is not None:
            tot += num(part)
    return min(tot, 30.0)


def load_trials():
    by = defaultdict(list)
    path = os.path.join(ROOT, "trials", "trial_results.csv")
    if not os.path.exists(path):
        return by
    with open(path, encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            dt = d(r.get("trial_date"))
            if dt and r.get("horse_no"):
                pos = (r.get("running_position") or "").split()
                by[r["horse_no"]].append((dt, num(pos[-1]) if pos else None, (r.get("result") or "").strip() == "及格"))
    return by


def build_rows():
    trials = load_trials()
    rows = []
    for path in glob.glob(os.path.join(ROOT, "horses", "form_records", "form_*.csv")):
        with open(path, encoding="utf-8-sig") as fh:
            recs = [r for r in csv.DictReader(fh)]
        runs = []
        for r in recs:
            dt, place, odds = d(r.get("date")), num(r.get("place")), num(r.get("win_odds"))
            if not dt or odds is None or odds <= 1:
                continue
            runs.append((dt, place, odds, r))
        runs.sort(key=lambda x: x[0])
        for i, (dt, place, odds, r) in enumerate(runs):
            prior = [x for x in runs[:i] if x[0] < dt]
            if not prior:
                continue  # 初出馬冇往績，另研究
            if place is None or not (1 <= place <= 98):
                continue  # 退出／未完賽唔作樣本
            last = prior[-1]
            lr = last[3]
            completed = [x[1] for x in prior if x[1] and 1 <= x[1] <= 98]
            tr = [t for t in trials.get(r["horse_no"], []) if t[0] < dt and (dt - t[0]).days <= 30]
            days = (dt - last[0]).days
            wt_now, wt_last = num(r.get("declared_wt_lbs")), num(lr.get("declared_wt_lbs"))
            rt_now, rt_last = num(r.get("rating")), num(lr.get("rating"))
            cl_now, cl_last = num(r.get("race_class")), num(lr.get("race_class"))
            rows.append({
                "date": dt, "race": (dt.strftime("%Y-%m-%d"), r.get("racecourse"), r.get("race_index")),
                "odds": odds, "top4": 1 if place <= 4 else 0, "win": 1 if place == 1 else 0,
                "log_odds": math.log(odds), "days_since": min(days, 400) / 100,
                "last_place": (last[1] or 14) / 14, "last_lbw": lbw(lr.get("lbw")) / 10,
                "last3_avg_place": (sum(completed[-3:]) / len(completed[-3:]) if completed else 14) / 14,
                "wt_change": ((wt_now - wt_last) / 20) if wt_now and wt_last else 0.0,
                "rating_change": ((rt_now - rt_last) / 10) if rt_now is not None and rt_last is not None else 0.0,
                "gear_changed": 1.0 if (r.get("gear") or "").strip() != (lr.get("gear") or "").strip() else 0.0,
                "class_drop": 1.0 if cl_now and cl_last and cl_now > cl_last else 0.0,
                "runs_count": min(len(prior), 40) / 40,
                "trial_30d": min(len(tr), 3) / 3,
                "trial_best_pos": (min([t[1] for t in tr if t[1]] or [14])) / 14,
                "trial_pass": 1.0 if any(t[2] for t in tr) else 0.0,
                "long_rest_with_trial": 1.0 if days >= 90 and tr else 0.0,
            })
    return rows


def fit_logit(X, y, l2=1.0, iters=400, lr=0.5):
    w = np.zeros(X.shape[1] + 1)
    Xb = np.hstack([X, np.ones((len(X), 1))])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Xb @ w))
        g = Xb.T @ (p - y) / len(y) + l2 * np.r_[w[:-1], 0] / len(y)
        w -= lr * g
    return w


def score(w, X):
    return 1 / (1 + np.exp(-(np.hstack([X, np.ones((len(X), 1))]) @ w)))


def evaluate(rows):
    ls = [r for r in rows if r["odds"] >= LONGSHOT]
    years = sorted({r["date"].year for r in ls})
    report = {"longshotRows": len(ls), "baseTop4Rate": round(sum(r["top4"] for r in ls) / max(len(ls), 1), 4), "years": []}
    pooled = {"model": [], "market": []}
    for y in years[3:]:
        tr = [r for r in ls if r["date"].year < y]
        te = [r for r in ls if r["date"].year == y]
        if len(tr) < 2000 or len(te) < 200:
            continue
        X = np.array([[r[f] for f in FEATURES] for r in tr]); mu, sd = X.mean(0), X.std(0) + 1e-9
        w = fit_logit((X - mu) / sd, np.array([r["top4"] for r in tr], dtype=float))
        Xt = (np.array([[r[f] for f in FEATURES] for r in te]) - mu) / sd
        for r, s in zip(te, score(w, Xt)):
            r["_s"] = float(s)
        races = defaultdict(list)
        for r in te:
            races[r["race"]].append(r)
        m_pick = [max(v, key=lambda r: r["_s"]) for v in races.values()]
        b_pick = [min(v, key=lambda r: r["odds"]) for v in races.values()]
        def summ(p):
            return {"races": len(p), "top4Rate": round(sum(r["top4"] for r in p) / len(p), 4),
                    "winRoi": round(sum((r["odds"] * 10 if r["win"] else 0) - 10 for r in p) / (10 * len(p)), 4)}
        pooled["model"] += [r["top4"] for r in m_pick]; pooled["market"] += [r["top4"] for r in b_pick]
        coef = dict(zip(FEATURES, [round(float(c), 3) for c in w[:-1]]))
        report["years"].append({"year": y, "train": len(tr), "test": len(te), "modelPick": summ(m_pick), "marketPick": summ(b_pick), "coef": coef})
    diff = [a - b for a, b in zip(pooled["model"], pooled["market"])]
    if diff:
        rnd = random.Random(20261106)
        boots = sorted(sum(rnd.choice(diff) for _ in diff) / len(diff) for _ in range(3000))
        report["pairedTop4RateDiff"] = {"mean": round(sum(diff) / len(diff), 4), "ci95": [round(boots[75], 4), round(boots[2924], 4)], "races": len(diff)}
    report["note"] = "研究報告；只用賽前紀錄；位置派彩未收所以只計獨贏回報；不改四揀、凍結或戰績，升唔升由用戶決定。"
    return report


if __name__ == "__main__":
    rep = evaluate(build_rows())
    out = json.dumps(rep, ensure_ascii=False, indent=1)
    if "--out" in sys.argv:
        open(sys.argv[sys.argv.index("--out") + 1], "w").write(out)
    print(out)
