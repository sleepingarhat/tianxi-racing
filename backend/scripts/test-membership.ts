#!/usr/bin/env tsx
// Whop 會籍已停用：舊 /api/membership/* 一律 410，/pro 一律 301 去 tianxi.racing/membership。
// 同時保留原有 projectTodayPicksForFree 回歸測試。

import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { LEGACY_MEMBERSHIP_GONE, MEMBERSHIP_URL, membershipRoutes, proRoutes } from '../src/routes/membership';
import { projectTodayPicksForFree } from '../src/lib/public-today-picks';

const app = new Hono();
app.route('/api/membership', membershipRoutes);
app.route('/pro', proRoutes);

async function main(): Promise<void> {
  for (const [method, path] of [
    ['GET', '/api/membership/login'],
    ['GET', '/api/membership/status'],
    ['GET', '/api/membership/checkout/day'],
    ['GET', '/api/membership/checkout/month'],
    ['GET', '/api/membership/oauth/callback?code=x&state=y'],
    ['GET', '/api/membership/pro/today'],
    ['POST', '/api/membership/logout'],
  ] as const) {
    const res = await app.request(path, { method });
    assert.equal(res.status, 410, `${method} ${path} should be 410`);
    assert.equal(res.headers.get('location'), null, `${path} must not redirect to Whop`);
    const body = await res.json() as typeof LEGACY_MEMBERSHIP_GONE;
    assert.equal(body.membershipUrl, MEMBERSHIP_URL);
    assert.doesNotMatch(JSON.stringify(body), /whop\.com/i);
  }

  for (const path of ['/pro', '/pro/', '/pro/anything']) {
    const res = await app.request(path);
    assert.equal(res.status, 301, `${path} should be 301`);
    assert.equal(res.headers.get('location'), MEMBERSHIP_URL);
  }

  const free = projectTodayPicksForFree({
    date: '2026-08-20',
    venue: 'HV',
    races: [
      { raceId: 'race_2026-08-20_HV_1', raceNumber: 1, picks: [{ horseNumber: 1 }] },
      { raceId: 'race_2026-08-20_HV_2', raceNumber: 2, picks: [{ horseNumber: 2 }] },
    ],
  });
  assert.equal(free.races.length, 1);
  assert.equal(free.races[0].raceNumber, 1);
}

main()
  .then(() => console.log('membership regression tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
