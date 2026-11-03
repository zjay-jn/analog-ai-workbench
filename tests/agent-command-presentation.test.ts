import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommandEnvironment,CommandExecution,CommandLogPage,CommandLogSummary} from '../apps/desktop/src/shared/agent/agent-command';
import {CommandEnvironmentResults,CommandExecutionView,CommandLogPageView,commandExecutionState,CommandExecutionArtifacts} from '../apps/desktop/src/renderer/agent/CommandExecutionResults';
import {createCommandExecutionController,commandExecutionPorts,type CommandExecutionPorts,type CommandReadResult} from '../apps/desktop/src/renderer/agent/command-execution-controller';
import {AGENT_PROJECT_READ_VERSION,type ProjectReadSummary} from '../apps/desktop/src/shared/agent/agent-project-read';
import {parseProjectReadEvent} from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import {ProjectReadView} from '../apps/desktop/src/renderer/agent/ProjectReadPanel';
import {initialProjectReadState} from '../apps/desktop/src/renderer/agent/project-read-controller';
import {createWorkCycleInspectionController} from '../apps/desktop/src/renderer/agent/work-cycle-controller';
import type {WorkCycleFile} from '../apps/desktop/src/shared/agent/agent-work-cycle';

const digest='a'.repeat(64),now='2026-09-14T12:00:00.000Z';
const log=(stream:'stdout'|'stderr',closed=false):CommandLogSummary=>({stream,persistedBytes:0,observedBytes:0,prefixVersion:digest,closed,coverage:closed?'complete':'open',sha256:closed?digest:null});
const running:CommandExecution={executionId:'command-a',runId:'run-a',workspaceId:'workspace-a',requestId:'request-a',signature:digest,environment:{environmentId:'powershell-a',revision:digest,displayName:'Windows PowerShell'},baselineVersion:digest,cwdRelativePath:'数据 输入',commandText:'node ./analyze.js',commandSha256:digest,scriptSha256:digest,revision:2,phase:'running',createdAt:now,deadlineAt:'2026-09-14T12:02:00.000Z',startedAt:now,completedAt:null,stopRequested:null,exit:null,job:{activeProcesses:2,emptyConfirmed:false,observedAt:now},cleanup:{state:'pending',observedAt:null,proofSha256:null},logs:{stdout:log('stdout'),stderr:log('stderr')},artifacts:[],changes:{state:'pending',manifestVersion:null,count:null,acceptance:'not_requested'},error:null};
const terminal:CommandExecution={...running,phase:'terminal',revision:3,completedAt:now,exit:{shellExitCode:0,shellExited:true,observedAt:now,termination:'exited'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:now},cleanup:{state:'confirmed',observedAt:now,proofSha256:digest},logs:{stdout:log('stdout',true),stderr:log('stderr',true)},changes:{state:'verified',manifestVersion:digest,count:2,acceptance:'not_requested'}};
const never=()=>{throw Error('Static rendering must not perform actions');};
const page=(offset=0,prefixVersion=digest,snapshotBytes=6):CommandLogPage=>({executionId:running.executionId,stream:'stdout',prefixVersion,offset,endOffset:offset+3,snapshotBytes,availableBytes:snapshotBytes,format:'utf8',data:'abc',bytesSha256:digest,nextCursor:offset+3<snapshotBytes?{offset:offset+3,prefixVersion}:null,streamClosed:true,coverage:'complete',hasNewerBytes:false});
function commandFixture(overrides:Partial<CommandExecutionPorts>={}){
 const calls:unknown[]=[];const ports:CommandExecutionPorts={list:async()=>({ok:true,value:[running]}),environment:async()=>({ok:true,value:{environments:[],workspace:null}}),status:async(run,input)=>{calls.push({method:'status',run,input});return{ok:true,value:running};},log:async(run,input)=>{calls.push({method:'log',run,input});return{ok:true,value:page()};},stop:async(run,input)=>{calls.push({method:'stop',run,input});return{ok:true,value:{...running,revision:3,stopRequested:{reason:'user',requestedAt:now}}};},...overrides};
 const controller=createCommandExecutionController(ports);controller.setScope({runId:running.runId,workspaceId:running.workspaceId});controller.register([running]);return{controller,calls};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('Q04BR frozen local methods validate envelopes and never expose a launch operation',async()=>{
 const calls:{method:string;input:unknown}[]=[];let invalid=false;
 const api:Parameters<typeof commandExecutionPorts>[0]={
  inspectCommandEnvironment:async input=>{calls.push({method:'environment',input});return{ok:true,value:{environments:[],workspace:null}};},
  listCommandExecutions:async input=>{calls.push({method:'list',input});return{ok:true,value:{executions:[running]}};},
  readCommandExecution:async input=>{calls.push({method:'status',input});return{ok:true,value:{execution:invalid?{...running,revision:0}:running}};},
  readCommandLog:async input=>{calls.push({method:'log',input});return{ok:true,value:{page:page()}};},
  stopCommandExecution:async input=>{calls.push({method:'stop',input});return{ok:false,error:{code:'CLEANUP_FAILED'}};},
 };
 const ports=commandExecutionPorts(api);assert.equal(calls.length,0);assert.deepEqual(Object.keys(ports).sort(),['environment','list','log','status','stop']);
 assert((await ports.environment('run-a')).ok);assert((await ports.list('run-a')).ok);
 assert((await ports.status('run-a',{executionId:running.executionId,afterRevision:2,waitMs:25000})).ok);
 assert((await ports.log('run-a',{executionId:running.executionId,stream:'stdout',offset:0,maxBytes:16384,expectedPrefixVersion:null})).ok);
 const stopped=await ports.stop('run-a',{executionId:running.executionId});assert(!stopped.ok);assert.match(stopped.message,/尚未确认释放/);
 assert.deepEqual(calls[2],{method:'status',input:{contractVersion:AGENT_PROJECT_READ_VERSION,runId:'run-a',executionId:running.executionId,afterRevision:2,waitMs:25000}});
 for(const call of calls)assert.equal((call.input as {contractVersion:string}).contractVersion,AGENT_PROJECT_READ_VERSION);
 const before=calls.length;await assert.rejects(ports.status('run-a',{executionId:running.executionId,afterRevision:2,waitMs:25001}));assert.equal(calls.length,before);
 invalid=true;await assert.rejects(ports.status('run-a',{executionId:running.executionId,afterRevision:2,waitMs:0}));
});

test('Q04BR cold history and environment reads preserve task scope and discard late responses',async()=>{
 const listing=deferred<CommandReadResult<readonly CommandExecution[]>>(),environment=deferred<CommandReadResult<{environments:readonly CommandEnvironment[];workspace:null}>>();
 const f=commandFixture({list:()=>listing.promise,environment:()=>environment.promise});try{
  const a=f.controller.refreshHistory(),b=f.controller.inspectEnvironment();assert(f.controller.snapshot().listing);assert(f.controller.snapshot().inspectingEnvironment);
  f.controller.setScope({runId:'other-run',workspaceId:'other-workspace'});listing.resolve({ok:true,value:[running]});environment.resolve({ok:true,value:{environments:[],workspace:null}});
  assert.equal(await a,false);assert.equal(await b,false);assert.deepEqual(f.controller.snapshot().entries,[]);assert.equal(f.controller.snapshot().environments,null);assert.deepEqual(f.calls,[]);
 }finally{f.controller.dispose();}
 const cold=commandFixture({list:async()=>({ok:true,value:[terminal]})});try{cold.controller.setScope(null);cold.controller.setScope({runId:running.runId,workspaceId:running.workspaceId});assert(await cold.controller.refreshHistory());assert.equal(cold.controller.snapshot().entries[0]?.execution.phase,'terminal');assert.deepEqual(cold.calls,[]);}finally{cold.controller.dispose();}
 const foreign=commandFixture({list:async()=>({ok:true,value:[{...running,runId:'foreign'}]}),environment:async()=>({ok:true,value:{environments:[],workspace:{workspaceId:'foreign',baselineVersion:digest,files:0,bytes:0}}})});try{assert.equal(await foreign.controller.refreshHistory(),false);assert.equal(await foreign.controller.inspectEnvironment(),false);assert.equal(foreign.controller.snapshot().entries[0]?.execution.runId,'run-a');assert.equal(foreign.controller.snapshot().environments,null);}finally{foreign.controller.dispose();}
});

test('Q04BR local status observation waits independently then stops polling on failure or terminal history',async()=>{
 const pending=new Map<number,()=>void>();let serial=0,reads=0,fail=false;const waiting=deferred<CommandReadResult<CommandExecution>>();
 const base=commandFixture();const controller=createCommandExecutionController({list:async()=>({ok:true,value:[running]}),environment:async()=>({ok:true,value:{environments:[],workspace:null}}),
  log:async()=>({ok:true,value:page()}),status:async(_run,input)=>{reads++;assert.equal(input.waitMs,25000);return fail?{ok:false,message:'读取失败'}:waiting.promise;},stop:async()=>({ok:true,value:{...running,revision:3,stopRequested:{reason:'user',requestedAt:now}}})},
  {set:fn=>{pending.set(++serial,fn);return serial;},clear:key=>{pending.delete(key as number);}});
 const tick=async()=>{const timer=pending.entries().next().value!;pending.delete(timer[0]);timer[1]();for(let n=0;n<12;n++)await Promise.resolve();};
 try{controller.setScope({runId:running.runId,workspaceId:running.workspaceId});controller.register([running]);assert.equal(pending.size,0);controller.watch(true);assert.equal(pending.size,1);
  await tick();assert.equal(reads,1);assert.equal(pending.size,0);assert(controller.snapshot().entries[0]?.refreshing);assert(await controller.stop(running.executionId));
  waiting.resolve({ok:true,value:running});for(let n=0;n<12;n++)await Promise.resolve();assert.equal(pending.size,1);fail=true;await tick();assert.equal(reads,2);assert.equal(pending.size,0);assert.match(controller.snapshot().entries[0]?.error??'',/读取失败/);
  controller.setScope(null);controller.setScope({runId:running.runId,workspaceId:running.workspaceId});controller.register([terminal]);assert.equal(pending.size,0);assert.deepEqual(base.calls,[]);
 }finally{controller.dispose();base.controller.dispose();assert.equal(pending.size,0);}
});

test('Q04BR existing tool details keep one live control per execution independently of model completion',()=>{
 const f=commandFixture();try{
  const run:ProjectReadSummary={runId:'run-a',clientRequestId:'client-a',project:{projectId:'project-a',bindingId:'binding-a',name:'合成项目',directoryName:'fixture',directorySegments:['C','fixture'],identity:'identity-a'},model:{provider:'deepseek',model:'deepseek-v4-flash'},goal:'合成命令任务',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:now,updatedAt:now,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:2,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:2,continuation:null,workCycle:{workspaceId:running.workspaceId}};
  const tool=(sequence:number,toolName:'command_start'|'command_status')=>parseProjectReadEvent({runId:run.runId,sequence,time:now,type:'tool.completed',data:{sessionId:'session-a',messageId:'message-a',callId:`call-${sequence}`,toolName,arguments:toolName==='command_start'?{requestId:running.requestId,environmentId:running.environment.environmentId,environmentRevision:running.environment.revision,workspaceId:running.workspaceId,baselineVersion:running.baselineVersion,cwdRelativePath:running.cwdRelativePath,commandText:running.commandText,timeoutMs:120000}:{executionId:running.executionId,afterRevision:null,waitMs:0},result:{ok:true,value:{kind:toolName,execution:running}}}});
  const events=[tool(2,'command_start'),tool(3,'command_status')];assert(events.every(Boolean));
  const actions={setProject:async()=>{},start:async()=>false,answer:async()=>false,stop:async()=>{},refresh:async()=>{},select:async()=>{},older:async()=>{},openCitation:async()=>{},closeCitation:()=>{},continueRun:async()=>false,deleteRun:async()=>false,revalidate:async()=>{},browse:async()=>{},checkCitation:async()=>{},cancelInspection:async()=>false};
  const props={state:{...initialProjectReadState,selectedRun:run,runs:[run],events:events.filter(e=>e!==null)},choices:{activeId:'project-a',projects:[{id:'project-a',name:'合成项目'}]},actions,onCreate:never,commandState:f.controller.snapshot(),commandActions:f.controller};
  const html=renderToStaticMarkup(createElement(ProjectReadView,props));assert.equal((html.match(/>停止这次执行<\/button>/gu)??[]).length,1);assert.match(html,/命令运行中/);assert.match(html,/本次工具返回时的执行状态/);assert.doesNotMatch(html,/调用参数|workbench.agent-project-read|<select[^>]*命令/);assert(!html.includes(digest));
  const cold=renderToStaticMarkup(createElement(ProjectReadView,{...props,state:{...props.state,events:[]}}));assert.match(cold,/已保存的命令执行/);assert.equal((cold.match(/>停止这次执行<\/button>/gu)??[]).length,1);
  const other=renderToStaticMarkup(createElement(ProjectReadView,{...props,commandState:{...props.commandState,scope:{runId:'other-run',workspaceId:'other-workspace'}}}));assert.doesNotMatch(other,/>停止这次执行<\/button>/);
 }finally{f.controller.dispose();}
});

test('Q04ART command artifacts bind exact file version execution manifest and original relative path',async()=>{
 const file:WorkCycleFile={fileId:'artifact-a',version:digest,relativePath:'artifacts/command-a/0/结果.md',bytes:3,confirmation:'confirmed',origin:{kind:'command',executionId:running.executionId,manifestVersion:digest,sourceRelativePath:'output/结果.md'}};
 const execution={...terminal,artifacts:[{fileId:file.fileId,version:file.version}]};
 const html=renderToStaticMarkup(createElement(CommandExecutionArtifacts,{execution,files:[file],onOpenFile:never}));assert.match(html,/命令产物 · 只读/);assert.match(html,/output\/结果.md/);assert.match(html,/原工作文件改动尚未承接/);assert.match(html,/<button[^>]*>artifacts\/command-a\/0\/结果.md<\/button>/);
 const foreign={...file,origin:{...file.origin as Extract<WorkCycleFile['origin'],{kind:'command'}>,manifestVersion:'b'.repeat(64)}};
 const unknown=renderToStaticMarkup(createElement(CommandExecutionArtifacts,{execution,files:[foreign],onOpenFile:never}));assert.doesNotMatch(unknown,/<button/);assert.match(unknown,/文件信息尚待核对/);
 const pending=renderToStaticMarkup(createElement(CommandExecutionArtifacts,{execution,files:[{...file,confirmation:'unconfirmed'}],onOpenFile:never}));assert.match(pending,/写入结果待核对/);
 const calls:unknown[]=[];let changed=false;const model=createWorkCycleInspectionController({list:async()=>({ok:true,value:[file]}),file:async(runId,fileId,version)=>{calls.push({runId,fileId,version});return{ok:true,value:{file:changed?foreign:file,text:'abc',verified:true}};},change:async()=>{throw Error('No edits for command artifacts');}});
 try{model.setScope({runId:running.runId,workspaceId:running.workspaceId});await model.refresh();assert.equal(await model.openFile(foreign),false);assert.equal(calls.length,0);
  assert(await model.openFile(file));assert.deepEqual(calls[0],{runId:running.runId,fileId:file.fileId,version:file.version});const preview=model.snapshot().preview;
  const moved={...file,origin:{...file.origin as Extract<WorkCycleFile['origin'],{kind:'command'}>,sourceRelativePath:'different.md'}};assert.equal(await model.openFile(moved),false);assert.equal(calls.length,1);
  changed=true;assert.equal(await model.openFile(file),false);assert.equal(model.snapshot().preview,preview);assert.match(model.snapshot().previewError??'',/身份或版本核对失败/);
 }finally{model.dispose();}
});

test('Q04CTL history registration never starts actions and rejects other scopes or changed execution versions',async()=>{
 const f=commandFixture();try{assert.equal(f.controller.snapshot().entries.length,1);assert.deepEqual(f.calls,[]);
  assert.equal(await f.controller.refresh('invented'),false);assert.equal(await f.controller.stop('invented'),false);assert.equal(await f.controller.readLog('invented','stdout'),false);assert.deepEqual(f.calls,[]);
  f.controller.register([{...running,executionId:'foreign',runId:'other-run'}]);assert.equal(f.controller.snapshot().entries.length,1);assert.match(f.controller.snapshot().error??'',/不属于/);
  f.controller.register([{...running,commandText:'changed command'}]);assert.equal(f.controller.snapshot().entries[0]?.execution.commandText,running.commandText);
  f.controller.register([{...running,phase:'settling'}]);assert.match(f.controller.snapshot().entries[0]?.error??'',/同一执行版本/);assert.equal(f.controller.snapshot().entries[0]?.execution.phase,'running');
  assert(await f.controller.refresh(running.executionId));assert.equal(f.calls.length,1);
 }finally{f.controller.dispose();}
});

test('Q04CTL status and log reads never block stopping and late lower revisions cannot undo the request',async()=>{
 const status=deferred<CommandReadResult<CommandExecution>>(),logging=deferred<CommandReadResult<CommandLogPage>>();
 const f=commandFixture({status:()=>status.promise,log:()=>logging.promise});try{
  const waiting=f.controller.refresh(running.executionId,25000),reading=f.controller.readLog(running.executionId,'stdout');
  assert(f.controller.snapshot().entries[0]?.refreshing);assert(f.controller.snapshot().entries[0]?.logs.stdout.reading);
  const html=renderToStaticMarkup(createElement(CommandExecutionView,{execution:running,refreshing:true,readingStreams:['stdout'],onRefresh:never,onStop:never,onReadLog:never}));assert.match(html,/<button type="button">停止这次执行<\/button>/);
  assert(await f.controller.stop(running.executionId));assert.equal(f.calls.length,1);assert.equal(f.controller.snapshot().entries[0]?.execution.stopRequested?.reason,'user');
  status.resolve({ok:true,value:running});logging.resolve({ok:true,value:page()});await waiting;await reading;assert.equal(f.controller.snapshot().entries[0]?.execution.revision,3);assert.equal(f.controller.snapshot().entries[0]?.execution.stopRequested?.reason,'user');
 }finally{f.controller.dispose();}
});

test('Q04CTL log pagination pins a snapshot and failed pages preserve the prior display',async()=>{
 let wrong=false;const requests:Parameters<CommandExecutionPorts['log']>[1][]=[];
 const f=commandFixture({log:async(_run,input)=>{requests.push(input);return{ok:true,value:page(input.offset,wrong?'b'.repeat(64):input.expectedPrefixVersion??(input.offset===6?'c'.repeat(64):digest),input.offset===6?9:6)};}});
 try{assert(await f.controller.readLog(running.executionId,'stdout'));const first=f.controller.snapshot().entries[0]!.logs.stdout.page;
  wrong=true;assert.equal(await f.controller.readLog(running.executionId,'stdout','next'),false);assert.equal(f.controller.snapshot().entries[0]?.logs.stdout.page,first);
  wrong=false;assert(await f.controller.readLog(running.executionId,'stdout','next'));assert.deepEqual(requests[2],{executionId:running.executionId,stream:'stdout',offset:3,maxBytes:16384,expectedPrefixVersion:digest});
  assert(await f.controller.readLog(running.executionId,'stdout','latest'));assert.equal(requests[3]?.expectedPrefixVersion,null);assert.equal(requests[3]?.offset,6);assert.equal(f.controller.snapshot().entries[0]?.logs.stdout.page?.prefixVersion,'c'.repeat(64));
 }finally{f.controller.dispose();}
});

test('Q04CTL switching task discards late state and log pages without issuing stop or restart',async()=>{
 const status=deferred<CommandReadResult<CommandExecution>>(),logging=deferred<CommandReadResult<CommandLogPage>>();const f=commandFixture({status:()=>status.promise,log:()=>logging.promise});
 try{const waiting=f.controller.refresh(running.executionId),reading=f.controller.readLog(running.executionId,'stdout');f.controller.setScope({runId:'other-run',workspaceId:'other-workspace'});status.resolve({ok:true,value:terminal});logging.resolve({ok:true,value:page()});assert.equal(await waiting,false);assert.equal(await reading,false);assert.deepEqual(f.controller.snapshot().entries,[]);assert.deepEqual(f.calls,[]);}
 finally{f.controller.dispose();}
});

test('Q04CTL an uncertain stop can only explicitly retry the same known execution',async()=>{
 let lose=true;const calls:unknown[]=[];const f=commandFixture({stop:async(run,input)=>{calls.push({run,input});if(lose)throw Error('Lost response');return{ok:true,value:{...running,revision:3,stopRequested:{reason:'user',requestedAt:now}}};}});
 try{assert.equal(await f.controller.stop(running.executionId),false);assert(f.controller.snapshot().entries[0]?.stopUnconfirmed);assert.equal(commandExecutionState(f.controller.snapshot().entries[0]!.execution).label,'命令运行中');assert.equal(await f.controller.stop('invented'),false);lose=false;assert(await f.controller.stop(running.executionId));assert.deepEqual(calls[0],calls[1]);assert.equal(f.controller.snapshot().entries[0]?.stopUnconfirmed,false);assert.equal(commandExecutionState(f.controller.snapshot().entries[0]!.execution).label,'已请求停止');}
 finally{f.controller.dispose();}
});

test('Q04UI stop completion requires this execution exit tree zero log closure and cleanup proof',()=>{
 const requested:CommandExecution={...running,stopRequested:{reason:'user',requestedAt:now}};
 assert.equal(commandExecutionState(running).canStop,true);assert.equal(commandExecutionState(requested).label,'已请求停止');assert.equal(commandExecutionState(requested).canStop,false);
 const stopped:CommandExecution={...terminal,stopRequested:requested.stopRequested,exit:{...terminal.exit!,termination:'stopped'}};assert.equal(commandExecutionState(stopped).label,'命令已停止');
 const missing:Partial<CommandExecution>[]=[{phase:'settling'},{exit:{...stopped.exit!,shellExited:false}},{job:{...stopped.job,activeProcesses:1}},{job:{...stopped.job,emptyConfirmed:false}},{cleanup:{...stopped.cleanup,state:'pending'}},{cleanup:{...stopped.cleanup,proofSha256:null}},{logs:{...stopped.logs,stdout:log('stdout')}},{logs:{...stopped.logs,stderr:log('stderr')}}];
 for(const patch of missing)assert.notEqual(commandExecutionState({...stopped,...patch}).label,'命令已停止');
 const html=renderToStaticMarkup(createElement(CommandExecutionView,{execution:requested,onStop:never,onRefresh:never,onReadLog:never}));assert.match(html,/<button type="button" disabled="">停止这次执行/);assert.match(html,/核对执行状态/);assert.doesNotMatch(html,/>命令已停止</);
 assert.equal(commandExecutionState({...stopped,phase:'reconciliation_required'}).label,'执行状态待核对');assert.equal(commandExecutionState({...stopped,cleanup:{...stopped.cleanup,state:'failed'}}).label,'执行状态待核对');
});

test('Q04UI actual environment cwd command and error are escaped facts without profile hashes',()=>{
 const execution={...running,commandText:'Write-Output "<script>alert(1)</script>"',error:{code:'START_DENIED',stage:'start' as const,nativeCode:5}};
 const html=renderToStaticMarkup(createElement(CommandExecutionView,{execution,onRefresh:never,onStop:never,onReadLog:never}));assert.match(html,/环境：Windows PowerShell/);assert.match(html,/数据 输入/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script/);assert.match(html,/诊断码：START_DENIED · 启动 · 系统码 5/);assert.match(html,/<details><summary>技术详情/);assert(!html.includes(digest));
 const environment:CommandEnvironment={environmentId:'powershell-a',revision:digest,displayName:'PowerShell 环境',platform:'windows',shell:{kind:'powershell',version:'5.1',sha256:digest,scriptEncoding:'utf8_bom',interactive:false},tools:[{name:'Node',version:'24.20.0',sha256:digest}],isolation:'windows-appcontainer-job',profileRevision:digest,availability:'unavailable',reason:'依赖尚未准入',projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16777216,defaultTimeoutMs:120000,maxTimeoutMs:600000}};
 const envHtml=renderToStaticMarkup(createElement(CommandEnvironmentResults,{environments:[environment]}));assert.match(envHtml,/尚未就绪：依赖尚未准入/);assert.match(envHtml,/PowerShell 5.1/);assert.match(envHtml,/Node 24.20.0/);assert.match(envHtml,/非交互执行/);assert(!envHtml.includes(digest));assert.doesNotMatch(envHtml,/<select|<textarea|<button/);
 assert.match(renderToStaticMarkup(createElement(CommandEnvironmentResults,{environments:[]})),/没有已准入/);
});

