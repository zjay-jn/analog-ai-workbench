import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommandExecution} from '../apps/desktop/src/shared/agent/agent-command';
import type {CommandDiagnosticReadResult} from '../apps/desktop/src/shared/agent/command-diagnostics';
import type {ChatTurnActivity} from '../apps/desktop/src/shared/agent/chat-turns';
import {CommandExecutionDetails,CommandExecutionView,commandExecutionState} from '../apps/desktop/src/renderer/agent/CommandExecutionResults';
import {ChatAgentResults,type ChatResultRequest} from '../apps/desktop/src/renderer/agent/ChatAgentResults';
import {createCommandExecutionController,commandExecutionPorts,commandDiagnosticClipboardText,type CommandExecutionPorts,type CommandReadResult} from '../apps/desktop/src/renderer/agent/command-execution-controller';

const sha='a'.repeat(64),now='2026-10-28T00:00:00.000Z';
const log=(stream:'stdout'|'stderr')=>({stream,persistedBytes:0,observedBytes:0,prefixVersion:sha,closed:true,coverage:'complete' as const,sha256:sha});
const execution:CommandExecution={executionId:'command-synthetic',runId:'run-synthetic',workspaceId:'workspace-synthetic',requestId:'request-synthetic',signature:sha,environment:{environmentId:'synthetic',revision:sha,displayName:'PRIVATE_ENVIRONMENT'},baselineVersion:sha,cwdRelativePath:'private-directory',commandText:'PRIVATE_COMMAND_TEXT',commandSha256:sha,scriptSha256:sha,revision:5,phase:'terminal',createdAt:now,deadlineAt:'2026-10-28T00:02:00.000Z',startedAt:now,completedAt:now,stopRequested:{reason:'engine_failure',requestedAt:now},exit:{shellExitCode:null,shellExited:false,observedAt:now,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:now},cleanup:{state:'confirmed',observedAt:now,proofSha256:sha},logs:{stdout:log('stdout'),stderr:log('stderr')},artifacts:[],artifactCollection:{scope:'bounded_text_exports',skippedEntries:0},changes:{state:'unavailable',manifestVersion:null,count:null,acceptance:'not_requested'},error:{code:'RESULT_ADOPTION_CANCELLED',stage:'run',nativeCode:null}};
const result:CommandDiagnosticReadResult={records:[{version:1,id:'11111111-1111-4111-8111-111111111111',time:now,appVersion:'0.1.0-alpha.0',runId:execution.runId,executionId:execution.executionId,workspaceId:execution.workspaceId,chatSessionId:'session-private',turnId:'turn-private',component:'controller',operation:'finish.baseline',kind:'failure',causeCode:'CANCELLED',nativeCode:null,stack:['apps/desktop/src/main/agent-command/controller.ts:64:20']}],unavailable:false,truncated:false};
const forbidden=():never=>assert.fail('No command, status, log or model action is allowed');
const base:CommandExecutionPorts={list:async()=>forbidden(),environment:async()=>forbidden(),status:async()=>forbidden(),log:async()=>forbidden(),stop:async()=>forbidden()};
function fixture(ports:Partial<CommandExecutionPorts>={}){const c=createCommandExecutionController({...base,...ports});c.setScope({runId:execution.runId,workspaceId:execution.workspaceId});c.register([execution]);return c;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}

test('execution details use Chinese cause, collapse technical data, omit empty artifacts and zero omissions',()=>{
 const controller=fixture();try{
  const markup=renderToStaticMarkup(createElement(CommandExecutionDetails,{entry:controller.snapshot().entries[0]!,actions:controller}));
  assert.match(markup,/软件异常后已停止/);assert.match(markup,/任务已停止，文件变更未接收；进程收尾已确认/);assert.match(markup,/<details><summary>技术详情<\/summary>/);
  const beforeTechnical=markup.slice(0,markup.indexOf('<summary>技术详情'));
  assert.doesNotMatch(beforeTechnical,/PRIVATE_COMMAND|PRIVATE_ENVIRONMENT|RESULT_ADOPTION_CANCELLED|private-directory/);
  assert.doesNotMatch(markup,/open=""|已省略 0|命令产物|本次产物|role="alert"|用户请求|停止这次执行/);
  assert.match(markup,/复制诊断信息/);assert.match(markup,/打开日志位置/);
 }finally{controller.dispose();}
});

