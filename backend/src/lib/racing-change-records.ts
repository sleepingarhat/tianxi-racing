import { officialWithdrawal,type HkjcChangesPage } from './hkjc-changes';
/** Append-only event projection; actual jockey/result fields are never overwritten. */
export function runnerChangeRecord(page:HkjcChangesPage,raceNumber:number,horseNumber:number,nameCh:string,lockAt:string|null) {
 const withdrawal=officialWithdrawal(page.changes,raceNumber,horseNumber,nameCh);
 const changes=page.changes.filter(c=>c.raceNumber===raceNumber&&c.horseNumber===horseNumber&&c.horseName===nameCh);
 const locked=Date.parse(lockAt??'');
 const postLockJockeyChange=changes.some(c=>c.kind==='other'&&/騎師|策騎/.test(c.text)&&Number.isFinite(locked)&&Date.parse(c.announcedAtIso??'')>locked);
 return {date:page.date,venue:page.venue,raceNumber,horseNumber,nameCh,withdrawn:!!withdrawal,started:withdrawal?false:null,trainingEligible:withdrawal?false:null,hasWithdrawal:page.changes.some(c=>c.raceNumber===raceNumber&&(c.kind==='scratched'||c.kind==='replaced')),postLockJockeyChange,changes};
}
export function assertChangeResultConsistent(withdrawn:boolean,position:number|null) {
 if(withdrawn&&position!==null&&position>0&&position<99)throw new Error('withdrawn-runner-has-finish-position');
}
