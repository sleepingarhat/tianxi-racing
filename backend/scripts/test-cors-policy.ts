#!/usr/bin/env tsx
// CORS 白名單回歸測試：天喜網站／Lovable 預覽／本機可讀，其他網域唔會收到 Allow-Origin。
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { corsPolicy, isAllowedOrigin, LOVABLE_PROJECT_ID } from '../src/lib/cors-policy';

const allowed = [
  'https://tianxi.racing',
  'https://www.tianxi.racing',
  'https://mark-six-joy.lovable.app',
  `https://id-preview--${LOVABLE_PROJECT_ID}.lovable.app`,
  `https://project--${LOVABLE_PROJECT_ID}-dev.lovable.app`,
  `https://${LOVABLE_PROJECT_ID}.lovableproject.com`,
  'http://localhost:8080',
  'http://localhost',
  'http://127.0.0.1:5173',
];
const denied = [
  'https://evil.example',
  'https://tianxi.racing.evil.example',
  'https://eviltianxi.racing',
  'http://tianxi.racing',
  'https://someone-else.lovable.app',
  `https://${LOVABLE_PROJECT_ID}.lovable.app.evil.example`,
  `https://id-preview--00000000-0000-0000-0000-000000000000.lovable.app`,
  'http://localhost.evil.example',
  'null',
  '',
];

async function main(): Promise<void> {
  for (const o of allowed) assert.ok(isAllowedOrigin(o), `should allow ${o}`);
  for (const o of denied) assert.ok(!isAllowedOrigin(o), `should deny ${o}`);
  assert.ok(isAllowedOrigin('https://staging.example', 'https://staging.example, https://x.example/'));
  assert.ok(!isAllowedOrigin('https://staging.example', 'not-a-url'));

  const app = new Hono();
  app.use('*', corsPolicy());
  app.get('/api/meetings', (c) => c.json({ ok: true }));

  const ok = await app.request('/api/meetings', { headers: { Origin: 'https://tianxi.racing' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://tianxi.racing');

  const bad = await app.request('/api/meetings', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 200, 'non-browser semantics unchanged; browser blocks via missing header');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);

  const noOrigin = await app.request('/api/meetings');
  assert.equal(noOrigin.status, 200, 'server-to-server (no Origin) still works');

  const pre = await app.request('/api/meetings', {
    method: 'OPTIONS',
    headers: { Origin: `https://id-preview--${LOVABLE_PROJECT_ID}.lovable.app`, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), `https://id-preview--${LOVABLE_PROJECT_ID}.lovable.app`);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);

  const extra = await app.request('/api/meetings', { headers: { Origin: 'https://staging.example' } }, { CORS_EXTRA_ORIGINS: 'https://staging.example' });
  assert.equal(extra.headers.get('access-control-allow-origin'), 'https://staging.example');
  console.log('cors policy tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
