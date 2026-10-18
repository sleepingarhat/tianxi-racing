"""Offline calibrated fusion sensitivity; no production writes or release.
Uses saved fixed per-day rounds and corrected available-axis baseline.
Top-picks context is a current read-only reconstruction, NOT a frozen receipt.
Meeting factor parity remains UNVERIFIED: never promote from this report.
"""
import argparse, hashlib, json, importlib.util
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb

def composite(frame):
    v=frame[['h_elo','j_elo','t_elo']].to_numpy(dtype=float);w=np.array([.7,.2,.1]);den=(np.isfinite(v)*w).sum(axis=1)
    return np.divide(np.nansum(v*w,axis=1),den,out=np.full(len(v),np.nan),where=den>0)

def serving_z(values):
    s=pd.Series(values,dtype=float);valid=s.dropna();sd=valid.std(ddof=1) if len(valid)>1 else 1.
    return ((s-valid.mean())/(sd if np.isfinite(sd) and sd>0 else 1.)).fillna(0).to_numpy()

def serving_scores(logp,elo,factor):
    b=.88*serving_z(logp)+.12*serving_z(elo)
    return np.floor((1500+100*b)*10+.5)/10,b+np.nan_to_num(factor)*.005

def run(a):
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);df=pd.read_csv(a.input).sort_values(['race_date','race_id']).reset_index(drop=True)
    assert hashlib.sha256(__import__('gzip').open(a.input,'rb').read()).hexdigest()=='5d56049e6acbc419db783c2827ae25095a413c42016e4f389e55a99055053dcf'
    spec=importlib.util.spec_from_file_location('predict_source',a.predict_source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    daily_spec=importlib.util.spec_from_file_location('daily_source',a.daily_source)
    # Import standalone daily helpers with a temporary module alias, never run its CLI.
    import sys,types
    pkg=types.ModuleType('scripts');sub=types.ModuleType('scripts.backtest');sys.modules['scripts']=pkg;sys.modules['scripts.backtest']=sub;sys.modules['scripts.backtest.predict_upcoming']=m
    daily=importlib.util.module_from_spec(daily_spec);daily_spec.loader.exec_module(daily)
    before_missing=int(df.baseline_score.isna().sum());df['corrected_composite']=composite(df);df['baseline_score']=df.corrected_composite+df.factor_bonus
    cohort=pd.read_csv('public/reports/repair-calibration-2026-10-18/cohort-readback.csv');keys=set(zip(cohort.race_id,cohort.rebuilt_horse_id));excluded=pd.Series([(r,h) in keys for r,h in zip(df.race_id,df.horse_id)]);assert excluded.sum()==134
    contexts={r['raceId']:r['picks'] for r in json.load(open(a.context))};old=pd.read_csv('public/reports/cohort-impact-2026-10-18/comparison.csv');params={'objective':'lambdarank','metric':'None','lambdarank_truncation_level':4,'label_gain':[0,1,7,31,127,127,127,127,127,127,127,127,127,127,127,127,127,127,127,127],'learning_rate':.01,'num_leaves':8,'min_data_in_leaf':20,'verbosity':-1,'num_threads':2,'seed':42,'deterministic':True,'force_col_wise':True}
    days=[];details=[];races=[]
    for d in json.load(open('src/lib/repair-calibration-summary.json'))['days']:
        day=d['date'];past,train,val=daily.split_before(df,day);target=df[df.race_date==day].copy();ids=val.race_id.to_numpy();labels=val.is_top1.to_numpy();base=m.standardize_per_race(val.baseline_score.fillna(0).to_numpy(),ids)
        diag=json.load(open(f'public/reports/repair-calibration-2026-10-18/{day}.json'));rounds=diag['best_iteration'];branches={};calibs={}
        for name,remove in [('included',False),('excluded',True)]:
            fit=train[~excluded.loc[train.index]] if remove else train
            assert fit.race_date.max()<val.race_date.min()<=val.race_date.max()<day
            ds=lgb.Dataset(fit[m.FEAT_COLS].fillna(-1).to_numpy(),label=m.make_graded_label(fit),group=fit.groupby('race_id',sort=False).size().to_numpy())
            model=lgb.train(params,ds,num_boost_round=rounds);raw=model.predict(val[m.FEAT_COLS].fillna(-1).to_numpy())
            tl=m.fit_temperature(raw,ids,labels);te=m.fit_temperature(base,ids,labels);pl=m.per_race_softmax(raw,ids,tl);pe=m.per_race_softmax(base,ids,te);alpha=m.fit_alpha(pl,pe,ids,labels)
            calibs[name]={'tau_lgb':tl,'tau_elo':te,'inner_alpha':alpha,'validation_logloss':daily.loss(alpha*pl+(1-alpha)*pe,labels,ids),'rounds':rounds}
            if remove:
                refit=lgb.Booster(model_file=f'public/reports/cohort-impact-2026-10-18/{day}-excluded-model.txt');traw=refit.predict(target[m.FEAT_COLS].fillna(-1).to_numpy())
            else:
                inc=pd.read_csv(f'public/reports/repair-calibration-2026-10-18/{day}-predictions.csv');traw=target[['race_id','horse_id']].merge(inc[['race_id','horse_id','raw_score']],on=['race_id','horse_id'],validate='one_to_one').raw_score.to_numpy()
            tids=target.race_id.to_numpy();tb=m.standardize_per_race(target.baseline_score.fillna(0).to_numpy(),tids);prob=alpha*m.per_race_softmax(traw,tids,tl)+(1-alpha)*m.per_race_softmax(tb,tids,te);assert np.isfinite(prob).all();branches[name]=np.log(np.maximum(prob,1e-12))
        target['included_logp']=branches['included'];target['excluded_logp']=branches['excluded']
        matched=0
        for rid,g in target.groupby('race_id',sort=False):
            ctx=pd.DataFrame(contexts.get(rid,[]));orig=old[old.raceId==rid]
            if ctx.empty or set(ctx.horseId)!=set(g.horse_id) or set(orig.horseId)!=set(g.horse_id):continue
            g=g.merge(ctx[['horseId','eloComposite','factorBonus']],left_on='horse_id',right_on='horseId',validate='one_to_one').merge(orig[['horseId','originalScore','originalRank']],on='horseId',validate='one_to_one')
            for n in ['included','excluded']:
                g[n+'Score'],rankscore=serving_scores(g[n+'_logp'],g.eloComposite,g.factorBonus)
                g[n+'Rank']=pd.Series(rankscore,index=g.index).rank(ascending=False,method='first')
            delta=g.includedScore-g.excludedScore;historic=g.includedScore-g.originalScore;valid=g.finishing_position.between(1,4);i=set(g[g.includedRank<=4].horse_id);e=set(g[g.excludedRank<=4].horse_id);h=set(g[g.originalRank<=4].horse_id)
            races.append({'date':day,'raceId':rid,'runners':len(g),'cohortTop4Changed':i!=e,'historicalTop4Changed':i!=h,'includedHits':int(((g.includedRank<=4)&valid).sum()),'excludedHits':int(((g.excludedRank<=4)&valid).sum()),'rankChanges':int((g.includedRank!=g.excludedRank).sum())});matched+=1
            for j,r in g.iterrows():details.append({'date':day,'raceId':rid,'horseId':r.horse_id,'includedScore':r.includedScore,'excludedScore':r.excludedScore,'originalScore':r.originalScore,'cohortDelta':r.includedScore-r.excludedScore,'historicalDelta':r.includedScore-r.originalScore,'includedRank':int(r.includedRank),'excludedRank':int(r.excludedRank),'originalRank':int(r.originalRank)})
        record={'date':day,'matchedRaces':matched,'train_end':train.race_date.max(),'validation_start':val.race_date.min(),'validation_end':val.race_date.max(),'calibration':calibs};days.append(record);(out/f'{day}.json').write_text(json.dumps(record,indent=2));print('completed',day,matched,flush=True)
    r=pd.DataFrame(races);v=pd.DataFrame(details);v.to_csv(out/'comparison.csv',index=False)
    result={'scope':'CALIBRATED_FORMULA_REPLAY_SERVING_CONTEXT_PARITY_UNVERIFIED','promotionGate':'BLOCKED','productionPromoted':False,'frozenWrites':False,'cohortRows':134,'matchedRaces':len(r),'matchedRunners':len(v),'excludedIncompleteRaces':107-len(r),'cohortTop4ChangedRaces':int(r.cohortTop4Changed.sum()),'cohortRankChanges':int(r.rankChanges.sum()),'cohortMeanAbsScoreDelta':float(v.cohortDelta.abs().mean()),'cohortMaxAbsScoreDelta':float(v.cohortDelta.abs().max()),'historicalTop4ChangedRaces':int(r.historicalTop4Changed.sum()),'historicalMeanAbsScoreDelta':float(v.historicalDelta.abs().mean()),'historicalMaxAbsScoreDelta':float(v.historicalDelta.abs().max()),'includedMeanHits':float(r.includedHits.mean()),'excludedMeanHits':float(r.excludedHits.mean()),'baselineMissingBefore':before_missing,'baselineMissingAfter':int(df.baseline_score.isna().sum()),'days':days,'limitations':['已使用校準混合log(p)及外層α=.88，不再用原始margin冒充服務分數','固定修復後52項特徵與逐日輪數，移除134行只測条件式影響；不是重建舊錯誤資料管道','top-picks為現行只讀重建；與會期正式批量因子和未四捨五入Elo尚未核實一致，不冒充完整服務驗收','39行全軸缺值仍採既有校準fillna(0)；缺值處理尚非已完成正式發布契約','歷史凍結缺不可變發布收據，歷史差異含多項修復，不能全歸因134行','研究閘未通過、不升版、不改歷史副本或戰績']}
    (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False));print({k:v for k,v in result.items() if k not in ['days','limitations']},flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--context',required=True);p.add_argument('--out',required=True);p.add_argument('--predict-source',required=True);p.add_argument('--daily-source',required=True);run(p.parse_args())
