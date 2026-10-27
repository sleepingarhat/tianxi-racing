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
import { coerceFinishingPosition } from '../src/lib/finishing-position';

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
assert.equal(isH2hType('trainer'), true);
assert.equal(isH2hType('owner'), false);
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
assert.equal(validateEntityId('trainer', 'trainer_CAS'), true);
assert.equal(validateEntityId('trainer', 'trainer_方嘉柏'), true);
assert.equal(validateEntityId('trainer', 'trainer_蔡約翰'), true);
assert.equal(validateEntityId('trainer', 'trainer_方_嘉柏'), true);
assert.equal(validateEntityId('trainer', '方嘉柏'), false);
assert.equal(validateEntityId('trainer', 'jockey_方嘉柏'), false);
assert.equal(validateEntityId('trainer', 'horse_方嘉柏'), false);
assert.equal(validateEntityId('jockey', 'trainer_方嘉柏'), false);
assert.equal(validateEntityId('trainer', 'trainer_'), false);
assert.equal(validateEntityId('trainer', 'trainer_方 嘉柏'), false);
assert.equal(validateEntityId('trainer', 'trainer_方|嘉柏'), false);
assert.equal(validateEntityId('trainer', "trainer_方嘉柏'"), false);
assert.equal(validateEntityId('trainer', 'trainer_../方'), false);
assert.equal(validateEntityId('trainer', 'trainer_方\n嘉柏'), false);
assert.equal(validateEntityId('trainer', 'trainer_方\u0000嘉柏'), false);
const trainerMax = 'A'.repeat(MAX_ENTITY_ID_LENGTH - 'trainer_'.length);
assert.equal(validateEntityId('trainer', `trainer_${trainerMax}`), true);
assert.equal(validateEntityId('trainer', `trainer_${trainerMax}A`), false);
assert.equal(validateEntityId('trainer', `trainer_${'蔡'.repeat(100)}`), true);

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

// 兩邊都有效 → ahead；同名次 → tie
const bothValid = buildDirectMeetings(
  [r({ entityId: 'a', raceId: 'race_tie', date: '2026-05-01', position: 3, draw: 4 })],
  [r({ entityId: 'b', raceId: 'race_tie', date: '2026-05-01', position: 3, draw: 8 })],
);
assert.equal(bothValid.length, 1);
assert.equal(bothValid[0].ahead, 'tie');
assert.equal(bothValid[0].a.position, 3);
assert.equal(bothValid[0].b.position, 3);

const aAhead = buildDirectMeetings(
  [r({ entityId: 'a', raceId: 'race_win', date: '2026-05-02', position: 1, draw: 2 })],
  [r({ entityId: 'b', raceId: 'race_win', date: '2026-05-02', position: 6, draw: 9 })],
);
assert.equal(aAhead[0].ahead, 'a');
const bAhead = buildDirectMeetings(
  [r({ entityId: 'a', raceId: 'race_win', date: '2026-05-02', position: 8, draw: 2 })],
  [r({ entityId: 'b', raceId: 'race_win', date: '2026-05-02', position: 2, draw: 1 })],
);
assert.equal(bAhead[0].ahead, 'b');

// 只有一邊有效名次 → 該邊名次保留，另一邊 null，ahead null
const oneInvalid = buildDirectMeetings(
  [r({ entityId: 'a', raceId: 'race_pu', date: '2026-06-13', position: 999, draw: null, raceNumber: 10 })],
  [r({ entityId: 'b', raceId: 'race_pu', date: '2026-06-13', position: 9, draw: 12, raceNumber: 10 })],
);
assert.equal(oneInvalid.length, 1);
assert.equal(oneInvalid[0].ahead, null);
assert.equal(oneInvalid[0].a.position, null);
assert.equal(oneInvalid[0].a.draw, null);
assert.equal(oneInvalid[0].b.position, 9);
assert.equal(oneInvalid[0].b.draw, 12);

// 練馬師同場兩駒：以前 mapB.set 留最後一列（往往係較差名次或 999），
// 再逐列掃 A，會出重複場次，並把 ahead 配成 null。
// 而家每場一次，用兩邊最佳有效名次。
const multiA = [
  r({ entityId: 'trainer_呂健威', raceId: 'race_multi', date: '2026-06-01', position: 999, draw: 5, raceNumber: 4 }),
  r({ entityId: 'trainer_呂健威', raceId: 'race_multi', date: '2026-06-01', position: 2, draw: 3, raceNumber: 4 }),
];
const multiB = [
  r({ entityId: 'trainer_方嘉柏', raceId: 'race_multi', date: '2026-06-01', position: 4, draw: 9, raceNumber: 4 }),
  r({ entityId: 'trainer_方嘉柏', raceId: 'race_multi', date: '2026-06-01', position: 999, draw: 11, raceNumber: 4 }),
];
const multi = buildDirectMeetings(multiA, multiB);
assert.equal(multi.length, 1);
assert.equal(multi[0].raceId, 'race_multi');
assert.equal(multi[0].a.position, 2);
assert.equal(multi[0].a.draw, 3);
assert.equal(multi[0].b.position, 4);
assert.equal(multi[0].b.draw, 9);
assert.equal(multi[0].ahead, 'a');

