import assert from 'node:assert/strict';
import {readChangesManifest} from './backtest/withdrawal-input';
import {assertChangeResultConsistent} from '../src/lib/racing-change-records';
assert.throws(()=>readChangesManifest(''),/official-change-manifest-required/);
assert.throws(()=>assertChangeResultConsistent(true,4),/withdrawn-runner/);
assert.doesNotThrow(()=>assertChangeResultConsistent(false,null));
console.log('Missing manifest stops training; withdrawn winners contradict; started DNF is not withdrawal');