#!/usr/bin/env tsx
/**
 * elo_baseline_picks 讀路徑回歸：無表／空 map → on-demand；有 stub 列 → 優先用表。
 * 跑：npm run test:lab-elo-baseline
 */
import assert from 'node:assert/strict';
import {
  ALL_POOLS,
  buildDemoMatrix,
  eloBaselineLimitation,
  measureEloBaselineUsage,
  pickTop4,
  resolveEloPicks,
  runCompare,
  type EloBaselinePicksMap,
} from '../src/lib/lab-backtest';

async function main(): Promise<void> {
  const matrix = buildDemoMatrix({
    raceCount: 12,
    seed: 42,
    withDividends: true,
    withOfficial: true,
    from: '2025-09-07',
  });
  const from = matrix.races[0]!.date;
  const to = matrix.races[matrix.races.length - 1]!.date;

  // 無表：on-demand OK
  const noTable = runCompare(matrix, {
    from,
    to,
    pools: ALL_POOLS,
    strategies: [
      { key: 'official', label: '官方', kind: 'official' },
      { key: 'elo', label: 'Elo', kind: 'elo' },
    ],
  });
  assert.equal(noTable.status, 'ready');
  assert.ok(
    noTable.limitations.some((l) => l.includes('on-demand') || l.includes('無可用表列')),
  );

  const race0 = matrix.races[0]!;
  const onDemand = pickTop4(race0.runners, [{ id: 'elo', weight: 1 }]);
  assert.equal(resolveEloPicks(race0.runners, race0.raceId, null).join(','), onDemand.join(','));

  // stub 列：故意同 on-demand 唔同（倒轉場內頭四馬號），確認優先用表
  const field = race0.runners.map((r) => r.horseNumber).sort((a, b) => a - b);
  assert.ok(field.length >= 4);
  const stubPicks = [field[3]!, field[2]!, field[1]!, field[0]!] as const;
  const map: EloBaselinePicksMap = new Map([[race0.raceId, stubPicks]]);
  const resolved = resolveEloPicks(race0.runners, race0.raceId, map);
  assert.deepEqual(resolved, [...stubPicks]);
  assert.notEqual(resolved.join(','), onDemand.join(','));

  const usage = measureEloBaselineUsage(matrix.races, map);
  assert.equal(usage.tableHits, 1);
  assert.equal(usage.raceCount, matrix.races.length);
  assert.ok(eloBaselineLimitation(usage).includes('1/'));

  const withTable = runCompare(matrix, {
    from,
    to,
    pools: ALL_POOLS,
    strategies: [
      { key: 'official', label: '官方', kind: 'official' },
      { key: 'elo', label: 'Elo', kind: 'elo' },
    ],
    eloBaselinePicks: map,
  });
  assert.ok(withTable.limitations.some((l) => l.includes('表列')));
  // 只有 1 場有 stub → mixed
  assert.ok(withTable.limitations.some((l) => l.includes('1/') || l.includes('fallback')));

  // 無效馬號 → fallback on-demand
  const badMap: EloBaselinePicksMap = new Map([[race0.raceId, [99, 98, 97, 96]]]);
  assert.deepEqual(
    resolveEloPicks(race0.runners, race0.raceId, badMap),
    onDemand,
  );

  console.log('test-lab-elo-baseline: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
