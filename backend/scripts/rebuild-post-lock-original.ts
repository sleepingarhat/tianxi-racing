#!/usr/bin/env tsx
/**
 * Owner-approved post-lock rebuild of an original freeze ("鎖後補建").
 *
 * Only for a meeting whose capture was blocked and whose pre-lock prediction rows are
 * provably untouched since before the lock. It never computes, edits or deletes a
 * prediction row. The snapshot it writes is labelled inside its SHA-256 covered JSON
 * (provenance.kind = 'post-lock-rebuild') and an append-only attestation row records
 * the approval and evidence, so it can never be read as an on-time original.
 *
 * Refuses unless every check passes:
 *  - no original snapshot exists yet; recovery status is blocked with fixture-original-incomplete
 *    and every recorded check for the date failed with that same reason (no post-lock row write,
 *    which would have produced post-lock-row-cannot-be-original instead);
 *  - every baseline row and the lock meta were written before the lock;
 *  - the only difference from current starters is rows for runners officially marked 退出.
 *
 * Usage: tsx scripts/rebuild-post-lock-original.ts --date=YYYY-MM-DD --approved-at=ISO \
 *          --approval="owner decision text" [--apply]
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, optional D1_API_BASE and
 *      D1_EXTRA_HEADER_NAME / D1_EXTRA_HEADER_VALUE. Without --apply it only reports.
 */
import { PREDICTION_COLUMNS, digest, validateRows } from '../src/lib/freeze-recovery.js';
import { isStarterPriority } from '../src/lib/starter-entries.js';

const DB_ID = 'aad1636e-869a-43f5-aa95-4a19e3aa5517';
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const date = arg('date') ?? '';
const engine = 'v12';
const approvedAt = arg('approved-at') ?? '';
const approval = arg('approval') ?? '';
const apply = process.argv.includes('--apply');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(approvedAt)) || approval.length < 8) {
  throw new Error('need --date, --approved-at and --approval');
}

type Row = Record<string, any>;
async function query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const base = (process.env.D1_API_BASE ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
  const headers: Record<string, string> = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? ''}`, 'Content-Type': 'application/json' };
  if (process.env.D1_EXTRA_HEADER_NAME && process.env.D1_EXTRA_HEADER_VALUE) headers[process.env.D1_EXTRA_HEADER_NAME] = process.env.D1_EXTRA_HEADER_VALUE;
  const res = await fetch(`${base}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, { method: 'POST', headers, body: JSON.stringify({ sql, params }) });
  const body = await res.json() as { success?: boolean; result?: { results: T[] }[]; errors?: { message: string }[] };
  if (!res.ok || !body.success) throw new Error(`D1 ${res.status}: ${(body.errors ?? []).map((e) => e.message).join('; ')}`);
  return body.result?.[0]?.results ?? [];
}

function refuse(reason: string): never { console.error(`refused: ${reason}`); process.exit(2); }

