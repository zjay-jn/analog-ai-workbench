import {isDeepStrictEqual} from 'node:util';
import type {ProjectReadRun,ProjectReadSummary} from '../../shared/agent/agent-project-read';
import {CHAT_TURN_ACTIVITY_BYTES,CHAT_TURN_ACTIVITY_PAGE,parseChatTurnExecution,type ChatTurnActivity,type ChatTurnExecution,type ChatTurnPart} from '../../shared/agent/chat-turns';
import {parseChatTurnActivity} from '../../shared/agent/chat-turn-activity';
import type {SessionTurn} from '../../shared/agent/chat-sessions';
import {splitCloudDeltaV2} from './cloud-budget';
import {ProjectReadFsError} from './project-read-files';

/** The ledger can only read already loaded records. It has no execution or storage capability. */
export type ChatTurnRunLookup=Readonly<{
  chatRun(id:string):ProjectReadRun|null;
  chatRuns():readonly ProjectReadRun[];
}>;
const conflict=():never=>{throw new ProjectReadFsError('CONFLICT');};
const terminal=(phase:ChatTurnExecution['phase'])=>['completed','failed','cancelled','interrupted','needs_configuration','needs_review'].includes(phase);
const runTerminal=(run:ProjectReadRun)=>['completed','failed','stopped','interrupted'].includes(run.status);
const summary=(run:ProjectReadRun):ProjectReadSummary=>{const {events:_,...value}=run;return value;};

/** adopt is reserved for cold two-store reconciliation, never ordinary activity reads. */
export function readChatTurnRun(lookup:ChatTurnRunLookup,sessionId:string,turn:SessionTurn,adopt=false):ProjectReadRun|null{
  const execution=turn.execution;if(!execution)return null;
  const candidates=lookup.chatRuns().filter(run=>run.origin?.executionId===execution.executionId||run.origin?.chatSessionId===sessionId&&run.origin.turnId===turn.id);
  if(candidates.length>1)return conflict();
  const run=execution.runLink?lookup.chatRun(execution.runLink.runId):candidates[0]??null;
  if(!run){if(execution.runLink)return conflict();return null;}
  const context=execution.acceptedContext,origin={chatSessionId:sessionId,turnId:turn.id,executionId:execution.executionId,inputDigest:execution.requestDigest};
  const lateWork=adopt&&execution.readOnlyScope===true&&execution.runLink?.workspaceId===null&&context.bindingId!==null&&run.events.some(e=>e.type==='work.prepared'&&e.data.workCycle.workspaceId===run.workCycle?.workspaceId);
  if(candidates.length!==1||!isDeepStrictEqual(candidates[0],run)||!isDeepStrictEqual(run.origin,origin)
    ||run.project.projectId!==context.projectId||run.project.bindingId!==context.bindingId||run.project.identity!==context.bindingIdentity
    ||run.model.provider!==context.provider||run.model.model!==context.model
    ||execution.runLink&&(execution.runLink.runId!==run.runId||execution.runLink.workspaceId!==(run.workCycle?.workspaceId??null)&&!lateWork))return conflict();
  if(run.project.bindingId===null&&(run.workCycle||!run.origin)||execution.readOnlyScope&&run.workCycle&&!lateWork)return conflict();
  if(run.eventCount!==run.events.length||run.events.some((event,index)=>event.runId!==run.runId||event.sequence!==index+1))return conflict();
  return execution.runLink||adopt?run:null;
}

/** Stable public pages: bound turns expose only original ledger events, never duplicate text. */
export function buildChatTurnActivity(lookup:ChatTurnRunLookup,sessionId:string,turn:SessionTurn,afterSequence:number):ChatTurnActivity{
  const execution=turn.execution??null,run=readChatTurnRun(lookup,sessionId,turn);
  const complete=execution?terminal(execution.phase):turn.status!=='running';
  const all:ChatTurnPart[]=run?run.events.map(event=>({kind:'run_event',partId:'run_'+event.runId+'_'+event.sequence,sequence:event.sequence,runId:event.runId,event}))
    :complete?splitCloudDeltaV2(turn.assistant).map((text,index)=>({kind:'text',partId:'text_'+turn.id+'_'+(index+1),sequence:index+1,text})):[];
  if(!Number.isSafeInteger(afterSequence)||Object.is(afterSequence,-0)||afterSequence<0||afterSequence>all.length)return conflict();
  const base={sessionId,turnId:turn.id,version:(execution?.version??0)+(run?.eventCount??0),execution,run:run?summary(run):null};
  const parts:ChatTurnPart[]=[];
  for(const part of all.slice(afterSequence,afterSequence+CHAT_TURN_ACTIVITY_PAGE)){
    if(Buffer.byteLength(JSON.stringify({...base,parts:[...parts,part],nextSequence:part.sequence,hasMore:true}))>CHAT_TURN_ACTIVITY_BYTES)break;
    parts.push(part);
  }
  const nextSequence=parts.at(-1)?.sequence??afterSequence;
  if(!parts.length&&nextSequence<all.length)throw new ProjectReadFsError('BUDGET_EXCEEDED');
  return parseChatTurnActivity({...base,parts,nextSequence,hasMore:nextSequence<all.length});
}

/** Recover durable associations and a missing text suffix without restarting any work. */
export function reconcileChatTurn(lookup:ChatTurnRunLookup,sessionId:string,turn:SessionTurn):ChatTurnExecution{
  const execution=turn.execution;if(!execution)return conflict();
  const run=readChatTurnRun(lookup,sessionId,turn,true);
  if(!run){
    if(terminal(execution.phase))return execution.cleanupState==='pending'
      ?parseChatTurnExecution({...execution,version:execution.version+1,cleanupState:'failed'}):execution;
    return parseChatTurnExecution({...execution,version:execution.version+1,phase:'interrupted',cleanupState:execution.phase==='accepted'?'idle':'failed',pendingInteraction:null});
  }
  const text=run.events.flatMap(event=>event.type==='message.delta'?[event.data.text]:[]).join('');
  // A divergent cache is not an authoritative answer. Do not mark it completed or overwrite it.
  if(!text.startsWith(turn.assistant))return conflict();
  const held=runTerminal(run)&&(execution.phase==='needs_configuration'&&execution.pendingInteraction?.kind==='configuration'
    ||execution.phase==='needs_review'&&execution.pendingInteraction?.kind==='permission');
  const question=execution.pendingInteraction?.kind==='question';
  const phase:ChatTurnExecution['phase']=held?execution.phase:question?'interrupted'
    :run.status==='completed'&&text.trim()?'completed':run.status==='stopped'?'cancelled':run.status==='failed'?'failed':'interrupted';
  const next:ChatTurnExecution={...execution,phase,cleanupState:run.cleanupState,
    runLink:{runId:run.runId,workspaceId:run.workCycle?.workspaceId??null},pendingInteraction:held?execution.pendingInteraction:null};
  if(run.workCycle)delete next.readOnlyScope;else if(run.origin)next.readOnlyScope=true;
  if(!isDeepStrictEqual(execution,next))next.version=execution.version+1;
  const parsed=parseChatTurnExecution(next);
  turn.assistant=text;
  return isDeepStrictEqual(execution,parsed)?execution:parsed;
}
