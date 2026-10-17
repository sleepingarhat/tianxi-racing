import assert from 'node:assert/strict';
import { V12_DEFAULTS, timeWeightedK, computeV12RaceDeltas, computeConfidence, provisionalMultiplier, classifyIdle } from './elo/engine_v12.js';
assert.equal(V12_DEFAULTS.horse.k, 28);
assert.equal(V12_DEFAULTS.jockey.k, 18);
assert.equal(V12_DEFAULTS.trainer.k, 11);
assert.equal(timeWeightedK(V12_DEFAULTS.horse, 548), 28 * Math.exp(-1));
assert.equal(provisionalMultiplier(V12_DEFAULTS.horse, 5), 1.5);
assert.equal(provisionalMultiplier(V12_DEFAULTS.horse, 6), 1);
const deltas=computeV12RaceDeltas([
 {entityId:'A',finish:1,currentRating:1500,gamesPlayed:0,daysSinceLastRace:null},
 {entityId:'B',finish:2,currentRating:1500,gamesPlayed:0,daysSinceLastRace:null},
],V12_DEFAULTS.horse);
assert.equal(deltas.get('A'),21);assert.equal(deltas.get('B'),-21);
const state={rating:1500,gamesPlayed:20,recencyWeightedGames:6,lastRaceDate:'2025-01-01',priorRating:1500,lastSeasonEndApplied:null,isFrozen:false,isRetired:false};
assert.equal(computeConfidence(V12_DEFAULTS.horse,state),1-Math.exp(-1));
assert.equal(classifyIdle(V12_DEFAULTS.horse,state,'2026-01-02').isFrozen,true);
assert.equal(classifyIdle(V12_DEFAULTS.horse,state,'2027-01-01').isRetired,true);
console.log('v12 original parameter and formula tests passed');
