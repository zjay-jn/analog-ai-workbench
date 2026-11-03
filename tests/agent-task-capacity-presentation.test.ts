import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AGENT_PROJECT_READ_VERSION as V,type ProjectReadSummary,type ProjectReadRequests,type ProjectReadEvent,type WorkbenchAgentProjectReadApi} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {TaskCapacity,TaskCapacityEntry} from '../apps/desktop/src/shared/agent/agent-task-capacity';
import {createProjectReadController} from '../apps/desktop/src/renderer/agent/project-read-controller';
import {TaskDeletionPreview,TaskCapacityPanel} from '../apps/desktop/src/renderer/agent/TaskCapacityPanel';
import {ProjectReadView} from '../apps/desktop/src/renderer/agent/ProjectReadPanel';

const time='2026-09-15T00:00:00.000Z';
const project={projectId:'project-a',bindingId:'binding-a',identity:'identity-a',name:'合成项目',directoryName:'synthetic',directorySegments:['C','synthetic']};
const model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const budget={providerAttempts:24,httpDispatches:24,toolAttempts:64,physicalReadBytes:268435456,visitedCandidates:100000,contextBytes:196608,outputBytes:65536,maxOutputTokens:16384,deadlineMs:600000,waitMs:600000};
function fixture(){
 const run:ProjectReadSummary={runId:'run-a',clientRequestId:'client-a',project,model,goal:'合成工作任务',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,
  accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:2,continuation:null,workCycle:{workspaceId:'workspace-a'}};
 const events:ProjectReadEvent[]=[{runId:run.runId,sequence:1,time,type:'run.accepted',data:{project,model,continuedFrom:null,budget,workCycle:run.workCycle!}},{runId:run.runId,sequence:2,time,type:'run.completed',data:{citations:[]}}];
 const entry:TaskCapacityEntry={runId:run.runId,projectId:project.projectId,expectedEventCount:2,capacityVersion:'a'.repeat(64),complete:true,canDelete:true,blockedReason:null,dependentRunIds:[],deletionState:'none',taskBytes:1200,logBytes:2400,workspaceBytes:6400,totalBytes:10000};
 const control={entry,mode:'success' as 'success'|'lost'|'conflict'|'storage',gate:null as Promise<void>|null,capacityFails:false,exists:true};
 const capacityCalls:ProjectReadRequests['getTaskCapacity'][]=[],deletes:ProjectReadRequests['deleteRun'][]=[];
 const ports:Partial<WorkbenchAgentProjectReadApi>={
  getWslResultsBinding:async()=>({ok:true,value:{binding:null}}),
  getStatus:async()=>({ok:true,value:{project,model,availability:'available',canStart:true,processState:'idle',cleanupState:'idle',reason:null,activeTask:null}}),
  listRuns:async()=>({ok:true,value:{runs:control.exists?[run]:[],nextBefore:null}}),
  readRun:async input=>({ok:true,value:{run,events:events.slice(input.after),nextAfter:2,hasMore:false}}),
  getTaskCapacity:async input=>{capacityCalls.push(input);const snapshot=structuredClone(control.entry),exists=control.exists;if(control.gate)await control.gate;if(control.capacityFails)throw Error('Unknown capacity');
   const runs=exists?[snapshot]:[];const value:TaskCapacity={runs,totals:exists?{taskBytes:snapshot.taskBytes,logBytes:snapshot.logBytes,workspaceBytes:snapshot.workspaceBytes,totalBytes:snapshot.totalBytes}:{taskBytes:0,logBytes:0,workspaceBytes:0,totalBytes:0},complete:runs.every(row=>row.complete),measuredAt:time,scope:'tool_tasks',byteMeasure:'logical_file_bytes'};return{ok:true,value};},
  deleteRun:async input=>{deletes.push(input);if(control.mode==='lost')throw Error('Delete reply lost');if(control.mode==='conflict')return{ok:false,error:{code:'CONFLICT'}};if(control.mode==='storage')return{ok:false,error:{code:'STORAGE_FAILED'}};control.exists=false;return{ok:true,value:{deleted:true}};},
 };
 const api=new Proxy(ports,{get:(target,key)=>target[key as keyof typeof target]??(()=>{throw Error('Unexpected bridge call: '+String(key));})}) as WorkbenchAgentProjectReadApi;
 const controller=createProjectReadController(api,{set:()=>0,clear:()=>{}});
 return {controller,api,control,run,deletes,capacityCalls};
}
const deletionHtml=(f:ReturnType<typeof fixture>)=>renderToStaticMarkup(createElement(TaskDeletionPreview,{state:f.controller.snapshot(),actions:f.controller}));

