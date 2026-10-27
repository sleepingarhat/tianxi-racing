#!/usr/bin/env tsx
/**
 * backtest API 已下架：無論有冇 secret 一律 410 Gone（唔再係產品端點）。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { labRoutes } from '../src/routes/lab';

async function main(): Promise<void> {
  const app = new Hono();
  app.route('/api/lab', labRoutes);

  async function hit(
    path: string,
    init: RequestInit = {},
    env: Record<string, unknown> = {},
  ) {
    const req = new Request(`http://localhost${path}`, init);
    return app.fetch(req, {
      DB: null,
      SITE_READER_TOKEN: undefined,
      ...env,
    } as any);
  }

  {
    const res = await hit('/api/lab/backtest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        features: [{ id: 'elo', weight: 1 }],
        from: '2025-09-01',
        to: '2026-04-01',
        pools: ['FF'],
      }),
    });
    assert.equal(res.status, 410, 'POST backtest no secret → 410 gone');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
  }

  {
    const res = await hit('/api/lab/backtest/abcdef0123456789abcdef0123456789');
    assert.equal(res.status, 410, 'GET backtest no secret → 410');
  }

  {
    const res = await hit(
      '/api/lab/backtest',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tianxi-Site-Token': 'correct-secret',
        },
        body: JSON.stringify({
          features: [
            { id: 'elo', weight: 2 },
            { id: 'form', weight: 1 },
          ],
          from: '2025-09-01',
          to: '2026-10-04',
          pools: ['FF', 'TRIO'],
        }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, `POST backtest with secret → 410 (got ${res.status})`);
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
  }

  {
    const res = await hit(
      '/api/lab/backtest/abcdef0123456789abcdef0123456789',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, 'GET backtest hash with secret → 410');
  }

  console.log('test-lab-backtest-auth: all passed (410 gone)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
