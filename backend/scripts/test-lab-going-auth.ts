#!/usr/bin/env tsx
/**
 * going／weather API 合約：冇 secret → 401；參數驗證。
 * 用 Hono app + stub Env（無真 D1）；只驗閘同 400。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { labRoutes } from '../src/routes/lab';

async function main(): Promise<void> {
  const app = new Hono();
  app.route('/api/lab', labRoutes);

  async function hit(
    path: string,
    headers: Record<string, string> = {},
    env: Record<string, unknown> = {},
  ) {
    const req = new Request(`http://localhost${path}`, { headers });
    return app.fetch(req, {
      DB: null,
      SITE_READER_TOKEN: undefined,
      ...env,
    } as any);
  }

  {
    const res = await hit('/api/lab/going?venue=ST');
    assert.equal(res.status, 401, 'going no secret → 401');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'unauthorized');
  }

  {
    const res = await hit('/api/lab/weather/2026-10-26_ST');
    assert.equal(res.status, 401, 'weather no secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/going?venue=ST',
      { 'X-Tianxi-Site-Token': 'wrong' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 401, 'wrong secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/going?venue=XX',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad venue → 400');
  }

  {
    const res = await hit(
      '/api/lab/weather/',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    // empty meetingId path may 404 from router
    assert.ok([400, 404].includes(res.status), `empty meeting → 400/404 got ${res.status}`);
  }

  // 有 secret 但 DB null → 503（證明已過 auth）
  {
    const res = await hit(
      '/api/lab/going?venue=ST&going=好地',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret', DB: null },
    );
    assert.equal(res.status, 503, 'no DB after auth → 503');
  }

  console.log('test-lab-going-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
