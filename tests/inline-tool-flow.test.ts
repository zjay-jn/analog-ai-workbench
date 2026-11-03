import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatAgentParts,chatToolActivityLabel,chatToolSubject,chatToolSummarySubject,chatToolDurations,chatToolOperation} from '../apps/desktop/src/renderer/agent/ChatAgentParts';
import type {CommandExecution,CommandLogSummary} from '../apps/desktop/src/shared/agent/agent-command';
import type {ProjectReadEvent,ProjectReadSummary,ProjectReadToolCall,ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {ChatTurnActivity,ChatTurnExecution} from '../apps/desktop/src/shared/agent/chat-turns';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';

const digest='a'.repeat(64),time='2026-10-27T00:00:00.000Z',no=()=>{};
const log=(stream:'stdout'|'stderr'):CommandLogSummary=>({stream,persistedBytes:0,observedBytes:0,prefixVersion:digest,closed:false,coverage:'open',sha256:null});
const running:CommandExecution={executionId:'command-a',runId:'run-a',workspaceId:'workspace-a',requestId:'request-a',signature:digest,environment:{environmentId:'fixture-environment',revision:digest,displayName:'合成环境'},baselineVersion:digest,cwdRelativePath:'fixture',commandText:'synthetic-command --fixture',commandSha256:digest,scriptSha256:digest,revision:2,phase:'running',createdAt:time,deadlineAt:time,startedAt:time,completedAt:null,stopRequested:null,exit:null,job:{activeProcesses:1,emptyConfirmed:false,observedAt:time},cleanup:{state:'pending',observedAt:null,proofSha256:null},logs:{stdout:log('stdout'),stderr:log('stderr')},artifacts:[],changes:{state:'pending',manifestVersion:null,count:null,acceptance:'not_requested'},error:null};
const call:ProjectReadToolCall={sessionId:'engine-a',messageId:'message-a',callId:'call-a',toolName:'command_start',arguments:{requestId:running.requestId,environmentId:running.environment.environmentId,environmentRevision:digest,workspaceId:running.workspaceId,baselineVersion:digest,cwdRelativePath:'fixture',commandText:running.commandText,timeoutMs:1000}};
const result=(execution:CommandExecution):ProjectReadToolResult=>({ok:true,value:{kind:'command_start',execution}});
const execution:ChatTurnExecution={executionId:'chat-a',version:1,requestDigest:digest,acceptedContext:{projectId:'project-a',workspaceRevision:1,bindingId:'binding-a',bindingIdentity:digest,provider:'kimi',model:'kimi-k3',historyVersion:digest},phase:'running',cleanupState:'idle',runLink:{runId:running.runId,workspaceId:running.workspaceId},parentTurnId:null,pendingInteraction:null};
const run:ProjectReadSummary={runId:running.runId,clientRequestId:running.requestId,project:{projectId:'project-a',bindingId:'binding-a',identity:digest,name:'合成项目',directoryName:'fixture',directorySegments:['C','fixture']},model:{provider:'kimi',model:'kimi-k3'},goal:'合成执行行展示',constraint:'',continuedFrom:null,status:'running',cleanupState:'idle',createdAt:time,updatedAt:time,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:1,continuation:null};
function render(value:ProjectReadToolResult|null,phase:ChatTurnExecution['phase']='running'){
 const current={...execution,phase};
 const event:ProjectReadEvent=value?{runId:run.runId,sequence:1,time,type:'tool.completed',data:{...call,result:value}}:{runId:run.runId,sequence:1,time,type:'tool.started',data:call};
 const turn:SessionTurn={id:'turn-a',user:'合成请求',assistant:'',status:phase==='running'?'running':'failed',error:'',execution:current};
 const activity:ChatTurnActivity={sessionId:'session-a',turnId:turn.id,version:1,execution:current,run:{...run,status:phase==='running'?'running':'failed'},parts:[{kind:'run_event',partId:'part-a',sequence:1,runId:run.runId,event}],nextSequence:1,hasMore:false};
 return renderToStaticMarkup(createElement(ChatAgentParts,{turn,activity,onRetry:no,onOpen:no,onAdvance:no}));
}
const summary=(html:string)=>html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1]??'';
const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:()=>({matches:true})}});
test.after(()=>{if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');});

test('command launch receipts distinguish requested, started and returned execution without claiming success',()=>{
 assert.equal(chatToolActivityLabel(call,result({...running,phase:'starting',startedAt:null}),false),'发起了命令');
 assert.equal(chatToolActivityLabel(call,result(running),false),'启动了命令');
 const exited:CommandExecution={...running,phase:'terminal',completedAt:time,exit:{termination:'exited',shellExitCode:3,shellExited:true,observedAt:time},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},logs:{stdout:{...log('stdout'),closed:true,coverage:'complete'},stderr:{...log('stderr'),closed:true,coverage:'complete'}}};
 assert.equal(chatToolActivityLabel(call,result(exited),false),'启动了命令');
 const label=chatToolActivityLabel(call,result({...exited,cleanup:{state:'confirmed',observedAt:time,proofSha256:digest}}),false);
 assert.equal(label,'运行了命令');assert.doesNotMatch(label,/成功|完成/);
 const failedStart={...running,phase:'terminal' as const,startedAt:null,exit:{termination:'failed_start' as const,shellExitCode:null,shellExited:false,observedAt:time}};
 assert.equal(chatToolActivityLabel(call,result(failedStart),false),'发起了命令');
});

test('a successful stop tool receipt describes the request while cleanup is still pending',()=>{
 const stop:ProjectReadToolCall={...call,toolName:'command_stop',arguments:{executionId:running.executionId}};
 const value:ProjectReadToolResult={ok:true,value:{kind:'command_stop',execution:{...running,stopRequested:{reason:'user',requestedAt:time}}}};
 assert.equal(chatToolActivityLabel(stop,value,false),'执行了');
 assert.match(chatToolOperation(stop,'synthetic-command --fixture'),/^command_stop /);
 assert.doesNotMatch(chatToolActivityLabel(stop,value,false),/已停止|停止了|完成|成功/);
});

test('tool summaries retain the actual command after return; only unmatched active tools show progress',()=>{
 const active=render(null),activeSummary=summary(active);
 assert.match(activeSummary,/正在执行命令/);assert.match(activeSummary,/chat-tool-progress/);assert.match(activeSummary,/synthetic-command --fixture/);
 assert.doesNotMatch(activeSummary,/chat-tool-state|进行中/);
 const returned=render(result(running)),returnedSummary=summary(returned);
 assert.match(returnedSummary,/启动了命令/);assert.match(returnedSummary,/synthetic-command --fixture/);assert.doesNotMatch(returnedSummary,/已返回|chat-tool-state|chat-tool-progress/);
 assert.match(returned,/class="chat-tool-target">synthetic-command --fixture/);assert.doesNotMatch(returned,/查看结果|运行记录|在图中定位/);assert.doesNotMatch(returned,/<details[^>]*open/);
 const interrupted=render(null,'failed'),interruptedSummary=summary(interrupted);
 assert.match(interruptedSummary,/未确认完成/);assert.doesNotMatch(interruptedSummary,/正在|chat-tool-progress/);
});

test('file edit subjects expose only the stored relative filename, never edit bodies or opaque IDs',()=>{
 const edit:ProjectReadToolCall={sessionId:'s',messageId:'m',callId:'c',toolName:'work_edit',arguments:{fileId:'opaque-file',expectedVersion:digest,oldText:'private-before',newText:'private-after'}};
 const edited:ProjectReadToolResult={ok:true,value:{kind:'work_edit',file:{fileId:'opaque-file',relativePath:'analysis/check.js',version:digest,bytes:10,confirmation:'confirmed',origin:{kind:'write',changeId:'opaque-change'}},previousVersion:digest,changeId:'opaque-change',changed:true}};
 assert.equal(chatToolSubject(edit,edited),'analysis/check.js');assert.equal(chatToolSubject(edit,null),'');
 assert.equal(chatToolSummarySubject(edit,'analysis/check.js'),'check.js');assert.equal(chatToolSummarySubject(edit,'analysis\\check.js'),'check.js');
 assert.equal(chatToolSummarySubject(call,'node analysis/check.js'),'node analysis/check.js');
});

test('tool duration pairs stored timestamps from the same run and call; missing or invalid evidence stays absent',()=>{
 const part=(type:'tool.started'|'tool.completed',runId:string,at:string):ChatTurnActivity['parts'][number]=>({kind:'run_event',partId:type+runId,sequence:1,runId,event:type==='tool.started'
  ?{type,runId,sequence:1,time:at,data:call}:{type,runId,sequence:2,time:at,data:{...call,result:result(running)}}});
 const base:ChatTurnActivity={sessionId:'session-a',turnId:'turn-a',version:1,execution:null,run:null,parts:[],nextSequence:1,hasMore:false};
 const elapsed=chatToolDurations({...base,parts:[part('tool.started','run-a',time),part('tool.completed','run-other','2026-10-27T00:00:00.500Z'),part('tool.completed','run-a','2026-10-27T00:00:00.850Z')]});
 assert.equal(elapsed.get(JSON.stringify(['run-a',call.callId])),850);assert.equal(elapsed.has(JSON.stringify(['run-other',call.callId])),false);
 assert.equal(chatToolDurations({...base,parts:[part('tool.completed','run-a',time)]}).size,0);
 assert.equal(chatToolDurations({...base,parts:[part('tool.started','run-a',time),part('tool.completed','run-a','2026-10-26T23:59:59Z')]}).size,0);
 assert.equal(chatToolDurations({...base,parts:[part('tool.started','run-a','invalid'),part('tool.completed','run-a',time)]}).size,0);
});
