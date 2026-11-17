#!/usr/bin/env tsx
/**
 * 2026-11-14 ST race 7 dead-heat.
 * Official: 1st #9 玩笑, 2nd #8 正本巨星, dead-heat 3rd #6 小霸王 and #13 實力股 (平頭馬).
 * Dividends: 位置Q 8,13 = 10.50 (also 6,8 / 6,9 / 9,13 / 6,13 / 8,9);
 * 連贏 8,9; 三重彩 9,8,6 and 9,8,13; 單T 6,8,9 and 8,9,13;
 * 四連環 6,8,9,13; 四重彩 9,8,6,13 and 9,8,13,6.
 * Frozen picks 13-8-5-14 are a QP hit and not an FF/TRIO/TIERCE/QUARTET hit.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreOfficialPools } from '../src/lib/pool-scores';
import { isVoidResultRow, OFFICIAL_RACE_CANCELLED } from '../src/lib/race-cancellation';
import { auditTop4Pairs } from '../src/lib/prediction-lock';

const finishers = [
  { id: '9', position: 1 },
  { id: '8', position: 2 },
  { id: '6', position: 3 },
  { id: '13', position: 3 },
  { id: '5', position: 5 },
];

const scored = scoreOfficialPools(['13', '8', '5', '14'], finishers);
assert.equal(scored.qpHit, true, '13 and 8 are both placed');
assert.equal(scored.quinellaHit, false, '連贏 is only 8,9');
assert.equal(scored.trioHit, false);
assert.equal(scored.tierceHit, false);
assert.equal(scored.first4Hit, false);
assert.equal(scored.quartetHit, false);
assert.equal(scored.top1Hit, false);
assert.equal(scored.top3AnyHit, true, '8 finished 2nd, already a top3-any hit');
assert.deepEqual(scored.placedIds.sort((a, b) => Number(a) - Number(b)), ['6', '8', '9', '13']);
assert.deepEqual(scored.quinellaSets, [['8', '9']]);
assert.deepEqual(scored.tierceOrders.map((order) => order.join('-')).sort(), ['9-8-13', '9-8-6']);
assert.deepEqual(scored.trioSets.map((set) => set.join(',')).sort(), ['13,8,9', '6,8,9']);
assert.deepEqual(scored.first4Sets, [['13', '6', '8', '9']]);
assert.deepEqual(scored.quartetOrders.map((order) => order.join('-')).sort(), ['9-8-13-6', '9-8-6-13']);

assert.equal(scoreOfficialPools(['8', '9'], finishers).quinellaHit, true);
assert.equal(scoreOfficialPools(['8', '13'], finishers).qpHit, true);
assert.equal(scoreOfficialPools(['6', '13'], finishers).qpHit, true);
assert.equal(scoreOfficialPools(['6', '13'], finishers).quinellaHit, false);
assert.equal(scoreOfficialPools(['9', '8', '6'], finishers).tierceHit, true);
assert.equal(scoreOfficialPools(['9', '8', '13'], finishers).tierceHit, true);
assert.equal(scoreOfficialPools(['9', '8', '13'], finishers).trioHit, true);
assert.equal(scoreOfficialPools(['6', '8', '9'], finishers).trioHit, true);
assert.equal(scoreOfficialPools(['9', '8', '6', '13'], finishers).quartetHit, true);
assert.equal(scoreOfficialPools(['9', '8', '13', '6'], finishers).quartetHit, true);
assert.equal(scoreOfficialPools(['9', '8', '6', '13'], finishers).first4Hit, true);
assert.equal(scoreOfficialPools(['9', '5'], finishers).qpHit, false);

// No dead-heat: first three positions are exactly the first three finishers.
const plain = scoreOfficialPools(['1', '2', '3', '4'], [
  { id: '1', position: 1 },
  { id: '2', position: 2 },
  { id: '3', position: 3 },
  { id: '4', position: 4 },
]);
assert.equal(plain.quinellaHit && plain.qpHit && plain.trioHit && plain.tierceHit && plain.first4Hit && plain.quartetHit, true);
assert.equal(plain.evaluated, true);

const csv = readFileSync(new URL('../../data/2026/results_2026-11-14.csv', import.meta.url), 'utf8');
assert.ok(csv.includes(OFFICIAL_RACE_CANCELLED));
assert.equal(isVoidResultRow({ race_status: 'cancelled', place: '取消', horse_no: '' }), true);
assert.equal(isVoidResultRow({ place: '3 平頭馬', horse_no: '13' }), false);

const frozen = [{ horseNumber: 4, rank: 1 }, { horseNumber: 8, rank: 2 }, { horseNumber: 6, rank: 3 }, { horseNumber: 3, rank: 4 }];
const audit = auditTop4Pairs(
  new Map([[6, frozen], [2, frozen]]),
  new Map([[2, frozen]]),
  new Set([6]),
);
assert.equal(audit.ok, true);
assert.equal(audit.mismatches.length, 0);
const race6 = audit.races.find((race) => race.raceNumber === 6);
assert.equal(race6?.frozenTop4, '4-8-6-3');
assert.equal(race6?.comparedTop4, '');
assert.equal(race6?.ok, true);
assert.equal(race6?.void, true);
assert.equal(race6?.settlement, 'void');

console.log('pool-scores and void lock ok');
