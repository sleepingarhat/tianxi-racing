// Explanation-only factors: going neighbourhood and 快操／試閘 trackwork reading.
// Run: bun scripts/test-factor-explain.ts
import { strict as assert } from 'node:assert';
import { conditionFromCounts, goingFitFromRows, surfaceOf } from '../src/lib/factor-explain';

// Surface detection covers both feed spellings.
assert.equal(surfaceOf('TURF', '好地'), 'turf');
assert.equal(surfaceOf('ALL WEATHER TRACK', '好地'), 'awt');
assert.equal(surfaceOf('全天候', '好地'), 'awt');
assert.equal(surfaceOf(null, '濕慢地'), 'awt');
assert.equal(surfaceOf(null, '好地'), null);

const rows = [
  { track: '草地', going: '好地', starts: 6, top3: 2 },
  { track: '草地', going: '黏地', starts: 1, top3: 1 },
  { track: '草地', going: '快地', starts: 3, top3: 0 },
  { track: '全天候', going: '好地', starts: 4, top3: 4 },
];
// 好地至黏地 on turf counts turf 好地 and 黏地 (±1 grade); not 快地 (2 grades away) and not AWT 好地.
const rare = goingFitFromRows(rows, '好地至黏地', 'TURF');
assert.equal(rare.note, '草地 好地／好地至黏地／黏地 7 戰 3上 (43%)');
// Exact old behaviour would have found no 好地至黏地 runs at all.
assert.ok(rare.conf > 0);
// AWT 好地 does not borrow turf runs.
assert.equal(goingFitFromRows(rows, '好地', '全天候').note, '全天候 快地／好地／濕快地 4 戰 4上 (100%)');
// Unknown surface keeps the exact string rule.
assert.equal(goingFitFromRows(rows, '黏地', null).note, '黏地 往績不足');
assert.equal(goingFitFromRows([], '好地', 'TURF').note, '無場地往績');
assert.equal(goingFitFromRows(rows, null, 'TURF').note, '場地狀況未定');

// Trackwork: routine 踱步／游水 never counts as over-training.
const busy = conditionFromCounts({ total: 26, fast: 3, trials: 0, races: 1 });
assert.equal(busy.bonus, 0, 'normal HK routine (26 activities, 3 fast works) is neutral, not −5');
assert.equal(busy.note, '14 天快操 3 課（另有 22 課踱步、游水等）');
const noFast = conditionFromCounts({ total: 18, fast: 0, trials: 0 });
assert.equal(noFast.bonus, -3);
assert.equal(noFast.note, '14 天未見快操或試閘（另有 18 課踱步、游水等）');
assert.equal(conditionFromCounts({ total: 5, fast: 1, trials: 1 }).note, '14 天快操 1 課、試閘 1 次（另有 3 課踱步、游水等）');
assert.equal(conditionFromCounts({ total: 0, fast: 0, trials: 0 }).note, '無晨操記錄');

console.log('test-factor-explain: all assertions passed');
