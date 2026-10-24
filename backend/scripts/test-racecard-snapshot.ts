import assert from 'node:assert/strict';
import { buildRows, contentSha, parseGear, toCsv } from './ingest/lib/racecard-snapshot.js';

assert.deepEqual(parseGear('B1/TT/CP-'), { first: ['B'], replaced: [], removed: ['CP'] });
assert.deepEqual(parseGear('XB2'), { first: [], replaced: ['XB'], removed: [] });
assert.deepEqual(parseGear(''), { first: [], replaced: [], removed: [] });

const meeting = { date: '2026-10-25', venueCode: 'ST', races: [{ no: 1, runners: [
  { no: 2, name_ch: '星球勇士', horse: { id: 'HK_2023_J001', code: 'J001' }, currentWeight: 132, handicapWeight: null, currentRating: 60, gearInfo: 'TT1', standbyNo: '' },
  { no: null, name_ch: '後備馬', horse: { id: 'HK_2023_J002' }, currentWeight: 115, currentRating: 40, gearInfo: '', standbyNo: '1' },
] }] };
const rows = buildRows(meeting, '2026-10-24T20:00:00.000Z', new Map([['HK_2023_J001', 57]]));
assert.equal(rows[0].carried_weight_lbs, 132, 'currentWeight is carried weight');
assert.equal(rows[0].rating_change_vs_prev_card, 3);
assert.equal(rows[0].gear_first_time, 'TT');
assert.equal(rows[1].is_standby, true);
assert.equal(rows[1].rating_change_vs_prev_card, null, 'no earlier card -> no change claimed');
assert.ok(toCsv(rows).startsWith('\uFEFFrace_date,venue,'));
const later = buildRows(meeting, '2026-10-25T03:00:00.000Z', new Map([['HK_2023_J001', 57]]));
assert.equal(contentSha(rows), contentSha(later), 'scrape time alone does not create a new snapshot');
console.log('racecard snapshot: 10 checks passed');
