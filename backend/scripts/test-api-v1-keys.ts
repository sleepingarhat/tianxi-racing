#!/usr/bin/env tsx
/**
 * API v1 key lifecycle with in-memory D1 stub:
 * create → auth ok → expired entitlement 403 → revoke → 401；frozen-only gate.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { apiV1Routes } from '../src/routes/api-v1';
import {
  API_V1_KEY_PREFIX,
  ensureApiV1Tables,
  mintApiKey,
  resetApiV1TableCache,
  authenticateApiKey,
} from '../src/lib/api-v1-keys';
import { resetRateLimitTableCache } from '../src/lib/rate-limit';

type Row = Record<string, unknown>;

function makeMemDb() {
  const tables = new Map<string, Row[]>();
  const ensure = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function prepare(sql: string) {
    const binds: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) {
        binds.length = 0;
        binds.push(...args);
        return stmt;
      },
      async run() {
        return execute('run');
      },
      async first() {
        return execute('first');
      },
      async all() {
        return execute('all');
      },
    };

    async function execute(mode: 'run' | 'first' | 'all'): Promise<any> {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/^CREATE TABLE/i.test(s) || /^CREATE INDEX/i.test(s)) {
        return mode === 'all' ? { results: [] } : mode === 'first' ? null : { success: true, meta: { changes: 0 } };
      }

      if (/INSERT INTO api_keys/i.test(s)) {
        ensure('api_keys').push({
          id: binds[0],
          key_prefix: binds[1],
          key_hash: binds[2],
          user_id: binds[3],
          scopes: binds[4],
          entitlement_until: binds[5],
          revoked_at: null,
          last_used_at: null,
          created_at: binds[6],
          label: binds[7] ?? null,
        });
        return { success: true, meta: { changes: 1 }, results: [] };
      }

      if (/UPDATE api_keys SET last_used_at/i.test(s)) {
        for (const r of ensure('api_keys')) if (r['id'] === binds[1]) r['last_used_at'] = binds[0];
        return { success: true, meta: { changes: 1 }, results: [] };
      }

      if (/UPDATE api_keys SET revoked_at/i.test(s)) {
        let changes = 0;
        for (const r of ensure('api_keys')) {
          if (r['id'] === binds[1] && r['revoked_at'] == null) {
            r['revoked_at'] = binds[0];
            changes = 1;
          }
        }
        return { success: true, meta: { changes }, results: [] };
      }

      if (/UPDATE api_keys SET entitlement_until/i.test(s)) {
        for (const r of ensure('api_keys')) if (r['id'] === binds[1]) r['entitlement_until'] = binds[0];
        return { success: true, meta: { changes: 1 }, results: [] };
      }

      if (/UPDATE api_keys SET scopes/i.test(s)) {
        for (const r of ensure('api_keys')) if (r['id'] === binds[1]) r['scopes'] = binds[0];
        return { success: true, meta: { changes: 1 }, results: [] };
      }

      if (/INSERT INTO api_usage_daily/i.test(s)) {
        const rows = ensure('api_usage_daily');
        const keyId = binds[0];
        const date = binds[1];
        let found = rows.find((r) => r['key_id'] === keyId && r['date'] === date);
        if (!found) {
          found = { key_id: keyId, date, count: 0 };
          rows.push(found);
        }
        found['count'] = Number(found['count']) + 1;
        const resultRow = { count: found['count'] };
        if (mode === 'first') return resultRow;
        return { success: true, meta: { changes: 1 }, results: [resultRow] };
      }

      if (/INSERT INTO api_rate_limits/i.test(s)) {
        const rows = ensure('api_rate_limits');
        const bucket = binds[0];
        const windowStart = binds[1];
        let found = rows.find((r) => r['bucket'] === bucket && r['window_start'] === windowStart);
        if (!found) {
          found = { bucket, window_start: windowStart, count: 0, expires_at: binds[2] };
          rows.push(found);
        }
        found['count'] = Number(found['count']) + 1;
        const resultRow = { count: found['count'] };
        if (mode === 'first') return resultRow;
        return { success: true, meta: { changes: 1 }, results: [resultRow] };
      }

      if (/DELETE FROM api_rate_limits/i.test(s)) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }

      if (/FROM api_keys WHERE key_hash/i.test(s)) {
        const row = ensure('api_keys').find((r) => r['key_hash'] === binds[0]) ?? null;
        if (mode === 'all') return { results: row ? [row] : [] };
        return row;
      }

      if (/FROM api_keys WHERE id = \?/i.test(s)) {
        const row = ensure('api_keys').find((r) => r['id'] === binds[0]) ?? null;
        if (mode === 'all') return { results: row ? [row] : [] };
        return row;
      }

      if (/FROM api_keys WHERE user_id/i.test(s)) {
        const rows = ensure('api_keys').filter((r) => r['user_id'] === binds[0]);
        return { results: rows };
      }

      if (/FROM api_usage_daily/i.test(s)) {
        return { results: ensure('api_usage_daily') };
      }

      if (mode === 'all') return { results: [] };
      if (mode === 'first') return null;
      return { success: true, meta: { changes: 0 }, results: [] };
    }

    return stmt;
  }

  return {
    prepare,
    async batch(stmts: { run: () => Promise<any> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

async function main(): Promise<void> {
  resetApiV1TableCache();
  resetRateLimitTableCache();
  const db = makeMemDb() as unknown as D1Database;
  await ensureApiV1Tables(db);

  const minted = await mintApiKey();
  assert.ok(minted.plaintext.startsWith(API_V1_KEY_PREFIX));

  await db
    .prepare(
      `INSERT INTO api_keys (id, key_prefix, key_hash, user_id, scopes, entitlement_until, revoked_at, last_used_at, created_at, label)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(minted.id, minted.keyPrefix, minted.keyHash, 'user-1', 'elo,picks,features', null, new Date().toISOString(), 'test')
    .run();

  const ok = await authenticateApiKey(db, `Bearer ${minted.plaintext}`, { skipUsage: true });
  assert.equal(ok.ok, true, 'active key authenticates');

  const expired = await mintApiKey();
  await db
    .prepare(
      `INSERT INTO api_keys (id, key_prefix, key_hash, user_id, scopes, entitlement_until, revoked_at, last_used_at, created_at, label)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      expired.id,
      expired.keyPrefix,
      expired.keyHash,
      'user-1',
      'elo,picks',
      new Date(Date.now() - 3600_000).toISOString(),
      new Date().toISOString(),
      'expired',
    )
    .run();
  const expAuth = await authenticateApiKey(db, `Bearer ${expired.plaintext}`, { skipUsage: true });
  assert.equal(expAuth.ok, false);
  if (!expAuth.ok) assert.equal(expAuth.status, 403, 'expired → 403');

  await db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(new Date().toISOString(), minted.id)
    .run();
  const revoked = await authenticateApiKey(db, `Bearer ${minted.plaintext}`, { skipUsage: true });
  assert.equal(revoked.ok, false);
  if (!revoked.ok) assert.equal(revoked.status, 401, 'revoked → 401');

  const app = new Hono();
  app.route('/api/v1', apiV1Routes);
  const mem2 = makeMemDb();
  resetApiV1TableCache();
  resetRateLimitTableCache();
  const res = await app.fetch(
    new Request('http://localhost/api/v1/admin/keys', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Tianxi-Site-Token': 'site-secret',
      },
      body: JSON.stringify({ userId: 'u-web', label: 'from-test' }),
    }),
    { DB: mem2, SITE_READER_TOKEN: 'site-secret' } as any,
  );
  assert.equal(res.status, 200, `create key status ${res.status} body=${await res.clone().text()}`);
  const body = (await res.json()) as any;
  assert.ok(String(body.apiKey).startsWith(API_V1_KEY_PREFIX));
  assert.ok(body.keyPrefix);
  assert.equal(body.userId, 'u-web');

  const use = await app.fetch(
    new Request('http://localhost/api/v1/picks/frozen?date=2099-01-01', {
      headers: { Authorization: `Bearer ${body.apiKey}` },
    }),
    { DB: mem2, SITE_READER_TOKEN: 'site-secret' } as any,
  );
  assert.notEqual(use.status, 401, `frozen gate should not be bare unauthorized, got ${use.status}`);
  assert.ok([403, 404, 500, 503].includes(use.status), `got ${use.status}`);

  console.log('test-api-v1-keys: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
