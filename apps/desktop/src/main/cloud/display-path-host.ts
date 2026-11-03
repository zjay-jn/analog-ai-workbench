import {createAtomicJsonStore} from './session-store';
import {DISPLAY_PATH_LIMIT,emptyDisplayPaths,parseDisplayPathDisk,parseDisplayPathRead,parseDisplayPathRemember,parseDisplayPathResult,displayPathFailure,type DisplayPathDisk,type DisplayPathResult} from '../../shared/agent/display-paths';
export type DisplayPathStore={load:()=>DisplayPathDisk;save:(state:DisplayPathDisk)=>void};
export const createDisplayPathStore=(root:string,directory:string):DisplayPathStore=>createAtomicJsonStore(root,directory,'paths.json',parseDisplayPathDisk,DISPLAY_PATH_LIMIT,emptyDisplayPaths);
export function createDisplayPathHost(store:DisplayPathStore){
 let state:DisplayPathDisk|undefined,failed=false,revoked=false;
 try{state=parseDisplayPathDisk(store.load());}catch{failed=true;}
 return {
  invoke(method:'read'|'remember',value:unknown,allowed:boolean):DisplayPathResult{
   if(revoked||!allowed)return displayPathFailure('CAPABILITY_DENIED');
   if(failed||!state)return displayPathFailure('STORAGE_ERROR');
   try{
    if(method==='read'){const request=parseDisplayPathRead(value);return parseDisplayPathResult({ok:true,records:state.records.filter(r=>request.ids.includes(r.id))});}
    const {record}=parseDisplayPathRemember(value),existing=state.records.find(r=>r.id===record.id);
    if(existing)return JSON.stringify(existing)===JSON.stringify(record)?parseDisplayPathResult({ok:true,records:[existing]}):displayPathFailure('CONFLICT');
    let next:DisplayPathDisk;try{next=parseDisplayPathDisk({version:1,records:[...state.records,record]});}catch{return displayPathFailure('LIMIT');}
    try{store.save(next);}catch{failed=true;return displayPathFailure('STORAGE_ERROR');}
    state=next;return parseDisplayPathResult({ok:true,records:[record]});
   }catch{return displayPathFailure('INVALID_REQUEST');}
  },
  revoke(){revoked=true;state=undefined;},
 };
}
