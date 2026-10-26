#!/usr/bin/env tsx
/**
 * compare API 合約：冇 secret → 401；壞 body → 400；有 secret → 200（demo 矩陣）。
 * baselines stub 繼續可用。
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
    assert.equal(res.status, 401, 'GET compare no secret → 401');
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
    assert.equal(res.status, 401, 'POST compare no secret → 401');
  }

  {
    const res = await hit('/api/lab/compare/baselines?from=2025-09-01&to=2026-04-01');
    assert.equal(res.status, 401, 'baselines no secret → 401');
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
          from: '2026-01-01',
          to: '2025-01-01',
          strategies: [
            { key: 'official', kind: 'official' },
            { key: 'elo', kind: 'elo' },
          ],
        }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad range → 400');
  }

  {
    const res = await hit(
      '/api/lab/compare?from=2025-09-01&to=2026-10-04&strategies=official,elo&pools=FF,TRIO',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 200, `GET compare → 200 (got ${res.status})`);
    const j = (await res.json()) as any;
    assert.equal(j.status, 'ready');
    assert.equal(j.liveFrom, '2026-10-04');
    assert.ok(Array.isArray(j.strategies) && j.strategies.length === 2);
    assert.ok(Array.isArray(j.dayDiff));
    assert.equal(j.matrixSource, 'demo-fixture');
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
            {
              key: 'mine',
              label: '我的',
              kind: 'custom',
              features: [
                { id: 'elo', weight: 2 },
                { id: 'form', weight: 1 },
              ],
            },
          ],
        }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 200, `POST compare → 200 (got ${res.status})`);
    const j = (await res.json()) as any;
    assert.equal(j.strategies.length, 3);
    assert.ok(j.strategies.some((s: any) => s.kind === 'custom'));
    assert.ok(j.researchNote);
  }

  {
    const res = await hit(
      '/api/lab/compare/baselines?from=2025-09-01&to=2026-04-01',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 200, 'baselines stub still 200');
    const j = (await res.json()) as any;
    assert.ok(j.official);
    assert.ok(j.elo);
  }

  console.log('test-lab-compare-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
