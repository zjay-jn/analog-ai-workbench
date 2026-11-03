import {DRAFT_VERSION,emptyDraft,parseDraftReadResult,parseDraftSaveResult,submittedTurnMatches,type ChatDraft,type DraftRecord,type WorkbenchDraftsApi} from '../../shared/agent/chat-drafts';
import type {SessionState} from '../../shared/agent/chat-sessions';import {acceptFileDraft} from './file-draft';
type Snapshot={records:Record<string,DraftRecord>;status:'loading'|'saving'|'saved'|'memory'|'error';error:string};
export function createDraftController(api?:WorkbenchDraftsApi){
 let snapshot:Snapshot={records:{},status:'loading',error:''},revision=0,fatal=false,loading:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<boolean>|undefined;
 let sessionRevision=-1;
 const listeners=new Set<()=>void>(),dirty=new Set<string>(),sending=new Set<string>();
 const clearing=new Map<string,{original:DraftRecord|null}>();
 const emit=(next:Snapshot)=>{snapshot=next;for(const fn of listeners)fn();};
 const notify=()=>emit({...snapshot,status:api?(dirty.size?'saving':'saved'):'memory',error:''});
 const fail=(permanent:boolean)=>{fatal=permanent;emit({...snapshot,status:'error',error:permanent?'草稿未能保存，写入已暂停。请先复制重要输入，再重新打开软件。':'草稿未能保存，请缩短文字或减少附件。当前输入仍保留。'});};
 const schedule=()=>{if(!timer&&!fatal)timer=setTimeout(()=>{timer=undefined;void flush();},350);};
 function setRecord(id:string,record:DraftRecord|null){const records={...snapshot.records};if(record)records[id]=record;else delete records[id];dirty.add(id);emit({...snapshot,records,status:fatal?'error':api?'saving':'memory',error:fatal?snapshot.error:''});schedule();}
 function flush():Promise<boolean>{
  if(timer){clearTimeout(timer);timer=undefined;}if(fatal||snapshot.status==='loading')return Promise.resolve(false);if(running)return running.then(ok=>ok?flush():false);
  running=(async()=>{while(dirty.size){const id=dirty.values().next().value!,clear=clearing.get(id),record=clear?null:snapshot.records[id]??null;
   if(api)try{const result=parseDraftSaveResult(await api.save({contractVersion:DRAFT_VERSION,expectedRevision:revision,sessionId:id,record}));
    if(!result.ok){fail(result.error.code==='STORAGE_ERROR'||result.error.code==='CONFLICT'||result.error.code==='CAPABILITY_DENIED');return false;}
    if(result.revision!==revision+1){fail(true);return false;}revision=result.revision;
   }catch{fail(true);return false;}
   if(clear){
    clearing.delete(id);
    // Publish deletion only after its ACK. Edits made while waiting retain their full contents.
    if((snapshot.records[id]??null)===clear.original){const records={...snapshot.records};delete records[id];emit({...snapshot,records});}
   }
   // A clear queued behind an earlier save must still reach main, even if that save matched.
   if(!clearing.has(id)&&(snapshot.records[id]??null)===record)dirty.delete(id);
  }notify();return true;})().finally(()=>{running=undefined;});return running;
 }
 return {
  snapshot:()=>snapshot,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  start(){return loading??=(async()=>{if(!api){emit({records:{},status:'memory',error:''});return;}try{const r=parseDraftReadResult(await api.read({contractVersion:DRAFT_VERSION}));if(!r.ok){fail(true);return;}revision=r.value.revision;emit({records:Object.fromEntries(r.value.records.map(record=>[record.sessionId,record])),status:'saved',error:''});}catch{fail(true);}})();},
  change(update:(drafts:Record<string,ChatDraft>)=>Record<string,ChatDraft>){if(snapshot.status==='loading')return;const before=Object.fromEntries(Object.entries(snapshot.records).map(([id,r])=>[id,r.draft])),next=update(before);
   for(const id of new Set([...Object.keys(before),...Object.keys(next)])){if(before[id]===next[id])continue;const old=snapshot.records[id];if(next[id])setRecord(id,{sessionId:id,draft:next[id]!,pending:old?.pending??null});else setRecord(id,null);}
  },
  flush,
  async beginSend(id:string,requestId:string,submitted:ChatDraft){if(sending.has(id)||clearing.has(id)||snapshot.records[id]?.pending||fatal)return false;sending.add(id);const current=snapshot.records[id]?.draft??submitted;setRecord(id,{sessionId:id,draft:current,pending:{requestId,submitted}});const ok=await flush();if(!ok)sending.delete(id);return ok;},
  async finishSend(id:string,accepted:boolean,known=true){const record=snapshot.records[id];if(record?.pending){if(known){setRecord(id,{...record,draft:accepted?acceptFileDraft(record.draft,record.pending.submitted):record.draft,pending:null});}}sending.delete(id);return known?flush():false;},
  reconcile(state:SessionState){if(state.storage==='error'||state.revision<sessionRevision)return;sessionRevision=state.revision;if(snapshot.status==='loading'||fatal)return;
   const ids=new Set(state.sessions.map(s=>s.id));for(const [id,record] of Object.entries(snapshot.records)){if(sending.has(id)||clearing.has(id))continue;if(!ids.has(id)){setRecord(id,null);continue;}
    if(!record.pending||state.selected?.id!==id)continue;const turn=state.selected.turns.find(t=>t.id===record.pending!.requestId);
    if(turn&&!submittedTurnMatches(turn,record.pending.submitted)){emit({...snapshot,status:'error',error:'草稿发送记录与聊天内容不一致，已保留输入，请核对后再操作。'});continue;}
    setRecord(id,{...record,draft:turn?acceptFileDraft(record.draft,record.pending.submitted):record.draft,pending:null});
   }
  },
  async clear(id:string){
   if(sending.has(id)||clearing.has(id)||snapshot.records[id]?.pending||fatal||snapshot.status==='loading')return false;
   const request={original:snapshot.records[id]??null};clearing.set(id,request);dirty.add(id);notify();
   try{return await flush();}finally{if(clearing.get(id)===request)clearing.delete(id);}
  },
  hasPending:(id:string)=>!!snapshot.records[id]?.pending,
  dispose(){if(timer)clearTimeout(timer);timer=undefined;},
 };
}
