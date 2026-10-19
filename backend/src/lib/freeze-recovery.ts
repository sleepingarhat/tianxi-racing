/** Original-only freeze recovery. Never computes predictions or rewrites an existing row. */
export const PREDICTION_COLUMNS = ['date','race_number','horse_id','engine','variant','horse_number','draw','horse_elo','elo_source','elo_confidence','elo_composite','factor_bonus','final_score','p_win','p_top3','predicted_rank','generated_at','lgb_score','lgb_model_version','score_source','jockey_elo','trainer_elo','factor_scores','pace_estimate'] as const;
type Row = Record<string, any>;
type Snapshot = { schema: 1; date: string; engine: string; venue: string; lockAt: string; rows: Row[]; meta: Row | null };
export type RecoveryResult = { ok: boolean; action: string; restored: number; error?: string };
export type RaceAudit = { race_number: number; expected: number; actual: number; ok: boolean; fingerprint: string; error: string | null };
/** Audit each race against immutable originals, never against changed race-day entries. */
export async function auditOriginalRaces(original: Row[], current: Row[], date: string, engine: string): Promise<RaceAudit[]> {
  validateRows(original, date, engine);
  const numbers = [...new Set([...original, ...current].map(r => r.race_number))].sort((a,b)=>a-b);
  const audits: RaceAudit[] = [];
  for (const race_number of numbers) {
    const source = original.filter(r=>r.race_number===race_number);
    const actual = current.filter(r=>r.race_number===race_number);
    let error: string | null = null;
    try {
      if (!source.length) throw new Error('unexpected-race');
      validateRows(actual,date,engine);
      if (missingOriginalRows(source,actual).length) throw new Error('race-runner-count-mismatch');
    } catch(e) { error=e instanceof Error?e.message:'race-audit-failed'; }
    audits.push({race_number,expected:source.length,actual:actual.length,ok:error===null,fingerprint:await digest(JSON.stringify(source.map(project))),error});
  }
  return audits;
}
const blocked = (error: string): RecoveryResult => ({ ok: false, action: 'blocked', restored: 0, error });
function project(row: Row): Row { return Object.fromEntries(PREDICTION_COLUMNS.map(c => [c, row[c] ?? null])); }
export function validateRows(rows: Row[], date: string, engine: string): void {
  if (!rows.length) throw new Error('missing-original-rows');
  const races = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.date !== date || r.engine !== engine || r.variant !== 'baseline' || !r.horse_id || !Number.isInteger(r.race_number) || r.race_number < 1 || !Number.isInteger(r.predicted_rank) || r.predicted_rank < 1 || !Number.isFinite(r.final_score) || !Number.isFinite(Date.parse(r.generated_at))) throw new Error('invalid-original-row');
    const list = races.get(r.race_number) ?? []; list.push(r); races.set(r.race_number, list);
  }
  for (const list of races.values()) {
    if (list.length < 4 || new Set(list.map(r => r.horse_id)).size !== list.length || new Set(list.map(r => r.horse_number)).size !== list.length || list.some(r => !Number.isInteger(r.horse_number) || r.horse_number < 1) || new Set(list.map(r => r.predicted_rank)).size !== list.length || list.some(r => r.predicted_rank > list.length)) throw new Error('duplicate-or-incomplete-original');
  }
}
export function missingOriginalRows(original: Row[], current: Row[]): Row[] {
  const source = new Map(original.map(r => [`${r.race_number}:${r.horse_id}`, JSON.stringify(project(r))]));
  const seen = new Set<string>();
  for (const r of current) {
    const key = `${r.race_number}:${r.horse_id}`;
    if (seen.has(key) || source.get(key) !== JSON.stringify(project(r))) throw new Error('existing-row-conflicts-with-original');
    seen.add(key);
  }
  return original.filter(r => !seen.has(`${r.race_number}:${r.horse_id}`));
}
export async function digest(text: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(n => n.toString(16).padStart(2,'0')).join(''); }
export async function ensureRecoveryTables(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS prediction_original_snapshots (date TEXT NOT NULL, engine TEXT NOT NULL, snapshot_json TEXT NOT NULL, sha256 TEXT NOT NULL, captured_at TEXT NOT NULL, PRIMARY KEY(date,engine))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS prediction_recovery_history (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, engine TEXT NOT NULL, checked_at TEXT NOT NULL, ok INTEGER NOT NULL, action TEXT NOT NULL, restored INTEGER NOT NULL, error TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS prediction_recovery_status (date TEXT NOT NULL, engine TEXT NOT NULL, checked_at TEXT NOT NULL, ok INTEGER NOT NULL, action TEXT NOT NULL, restored INTEGER NOT NULL, error TEXT, PRIMARY KEY(date,engine))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS prediction_race_audit_history (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, engine TEXT NOT NULL, race_number INTEGER NOT NULL, checked_at TEXT NOT NULL, expected INTEGER NOT NULL, actual INTEGER NOT NULL, ok INTEGER NOT NULL, fingerprint TEXT NOT NULL, error TEXT)`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS original_snapshot_no_update BEFORE UPDATE ON prediction_original_snapshots BEGIN SELECT RAISE(ABORT,'original snapshot immutable'); END`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS original_snapshot_no_delete BEFORE DELETE ON prediction_original_snapshots BEGIN SELECT RAISE(ABORT,'original snapshot immutable'); END`).run();
  const changed = PREDICTION_COLUMNS.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS frozen_prediction_no_update BEFORE UPDATE ON prediction_log WHEN EXISTS (SELECT 1 FROM prediction_original_snapshots s WHERE s.date=OLD.date AND s.engine=OLD.engine) AND (${changed}) BEGIN SELECT RAISE(ABORT,'frozen prediction immutable'); END`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS frozen_prediction_no_delete BEFORE DELETE ON prediction_log WHEN EXISTS (SELECT 1 FROM prediction_original_snapshots s WHERE s.date=OLD.date AND s.engine=OLD.engine) BEGIN SELECT RAISE(ABORT,'frozen prediction immutable'); END`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS frozen_meta_no_update BEFORE UPDATE ON prediction_lock_meta WHEN EXISTS (SELECT 1 FROM prediction_original_snapshots s WHERE s.date=OLD.date AND s.engine=OLD.engine) BEGIN SELECT RAISE(ABORT,'lock meta immutable'); END`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS frozen_meta_no_delete BEFORE DELETE ON prediction_lock_meta WHEN EXISTS (SELECT 1 FROM prediction_original_snapshots s WHERE s.date=OLD.date AND s.engine=OLD.engine) BEGIN SELECT RAISE(ABORT,'lock meta immutable'); END`).run();
  // Inserts after capture must be an exact copy of an original row, including NULL.
  const matches = PREDICTION_COLUMNS.map(c => `json_extract(j.value,'$.${c}') IS NEW.${c}`).join(' AND ');
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS frozen_prediction_original_insert BEFORE INSERT ON prediction_log WHEN EXISTS (SELECT 1 FROM prediction_original_snapshots s WHERE s.date=NEW.date AND s.engine=NEW.engine) AND NOT EXISTS (SELECT 1 FROM prediction_original_snapshots s,json_each(s.snapshot_json,'$.rows') j WHERE s.date=NEW.date AND s.engine=NEW.engine AND ${matches}) BEGIN SELECT RAISE(ABORT,'not an original prediction'); END`).run();
}
async function rowsFor(db: D1Database,date: string,engine: string) { const r = await db.prepare(`SELECT ${PREDICTION_COLUMNS.join(',')} FROM prediction_log WHERE date=? AND engine=? AND variant='baseline' ORDER BY race_number,predicted_rank,horse_id`).bind(date,engine).all<Row>(); return r.results ?? []; }
export async function recoverOriginalFreeze(db: D1Database, date: string, venue: string, lockAt: string, engine = 'v12', now = Date.now()): Promise<RecoveryResult> {
  let result: RecoveryResult;
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['ST','HV'].includes(venue) || !Number.isFinite(Date.parse(lockAt)) || now < Date.parse(lockAt)) throw new Error('not-a-confirmed-lock');
    await ensureRecoveryTables(db);
    let saved = await db.prepare(`SELECT snapshot_json,sha256 FROM prediction_original_snapshots WHERE date=? AND engine=?`).bind(date,engine).first<{snapshot_json:string;sha256:string}>();
    if (!saved) {
      // Only current meeting, only genuinely pre-lock rows; never manufacture a historical original.
      if (new Date(now + 8*3600_000).toISOString().slice(0,10) !== date) throw new Error('historical-original-unavailable');
      const rows = await rowsFor(db,date,engine); validateRows(rows,date,engine);
      if (rows.some(r => Date.parse(r.generated_at) > Date.parse(lockAt))) throw new Error('post-lock-row-cannot-be-original');
      const fixtures = await db.prepare(`SELECT race_number,horse_id,horse_number FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0 AND (priority_order IS NULL OR priority_order='' OR priority_order='正選') ORDER BY race_number,horse_number`).bind(date,venue).all<Row>();
      const expected = fixtures.results ?? [];
      const keys = (rs: Row[]) => rs.map(r => `${r.race_number}:${r.horse_id}:${r.horse_number}`).sort().join('|');
      if (!expected.length || rows.length !== expected.length || keys(rows) !== keys(expected)) throw new Error('fixture-original-incomplete');
      const meta = await db.prepare(`SELECT * FROM prediction_lock_meta WHERE date=? AND engine=?`).bind(date,engine).first<Row>();
      if (!meta || meta.venue !== venue || !Number.isFinite(Date.parse(meta.written_at)) || Date.parse(meta.written_at)>Date.parse(lockAt)) throw new Error('original-lock-meta-unavailable');
      const snapshot: Snapshot = {schema:1,date,engine,venue,lockAt,rows,meta};
      const text=JSON.stringify(snapshot); const hash=await digest(text);
      // Capture guard and snapshot insertion share one transaction. A concurrent draft cannot change its rows.
      // Compare typed values, not JSON formatting: SQLite serializes REAL 1 as 1.0,
      // while JavaScript serializes it as 1. Counts + every field (including NULL)
      // still guard the read/write race inside this single INSERT transaction.
      const sameFields = PREDICTION_COLUMNS.map(c => `p.${c} IS json_extract(j.value,'$.${c}')`).join(' AND ');
      const insert = db.prepare(`INSERT OR IGNORE INTO prediction_original_snapshots(date,engine,snapshot_json,sha256,captured_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM prediction_log WHERE date=? AND engine=? AND variant='baseline') = ? AND NOT EXISTS (SELECT 1 FROM prediction_log p WHERE p.date=? AND p.engine=? AND p.variant='baseline' AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE ${sameFields}))`).bind(date,engine,text,hash,new Date(now).toISOString(),date,engine,rows.length,date,engine,JSON.stringify(rows));
      await db.batch([insert]);
      saved=await db.prepare(`SELECT snapshot_json,sha256 FROM prediction_original_snapshots WHERE date=? AND engine=?`).bind(date,engine).first<{snapshot_json:string;sha256:string}>();
      if (!saved) throw new Error('concurrent-capture-retry');
    }
    if (await digest(saved.snapshot_json) !== saved.sha256) throw new Error('original-hash-mismatch');
    const snapshot = JSON.parse(saved.snapshot_json) as Snapshot;
    if (snapshot.schema!==1 || snapshot.date!==date || snapshot.engine!==engine || snapshot.venue!==venue || snapshot.lockAt!==lockAt) throw new Error('original-identity-mismatch');
    validateRows(snapshot.rows,date,engine);
    const current=await rowsFor(db,date,engine);
    const checkedAt=new Date(now).toISOString();
    const before=await auditOriginalRaces(snapshot.rows,current,date,engine);
    await db.batch(before.map(a=>db.prepare(`INSERT INTO prediction_race_audit_history(date,engine,race_number,checked_at,expected,actual,ok,fingerprint,error) VALUES (?,?,?,?,?,?,?,?,?)`).bind(date,engine,a.race_number,checkedAt,a.expected,a.actual,a.ok?1:0,a.fingerprint,a.error)));
    const missing=missingOriginalRows(snapshot.rows,current);
    const meta=await db.prepare(`SELECT * FROM prediction_lock_meta WHERE date=? AND engine=?`).bind(date,engine).first<Row>();
    if (meta && JSON.stringify(meta) !== JSON.stringify(snapshot.meta)) throw new Error('lock-meta-conflict');
    const writes=missing.map(r => db.prepare(`INSERT OR IGNORE INTO prediction_log (${PREDICTION_COLUMNS.join(',')}) VALUES (${PREDICTION_COLUMNS.map(()=>'?').join(',')})`).bind(...PREDICTION_COLUMNS.map(c=>r[c]??null)));
    if (!meta && snapshot.meta) { const cols=Object.keys(snapshot.meta); writes.push(db.prepare(`INSERT OR IGNORE INTO prediction_lock_meta (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).bind(...cols.map(c=>snapshot.meta?.[c]??null))); }
    if (writes.length) await db.batch(writes);
    if (missingOriginalRows(snapshot.rows,await rowsFor(db,date,engine)).length) throw new Error('recovery-readback-incomplete');
    const after=await auditOriginalRaces(snapshot.rows,await rowsFor(db,date,engine),date,engine);
    if(after.some(a=>!a.ok)) throw new Error('race-audit-readback-failed');
    if(missing.length) await db.batch(after.map(a=>db.prepare(`INSERT INTO prediction_race_audit_history(date,engine,race_number,checked_at,expected,actual,ok,fingerprint,error) VALUES (?,?,?,?,?,?,?,?,?)`).bind(date,engine,a.race_number,new Date(now+1).toISOString(),a.expected,a.actual,a.ok?1:0,a.fingerprint,a.error)));
    result={ok:true,action:missing.length?'restored-original':'verified-original',restored:missing.length};
  } catch(e) { result=blocked(e instanceof Error?e.message:String(e)); }
  try { await db.prepare(`INSERT INTO prediction_recovery_history(date,engine,checked_at,ok,action,restored,error) VALUES (?,?,?,?,?,?,?)`).bind(date,engine,new Date(now).toISOString(),result.ok?1:0,result.action,result.restored,result.error??null).run(); } catch { return blocked('recovery-history-write-failed'); }
  try { await db.prepare(`INSERT INTO prediction_recovery_status(date,engine,checked_at,ok,action,restored,error) VALUES (?,?,?,?,?,?,?) ON CONFLICT(date,engine) DO UPDATE SET checked_at=excluded.checked_at,ok=excluded.ok,action=excluded.action,restored=excluded.restored,error=excluded.error`).bind(date,engine,new Date(now).toISOString(),result.ok?1:0,result.action,result.restored,result.error??null).run(); } catch { return blocked('recovery-status-write-failed'); }
  return result;
}
/** Reads never trust a blocked meeting. Historical rows with no new snapshot remain legacy evidence. */
export async function assertOriginalFreezeReadable(db:D1Database,date:string,engine:string) {
  const status=await db.prepare(`SELECT ok,error FROM prediction_recovery_status WHERE date=? AND engine=?`).bind(date,engine).first<{ok:number;error:string|null}>();
  if (status && !status.ok) throw new Error(status.error??'freeze-recovery-blocked');
  const saved=await db.prepare(`SELECT snapshot_json,sha256 FROM prediction_original_snapshots WHERE date=? AND engine=?`).bind(date,engine).first<{snapshot_json:string;sha256:string}>();
  if (!saved) return;
  if(await digest(saved.snapshot_json)!==saved.sha256) throw new Error('original-hash-mismatch');
  const original=JSON.parse(saved.snapshot_json) as Snapshot;
  if(original.schema!==1 || original.date!==date || original.engine!==engine) throw new Error('original-identity-mismatch');
  validateRows(original.rows,date,engine);
  const meta=await db.prepare(`SELECT * FROM prediction_lock_meta WHERE date=? AND engine=?`).bind(date,engine).first<Row>();
  if(JSON.stringify(meta)!==JSON.stringify(original.meta)) throw new Error('lock-meta-conflict');
  if(missingOriginalRows(original.rows,await rowsFor(db,date,engine)).length) throw new Error('missing-original-await-recovery');
}
