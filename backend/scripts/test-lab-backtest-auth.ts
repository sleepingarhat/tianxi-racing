#!/usr/bin/env tsx
/**
 * backtest API 合約：冇 secret → 401；壞 body → 400；有 secret → 200（demo 矩陣）。
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
    assert.equal(res.status, 401, 'POST backtest no secret → 401');
  }

  {
    const res = await hit('/api/lab/backtest/abcdef0123456789abcdef0123456789');
    assert.equal(res.status, 401, 'GET backtest no secret → 401');
  }

  {
    const res = await hit('/api/lab/compare/baselines?from=2025-09-01&to=2026-04-01');
    assert.equal(res.status, 401, 'compare no secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/backtest',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tianxi-Site-Token': 'wrong',
        },
        body: JSON.stringify({
          features: [{ id: 'elo', weight: 1 }],
          from: '2025-09-01',
          to: '2026-04-01',
        }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 401, 'wrong secret → 401');
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
          features: [],
          from: '2025-09-01',
          to: '2026-04-01',
        }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'empty features → 400');
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
    assert.equal(res.status, 200, `POST backtest with secret → 200 (got ${res.status})`);
    const j = (await res.json()) as any;
    assert.equal(j.status, 'ready');
    assert.ok(j.hash);
    assert.ok(j.result?.overall);
    assert.equal(j.result.matrixSource, 'demo-fixture');
    assert.ok(j.result.eloBaseline);
    assert.ok(Array.isArray(j.result.limitations));
  }

  {
    const res = await hit(
      '/api/lab/compare/baselines?from=2025-09-01&to=2026-04-01',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 200, 'compare with secret → 200');
    const j = (await res.json()) as any;
    assert.ok(j.official);
    assert.ok(j.elo);
  }

  {
    const res = await hit(
      '/api/lab/backtest/not-a-hash',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad hash → 400');
  }

  console.log('test-lab-backtest-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
