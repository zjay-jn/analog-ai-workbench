import test from 'node:test';
import assert from 'node:assert/strict';
import {providerUsageDiagnostic} from '../apps/desktop/src/shared/agent/provider-response-diagnostic';
import type {ChatTurnActivity,ChatFailureDiagnostic,ChatRunOrigin} from '../apps/desktop/src/shared/agent/chat-turns';
import type {CommandExecution} from '../apps/desktop/src/shared/agent/agent-command';
import type {CommandDiagnosticReadResult} from '../apps/desktop/src/shared/agent/command-diagnostics';
import {commandPrimaryFailure,commandPrimaryFailurePort,type CommandDiagnosticScope} from '../apps/desktop/src/renderer/agent/command-primary-failure';
import {createCommandExecutionController,type CommandExecutionPorts} from '../apps/desktop/src/renderer/agent/command-execution-controller';

const sha='a'.repeat(64),time='2026-10-28T00:00:00.000Z';
const origin:ChatRunOrigin={chatSessionId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',executionId:'chat-execution',inputDigest:sha};
const scope:CommandDiagnosticScope={runId:'run-synthetic',workspaceId:'workspace-synthetic',origin};
const log=(stream:'stdout'|'stderr')=>({stream,persistedBytes:0,observedBytes:0,prefixVersion:sha,closed:true,coverage:'complete' as const,sha256:sha});
const execution:CommandExecution={executionId:'command-synthetic',runId:scope.runId,workspaceId:scope.workspaceId,requestId:'request-synthetic',signature:sha,environment:{environmentId:'synthetic',revision:sha,displayName:'PRIVATE_ENV'},baselineVersion:sha,cwdRelativePath:'PRIVATE_DIRECTORY',commandText:'PRIVATE_COMMAND_TEXT',commandSha256:sha,scriptSha256:sha,revision:5,phase:'terminal',createdAt:time,deadlineAt:'2026-10-28T00:02:00.000Z',startedAt:null,runtime:null,completedAt:time,stopRequested:{reason:'engine_failure',requestedAt:time},exit:{shellExitCode:null,shellExited:false,observedAt:time,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},logs:{stdout:log('stdout'),stderr:log('stderr')},artifacts:[],changes:{state:'unavailable',manifestVersion:null,count:null,acceptance:'not_requested'},error:{code:'RESULT_ADOPTION_CANCELLED',stage:'run',nativeCode:null}};
const diagnostics:CommandDiagnosticReadResult={records:[{version:1,id:'33333333-3333-4333-8333-333333333333',time,appVersion:'0.1.0-alpha.0',runId:scope.runId,executionId:execution.executionId,workspaceId:scope.workspaceId,component:'controller',operation:'finish.baseline',kind:'failure',causeCode:'CANCELLED',nativeCode:null,stack:[]}],unavailable:false,truncated:false};
const primary:ChatFailureDiagnostic={stage:'response_validation',reason:'PROTOCOL_ERROR',providerAttempts:2,httpDispatches:2,httpStatus:200,responseFailure:{code:'sse.usage.completion_details',frame:7,receivedBytes:1400,textBytes:20,toolCalls:1,done:false,finish:'none',usage:providerUsageDiagnostic({prompt_tokens:10,completion_tokens:5,total_tokens:15,completion_tokens_details:{},prompt_tokens_details:{cached_tokens:'PRIVATE_PROVIDER_VALUE'},PRIVATE_PROVIDER_KEY:'PRIVATE_PROVIDER_VALUE'},'choice','tool_calls')}};
const activity:ChatTurnActivity={sessionId:origin.chatSessionId,turnId:origin.turnId,version:2,execution:{executionId:origin.executionId,version:2,requestDigest:sha,acceptedContext:{projectId:'44444444-4444-4444-8444-444444444444',workspaceRevision:1,bindingId:'binding-a',bindingIdentity:sha,provider:'kimi',model:'kimi-k3',historyVersion:sha},phase:'failed',cleanupState:'idle',runLink:{runId:scope.runId,workspaceId:scope.workspaceId},parentTurnId:null,pendingInteraction:null,failureDiagnostic:primary},run:{origin,runId:scope.runId,clientRequestId:origin.turnId,project:{projectId:'44444444-4444-4444-8444-444444444444',bindingId:'binding-a',identity:sha,name:'PRIVATE_PROJECT',directoryName:'PRIVATE_PATH',directorySegments:['C','PRIVATE_PATH']},model:{provider:'kimi',model:'kimi-k3'},goal:'PRIVATE_GOAL',constraint:'',continuedFrom:null,status:'failed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting:{providerAttempts:2,httpDispatches:2,toolAttempts:1,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:1,continuation:null,workCycle:{workspaceId:scope.workspaceId}},parts:[{kind:'text',partId:'text-a',sequence:1,text:'PRIVATE_CHAT_BODY'}],nextSequence:1,hasMore:false};
const forbidden=():never=>assert.fail('Copy may not use command, status, model, selection or log ports');
function fixture(primaryFailure?:CommandExecutionPorts['primaryFailure'],selected:CommandDiagnosticScope=scope){
 const copies:string[]=[];let reads=0;const controller=createCommandExecutionController({list:async()=>forbidden(),environment:async()=>forbidden(),status:async()=>forbidden(),log:async()=>forbidden(),stop:async()=>forbidden(),diagnostics:async()=>{reads++;return{ok:true,value:diagnostics};},copyText:async text=>{copies.push(text);},...(primaryFailure?{primaryFailure}:{})});
 controller.setScope(selected);controller.register([execution]);return{controller,copies,reads:()=>reads};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}

test('copy includes scoped primary parser failure and fixed usage while retaining command cancellation as secondary evidence',async()=>{
 let primaryReads=0;const f=fixture(async requested=>{primaryReads++;assert.deepEqual(requested,scope);return activity;});try{
  assert.equal(primaryReads,0);assert.equal(f.reads(),0);assert(await f.controller.copyDiagnostics(execution.executionId));assert.equal(primaryReads,1);assert.equal(f.reads(),1);
  const result=JSON.parse(f.copies[0]!);assert.equal(result.primaryUnavailable,false);assert.equal(result.primaryFailure.responseFailure.code,'sse.usage.completion_details');assert.equal(result.primaryFailure.responseFailure.usage.fields.length,11);
  assert.equal(result.primaryFailure.responseFailure.usage.fields.find((row:{field:string})=>row.field==='completion_tokens_details.reasoning_tokens').kind,'missing');
  assert.equal(result.primaryFailure.responseFailure.usage.fields.find((row:{field:string})=>row.field==='prompt_tokens_details.cached_tokens').kind,'string');
  assert.equal(result.error.code,'RESULT_ADOPTION_CANCELLED');assert.equal(result.diagnostics.records[0].causeCode,'CANCELLED');assert.doesNotMatch(f.copies[0]!,/PRIVATE_|commandText|directorySegments|parts|inputDigest/);
 }finally{f.controller.dispose();}
});

test('missing origin, missing failure and failed lookup preserve available command diagnostics and declare primaryUnavailable',async()=>{
 for(const mode of ['origin','missing','failure','no-port'] as const){let calls=0;const f=fixture(mode==='no-port'?undefined:async()=>{calls++;if(mode==='failure')throw Error('PRIVATE_FAILURE');return mode==='missing'?{...activity,execution:{...activity.execution!,failureDiagnostic:undefined} as unknown as NonNullable<ChatTurnActivity['execution']>}:activity;},mode==='origin'?{runId:scope.runId,workspaceId:scope.workspaceId}:scope);
  try{assert(await f.controller.copyDiagnostics(execution.executionId));const result=JSON.parse(f.copies[0]!);assert.equal(result.primaryFailure,null);assert.equal(result.primaryUnavailable,true);assert.equal(result.diagnostics.records.length,1);assert.match(f.controller.snapshot().entries[0]!.diagnosticsActionStatus??'',/首因暂不可用/);assert.equal(calls,mode==='origin'||mode==='no-port'?0:1);}finally{f.controller.dispose();}
 }
});

test('primary projection rejects mismatched chat, turn, execution, digest, run, workspace and recorded origin',async()=>{
 const invalid:ChatTurnActivity[]=[{...activity,sessionId:'55555555-5555-4555-8555-555555555555'},{...activity,turnId:'55555555-5555-4555-8555-555555555555'},
  ...[{executionId:'foreign'},{requestDigest:'b'.repeat(64)},{runLink:{runId:'foreign',workspaceId:scope.workspaceId}},{runLink:{runId:scope.runId,workspaceId:'foreign'}}].map(patch=>({...activity,execution:{...activity.execution!,...patch}})),
  {...activity,run:{...activity.run!,runId:'foreign'}},{...activity,run:{...activity.run!,workCycle:{workspaceId:'foreign'}}},{...activity,run:{...activity.run!,origin:{...origin,turnId:'55555555-5555-4555-8555-555555555555'}}}];
 for(const value of invalid){assert.equal(commandPrimaryFailure(value,scope),null);const f=fixture(async()=>value);try{assert(await f.controller.copyDiagnostics(execution.executionId));assert.equal(JSON.parse(f.copies[0]!).primaryUnavailable,true);}finally{f.controller.dispose();}}
});

test('late primary responses cannot copy after scope, origin or disposal changes',async()=>{
 for(const transition of ['scope','origin','dispose'] as const){const wait=deferred<ChatTurnActivity|null>();let reads=0;const f=fixture(async()=>{reads++;return wait.promise;});
  try{const pending=f.controller.copyDiagnostics(execution.executionId);for(let i=0;i<8&&reads===0;i++)await Promise.resolve();assert.equal(reads,1);assert.equal(await f.controller.copyDiagnostics(execution.executionId),false);
   if(transition==='scope')f.controller.setScope({runId:'other',workspaceId:'other'});else if(transition==='origin')f.controller.setScope({...scope,origin:{...origin,turnId:'55555555-5555-4555-8555-555555555555'}});else f.controller.dispose();
   wait.resolve(activity);assert.equal(await pending,false);assert.deepEqual(f.copies,[]);
  }finally{f.controller.dispose();}
 }
});

test('malformed or arbitrary diagnostic strings are omitted while fixed command diagnostics remain copyable',async()=>{
 const patches=[{reason:'PRIVATE_PROVIDER_VALUE'},{responseFailure:{...primary.responseFailure,code:'PRIVATE_PROVIDER_VALUE'}},{responseFailure:{...primary.responseFailure,usage:{...primary.responseFailure!.usage,fields:[{field:'PRIVATE_PROVIDER_VALUE',kind:'string'}]}}},{PRIVATE_EXTRA:'PRIVATE_PROVIDER_VALUE'}];
 for(const patch of patches){const value={...activity,execution:{...activity.execution!,failureDiagnostic:{...primary,...patch} as ChatFailureDiagnostic}},f=fixture(async()=>value);try{assert(await f.controller.copyDiagnostics(execution.executionId));assert.equal(JSON.parse(f.copies[0]!).primaryUnavailable,true);assert.doesNotMatch(f.copies[0]!,/PRIVATE_/);}finally{f.controller.dispose();}}
});

test('existing readTurnActivity bridge performs one explicit scoped read and validates its full envelope',async()=>{
 const calls:unknown[]=[];let foreign=false;const port=commandPrimaryFailurePort({readTurnActivity:async request=>{calls.push(request);return{ok:true,value:foreign?{...activity,sessionId:'55555555-5555-4555-8555-555555555555'}:activity};}});
 assert.equal(calls.length,0);const parsed=await port(scope);assert.deepEqual(commandPrimaryFailure(parsed,scope),primary);assert.deepEqual(calls,[{contractVersion:'workbench.sessions.v6',sessionId:origin.chatSessionId,turnId:origin.turnId,afterSequence:0}]);
 assert.equal(await port({runId:scope.runId,workspaceId:scope.workspaceId}),null);assert.equal(calls.length,1);
 await assert.rejects(port({...scope,origin:{...origin,turnId:'../invalid'}}));assert.equal(calls.length,1);
 foreign=true;await assert.rejects(port(scope));assert.equal(calls.length,2);
});

test('each copy uses the latest bound failure metadata instead of a stale saved command cancellation',async()=>{
 let current=activity;const f=fixture(async()=>current);try{assert(await f.controller.copyDiagnostics(execution.executionId));current={...activity,execution:{...activity.execution!,failureDiagnostic:{...primary,responseFailure:{...primary.responseFailure!,code:'sse.usage.cached_conflict'}}}};assert(await f.controller.copyDiagnostics(execution.executionId));assert.equal(f.reads(),1);assert.equal(JSON.parse(f.copies[1]!).primaryFailure.responseFailure.code,'sse.usage.cached_conflict');}finally{f.controller.dispose();}
});

