#!/usr/bin/env tsx
/**
 * lab-compare 純引擎單元測試（無網絡／無 D1）。
 */
import assert from 'node:assert/strict';
import {
  ALL_POOLS,
  LIVE_FROM_DATE,
  MIN_ROI_SAMPLE,
  buildDemoMatrix,
  maxLosingStreakDays,
  runCompare,
  seriesPhase,
  validateCompareParams,
} from '../src/lib/lab-backtest';

async function main(): Promise<void> {
  assert.equal(LIVE_FROM_DATE, '2026-10-04');
  assert.equal(seriesPhase('2026-10-03'), 'backtest');
  assert.equal(seriesPhase('2026-10-04'), 'live');

  const bad = validateCompareParams({ from: '2026-01-01', to: '2025-01-01' });
  assert.equal(bad.ok, false);

  const good = validateCompareParams({
    from: '2025-09-01',
    to: '2026-10-04',
    pools: ['FF', 'TRIO'],
    strategies: [
      { key: 'official', label: '官方四揀', kind: 'official' },
      { key: 'elo', label: '純 Elo', kind: 'elo' },
      {
        key: 'custom_a',
        label: '我的 A',
        kind: 'custom',
        features: [
          { id: 'elo', weight: 2 },
          { id: 'form', weight: 1 },
        ],
      },
    ],
  });
  assert.equal(good.ok, true);

  const fromQuery = validateCompareParams({
    from: '2025-09-01',
    to: '2026-04-01',
    strategies: 'official,elo',
  });
  assert.equal(fromQuery.ok, true);
  if (fromQuery.ok) assert.equal(fromQuery.strategies.length, 2);

  const matrix = buildDemoMatrix({
    raceCount: 220,
    seed: 99,
    withDividends: true,
    withOfficial: true,
    from: '2025-09-07',
  });
  const from = matrix.races[0]!.date;
  const to = matrix.races[matrix.races.length - 1]!.date;

  const cmp = runCompare(matrix, {
    from,
    to,
    pools: ALL_POOLS,
    strategies: [
      { key: 'official', label: '官方四揀', kind: 'official' },
      { key: 'elo', label: '純 Elo', kind: 'elo' },
      {
        key: 'c1',
        label: '自訂',
        kind: 'custom',
        features: [
          { id: 'elo', weight: 2 },
          { id: 'distance', weight: 1 },
        ],
      },
    ],
  });

  assert.equal(cmp.status, 'ready');
  assert.equal(cmp.liveFrom, '2026-10-04');
  assert.equal(cmp.strategies.length, 3);
  assert.ok(cmp.strategies.every((s) => s.summary.raceCount > 0));
  assert.ok(cmp.strategies[0]!.summary.raceCount >= MIN_ROI_SAMPLE);
  assert.ok(cmp.dayDiff.length > 0);
  assert.ok(cmp.strategies[0]!.series.every((p) => p.phase === 'live' || p.phase === 'backtest'));
  assert.ok(cmp.limitations.some((l) => l.includes('研究層') || l.includes('公開戰績')));
  assert.ok(typeof cmp.strategies[0]!.summary.maxLosingStreakDays === 'number');

  const streak = maxLosingStreakDays([
    { date: 'a', races: 1, avgTop4Hits: 0, cost: 10, payout: 0, net: -10, cum: -10 },
    { date: 'b', races: 1, avgTop4Hits: 0, cost: 10, payout: 0, net: -5, cum: -15 },
    { date: 'c', races: 1, avgTop4Hits: 0, cost: 10, payout: 20, net: 10, cum: -5 },
    { date: 'd', races: 1, avgTop4Hits: 0, cost: 10, payout: 0, net: -1, cum: -6 },
  ]);
  assert.equal(streak, 2);

  // dayDiff maxGapKeys present when ≥2 strategies
  const withGap = cmp.dayDiff.find((d) => d.maxGap != null && d.maxGap > 0);
  assert.ok(withGap?.maxGapKeys);

  console.log('test-lab-compare: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
