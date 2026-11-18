#!/usr/bin/env python3
"""Research only: barrier-trial prior for first-time (debut) runners.

Question: the engine almost never picks debut runners (2026-09-16→11-14: 1 of 97 seeded
debutants picked, 26 finished top four). Do official HKJC barrier trials carry pre-race
signal that could give debutants a better starting estimate?

Inputs (all public, all read-only):
  data/YYYY/results_*.csv        official results (identity = brand code in horse_name)
  trials/trial_results.csv       official barrier trials (2025-03-13 onwards)
  <pl_dir>/*.jsonl               engine prediction_log rows (baseline v12) dumped read-only

Leakage guards: trial, jockey and trainer evidence strictly before race date; debut model
for validation trained to 2026-04-30, for the test window trained to 2026-07-31; the swap
margin is chosen on validation and applied once to the test window. No production writes,
no change to frozen records; market odds are not used.

Usage: python3 debut_trial_prior.py <repo_root> <pl_dir> <out_json>
"""
import csv, glob, json, math, os, re, sys
from collections import defaultdict
import numpy as np

ROOT, PL_DIR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
CODE = re.compile(r"\(([A-Z]\d{3})\)")
RNG = np.random.default_rng(20261118)
TRAIN_FROM = "2025-07-01"
VAL_FROM, VAL_TO = "2026-05-01", "2026-07-31"
TEST_FROM, TEST_TO = "2026-09-01", "2026-11-14"

def place_of(s):
    m = re.match(r"\s*(\d+)", s or "")
    return int(m.group(1)) if m else None

def class_num(s):
    s = s or ""
    for k, v in (("第一班", 1), ("第二班", 2), ("第三班", 3), ("第四班", 4), ("第五班", 5)):
        if k in s: return v
    if "新馬" in s or "Griffin" in s: return 5
    if "一級" in s or "二級" in s or "三級" in s: return 1
    return 3

# ── results ──────────────────────────────────────────────────────────────
runs = []  # dict(date, race, code, place, draw, field, cls, jockey, trainer, wt)
for f in sorted(glob.glob(os.path.join(ROOT, "data", "*", "results_*.csv"))):
    rows = list(csv.DictReader(open(f, encoding="utf-8-sig")))
    by_race = defaultdict(list)
    for r in rows:
        m = CODE.search(r.get("horse_name", ""))
        if not m: continue
        by_race[(r["date"], int(r["race_no"]))].append((r, m.group(1)))
    for (d, rn), lst in by_race.items():
        started = [x for x in lst if not re.match(r"\s*(WV|WX|W)\b", x[0].get("place") or "")]
        for r, code in started:
            try: draw = int(r.get("draw") or 0)
            except ValueError: draw = 0
            try: wt = float(r.get("actual_wt_lbs") or 0)
            except ValueError: wt = 0.0
            runs.append(dict(date=d, race=rn, code=code, place=place_of(r.get("place")), draw=draw,
                             field=len(started), cls=class_num(r.get("race_class")), jockey=r.get("jockey", ""),
                             trainer=r.get("trainer", ""), wt=wt))
runs.sort(key=lambda x: (x["date"], x["race"]))
first = {}
for r in runs: first.setdefault(r["code"], r["date"])
result_place = {(r["date"], r["race"], r["code"]): r["place"] for r in runs}
started_set = set(result_place)

# prior-date jockey / trainer rates (strictly before race date)
def prior_rates(key, only_debut=False):
    out = {}; hist = defaultdict(lambda: [0, 0]); day_buf = []; cur = None
    for r in runs:
        if r["date"] != cur:
            for k, hit in day_buf:
                hist[k][0] += 1; hist[k][1] += hit
            day_buf = []; cur = r["date"]
        k = r[key]
        out[(r["date"], r["race"], r["code"])] = tuple(hist[k])
        if r["place"] is None: continue
        if only_debut and first[r["code"]] != r["date"]: continue
        day_buf.append((k, 1 if r["place"] <= 4 else 0))
    return out
jk = prior_rates("jockey"); tr_deb = prior_rates("trainer", only_debut=True); tr_all = prior_rates("trainer")

# ── trials ───────────────────────────────────────────────────────────────
def secs(t):
    p = (t or "").split(".")
    try:
        return int(p[0]) * 60 + int(p[1]) + int(p[2]) / 100 if len(p) == 3 else None
    except ValueError: return None
