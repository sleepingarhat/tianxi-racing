#!/usr/bin/env tsx
/**
 * lab-h2h 純函式測試（無 D1）。跑：npm run test:lab-h2h
 */
import assert from 'node:assert/strict';
import {
  LOW_SAMPLE_NOTE,
  buildConditionRows,
  buildDirectMeetings,
  buildRunningStyle,
  canonicalH2hCacheKey,
  collectWarnings,
  drawBand,
  emptyStats,
  isH2hType,
  MAX_ENTITY_ID_LENGTH,
  meetingMarkersFrom,
  parseDistanceFilter,
  statsFromPositions,
  validateEntityId,
  type ResultRow,
} from '../src/lib/lab-h2h';

function r(partial: Partial<ResultRow> & Pick<ResultRow, 'entityId' | 'raceId' | 'date'>): ResultRow {
  return {
    venue: 'ST',
    raceNumber: 1,
    distance: 1200,
    going: '好',
    track: '草地',
    draw: 5,
    position: 3,
    runningPosition: '4-3-3',
    totalRunners: 12,
    last400: 22.5,
    ...partial,
  };
}

assert.equal(isH2hType('horse'), true);
assert.equal(isH2hType('jockey'), true);
assert.equal(isH2hType('trainer'), false);
assert.equal(validateEntityId('horse', 'horse_J062'), true);
assert.equal(validateEntityId('horse', 'horse_A001'), true);
assert.equal(validateEntityId('horse', 'horse_A-1'), true);
assert.equal(validateEntityId('horse', 'J062'), false);
assert.equal(validateEntityId('jockey', 'jockey_PZ'), true);
assert.equal(validateEntityId('jockey', 'jockey_HAA'), true);
assert.equal(validateEntityId('jockey', 'PZ'), false);
assert.equal(validateEntityId('jockey', 'jockey_潘頓'), true);
assert.equal(validateEntityId('jockey', 'jockey_郭能'), true);
assert.equal(validateEntityId('jockey', 'jockey_潘_頓'), true);
assert.equal(validateEntityId('horse', 'horse_金鎗六十'), true);
assert.equal(validateEntityId('horse', 'jockey_潘頓'), false);
assert.equal(validateEntityId('jockey', 'horse_J062'), false);
assert.equal(validateEntityId('jockey', 'jockey_'), false);
assert.equal(validateEntityId('jockey', 'jockey_潘 頓'), false);
assert.equal(validateEntityId('jockey', 'jockey_潘|頓'), false);
assert.equal(validateEntityId('jockey', "jockey_潘頓'"), false);
assert.equal(validateEntityId('jockey', 'jockey_../潘'), false);
assert.equal(validateEntityId('jockey', 'jockey_潘\n頓'), false);
assert.equal(validateEntityId('jockey', 'jockey_潘\u0000頓'), false);
const maxSuffix = 'A'.repeat(MAX_ENTITY_ID_LENGTH - 'jockey_'.length);
assert.equal(validateEntityId('jockey', `jockey_${maxSuffix}`), true);
assert.equal(validateEntityId('jockey', `jockey_${maxSuffix}A`), false);
assert.equal(validateEntityId('jockey', `jockey_${'潘'.repeat(100)}`), true);

assert.equal(drawBand(1), '1-4');
assert.equal(drawBand(4), '1-4');
assert.equal(drawBand(5), '5-8');
assert.equal(drawBand(12), '9-12');
assert.equal(drawBand(14), '13+');
assert.equal(drawBand(null), null);

assert.equal(parseDistanceFilter('1200'), 1200);
assert.equal(parseDistanceFilter(''), null);
assert.equal(parseDistanceFilter('abc'), null);

const s = statsFromPositions([1, 2, 4, 8, 3]);
assert.equal(s.starts, 5);
assert.equal(s.wins, 1);
assert.equal(s.top3, 3);
assert.equal(s.lowSample, false);
assert.ok(s.avgPlace != null && s.avgPlace > 0);

const low = statsFromPositions([1, 2]);
assert.equal(low.lowSample, true);
assert.deepEqual(emptyStats().starts, 0);

const rowsA = [
  r({ entityId: 'a', raceId: 'race_1', date: '2026-01-01', distance: 1200, going: '好', venue: 'ST', draw: 2, position: 1, runningPosition: '1-1-1' }),
  r({ entityId: 'a', raceId: 'race_2', date: '2026-02-01', distance: 1400, going: '好至快', venue: 'HV', draw: 7, position: 5, runningPosition: '6-5-5' }),
  r({ entityId: 'a', raceId: 'race_3', date: '2026-03-01', distance: 1200, going: '好', venue: 'ST', draw: 3, position: 2, runningPosition: '2-2-2' }),
];
const rowsB = [
  r({ entityId: 'b', raceId: 'race_1', date: '2026-01-01', distance: 1200, going: '好', venue: 'ST', draw: 8, position: 4, runningPosition: '8-7-5' }),
  r({ entityId: 'b', raceId: 'race_4', date: '2026-04-01', distance: 1200, going: '好', venue: 'ST', draw: 1, position: 1, runningPosition: '1-1-1' }),
];

const conditions = buildConditionRows(rowsA, rowsB);
const overall = conditions.find((c) => c.key === 'overall');
assert.ok(overall);
assert.equal(overall!.a.starts, 3);
assert.equal(overall!.b.starts, 2);
assert.ok(conditions.some((c) => c.key.startsWith('distance:')));
assert.ok(conditions.some((c) => c.key.startsWith('draw:')));

const filtered = buildConditionRows(rowsA, rowsB, { distance: 1200, venue: 'ST' });
assert.equal(filtered.find((c) => c.key === 'overall')!.a.starts, 2);

const meetings = buildDirectMeetings(rowsA, rowsB);
assert.equal(meetings.length, 1);
assert.equal(meetings[0].raceId, 'race_1');
assert.equal(meetings[0].ahead, 'a');

const style = buildRunningStyle(rowsA);
assert.ok(style.sample >= 1);
assert.ok(style.buckets.some((b) => b.count > 0));
assert.ok(['放', '前', '中', '後'].includes(style.buckets.find((b) => b.count > 0)!.label));

const markers = meetingMarkersFrom(
  meetings,
  [{ date: '2026-01-01', rating: 1500 }, { date: '2026-02-01', rating: 1510 }],
  [{ date: '2026-01-01', rating: 1480 }, { date: '2026-02-01', rating: 1490 }],
);
assert.ok(markers.some((m) => m.date === '2026-01-01'));
assert.ok(markers.some((m) => m.date === '2026-02-01')); // elo 交集

const warns = collectWarnings([{ lowSample: true }, { lowSample: false }]);
assert.deepEqual(warns, [LOW_SAMPLE_NOTE]);
assert.deepEqual(collectWarnings([{ lowSample: false }]), []);

const k1 = canonicalH2hCacheKey({ type: 'horse', a: 'horse_B', b: 'horse_A', distance: null, going: null, venue: null });
const k2 = canonicalH2hCacheKey({ type: 'horse', a: 'horse_A', b: 'horse_B', distance: null, going: null, venue: null });
assert.equal(k1, k2);
assert.ok(k1.startsWith('lab-h2h|horse|'));

console.log('test-lab-h2h: all passed');
