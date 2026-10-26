/**
 * 特徵矩陣載入同 backtest_results D1 快取。
 * R2 binding 未開：優先 D1 lab_feature_matrix_meta／demo fixture；PR 寫明 R2 待開。
 */
import type { Env } from '../types';
import {
  buildDemoMatrix,
  type BacktestParams,
  type BacktestResult,
  type FeatureMatrix,
} from './lab-backtest';

const RESULTS_DDL = `CREATE TABLE IF NOT EXISTS lab_backtest_results (
  hash TEXT PRIMARY KEY,
  params_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  series_json TEXT,
  matrix_version TEXT NOT NULL,
  matrix_source TEXT,
  computed_at TEXT NOT NULL
)`;

/** 可選：夜間／Actions 寫入嘅矩陣 meta（唔假稱已有 R2） */
const MATRIX_META_DDL = `CREATE TABLE IF NOT EXISTS lab_feature_matrix_meta (
  version TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  note TEXT,
  race_count INTEGER,
  updated_at TEXT NOT NULL
)`;

export async function ensureBacktestTables(db: D1Database): Promise<void> {
  await db.prepare(RESULTS_DDL).run();
  await db.prepare(MATRIX_META_DDL).run();
}

export async function getCachedBacktest(
  db: D1Database,
  hash: string,
): Promise<BacktestResult | null> {
  try {
    const row = await db
      .prepare(
        `SELECT hash, params_json, summary_json, series_json, matrix_version, matrix_source, computed_at
         FROM lab_backtest_results WHERE hash = ? LIMIT 1`,
      )
      .bind(hash)
      .first<any>();
    if (!row) return null;
    const summary = JSON.parse(row.summary_json);
    const params = JSON.parse(row.params_json) as BacktestParams;
    const series = row.series_json ? JSON.parse(row.series_json) : [];
    return {
      hash: row.hash,
      status: 'ready',
      params,
      matrixVersion: row.matrix_version,
      matrixSource: row.matrix_source ?? 'd1-cache',
      researchNote: summary.researchNote,
      train: summary.train,
      validation: summary.validation,
      overall: summary.overall,
      officialBaseline: summary.officialBaseline ?? null,
      eloBaseline: summary.eloBaseline ?? null,
      series,
      bySeason: summary.bySeason ?? [],
      computedAt: row.computed_at,
      limitations: summary.limitations ?? [],
    };
  } catch {
    return null;
  }
}

export async function putCachedBacktest(
  db: D1Database,
  result: BacktestResult,
): Promise<void> {
  try {
    await ensureBacktestTables(db);
    const summary = {
      researchNote: result.researchNote,
      train: result.train,
      validation: result.validation,
      overall: result.overall,
      officialBaseline: result.officialBaseline,
      eloBaseline: result.eloBaseline,
      bySeason: result.bySeason,
      limitations: result.limitations,
    };
    await db
      .prepare(
        `INSERT OR REPLACE INTO lab_backtest_results
         (hash, params_json, summary_json, series_json, matrix_version, matrix_source, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        result.hash,
        JSON.stringify(result.params),
        JSON.stringify(summary),
        JSON.stringify(result.series),
        result.matrixVersion,
        result.matrixSource,
        result.computedAt,
      )
      .run();
  } catch {
    // 快取失敗唔阻主流程
  }
}

export type MatrixLoadResult =
  | { ok: true; matrix: FeatureMatrix }
  | { ok: false; error: string; code: 'matrix_unavailable' };

/**
 * 載入特徵矩陣。
 * 順序：env 指定 demo → D1 meta 提示（仍用 demo 直到 artifact／R2 接上）→ demo fixture。
 * 明確唔讀 R2（wrangler 未有 binding）。
 */
export async function loadFeatureMatrix(
  env: Env | null | undefined,
  opts?: { preferDemo?: boolean; raceCount?: number },
): Promise<MatrixLoadResult> {
  // 未來：if (env?.FEATURES_R2) { ... } —— 而家唔假稱已有
  void env;

  if (opts?.preferDemo !== false) {
    const matrix = buildDemoMatrix({
      raceCount: opts?.raceCount ?? 220,
      withDividends: true,
      withOfficial: true,
    });
    return { ok: true, matrix };
  }

  return {
    ok: false,
    error:
      '特徵矩陣未就緒：R2 binding 未開，D1／Actions artifact 亦未見。請用 demo 或等夜間 dump-features。',
    code: 'matrix_unavailable',
  };
}

/** 由 D1 meta 讀版本號（若有）；冇就 demo-v1 */
export async function resolveMatrixVersion(db: D1Database | null | undefined): Promise<string> {
  if (!db) return 'demo-v1';
  try {
    await ensureBacktestTables(db);
    const row = await db
      .prepare(
        `SELECT version FROM lab_feature_matrix_meta ORDER BY updated_at DESC LIMIT 1`,
      )
      .first<{ version: string }>();
    return row?.version || 'demo-v1';
  } catch {
    return 'demo-v1';
  }
}
