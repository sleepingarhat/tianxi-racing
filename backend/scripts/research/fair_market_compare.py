# Research only. Engine top four vs market favourites from the earliest pre-lock WIN price
# (odds_archive first snapshot, before race-day 02:00Z) and from final odds.
# Run from a folder holding read-only dumps pl/<date>.jsonl (prediction_log) and
# early/<date>.jsonl (odds_archive first WIN rows): python3 fair_market_compare.py <repo_root>
import csv, glob, json, re, os
from collections import defaultdict
import sys
ROOT=sys.argv[1] if len(sys.argv)>1 else '.'; CODE=re.compile(r"\(([A-Z]\d{3})\)")
res=defaultdict(dict); final=defaultdict(dict)
for f in glob.glob(f'{ROOT}/data/2026/results_2026-*.csv'):
    for r in csv.DictReader(open(f,encoding='utf-8-sig')):
        if r['date']<'2026-09-01': continue
        k=(r['date'],int(r['race_no'])); m=re.match(r'\s*(\d+)',r['place'] or '')
        try: hn=int(r['horse_no'])
        except: continue
        res[k][hn]=int(m.group(1)) if m else None
        try: final[k][hn]=float(r['win_odds'])
        except: pass
eng=defaultdict(list)
for f in glob.glob('pl/2026-*.jsonl'):
    for l in open(f):
        if not l.startswith('{'): continue
        r=json.loads(l)
        if r['date']<'2026-09-01' or r['predicted_rank'] is None: continue
        eng[(r['date'],int(r['race_number']))].append((r['predicted_rank'],r['horse_number']))
early=defaultdict(dict); snap={}
for f in glob.glob('early/*.jsonl'):
    d=os.path.basename(f)[:10]
    for l in open(f):
        if not l.startswith('{'): continue
        r=json.loads(l)
        if r['odds'] and r['odds']>0: early[(d,int(r['race_number']))][int(r['combination'])]=r['odds']; snap[d]=r['snapshot_at']
def top4(od): return [h for h,_ in sorted(od.items(), key=lambda x:(x[1],x[0]))[:4]]
def hits(sel,pl): return sum(1 for h in sel if pl.get(h) is not None and pl[h]<=4)
rows=[]; per=defaultdict(lambda:[0,0,0,0])
for k in sorted(eng):
    if k not in res or k not in early or k not in final or not any(v is not None for v in res[k].values()): continue
    e=[h for _,h in sorted(eng[k])[:4]]
    a=hits(e,res[k]); b=hits(top4(early[k]),res[k]); c=hits(top4(final[k]),res[k])
    rows.append((k,a,b,c)); p=per[k[0]]; p[0]+=a;p[1]+=b;p[2]+=c;p[3]+=1
n=len(rows)
print('races',n,'meetings',len(per))
print('engine avg',round(sum(r[1] for r in rows)/n,3),'early-market top4',round(sum(r[2] for r in rows)/n,3),'final-market top4',round(sum(r[3] for r in rows)/n,3))
print('full hits engine/early/final',sum(r[1]==4 for r in rows),sum(r[2]==4 for r in rows),sum(r[3]==4 for r in rows))
print('meetings engine>=early',sum(1 for p in per.values() if p[0]>=p[1]),'engine>=final',sum(1 for p in per.values() if p[0]>=p[2]))
for d,p in sorted(per.items()): print(d, snap.get(d,'')[:16], round(p[0]/p[3],2), round(p[1]/p[3],2), round(p[2]/p[3],2), p[3])
import numpy as np
rng=np.random.default_rng(1); arr=np.array([[p[0]-p[1],p[3]] for p in per.values()],float); b=[]
for _ in range(5000):
    s=arr[rng.integers(0,len(arr),len(arr))]; b.append(s[:,0].sum()/s[:,1].sum())
print('engine-early diff', round(arr[:,0].sum()/arr[:,1].sum(),3), 'ci', np.percentile(b,[2.5,97.5]).round(3))
