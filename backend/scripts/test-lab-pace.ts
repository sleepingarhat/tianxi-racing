#!/usr/bin/env tsx
/**
 * lab-pace 純函式測試（無 D1）。跑：npm run test:lab-pace
 */
import assert from 'node:assert/strict';
import {
  PACE_DISCLAIMER,
  ROLE_LABELS,
  applySectionPositions,
  assembleRunner,
  buildDrawStyleGrid,
  buildPaceIndex,
  buildStyleMix,
  classifyRole,
  forecastFromLeaders,
  median,
  parseRunningPositions,
  pickHighlightIds,
  sectionDelta,
} from '../src/lib/lab-pace';
import type { RunningStyleEntry } from '../src/lib/running-style';

assert.deepEqual(parseRunningPositions('2-3-3-1'), [2, 3, 3, 1]);
assert.deepEqual(parseRunningPositions('1 2 3'), [1, 2, 3]);
assert.deepEqual(parseRunningPositions(''), []);
assert.deepEqual(parseRunningPositions('n/a'), []);

assert.equal(median([1, 3, 2]), 2);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(median([]), null);

assert.equal(classifyRole([1, 1, 2], 12), 'leader');
assert.equal(classifyRole([6, 5, 4], 12), 'midfield');
assert.equal(classifyRole([11, 10, 9], 12), 'held-up');
assert.equal(classifyRole([], 12), null);
assert.equal(ROLE_LABELS.leader, '領放');

assert.equal(sectionDelta(22.5, 23.0), -0.5);
assert.equal(sectionDelta(null, 23), null);

const fast = buildPaceIndex([-0.3, -0.2, -0.1]);
assert.equal(fast.label, '快');
assert.equal(fast.source, 'computed');
const slow = buildPaceIndex([0.2, 0.3, 0.4]);
assert.equal(slow.label, '慢');
const mid = buildPaceIndex([-0.05, 0.05, 0]);
assert.equal(mid.label, '中');
assert.equal(buildPaceIndex([]).source, 'none');

const fFast = forecastFromLeaders(3);
assert.equal(fFast.forecast, '快');
assert.equal(fFast.disclaimer, PACE_DISCLAIMER);
assert.equal(forecastFromLeaders(1).forecast, '慢');
assert.equal(forecastFromLeaders(0).forecast, '慢');
assert.equal(forecastFromLeaders(2).forecast, '中');

const styles: RunningStyleEntry[] = [
  { horseId: 'horse_A', code: 'leader', label: '放', sampleCount: 5 },
  { horseId: 'horse_B', code: 'leader', label: '放', sampleCount: 4 },
  { horseId: 'horse_C', code: 'leader', label: '放', sampleCount: 6 },
  { horseId: 'horse_D', code: 'held-up', label: '後', sampleCount: 3 },
];
const mix = buildStyleMix(styles, 6);
assert.equal(mix.nLeaders, 3);
assert.equal(mix.known, 4);
assert.equal(mix.buckets.find((b) => b.code === 'unknown')!.count, 2);
assert.equal(mix.buckets.find((b) => b.code === 'unknown')!.label, '未知');

const grid = buildDrawStyleGrid([
  { horseId: 'horse_A', horseNumber: 1, nameCh: '甲', draw: 3, style: 'leader' },
  { horseId: 'horse_B', horseNumber: 2, nameCh: '乙', draw: 1, style: null },
]);
assert.equal(grid[0]!.draw, 1);
assert.equal(grid[0]!.styleLabel, '未知');
assert.equal(grid[1]!.styleLabel, '放');

const runner = assembleRunner({
  horseId: 'horse_A',
  horseNumber: 5,
  nameCh: '甲',
  nameEn: 'A',
  draw: 2,
  finishingPosition: 1,
  runningPosition: '1-1-2-1',
  totalRunners: 12,
  sectionTimesByNumber: new Map([
    [1, 12.5],
    [2, 23.1],
    [3, 24.0],
  ]),
  sectionNumbers: [1, 2, 3],
  pickRank: 1,
});
assert.equal(runner.role, 'leader');
assert.equal(runner.roleLabel, '領放');
assert.equal(runner.times[0], 12.5);
assert.equal(runner.pickRank, 1);

const withPos = applySectionPositions(
  runner,
  [1, 2, 3],
  new Map([
    [1, 4],
    [2, 3],
    [3, 2],
  ]),
  12,
);
assert.deepEqual(withPos.positions, [4, 3, 2]);
assert.equal(withPos.role, 'prominent');

const highlights = pickHighlightIds([
  { ...runner, horseId: 'horse_X', pickRank: 2, finishingPosition: 5 },
  { ...runner, horseId: 'horse_Y', pickRank: 1, finishingPosition: 8 },
  { ...runner, horseId: 'horse_Z', pickRank: null, finishingPosition: 1 },
]);
assert.ok(highlights.has('horse_Y'));
assert.ok(highlights.has('horse_X'));
assert.equal(highlights.has('horse_Z'), false);

const byFinish = pickHighlightIds([
  { ...runner, horseId: 'horse_1', pickRank: null, finishingPosition: 1 },
  { ...runner, horseId: 'horse_2', pickRank: null, finishingPosition: 2 },
  { ...runner, horseId: 'horse_9', pickRank: null, finishingPosition: 9 },
]);
assert.ok(byFinish.has('horse_1'));
assert.ok(byFinish.has('horse_2'));
assert.equal(byFinish.has('horse_9'), false);

console.log('test-lab-pace: all passed');
