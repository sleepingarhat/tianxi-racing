#!/usr/bin/env tsx
/**
 * Predictor and freeze capture must agree on who starts (2026-11-22 R9 #3 regression).
 * A runner marked 退出 or 後備N before the lock is never scored, so the freeze capture
 * that compares prediction rows with starters cannot block on it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isStarterPriority, starterPredicate } from '../src/lib/starter-entries.js';

assert.equal(isStarterPriority(null), true);
assert.equal(isStarterPriority(''), true);
assert.equal(isStarterPriority('正選'), true);
assert.equal(isStarterPriority('退出'), false);
assert.equal(isStarterPriority('後備1'), false);
assert.equal(starterPredicate('e'), "(e.priority_order IS NULL OR e.priority_order='' OR e.priority_order='正選')");

const analyze = readFileSync(new URL('../src/routes/analyze.ts', import.meta.url), 'utf8');
const scoring = [...analyze.matchAll(/FROM entries_upcoming e (?:LEFT )?JOIN horses h ON h\.id = e\.horse_id\s+WHERE ([^\n]+)/g)];
assert.ok(scoring.length >= 4, `expected the scoring entry queries, found ${scoring.length}`);
for (const match of scoring) {
  assert.ok(match[1].includes("${starterPredicate('e')}"), `scoring query must exclude non-starters: ${match[1].trim()}`);
}
const recovery = readFileSync(new URL('../src/lib/freeze-recovery.ts', import.meta.url), 'utf8');
assert.ok(/FROM entries_upcoming WHERE[^`]*\$\{starterPredicate\(\)\}/.test(recovery), 'freeze capture must use the shared starter rule');
console.log('starter entry tests passed');