async function main() {

  const existing = await query(`SELECT 1 FROM prediction_original_snapshots WHERE date=? AND engine=?`, [date, engine]);
  if (existing.length) refuse('an original snapshot already exists');
  const [status] = await query<{ ok: number; error: string | null }>(`SELECT ok,error FROM prediction_recovery_status WHERE date=? AND engine=?`, [date, engine]);
  if (!status || status.ok !== 0 || status.error !== 'fixture-original-incomplete') refuse('recovery status is not blocked by fixture-original-incomplete');
  const history = await query<{ error: string | null; n: number; first: string; last: string }>(`SELECT error, COUNT(*) n, MIN(checked_at) first, MAX(checked_at) last FROM prediction_recovery_history WHERE date=? AND engine=? GROUP BY error`, [date, engine]);
  if (history.length !== 1 || history[0].error !== 'fixture-original-incomplete') refuse(`recovery history has other outcomes: ${JSON.stringify(history)}`);

  const [meta] = await query(`SELECT * FROM prediction_lock_meta WHERE date=? AND engine=?`, [date, engine]);
  if (!meta || !['ST', 'HV'].includes(meta.venue)) refuse('lock meta missing');
  const venue = meta.venue as string;
  const [first] = await query<{ pt: string | null }>(`SELECT MIN(post_time) pt FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0 AND post_time IS NOT NULL`, [date, venue]);
  const lockMs = Date.parse(first?.pt ?? '') - 90 * 60_000;
  if (!Number.isFinite(lockMs)) refuse('first post time unavailable');
  const lockAt = new Date(lockMs).toISOString();
  const [manifest] = await query<{ lock_at: string }>(`SELECT lock_at FROM lock_odds_manifest WHERE race_date=? AND venue=?`, [date, venue]).catch(() => []);
  if (manifest && Date.parse(manifest.lock_at) !== lockMs) refuse(`lock time ${lockAt} disagrees with lock odds manifest ${manifest.lock_at}`);
  if (!(Date.parse(meta.written_at) <= lockMs)) refuse('lock meta written after the lock');

  const rows = await query(`SELECT ${PREDICTION_COLUMNS.join(',')} FROM prediction_log WHERE date=? AND engine=? AND variant='baseline' ORDER BY race_number,predicted_rank,horse_id`, [date, engine]);
  validateRows(rows, date, engine);
  if (rows.some((r) => !(Date.parse(r.generated_at) <= lockMs))) refuse('a baseline row was written after the lock');

  const entries = await query<{ race_number: number; horse_id: string; horse_number: number; priority_order: string | null }>(`SELECT race_number,horse_id,horse_number,priority_order FROM entries_upcoming WHERE race_date=? AND venue=? AND race_number>0`, [date, venue]);
  const key = (r: Row) => `${r.race_number}:${r.horse_id}:${r.horse_number}`;
  const starters = new Set(entries.filter((e) => isStarterPriority(e.priority_order)).map(key));
  const withdrawn = new Map(entries.filter((e) => e.priority_order === '退出').map((e) => [key(e), e]));
  const rowKeys = new Set(rows.map(key));
  const missing = [...starters].filter((k) => !rowKeys.has(k));
  const extra = rows.filter((r) => !starters.has(key(r)));
  if (missing.length) refuse(`starters without a prediction row: ${missing.join(',')}`);
  if (extra.some((r) => !withdrawn.has(key(r)))) refuse('a prediction row is neither a starter nor an official 退出 runner');

  const rebuiltAt = new Date().toISOString();
  const evidence = {
    rowsGeneratedAt: [rows.map((r) => r.generated_at).sort()[0], rows.map((r) => r.generated_at).sort().at(-1)],
    metaWrittenAt: meta.written_at,
    blockedChecks: history[0].n, firstBlockedAt: history[0].first, lastBlockedAt: history[0].last,
    withdrawnRowsKept: extra.map((r) => ({ race: r.race_number, horseNumber: r.horse_number, horseId: r.horse_id, predictedRank: r.predicted_rank })),
  };
  const provenance = { kind: 'post-lock-rebuild', approvedBy: 'owner', approvedAt, approval, rebuiltAt, blockedReason: 'fixture-original-incomplete', evidence };
  const snapshot = { schema: 1, date, engine, venue, lockAt, rows, meta, provenance };
  const text = JSON.stringify(snapshot);
  const sha = await digest(text);
  console.log(JSON.stringify({ date, venue, lockAt, rows: rows.length, sha256: sha, evidence }, null, 2));
  if (!apply) { console.log('dry run: nothing written'); return; }

  // Same guarded insert as the lock-tick capture: rows must still equal what was read, field by field.
  const sameFields = PREDICTION_COLUMNS.map((c) => `p.${c} IS json_extract(j.value,'$.${c}')`).join(' AND ');
  await query(`INSERT OR IGNORE INTO prediction_original_snapshots(date,engine,snapshot_json,sha256,captured_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM prediction_log WHERE date=? AND engine=? AND variant='baseline') = ? AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN prediction_log p ON p.date=? AND p.engine=? AND p.variant='baseline' AND p.race_number=json_extract(j.value,'$.race_number') AND p.horse_id=json_extract(j.value,'$.horse_id') WHERE p.horse_id IS NULL OR NOT (${sameFields}))`,
    [date, engine, text, sha, rebuiltAt, date, engine, rows.length, JSON.stringify(rows), date, engine]);
  const [saved] = await query<{ snapshot_json: string; sha256: string }>(`SELECT snapshot_json,sha256 FROM prediction_original_snapshots WHERE date=? AND engine=?`, [date, engine]);
  if (!saved || saved.sha256 !== sha || await digest(saved.snapshot_json) !== sha) refuse('snapshot readback failed; nothing else written, status left blocked');
  await query(`INSERT INTO prediction_rebuild_attestations(date,engine,kind,approved_by,approved_at,approval,rebuilt_at,blocked_reason,rows,snapshot_sha256,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [date, engine, 'post-lock-rebuild', 'owner', approvedAt, approval, rebuiltAt, 'fixture-original-incomplete', rows.length, sha, JSON.stringify(evidence)]);
  await query(`INSERT INTO prediction_recovery_history(date,engine,checked_at,ok,action,restored,error) VALUES (?,?,?,?,?,?,?)`, [date, engine, rebuiltAt, 1, 'post-lock-rebuild', 0, null]);
  await query(`UPDATE prediction_recovery_status SET checked_at=?, ok=1, action='post-lock-rebuild', restored=0, error=NULL WHERE date=? AND engine=?`, [rebuiltAt, date, engine]);
  console.log(`applied: post-lock rebuild ${date} ${engine} sha256=${sha}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
