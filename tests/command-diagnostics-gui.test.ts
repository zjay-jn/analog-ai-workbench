import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,isValidElement,type ReactNode,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommandExecution} from '../apps/desktop/src/shared/agent/agent-command';
import type {CommandDiagnosticReadResult,CommandDiagnosticRecord} from '../apps/desktop/src/shared/agent/command-diagnostics';
import {AGENT_PROJECT_READ_VERSION} from '../apps/desktop/src/shared/agent/agent-project-read';
import {createCommandExecutionController,commandExecutionPorts,type CommandExecutionPorts,type CommandExecutionEntry,type CommandReadResult} from '../apps/desktop/src/renderer/agent/command-execution-controller';
import {CommandExecutionDetails,CommandExecutionView,commandExecutionState,type CommandExecutionActions} from '../apps/desktop/src/renderer/agent/CommandExecutionResults';

const sha='a'.repeat(64),now='2026-10-27T12:00:00.000Z';
const log=(stream:'stdout'|'stderr')=>({stream,persistedBytes:0,observedBytes:0,prefixVersion:sha,closed:false,coverage:'open' as const,sha256:null});
const execution:CommandExecution={executionId:'command-synthetic',runId:'run-synthetic',workspaceId:'workspace-synthetic',requestId:'request-synthetic',signature:sha,environment:{environmentId:'synthetic',revision:sha,displayName:'合成环境'},baselineVersion:sha,cwdRelativePath:'',commandText:'synthetic not executed',commandSha256:sha,scriptSha256:sha,revision:2,phase:'reconciliation_required',createdAt:now,deadlineAt:'2026-10-27T12:02:00.000Z',startedAt:now,completedAt:null,stopRequested:null,exit:null,job:{activeProcesses:null,emptyConfirmed:false,observedAt:null},cleanup:{state:'pending',observedAt:null,proofSha256:null},logs:{stdout:log('stdout'),stderr:log('stderr')},artifacts:[],changes:{state:'pending',manifestVersion:null,count:null,acceptance:'not_requested'},error:{code:'DRIVER_EVIDENCE_FAILED',stage:'run',nativeCode:null}};
const record:CommandDiagnosticRecord={version:1,id:'11111111-1111-4111-8111-111111111111',time:now,appVersion:'0.1.0-alpha.0',runId:execution.runId,executionId:execution.executionId,workspaceId:execution.workspaceId,component:'controller',operation:'finish.baseline',kind:'failure',causeCode:'CANCELLED',nativeCode:null,stack:['apps/desktop/src/main/agent-command/controller.ts:64:20']};
const result:CommandDiagnosticReadResult={records:[record],unavailable:false,truncated:false};
const forbidden=():never=>assert.fail('Reading diagnostics must not call another command operation');
const legacyPorts:CommandExecutionPorts={list:async()=>forbidden(),environment:async()=>forbidden(),status:async()=>forbidden(),log:async()=>forbidden(),stop:async()=>forbidden()};
function fixture(diagnostics?:CommandExecutionPorts['diagnostics']){const controller=createCommandExecutionController({...legacyPorts,...(diagnostics?{diagnostics}:{})});controller.setScope({runId:execution.runId,workspaceId:execution.workspaceId});controller.register([execution]);return controller;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const actions:CommandExecutionActions={refresh:async()=>forbidden(),stop:async()=>forbidden(),readLog:async()=>forbidden(),refreshHistory:async()=>forbidden(),inspectEnvironment:async()=>forbidden()};
const html=(entry:CommandExecutionEntry)=>renderToStaticMarkup(createElement(CommandExecutionDetails,{entry,actions:{...actions,readDiagnostics:async()=>true}}));
type ButtonProps={children?:ReactNode;disabled?:boolean;onClick?:()=>void};
function button(node:ReactNode,label:string):ReactElement<ButtonProps>|undefined{
 if(Array.isArray(node)){for(const child of node){const found=button(child,label);if(found)return found;}return;}
 if(!isValidElement<ButtonProps>(node))return;return node.type==='button'&&node.props.children===label?node:button(node.props.children,label);
}

test('diagnostic detail button reads only the selected execution and keeps command state untouched',async()=>{
 const calls:unknown[]=[],controller=fixture(async(runId,executionId)=>{calls.push({runId,executionId});return {ok:true,value:result};});
 try{
  const before=structuredClone(controller.snapshot().entries[0]!.execution);let pending:Promise<boolean>|undefined;
  const tree=CommandExecutionDetails({entry:controller.snapshot().entries[0]!,actions:{...actions,readDiagnostics:id=>pending=controller.readDiagnostics(id)}});
  assert.equal(calls.length,0);button(tree,'诊断日志')!.props.onClick!();assert(await pending);
  assert.deepEqual(calls,[{runId:execution.runId,executionId:execution.executionId}]);assert.deepEqual(controller.snapshot().entries[0]!.execution,before);
  assert.deepEqual(controller.snapshot().entries[0]!.diagnostics,result);const markup=html(controller.snapshot().entries[0]!);
  assert.match(markup,/finish\.baseline/);assert.match(markup,/CANCELLED/);assert.match(markup,/0\.1\.0-alpha\.0/);assert.match(markup,/2026-10-27 12:00:00\.000 UTC/);assert.match(markup,/controller\.ts:64:20/);
  assert.doesNotMatch(markup.slice(markup.indexOf('<section aria-label="执行诊断日志">')),/role="alert"|danger|cloud-turn-error/);
 }finally{controller.dispose();}
});

test('diagnostic reads are explicit, deduplicated while loading and discard stale scope or disposed responses',async()=>{
 for(const transition of ['scope','dispose'] as const){
  const wait=deferred<CommandReadResult<CommandDiagnosticReadResult>>();let reads=0;const controller=fixture(async()=>{reads++;return wait.promise;});
  try{
   assert.equal(await controller.readDiagnostics('unknown-execution'),false);assert.equal(reads,0);
   const pending=controller.readDiagnostics(execution.executionId);assert.equal(reads,1);assert.equal(controller.snapshot().entries[0]!.diagnosticsLoading,true);
   assert.equal(await controller.readDiagnostics(execution.executionId),false);assert.equal(reads,1);assert.match(html(controller.snapshot().entries[0]!),/disabled="">正在读取诊断…/);
   if(transition==='scope')controller.setScope({runId:'other-run',workspaceId:'other-workspace'});else controller.dispose();
   wait.resolve({ok:true,value:result});assert.equal(await pending,false);
   if(transition==='scope')assert.deepEqual(controller.snapshot().entries,[]);else assert.equal(controller.snapshot().entries[0]!.diagnostics,undefined);
  }finally{controller.dispose();}
 }
});

test('foreign or unsafe diagnostic records are rejected without replacing previously verified detail',async()=>{
 for(const patch of [{runId:'other-run'},{executionId:'other-execution'},{workspaceId:'other-workspace'},{stack:['C:/private/secret.js:12:4']},{causeCode:'PRIVATE_RAW_FAILURE'}]){
  let bad=false;const controller=fixture(async()=>({ok:true,value:bad?{...result,records:[{...record,...patch}]} as CommandDiagnosticReadResult:result}));
  try{assert(await controller.readDiagnostics(execution.executionId));bad=true;assert.equal(await controller.readDiagnostics(execution.executionId),false);assert.deepEqual(controller.snapshot().entries[0]!.diagnostics,result);assert.match(controller.snapshot().entries[0]!.diagnosticsError??'',/归属不一致/);}finally{controller.dispose();}
 }
});

test('missing, unavailable and retained-window diagnostics are explained quietly and never imply command success',async()=>{
 const controller=fixture(async()=>({ok:true,value:{records:[],unavailable:true,truncated:true}}));try{
  assert(await controller.readDiagnostics(execution.executionId));const markup=html(controller.snapshot().entries[0]!);
  assert.match(markup,/此执行没有保留可用诊断（可能早于记录功能或已轮转）/);assert.match(markup,/暂时无法完整读取/);assert.match(markup,/仅显示此执行最近保留/);assert.match(markup,/执行状态待核对/);assert.doesNotMatch(markup.slice(markup.indexOf('<section aria-label="执行诊断日志">')),/role="alert"/);
 }finally{controller.dispose();}
 const legacy=fixture();try{assert.equal(await legacy.readDiagnostics(execution.executionId),false);assert.match(legacy.snapshot().entries[0]!.diagnosticsError??'',/当前版本尚不能读取/);assert.doesNotMatch(renderToStaticMarkup(createElement(CommandExecutionDetails,{entry:legacy.snapshot().entries[0]!,actions})),/诊断日志/);}finally{legacy.dispose();}
});

test('diagnostic bridge validates envelopes and uses no status, recovery, stop or model port',async()=>{
 const calls:unknown[]=[],api:Parameters<typeof commandExecutionPorts>[0]={inspectCommandEnvironment:async()=>forbidden(),listCommandExecutions:async()=>forbidden(),readCommandExecution:async()=>forbidden(),readCommandLog:async()=>forbidden(),stopCommandExecution:async()=>forbidden(),readCommandDiagnostics:async request=>{calls.push(request);return {ok:true,value:{diagnostics:result}};}};
 const ports=commandExecutionPorts(api);assert.equal(calls.length,0);assert.deepEqual(await ports.diagnostics!(execution.runId,execution.executionId),{ok:true,value:result});
 assert.deepEqual(calls,[{contractVersion:AGENT_PROJECT_READ_VERSION,runId:execution.runId,executionId:execution.executionId}]);await assert.rejects(ports.diagnostics!('../foreign',execution.executionId));assert.equal(calls.length,1);
 const {readCommandDiagnostics:_,...oldApi}=api;assert.deepEqual(Object.keys(commandExecutionPorts(oldApi)).sort(),['environment','list','log','status','stop']);
});

test('confirmed stop before a shell exit shows stopped without inventing exit success',()=>{
 const stopped:CommandExecution={...execution,phase:'terminal',completedAt:now,exit:{shellExitCode:null,shellExited:false,observedAt:now,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:now},cleanup:{state:'confirmed',observedAt:now,proofSha256:sha},logs:{stdout:{...log('stdout'),closed:true,coverage:'complete',sha256:sha},stderr:{...log('stderr'),closed:true,coverage:'complete',sha256:sha}},error:{code:'RESULT_ADOPTION_CANCELLED',stage:'run',nativeCode:null},changes:{state:'unavailable',manifestVersion:null,count:null,acceptance:'not_requested'}};
 const state=commandExecutionState(stopped);assert.equal(state.label,'命令已停止');assert.equal(state.canStop,false);assert.match(state.detail,/未获得入口进程退出码/);
 const markup=renderToStaticMarkup(createElement(CommandExecutionView,{execution:stopped}));assert.match(markup,/任务已停止，文件变更未接收；进程收尾已确认/);assert.doesNotMatch(markup,/运行失败|role="alert"|入口进程退出码为 0/);
 assert.notEqual(commandExecutionState({...stopped,exit:{...stopped.exit!,termination:'exited'}}).label,'命令已停止');
 assert.equal(commandExecutionState({...stopped,cleanup:{state:'pending',observedAt:null,proofSha256:null}}).label,'执行收尾待确认');
 assert.equal(commandExecutionState({...stopped,exit:{...stopped.exit!,termination:'failed_start'}}).label,'命令启动失败');
});
