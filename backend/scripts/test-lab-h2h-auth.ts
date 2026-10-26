#!/usr/bin/env tsx
/**
 * 頭對頭 API 合約：冇 secret → 401；type／id 驗證。
 * 用 Hono app + stub Env（無真 D1）；只驗閘同 400。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { labRoutes } from '../src/routes/lab';

async function main(): Promise<void> {
  const app = new Hono();
  app.route('/api/lab', labRoutes);

  async function hit(path: string, headers: Record<string, string> = {}, env: Record<string, unknown> = {}) {
    const req = new Request(`http://localhost${path}`, { headers });
    return app.fetch(req, { DB: null, SITE_READER_TOKEN: undefined, ...env } as any);
  }

  {
    const res = await hit('/api/lab/h2h?type=horse&a=horse_A&b=horse_B');
    assert.equal(res.status, 401, 'no secret → 401');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'unauthorized');
  }

  {
    const res = await hit('/api/lab/search?type=jockey&q=潘');
    assert.equal(res.status, 401, 'search no secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=horse&a=horse_A&b=horse_B',
      { 'X-Tianxi-Site-Token': 'wrong' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 401, 'wrong secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=trainer&a=horse_A&b=horse_B',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad type → 400');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=horse&a=J062&b=horse_B',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad id → 400');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=horse&a=horse_A&b=horse_A',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'same a=b → 400');
  }

  console.log('test-lab-h2h-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