test('automatic stops and incomplete cleanup remain distinct from user cancellation and success',()=>{
 assert.equal(commandExecutionState(execution).label,'软件异常后已停止');
 assert.equal(commandExecutionState({...execution,stopRequested:{reason:'user',requestedAt:now}}).label,'命令已停止');
 const pending={...execution,phase:'reconciliation_required' as const,cleanup:{state:'pending' as const,observedAt:null,proofSha256:null},error:{code:'DRIVER_EVIDENCE_FAILED',stage:'run' as const,nativeCode:null}};
 const markup=renderToStaticMarkup(createElement(CommandExecutionView,{execution:pending}));
 assert.match(markup,/执行状态待核对/);assert.match(markup,/执行收尾尚未确认/);assert.match(markup,/执行结果未能完成核对/);assert.doesNotMatch(markup,/用户请求|命令已停止|软件异常后已停止|role="alert"/);
 const incomplete=renderToStaticMarkup(createElement(CommandExecutionView,{execution:{...pending,error:{code:'RESULT_ADOPTION_CANCELLED',stage:'run',nativeCode:null}}}));
 assert.match(incomplete,/进程收尾尚未确认/);assert.doesNotMatch(incomplete,/收尾已确认/);
 const gap=renderToStaticMarkup(createElement(CommandExecutionView,{execution:{...execution,logs:{...execution.logs,stdout:{...execution.logs.stdout,coverage:'incomplete'}}}}));
 assert.match(gap.slice(0,gap.indexOf('<summary>技术详情')),/标准输出保存不完整/);
});

test('a reconciled prestart receipt preserves the old cleanup code without claiming cleanup is still unknown',()=>{
 const recovered:CommandExecution={...execution,startedAt:null,runtime:null,error:{code:'WSL_CLEANUP_UNCONFIRMED',stage:'cleanup',nativeCode:null}};
 const markup=renderToStaticMarkup(createElement(CommandExecutionView,{execution:recovered}));
 assert.match(markup,/此前未能确认收尾，现已通过状态核对确认结束/);assert.match(markup,/诊断码：WSL_CLEANUP_UNCONFIRMED/);assert.doesNotMatch(markup,/收尾尚未确认|用户请求/);
 assert.equal(JSON.parse(commandDiagnosticClipboardText(recovered,result)).error.code,'WSL_CLEANUP_UNCONFIRMED');
 for(const patch of [{cleanup:{state:'pending' as const,observedAt:null,proofSha256:null}},{job:{activeProcesses:null,emptyConfirmed:false,observedAt:null}},{logs:{...recovered.logs,stdout:{...recovered.logs.stdout,closed:false}}}]){
  const unknown=renderToStaticMarkup(createElement(CommandExecutionView,{execution:{...recovered,...patch}}));assert.doesNotMatch(unknown,/现已通过状态核对确认结束/);assert.match(unknown,/收尾尚未确认/);
 }
});

test('copy diagnostics fetches once then copies only safe selected metadata without another command operation',async()=>{
 let reads=0;const copies:string[]=[];const c=fixture({diagnostics:async()=>{reads++;return{ok:true,value:result};},copyText:async text=>{copies.push(text);}});
 try{
  const before=structuredClone(c.snapshot().entries[0]!.execution);assert.equal(await c.copyDiagnostics('unknown'),false);assert.equal(reads,0);
  assert(await c.copyDiagnostics(execution.executionId));assert(await c.copyDiagnostics(execution.executionId));assert.equal(reads,1);assert.equal(copies.length,2);
  const copy=JSON.parse(copies[0]!);assert.equal(copy.executionId,execution.executionId);assert.equal(copy.stopReason,'engine_failure');assert.equal(copy.cleanup,'confirmed');assert.equal(copy.diagnostics.records[0].causeCode,'CANCELLED');
  assert.doesNotMatch(copies[0]!,/PRIVATE_|private-directory|session-private|turn-private|commandText|runtime|displayName/);assert.deepEqual(c.snapshot().entries[0]!.execution,before);assert.match(c.snapshot().entries[0]!.diagnosticsActionStatus??'',/已复制/);
 }finally{c.dispose();}
});

