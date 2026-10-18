"""Offline, date-held-out evaluation using the current 52 production features.
No HTTP calls, production writes or historical freeze updates.
Run from backend root with --features CSV --out DIRECTORY --dates comma-list.
"""
import argparse, hashlib, json, sys
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
sys.path.insert(0, str(Path.cwd()))
from scripts.backtest.predict_upcoming import FEAT_COLS, make_graded_label, standardize_per_race, per_race_softmax, fit_temperature, fit_alpha, evaluate_gates

def loss(p, labels, ids):
    # Dead heats share winner mass; do not select an arbitrary first winner.
    values=[]
    for rid in np.unique(ids):
        m=ids==rid; winners=labels[m]>0
        if winners.any(): values.append(float(-np.log(np.maximum(p[m][winners],1e-12)).mean()))
    return float(np.mean(values))

def split_before(df, target):
    past=df[df.race_date<target].copy()
    cutoff=(pd.Timestamp(past.race_date.max())-pd.Timedelta(days=30)).strftime('%Y-%m-%d')
    val=past[past.race_date>cutoff].copy()
    if val.race_id.nunique()<20:
        dates=[]
        for d in sorted(past.race_date.unique(),reverse=True):
            dates.append(d);val=past[past.race_date.isin(dates)].copy()
            if val.race_id.nunique()>=20 and len(dates)>=3: break
    train=past[past.race_date<val.race_date.min()].copy()
    assert train.race_date.max()<val.race_date.min()<=val.race_date.max()<target
    return past,train,val

def fit(df,target,out,full=False):
    past,train,val=split_before(df,target)
    params={'objective':'lambdarank','metric':'None','lambdarank_truncation_level':4,
      'label_gain':[0,1,7,31,127,127,127,127,127,127,127,127,127,127,127,127,127,127,127,127],
      'learning_rate':0.01,'num_leaves':8,'min_data_in_leaf':20,'verbosity':-1,'num_threads':2,'seed':42,'deterministic':True,'force_col_wise':True}
    def dataset(d): return lgb.Dataset(d[FEAT_COLS].fillna(-1).to_numpy(),label=make_graded_label(d),group=d.groupby('race_id',sort=False).size().to_numpy())
    ids=val.race_id.to_numpy(); labels=val.is_top1.to_numpy()
    def metric(scores,_): return ('race_logloss',loss(per_race_softmax(scores,ids),labels,ids),False)
    hist={}
    booster=lgb.train(params,dataset(train),num_boost_round=2000,valid_sets=[dataset(val)],valid_names=['val'],feval=metric,callbacks=[lgb.early_stopping(80,verbose=False),lgb.record_evaluation(hist)])
    scores=booster.predict(val[FEAT_COLS].fillna(-1).to_numpy());elo=standardize_per_race(val.baseline_score.fillna(0).to_numpy(),ids)
    tl=fit_temperature(scores,ids,labels);te=fit_temperature(elo,ids,labels)
    pl=per_race_softmax(scores,ids,tl);pe=per_race_softmax(elo,ids,te);alpha=fit_alpha(pl,pe,ids,labels)
    diag={'date':target,'train_end':train.race_date.max(),'validation_start':val.race_date.min(),'validation_end':val.race_date.max(),'refit_end':past.race_date.max(),'train_rows':len(past),'validation_races':val.race_id.nunique(),'best_iteration':booster.best_iteration,'tau_lgb':tl,'tau_elo':te,'alpha':alpha,'warnings':[]}
    curve=hist['val']['race_logloss']
    diag['race_logloss_curve']={'iter1':float(curve[0]),'best':float(curve[booster.best_iteration-1]),'final':float(curve[-1]),'len':len(curve)}
    diag['corr_lgb_elo']=float(np.corrcoef(standardize_per_race(scores,ids),elo)[0,1])
    diag['fit_rows']=len(train)
    diag['missing_baseline_validation']=int(val.baseline_score.isna().sum())
    passed,reasons=evaluate_gates(diag)
    diag['health_gate']={'status':'PASS' if passed else 'FAIL','reasons':reasons}
    diag['promotion_eligible']=False
    if tl<0.02 or tl>50: diag['warnings'].append('tau_lgb-bound')
    if te<0.02 or te>50: diag['warnings'].append('tau_elo-bound')
    final=lgb.train(params,dataset(past),num_boost_round=booster.best_iteration)
    if full:
        final.save_model(str(out/'model.txt'))
        importance=[{'feature':f,'gain':float(g),'split':int(s)} for f,g,s in zip(FEAT_COLS,final.feature_importance('gain'),final.feature_importance('split'))]
        (out/'feature-importance.json').write_text(json.dumps(importance,indent=2))
        diag['model_sha256']=hashlib.sha256((out/'model.txt').read_bytes()).hexdigest()
        diag['features']=FEAT_COLS;diag['production_promoted']=False
        (out/'full-training.json').write_text(json.dumps(diag,indent=2,allow_nan=False));print('Full training complete',diag,flush=True);return
    target_rows=df[df.race_date==target].copy();rids=target_rows.race_id.to_numpy()
    raw=final.predict(target_rows[FEAT_COLS].fillna(-1).to_numpy());base=standardize_per_race(target_rows.baseline_score.fillna(0).to_numpy(),rids)
    p=alpha*per_race_softmax(raw,rids,tl)+(1-alpha)*per_race_softmax(base,rids,te)
    assert np.isfinite(p).all(), 'non-finite calibrated probability'
    target_rows['candidate_p']=p;target_rows['raw_score']=raw
    records=[]
    for rid,g in target_rows.groupby('race_id',sort=False):
        chosen=g.sort_values('candidate_p',ascending=False).head(4); market=g[g.win_odds>0].sort_values('win_odds').head(4)
        records.append({'race_id':rid,'date':target,'runners':len(g),'candidate_top4_hits':int(chosen.finishing_position.between(1,4).sum()),'market_top4_hits':int(market.finishing_position.between(1,4).sum()),'market_complete':bool((g.win_odds>0).all()),'log_loss':loss(g.candidate_p.to_numpy(),g.is_top1.to_numpy(),g.race_id.to_numpy())})
    diag['races']=records;diag['evaluation_log_loss']=loss(p,target_rows.is_top1.to_numpy(),rids)
    target_rows[['race_id','race_date','horse_id','finishing_position','candidate_p','raw_score']].to_csv(out/f'{target}-predictions.csv',index=False)
    diag['missing_baseline_target']=int(target_rows.baseline_score.isna().sum())
    (out/f'{target}.json').write_text(json.dumps(diag,indent=2,allow_nan=False));print('Date complete',target,diag['best_iteration'],diag['health_gate'],flush=True)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--features',required=True);ap.add_argument('--out',required=True);ap.add_argument('--dates',default='');ap.add_argument('--full',action='store_true');a=ap.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    df=pd.read_csv(a.features).sort_values(['race_date','race_id']).reset_index(drop=True)
    assert len(FEAT_COLS)==52;assert not df.duplicated(['race_id','horse_id']).any()
    for f in FEAT_COLS: df[f]=pd.to_numeric(df[f],errors='raise')
    if a.full: fit(df,'2026-10-19',out,True)
    else:
        for d in a.dates.split(','):
            if d: fit(df,d,out)
if __name__=='__main__': main()