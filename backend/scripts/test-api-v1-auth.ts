#!/usr/bin/env tsx
/**
 * API v1 合約：無 key → 401；過期 entitlement → 403；frozen only；admin 無 secret → 401。
 * 用 Hono + stub Env（無真 D1）驗閘。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { apiV1Routes } from '../src/routes/api-v1';
import {
  API_V1_KEY_PREFIX,
  hashApiKey,
  isEntitlementActive,
  mintApiKey,
  parseScopes,
  requireScope,
  extractBearer,
} from '../src/lib/api-v1-keys';

async function main(): Promise<void> {
  // Pure helpers
  assert.equal(extractBearer('Bearer tx_live_abc'), 'tx_live_abc');
  assert.equal(extractBearer('bearer tx_live_abc'), 'tx_live_abc');
  assert.equal(extractBearer(null), null);
  assert.ok(isEntitlementActive(null));
  assert.ok(isEntitlementActive(new Date(Date.now() + 86_400_000).toISOString()));
  assert.equal(isEntitlementActive(new Date(Date.now() - 86_400_000).toISOString()), false);
  const scopes = parseScopes('elo, picks,features');
  assert.ok(scopes.has('elo') && scopes.has('picks') && scopes.has('features'));
  assert.equal(requireScope(scopes, 'elo').ok, true);
  assert.equal(requireScope(scopes, 'admin').ok, false);

  const minted = await mintApiKey();
  assert.ok(minted.plaintext.startsWith(API_V1_KEY_PREFIX));
  assert.equal(await hashApiKey(minted.plaintext), minted.keyHash);
  assert.notEqual(await hashApiKey(minted.plaintext + 'x'), minted.keyHash);

  const app = new Hono();
  app.route('/api/v1', apiV1Routes);

  async function hit(path: string, init: RequestInit = {}, env: Record<string, unknown> = {}) {
    const req = new Request(`http://localhost${path}`, init);
    return app.fetch(req, { DB: null, ...env } as any);
  }

  {
    const res = await hit('/api/v1/elo/horses/horse_A001');
    assert.equal(res.status, 401, 'no key → 401');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'unauthorized');
    assert.ok(String(j.disclaimer ?? '').includes('研究'));
  }

  {
    const res = await hit('/api/v1/picks/frozen?date=2026-10-25', {
      headers: { Authorization: 'Bearer not-a-key' },
    });
    assert.equal(res.status, 401, 'bad bearer → 401');
  }

  {
    const res = await hit('/api/v1/picks/frozen?date=2026-10-25', {
      headers: { Authorization: `Bearer ${API_V1_KEY_PREFIX}deadbeef` },
    });
    // DB null → authenticate fails closed as unauthorized / unavailable
    assert.ok([401, 503].includes(res.status), `got ${res.status}`);
  }

  {
    const res = await hit('/api/v1/admin/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401, 'admin create no secret → 401');
  }

  {
    const res = await hit(
      '/api/v1/admin/keys',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Tianxi-Site-Token': 'wrong' },
        body: JSON.stringify({ userId: 'u1' }),
      },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 401, 'wrong site token → 401');
  }

  // Meta endpoint is public (no auth) for discoverability
  {
    const res = await hit('/api/v1');
    assert.equal(res.status, 200);
    const j = (await res.json()) as any;
    assert.equal(j.name, 'tianxi-api-v1');
    assert.ok(Array.isArray(j.endpoints));
  }

  console.log('test-api-v1-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
