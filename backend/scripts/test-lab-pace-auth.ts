#!/usr/bin/env tsx
/**
 * pace / pace-forecast API 已下架：無論有冇 secret 一律 410 Gone（唔再係產品端點）。
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
    const res = await hit('/api/lab/pace/race_2026-04-15_HV_1');
    assert.equal(res.status, 410, 'GET pace no secret → 410 gone');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
  }

  {
    const res = await hit('/api/lab/pace-forecast/race_2026-04-15_HV_1');
    assert.equal(res.status, 410, 'GET pace-forecast no secret → 410');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
  }

  {
    const res = await hit('/api/lab/pace');
    assert.equal(res.status, 410, 'GET /pace (no raceId) → 410');
  }

  {
    const res = await hit('/api/lab/pace-forecast');
    assert.equal(res.status, 410, 'GET /pace-forecast (no raceId) → 410');
  }

  {
    const res = await hit(
      '/api/lab/pace/not-a-race',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, 'bad raceId with secret → 410 (no longer 400)');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
  }

  {
    const res = await hit(
      '/api/lab/pace-forecast/race_2099-99-99_ST_1',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tianxi-Site-Token': 'correct-secret',
        },
        body: '{}',
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, `POST pace-forecast with secret → 410 (got ${res.status})`);
  }

  {
    const res = await hit(
      '/api/lab/pace/race_2026-04-15_HV_1/extra',
      { headers: { 'X-Tianxi-Site-Token': 'wrong' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, 'nested pace path → 410');
  }

  console.log('test-lab-pace-auth: all passed (410 gone)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
