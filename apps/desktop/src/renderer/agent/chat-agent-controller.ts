import type {SessionTurn} from '../../shared/agent/chat-sessions';
import type {ChatTurnActivity,ChatTurnExecution,ChatTurnPhase,ChatTurnPart} from '../../shared/agent/chat-turns';
import type {ChatDraft} from '../../shared/agent/chat-drafts';

export function restoreBlockedChatDraft(draft:ChatDraft|undefined,turn:SessionTurn):ChatDraft{
 if(draft&&(draft.text||draft.images.length||draft.files.length||draft.schematics?.length))return draft;
 return {text:turn.user,revision:(draft?.revision??0)+1,images:structuredClone(turn.images??[]),files:structuredClone(turn.files??[]),...(turn.schematics?{schematics:structuredClone(turn.schematics)}:{})};
}

export const chatPhaseLabels:Record<ChatTurnPhase,string>={accepted:'已接收',preparing:'正在准备',running:'正在处理',waiting_question:'等待你的回答',needs_configuration:'需要配置',needs_review:'需要核对',stopping:'正在停止',completed:'已完成',failed:'执行失败',cancelled:'已停止',interrupted:'已中断'};
export const chatTurnActive=(execution:ChatTurnExecution)=>['accepted','preparing','running','waiting_question','stopping'].includes(execution.phase)||execution.cleanupState==='pending';
export function chatExecutionLabel(execution:ChatTurnExecution){
 if(execution.cleanupState==='failed')return '执行收尾尚未确认';
 if(execution.phase==='stopping')return '正在停止，等待执行收尾';
 if(execution.cleanupState==='pending')return '正在核对执行收尾';
 return chatPhaseLabels[execution.phase];
}
const identity=(execution:ChatTurnExecution)=>JSON.stringify([execution.executionId,execution.requestDigest,execution.acceptedContext,execution.parentTurnId]);
export type ChatActivityEntry={activity:ChatTurnActivity|null;error:string|null;reading:boolean};
export type ChatActivityState={sessionId:string;entries:Readonly<Record<string,ChatActivityEntry>>};
type ReadPort=(sessionId:string,turnId:string,afterSequence:number)=>Promise<ChatTurnActivity>;
type Clock={set:(fn:()=>void,ms:number)=>unknown;clear:(handle:unknown)=>void};

/** Immutable pages, not snapshots to concatenate blindly. Repeated pages are idempotent. */
export function mergeChatActivity(previous:ChatTurnActivity|null,page:ChatTurnActivity,sessionId:string,turn:Pick<SessionTurn,'id'|'execution'>):ChatTurnActivity{
 if(page.sessionId!==sessionId||page.turnId!==turn.id||!turn.execution||!page.execution||identity(page.execution)!==identity(turn.execution))throw Error('Chat activity identity mismatch');
 if(previous&&(!previous.execution||identity(previous.execution)!==identity(page.execution)))throw Error('Execution changed');
 if(previous&&page.version<previous.version)return previous;
 const oldLink=previous?.execution?.runLink??turn.execution.runLink,link=page.execution.runLink;
 if(oldLink&&(!link||oldLink.runId!==link.runId||oldLink.workspaceId!==null&&oldLink.workspaceId!==link.workspaceId))throw Error('Run link changed');
 if(page.run&&(page.run.runId!==link?.runId||page.run.project.projectId!==page.execution.acceptedContext.projectId||page.run.model.provider!==page.execution.acceptedContext.provider||page.run.model.model!==page.execution.acceptedContext.model||((page.run.workCycle?.workspaceId??null)!==link?.workspaceId)))throw Error('Run scope mismatch');
 if(page.run){const origin=page.run.origin;if(!origin||origin.chatSessionId!==sessionId||origin.turnId!==turn.id||origin.executionId!==page.execution.executionId||origin.inputDigest!==page.execution.requestDigest)throw Error('Run origin mismatch');}
 const parts:ChatTurnPart[]=[...(previous?.parts??[])],ids=new Map(parts.map(part=>[part.partId,part]));
 for(const part of page.parts){
  const known=ids.get(part.partId);
  if(known){if(JSON.stringify(known)!==JSON.stringify(part))throw Error('Part changed');continue;}
  if(part.sequence!==(parts.at(-1)?.sequence??0)+1)throw Error('Part sequence gap');
  if(part.kind==='run_event'&&(part.runId!==link?.runId||part.event.runId!==part.runId))throw Error('Event belongs to another run');
  parts.push(part);ids.set(part.partId,part);
 }
 if(page.nextSequence!==(parts.at(-1)?.sequence??0))throw Error('Page cursor mismatch');
 return {...page,parts};
}