groups = defaultdict(list)
for r in csv.DictReader(open(os.path.join(ROOT, "trials", "trial_results.csv"), encoding="utf-8-sig")):
    dd, mm, yy = r["trial_date"].split("/")
    groups[(f"{yy}-{mm}-{dd}", r["trial_venue"], r["group_no"])].append(r)
trials = defaultdict(list)  # code → [(date, pos_pct, behind, failed, won)]
for (d, venue, g), lst in groups.items():
    win_t = secs(lst[0]["finish_time"]); n = len(lst)
    for i, r in enumerate(lst):
        t = secs(r["finish_time"])
        behind = min(5.0, max(0.0, t - win_t)) if (t is not None and win_t is not None) else None
        trials[r["horse_no"]].append((d, i / max(1, n - 1), behind, r["result"] == "不及格", i == 0))
for v in trials.values(): v.sort()

FEATS = ["n_trials", "last_pos_pct", "last_behind", "best_pos_pct3", "mean_behind3", "log_days_last",
         "no_trial", "last_failed", "last_won", "field", "draw_pct", "cls", "jockey_rate", "trainer_debut_rate", "trainer_rate", "wt"]

def features(date, race, code, draw, field, cls, wt):
    tl = [t for t in trials.get(code, []) if t[0] < date][-6:]
    n = len(tl)
    if n:
        last = tl[-1]; l3 = tl[-3:]
        days = (np.datetime64(date) - np.datetime64(last[0])).astype(int)
        behinds = [x[2] for x in l3 if x[2] is not None]
        f = [n, last[1], last[2] if last[2] is not None else 2.0, min(x[1] for x in l3),
             float(np.mean(behinds)) if behinds else 2.0, math.log1p(min(120, max(0, days))), 0, int(last[3]), int(last[4])]
    else:
        f = [0, 0.5, 2.0, 0.5, 2.0, math.log1p(120), 1, 0, 0]
    key = (date, race, code)
    js, jh = jk.get(key, (0, 0)); ts, th = tr_deb.get(key, (0, 0)); as_, ah = tr_all.get(key, (0, 0))
    f += [field, (draw - 1) / max(1, field - 1) if draw else 0.5, cls,
          (jh + 0.30 * 50) / (js + 50), (th + 0.27 * 10) / (ts + 10), (ah + 0.30 * 50) / (as_ + 50), wt]
    return f

# ── debut dataset ────────────────────────────────────────────────────────
deb = []
for r in runs:
    if first[r["code"]] != r["date"] or r["date"] < TRAIN_FROM or r["place"] is None: continue
    deb.append(dict(date=r["date"], race=r["race"], code=r["code"], y=1 if r["place"] <= 4 else 0,
                    x=features(r["date"], r["race"], r["code"], r["draw"], r["field"], r["cls"], r["wt"])))

def fit(rows, lam=1.0):
    X = np.array([r["x"] for r in rows], float); y = np.array([r["y"] for r in rows], float)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd]); w = np.zeros(Z.shape[1])
    for _ in range(50):
        p = 1 / (1 + np.exp(-Z @ w)); g = Z.T @ (p - y) + lam * np.r_[0, w[1:]]
        H = (Z * (p * (1 - p))[:, None]).T @ Z + lam * np.diag(np.r_[0, np.ones(len(w) - 1)])
        step = np.linalg.solve(H, g); w -= step
        if np.abs(step).max() < 1e-8: break
    return dict(w=w, mu=mu, sd=sd)

def predict(m, x):
    z = np.r_[1, (np.array(x, float) - m["mu"]) / m["sd"]]
    return float(1 / (1 + math.exp(-(z @ m["w"]))))

def auc(p, y):
    p = np.array(p); y = np.array(y); pos = p[y == 1]; neg = p[y == 0]
    if not len(pos) or not len(neg): return None
    return float(((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()))

def logloss(p, y):
    p = np.clip(np.array(p), 1e-6, 1 - 1e-6); y = np.array(y)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())

m_val = fit([r for r in deb if r["date"] < VAL_FROM])
m_test = fit([r for r in deb if r["date"] <= VAL_TO])

# ── engine logs → Plackett-Luce top-4 probabilities ──────────────────────
races = defaultdict(list)
for f in sorted(glob.glob(os.path.join(PL_DIR, "*.jsonl"))):
    for line in open(f):
        if not line.startswith("{"): continue
        r = json.loads(line); code = str(r["horse_id"]).replace("horse_", "")
        races[(r["date"], int(r["race_number"]))].append(dict(code=code, rank=r["predicted_rank"], p=r["p_win"] or 0.0,
                                                                draw=r.get("horse_number")))
