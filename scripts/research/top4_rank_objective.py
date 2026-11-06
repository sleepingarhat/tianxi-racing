"""四揀排序目標研究（只讀、只出報告；不寫凍結、預測、模型或戰績）。

問題：主指標係「四揀平均中匹數」。逐匹二元入前四（pointwise）訓練，
對比直接以場內排序為目標（pairwise RankNet、listwise 入前四 softmax）訓練，
四揀中匹數有冇分別？
特徵：沿用 longshot_potential 嘅賽前特徵，但剔除賠率（凍結選馬不用市場）；
  初出馬保留，以 debut 旗標及預設值表示。退出／未完賽唔作樣本。
評估：逐年前推（只用之前年份訓練），每場揀分數最高四匹，計中前四匹數；
  配對 bootstrap 95% 區間（同場比較）。市場（賠率最低四匹）只作對照。
用法：python3 scripts/research/top4_rank_objective.py [--out report.json]
"""
import json, math, os, random, sys
from collections import defaultdict
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import longshot_potential as L

FEATS = [f for f in L.FEATURES if f != "log_odds"] + ["debut"]


def rows_all():
    rows = L.build_rows()
    for r in rows:
        r["debut"] = 0.0
    return rows


def group(rows):
    g = defaultdict(list)
    for r in rows:
        g[r["race"]].append(r)
    return [v for v in g.values() if len(v) >= 6 and sum(x["top4"] for x in v) >= 3]


def mats(races, mu=None, sd=None):
    X = [np.array([[r[f] for f in FEATS] for r in v], dtype=float) for v in races]
    if mu is None:
        A = np.vstack(X); mu, sd = A.mean(0), A.std(0) + 1e-9
    return [(x - mu) / sd for x in X], [np.array([r["top4"] for r in v], float) for v in races], mu, sd


def fit(X, Y, kind, iters=300, lr=0.3, l2=1e-3):
    w = np.zeros(X[0].shape[1]); b = 0.0
    for _ in range(iters):
        g = np.zeros_like(w); gb = 0.0; n = 0
        for x, y in zip(X, Y):
            s = x @ w + b
            if kind == "pointwise":
                p = 1 / (1 + np.exp(-s)); e = p - y
                g += x.T @ e; gb += e.sum(); n += len(y)
            elif kind == "listwise":
                p = np.exp(s - s.max()); p /= p.sum(); t = y / y.sum()
                g += x.T @ (p - t); n += 1
            else:  # pairwise RankNet：前四 vs 非前四
                pos, neg = y == 1, y == 0
                d = s[pos][:, None] - s[neg][None, :]
                c = -1 / (1 + np.exp(d))
                g += x[pos].T @ c.sum(1) - x[neg].T @ c.sum(0); n += c.size
        w -= lr * (g / n + l2 * w); b -= lr * gb / max(n, 1)
    return w, b


def hits(x, y, w, b):
    return float(y[np.argsort(-(x @ w + b))[:4]].sum())


def main():
    rows = rows_all()
    years = sorted({r["date"].year for r in rows})
    start = int(os.environ.get("TEST_FROM", "2018"))
    kinds = ["pointwise", "pairwise", "listwise"]
    pooled = {k: [] for k in kinds + ["market"]}
    rep = {"features": FEATS, "years": []}
    for yr in [y for y in years if y >= start]:
        tr = group([r for r in rows if r["date"].year < yr and r["date"].year >= yr - 6])
        te = group([r for r in rows if r["date"].year == yr])
        if len(tr) < 1000 or len(te) < 100:
            continue
        Xtr, Ytr, mu, sd = mats(tr)
        Xte, Yte, _, _ = mats(te, mu, sd)
        yrep = {"year": yr, "trainRaces": len(tr), "testRaces": len(te)}
        for k in kinds:
            w, b = fit(Xtr, Ytr, k)
            h = [hits(x, y, w, b) for x, y in zip(Xte, Yte)]
            pooled[k] += h; yrep[k] = round(sum(h) / len(h), 3)
        mk = [float(sum(r["top4"] for r in sorted(v, key=lambda r: r["odds"])[:4])) for v in te]
        pooled["market"] += mk; yrep["marketRef"] = round(sum(mk) / len(mk), 3)
        rep["years"].append(yrep); print(yrep, flush=True)
    rnd = random.Random(20261106)
    def ci(a, b):
        d = [x - y for x, y in zip(a, b)]
        bs = sorted(sum(rnd.choice(d) for _ in d) / len(d) for _ in range(2000))
        return {"mean": round(sum(d) / len(d), 4), "ci95": [round(bs[50], 4), round(bs[1949], 4)], "races": len(d)}
    rep["avgHits"] = {k: round(sum(v) / len(v), 4) for k, v in pooled.items()}
    rep["pairedVsPointwise"] = {k: ci(pooled[k], pooled["pointwise"]) for k in ["pairwise", "listwise"]}
    rep["note"] = "研究報告；只用賽前紀錄、不用賠率；市場欄只作對照；不改四揀、凍結或戰績，升唔升由用戶決定。"
    out = json.dumps(rep, ensure_ascii=False, indent=1)
    if "--out" in sys.argv:
        open(sys.argv[sys.argv.index("--out") + 1], "w").write(out)
    print(out)


if __name__ == "__main__":
    main()
