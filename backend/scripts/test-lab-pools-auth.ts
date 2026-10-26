#!/usr/bin/env tsx
/** 彩池優化器合約：無 secret → 401；回傳含 disclaimer；唔回投注 URL。 */
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
    assert.equal(res.status, 401, 'optimize no secret → 401');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'unauthorized');
    assert.ok(String(j.disclaimer ?? '').includes('研究'));
  }

  {
    const res = await hit('/api/lab/pools/backtest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401, 'backtest no secret → 401');
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
    assert.equal(res.status, 401, 'wrong secret → 401');
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
    assert.equal(res.status, 200, 'backtest stub with secret');
    const j = (await res.json()) as any;
    assert.ok(String(j.disclaimer).includes('研究'));
    assert.ok(String(j.researchBanner).includes('唔入公開戰績'));
    assert.equal(j.betUrl, null);
    assert.equal(j.placeBetUrl, null);
    const text = JSON.stringify(j);
    assert.equal(/hkjc\.com\//i.test(text), false);
    assert.equal(typeof j.betUrl === 'string' && j.betUrl.length > 0, false);
    assert.equal(typeof j.placeBetUrl === 'string' && j.placeBetUrl.length > 0, false);
  }

  {
    const res = await hit(
      '/api/lab/pools/optimize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Tianxi-Site-Token': 'ok' },
        body: JSON.stringify({ pool: 'FF', raceIds: ['race_2026-10-25_ST_1'], budget: 100 }),
      },
      { SITE_READER_TOKEN: 'ok', DB: null },
    );
    assert.equal(res.status, 503, 'optimize auth ok, no DB → 503');
  }

  console.log('test-lab-pools-auth: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
