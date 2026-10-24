#!/usr/bin/env tsx
/** Tests for RaceCard.aspx race-meta parsing (offline fixtures + identity guard). */
import assert from 'node:assert';
import { parseRaceMeta, racecardPageUrl } from './ingest/lib/racecard-meta.js';

const FIXTURE = `
<div class="f_fs13" style="line-height: 20px;"><span class="font_wb" />第 1 場 - 六福珠寶洛神水賦系列讓賽</span><br>2026年10月25日, 星期日, 沙田, 12:40<br>草地, "A" 賽道, 1200米, 好地<br>獎金: $1,170,000, 評分: 60-40, 第四班（條件限制）</div>
`;

const m = parseRaceMeta(FIXTURE, '2026-10-25', 'ST', 1);
assert.equal(m.postTime, '12:40', 'post time parsed');
assert.equal(m.distance, 1200, 'distance parsed');
assert.equal(m.track, '草地', 'track parsed');
assert.equal(m.course, 'A', 'course parsed');
assert.equal(m.going, '好地', 'going parsed');
assert.equal(m.raceClass, '第四班', 'class parsed');
assert.equal(m.raceName, '六福珠寶洛神水賦系列讓賽', 'race name parsed');

// Identity guard: wrong race number or venue must not fabricate meta.
const wrong = parseRaceMeta(FIXTURE, '2026-10-25', 'ST', 2);
assert.equal(wrong.postTime, null, 'wrong race number yields null post time');
const wrongVenue = parseRaceMeta(FIXTURE, '2026-10-25', 'HV', 1);
assert.equal(wrongVenue.postTime, null, 'wrong venue yields null post time');
const wrongDate = parseRaceMeta(FIXTURE, '2026-10-26', 'ST', 1);
assert.equal(wrongDate.postTime, null, 'wrong date yields null post time');

// Missing track line: post time still parsed, rest null.
const NO_TRACK = `<div>第 3 場 - 測試讓賽</span><br>2026年10月25日, 星期日, 沙田, 14:10<br></div>`;
const m3 = parseRaceMeta(NO_TRACK, '2026-10-25', 'ST', 3);
assert.equal(m3.postTime, '14:10');
assert.equal(m3.distance, null);

assert.equal(
  racecardPageUrl('2026-10-25', 'ST', 1),
  'https://racing.hkjc.com/racing/information/Chinese/racing/RaceCard.aspx?RaceDate=2026/10/25&Racecourse=ST&RaceNo=1',
);

console.log('test-racecard-meta: all assertions passed');
