/**
 * Results course / rating split used by import-csv before D1 push.
 */
import assert from 'node:assert/strict';
import { railKey, splitOfficialCourse, normalizeRatingRange, OfficialFieldError } from '../src/lib/result-course';

const turf = splitOfficialCourse('草地 - "A" 賽道');
assert.equal(turf.track, '草地');
assert.equal(turf.course, 'A');
assert.equal(splitOfficialCourse('草地 - "C+3" 賽道').course, 'C+3');
assert.equal(splitOfficialCourse('草地 - "B+2" 賽道').course, 'B+2');
assert.deepEqual(splitOfficialCourse('全天候跑道'), { track: '全天候', course: '全天候' });

assert.throws(() => splitOfficialCourse(''), OfficialFieldError);
assert.throws(() => splitOfficialCourse('草地跑道'), OfficialFieldError);

assert.equal(normalizeRatingRange('60-40'), '60-40');
assert.equal(normalizeRatingRange('40 - 0'), '40-0');
assert.equal(normalizeRatingRange(''), null);
assert.equal(normalizeRatingRange('-'), null);
assert.throws(() => normalizeRatingRange('好'), OfficialFieldError);

assert.equal(railKey('草地 - "C+3" 賽道'), 'C+3');
assert.equal(railKey('全天候跑道'), 'AWT');
assert.equal(railKey('全天候'), 'AWT');
assert.equal(railKey('A'), 'A');
assert.equal(railKey('c+3'), 'C+3');
assert.equal(railKey(''), 'NA');

console.log('result-course ok');
