"""Isolated conditional cohort sensitivity, never a production/frozen write.
Use fixed repaired features and per-date saved iteration counts. Removing rows
is NOT a reconstruction of the old broken importer or historical Elo.
"""
import argparse, json, hashlib
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb

def z(s):
    s=pd.to_numeric(s,errors='coerce'); valid=s.dropna();sd=valid.std(ddof=1) if len(valid)>1 else 1
    return ((s-valid.mean())/(sd if np.isfinite(sd) and sd>0 else 1)).fillna(0)
def blend(raw,elo): return .88*z(raw)+.12*z(elo)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--history',required=True);ap.add_argument('--factors',required=True);a=ap.parse_args()
    root=Path('public/reports');out=root/'cohort-impact-2026-10-18';cal=root/'repair-calibration-2026-10-18'
    df=pd.read_csv(a.input).sort_values(['race_date','race_id']).reset_index(drop=True)
    features=json.loads((cal/'full-training.json').read_text())['features']
    cohort=pd.read_csv(cal/'cohort-readback.csv'); keys=set(zip(cohort.race_id,cohort.rebuilt_horse_id))
    assert len(keys)==134
    exclude=pd.Series([(r,h) in keys for r,h in zip(df.race_id,df.horse_id)],index=df.index);assert exclude.sum()==134
    h=pd.DataFrame(json.load(open(a.history)));f=pd.DataFrame(json.load(open(a.factors)));h=h.merge(f,on=['date','race_number','horse_id'],validate='one_to_one')
    h['race_id']='race_'+h.date+'_'+h.date.map(df.groupby('race_date').venue.first())+'_'+h.race_number.astype(str)
    params={'objective':'lambdarank','metric':'None','lambdarank_truncation_level':4,'label_gain':[0,1,7,31,127,127,127,127,127,127,127,127,127,127,127,127,127,127,127,127],'learning_rate':.01,'num_leaves':8,'min_data_in_leaf':20,'verbosity':-1,'num_threads':2,'seed':42,'deterministic':True,'force_col_wise':True}
    races=[];details=[];days=[]
    for day in sorted(h.date.unique()):
        inc=pd.read_csv(cal/f'{day}-predictions.csv');diag=json.loads((cal/f'{day}.json').read_text());train=df[(df.race_date<day)&~exclude];target=df[df.race_date==day].copy()
        labels=np.maximum(5-train.finishing_position,0).astype(int)
        model=lgb.train(params,lgb.Dataset(train[features].fillna(-1).to_numpy(),label=labels,group=train.groupby('race_id',sort=False).size().to_numpy()),num_boost_round=diag['best_iteration'])
        target['excludedRaw']=model.predict(target[features].fillna(-1).to_numpy());target=target.merge(inc[['race_id','horse_id','raw_score']],on=['race_id','horse_id'],validate='one_to_one')
        model.save_model(str(out/f'{day}-excluded-model.txt'))
        for rid,g in target.groupby('race_id',sort=False):
            orig=h[h.race_id==rid]
            if set(orig.horse_id)!=set(g.horse_id):continue
            g=g.merge(orig[['horse_id','elo_composite','final_score','predicted_rank','factor_bonus']],on='horse_id',suffixes=('','_original'),validate='one_to_one')
            # Freeze original composite/factor deliberately: isolate LGB replacement;
            # this is not a repaired Elo serving replay.
            g['includedBlend']=blend(g.raw_score,g.elo_composite_original);g['excludedBlend']=blend(g.excludedRaw,g.elo_composite_original)
            g['includedScore']=np.floor((1500+100*g.includedBlend)*10+.5)/10;g['excludedScore']=np.floor((1500+100*g.excludedBlend)*10+.5)/10
            tilt=g.factor_bonus_original.fillna(0)*.005
            g['includedRank']=(g.includedBlend+tilt).rank(ascending=False,method='first');g['excludedRank']=(g.excludedBlend+tilt).rank(ascending=False,method='first')
            i=set(g.loc[g.includedRank<=4,'horse_id']);e=set(g.loc[g.excludedRank<=4,'horse_id']);o=set(g.loc[g.predicted_rank<=4,'horse_id'])
            delta=(g.includedScore-g.excludedScore).abs();hist=(g.includedScore-g.final_score).abs()
            races.append({'date':day,'raceId':rid,'runners':len(g),'cohortTop4Changed':i!=e,'historicalTop4Changed':i!=o,'cohortRankChanges':int((g.includedRank!=g.excludedRank).sum()),'historicalRankChanges':int((g.includedRank!=g.predicted_rank).sum()),'includedHits':int(((g.includedRank<=4)&g.finishing_position.between(1,4)).sum()),'excludedHits':int(((g.excludedRank<=4)&g.finishing_position.between(1,4)).sum()),'originalHits':int(((g.predicted_rank<=4)&g.finishing_position.between(1,4)).sum())})
            for _,r in g.iterrows(): details.append({'date':day,'raceId':rid,'horseId':r.horse_id,'originalScore':r.final_score,'includedScore':r.includedScore,'excludedScore':r.excludedScore,'cohortDelta':r.includedScore-r.excludedScore,'historicalDelta':r.includedScore-r.final_score,'originalRank':r.predicted_rank,'includedRank':int(r.includedRank),'excludedRank':int(r.excludedRank)})
        days.append({'date':day,'rounds':diag['best_iteration'],'includedTrainingRows':int((df.race_date<day).sum()),'excludedTrainingRows':len(train)})
        print('completed',day,flush=True)
    r=pd.DataFrame(races);d=pd.DataFrame(details);d.to_csv(out/'comparison.csv',index=False)
    summary={'promotion':'BLOCKED','productionPromoted':False,'frozenWrites':False,'cohortRows':134,'cohortDateStart':cohort.race_id.str.slice(5,15).min(),'cohortDateEnd':cohort.race_id.str.slice(5,15).max(),'historicalRowsRead':len(h),'matchedRaces':len(r),'matchedRunners':len(d),'excludedIncompleteRaces':107-len(r),'cohortTop4ChangedRaces':int(r.cohortTop4Changed.sum()),'cohortRankChanges':int(r.cohortRankChanges.sum()),'cohortMeanAbsScoreDelta':float(d.cohortDelta.abs().mean()),'cohortMaxAbsScoreDelta':float(d.cohortDelta.abs().max()),'historicalTop4ChangedRaces':int(r.historicalTop4Changed.sum()),'historicalRankChanges':int(r.historicalRankChanges.sum()),'historicalMeanAbsScoreDelta':float(d.historicalDelta.abs().mean()),'historicalMaxAbsScoreDelta':float(d.historicalDelta.abs().max()),'includedMeanHits':float(r.includedHits.mean()),'excludedMeanHits':float(r.excludedHits.mean()),'originalMeanHits':float(r.originalHits.mean()),'days':days,'races':r.to_dict('records'),'limitations':['固定修復後特徵、逐日已選輪數及原紀錄Elo／因子，僅移除134行訓練樣本；不是重建舊錯誤導入流程','歷史紀錄缺不可變發布收據，標記歷史未核；15場馬匹集合不同不比較','歷史差異含重訓、校準方法與資料修復，不能全歸因134行','未完成修復後Elo正式服務融合及正式研究驗收，禁止升版']}
    summary['scoreScope']='RAW_MARGIN_SENSITIVITY_NOT_CALIBRATED_SERVING_REPLAY'
    summary['limitations'].insert(0,'原始模型margin不是服務校準混合log(p)；分差及排名僅為條件式假設研究，不是真實服務影響')
    summary['historicalInputSha256']=hashlib.sha256(Path(a.history).read_bytes()).hexdigest()
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False));print({k:v for k,v in summary.items() if k not in ['days','races','limitations']})
if __name__=='__main__':main()