def top4_prob(ps, n_sim=20000):
    p = np.array(ps, float); p = np.where(p > 0, p, 1e-6); p = p / p.sum()
    g = np.log(p)[None, :] + RNG.gumbel(size=(n_sim, len(p)))
    k = min(4, len(p)); idx = np.argpartition(-g, k - 1, axis=1)[:, :k]
    cnt = np.zeros(len(p))
    np.add.at(cnt, idx.ravel(), 1)
    return cnt / n_sim

race_meta = {}
for r in runs: race_meta[(r["date"], r["race"], r["code"])] = r
evals = []
for (d, rn), lst in sorted(races.items()):
    if not any((d, rn, x["code"]) in started_set for x in lst): continue  # cancelled / unsettled race
    lst = [x for x in lst if x["rank"] is not None]
    if len(lst) < 5: continue
    p4 = top4_prob([x["p"] for x in lst])
    field = sum(1 for x in lst if (d, rn, x["code"]) in started_set)
    for x, q in zip(lst, p4):
        x["p4_engine"] = float(q)
        x["debut"] = first.get(x["code"], "9999") >= d  # never ran before this date (incl. late scratch)
        meta = race_meta.get((d, rn, x["code"]))
        pl = result_place.get((d, rn, x["code"]))
        x["hit"] = 1 if (pl is not None and pl <= 4) else 0
        if x["debut"]:
            draw = meta["draw"] if meta else 0; cls = meta["cls"] if meta else 3; wt = meta["wt"] if meta else 0.0
            x["feat"] = features(d, rn, x["code"], draw, field, cls, wt)
    evals.append(dict(date=d, race=rn, runners=lst))

def hits(sel): return sum(x["hit"] for x in sel)
def engine_top4(rs): return sorted(rs, key=lambda x: x["rank"])[:4]

def apply_rule(rs, model, delta):
    base = engine_top4(rs); fourth = base[-1]
    cands = [x for x in rs if x["debut"] and x not in base]
    if not cands: return base, None
    best = max(cands, key=lambda x: predict(model, x["feat"]))
    pd_ = predict(model, best["feat"])
    if pd_ > fourth["p4_engine"] + delta:
        return base[:3] + [best], best
    return base, None

def window(lo, hi): return [e for e in evals if lo <= e["date"] <= hi]

def evaluate(es, model, delta):
    diffs = []; per_meeting = defaultdict(lambda: [0, 0, 0]); swaps = []; base_tot = new_tot = 0
    for e in es:
        b = hits(engine_top4(e["runners"])); sel, sw = apply_rule(e["runners"], model, delta); n = hits(sel)
        base_tot += b; new_tot += n; diffs.append(n - b)
        pm = per_meeting[e["date"]]; pm[0] += b; pm[1] += n; pm[2] += 1
        if sw: swaps.append(dict(date=e["date"], race=e["race"], code=sw["code"], hit=sw["hit"],
                                 replaced_hit=engine_top4(e["runners"])[-1]["hit"]))
    k = len(es)
    # meeting-cluster bootstrap of the mean paired difference
    meet = sorted(per_meeting); arr = np.array([[per_meeting[m][1] - per_meeting[m][0], per_meeting[m][2]] for m in meet], float)
    boots = []
    for _ in range(5000):
        s = arr[RNG.integers(0, len(arr), len(arr))]; boots.append(s[:, 0].sum() / s[:, 1].sum())
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return dict(races=k, meetings=len(meet), engine_avg=round(base_tot / k, 3), overlay_avg=round(new_tot / k, 3),
                diff=round((new_tot - base_tot) / k, 3), ci95=[round(float(lo), 3), round(float(hi), 3)],
                swaps=len(swaps), swap_hits=sum(s["hit"] for s in swaps), replaced_hits=sum(s["replaced_hit"] for s in swaps),
                meetings_better=sum(1 for m in meet if per_meeting[m][1] > per_meeting[m][0]),
                meetings_worse=sum(1 for m in meet if per_meeting[m][1] < per_meeting[m][0]), swap_list=swaps)

val = window(VAL_FROM, VAL_TO); test = window(TEST_FROM, TEST_TO)
grid = [-0.10, -0.05, 0.0, 0.05, 0.10, 0.15, 0.20]
val_grid = {str(dl): evaluate(val, m_val, dl) for dl in grid}
best_delta = max(grid, key=lambda dl: (val_grid[str(dl)]["diff"], dl))
test_res = evaluate(test, m_test, best_delta)

