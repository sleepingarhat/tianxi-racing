#!/usr/bin/env tsx
/**
 * compare API 已下架：無論有冇 secret 一律 410 Gone（唔再係產品端點）。
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
    const res = await hit('/api/lab/compare?from=2025-09-01&to=2026-04-01');
    assert.equal(res.status, 410, 'GET compare no secret → 410');
  }

  {
    const res = await hit('/api/lab/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: '2025-09-01',
        to: '2026-04-01',
        strategies: [
          { key: 'official', kind: 'official' },
          { key: 'elo', kind: 'elo' },
        ],
      }),
    });
    assert.equal(res.status, 410, 'POST compare no secret → 410');
  }

  {
    const res = await hit('/api/lab/compare/baselines?from=2025-09-01&to=2026-04-01');
    assert.equal(res.status, 410, 'baselines no secret → 410');
  }

  {
    const res = await hit(
      '/api/lab/compare?from=2025-09-01&to=2026-10-04&strategies=official,elo&pools=FF,TRIO',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, `GET compare with secret → 410 (got ${res.status})`);
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
  }

  {
    const res = await hit(
      '/api/lab/compare',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tianxi-Site-Token': 'correct-secret',
        },
        body: JSON.stringify({
          from: '2025-09-01',
          to: '2026-10-04',
          pools: ['FF'],
          strategies: [
            { key: 'official', label: '官方四揀', kind: 'official' },
            { key: 'elo', label: '純 Elo', kind: 'elo' },
          ],
        }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, `POST compare with secret → 410 (got ${res.status})`);
  }

  {
    const res = await hit(
      '/api/lab/compare/baselines?from=2025-09-01&to=2026-04-01',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, 'baselines with secret → 410');
  }

  console.log('test-lab-compare-auth: all passed (410 gone)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
