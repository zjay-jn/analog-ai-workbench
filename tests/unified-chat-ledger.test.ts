import test from 'node:test';
import assert from 'node:assert/strict';
import {readChatTurnRun,buildChatTurnActivity,reconcileChatTurn,type ChatTurnRunLookup} from '../apps/desktop/src/main/cloud/unified-chat-ledger';
import {PROJECT_READ_LIMITS as L,type ProjectReadRun,type ProjectReadEvent,type ProjectReadEventData} from '../apps/desktop/src/shared/agent/agent-project-read';
import {CHAT_TURN_ACTIVITY_BYTES,CHAT_TURN_ACTIVITY_PAGE,parseChatTurnExecution,type ChatTurnExecution,type ChatTurnInteraction} from '../apps/desktop/src/shared/agent/chat-turns';
import {parseChatTurnActivity} from '../apps/desktop/src/shared/agent/chat-turn-activity';
import {parseSessionDisk,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';

// Author tests for the pure ledger extraction. These are not an independent
// review, two-store commit integration, or a native/product execution proof.
const SESSION='10000000-0000-4000-8000-000000000001',TURN='10000000-0000-4000-8000-000000000002',PROJECT='10000000-0000-4000-8000-000000000003';
const TIME='2026-09-16T00:00:00.000Z',HASH='a'.repeat(64);
const project={projectId:PROJECT,bindingId:'binding-ledger',name:'Synthetic',directoryName:'Ledger',directorySegments:['Q','Synthetic','Ledger'],identity:HASH};
const model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const origin={chatSessionId:SESSION,turnId:TURN,executionId:'execution-ledger',inputDigest:HASH};
const budget={providerAttempts:L.requests,httpDispatches:L.requests,toolAttempts:L.toolCalls,physicalReadBytes:L.runReadBytes,visitedCandidates:L.runCandidates,contextBytes:L.contextBytes,outputBytes:256*1024,maxOutputTokens:L.maxOutputTokens,deadlineMs:L.deadlineMs,waitMs:L.waitMs};
type DataEvent={ [K in keyof ProjectReadEventData]:{type:K;data:ProjectReadEventData[K]} }[keyof ProjectReadEventData];
function makeRun(texts=['durable ledger answer']):ProjectReadRun{
  const data:DataEvent[]=[{type:'run.accepted',data:{project,model,origin,continuedFrom:null,budget}},
    {type:'run.started',data:{sessionId:'native-ledger',engine:'opencode',version:'1.18.17'}},{type:'model.step',data:{step:1}},
    ...texts.map(text=>({type:'message.delta',data:{messageId:'message-ledger',step:1,text}} as const)),
    {type:'cleanup.started',data:{reason:'completed'}},{type:'cleanup.completed',data:{outcome:'confirmed'}},{type:'run.completed',data:{citations:[]}}];
  const events=data.map((event,index)=>({...event,runId:'run-ledger',sequence:index+1,time:TIME})) as ProjectReadEvent[];
  return {runId:'run-ledger',clientRequestId:'client-ledger',project,model,goal:'Synthetic ledger fixture',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:TIME,updatedAt:TIME,
    accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:events.length,continuation:null,origin,events};
}
function makeTurn(run:ProjectReadRun|null=null):SessionTurn{
  return {id:TURN,user:'Synthetic ledger question',assistant:'',status:'running',error:'',...model,
    execution:parseChatTurnExecution({executionId:origin.executionId,version:1,requestDigest:HASH,
      acceptedContext:{projectId:PROJECT,workspaceRevision:3,bindingId:project.bindingId,bindingIdentity:HASH,...model,historyVersion:HASH},
      phase:'accepted',cleanupState:'idle',runLink:run?{runId:run.runId,workspaceId:run.workCycle?.workspaceId??null}:null,parentTurnId:null,pendingInteraction:null})};
}
function lookup(runs:readonly ProjectReadRun[]):ChatTurnRunLookup{return {chatRuns:()=>runs,chatRun:id=>runs.find(run=>run.runId===id)??null};}
function noExecutionLookup():ChatTurnRunLookup{return new Proxy(lookup([]),{get(target,key,receiver){assert(key==='chatRun'||key==='chatRuns');return Reflect.get(target,key,receiver);}});}
const conflicts=(run:()=>unknown)=>assert.throws(run,(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='CONFLICT');

test('ledger adopts one exact durable run after the chat-link commit gap, without executing',()=>{
  const run=makeRun(),turn=makeTurn(),records=lookup([run]),before=structuredClone(run);
  assert.equal(readChatTurnRun(records,SESSION,turn),null);
  assert.equal(readChatTurnRun(records,SESSION,turn,true),run);
  const recovered=reconcileChatTurn(records,SESSION,turn);
  assert.deepEqual(recovered.runLink,{runId:run.runId,workspaceId:null});assert.equal(recovered.phase,'completed');assert.equal(recovered.cleanupState,'idle');assert.equal(recovered.version,2);
  assert.equal(turn.assistant,'durable ledger answer');assert.equal(turn.execution!.runLink,null,'caller owns committing the recovered execution');assert.deepEqual(run,before);
  turn.execution=recovered;assert.equal(reconcileChatTurn(records,SESSION,turn),recovered,'unchanged reconciliation must not bump the version');
});

test('ledger rejects a changed association, project/model scope, workspace, or inconsistent lookup',()=>{
  const run=makeRun(),turn=makeTurn(run);
  const wrong:ProjectReadRun[]=[{...run,origin:{...origin,inputDigest:'b'.repeat(64)}},{...run,project:{...project,projectId:TURN}},
    {...run,project:{...project,bindingId:'other-binding'}},{...run,project:{...project,identity:'b'.repeat(64)}},
    {...run,model:{provider:'kimi',model:'kimi-k3'}},{...run,workCycle:{workspaceId:'unexpected-workspace'}}];
  for(const other of wrong)conflicts(()=>readChatTurnRun(lookup([other]),SESSION,turn));
  conflicts(()=>readChatTurnRun({chatRuns:()=>[run],chatRun:()=>({...run,goal:'different record'})},SESSION,turn));
  const linked={...run,workCycle:{workspaceId:'work-ledger'}},bound=makeTurn(linked);
  conflicts(()=>readChatTurnRun(lookup([{...linked,workCycle:{workspaceId:'work-other'}}]),SESSION,bound));
});

test('ledger never invents a missing link or picks between duplicate origins',()=>{
  const turn=makeTurn(),empty=noExecutionLookup();assert.equal(readChatTurnRun(empty,SESSION,turn,true),null);
  const interrupted=reconcileChatTurn(empty,SESSION,turn);assert.equal(interrupted.phase,'interrupted');assert.equal(interrupted.cleanupState,'idle');assert.equal(interrupted.runLink,null);
  const run=makeRun();conflicts(()=>readChatTurnRun(empty,SESSION,makeTurn(run),true));
  conflicts(()=>readChatTurnRun(lookup([run,{...run,runId:'run-duplicate'}]),SESSION,turn,true));
  conflicts(()=>readChatTurnRun(lookup([run,{...run,runId:'run-other-execution',origin:{...origin,executionId:'other-execution'}}]),SESSION,turn,true));
});

test('ledger preserves durable configuration and review cards when a matching tool run has ended',()=>{
  const cards:ChatTurnInteraction[]=[{kind:'configuration',interactionId:'config-ledger',required:'command_environment',action:'review_environment',message:'Select a command environment'},
    {kind:'permission',interactionId:'permission-ledger',permissionRequestId:'permission-request-ledger',operation:'continue_verified_work',sourceRunId:'parent-ledger',recoveryVersion:HASH,message:'Review the confirmed parent work'}];
  for(const card of cards){
    const run={...makeRun(),status:'failed' as const},turn=makeTurn();
    turn.execution={...turn.execution!,phase:card.kind==='configuration'?'needs_configuration':'needs_review',cleanupState:'pending',pendingInteraction:card};
    const result=reconcileChatTurn(lookup([run]),SESSION,turn);assert.equal(result.phase,turn.execution.phase);assert.deepEqual(result.pendingInteraction,card);assert.equal(result.cleanupState,'idle');assert.equal(result.runLink!.runId,run.runId);
  }
});

test('ledger converts orphaned pending cleanup to unknown failure while retaining the actionable card',()=>{
  const turn=makeTurn(),card={kind:'configuration',interactionId:'config-no-run',required:'project_directory',action:'select_project',message:'Choose a project directory'} as const;
  turn.execution={...turn.execution!,phase:'needs_configuration',cleanupState:'pending',pendingInteraction:card};
  const recovered=reconcileChatTurn(noExecutionLookup(),SESSION,turn);
  assert.equal(recovered.phase,'needs_configuration');assert.equal(recovered.cleanupState,'failed');assert.equal(recovered.version,turn.execution.version+1);assert.deepEqual(recovered.pendingInteraction,card);assert.equal(recovered.runLink,null);
  turn.execution=recovered;assert.equal(reconcileChatTurn(noExecutionLookup(),SESSION,turn),recovered);
});

test('ledger interrupts a submitted question on cold open and retains its receipt without delivery',()=>{
  const turn=makeTurn(),receipt={requestId:'10000000-0000-4000-8000-000000000004',interactionId:'question-ledger',decisionDigest:HASH,resultTurnId:null};
  turn.execution={...turn.execution!,phase:'waiting_question',pendingInteraction:{kind:'question',interactionId:receipt.interactionId,questionId:'native-question',prompt:'Clarify?',state:'submitted'},interactionReceipts:[receipt]};
  for(const records of [noExecutionLookup(),lookup([{...makeRun(),status:'interrupted',cleanupState:'failed'}])]){
    const recovered=reconcileChatTurn(records,SESSION,structuredClone(turn));assert.equal(recovered.phase,'interrupted');assert.equal(recovered.cleanupState,'failed');assert.equal(recovered.pendingInteraction,null);assert.deepEqual(recovered.interactionReceipts,[receipt]);
  }
});

test('ledger pages legacy terminal Unicode text in bounded stable fragments without inventing execution',()=>{
  const disk=parseSessionDisk({version:1,selectedId:SESSION,sessions:[{id:SESSION,title:'Legacy',provider:'deepseek',createdAt:TIME,updatedAt:TIME,turns:[{id:TURN,user:'old question',assistant:'旧🙂"'.repeat(32000),status:'completed',error:''}]}]}),turn=disk.sessions[0]!.turns[0]!,before=structuredClone(turn);
  const forbidden:ChatTurnRunLookup={chatRun:()=>assert.fail('legacy has no run lookup'),chatRuns:()=>assert.fail('legacy has no run lookup')};
  const text:string[]=[];let cursor=0,pages=0;
  for(;;){const page=buildChatTurnActivity(forbidden,SESSION,turn,cursor);assert.deepEqual(parseChatTurnActivity(page),page);assert.equal(page.execution,null);assert.equal(page.run,null);assert(page.parts.length<=CHAT_TURN_ACTIVITY_PAGE);assert(Buffer.byteLength(JSON.stringify(page))<=CHAT_TURN_ACTIVITY_BYTES);
    for(const part of page.parts){assert.equal(part.kind,'text');if(part.kind==='text'){assert(Buffer.byteLength(part.text)<=4096);text.push(part.text);}}
    assert.deepEqual(buildChatTurnActivity(forbidden,SESSION,turn,cursor),page);cursor=page.nextSequence;pages++;if(!page.hasMore)break;
  }
  assert(pages>1);assert.equal(text.join(''),turn.assistant);assert.deepEqual(turn,before);
  assert.equal(buildChatTurnActivity(forbidden,SESSION,{...turn,status:'running'},0).parts.length,0);
  for(const bad of [-1,-0,0.5,cursor+1])conflicts(()=>buildChatTurnActivity(forbidden,SESSION,turn,bad));
});

test('ledger linked activity keeps only original events and respects both page and byte boundaries',()=>{
  for(const texts of [Array.from({length:70},()=> 'part'),Array.from({length:8},()=> '"'.repeat(16250))]){
    const run={...makeRun(texts),goal:'g'.repeat(4096)},turn=makeTurn(run);turn.execution={...turn.execution!,phase:'completed'};turn.status='completed';turn.assistant=texts.join('');
    const records=lookup([run]),events:ProjectReadEvent[]=[];let cursor=0,pages=0;
    for(;;){const page=buildChatTurnActivity(records,SESSION,turn,cursor);assert(page.parts.length<=CHAT_TURN_ACTIVITY_PAGE);assert(Buffer.byteLength(JSON.stringify(page))<=CHAT_TURN_ACTIVITY_BYTES);assert.deepEqual(parseChatTurnActivity(page),page);
      for(const part of page.parts){assert.equal(part.kind,'run_event');if(part.kind==='run_event'){assert.equal(part.sequence,part.event.sequence);events.push(part.event);}}
      if(texts.length===8&&pages===0){assert(page.hasMore);assert(page.parts.length<CHAT_TURN_ACTIVITY_PAGE,'byte limit must stop before the count limit');}
      cursor=page.nextSequence;pages++;if(!page.hasMore)break;
    }
    assert(pages>1);assert.deepEqual(events,run.events);assert.equal(cursor,run.eventCount);
  }
});
