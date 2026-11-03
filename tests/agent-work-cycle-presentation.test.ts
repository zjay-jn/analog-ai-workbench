import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {WorkCycleExecution,WorkCycleFile,WorkCycleToolValue} from '../apps/desktop/src/shared/agent/agent-work-cycle';
import {workExecutionOutcome,workExecutionActiveLabel,reconcileWorkValue,isWorkCycleValue} from '../apps/desktop/src/renderer/agent/work-cycle-presentation';
import {projectReadEvents} from '../apps/desktop/src/renderer/agent/project-read-presentation';
import {ProjectReadResults} from '../apps/desktop/src/renderer/agent/ProjectReadResults';
import {WorkCycleResults,WorkCycleFiles,WorkCycleExecutionResult,WorkCycleFilePreview,WorkCycleChangePreview} from '../apps/desktop/src/renderer/agent/WorkCycleResults';

const file:WorkCycleFile={fileId:'opaque-file-id',relativePath:'results/report.md',version:'a'.repeat(64),bytes:20,confirmation:'confirmed',origin:{kind:'execution',executionId:'execution-a'}};
const execution:WorkCycleExecution={executionId:'execution-a',language:'javascript',isolation:'windows-appcontainer',script:{fileId:'script-id',version:'b'.repeat(64)},inputs:[],termination:'exited',exitCode:0,signal:null,durationMs:34,stdout:'computed',stderr:'',stdoutTruncated:false,stderrTruncated:false,artifacts:[file],verified:true,cleanupConfirmed:true};
const onOpenFile=()=>{throw Error('Rendering must not open files');},onOpenChange=()=>{throw Error('Rendering must not open changes');};

test('C1C inherited reports retain open controls and cannot count as this execution artifacts',()=>{
 const inherited:WorkCycleFile={...file,fileId:'child-report',relativePath:'artifacts/execution-parent/report.md',origin:{kind:'continuation',source:{runId:'parent',workspaceId:'workspace-parent',fileId:'parent-report',version:file.version,baselineVersion:'b'.repeat(64)}}};
 const html=renderToStaticMarkup(createElement(WorkCycleFiles,{files:[inherited],onOpenFile}));assert.match(html,/承接自原任务/);assert.match(html,/原报告与产物只读/);assert.match(html,/title="打开已核对的工作文件"/);assert.doesNotMatch(html,/本次产物|分析生成/);
 assert.equal(workExecutionOutcome({...execution,artifacts:[inherited]}).kind,'pending');
 const result=renderToStaticMarkup(createElement(WorkCycleExecutionResult,{execution,onOpenFile}));assert.match(result,/本次产物/);assert.doesNotMatch(result,/承接自原任务/);
});

test('work delivery requires confirmed successful exit and verified artifacts from that execution',()=>{
 assert.equal(workExecutionOutcome(execution).kind,'verified');
 for(const patch of [{cleanupConfirmed:false},{verified:false},{exitCode:null},{signal:'SIGTERM'},{artifacts:[]},{artifacts:[{...file,confirmation:'unconfirmed' as const}]},{artifacts:[{...file,origin:{kind:'execution' as const,executionId:'other-execution'}}]},{artifacts:[{...file,origin:{kind:'write' as const,changeId:'old-write'}}]}])assert.equal(workExecutionOutcome({...execution,...patch}).kind,'pending');
 for(const termination of ['timed_out','cancelled','limit','isolation_failed'] as const)assert.equal(workExecutionOutcome({...execution,termination}).kind,'failed');
 assert.equal(workExecutionOutcome({...execution,exitCode:1}).kind,'failed');
 assert.match(workExecutionOutcome(execution).detail,/是否满足任务要求/);
});

test('failed analysis shows actual exit and bounded plain logs without executing markup',()=>{
 const html=renderToStaticMarkup(createElement(WorkCycleExecutionResult,{execution:{...execution,exitCode:2,stderr:'<script>fetch("https://example.invalid")</script>',stderrTruncated:true,artifacts:[],verified:false},onOpenFile}));
 assert.match(html,/分析执行失败/);assert.match(html,/退出码：2/);assert.match(html,/错误输出已截断/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<iframe|href=/);assert.doesNotMatch(html,/产物已生成并核对/);
});

test('unconfirmed write is never described as saved and only offers identity based controls',()=>{
 const html=renderToStaticMarkup(createElement(WorkCycleResults,{value:{kind:'work_write',file:{...file,confirmation:'unconfirmed',origin:{kind:'write',changeId:'opaque-change'}},previousVersion:null,changeId:'opaque-change',changed:true},onOpenFile,onOpenChange}));
 assert.match(html,/文件写入结果待核对/);assert.match(html,/results\/report.md/);assert.match(html,/查看差异/);assert.doesNotMatch(html,/已创建|已保存|opaque-file-id|opaque-change|href=/);
});

