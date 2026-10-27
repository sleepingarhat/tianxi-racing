#!/usr/bin/env tsx
/**
 * going／weather API 已下架：無論有冇 secret 一律 410 Gone（唔再係產品端點）。
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
    const res = await hit('/api/lab/going?venue=ST');
    assert.equal(res.status, 410, 'GET going no secret → 410');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(j.redirect, '/lab');
    assert.equal(/場地|天氣/.test(String(j.message)), false, 'gone message 唔再提場地／天氣');
  }

  {
    const res = await hit('/api/lab/weather/2026-10-26_ST');
    assert.equal(res.status, 410, 'GET weather no secret → 410');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
    assert.equal(/場地|天氣/.test(String(j.message)), false);
  }

  {
    const res = await hit(
      '/api/lab/going?venue=ST',
      { headers: { 'X-Tianxi-Site-Token': 'wrong' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, 'wrong secret → 410');
  }

  {
    const res = await hit(
      '/api/lab/going?venue=XX',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, 'bad venue with secret → 410 (no longer 400)');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'gone');
  }

  {
    const res = await hit(
      '/api/lab/weather/',
      { headers: { 'X-Tianxi-Site-Token': 'correct-secret' } },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 410, `empty meeting → 410 (got ${res.status})`);
  }

  {
    const res = await hit(
      '/api/lab/going?venue=ST&going=好地',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tianxi-Site-Token': 'correct-secret',
        },
        body: '{}',
      },
      { SITE_READER_TOKEN: 'correct-secret', DB: null },
    );
    assert.equal(res.status, 410, 'POST going with secret and no DB → 410');
  }

  {
    const res = await hit('/api/lab/weather/2026-10-26_ST/extra');
    assert.equal(res.status, 410, 'nested weather path → 410');
  }

  {
    const res = await hit('/api/lab/going/extra');
    assert.equal(res.status, 410, 'nested going path → 410');
  }

  console.log('test-lab-going-auth: all passed (410 gone)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
