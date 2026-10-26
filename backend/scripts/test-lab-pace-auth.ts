#!/usr/bin/env tsx
/**
 * pace API 合約：冇 secret → 401；raceId 驗證。
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
    const res = await hit('/api/lab/pace/race_2026-04-15_HV_1');
    assert.equal(res.status, 401, 'pace no secret → 401');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'unauthorized');
  }

  {
    const res = await hit('/api/lab/pace-forecast/race_2026-04-15_HV_1');
    assert.equal(res.status, 401, 'pace-forecast no secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/pace/race_2026-04-15_HV_1',
      { 'X-Tianxi-Site-Token': 'wrong' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 401, 'wrong secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/pace/not-a-race',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad raceId → 400');
  }

  {
    const res = await hit(
      '/api/lab/pace-forecast/race_2099-99-99_ST_1',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'invalid date in raceId → 400');
  }

  console.log('test-lab-pace-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