// 同名次多駒：取較細檔位，唔取後寫入嗰匹。
const samePlace = buildDirectMeetings(
  [
    r({ entityId: 'a', raceId: 'race_dh', date: '2026-06-02', position: 2, draw: 8 }),
    r({ entityId: 'a', raceId: 'race_dh', date: '2026-06-02', position: 2, draw: 3 }),
  ],
  [r({ entityId: 'b', raceId: 'race_dh', date: '2026-06-02', position: 2, draw: 1 })],
);
assert.equal(samePlace.length, 1);
assert.equal(samePlace[0].ahead, 'tie');
assert.equal(samePlace[0].a.position, 2);
assert.equal(samePlace[0].a.draw, 3);

// 2026-06-27 沙田第9場（race_2026-06-27_ST_9）：
// 呂健威只有 PU（入庫 999，檔5）；方嘉柏第4檔9 同第8檔11。
// 舊配對留最後一匹方嘉柏（第8），ahead 因 999 而係 null。
// 新行為：一場、呂健威名次 null、方嘉柏最佳第4、ahead null。
const race9 = buildDirectMeetings(
  [r({
    entityId: 'trainer_呂健威', raceId: 'race_2026-06-27_ST_9', date: '2026-06-27',
    venue: 'ST', raceNumber: 9, distance: 1650, going: '好地', position: 999, draw: 5,
  })],
  [
    r({
      entityId: 'trainer_方嘉柏', raceId: 'race_2026-06-27_ST_9', date: '2026-06-27',
      venue: 'ST', raceNumber: 9, distance: 1650, going: '好地', position: 4, draw: 9,
    }),
    r({
      entityId: 'trainer_方嘉柏', raceId: 'race_2026-06-27_ST_9', date: '2026-06-27',
      venue: 'ST', raceNumber: 9, distance: 1650, going: '好地', position: 8, draw: 11,
    }),
  ],
);
assert.equal(race9.length, 1);
assert.equal(race9[0].ahead, null);
assert.equal(race9[0].a.position, null);
assert.equal(race9[0].a.draw, 5);
assert.equal(race9[0].b.position, 4);
assert.equal(race9[0].b.draw, 9);

// 2026-06-13 沙田第10場：呂健威 WV-A（999、無檔），方嘉柏第9檔12。ahead null。
const race10 = buildDirectMeetings(
  [r({
    entityId: 'trainer_呂健威', raceId: 'race_2026-06-13_ST_10', date: '2026-06-13',
    venue: 'ST', raceNumber: 10, distance: 1600, going: '好地至黏地', position: 999, draw: null,
  })],
  [r({
    entityId: 'trainer_方嘉柏', raceId: 'race_2026-06-13_ST_10', date: '2026-06-13',
    venue: 'ST', raceNumber: 10, distance: 1600, going: '好地至黏地', position: 9, draw: 12,
  })],
);
assert.equal(race10.length, 1);
assert.equal(race10[0].ahead, null);
assert.equal(race10[0].a.position, null);
assert.equal(race10[0].b.position, 9);

// 2026-06-13 沙田第1場：呂健威兩駒第2檔2、第5檔4；方嘉柏第6檔1。只出一行，用最佳名次。
const race1 = buildDirectMeetings(
  [
    r({
      entityId: 'trainer_呂健威', raceId: 'race_2026-06-13_ST_1', date: '2026-06-13',
      venue: 'ST', raceNumber: 1, going: '好地至黏地', position: 2, draw: 2,
    }),
    r({
      entityId: 'trainer_呂健威', raceId: 'race_2026-06-13_ST_1', date: '2026-06-13',
      venue: 'ST', raceNumber: 1, going: '好地至黏地', position: 5, draw: 4,
    }),
  ],
  [r({
    entityId: 'trainer_方嘉柏', raceId: 'race_2026-06-13_ST_1', date: '2026-06-13',
    venue: 'ST', raceNumber: 1, going: '好地至黏地', position: 6, draw: 1,
  })],
);
assert.equal(race1.length, 1);
assert.equal(race1[0].ahead, 'a');
assert.equal(race1[0].a.position, 2);
assert.equal(race1[0].a.draw, 2);
assert.equal(race1[0].b.position, 6);
assert.equal(race1[0].b.draw, 1);

// 路由層：DB 若存到文字名次，唔好 Number("1 DH") → NaN。
assert.equal(coerceFinishingPosition(4), 4);
assert.equal(coerceFinishingPosition(999), 999);
assert.equal(coerceFinishingPosition('1 DH'), 1);
assert.equal(coerceFinishingPosition('三'), 3);
assert.equal(coerceFinishingPosition('PU'), null);
assert.equal(coerceFinishingPosition(null), null);

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