test('work file and change previews reuse safe Markdown and exact before after text',()=>{
 const html=renderToStaticMarkup(createElement(WorkCycleFilePreview,{content:{file,text:'# 分析报告\n\n**结果**\n\n![remote](https://example.invalid/a.png)',verified:true}}));
 assert.match(html,/<h1>分析报告<\/h1>/);assert.match(html,/<strong>结果<\/strong>/);assert.doesNotMatch(html,/<img|<script/);
 const diff=renderToStaticMarkup(createElement(WorkCycleChangePreview,{change:{changeId:'change-a',file,previousVersion:'b'.repeat(64),before:'same\nold <script>\ntail',after:'same\nnew\ntail',changed:true}}));
 assert.match(diff,/修改前全文/);assert.match(diff,/修改后全文/);assert.match(diff,/diff-removed/);assert.match(diff,/diff-added/);assert.match(diff,/old &lt;script&gt;/);assert.doesNotMatch(diff,/<script/);
});

test('partial work reads and stopped pending analysis do not claim complete delivery',()=>{
 const html=renderToStaticMarkup(createElement(WorkCycleResults,{value:{kind:'work_read',file,text:'first fragment',offset:0,nextOffset:14},onOpenFile,onOpenChange}));
 assert.match(html,/文件尚未读完/);assert.match(workExecutionActiveLabel(true,false),/等待实际退出/);assert.match(workExecutionActiveLabel(false,true),/未自动重新执行/);
});

test('historical confirmed execution cannot override latest workspace downgrade or missing version',()=>{
 const value={kind:'work_run' as const,execution};
 for(const latest of [[],[{...file,confirmation:'unconfirmed' as const}],[{...file,version:'c'.repeat(64)}],[{...file,origin:{kind:'write' as const,changeId:'other'}}]]){
  const result=reconcileWorkValue(value,latest);assert.equal(result.kind,'work_run');if(result.kind==='work_run')assert.equal(workExecutionOutcome(result.execution).kind,'pending');
  const html=renderToStaticMarkup(createElement(ProjectReadResults,{result:{ok:true,value},onCitation:()=>{},onWorkFile:onOpenFile,onWorkChange:onOpenChange,currentFiles:latest}));
  assert.doesNotMatch(html,/产物已生成并核对/);
 }
 const result=reconcileWorkValue(value,[file]);if(result.kind==='work_run')assert.equal(workExecutionOutcome(result.execution).kind,'verified');
});

test('execution failure instructions allow correction in the active task',()=>{
 for(const patch of [{exitCode:2},{termination:'timed_out' as const},{termination:'limit' as const}]){
  const detail=workExecutionOutcome({...execution,...patch}).detail;assert.match(detail,/修改程序后再运行/);assert.doesNotMatch(detail,/后续任务|新任务/);
 }
});

test('C1E incremental edit reuses confirmed diff controls and respects current workspace downgrade',()=>{
 const edited:WorkCycleFile={...file,origin:{kind:'write',changeId:'edit-a'}};
 const value:WorkCycleToolValue={kind:'work_edit',file:edited,changeId:'edit-a',previousVersion:'b'.repeat(64),changed:true};
 assert(isWorkCycleValue(value));
 const show=(currentFiles:readonly WorkCycleFile[],changed=true)=>renderToStaticMarkup(createElement(ProjectReadResults,{result:{ok:true,value:{...value,changed,previousVersion:changed?value.previousVersion:edited.version}},onCitation:()=>{},onWorkFile:onOpenFile,onWorkChange:onOpenChange,currentFiles}));
 const confirmed=show([edited]);assert.match(confirmed,/工作文件修改已核对/);assert.match(confirmed,/查看差异/);assert.doesNotMatch(confirmed,/已创建|分析结果|写入结果待核对/);
 for(const latest of [[],[{...edited,confirmation:'unconfirmed' as const}],[{...edited,version:'c'.repeat(64)}]]){const html=show(latest);assert.match(html,/文件写入结果待核对/);assert.doesNotMatch(html,/工作文件修改已核对|已保存/);}
 assert.match(show([edited],false),/工作文件内容未改变/);
});

test('C1E incremental edit events enter the existing work projection without a new rules or execution path',()=>{
 const edited:WorkCycleFile={...file,origin:{kind:'write',changeId:'edit-a'}};
 const value:WorkCycleToolValue={kind:'work_edit',file:edited,changeId:'edit-a',previousVersion:'b'.repeat(64),changed:true};
 const projection=projectReadEvents([{runId:'run-a',sequence:1,time:'2026-09-13T12:00:00.000Z',type:'tool.completed',data:{sessionId:'session-a',messageId:'message-a',callId:'call-edit',toolName:'work_edit',arguments:{fileId:file.fileId,expectedVersion:'b'.repeat(64),oldText:'old',newText:'new'},result:{ok:true,value}}}]);
 assert.deepEqual(projection.workValues,[value]);assert.deepEqual(projection.ruleChunks,[]);assert.equal(projection.timeline.length,1);assert.equal(projection.timeline[0]?.kind,'tool');
});
