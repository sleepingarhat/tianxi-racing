/**
 * Lab pools optimizer routes — self-contained mount under /api/lab
 * to avoid merge conflicts with lab.ts (#103 style).
 *
 * POST /api/lab/pools/optimize
 * POST /api/lab/pools/backtest  (MVP stub / simplified)
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { hasReaderCredential, READER_VARY } from '../lib/tg-reader';
import {
  POOLS_DISCLAIMER,
  POOLS_RESEARCH_BANNER,
  loadFrozenFieldForRaceId,
  optimizePools,
  parseMethod,
  parsePool,
  type RaceFrozenField,
} from '../lib/lab-pools';

export const labPoolsRoutes = new Hono<{ Bindings: Env }>();

async function requireLabSecret(c: any): Promise<Response | null> {
  if (await hasReaderCredential(c)) return null;
  c.header('Vary', READER_VARY);
  c.header('Cache-Control', 'private, no-store');
  return c.json(
    { error: 'unauthorized', message: '此研究室 API 需要服務憑證', disclaimer: POOLS_DISCLAIMER },
    401,
  );
}

function noBetLinks<T extends Record<string, unknown>>(body: T): T {
  // Hard guarantee: never emit betting URLs.
  const json = JSON.stringify(body);
  if (/hkjc\.com\/|投注連結|\/betting\//i.test(json)) {
    throw new Error('refusing to emit betting URL');
  }
  return body;
}

labPoolsRoutes.post('/pools/optimize', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', READER_VARY);

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: '需要 JSON body', disclaimer: POOLS_DISCLAIMER }, 400);
  }

  const pool = parsePool(String(body.pool ?? ''));
  if (!pool) {
    return c.json(
      {
        error: 'bad_request',
        message: 'pool 須為 FF／QUARTET／TRIO（孖T／三T 為 phase-2）',
        disclaimer: POOLS_DISCLAIMER,
        researchBanner: POOLS_RESEARCH_BANNER,
      },
      400,
    );
  }
  const method = parseMethod(body.method);
  const budget = Number(body.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000) {
    return c.json({ error: 'bad_request', message: 'budget 須為正數', disclaimer: POOLS_DISCLAIMER }, 400);
  }
  const raceIdsRaw = body.raceIds ?? body.race_ids;
  if (!Array.isArray(raceIdsRaw) || raceIdsRaw.length < 1 || raceIdsRaw.length > 12) {
    return c.json(
      { error: 'bad_request', message: 'raceIds 須為 1–12 個場次 id', disclaimer: POOLS_DISCLAIMER },
      400,
    );
  }
  const raceIds = raceIdsRaw.map((x: unknown) => String(x).trim()).filter(Boolean);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'unavailable', message: '資料庫未就緒', disclaimer: POOLS_DISCLAIMER }, 503);

  const fields: RaceFrozenField[] = [];
  const loadErrors: { raceId: string; status: number; error: string; message: string }[] = [];
  for (const raceId of raceIds) {
    const loaded = await loadFrozenFieldForRaceId(db, raceId);
    if (!loaded.ok) {
      loadErrors.push({ raceId, status: loaded.status, error: loaded.error, message: loaded.message });
      continue;
    }
    fields.push(loaded.field);
  }
  if (!fields.length) {
    const first = loadErrors[0];
    const status = (first?.status === 400 || first?.status === 403 || first?.status === 404
      ? first.status
      : 404) as 400 | 403 | 404;
    return c.json(
      {
        error: first?.error ?? 'not_found',
        message: first?.message ?? '無可用凍結場次',
        loadErrors,
        disclaimer: POOLS_DISCLAIMER,
        researchBanner: POOLS_RESEARCH_BANNER,
      },
      status,
    );
  }

  const result = optimizePools({ pool, method, budget, fields });
  return c.json(
    noBetLinks({
      pool,
      method,
      budget,
      raceIds: fields.map((f) => f.raceId),
      ...result,
      loadErrors,
      betUrl: null,
      placeBetUrl: null,
    }),
  );
});

/** MVP backtest stub：回傳 disclaimer + 空序列；真實歷史派彩對照 phase-2。 */
labPoolsRoutes.post('/pools/backtest', async (c) => {
  const denied = await requireLabSecret(c);
  if (denied) return denied;
  c.header('Cache-Control', 'private, no-store');

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const pool = parsePool(String(body.pool ?? 'FF')) ?? 'FF';
  const method = parseMethod(body.method);
  return c.json(
    noBetLinks({
      status: 'stub',
      pool,
      method,
      from: body.from ?? null,
      to: body.to ?? null,
      rows: [] as {
        date: string;
        cost: number;
        dividend: number;
        net: number;
        hit: boolean;
      }[],
      summary: {
        meetings: 0,
        totalCost: 0,
        totalDividend: 0,
        net: 0,
        hitRate: null as number | null,
        note: 'MVP stub：歷史成本／派彩／對照官方膽拖列 phase-2；特徵回測見 /features',
      },
      disclaimer: POOLS_DISCLAIMER,
      researchBanner: POOLS_RESEARCH_BANNER,
      betUrl: null,
      placeBetUrl: null,
    }),
  );
});
