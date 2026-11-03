import {createAtomicJsonStore} from './session-store';
import {DRAFT_DISK_LIMIT,emptyDraftDisk,parseDraftDisk,parseDraftRead,parseDraftSave,draftFailure,type DraftDisk,type DraftReadResult,type DraftSaveResult} from '../../shared/agent/chat-drafts';
import type {ImageAttachment} from '../../shared/agent/image-attachment';
export type DraftStore={load:()=>DraftDisk;save:(state:DraftDisk)=>void};
export const createDraftStore=(root:string,directory:string):DraftStore=>createAtomicJsonStore(root,directory,'drafts.json',parseDraftDisk,DRAFT_DISK_LIMIT,emptyDraftDisk);
export function createDraftHost(store:DraftStore,validateImages?:(images:ImageAttachment[])=>void){
 let state:DraftDisk|undefined,failed=false,revoked=false;
 const validate=(disk:DraftDisk)=>{for(const record of disk.records){validateImages?.(record.draft.images);if(record.pending)validateImages?.(record.pending.submitted.images);}};
 try{state=parseDraftDisk(store.load());validate(state);}catch{failed=true;}
 return {
  read(value:unknown,allowed:boolean):DraftReadResult{if(revoked||!allowed)return draftFailure('CAPABILITY_DENIED');if(failed||!state)return draftFailure('STORAGE_ERROR');try{parseDraftRead(value);return {ok:true,value:parseDraftDisk(state)};}catch{return draftFailure('INVALID_REQUEST');}},
  save(value:unknown,allowed:boolean):DraftSaveResult{
   if(revoked||!allowed)return draftFailure('CAPABILITY_DENIED');if(failed||!state)return draftFailure('STORAGE_ERROR');
   try{const request=parseDraftSave(value);if(request.expectedRevision!==state.revision)return draftFailure('CONFLICT');
    let next:DraftDisk;try{next=parseDraftDisk({version:2,revision:state.revision+1,records:[...state.records.filter(r=>r.sessionId!==request.sessionId),...(request.record?[request.record]:[])]});}catch{return draftFailure('LIMIT');}validate(next);
    try{store.save(next);}catch{failed=true;return draftFailure('STORAGE_ERROR');}state=next;return {ok:true,revision:next.revision};
   }catch{return draftFailure('INVALID_REQUEST');}
  },revoke(){revoked=true;state=undefined;},
 };
}
