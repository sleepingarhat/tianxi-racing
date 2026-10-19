import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseHkjcChangesPage,type HkjcChangesPage} from '../../src/lib/hkjc-changes';
/** Explicit source manifest, never infer withdrawal from DNF/PU/UR. */
export function readChangesManifest(path:string):HkjcChangesPage[] {
 if(!path)throw new Error('official-change-manifest-required');
 const body=JSON.parse(readFileSync(path,'utf8'));
 if(!Array.isArray(body.snapshots)||!body.snapshots.length)throw new Error('official-change-manifest-required');
 const pages=body.snapshots.map((s:any)=>{
  const p=typeof s.rawHtml==='string'?parseHkjcChangesPage(s.rawHtml):null;
  if(createHash('sha256').update(s.rawHtml??'').digest('hex')!==s.sha256)throw new Error('training-change-sha-mismatch');
  if(!p||!s.sha256||!s.sourceUrl?.startsWith('https://racing.hkjc.com/'))throw new Error('unverified-training-change-source');
  return p;
 });
 const merged=new Map<string,HkjcChangesPage>();
 for(const page of pages){const key=page.date+':'+page.venue;const old=merged.get(key);merged.set(key,old?{...page,changes:[...old.changes,...page.changes]}:page);}
 return [...merged.values()];
}
