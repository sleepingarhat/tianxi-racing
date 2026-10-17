import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
const db=new Database(':memory:');
for (const entity of ['horse','jockey','trainer']) {
 db.exec(`CREATE TABLE ${entity}_elo_snapshots(id TEXT,${entity}_id TEXT,rating REAL,confidence REAL,is_frozen INTEGER,is_retired INTEGER,is_provisional INTEGER${entity==='horse'?',axis_key TEXT':''},as_of_date TEXT)`);
 const add=db.prepare(`INSERT INTO ${entity}_elo_snapshots VALUES(?,?,?,?,?,?,?${entity==='horse'?',?':''},?)`);
 for(const [date,no,rating] of [['2026-10-14',2,1502],['2026-10-14',10,1510],['2026-10-19',1,9999]] as const) add.run(`v12:A|overall|${date}|ST|${no}`,'A',rating,0.5,0,0,0,...(entity==='horse'?['overall']:[]),date);
 const source=readFileSync('src/routes/analyze.ts','utf8');const section=source.slice(source.indexOf('async function fetchAxisEloReading'),source.indexOf('async function fetchAxisElo',source.indexOf('async function fetchAxisEloReading')+20));
 const template=section.match(/`SELECT rating, confidence[\s\S]*?LIMIT 1`/)?.[0];if(!template)throw new Error('Missing production reading SQL');
 const sql=template.slice(1,-1).replace('${table}',`${entity}_elo_snapshots`).replace('${col}',`${entity}_id`).replace('${entityTable === \'horse\' ? " AND axis_key = \'overall\'" : \'\'}',entity==='horse'?" AND axis_key = 'overall'":'');
 const row=db.prepare(sql).get('A','2026-10-19') as {rating:number};assert.equal(row.rating,1510,entity+' excludes same-day result and chooses race 10 not 2');
}
console.log('all three production readers exclude same-day results and choose last numeric race');