test('Q04UI log pages preserve stream byte range encoding gaps and snapshot end distinctions',()=>{
 const page:CommandLogPage={executionId:'command-a',stream:'stderr',prefixVersion:digest,offset:2048,endOffset:2051,snapshotBytes:2051,availableBytes:4096,format:'base64',data:'/wAA',bytesSha256:digest,nextCursor:null,streamClosed:true,coverage:'partial_at_limit',hasNewerBytes:true};
 const html=renderToStaticMarkup(createElement(CommandLogPageView,{page,onNext:never,onLatest:never}));assert.match(html,/错误输出/);assert.match(html,/2048–2051/);assert.match(html,/Base64/);assert.match(html,/\/wAA/);assert.match(html,/未保存内容/);assert.match(html,/不代表此前全部内容已经显示/);assert.match(html,/已有新增日志/);assert.doesNotMatch(html,/>下一页</);assert(!html.includes(digest));
 const utf8={...page,stream:'stdout' as const,offset:0,format:'utf8' as const,data:'<script>not executable</script>',coverage:'open' as const,streamClosed:false,nextCursor:{offset:2051,prefixVersion:digest}};
 const partial=renderToStaticMarkup(createElement(CommandLogPageView,{page:utf8,onNext:never,onLatest:never}));assert.match(partial,/标准输出/);assert.match(partial,/日志仍在写入/);assert.match(partial,/&lt;script&gt;/);assert.match(partial,/>下一页</);assert.doesNotMatch(partial,/<script/);
 const complete=renderToStaticMarkup(createElement(CommandLogPageView,{page:{...page,coverage:'complete',hasNewerBytes:false}}));assert.match(complete,/日志已完整保存/);assert.match(complete,/不代表此前全部内容已经显示/);
});

test('Q04UI shell zero exit does not claim child success or accepted artifacts and failure reasons remain distinct',()=>{
 const html=renderToStaticMarkup(createElement(CommandExecutionView,{execution:terminal}));assert.match(html,/命令已退出/);assert.match(html,/不单独证明每条子命令成功/);assert.match(html,/尚未承接为任务文件/);assert.doesNotMatch(html,/任务已完成|产物已生成并核对/);
 for(const [termination,label] of [['timed_out','命令已超时'],['log_limit','命令达到日志上限'],['fault','命令执行异常'],['failed_start','命令启动失败']] as const)assert.equal(commandExecutionState({...terminal,exit:{...terminal.exit!,termination}}).label,label);
 assert.equal(commandExecutionState({...terminal,exit:{...terminal.exit!,shellExitCode:7}}).label,'命令非零退出');assert.equal(commandExecutionState({...terminal,exit:{...terminal.exit!,shellExitCode:null}}).label,'退出码未确认');
});
