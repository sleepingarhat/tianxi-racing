import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDb, ensureSchema } from './ingest/lib/db.js';
const dir=mkdtempSync(join(tmpdir(),'elo-v12-test-'));const path=join(dir,'test.db');
try {
 const db=openDb(path);ensureSchema(db,['src/db/schema.sql','src/db/schema_v2.sql']);
 db.exec("INSERT INTO horse_elo_snapshots(id,horse_id,axis_key,as_of_date,rating) VALUES('old:A','A','overall','2020-01-01',1510)");
 const insert=db.prepare('INSERT INTO horse_form_records(horse_id,race_date,venue,race_number,distance,track,jockey_name,trainer_name,finishing_position_num) VALUES(?,?,?,?,?,?,?,?,?)');
 for(const [date, race, a,b] of [['2026-10-07',1,1,2],['2026-10-11',1,2,1]] as const){
  insert.run('A',date,'ST',race,1200,'草地','騎甲','練甲',a);insert.run('B',date,'ST',race,1200,'草地','騎乙','練乙',b);
 }
 db.close();
 const run=()=>execFileSync('./node_modules/.bin/tsx',['scripts/elo/compute_v12.ts',`--db=${path}`,'--reset'],{stdio:'pipe'});
 run(); const read=()=>{const d=new Database(path,{readonly:true});const rows=d.prepare("SELECT id,rating,games_played,confidence FROM horse_elo_snapshots WHERE id LIKE 'v12:%' ORDER BY id").all();assert.equal((d.prepare("SELECT rating FROM horse_elo_snapshots WHERE id='old:A'").get() as {rating:number}).rating,1510);const latest=d.prepare("SELECT MAX(as_of_date) AS date FROM jockey_elo_snapshots WHERE id LIKE 'v12:%'").get() as {date:string};assert.equal(latest.date,'2026-10-11');d.close();return rows;};
 const first=read();assert.equal(first.length,8);run();assert.deepEqual(read(),first);
 assert.throws(()=>execFileSync('./node_modules/.bin/tsx',['scripts/elo/compute_v12.ts',`--db=${path}`,'--since=2026-10-07'],{stdio:'pipe'}));
 console.log('v12 replay deterministic; legacy snapshots retained; unknown flag refused');
} finally {rmSync(dir,{recursive:true,force:true});}