/** Read-only mounting and polling. No send, answer, stop, launch or replay port exists. */
export function createChatAgentController(read:ReadPort,clock:Clock={set:(fn,ms)=>setTimeout(fn,ms),clear:h=>clearTimeout(h as ReturnType<typeof setTimeout>)}){
 let state:ChatActivityState={sessionId:'',entries:{}},turns:readonly SessionTurn[]=[],epoch=0,disposed=false,busy=false,timer:unknown=null;
 const listeners=new Set<()=>void>(),checked=new Map<string,number>();
 const publish=(entries:ChatActivityState['entries'])=>{state={...state,entries};listeners.forEach(fn=>fn());};
 const cancelTimer=()=>{if(timer!==null){clock.clear(timer);timer=null;}};
 const unread=(turn:SessionTurn)=>!!turn.execution&&(!!state.entries[turn.id]?.activity?.hasMore||(checked.get(turn.id)??0)<turn.execution.version);
 const pending=()=>turns.filter(turn=>turn.execution&&!state.entries[turn.id]?.error&&(unread(turn)||chatTurnActive(turn.execution)));
 const schedule=()=>{cancelTimer();const candidates=pending();if(disposed||busy||!candidates.length)return;timer=clock.set(()=>{timer=null;void poll();},candidates.some(unread)?10:500);};
 async function poll(){
  if(disposed||busy)return;const turn=pending().sort((a,b)=>Number(unread(b))-Number(unread(a))||Number(chatTurnActive(b.execution!))-Number(chatTurnActive(a.execution!)))[0];if(!turn)return;
  const currentEpoch=epoch,sessionId=state.sessionId,previous=state.entries[turn.id]?.activity??null;busy=true;
  publish({...state.entries,[turn.id]:{activity:previous,error:null,reading:true}});
  try{const page=await read(sessionId,turn.id,previous?.nextSequence??0);if(disposed||epoch!==currentEpoch)return;
   if(page.hasMore&&page.nextSequence<=(previous?.nextSequence??0))throw Error('Page made no progress');
   const activity=mergeChatActivity(previous,page,sessionId,turn);
   checked.set(turn.id,page.execution!.version);publish({...state.entries,[turn.id]:{activity,error:null,reading:false}});
  }catch{if(!disposed&&epoch===currentEpoch)publish({...state.entries,[turn.id]:{activity:previous,error:'过程记录暂时无法核对，已保留收到的内容。',reading:false}});}
  finally{busy=false;if(!disposed)schedule();}
 }
 return {snapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  setSession:(sessionId:string,next:readonly SessionTurn[])=>{
   if(disposed)return;if(sessionId!==state.sessionId){epoch++;cancelTimer();checked.clear();state={sessionId,entries:{}};listeners.forEach(fn=>fn());}
   turns=next;schedule();
  },
  retry:(turnId:string)=>{if(!turns.some(turn=>turn.id===turnId&&turn.execution))return;checked.delete(turnId);const entry=state.entries[turnId];publish({...state.entries,[turnId]:{activity:entry?.activity??null,error:null,reading:false}});schedule();},
  dispose:()=>{disposed=true;epoch++;cancelTimer();listeners.clear();},
 };
}
