#!/usr/bin/env tsx
/**
 * lab-going 純函式：熱圖、跑法偏差、合地名單、地況桶。
 */
import assert from 'node:assert/strict';
import {
  MIN_SAMPLE_RACES,
  PENDING_GOING,
  buildDrawHeatmap,
  buildStyleBias,
  buildSuitedHorses,
  normalizeGoingBucket,
  parseVenue,
  type RawGoingResult,
} from '../src/lib/lab-going';

function main(): void {
  assert.equal(normalizeGoingBucket('好地'), '好地');
  assert.equal(normalizeGoingBucket('Good'), '好地');
  assert.equal(normalizeGoingBucket('good to firm'), '好地至快地');
  assert.equal(normalizeGoingBucket(PENDING_GOING), null);
  assert.equal(normalizeGoingBucket(''), null);
  assert.equal(parseVenue('ST'), 'ST');
  assert.equal(parseVenue('沙田'), 'ST');
  assert.equal(parseVenue('xx'), null);

  const rows: RawGoingResult[] = [];
  // 1200m draw1：40 場、每場 1 runner 模擬 → top3 全中 → 唔 sparse
  for (let i = 0; i < 40; i++) {
    rows.push({
      draw: 1,
      distance: 1200,
      finishingPosition: i % 3 === 0 ? 1 : 2,
      runningPosition: '1-1-1',
      horseId: `h${i}`,
      raceId: `race_a_${i}`,
      fieldSize: 12,
    });
  }
  // 1200m draw14：5 場 → sparse
  for (let i = 0; i < 5; i++) {
    rows.push({
      draw: 14,
      distance: 1200,
      finishingPosition: 8,
      runningPosition: '13-13-13',
      horseId: `z${i}`,
      raceId: `race_b_${i}`,
      fieldSize: 14,
    });
  }

  const heat = buildDrawHeatmap(rows);
  assert.ok(heat.distances.includes(1200));
  const c1 = heat.cells.find((c) => c.draw === 1 && c.distance === 1200)!;
  assert.equal(c1.races, 40);
  assert.equal(c1.sparse, false);
  assert.ok(c1.top3Rate != null && c1.top3Rate > 0.9);
  const c14 = heat.cells.find((c) => c.draw === 14 && c.distance === 1200)!;
  assert.equal(c14.sparse, true);
  assert.ok(c14.races < MIN_SAMPLE_RACES);

  const style = buildStyleBias(rows);
  const leader = style.find((s) => s.code === 'leader')!;
  assert.ok(leader.runners >= 40);
  assert.equal(leader.sparse, false);
  const held = style.find((s) => s.code === 'held-up')!;
  assert.ok(held.runners >= 5);

  const suited = buildSuitedHorses(
    [
      {
        horseId: 'alpha',
        horseNumber: 3,
        nameCh: '甲',
        nameEn: 'Alpha',
        draw: 2,
      },
      {
        horseId: 'beta',
        horseNumber: 7,
        nameCh: '乙',
        nameEn: 'Beta',
        draw: 8,
      },
    ],
    [
      {
        horseId: 'alpha',
        goingStarts: 10,
        goingTop3: 6,
        overallStarts: 40,
        overallTop3: 8,
      },
      {
        horseId: 'beta',
        goingStarts: 10,
        goingTop3: 2,
        overallStarts: 40,
        overallTop3: 10,
      },
    ],
  );
  assert.equal(suited.length, 1);
  assert.equal(suited[0].horseId, 'alpha');
  assert.equal(suited[0].tag, '今日合地');
  assert.ok((suited[0].edgePp ?? 0) > 0.05);

  console.log('test-lab-going: all passed');
}

main();
