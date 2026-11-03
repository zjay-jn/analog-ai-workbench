import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SESSION_VERSION as V,parseSessionRequest,parseSessionDisk,parseSessionMethodResult,parseSessionResult,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import {parseChatTurnExecution,parseChatRunOrigin,type ChatTurnExecution} from '../apps/desktop/src/shared/agent/chat-turns';
import {parseChatTurnActivity} from '../apps/desktop/src/shared/agent/chat-turn-activity';
import {parseProjectReadDisk,type ProjectReadStoredRun} from '../apps/desktop/src/main/agent-project-read/store';
import {PROJECT_READ_LIMITS as L,type ProjectReadEvent,type ProjectReadSummary} from '../apps/desktop/src/shared/agent/agent-project-read';

const sid='10000000-0000-4000-8000-000000000001',tid='10000000-0000-4000-8000-000000000002',pid='10000000-0000-4000-8000-000000000003',nextId='10000000-0000-4000-8000-000000000004';
const time='2026-09-16T10:00:00.000Z',digest='a'.repeat(64),identity='b'.repeat(64);
const execution=():ChatTurnExecution=>({executionId:'chat_synthetic',version:1,requestDigest:digest,acceptedContext:{projectId:pid,workspaceRevision:0,bindingId:'binding_synthetic',bindingIdentity:identity,provider:'kimi',model:'kimi-k3',historyVersion:'c'.repeat(64)},phase:'completed',cleanupState:'idle',runLink:null,parentTurnId:null,pendingInteraction:null});
const turn=():SessionTurn=>({id:tid,user:'完整问题',assistant:'合成回答',status:'completed',error:'',provider:'kimi',model:'kimi-k3',execution:execution()});
const session=()=>({id:sid,title:'合成会话',provider:'kimi' as const,model:'kimi-k3',createdAt:time,updatedAt:time,turns:[turn()]});
const origin=()=>({chatSessionId:sid,turnId:tid,executionId:'chat_synthetic',inputDigest:digest});
function stored(runId='run_synthetic'):ProjectReadStoredRun{
 const project={projectId:pid,bindingId:'binding_synthetic',name:'Synthetic',directoryName:'Chat-Source',directorySegments:['Q','Synthetic','Chat-Source'],identity};
 const model={provider:'kimi' as const,model:'kimi-k3' as const};
 const budget={providerAttempts:L.requests,httpDispatches:L.requests,toolAttempts:L.toolCalls,physicalReadBytes:L.runReadBytes,visitedCandidates:L.runCandidates,contextBytes:L.contextBytes,outputBytes:L.outputBytes,maxOutputTokens:L.maxOutputTokens,deadlineMs:L.deadlineMs,waitMs:L.waitMs};
 const events=[{type:'run.accepted',data:{project,model,continuedFrom:null,budget,origin:origin()}},{type:'run.started',data:{sessionId:'native_synthetic',engine:'opencode',version:'1.18.17'}},{type:'cleanup.started',data:{reason:'completed'}},{type:'cleanup.completed',data:{outcome:'confirmed'}},{type:'run.completed',data:{citations:[]}}].map((event,i)=>({runId,sequence:i+1,time,...event})) as ProjectReadEvent[];
 return {root:{projectId:pid,bindingId:'binding_synthetic',root:'Q:\\Synthetic\\Chat-Source',chain:[{dev:'1',ino:'1'},{dev:'1',ino:'2'},{dev:'1',ino:'3'}]},citations:[],run:{runId,clientRequestId:'client_'+runId,project,model,goal:'已接受聊天的工具记录',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,eventCount:events.length,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},continuation:null,origin:origin(),events}};
}
function activity(){const {events,...run}=stored().run,e={...execution(),runLink:{runId:run.runId,workspaceId:null}};return {sessionId:sid,turnId:tid,version:1,execution:e,run,parts:events.map(event=>({kind:'run_event' as const,partId:'event_'+event.sequence,sequence:event.sequence,runId:run.runId,event})),nextSequence:events.length,hasMore:false};}

