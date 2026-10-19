import assert from 'node:assert/strict';
import {parseHkjcChangesPage} from '../src/lib/hkjc-changes';
import {runnerChangeRecord,assertChangeResultConsistent} from '../src/lib/racing-change-records';
import {readChangesManifest} from './backtest/withdrawal-input';
import {applyOfficialSelection} from '../src/lib/hkjc-preflight';
import {raceAccounting} from '../src/lib/withdrawal-accounting';
const pages=readChangesManifest('../evidence/changes-manifest.json');
const page=pages[0];assert.ok(page);assert.equal(page.date,'2026-10-19');
const rec=runnerChangeRecord(page,11,2,'極上紗瓏','2026-10-19T03:00:00Z');
assert.equal(rec.withdrawn,true);assert.equal(rec.trainingEligible,false);assert.equal(rec.hasWithdrawal,true);
assert.throws(()=>assertChangeResultConsistent(true,4),/withdrawn-runner/);assert.doesNotThrow(()=>assertChangeResultConsistent(false,null));
const frozen=await Bun.file('/tmp/frozen-after.json').json();
assert.equal(frozen.snapshot.sha256,'388f22b44e13e2124e46d3a703027025d401225725152879793b4578f148ce89');
for(const rn of [8,10,11]) {
 const race=frozen.races.find((r:any)=>r.raceNumber===rn);assert.ok(race);
 const state=applyOfficialSelection(race.picks,rn,page,frozen.lockAt);
 if(rn===11){assert.deepEqual(state.original,[8,13,6,2]);assert.deepEqual(state.effective,[8,13,6,10]);const account=raceAccounting(state.original,state.effective,state.withdrawnHorseNumbers,true,null);assert.equal(account.original.pools.reduce((n,p)=>n+p.refund,0),460);assert.equal(account.original.pools.reduce((n,p)=>n+p.cost,0),70);}
 else assert.equal(state.status,'invalid-prelock-input');
}
console.log('Official R8/R10 excluded, R11 originals/effective + refund readback passed; no frozen writes');
