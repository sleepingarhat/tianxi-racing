import assert from 'node:assert/strict';
import { raceAccounting,settleSingleBox,settleCrossTrioTicket,substituteTrioLeg } from '../src/lib/withdrawal-accounting';
import { effectiveTop4 } from '../src/lib/withdrawal-substitution';
const lock='2026-10-19T00:48:00Z';
const ranked=[1,2,3,4,5].map((horseNumber,i)=>({horseNumber,rank:i+1,withdrawn:horseNumber===4,announcedAtIso:'2026-10-19T00:47:00Z'}));
assert.equal(effectiveTop4(ranked,lock).status,'invalid-prelock-input');
assert.equal(raceAccounting([1,2,3,4],[],[4],false,{}).scoringEligible,false);
assert.deepEqual(raceAccounting([1,2,3,4],[],[4],false,{}).original.pools,[]);
assert.deepEqual(effectiveTop4(ranked.map(p=>({...p,announcedAtIso:'2026-10-19T01:00:00Z'})),lock).effective,[1,2,3,5]);
assert.deepEqual(effectiveTop4(ranked.map(p=>({...p,withdrawn:p.horseNumber===1,announcedAtIso:'2026-10-19T01:00:00Z'})),lock).effective,[2,3,4,5]);
for(const [pool,gross,refund,cost] of [['FF',10,10,0],['TRIO',40,30,10],['TIERCE',240,180,60],['QUARTET',240,240,0]] as const) {
 const p=settleSingleBox(pool,[8,13,6,2],[2],[]); assert.deepEqual([p.grossCost,p.refund,p.cost],[gross,refund,cost]);
}
const r=raceAccounting([8,13,6,2],[8,13,6,10],[2],true,{TRI:[{nums:['8','13','6'],div:123.4}]});
assert.equal(r.original.pools[1]?.payout,123.4); assert.equal(r.effective.pools[1]?.refund,0); assert.equal(r.effective.pools[1]?.cost,40);
assert.equal(settleSingleBox('TRIO',[1,2,3,4],[],[]).net,-40);
assert.equal(settleSingleBox('TRIO',[1,2,3,4],[],null).payout,null);
assert.equal(settleSingleBox('TRIO',[1,2,3,4],[],null,10,true).refund,40);
assert.equal(settleSingleBox('TRIO',[1,2,3,4],[],[{nums:['1','2','3'],div:10.5},{nums:['1','2','4'],div:20.25}]).payout,30.75);
for(const withdrawals of [[9],[9,10],[9,10,11]]) {
 for(const selections of [[9,7,8],[9,1,8],[9,1,2],[9,1,3]]) {
  const x=substituteTrioLeg({selections,withdrawals,favourites:[1,2,3],favouriteSource:'official'}); assert.equal(x.status,'valid'); assert.equal(new Set(x.selections).size,3); assert.equal(x.selections.includes(9),false);
 }
}
assert.deepEqual(substituteTrioLeg({selections:[9,10,1],withdrawals:[9,10],favourites:[1,2,3],favouriteSource:'official'}).selections,[1,2,3]);
assert.deepEqual(substituteTrioLeg({selections:[9,10,2],withdrawals:[9,10,11],favourites:[1,2,3],favouriteSource:'official'}).selections,[2,1,3]);
assert.deepEqual(substituteTrioLeg({selections:[9,10,11],withdrawals:[9,10,11],favourites:[1,2,3],favouriteSource:'official'}).selections,[1,2,3]);
assert.equal(substituteTrioLeg({selections:[9,1,2],withdrawals:[9]}).status,'pending-official-favourites');
const legs=[{selections:[9,1,2],withdrawals:[9],favourites:[1,2,3],favouriteSource:'official'},{selections:[4,5,6],withdrawals:[]}];
const dt=settleCrossTrioTicket('DT',legs,[{legs:[[1,2,3],[4,5,6]],div:500}]); assert.equal(dt.refund,0); assert.equal(dt.payout,500);
assert.equal(settleCrossTrioTicket('TT',[...legs,{selections:[7,8,12],withdrawals:[]}],null).net,null);
console.log('Withdrawal accounting concrete rule assertions passed');