# debutant-level discrimination in the test window (engine vs trial prior vs base rate)
td = [x for e in test for x in e["runners"] if x["debut"]]
y = [x["hit"] for x in td]; p_prior = [predict(m_test, x["feat"]) for x in td]; p_eng = [x["p4_engine"] for x in td]
base_rate = float(np.mean([r["y"] for r in deb if r["date"] <= VAL_TO]))
coef = {f: round(float(w), 3) for f, w in zip(FEATS, m_test["w"][1:])}
report = dict(
    generated_for="2026-11-18 research gate (report only, no promotion)",
    windows=dict(train_from=TRAIN_FROM, validation=[VAL_FROM, VAL_TO], test=[TEST_FROM, TEST_TO]),
    debut_rows=dict(train_to_val=sum(1 for r in deb if r["date"] < VAL_FROM), train_to_test=sum(1 for r in deb if r["date"] <= VAL_TO),
                    base_top4_rate=round(base_rate, 3)),
    test_debutants=dict(n=len(td), top4=int(sum(y)), engine_picked=sum(1 for e in test for x in engine_top4(e["runners"]) if x["debut"]),
                        auc_engine=auc(p_eng, y), auc_trial_prior=auc(p_prior, y),
                        logloss_base=logloss([base_rate] * len(y), y), logloss_engine=logloss(p_eng, y), logloss_trial_prior=logloss(p_prior, y),
                        mean_p4_engine=round(float(np.mean(p_eng)), 3), mean_p4_prior=round(float(np.mean(p_prior)), 3)),
    validation_grid={k: {kk: vv for kk, vv in v.items() if kk != "swap_list"} for k, v in val_grid.items()},
    chosen_delta=best_delta,
    test=test_res,
    coefficients_std=coef,
)

# ── supplementary: is the gap ranking or calibration? ───────────────────
def fourth_rate(es): return round(float(np.mean([engine_top4(e["runners"])[-1]["hit"] for e in es])), 3)
order = np.argsort(p_prior)[::-1]; top_q = order[: max(1, len(order) // 5)]
report["supplementary"] = dict(
    fourth_pick_hit_rate=dict(validation=fourth_rate(val), test=fourth_rate(test)),
    prior_top_quintile_test=dict(n=int(len(top_q)), top4=int(sum(y[i] for i in top_q)), mean_prior=round(float(np.mean([p_prior[i] for i in top_q])), 3)),
    engine_top_quintile_test=(lambda o: dict(n=int(len(o)), top4=int(sum(y[i] for i in o)), mean_engine_p4=round(float(np.mean([p_eng[i] for i in o])), 3)))(np.argsort(p_eng)[::-1][: max(1, len(p_eng) // 5)]),
)
# Rule C: keep the engine ranking among debutants, only rescale their engine top-4 probability
vd = [x for e in val for x in e["runners"] if x["debut"]]
scale = float(sum(x["hit"] for x in vd) / max(1e-9, sum(x["p4_engine"] for x in vd)))
def rule_c(es, sc):
    b_tot = n_tot = 0; sw = 0; sw_hit = 0; rep_hit = 0
    for e in es:
        base = engine_top4(e["runners"]); fourth = base[-1]
        c = [x for x in e["runners"] if x["debut"] and x not in base]
        best = max(c, key=lambda x: x["p4_engine"], default=None)
        sel = base
        if best is not None and best["p4_engine"] * sc > fourth["p4_engine"]:
            sel = base[:3] + [best]; sw += 1; sw_hit += best["hit"]; rep_hit += fourth["hit"]
        b_tot += hits(base); n_tot += hits(sel)
    return dict(scale=round(sc, 3), races=len(es), engine_avg=round(b_tot / len(es), 3), overlay_avg=round(n_tot / len(es), 3), swaps=sw, swap_hits=sw_hit, replaced_hits=rep_hit)
report["supplementary"]["rescale_engine_debut_p4"] = dict(validation_debutants=dict(n=len(vd), top4=sum(x["hit"] for x in vd), mean_p4_engine=round(float(np.mean([x["p4_engine"] for x in vd])), 3)),
                                                         validation=rule_c(val, scale), test=rule_c(test, scale))

json.dump(report, open(OUT, "w"), ensure_ascii=False, indent=1)
print(json.dumps(report.get("supplementary"), ensure_ascii=False, indent=1))
