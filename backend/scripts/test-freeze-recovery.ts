import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { PREDICTION_COLUMNS,ensureRecoveryTables,recoverOriginalFreeze,assertOriginalFreezeReadable,validateRows,missingOriginalRows,auditOriginalRaces } from '../src/lib/freeze-recovery';
const sqlite = new Database(':memory:');
class Statement {
  params:any[]=[];
  constructor(public sql:string) {}
  bind(...params:any[]) { this.params=params; return this; }
  async all() { return {results:sqlite.query(this.sql).all(...this.params)}; }
  async first() { return sqlite.query(this.sql).get(...this.params); }
  async run() { return sqlite.query(this.sql).run(...this.params); }
}
const db={prepare:(sql:string)=>new Statement(sql),batch:async(stmts:Statement[])=>sqlite.transaction(()=>stmts.map(s=>sqlite.query(s.sql).run(...s.params)))()} as any;
const text=new Set(['date','horse_id','engine','variant','elo_source','generated_at','lgb_model_version','score_source','factor_scores','pace_estimate']);
const integers=new Set(['race_number','horse_number','draw','predicted_rank']);
sqlite.exec(`CREATE TABLE prediction_log(${PREDICTION_COLUMNS.map(c=>c+' '+(text.has(c)?'TEXT':integers.has(c)?'INTEGER':'REAL')).join(',')},actual_finish INTEGER,PRIMARY KEY(date,race_number,horse_id,engine,variant));CREATE TABLE prediction_lock_meta(date TEXT,engine TEXT,venue TEXT,written_at TEXT,PRIMARY KEY(date,engine));CREATE TABLE entries_upcoming(race_date TEXT,venue TEXT,race_number INTEGER,horse_id TEXT,horse_number INTEGER,priority_order TEXT);`);
const date='2026-10-19',lock='2026-10-19T03:00:00.000Z',now=Date.parse(lock)+1000;
function row(n:number) { return Object.fromEntries(PREDICTION_COLUMNS.map(c=>[c,({date,race_number:1,horse_id:'H'+n,engine:'v12',variant:'baseline',horse_number:n,predicted_rank:n,final_score:1500-n,generated_at:'2026-10-19T02:55:00.000Z'} as any)[c]??null])); }
const rows=[1,2,3,4,5].map(row);
rows[0].factor_bonus=1;rows[0].elo_confidence=0.93;rows[0].final_score=1628.8;
const completeAudit=await auditOriginalRaces(rows,rows,date,'v12');assert.equal(completeAudit[0].expected,5);assert.equal(completeAudit[0].ok,true);
const absentRace=await auditOriginalRaces(rows,[],date,'v12');assert.equal(absentRace[0].ok,false);assert.equal(absentRace[0].actual,0);
const missingHorse=await auditOriginalRaces(rows,rows.slice(0,4),date,'v12');assert.equal(missingHorse[0].ok,false);
const duplicateRank=await auditOriginalRaces(rows,rows.map((r,i)=>i===4?{...r,predicted_rank:4}:r),date,'v12');assert.equal(duplicateRank[0].ok,false);
const scoreConflict=await auditOriginalRaces(rows,rows.map((r,i)=>i===0?{...r,final_score:100}:r),date,'v12');assert.equal(scoreConflict[0].ok,false);assert.equal(scoreConflict[0].fingerprint,completeAudit[0].fingerprint);
console.log('PASS five per-race audit checks');
for(const r of rows){await db.prepare(`INSERT INTO prediction_log(${PREDICTION_COLUMNS.join(',')}) VALUES(${PREDICTION_COLUMNS.map(()=>'?').join(',')})`).bind(...PREDICTION_COLUMNS.map(c=>r[c])).run();sqlite.query('INSERT INTO entries_upcoming VALUES(?,?,?,?,?,?)').run(date,'ST',1,r.horse_id,r.horse_number,'正選');}
await db.prepare('INSERT INTO prediction_lock_meta VALUES(?,?,?,?)').bind(date,'v12','ST','2026-10-19T02:55:00.000Z').run();
assert.equal(sqlite.query("SELECT json_object('v',factor_bonus) AS value FROM prediction_log WHERE horse_id='H1'").get()?.value,'{"v":1.0}');
assert.throws(()=>validateRows([rows[0],rows[0],rows[2],rows[3]],date,'v12'));console.log('PASS duplicate horses/ranks rejected');
assert.throws(()=>validateRows(rows.slice(0,3),date,'v12'));console.log('PASS incomplete four picks rejected');
assert.throws(()=>missingOriginalRows(rows,[{...rows[0],horse_elo:1600}]));console.log('PASS original NULL never replaced by live value');
sqlite.exec("ALTER TABLE entries_upcoming ADD COLUMN source_commit TEXT;CREATE TABLE hkjc_input_bindings(date TEXT,engine TEXT,prediction_json TEXT,card_sha TEXT,changes_sha TEXT);CREATE TABLE hkjc_transaction_checks(ok INTEGER CHECK(ok=1));UPDATE entries_upcoming SET source_commit='card'");
const bindingJson=JSON.stringify(rows);
await db.prepare('INSERT INTO hkjc_input_bindings VALUES(?,?,?,?,?)').bind(date,'v12',bindingJson,'card','changes').run();
const binding={bindingJson,cardSha:'card',changesSha:'changes'};
const rejected=await recoverOriginalFreeze(db,date,'ST',lock,'v12',now,{...binding,bindingJson:JSON.stringify(rows.map((r,i)=>i===0?{...r,final_score:9999}:r))});assert.equal(rejected.ok,false);assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM prediction_original_snapshots').get()?.n,0);console.log('PASS altered prediction binding blocks snapshot capture');
let out=await recoverOriginalFreeze(db,date,'ST',lock,'v12',now,binding);assert.equal(out.ok,true,JSON.stringify(out));await assertOriginalFreezeReadable(db,date,'v12');console.log('PASS complete pre-lock original captured and read back');
assert.throws(()=>sqlite.query("UPDATE prediction_original_snapshots SET sha256='bad'" ).run());console.log('PASS original snapshot immutable');
assert.throws(()=>sqlite.query("UPDATE prediction_log SET final_score=2000 WHERE horse_id='H1'").run());console.log('PASS frozen score rewrite blocked');
assert.throws(()=>sqlite.query("DELETE FROM prediction_log WHERE horse_id='H1'").run());console.log('PASS accidental frozen deletion blocked');
assert.throws(()=>sqlite.query("INSERT INTO prediction_log(date,race_number,horse_id,engine,variant) VALUES(?,1,'LIVE','v12','baseline')").run(date));console.log('PASS live replacement insert blocked');
sqlite.query("UPDATE prediction_log SET actual_finish=1 WHERE horse_id='H1'").run();console.log('PASS settlement still permitted');
// Simulate storage damage, not ordinary application access. Recovery only inserts exact missing originals.
sqlite.exec('DROP TRIGGER frozen_prediction_no_delete');sqlite.query("DELETE FROM prediction_log WHERE horse_id='H5'").run();
await assert.rejects(()=>assertOriginalFreezeReadable(db,date,'v12'));out=await recoverOriginalFreeze(db,date,'ST',lock,'v12',now);assert.equal(out.restored,1);assert.equal(out.ok,true);assert.equal(sqlite.query("SELECT actual_finish FROM prediction_log WHERE horse_id='H1'").get()?.actual_finish,1);await assertOriginalFreezeReadable(db,date,'v12');console.log('PASS missing fifth restored exactly and settlement preserved');
out=await recoverOriginalFreeze(db,date,'ST',lock,'v12',now);assert.equal(out.restored,0);console.log('PASS repeated recovery idempotent');
sqlite.exec('DROP TRIGGER frozen_prediction_no_update');sqlite.query("UPDATE prediction_log SET final_score=1 WHERE horse_id='H1'").run();out=await recoverOriginalFreeze(db,date,'ST',lock,'v12',now);assert.equal(out.ok,false);assert.equal(sqlite.query("SELECT final_score FROM prediction_log WHERE horse_id='H1'").get()?.final_score,1);await assert.rejects(()=>assertOriginalFreezeReadable(db,date,'v12'));console.log('PASS conflicting row blocked, never rewritten');
out=await recoverOriginalFreeze(db,'2026-10-14','HV','2026-10-14T09:00:00.000Z','v12',now);assert.equal(out.ok,false);assert.equal(out.error,'historical-original-unavailable');console.log('PASS no fabricated historical snapshot');
console.log('All 13 checks passed');
console.log('PASS REAL 1.0 vs JSON 1 capture regression (production affinity)');
await Bun.write('/tmp/freeze-recovery/schema.sql',sqlite.query("SELECT sql FROM sqlite_master WHERE (type='table' AND name IN ('prediction_original_snapshots','prediction_recovery_status')) OR type='trigger' ORDER BY CASE WHEN type='table' THEN 0 ELSE 1 END,name").all().map((r:any)=>r.sql+';').join('\n'));
