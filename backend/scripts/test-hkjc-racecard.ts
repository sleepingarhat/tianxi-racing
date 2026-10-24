#!/usr/bin/env tsx
/** Tests for the shared whitelisted HKJC race-card fetch + weight mapping. */
import assert from 'node:assert';
import { isLocalCard, mapWeights } from './ingest/lib/hkjc-racecard.js';

// Weight mapping verified 2026-10-24 against HKJC's own bet-site rendering
// (handicapWeight = 負磅, currentWeight = 排位體重) and the live 2026-10-25
// ST R1 card (handicapWeight 132, currentWeight 921/1151).
const w1 = mapWeights({ handicapWeight: '132', currentWeight: '1151', allowance: '7 ' });
assert.equal(w1.declaredWeight, 132, 'handicapWeight is 負磅 (declared_weight)');
assert.equal(w1.actualWeight, 125, 'actual_weight = 負磅 - 見習減磅');
assert.equal(w1.bodyWeight, 1151, 'currentWeight is body weight, never a carried weight');

const w2 = mapWeights({ handicapWeight: '115', currentWeight: '1000', allowance: '  ' });
assert.equal(w2.declaredWeight, 115);
assert.equal(w2.actualWeight, 115, 'blank allowance deducts nothing');
assert.equal(w2.bodyWeight, 1000);

const w3 = mapWeights({ handicapWeight: null, currentWeight: null, allowance: null });
assert.equal(w3.declaredWeight, null);
assert.equal(w3.actualWeight, null);
assert.equal(w3.bodyWeight, null);

// actual_weight must stay in the carried-weight range, never body weight.
for (const w of [w1, w2]) {
  assert.ok(w.actualWeight! >= 100 && w.actualWeight! <= 140, `actual_weight ${w.actualWeight} in carried range`);
}

// Local-card guard: every runner must carry a local HK horse id.
const local = { races: [{ runners: [{ horse: { id: 'HK_2023_J001' } }, { horse: { id: 'HK_2024_K210' } }] }] };
assert.ok(isLocalCard(local), 'all-local card accepted');
const overseas = { races: [{ runners: [{ horse: { id: 'HK_2023_J001' } }, { horse: { id: 'GB_2020_X12' } }] }] };
assert.ok(!isLocalCard(overseas), 'card with any non-local horse id rejected');
assert.ok(!isLocalCard({ races: [] }), 'empty card rejected');
assert.ok(!isLocalCard({ races: [{ runners: [] }] }), 'race with no runners rejected');

console.log('test-hkjc-racecard: all assertions passed');
