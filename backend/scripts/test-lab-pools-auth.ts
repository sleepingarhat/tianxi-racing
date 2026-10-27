#!/usr/bin/env tsx
/**
 * pools API 已下架：無論有冇 secret 一律 410 Gone（唔再係產品端點）。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { labPoolsRoutes } from '../src/routes/lab-pools';

async function main(): Promise<void> {
  const app = new Hono();
  app.route('/api/lab', labPoolsRoutes);

  async function hit(path: string, init: RequestInit = {}, env: Record<string, unknown> = {}) {
    return app.fetch(new Request(`http://localhost${path}`, init), {
      DB: null,
      SITE_READER_TOKEN: undefined,
      ...env,
    } as any);
  }

  {
    const res = await hit('/api/lab/pools/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pool: 'FF', raceIds: ['race_2026-10-25_ST_1'], budget: 100 }),
    });
    assert.equal(res.status, 410, 'optimize no secret → 410 gone');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
  }

  {
    const res = await hit('/api/lab/pools/backtest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 410, 'backtest no secret → 410');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
  }

  {
    const res = await hit('/api/lab/pools');
    assert.equal(res.status, 410, 'GET /pools → 410');
  }

  {
    const res = await hit(
      '/api/lab/pools/optimize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Tianxi-Site-Token': 'wrong' },
        body: JSON.stringify({ pool: 'FF', raceIds: ['race_2026-10-25_ST_1'], budget: 100 }),
      },
      { SITE_READER_TOKEN: 'correct' },
    );
    assert.equal(res.status, 410, 'wrong secret → 410');
  }

  {
    const res = await hit(
      '/api/lab/pools/backtest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Tianxi-Site-Token': 'ok' },
        body: JSON.stringify({ pool: 'QUARTET' }),
      },
      { SITE_READER_TOKEN: 'ok', DB: null },
    );
    assert.equal(res.status, 410, `backtest with secret → 410 (got ${res.status})`);
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
    assert.equal(/hkjc\.com\//i.test(JSON.stringify(j)), false);
  }

  {
    const res = await hit(
      '/api/lab/pools/optimize',
      {
        method: 'GET',
        headers: { 'X-Tianxi-Site-Token': 'ok' },
      },
      { SITE_READER_TOKEN: 'ok', DB: null },
    );
    assert.equal(res.status, 410, 'GET optimize with secret → 410');
  }

  {
    const res = await hit('/api/lab/pools/optimize/extra');
    assert.equal(res.status, 410, 'nested pools path → 410');
  }

  console.log('test-lab-pools-auth: all passed (410 gone)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
