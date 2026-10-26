#!/usr/bin/env tsx
/**
 * lab-backtest 純引擎單元測試（無網絡／無 D1）。
 */
import assert from 'node:assert/strict';
import {
  ALL_POOLS,
  MIN_ROI_SAMPLE,
  buildDemoMatrix,
  compareOfficialVsElo,
  compositeScore,
  hashParams,
  normalizeWeights,
  pickTop4,
  runBacktest,
  validateParams,
} from '../src/lib/lab-backtest';

async function main(): Promise<void> {
  // weights clamp / step
  const w = normalizeWeights([
    { id: 'elo', weight: 3.7 },
    { id: 'h2h', weight: 0.4 },
    { id: 'draw', weight: 0 },
    { id: 'elo', weight: 1 }, // dup ignored
    { id: 'nope' as any, weight: 2 },
  ]);
  assert.equal(w.length, 2);
  assert.equal(w[0].weight, 3); // clamped
  assert.equal(w[1].weight, 0.5); // stepped

  // validateParams
  const bad = validateParams({ features: [], from: '2025-01-01', to: '2025-02-01' });
  assert.equal(bad.ok, false);
  const good = validateParams({
    features: [{ id: 'elo', weight: 1 }, { id: 'form', weight: 2, invert: true }],
    from: '2025-09-01',
    to: '2026-04-01',
    pools: ['FF', 'TRIO'],
  });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.params.pools, ['FF', 'TRIO']);

  // composite + pick
  const score = compositeScore(
    { elo: 80, form: 20 },
    [
      { id: 'elo', weight: 1 },
      { id: 'form', weight: 1, invert: true },
    ],
  );
  // (80*1 + (100-20)*1) / 2 = 80
  assert.equal(score, 80);

  const top = pickTop4(
    [
      { horseNumber: 1, scores: { elo: 10 }, finishingPosition: 5 },
      { horseNumber: 2, scores: { elo: 90 }, finishingPosition: 1 },
      { horseNumber: 3, scores: { elo: 70 }, finishingPosition: 2 },
      { horseNumber: 4, scores: { elo: 60 }, finishingPosition: 3 },
      { horseNumber: 5, scores: { elo: 50 }, finishingPosition: 4 },
    ],
    [{ id: 'elo', weight: 1 }],
  );
  assert.deepEqual(top, [2, 3, 4, 5]);

  // demo matrix backtest — 大樣本應可出 ROI
  const matrix = buildDemoMatrix({ raceCount: 220, seed: 42, withDividends: true, withOfficial: true });
  assert.ok(matrix.races.length >= 200);
  assert.equal(matrix.source, 'demo-fixture');

  const params = {
    features: [
      { id: 'elo' as const, weight: 2 },
      { id: 'form' as const, weight: 1 },
      { id: 'distance' as const, weight: 1 },
    ],
    from: matrix.races[0].date,
    to: matrix.races[matrix.races.length - 1].date,
    pools: ALL_POOLS,
  };
  const hash = await hashParams(params, matrix.version);
  assert.match(hash, /^[a-f0-9]{32}$/);

  const result = runBacktest(matrix, params);
  assert.equal(result.status, 'ready');
  assert.ok(result.overall.raceCount >= MIN_ROI_SAMPLE, `raceCount=${result.overall.raceCount}`);
  assert.equal(result.overall.showRoi, true);
  assert.ok(result.overall.roiPct != null);
  assert.ok(result.train.raceCount > 0);
  assert.ok(result.validation.raceCount > 0);
  assert.ok(result.eloBaseline);
  assert.ok(result.officialBaseline);
  assert.ok(result.series.length > 0);
  assert.ok(result.limitations.some((l) => l.includes('demo-fixture') || l.includes('R2')));

  // 小樣本：唔出 ROI
  const small = buildDemoMatrix({ raceCount: 40, seed: 7, withDividends: true });
  const smallRes = runBacktest(small, {
    features: [{ id: 'elo', weight: 1 }],
    from: small.races[0].date,
    to: small.races[small.races.length - 1].date,
    pools: ['FF'],
  });
  assert.ok(smallRes.overall.raceCount < MIN_ROI_SAMPLE);
  assert.equal(smallRes.overall.showRoi, false);
  assert.equal(smallRes.overall.roiPct, null);

  // 官方 vs Elo stub
  const cmp = compareOfficialVsElo(matrix, {
    from: params.from,
    to: params.to,
  });
  assert.equal(cmp.official.label, 'official');
  assert.equal(cmp.elo.label, 'elo');
  assert.ok(cmp.elo.raceCount > 0);

  // hash 穩定性
  const hash2 = await hashParams(params, matrix.version);
  assert.equal(hash, hash2);

  console.log('test-lab-backtest: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
