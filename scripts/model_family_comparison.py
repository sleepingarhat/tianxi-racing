"""Offline temporal family comparison; no production writes or promotion."""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
import xgboost as xgb
import sklearn
from sklearn.ensemble import RandomForestRegressor

ROOT = Path(__file__).resolve().parents[1]
SEED = 42

def safe_parameters(params):
    return {key: None if isinstance(value, float) and not np.isfinite(value) else value for key, value in params.items()}

def complete_field(g):
    positions = g.finishing_position
    return (len(g) >= 4 and g.field_size.nunique() == 1
            and len(g) == g.field_size.iloc[0]
            and g.horse_id.nunique() == len(g)
            and g.race_date.nunique() == 1
            and positions.between(1, 98).all()
            and all((positions == rank).sum() == 1 for rank in range(1, 5)))

def graded_labels(positions):
    return np.where((positions >= 1) & (positions <= 4), 5-positions, 0).astype(int)

def top_four(g, scores):
    order = np.lexsort((g.horse_id.to_numpy(), -np.asarray(scores)))[:4]
    chosen = g.iloc[order]
    return chosen.horse_id.tolist(), int(chosen.finishing_position.between(1, 4).sum())

def run(a):
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    frame = pd.read_csv(a.input).sort_values(['race_date', 'race_id', 'horse_id']).reset_index(drop=True)
    if frame.duplicated(['race_id', 'horse_id']).any():
        raise ValueError('Duplicate race/horse identity')
    columns = json.loads((ROOT/'public/reports/repair-retraining-2026-10-18/meta.json').read_text())['featCols']
    if any(c not in frame for c in columns): raise ValueError('Missing canonical column')
    complete = [rid for rid, g in frame.groupby('race_id') if complete_field(g)]
    data = frame[frame.race_id.isin(complete)].copy()
    dates = sorted(data.race_date.unique())[-a.days:]
    for i, day in enumerate(dates):
        if i % a.shards != a.shard: continue
        path = out/f'{day}.json'
        if path.exists(): continue
        train = data[data.race_date < day].copy()
        test = data[data.race_date == day].copy()
        if train.empty or train.race_date.max() >= day: raise ValueError('Invalid temporal split')
        x = train[columns].replace([np.inf, -np.inf], np.nan).fillna(-1).to_numpy(dtype=np.float32)
        xt = test[columns].replace([np.inf, -np.inf], np.nan).fillna(-1).to_numpy(dtype=np.float32)
        y = graded_labels(train.finishing_position.to_numpy())
        group = train.groupby('race_id', sort=False).size().to_numpy()
        qid = np.repeat(np.arange(len(group)), group)
        models = {
            'LightGBM': lgb.LGBMRanker(objective='lambdarank', n_estimators=200, learning_rate=.05,
                num_leaves=15, max_depth=6, min_child_samples=20, label_gain=[0,1,2,3,4],
                lambdarank_truncation_level=4, random_state=SEED, n_jobs=2, verbosity=-1,
                deterministic=True, force_col_wise=True),
            'XGBoost': xgb.XGBRanker(objective='rank:pairwise', n_estimators=200, learning_rate=.05,
                max_depth=6, min_child_weight=20, subsample=1, colsample_bytree=1,
                tree_method='hist', random_state=SEED, n_jobs=2),
            'Random Forest': RandomForestRegressor(n_estimators=200, max_depth=6,
                min_samples_leaf=20, max_features=.5, random_state=SEED, n_jobs=2),
        }
        predictions = {}; model_meta = {}
        for name, model in models.items():
            start=time.monotonic()
            if name == 'LightGBM': model.fit(x,y,group=group)
            elif name == 'XGBoost': model.fit(x,y,qid=qid)
            else: model.fit(x,y)
            predictions[name]=model.predict(xt)
            model_meta[name]={'parameters':safe_parameters(model.get_params()), 'seconds':round(time.monotonic()-start,2)}
            print(day, name, model_meta[name]['seconds'], flush=True)
        races=[]
        for rid,g in test.groupby('race_id',sort=False):
            idx=test.index.get_indexer(g.index)
            rec={'date':day,'raceId':rid,'runners':len(g),'actualTop4':g[g.finishing_position.between(1,4)].sort_values('finishing_position').horse_id.tolist(),'models':{}}
            for name, scores in predictions.items():
                selected,hits=top_four(g,scores[idx]);rec['models'][name]={'selected':selected,'hits':hits}
            races.append(rec)
        record={'date':day,'trainingStart':train.race_date.min(),'trainingEnd':train.race_date.max(),
            'trainingRows':len(train),'trainingRaces':train.race_id.nunique(),'races':races,'models':model_meta}
        path.write_text(json.dumps(record,ensure_ascii=False,indent=2,allow_nan=False))
    if a.shards > 1 and not all((out/f'{d}.json').exists() for d in dates): return
    records=[json.loads((out/f'{day}.json').read_text()) for day in dates]
    races=[r for d in records for r in d['races']]
    summary=[]
    rng=np.random.default_rng(SEED)
    boot=rng.integers(0,len(dates),(10000,len(dates)))
    counts=np.array([len(d['races']) for d in records])
    for name in ['LightGBM','XGBoost','Random Forest']:
        hits=sum(r['models'][name]['hits'] for r in races)
        daily=np.array([sum(r['models'][name]['hits'] for r in d['races']) for d in records])
        ci=np.quantile(daily[boot].sum(1)/counts[boot].sum(1),[.025,.975]).tolist()
        summary.append({'name':name,'hits':hits,'races':len(races),'averageHits':hits/len(races),'ci95':ci})
    result={'schema':1,'scope':'歷史資料重建特徵 · 逐日留出探索性回測','productionPromoted':False,
        'inputSha256':hashlib.sha256(Path(a.input).read_bytes()).hexdigest(),
        'sourceRows':len(frame),'sourceRaces':frame.race_id.nunique(),'completeRaces':len(complete),
        'excludedRaces':int(frame.race_id.nunique()-len(complete)),
        'features':columns,'allMissingFeatures':[c for c in columns if frame[c].isna().all()],
        'featureMissingRates':{c:float(frame[c].isna().mean()) for c in columns},
        'versions':{'LightGBM':lgb.__version__,'XGBoost':xgb.__version__,'sklearn':sklearn.__version__},
        'dates':dates,'summary':summary,'days':records,'seed':SEED,'trees':200,
        'limitations':['真實歷史賽果及現存重建特徵，不是當時公開預測；並非正式戰績。',
        '缺失特徵一致填-1；本次比較模型本體，不包含正式LGB與Elo分數混合或服務校準。',
        '目標日不入訓練；排除賽果標籤、落後距離、賠率及最終分數作輸入。',
        '往績及血統沿用現存重建欄位，未逐筆驗證歷史採集時間；不能宣稱完全排除來源層洩漏。',
        '只比較固定200棵樹、種子42及本次參數，未進行等預算調參；RF用分級回歸，兩個boosting用場內排序。',
        '完整場數與頭四名唯一性才計分；並頭、不完整場次排除，不能外推全部賽事。',
        f'95%區間按{len(dates)}個賽日重抽；小樣本研究不構成升版批准。']}
    (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    print(json.dumps(summary,ensure_ascii=False),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--out',required=True);p.add_argument('--days',type=int,default=11);p.add_argument('--shard',type=int,default=0);p.add_argument('--shards',type=int,default=1)
    run(p.parse_args())