test('CAPUI work deletion requires a current reviewed preview and sends its exact capacity version',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);assert.equal(f.capacityCalls.length,0);assert.equal(await f.controller.deleteRun('run-a'),false);
  assert(await f.controller.prepareDeletion('run-a'));assert.equal(f.deletes.length,0);assert.deepEqual(f.capacityCalls,[{contractVersion:V,projectId:null}]);
  const html=deletionHtml(f);assert.match(html,/合成工作任务/);assert.match(html,/命令日志/);assert.match(html,/工作文件/);assert.match(html,/不代表实际磁盘释放量/);assert.match(html,/<button type="button">确认删除<\/button>/);
  assert(await f.controller.deleteRun('run-a'));assert.deepEqual(f.deletes,[{contractVersion:V,runId:'run-a',expectedEventCount:2,expectedCapacityVersion:'a'.repeat(64)}]);
  assert.equal(f.controller.snapshot().selectedRun,null);assert.equal(f.controller.snapshot().runs.length,0);assert.equal(f.controller.snapshot().deletionPreview,null);assert.equal(f.controller.snapshot().capacity?.totals.totalBytes,0);
 }finally{f.controller.dispose();}
});

test('CAPUI active cleanup reference and incomplete storage facts block deletion and disclose the reason',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);
  const cases=[['active','任务仍在运行'],['cleanup_unconfirmed','收尾尚未确认'],['referenced','仍有其他任务引用'],['storage_unknown','存储状态尚未确认'],['storage_changed','存储内容已变化']] as const;
  for(const [blockedReason,text] of cases){f.control.entry={...f.control.entry,blockedReason,canDelete:false,complete:blockedReason!=='storage_unknown',dependentRunIds:blockedReason==='referenced'?['child-a']:[]};
   assert(await f.controller.prepareDeletion('run-a'));assert.equal(await f.controller.deleteRun('run-a'),false);const html=deletionHtml(f);assert(html.includes(text));assert.match(html,/<button type="button" disabled="">确认删除/);
   if(blockedReason==='referenced')assert.match(html,/child-a/);if(blockedReason==='storage_unknown'){assert.match(html,/无法确定可回收大小/);assert.doesNotMatch(html,/待处理文件的逻辑大小/);}
  }
  assert.equal(f.deletes.length,0);
 }finally{f.controller.dispose();}
});

test('CAPUI failed and uncertain deletion refresh only and require new review before any retry',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);
  for(const mode of ['conflict','lost','storage'] as const){f.control.mode=mode;assert(await f.controller.prepareDeletion('run-a'));const calls=f.capacityCalls.length,attempts=f.deletes.length;
   assert.equal(await f.controller.deleteRun('run-a'),false);assert.equal(f.capacityCalls.length,calls+1);assert.equal(f.controller.snapshot().deletionPreview,null);assert.equal(f.controller.snapshot().runs.length,1);
   assert.equal(await f.controller.deleteRun('run-a'),false);assert.equal(f.deletes.length,attempts+1);assert.match(deletionHtml(f),/重新核对|尚未确认/);
  }
  f.control.entry={...f.control.entry,capacityVersion:'b'.repeat(64),deletionState:'failed',taskBytes:200,totalBytes:9000};f.control.mode='success';
  assert(await f.controller.prepareDeletion('run-a'));assert.match(deletionHtml(f),/此前删除未完成/);assert(await f.controller.deleteRun('run-a'));assert.equal(f.deletes.at(-1)?.expectedCapacityVersion,'b'.repeat(64));
 }finally{f.controller.dispose();}
});

test('CAPUI refreshing cancellation and reopening never retain an armed deletion preview',async()=>{
 const f=fixture();let release!:()=>void;try{await f.controller.setProject(project.projectId);assert(await f.controller.prepareDeletion('run-a'));
  await f.controller.refreshCapacity();assert.equal(f.controller.snapshot().deletionPreview,null);assert.equal(await f.controller.deleteRun('run-a'),false);
  f.control.gate=new Promise<void>(resolve=>{release=resolve;});const old=f.controller.prepareDeletion('run-a');f.controller.cancelDeletion();release();assert.equal(await old,false);assert.equal(f.controller.snapshot().deletionTarget,null);
  f.control.gate=null;const reopened=createProjectReadController(f.api,{set:()=>0,clear:()=>{}});try{await reopened.setProject(project.projectId);assert.equal(reopened.snapshot().deletionPreview,null);assert.equal(await reopened.deleteRun('run-a'),false);assert.equal(f.deletes.length,0);}finally{reopened.dispose();}
 }finally{release?.();f.controller.dispose();}
});