test('copy cannot emit foreign or late diagnostics and clipboard failure remains a quiet action status',async()=>{
 for(const mode of ['foreign','scope','dispose','clipboard'] as const){
  const wait=deferred<CommandReadResult<CommandDiagnosticReadResult>>();let copies=0;
  const c=fixture({diagnostics:()=>wait.promise,copyText:async()=>{copies++;if(mode==='clipboard')throw Error('Synthetic denied');}});
  try{
   const pending=c.copyDiagnostics(execution.executionId);assert.equal(await c.copyDiagnostics(execution.executionId),false);
   if(mode==='scope')c.setScope({runId:'other',workspaceId:'other'});if(mode==='dispose')c.dispose();
   wait.resolve({ok:true,value:mode==='foreign'?{...result,records:[{...result.records[0]!,executionId:'foreign'}]}:result});assert.equal(await pending,false);assert.equal(copies,mode==='clipboard'?1:0);
   if(mode==='clipboard')assert.match(c.snapshot().entries[0]!.diagnosticsActionStatus??'',/未能复制/);
  }finally{c.dispose();}
 }
});

test('open diagnostics is explicit, scoped, deduplicated and does not mutate execution or query commands',async()=>{
 const wait=deferred<CommandReadResult<{opened:boolean}>>(),calls:unknown[]=[];const c=fixture({openDiagnostics:async(runId,executionId)=>{calls.push({runId,executionId});return wait.promise;}});
 try{
  const before=structuredClone(c.snapshot().entries[0]!.execution);assert.equal(await c.openDiagnostics('unknown'),false);assert.equal(calls.length,0);
  const pending=c.openDiagnostics(execution.executionId);assert.equal(await c.openDiagnostics(execution.executionId),false);
  wait.resolve({ok:true,value:{opened:true}});assert(await pending);assert.deepEqual(calls,[{runId:execution.runId,executionId:execution.executionId}]);assert.deepEqual(c.snapshot().entries[0]!.execution,before);assert.match(c.snapshot().entries[0]!.diagnosticsActionStatus??'',/已打开日志位置/);
 }finally{c.dispose();}
 for(const mode of ['scope','dispose','missing'] as const){
  const waiting=deferred<CommandReadResult<{opened:boolean}>>(),controller=fixture({openDiagnostics:()=>waiting.promise});try{
   const pending=controller.openDiagnostics(execution.executionId);if(mode==='scope')controller.setScope({runId:'other',workspaceId:'other'});if(mode==='dispose')controller.dispose();waiting.resolve({ok:true,value:{opened:false}});assert.equal(await pending,false);
   if(mode==='missing')assert.match(controller.snapshot().entries[0]!.diagnosticsActionStatus??'',/尚无可打开/);else assert.equal(controller.snapshot().entries[0]?.diagnosticsActionStatus??null,null);
  }finally{controller.dispose();}
 }
});

test('open diagnostic bridge validates fixed run and execution envelopes with no path supplied by renderer',async()=>{
 const calls:unknown[]=[],api:Parameters<typeof commandExecutionPorts>[0]={inspectCommandEnvironment:async()=>forbidden(),listCommandExecutions:async()=>forbidden(),readCommandExecution:async()=>forbidden(),readCommandLog:async()=>forbidden(),stopCommandExecution:async()=>forbidden(),openCommandDiagnostics:async input=>{calls.push(input);return{ok:true,value:{opened:true}};}};
 const ports=commandExecutionPorts(api);assert.deepEqual(await ports.openDiagnostics!(execution.runId,execution.executionId),{ok:true,value:{opened:true}});assert.deepEqual(Object.keys(calls[0] as object).sort(),['contractVersion','executionId','runId']);
 await assert.rejects(ports.openDiagnostics!('../outside',execution.executionId));assert.equal(calls.length,1);
});

test('chat results hide an empty whole artifact region instead of showing an empty file list',()=>{
 const activity:ChatTurnActivity={sessionId:'synthetic-session',turnId:'synthetic-turn',version:1,execution:{executionId:'chat-execution',version:1,requestDigest:sha,acceptedContext:{projectId:'synthetic-project',workspaceRevision:1,bindingId:null,bindingIdentity:null,provider:'kimi',model:'kimi-k3',historyVersion:sha},phase:'failed',cleanupState:'idle',runLink:{runId:execution.runId,workspaceId:execution.workspaceId},parentTurnId:null,pendingInteraction:null},run:null,parts:[],nextSequence:0,hasMore:false};
 const request:ChatResultRequest={sessionId:activity.sessionId,turnId:activity.turnId,executionId:'chat-execution',runId:execution.runId,workspaceId:execution.workspaceId,activity,target:{kind:'run'}};
 const markup=renderToStaticMarkup(createElement(ChatAgentResults,{request,activity,api:undefined}));assert.doesNotMatch(markup,/本轮成果文件|核对文件|暂无工作文件|成果文件/);assert.doesNotMatch(markup,/结果归属已变化/);
});