test('compaction provenance survives session storage and rejects malformed receipts',()=>{
 const compaction={version:2,sourceHash:'d'.repeat(64),summaryHash:'e'.repeat(64),coveredResponses:70};
 const saved=session();saved.turns[0]!.execution={...execution(),compaction};
 const disk=parseSessionDisk({version:6,selectedId:sid,sessions:[saved]});
 assert.deepEqual(disk.sessions[0]!.turns[0]!.execution!.compaction,compaction);
 assert.equal(disk.sessions[0]!.turns[0]!.user,'完整问题');
 assert.equal(parseChatTurnExecution(execution()).compaction,undefined);
 for(const invalid of [{...compaction,version:0},{...compaction,sourceHash:'unknown'},{...compaction,coveredResponses:-1},{...compaction,summary:'untrusted replacement'}])assert.throws(()=>parseChatTurnExecution({...execution(),compaction:invalid}));
});

test('unified cancel identifies an exact conversation turn and rejects legacy broad cancellation',()=>{
 assert.deepEqual(parseSessionRequest('cancelReply',{contractVersion:V,sessionId:sid,turnId:tid}),{contractVersion:V,sessionId:sid,turnId:tid});
 assert.throws(()=>parseSessionRequest('cancelReply',{contractVersion:V,sessionId:sid}));
 assert.throws(()=>parseSessionRequest('cancelReply',{contractVersion:V,sessionId:sid,turnId:tid,runId:'guessed'}));
});
test('new admission preserves 16KiB text and explicit follow-up identity without combining text continuation',()=>{
 const value={contractVersion:V,sessionId:sid,requestId:nextId,text:'x'.repeat(16384),followUp:{fromTurnId:tid,expectedTurnVersion:2}};
 assert.equal(parseSessionRequest('sendMessage',value).text.length,16384);
 assert.throws(()=>parseSessionRequest('sendMessage',{...value,text:value.text+'x'}));
 assert.throws(()=>parseSessionRequest('sendMessage',{...value,continueFrom:tid}));
 assert.throws(()=>parseSessionRequest('sendMessage',{...value,followUp:{fromTurnId:tid,expectedTurnVersion:-0}}));
});
test('interaction is a strict data union and getters never run at the IPC boundary',()=>{
 const base={contractVersion:V,sessionId:sid,turnId:tid,interactionId:'question_1',requestId:nextId};
 assert.equal(parseSessionRequest('answerInteraction',{...base,decision:{kind:'question',questionId:'native_question',answer:'明确回答'}}).decision.kind,'question');
 for(const decision of [{kind:'question',questionId:'q',answer:'x',path:'C:/outside'},{kind:'permission',permissionRequestId:'p',decision:'always_allow'},{kind:'configuration',decision:'retry',projectId:pid}])assert.throws(()=>parseSessionRequest('answerInteraction',{...base,decision}));
 let reads=0;const malicious={...base,decision:{kind:'question',questionId:'q',get answer(){reads++;return 'x';}}};assert.throws(()=>parseSessionRequest('answerInteraction',malicious));assert.equal(reads,0);
});
test('old v1-v5 conversations migrate with text intact and without fabricated run ownership',()=>{
 for(const version of [1,2,3,4,5]){const old={id:tid,user:'旧问题',assistant:'旧答案',status:'completed',error:''};const row={id:sid,title:'旧会话',provider:'kimi',createdAt:time,updatedAt:time,turns:[old]};const parsed=parseSessionDisk({version,selectedId:sid,sessions:[row]});assert.equal(parsed.version,6);assert.equal(parsed.sessions[0]!.turns[0]!.assistant,'旧答案');assert.equal(parsed.sessions[0]!.turns[0]!.execution,undefined);}
});
test('durable turn metadata validates model, status, preceding parent and globally unique execution/run links',()=>{
 const good={version:6,selectedId:sid,sessions:[session()]};assert.ok(parseSessionDisk(good));
 assert.throws(()=>parseSessionDisk({...good,sessions:[{...session(),turns:[{...turn(),provider:'deepseek',model:'deepseek-v4-flash'}]}]}));
 assert.throws(()=>parseSessionDisk({...good,sessions:[{...session(),turns:[{...turn(),status:'running'}]}]}));
 assert.throws(()=>parseSessionDisk({...good,sessions:[{...session(),turns:[{...turn(),execution:{...execution(),parentTurnId:nextId}}]}]}));
 assert.throws(()=>parseSessionDisk({...good,sessions:[{...session(),turns:[turn(),{...turn(),id:nextId}]}]}));
});
test('configuration/review/question metadata cannot masquerade as a completed clean turn',()=>{
 const question={kind:'question' as const,interactionId:'interaction_1',questionId:'q1',prompt:'继续？',state:'pending' as const};
 assert.ok(parseChatTurnExecution({...execution(),phase:'waiting_question',pendingInteraction:question}));
 assert.throws(()=>parseChatTurnExecution({...execution(),pendingInteraction:question}));
 assert.throws(()=>parseChatTurnExecution({...execution(),phase:'waiting_question'}));
 assert.throws(()=>parseChatTurnExecution({...execution(),cleanupState:'failed'}));
 assert.throws(()=>parseChatTurnExecution({...execution(),acceptedContext:{...execution().acceptedContext,bindingId:null,bindingIdentity:null},runLink:{runId:'run_1',workspaceId:null}}));
});
test('interaction receipts bind a fixed decision and one result turn; malformed or duplicate receipts are rejected',()=>{
 const receipt={requestId:nextId,interactionId:'interaction_1',decisionDigest:digest,resultTurnId:nextId};assert.deepEqual(parseChatTurnExecution({...execution(),interactionReceipts:[receipt]}).interactionReceipts,[receipt]);
 assert.throws(()=>parseChatTurnExecution({...execution(),interactionReceipts:[receipt,receipt]}));
 assert.throws(()=>parseChatTurnExecution({...execution(),interactionReceipts:[{...receipt,decisionDigest:'short'}]}));
});
test('main-issued origin keeps chat, turn and engine identities distinct and excludes locators',()=>{
 assert.deepEqual(parseChatRunOrigin(origin()),origin());
 for(const value of [{...origin(),chatSessionId:'native_session'},{...origin(),turnId:'tool_call'},{...origin(),inputDigest:'short'},{...origin(),path:'Q:/outside'}])assert.throws(()=>parseChatRunOrigin(value));
});
test('stored run admission and summary must agree on origin and no source lookup happens during decoding',()=>{
 const run=stored(),original=Object.getOwnPropertyDescriptor(fs,'lstatSync')!;let lookups=0;
 Object.defineProperty(fs,'lstatSync',{...original,value(){lookups++;throw Error('No source access');}});
 try{assert.ok(parseProjectReadDisk({version:1,runs:[run]}));assert.equal(lookups,0);}finally{Object.defineProperty(fs,'lstatSync',original);}
 assert.equal(parseProjectReadDisk({version:1,runs:[{...run,run:{...run.run,origin:{...origin(),inputDigest:identity}}}]}),null);
 const other=stored('run_other');assert.equal(parseProjectReadDisk({version:1,runs:[run,other]}),null);
});
test('activity validates every origin field, frozen project/model, run and workspace before projecting evidence',()=>{
 const valid=activity();assert.deepEqual(parseChatTurnActivity(valid),valid);
 const {origin:_origin,...noOrigin}=valid.run;assert.notEqual(valid.run.project.bindingId,null);
 const variants:unknown[]=[noOrigin,{...valid.run,origin:{...origin(),chatSessionId:nextId}},{...valid.run,origin:{...origin(),turnId:nextId}},{...valid.run,origin:{...origin(),executionId:'other_execution'}},{...valid.run,origin:{...origin(),inputDigest:identity}},{...valid.run,project:{...valid.run.project,identity:digest}},{...valid.run,model:{provider:'deepseek',model:'deepseek-v4-flash'}},{...valid.run,workCycle:{workspaceId:'other_workspace'}}];
 for(const run of variants)assert.throws(()=>parseChatTurnActivity({...valid,run}));
});
test('activity pages reject duplicate parts, gaps, foreign events and incorrect cursor endpoints',()=>{
 const valid=activity();assert.throws(()=>parseChatTurnActivity({...valid,nextSequence:99}));
 assert.throws(()=>parseChatTurnActivity({...valid,parts:[valid.parts[0],valid.parts[0]],nextSequence:1}));
 assert.throws(()=>parseChatTurnActivity({...valid,parts:[valid.parts[0],valid.parts[2]],nextSequence:3}));
 assert.throws(()=>parseChatTurnActivity({...valid,parts:[{...valid.parts[0],runId:'other_run'}],nextSequence:1}));
 assert.throws(()=>parseChatTurnActivity({...valid,parts:[],hasMore:true}));
});
test('method-specific result parser never mistakes an activity page for session state',()=>{
 const result={ok:true,value:activity()};assert.equal(parseSessionMethodResult('readTurnActivity',result).ok,true);assert.throws(()=>parseSessionResult(result));
 assert.deepEqual(parseSessionMethodResult('readTurnActivity',{ok:false,error:{code:'CONTEXT_LIMIT'}}),{ok:false,error:{code:'CONTEXT_LIMIT'}});
});
