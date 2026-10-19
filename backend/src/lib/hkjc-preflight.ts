import { HKJC_CHANGES_URL, parseHkjcChangesPage, officialWithdrawal, type HkjcChangesPage } from './hkjc-changes';
import { officialCardQuery } from './official-card-query';
import { effectiveTop4 } from './withdrawal-substitution';
import {PREDICTION_COLUMNS} from './freeze-recovery';
import { getMeetingLockState } from './lock-window';
export const ACCOUNTING_POLICY = 'official-withdrawals-v5-original-metrics';
const CARD_URL = 'https://info.cld.hkjc.com/graphql/base/';
async function sha(raw: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(n=>n.toString(16).padStart(2,'0')).join(''); }
export async function ensureOfficialTables(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS hkjc_source_versions(date TEXT NOT NULL,venue TEXT NOT NULL,kind TEXT NOT NULL,sha TEXT NOT NULL,raw TEXT NOT NULL,source_url TEXT NOT NULL,captured_at TEXT NOT NULL,PRIMARY KEY(date,venue,kind,sha))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hkjc_prediction_inputs(date TEXT NOT NULL,engine TEXT NOT NULL,card_sha TEXT NOT NULL,changes_sha TEXT NOT NULL,runner_json TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(date,engine))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hkjc_input_bindings(date TEXT NOT NULL,engine TEXT NOT NULL,prediction_json TEXT NOT NULL,card_sha TEXT NOT NULL,changes_sha TEXT NOT NULL,PRIMARY KEY(date,engine))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hkjc_transaction_checks(ok INTEGER CHECK(ok=1))`).run();
  for(const action of ['UPDATE','DELETE']) await db.prepare(`CREATE TRIGGER IF NOT EXISTS hkjc_versions_no_${action.toLowerCase()} BEFORE ${action} ON hkjc_source_versions BEGIN SELECT RAISE(ABORT,'official source append-only'); END`).run();
}
async function archive(db:D1Database, page:{date:string;venue:string}, kind:string, raw:string, url:string) {
  const hash=await sha(raw), capturedAt=new Date().toISOString();
  const inserted=await db.prepare(`INSERT OR IGNORE INTO hkjc_source_versions VALUES(?,?,?,?,?,?,?)`).bind(page.date,page.venue,kind,hash,raw,url,capturedAt).run();
  if(kind==='changes'&&inserted.meta?.changes) await db.prepare("DELETE FROM meeting_hit_rate_cache WHERE date=? OR engine LIKE '%-rollup'").bind(page.date).run().catch(()=>{});
  return {sha:hash,capturedAt};
}
export async function captureOfficialChanges(db:D1Database) {
  await ensureOfficialTables(db);
  const res=await fetch(HKJC_CHANGES_URL,{headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(20000)});
  if(!res.ok) throw new Error('official-changes-fetch-failed');
  const raw=await res.text(), page=parseHkjcChangesPage(raw);
  if(!page) throw new Error('official-changes-parse-failed');
  return {...page,...await archive(db,page,'changes',raw,HKJC_CHANGES_URL)};
}
export async function readOfficialChanges(db:D1Database,date:string,venue:string):Promise<HkjcChangesPage | null> {
  await ensureOfficialTables(db);
  const row=await db.prepare(`SELECT raw FROM hkjc_source_versions WHERE date=? AND venue=? AND kind='changes' ORDER BY captured_at DESC LIMIT 1`).bind(date,venue).first<{raw:string}>();
  return row ? parseHkjcChangesPage(row.raw) : null;
}
export function validateOfficialCard(meeting:any, changes:HkjcChangesPage, date:string, venue:string) {
  if(!meeting || meeting.date?.slice(0,10)!==date || meeting.venueCode!==venue || !Array.isArray(meeting.races) || meeting.races.length!==Number(meeting.totalNumberOfRace)) throw new Error('official-card-incomplete-meeting');
  const numbers=new Set<number>(), entries:any[]=[];
  for(const race of meeting.races) {
    const rn=Number(race.no); if(!Number.isInteger(rn)||rn<1||numbers.has(rn))throw new Error('official-card-invalid-race'); numbers.add(rn);
    const slots=new Set<number>(), horses=new Set<string>(); let active=0;
    for(const runner of race.runners??[]) {
      if(['Scratched','Standby'].includes(runner.status))continue;
      if(runner.status!=='Declared')throw new Error('official-card-not-prerace');
      const hn=Number(runner.no), code=runner.horse?.code, draw=Number(runner.barrierDrawNumber);
      if(!Number.isInteger(hn)||hn<1||!code||slots.has(hn)||horses.has(code)||!runner.barrierDrawNumber||!Number.isInteger(draw)||draw<1||!runner.jockey?.code||!runner.trainer?.code||!Number.isFinite(Date.parse(race.postTime)))throw new Error('official-card-invalid-runner');
      if(officialWithdrawal(changes.changes,rn,hn,runner.name_ch))throw new Error('official-card-older-than-changes');
      slots.add(hn);horses.add(code);active++;entries.push({race,runner,raceNumber:rn,horseNumber:hn,horseId:'horse_'+code,nameCh:runner.name_ch,draw});
    }
    for(const c of changes.changes.filter(c=>c.raceNumber===rn&&c.kind==='other')) {
      const e=entries.find(e=>e.raceNumber===rn&&e.horseNumber===c.horseNumber&&e.nameCh===c.horseName);
      if(!e)throw new Error('official-change-runner-missing');
      const jockey=c.text.match(/由騎師\s+(\S+)\s+策騎/);
      const weight=c.text.match(/將負\s+(\d+)\s+磅/);
      if(jockey&&e.runner.jockey?.name_ch!==jockey[1])throw new Error('official-jockey-change-not-applied');
      if(weight&&Number(e.runner.handicapWeight)!==Number(weight[1]))throw new Error('official-weight-change-not-applied');
      if(!jockey&&!weight)throw new Error('official-change-not-verifiable');
    }
    if(active<4)throw new Error('official-card-incomplete-field');
    for(const c of changes.changes.filter(c=>c.raceNumber===rn&&c.kind==='replaced')) {
      if(!entries.some(e=>e.raceNumber===rn&&e.horseNumber===c.horseNumber&&e.nameCh===c.replacement))throw new Error('official-replacement-not-applied');
    }
  }
  if([...numbers].some(n=>n>numbers.size))throw new Error('official-card-missing-race');
  return entries;
}
export async function refreshOfficialCard(db:D1Database,date:string,venue:string) {
  const before=await captureOfficialChanges(db);
  if(before.date!==date||before.venue!==venue)throw new Error('official-changes-wrong-meeting');
  const res=await fetch(CARD_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:officialCardQuery,variables:{date,venueCode:venue}}),signal:AbortSignal.timeout(20000)});
  const raw=await res.text(); if(!res.ok)throw new Error('official-card-fetch-failed');
  const data=JSON.parse(raw); if(data.errors?.length)throw new Error('official-card-query-failed');
  const meeting=data.data?.raceMeetings?.find((m:any)=>m.date?.slice(0,10)===date&&m.venueCode===venue);
  const after=await captureOfficialChanges(db);
  if(after.date!==date||after.venue!==venue||after.sha!==before.sha)throw new Error('official-changes-changed-during-card-read');
  const entries=validateOfficialCard(meeting,after,date,venue), source=await archive(db,after,'card',raw,CARD_URL);
  const lock=await getMeetingLockState(db,date,venue);
  const first=Math.min(...entries.map(e=>Date.parse(e.race.postTime)));
  if(lock.locked||Date.now()>=first-90*60000)throw new Error('official-refresh-after-lock-refused');
  const deadline=new Date(first-90*60000).toISOString();
  const stmts:D1PreparedStatement[]=[db.prepare("INSERT INTO hkjc_transaction_checks(ok) SELECT CASE WHEN julianday('now')<julianday(?) THEN 1 ELSE 0 END").bind(deadline),db.prepare('DELETE FROM entries_upcoming WHERE race_date=? AND venue=?').bind(date,venue)];
  for(const e of entries) {
    const r=e.runner,a=e.race;
    stmts.push(db.prepare(`INSERT INTO horses(id,code,name_en,name_ch) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name_en=excluded.name_en,name_ch=excluded.name_ch`).bind(e.horseId,r.horse.code,r.name_en,r.name_ch));
    for(const kind of ['jockey','trainer'])stmts.push(db.prepare(`INSERT INTO ${kind==='jockey'?'jockeys':'trainers'}(id,name_en,name_ch) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name_en=excluded.name_en,name_ch=excluded.name_ch`).bind(kind+'_'+r[kind].code,r[kind].name_en,r[kind].name_ch));
    stmts.push(db.prepare(`INSERT INTO entries_upcoming(id,race_date,venue,race_number,race_class,distance,track,course,horse_id,horse_number,horse_code,draw,jockey_name,jockey_id,trainer_name,trainer_id,actual_weight,declared_weight,gear,rating,priority_order,post_time,scraped_at,source_commit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(`${date}_${venue}_${e.raceNumber}_${e.horseNumber}`,date,venue,e.raceNumber,a.claCode,Number(a.distance),a.raceTrack?.description_en??null,a.raceCourse?.displayCode??null,e.horseId,e.horseNumber,r.horse.code,e.draw,r.jockey.name_ch,'jockey_'+r.jockey.code,r.trainer.name_ch,'trainer_'+r.trainer.code,Number(r.currentWeight)||null,Number(r.handicapWeight)||null,r.gearInfo??null,Number(r.currentRating)||null,'正選',a.postTime,source.capturedAt,source.sha));
  }
  stmts.push(db.prepare("INSERT INTO hkjc_transaction_checks(ok) SELECT CASE WHEN julianday('now')<julianday(?) THEN 1 ELSE 0 END").bind(deadline),db.prepare("DELETE FROM hkjc_transaction_checks"));
  await db.batch(stmts);
  return {cardSha:source.sha,changesSha:after.sha,checkedAt:source.capturedAt,runners:entries.map(e=>({raceNumber:e.raceNumber,horseNumber:e.horseNumber,horseId:e.horseId,nameCh:e.nameCh,draw:e.draw}))};
}
export async function verifyPredictionInput(db:D1Database,payload:any,source:any) {
  const latest=await captureOfficialChanges(db);
  if(latest.date!==payload.date||latest.venue!==payload.venue||latest.sha!==source.changesSha)throw new Error('official-changes-invalidated-compute');
  const rows=await db.prepare(`SELECT race_number,horse_number,horse_id,draw,source_commit FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0`).bind(payload.date,payload.venue).all<any>();
  const key=(r:any)=>`${r.raceNumber}:${r.horseNumber}:${r.horseId}`;
  const expected=new Map<string,any>(source.runners.map((r:any)=>[key(r),r]));
  const picks=payload.races.flatMap((r:any)=>r.picks.map((p:any)=>({...p,raceNumber:r.raceNumber})));
  if(rows.results?.length!==expected.size||picks.length!==expected.size||new Set(picks.map(key)).size!==expected.size||rows.results?.some((r:any)=>r.source_commit!==source.cardSha||!expected.has(`${r.race_number}:${r.horse_number}:${r.horse_id}`))||picks.some((r:any)=>!expected.has(key(r))||Number(r.draw)!==expected.get(key(r))?.draw))throw new Error('official-input-version-mismatch');
}
export function officialWriteGuard(db:D1Database,date:string,venue:string,source:any,lockAt:string) {
  return db.prepare(`INSERT INTO hkjc_transaction_checks(ok) SELECT CASE WHEN julianday('now') < julianday(?) AND (SELECT COUNT(*) FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0)=? AND NOT EXISTS(SELECT 1 FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0 AND source_commit IS NOT ?) THEN 1 ELSE 0 END`).bind(lockAt,date,venue,source.runners.length,date,venue,source.cardSha);
}
export function predictionBindingStatements(db:D1Database,payload:any,source:any) {
  const engine=payload.eloEngine??'v12';
  const object=`json_object(${PREDICTION_COLUMNS.map(c=>`'${c}',${c}`).join(',')})`;
  return [db.prepare(`INSERT OR REPLACE INTO hkjc_prediction_inputs VALUES(?,?,?,?,?,?)`).bind(payload.date,engine,source.cardSha,source.changesSha,JSON.stringify(source.runners),source.checkedAt),db.prepare(`INSERT OR REPLACE INTO hkjc_input_bindings SELECT ?,?,json_group_array(json(row_json)),?,? FROM (SELECT ${object} AS row_json FROM prediction_log WHERE date=? AND engine=? AND variant='baseline' ORDER BY race_number,predicted_rank,horse_id)`).bind(payload.date,engine,source.cardSha,source.changesSha,payload.date,engine)];
}
export async function assertFreezeInput(db:D1Database,date:string,venue:string,lockAt:string) {
  const changes=await captureOfficialChanges(db);
  if(changes.date!==date||changes.venue!==venue)throw new Error('official-changes-wrong-meeting');
  const receipt=await db.prepare(`SELECT * FROM hkjc_prediction_inputs WHERE date=? AND engine='v12'`).bind(date).first<any>();
  const locked=Date.parse(lockAt),checked=Date.parse(receipt?.checked_at??'');
  if(!receipt||!Number.isFinite(checked)||checked>locked||locked-checked>6*60000)throw new Error('official-prelock-receipt-missing-or-stale');
  const previous=await db.prepare("SELECT raw FROM hkjc_source_versions WHERE date=? AND venue=? AND kind='changes' AND sha=?").bind(date,venue,receipt.changes_sha).first<{raw:string}>();
  if(!previous)throw new Error('official-input-source-missing');
  const old=parseHkjcChangesPage(previous.raw);
  const key=(c:any)=>JSON.stringify([c.raceNumber,c.horseNumber,c.horseName,c.text,c.announcedAtIso]);
  const existing=new Set((old?.changes??[]).map(key));
  if(changes.changes.some(c=>!existing.has(key(c))&&(!c.announcedAtIso||Date.parse(c.announcedAtIso)<=locked)))throw new Error('official-prelock-change-not-recomputed');
  const active=await db.prepare("SELECT race_number,horse_number,horse_id,source_commit FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0").bind(date,venue).all<any>();
  const runners=JSON.parse(receipt.runner_json);
  const activeSet=new Set(runners.map((r:any)=>`${r.raceNumber}:${r.horseNumber}:${r.horseId}`));
  if(active.results?.length!==activeSet.size||active.results?.some((r:any)=>r.source_commit!==receipt.card_sha||!activeSet.has(`${r.race_number}:${r.horse_number}:${r.horse_id}`)))throw new Error('official-active-card-version-changed');
  for(const r of runners) {
    const c=officialWithdrawal(changes.changes,r.raceNumber,r.horseNumber,r.nameCh);
    if(c&&(!c.announcedAtIso||Date.parse(c.announcedAtIso)<=locked))throw new Error('official-prelock-withdrawal-not-applied');
  }
  const rows=await db.prepare(`SELECT race_number,horse_number,horse_id,generated_at FROM prediction_log WHERE date=? AND engine='v12' AND variant='baseline'`).bind(date).all<any>();
  const set=new Set(runners.map((r:any)=>`${r.raceNumber}:${r.horseNumber}:${r.horseId}`));
  if(rows.results?.length!==set.size||rows.results?.some((r:any)=>!set.has(`${r.race_number}:${r.horse_number}:${r.horse_id}`)||!Number.isFinite(Date.parse(r.generated_at))||Date.parse(r.generated_at)<checked))throw new Error('official-frozen-version-mismatch');
  const binding=await db.prepare("SELECT * FROM hkjc_input_bindings WHERE date=? AND engine='v12'").bind(date).first<any>();
  if(!binding||binding.card_sha!==receipt.card_sha||binding.changes_sha!==receipt.changes_sha)throw new Error('official-prediction-binding-missing');
  return {bindingJson:binding.prediction_json,cardSha:receipt.card_sha,changesSha:receipt.changes_sha};
}
export function applyOfficialSelection(picks:any[],raceNumber:number,changes:HkjcChangesPage|null,lockAt:string|null) {
  const marked=picks.map(p=>{const c=officialWithdrawal(changes?.changes??[],raceNumber,p.horseNumber??p.horse_number,p.nameCh??p.name_ch);return {...p,horseNumber:Number(p.horseNumber??p.horse_number),rank:Number(p.rank??p.predicted_rank),withdrawn:!!c,announcedAtIso:c?.announcedAtIso};});
  const state=effectiveTop4(marked,lockAt);
  const raceChanges=(changes?.changes??[]).filter(c=>c.raceNumber===raceNumber);
  const jockeyChanges=raceChanges.filter(c=>c.kind==='other'&&/騎師|策騎/.test(c.text));
  const locked=Date.parse(lockAt??'');
  const postLockJockeyChange=jockeyChanges.some(c=>Number.isFinite(locked)&&Number.isFinite(Date.parse(c.announcedAtIso??''))&&Date.parse(c.announcedAtIso??'')>locked);
  const hasUnappliedPrelockJockeyChange=jockeyChanges.some(c=>{if(!Number.isFinite(locked)||!Number.isFinite(Date.parse(c.announcedAtIso??'')))return true;if(Date.parse(c.announcedAtIso??'')>locked)return false;const jockey=c.text.match(/由騎師\s+(\S+)\s+策騎/);const p=marked.find(p=>p.horseNumber===c.horseNumber&&(p.nameCh??p.name_ch)===c.horseName);return !jockey||!p||(p.jockeyCh??p.jockey_ch)!==jockey[1];});
  const status=hasUnappliedPrelockJockeyChange?'invalid-prelock-input':state.status;
  return {...state,status,effective:status==='valid'?state.effective:[],hasWithdrawal:raceChanges.some(c=>c.kind==='scratched'||c.kind==='replaced'),withdrawnHorseNumbers:marked.filter(p=>p.withdrawn).map(p=>p.horseNumber),changes:raceChanges,postLockJockeyChange,picks:status==='valid'?marked.filter(p=>!p.withdrawn).sort((a,b)=>a.rank-b.rank):[]};
}
