#!/usr/bin/env tsx
/** Pure optimizer helpers：top_k／banker_box；disclaimer；無投注 URL。 */
import assert from 'node:assert/strict';
import {
  buildCombosForRace,
  combCount,
  optimizePools,
  parsePool,
  permCount,
  POOLS_DISCLAIMER,
  type PoolRunner,
} from '../src/lib/lab-pools';

function runners(n: number): PoolRunner[] {
  const out: PoolRunner[] = [];
  let rem = 1;
  for (let i = 0; i < n; i++) {
    const p = i === n - 1 ? rem : rem * 0.45;
    rem -= i === n - 1 ? 0 : p;
    out.push({
      horseId: `h${i + 1}`,
      horseNumber: i + 1,
      nameCh: `馬${i + 1}`,
      pWin: Math.max(p, 0.001),
      rank: i + 1,
      score: n - i,
    });
  }
  const z = out.reduce((a, r) => a + r.pWin, 0);
  out.forEach((r) => {
    r.pWin /= z;
  });
  return out;
}

async function main(): Promise<void> {
  assert.equal(parsePool('ff'), 'FF');
  assert.equal(parsePool('QTT'), 'QUARTET');
  assert.equal(parsePool('TCE'), 'TRIO');
  assert.equal(parsePool('DT'), null);
  assert.equal(combCount(5, 4), 5);
  assert.equal(permCount(5, 4), 120);

  const fieldRunners = runners(10);
  const built = buildCombosForRace({
    raceId: 'race_2026-10-25_ST_1',
    pool: 'FF',
    method: 'top_k',
    budget: 50,
    runners: fieldRunners,
  });
  assert.ok(built.combos.length >= 1);
  assert.ok(built.combos[0]!.modelHitProb > 0);
  assert.ok(built.combos[0]!.cost > 0);

  const opt = optimizePools({
    pool: 'TRIO',
    method: 'top_k',
    budget: 200,
    fields: [
      {
        raceId: 'race_2026-10-25_ST_1',
        date: '2026-10-25',
        venue: 'ST',
        raceNumber: 1,
        locked: true,
        runners: fieldRunners,
      },
    ],
  });
  assert.ok(opt.disclaimer.includes('研究'));
  assert.equal(opt.disclaimer, POOLS_DISCLAIMER);
  assert.ok(opt.researchBanner.includes('唔入公開戰績'));
  assert.ok(opt.scope.includes('phase-2'));
  assert.ok(opt.combos.length >= 1);
  const blob = JSON.stringify(opt);
  assert.equal(/hkjc\.com|投注連結|placebet/i.test(blob), false);

  const banker = buildCombosForRace({
    raceId: 'race_2026-10-25_ST_2',
    pool: 'FF',
    method: 'banker_box',
    budget: 100,
    runners: fieldRunners,
  });
  assert.ok(banker.combos[0]!.combination.includes('>'));

  console.log('test-lab-pools: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
