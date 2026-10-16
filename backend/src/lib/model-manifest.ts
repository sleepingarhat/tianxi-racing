/** Retrain-run manifests (2026-10-16). Written only from the retrain workflow's verified
 *  lock-manifest.json (or an import of the same artefacts); never inferred. */
export async function ensureModelManifestTable(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS model_run_manifest (
    run_id TEXT PRIMARY KEY, model_version TEXT NOT NULL, trained_on TEXT,
    training_start TEXT, training_end TEXT, training_rows INTEGER,
    bundle_fingerprint TEXT, fitted_alpha REAL, live_alpha REAL,
    gate_status TEXT, gate_reasons TEXT, head_sha TEXT, source TEXT NOT NULL,
    recorded_at TEXT NOT NULL)`).run();
}
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function parseManifest(m: any) {
  if (!m || typeof m.runId !== 'string' || !/^lgb-ensemble-\d{8}$/.test(String(m.modelVersion))) return null;
  const g = m.gate && typeof m.gate === 'object' ? m.gate : null;
  const st = g && ['PASS', 'FAIL', 'INDETERMINATE'].includes(g.status) ? g.status : null;
  return {
    run_id: m.runId, model_version: m.modelVersion, trained_on: date(m.trainedOn),
    training_start: date(m.trainingStart), training_end: date(m.trainingEnd), training_rows: num(m.trainingRows),
    bundle_fingerprint: typeof m.bundleFingerprint === 'string' && /^[0-9a-f]{24}$/.test(m.bundleFingerprint) ? m.bundleFingerprint : null,
    fitted_alpha: num(m.alpha), live_alpha: g ? num(g.alphaSet) : null, gate_status: st,
    gate_reasons: g && Array.isArray(g.reasons) ? JSON.stringify(g.reasons.slice(0, 20).map(String)) : null,
    head_sha: typeof m.headSha === 'string' ? m.headSha.slice(0, 40) : null,
    source: m.source === 'artifact-import' ? 'artifact-import' : 'workflow',
  };
}
export async function writeManifest(db: D1Database, row: NonNullable<ReturnType<typeof parseManifest>>): Promise<void> {
  await ensureModelManifestTable(db);
  await db.prepare(`INSERT OR REPLACE INTO model_run_manifest (run_id, model_version, trained_on, training_start, training_end,
    training_rows, bundle_fingerprint, fitted_alpha, live_alpha, gate_status, gate_reasons, head_sha, source, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.run_id, row.model_version, row.trained_on, row.training_start,
    row.training_end, row.training_rows, row.bundle_fingerprint, row.fitted_alpha, row.live_alpha, row.gate_status,
    row.gate_reasons, row.head_sha, row.source, new Date().toISOString()).run();
}
/** Latest successful manifest for a model version (the bundle that scored the picks). */
export async function manifestFor(db: D1Database, modelVersion: string | null | undefined) {
  if (!modelVersion) return null;
  await ensureModelManifestTable(db).catch(() => {});
  return db.prepare(`SELECT * FROM model_run_manifest WHERE model_version = ? AND bundle_fingerprint IS NOT NULL
    ORDER BY recorded_at DESC LIMIT 1`).bind(modelVersion).first<any>().catch(() => null);
}
