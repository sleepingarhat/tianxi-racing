/**
 * Lab pools optimizer routes — decommissioned (產品面移除).
 * Mounted under /api/lab. Every /pools* path returns 410 Gone,
 * with or without a reader secret. Pure helpers stay in lib/lab-pools.
 *
 * POST /api/lab/pools/optimize
 * POST /api/lab/pools/backtest
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { labFeatureGone } from './lab';

export const labPoolsRoutes = new Hono<{ Bindings: Env }>();

/** 彩池優化器已下架。舊客戶端呼叫回 410 Gone。 */
labPoolsRoutes.all('/pools', (c) => labFeatureGone(c));
labPoolsRoutes.all('/pools/:action', (c) => labFeatureGone(c));
labPoolsRoutes.all('/pools/*', (c) => labFeatureGone(c));
