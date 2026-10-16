#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { factorScores, paceEstimates, stagesOf, configFingerprint } from '../src/lib/lock-telemetry';

// total is the stored factor_bonus (draw+weight only), not the sum of all 8.
const fs = JSON.parse(factorScores({ draw: { bonus: 0.3 }, weight: { bonus: -0.1 }, recency: { bonus: 2 } }, 0.2)!);
assert.equal(fs.total, 0.2);
assert.equal(fs.recency, 2);
assert.deepEqual(fs.used, ['draw', 'weight']);
assert.equal(factorScores(null, 1), null);

// final number (finish) excluded from stages
assert.deepEqual(stagesOf('5 3 3 1'), [5, 3, 3]);
assert.equal(stagesOf('1'), null);

const rows = [
  ...['2026-10-01', '2026-09-20', '2026-09-10'].map((d) => ({ horse_id: 'horse_A', race_date: d, distance: 1200, running_position: '1 1 1 2' })),
  ...['2026-10-01', '2026-09-20', '2026-09-10'].map((d) => ({ horse_id: 'horse_B', race_date: d, distance: 1200, running_position: '8 6 4 1' })),
  // same-day / future rows must be ignored (no leakage)
  ...['2026-10-16', '2026-10-20', '2026-10-25'].map((d) => ({ horse_id: 'horse_C', race_date: d, distance: 1200, running_position: '1 1 1 1' })),
];
const p = paceEstimates(['horse_A', 'horse_B', 'horse_C'], rows, '2026-10-16', 1200);
assert.equal(p.get('horse_A')!.early, 1);
assert.equal(p.get('horse_B')!.early, 2);
assert.equal(p.has('horse_C'), false);
assert.equal(p.get('horse_A')!.method, 'history-v1');

configFingerprint({ a: 1 }).then((f) => { assert.match(f, /^cfg-[0-9a-f]{16}$/); console.log('lock-telemetry tests passed'); });