test('CAPUI mismatched capacity identity unreadable storage and blocked pending deletion cannot be confirmed',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);f.control.entry={...f.control.entry,projectId:'foreign-project'};assert.equal(await f.controller.prepareDeletion('run-a'),false);assert.equal(f.controller.snapshot().deletionPreview,null);
  f.control.entry={...f.control.entry,projectId:project.projectId,deletionState:'pending',canDelete:false,blockedReason:'active'};assert(await f.controller.prepareDeletion('run-a'));assert.equal(await f.controller.deleteRun('run-a'),false);assert.match(deletionHtml(f),/此前删除未完成/);
  f.control.capacityFails=true;assert.equal(await f.controller.prepareDeletion('run-a'),false);assert.equal(f.controller.snapshot().capacity,null);assert.match(deletionHtml(f),/容量统计尚未确认/);assert.equal(f.deletes.length,0);
 }finally{f.controller.dispose();}
});

test('CAPUI capacity scope and partial totals are explicit and the existing task entry exposes management',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);f.control.entry={...f.control.entry,complete:false,canDelete:false,blockedReason:'storage_unknown'};
  await f.controller.refreshCapacity();const state=f.controller.snapshot();const html=renderToStaticMarkup(createElement(TaskCapacityPanel,{capacity:state.capacity,loading:false,error:null,onRefresh:()=>{},onClose:()=>{}}));
  assert.match(html,/全部项目的工具任务/);assert.match(html,/文件逻辑字节/);assert.match(html,/统计不完整，仅显示已确认部分/);assert.match(html,/10[,.]?000 字节/);
  const panel=renderToStaticMarkup(createElement(ProjectReadView,{state,choices:{activeId:project.projectId,projects:[{id:project.projectId,name:project.name}]},actions:f.controller,onCreate:()=>{}}));
  assert.match(panel,/存储用量/);assert.match(panel,/查看容量与删除/);assert.doesNotMatch(panel,/工作任务暂不支持删除/);assert.equal(f.deletes.length,0);
 }finally{f.controller.dispose();}
});

test('CAPUI a reopened pending intent follows fresh host permission and requires explicit reviewed retry',async()=>{
 const f=fixture();try{f.control.entry={...f.control.entry,deletionState:'pending',capacityVersion:'c'.repeat(64)};await f.controller.setProject(project.projectId);
  await f.controller.refreshCapacity();assert.equal(f.deletes.length,0);assert.equal(await f.controller.deleteRun('run-a'),false);
  assert(await f.controller.prepareDeletion('run-a'));assert.match(deletionHtml(f),/此前删除未完成/);assert.match(deletionHtml(f),/<button type="button">确认删除<\/button>/);
  assert(await f.controller.deleteRun('run-a'));assert.equal(f.deletes.length,1);assert.equal(f.deletes[0]?.expectedCapacityVersion,'c'.repeat(64));
 }finally{f.controller.dispose();}
});

test('CAPUI shared-cache scope wording is explicit in capacity preview and success without bridge calls',()=>{
 const f=fixture();try{
  const capacity=renderToStaticMarkup(createElement(TaskCapacityPanel,{capacity:null,loading:false,error:null,onRefresh:()=>{},onClose:()=>{}}));
  const preview=renderToStaticMarkup(createElement(TaskDeletionPreview,{state:{...f.controller.snapshot(),deletionTarget:f.run,deletionPreview:f.control.entry},actions:f.controller}));
  for(const html of [capacity,preview]){assert.match(html,/主记录、独占工作文件、命令日志和执行副本/);assert.match(html,/不含共享引擎缓存，其中可能保留会话副本。/);}
  const source=readFileSync('apps/desktop/src/renderer/agent/project-read-controller.ts','utf8');
  const success=source.match(/deletionNotice:'([^']*已删除[^']*)'/u)?.[1];assert(success);
  const notice=renderToStaticMarkup(createElement(TaskDeletionPreview,{state:{...f.controller.snapshot(),deletionNotice:success},actions:f.controller}));
  assert.match(notice,/此任务的主记录、独占工作文件、命令日志和执行副本已删除/);assert.match(notice,/共享引擎缓存保留/);assert.doesNotMatch(notice,/全部.*删除|全部.*清理|任务及其独占数据已删除/);
  assert.equal(f.deletes.length,0);assert.equal(f.capacityCalls.length,0);
 }finally{f.controller.dispose();}
});
