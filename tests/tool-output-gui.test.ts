import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommandExecution,CommandLogPage,CommandLogSummary} from '../apps/desktop/src/shared/agent/agent-command';
import type {ProjectReadToolCall,ProjectReadToolResult,ProjectReadSummary,ProjectReadEvent} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {ChatTurnActivity,ChatTurnExecution} from '../apps/desktop/src/shared/agent/chat-turns';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import {ChatAgentParts} from '../apps/desktop/src/renderer/agent/ChatAgentParts';
import {ProjectReadResults,CommandLogResult} from '../apps/desktop/src/renderer/agent/ProjectReadResults';
import {CommandLogPageView,commandExecutionState} from '../apps/desktop/src/renderer/agent/CommandExecutionResults';
import {createCommandExecutionController,type CommandExecutionPorts,type CommandReadResult} from '../apps/desktop/src/renderer/agent/command-execution-controller';

const digest='a'.repeat(64),now='2026-09-16T12:00:00.000Z',no=()=>{};
const summary=(stream:'stdout'|'stderr'):CommandLogSummary=>({stream,persistedBytes:0,observedBytes:0,prefixVersion:digest,closed:false,coverage:'open',sha256:null});
const running:CommandExecution={executionId:'command-a',runId:'run-a',workspaceId:'workspace-a',requestId:'request-a',signature:digest,environment:{environmentId:'powershell-a',revision:digest,displayName:'Windows PowerShell'},baselineVersion:digest,cwdRelativePath:'fixture',commandText:'synthetic-only',commandSha256:digest,scriptSha256:digest,revision:2,phase:'running',createdAt:now,deadlineAt:'2026-09-16T12:02:00.000Z',startedAt:now,completedAt:null,stopRequested:null,exit:null,job:{activeProcesses:2,emptyConfirmed:false,observedAt:now},cleanup:{state:'pending',observedAt:null,proofSha256:null},logs:{stdout:summary('stdout'),stderr:summary('stderr')},artifacts:[],changes:{state:'pending',manifestVersion:null,count:null,acceptance:'not_requested'},error:null};
function page(offset=0,snapshotBytes=12,length=Math.min(4,snapshotBytes-offset),patch:Partial<CommandLogPage>={}):CommandLogPage{
 const endOffset=offset+length;
 return {executionId:running.executionId,stream:'stdout',prefixVersion:digest,offset,endOffset,snapshotBytes,availableBytes:snapshotBytes,format:'utf8',data:'x'.repeat(length),bytesSha256:digest,nextCursor:endOffset<snapshotBytes?{offset:endOffset,prefixVersion:digest}:null,streamClosed:false,coverage:'open',hasNewerBytes:false,...patch};
}
function fixture(log:CommandExecutionPorts['log']){
 const controller=createCommandExecutionController({log,list:async()=>({ok:true,value:[running]}),environment:async()=>({ok:true,value:{environments:[],workspace:null}}),status:async()=>({ok:true,value:running}),stop:async()=>({ok:false,message:'not used'})});
 controller.setScope({runId:running.runId,workspaceId:running.workspaceId});controller.register([running]);return controller;
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const call=(toolName:'command_log',p:CommandLogPage):ProjectReadToolCall=>({sessionId:'engine-a',messageId:'message-a',callId:'call-a',toolName,arguments:{executionId:p.executionId,stream:p.stream,offset:p.offset,maxBytes:4096,expectedPrefixVersion:null}});
const execution:ChatTurnExecution={executionId:'chat-execution',version:4,requestDigest:digest,acceptedContext:{projectId:'project-a',workspaceRevision:1,bindingId:'binding-a',bindingIdentity:digest,provider:'kimi',model:'kimi-k3',historyVersion:digest},phase:'running',cleanupState:'idle',runLink:{runId:running.runId,workspaceId:running.workspaceId},parentTurnId:null,pendingInteraction:null};
const run:ProjectReadSummary={runId:running.runId,clientRequestId:'request-a',project:{projectId:'project-a',bindingId:'binding-a',identity:digest,name:'合成项目',directoryName:'fixture',directorySegments:['C','fixture']},model:{provider:'kimi',model:'kimi-k3'},goal:'合成大输出展示',constraint:'',continuedFrom:null,status:'running',cleanupState:'idle',createdAt:now,updatedAt:now,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:1,continuation:null};
const turn:SessionTurn={id:'turn-a',user:'合成任务',assistant:'',status:'running',error:'',execution};
function chat(result:ProjectReadToolResult,p=page()){
 const event:ProjectReadEvent={runId:run.runId,sequence:1,time:now,type:'tool.completed',data:{...call('command_log',p),result}};
 const activity:ChatTurnActivity={sessionId:'session-a',turnId:turn.id,version:4,execution,run,parts:[{kind:'run_event',partId:'part-a',sequence:1,runId:run.runId,event}],nextSequence:1,hasMore:false};
 return renderToStaticMarkup(createElement(ChatAgentParts,{turn,activity,onRetry:no,onOpen:no,onAdvance:no}));
}
const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:()=>({matches:true})}});
test.after(()=>{if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');});

test('partial and pending successful tool pages stay distinct from failure without dumping data into chat',()=>{
 const partial=page(0,4000,20,{data:'synthetic-log-secret'}); // Rendering uses the saved result, not an IPC re-read.
 const html=chat({ok:true,value:{kind:'command_log',page:partial}},partial);
 assert.match(html,/已返回部分内容/);assert.doesNotMatch(html,/查看结果|运行记录|synthetic-log-secret|读取命令日志未完成|本轮失败原因/);
 const empty=page(12,12,0);assert.match(chat({ok:true,value:{kind:'command_log',page:empty}},empty),/暂无新增内容/);
 const limited=page(8,12,4,{streamClosed:true,coverage:'partial_at_limit'});assert.match(chat({ok:true,value:{kind:'command_log',page:limited}},limited),/已返回 · 保存不完整/);
 assert.match(chat({ok:false,error:{code:'IO_ERROR'},coverage:null}),/command_log 未完成/);
});

test('current EOF, unknown closure and full saved log do not imply execution ended or all earlier pages viewed',()=>{
 const partial=renderToStaticMarkup(createElement(CommandLogPageView,{page:page(),onNext:no,onLatest:no}));
 assert.match(partial,/>下一页</);assert.doesNotMatch(partial,/检查新增日志/);
 const eof=renderToStaticMarkup(createElement(CommandLogPageView,{page:page(12,12,0),onNext:no,onLatest:no}));
 assert.match(eof,/读到当前末尾不表示命令已结束/);assert.match(eof,/检查新增日志/);assert.doesNotMatch(eof,/>下一页</);
 const unknown=renderToStaticMarkup(createElement(CommandLogPageView,{page:page(8,12,4,{coverage:'complete',availableBytes:16,hasNewerBytes:true}),onLatest:no}));
 assert.match(unknown,/当前日志关闭状态尚未确认/);assert.doesNotMatch(unknown,/日志仍在写入/);
 const closed=renderToStaticMarkup(createElement(CommandLogPageView,{page:page(8,12,4,{coverage:'complete',streamClosed:true}),onLatest:no}));
 assert.match(closed,/日志已完整保存/);assert.match(closed,/不代表此前全部内容已经显示/);assert.doesNotMatch(closed,/检查新增日志/);
 assert.equal(commandExecutionState(running).label,'命令运行中');
});

test('historic log result shows its immutable returned page and offers explicit exact continuation without reading on render',async()=>{
 let reads=0;const controller=fixture(async()=>{reads++;return {ok:true,value:page(8,12,4,{data:'live'})};});
 try{
  const original=page(0,12,4,{data:'past'});await controller.readLog(running.executionId,'stdout','next',page(4));assert.equal(reads,1);
  const html=renderToStaticMarkup(createElement(CommandLogResult,{page:original,entry:controller.snapshot().entries[0]!,actions:controller}));
  assert.match(html,/工具当时返回的日志片段/);assert.match(html,/past/);assert.doesNotMatch(html,/live/);assert.match(html,/>下一页</);assert.equal(reads,1);assert.equal(original.data,'past');
 }finally{controller.dispose();}
});

test('historic continuation pins the returned snapshot, never restarts unread large logs, and stores one bounded page',async()=>{
 const requests:Parameters<CommandExecutionPorts['log']>[1][]=[];
 const controller=fixture(async(_run,input)=>{requests.push(input);return {ok:true,value:page(input.offset,60000,Math.min(input.maxBytes,60000-input.offset))};});
 try{
  const original=page(0,60000,4096),before=JSON.stringify(original);
  assert.equal(await controller.readLog(running.executionId,'stdout','latest'),false);
  assert.equal(await controller.readLog(running.executionId,'stdout','latest',original),false);assert.equal(requests.length,0);
  assert(await controller.readLog(running.executionId,'stdout','next',original));
  while(controller.snapshot().entries[0]!.logs.stdout.page!.nextCursor)assert(await controller.readLog(running.executionId,'stdout','next'));
  assert.deepEqual(requests.map(request=>request.offset),[4096,20480,36864,53248]);
  for(const request of requests){assert.equal(request.expectedPrefixVersion,digest);assert.equal(request.maxBytes,16384);}
  const last=controller.snapshot().entries[0]!.logs.stdout.page!;assert.equal(last.offset,53248);assert.equal(last.endOffset,60000);assert.equal(last.data.length,6752);
  assert.equal(JSON.stringify(original),before);assert.equal(controller.snapshot().entries[0]!.execution.phase,'running');
 }finally{controller.dispose();}
});

test('refresh at current EOF reads only appended bytes and never promotes running execution to completed',async()=>{
 const requests:Parameters<CommandExecutionPorts['log']>[1][]=[];let appended=false;
 const controller=fixture(async(_run,input)=>{requests.push(input);return {ok:true,value:page(input.offset,appended?16:12,appended?4:0,{prefixVersion:appended?'b'.repeat(64):digest})};});
 try{
  const eof=page(12,12,0);assert.equal(await controller.readLog(running.executionId,'stdout','next',eof),false);assert.equal(requests.length,0);
  assert(await controller.readLog(running.executionId,'stdout','latest',eof));appended=true;assert(await controller.readLog(running.executionId,'stdout','latest'));
  assert.deepEqual(requests.map(p=>[p.offset,p.expectedPrefixVersion]),[[12,null],[12,null]]);
  assert.equal(controller.snapshot().entries[0]!.logs.stdout.page!.endOffset,16);assert.equal(commandExecutionState(controller.snapshot().entries[0]!.execution).label,'命令运行中');
 }finally{controller.dispose();}
});

test('reopening the same scope cannot accept earlier success or failure from a historic-page read',async()=>{
 for(const late of [{ok:true as const,value:page(4)},{ok:false as const,message:'old failure'}]){
  const pending=deferred<CommandReadResult<CommandLogPage>>();let calls=0;
  const controller=fixture(async()=>{calls++;return calls===1?pending.promise:{ok:true,value:page(8)};});
  try{
   const first=controller.readLog(running.executionId,'stdout','next',page());
   assert.equal(await controller.readLog(running.executionId,'stdout','next',page()),false);assert.equal(calls,1);
   controller.setScope({runId:'other-run',workspaceId:'other-workspace'});controller.setScope({runId:running.runId,workspaceId:running.workspaceId});controller.register([running]);
   assert(await controller.readLog(running.executionId,'stdout','next',page(4)));pending.resolve(late);assert.equal(await first,false);
   const log=controller.snapshot().entries[0]!.logs.stdout;assert.equal(log.page!.offset,8);assert.equal(log.error,null);assert.equal(log.reading,false);
  }finally{controller.dispose();}
 }
});

test('work file preview reports Unicode byte range and keeps the version-checked full file action',()=>{
 const file={fileId:'file-a',version:digest,relativePath:'report.md',bytes:300,confirmation:'confirmed' as const,origin:{kind:'write' as const,changeId:'change-a'}};
 const result:ProjectReadToolResult={ok:true,value:{kind:'work_read',file,offset:20,text:'中文',nextOffset:26}};
 const read:ProjectReadToolCall={sessionId:'engine-a',messageId:'message-a',callId:'work-a',toolName:'work_read',arguments:{fileId:file.fileId,version:digest,offset:20}};
 const html=renderToStaticMarkup(createElement(ProjectReadResults,{result,runId:run.runId,call:read,onCitation:no,onWorkFile:no,onWorkChange:no}));
 assert.match(html,/返回 6 字节，范围 20–26/);assert.match(html,/来源共 300 字节/);assert.match(html,/工作文件保存在本地/);assert.match(html,/<button[^>]*>report.md<\/button>/);assert.match(html,/文件尚未读完/);
});

test('project reference preserves row positions and continuation without claiming a full local source copy',()=>{
 const next={line:10,column:3},result:ProjectReadToolResult={ok:true,value:{kind:'read',phase:'data',snapshotId:'snapshot-a',rules:[],resume:null,empty:false,next,
  coverage:{scope:{projectId:'project-a',bindingId:'binding-a',identity:digest,directoryId:null,relativeDirectory:''},complete:false,scannedCandidates:1,scannedFiles:1,scannedBytes:100,returned:1,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},remaining:{directories:0,files:0,position:next},nextCursor:'cursor-a',limitReason:'bytes'},
  citation:{citationId:'citation-a',fileId:'file-a',relativePath:'source.md',version:digest,normalizedSha256:digest,range:{start:{line:8,column:1},end:next},excerpt:'节选',excerptSha256:digest,totalLines:100,fileBytes:1000,source:'read'}}};
 const read:ProjectReadToolCall={sessionId:'engine-a',messageId:'message-a',callId:'read-a',toolName:'project_read',arguments:{fileId:'file-a',version:digest,start:{line:8,column:1},cursor:null}};
 const html=renderToStaticMarkup(createElement(ProjectReadResults,{result,runId:run.runId,call:read,onCitation:no}));
 assert.match(html,/已保存引用片段/);assert.match(html,/未另存整份文件/);assert.match(html,/原任务运行期间从已记录的位置继续读取/);assert.match(html,/第 8 行，第 1 列/);assert.match(html,/第 10 行，第 3 列/);assert.doesNotMatch(html,/工作文件保存在本地|日志已完整保存/);
});
