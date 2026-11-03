import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AGENT_PROJECT_READ_VERSION as V,type WorkbenchAgentProjectReadApi,type ProjectReadEvent,type ProjectReadSummary,type ProjectReadRequests} from '../apps/desktop/src/shared/agent/agent-project-read';
import {WSL_RESULTS_VERSION,type WslResultsBinding,type WslResultsReadValue,type WslResultsListValue} from '../apps/desktop/src/shared/agent/wsl-results';
import {createProjectReadController,projectCanStart} from '../apps/desktop/src/renderer/agent/project-read-controller';
import {projectMessageCitations,projectReadEvents} from '../apps/desktop/src/renderer/agent/project-read-presentation';
import {ProjectReadView} from '../apps/desktop/src/renderer/agent/ProjectReadPanel';
import {ProjectReadResults} from '../apps/desktop/src/renderer/agent/ProjectReadResults';
import {WslResultsView,WslResultsSettings,WslCitationContext} from '../apps/desktop/src/renderer/agent/WslResultsView';

const time='2026-09-15T00:00:00.000Z';
const binding:WslResultsBinding={distro:'ROCKY9_LLM_LAB',user:'maxwell',rootPath:'/home/maxwell/simulation/fixture-a',id:'wsl-binding-a',rootIdentity:'1:10',readerVersion:WSL_RESULTS_VERSION,selectedAt:time};
const read:WslResultsReadValue={kind:'wsl_results_read',source:{...binding,relativePath:'result.csv',absolutePath:binding.rootPath+'/result.csv'},fileId:'wsl-file-a',fileIdentity:'1:2',version:'1:2:120:3:4',rawSha256:'a'.repeat(64),excerptSha256:'b'.repeat(64),startLine:1,endLine:2,totalLines:2,fileBytes:120,text:'frequency,gain\n1000,20',nextLine:null,complete:true,citationId:'wsl-citation-a',physicalReadBytes:120,scannedCandidates:1};
const project={projectId:'project-a',bindingId:'binding-a',identity:'identity-a',name:'合成项目',directoryName:'synthetic',directorySegments:['C','synthetic']};
const model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const budget={providerAttempts:24,httpDispatches:24,toolAttempts:64,physicalReadBytes:268435456,visitedCandidates:100000,contextBytes:196608,outputBytes:65536,maxOutputTokens:16384,deadlineMs:600000,waitMs:600000};
function fixture(){
 const run:ProjectReadSummary={runId:'run-a',clientRequestId:'client-a',project,model,goal:'读取合成历史结果',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,
  accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:1,physicalReadBytes:120,visitedCandidates:1,contextBytes:null},eventCount:4,continuation:null,wslResultsBinding:binding};
 const call={sessionId:'session-a',messageId:'message-a',callId:'call-a',toolName:'wsl_results_read',arguments:{bindingId:binding.id,fileId:read.fileId,version:read.version,startLine:1,maxLines:200}} as const;
 const events:ProjectReadEvent[]=[{runId:run.runId,sequence:1,time,type:'run.accepted',data:{project,model,continuedFrom:null,budget,wslResultsBinding:binding}},
  {runId:run.runId,sequence:2,time,type:'tool.started',data:call},{runId:run.runId,sequence:3,time,type:'tool.completed',data:{...call,result:{ok:true,value:read}}},
  {runId:run.runId,sequence:4,time,type:'run.completed',data:{citations:[read.citationId]}}];
 const saved=new Map<string,WslResultsBinding|null>([[project.projectId,binding],['project-b',null]]),calls:string[]=[];
 const selects:ProjectReadRequests['selectWslResultsBinding'][]=[],clears:ProjectReadRequests['clearWslResultsBinding'][]=[],resolves:ProjectReadRequests['resolveWslResultsCitation'][]=[],checks:ProjectReadRequests['checkWslResultsCitation'][]=[];
 const control={mode:'success' as 'success'|'lost'|'busy',clearLost:false,getFails:false,getGate:null as Promise<void>|null,resolveGate:null as Promise<void>|null,resolved:read,
  checkState:'current' as 'current'|'changed'|'unavailable',checkMismatch:false};
 const ports:Partial<WorkbenchAgentProjectReadApi>={
  getStatus:async input=>({ok:true,value:{project:{...project,projectId:input.projectId},model,availability:'available',canStart:true,processState:'idle',cleanupState:'idle',reason:null,activeTask:null}}),
  getWslResultsBinding:async input=>{calls.push('get-binding');const snapshot=saved.get(input.projectId)??null;if(control.getGate)await control.getGate;if(control.getFails)throw Error('Get failed');return{ok:true,value:{binding:snapshot}};},
  selectWslResultsBinding:async input=>{calls.push('select');selects.push(input);if(control.mode==='busy')return{ok:false,error:{code:'BUSY'}};const next={...binding,...input.selection,id:'wsl-binding-next'};saved.set(input.projectId,next);if(control.mode==='lost')throw Error('Reply lost');return{ok:true,value:{binding:next}};},
  clearWslResultsBinding:async input=>{calls.push('clear');clears.push(input);saved.set(input.projectId,null);if(control.clearLost)throw Error('Clear reply lost');return{ok:true,value:{binding:null}};},
  listRuns:async()=>({ok:true,value:{runs:[run],nextBefore:null}}),
  readRun:async input=>({ok:true,value:{run,events:events.slice(input.after),nextAfter:events.length,hasMore:false}}),
  resolveWslResultsCitation:async input=>{calls.push('resolve');resolves.push(input);const value=structuredClone(control.resolved);if(control.resolveGate)await control.resolveGate;return{ok:true,value};},
  checkWslResultsCitation:async input=>{calls.push('check');checks.push(input);return{ok:true,value:{citationId:control.checkMismatch?'wsl-foreign':input.citationId,state:control.checkState,reason:control.checkState==='current'?null:control.checkState==='changed'?'SOURCE_CHANGED':'ROOT_UNAVAILABLE'}};},
 };
 const api=new Proxy(ports,{get:(target,key)=>target[key as keyof typeof target]??(()=>{throw Error('Unexpected bridge call: '+String(key));})}) as WorkbenchAgentProjectReadApi;
 return {api,controller:createProjectReadController(api,{set:()=>0,clear:()=>{}}),saved,calls,selects,clears,resolves,checks,control,run,events};
}

test('WSLUI saved project selection is explicit and never changes historical run source',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);assert(projectCanStart(f.controller.snapshot()));assert.equal(f.selects.length,0);assert.equal(f.resolves.length,0);assert.equal(f.checks.length,0);
  assert(await f.controller.selectWslBinding('/home/maxwell/simulation/fixture-next'));
  assert.deepEqual(f.selects,[{contractVersion:V,projectId:project.projectId,selection:{distro:'ROCKY9_LLM_LAB',user:'maxwell',rootPath:'/home/maxwell/simulation/fixture-next'}}]);
  assert.equal(f.controller.snapshot().wslBinding?.id,'wsl-binding-next');assert.equal(f.controller.snapshot().selectedRun?.wslResultsBinding?.id,binding.id);
  const html=renderToStaticMarkup(createElement(WslResultsSettings,{state:f.controller.snapshot(),actions:f.controller}));assert.match(html,/ROCKY9_LLM_LAB/);assert.match(html,/maxwell/);assert.match(html,/fixture-next/);assert.match(html,/后续任务来源/);
  assert(await f.controller.clearWslBinding());assert.deepEqual(f.clears,[{contractVersion:V,projectId:project.projectId,expectedBindingId:'wsl-binding-next'}]);assert.equal(f.controller.snapshot().wslBinding,null);assert.equal(f.controller.snapshot().selectedRun?.wslResultsBinding?.id,binding.id);
 }finally{f.controller.dispose();}
});

test('WSLUI invalid selection BUSY and uncertain writes never auto retry or claim the wrong source',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);assert.equal(await f.controller.selectWslBinding('/home/maxwell/.ssh'),false);assert.equal(f.selects.length,0);
  f.control.mode='busy';assert.equal(await f.controller.selectWslBinding('/home/maxwell/simulation/fixture-next'),false);assert.match(f.controller.snapshot().wslBindingNotice??'',/正在使用或核对/);assert.equal(f.controller.snapshot().wslBinding?.id,binding.id);
  f.control.mode='lost';assert.equal(await f.controller.selectWslBinding('/home/maxwell/simulation/fixture-next'),false);assert.equal(f.selects.length,2);assert.equal(f.controller.snapshot().wslBinding?.id,'wsl-binding-next');assert.match(f.controller.snapshot().wslBindingNotice??'',/没有自动重试/);
  f.control.clearLost=true;assert.equal(await f.controller.clearWslBinding(),false);assert.equal(f.clears.length,1);assert.equal(f.controller.snapshot().wslBinding,null);
  f.control.getFails=true;assert.equal(await f.controller.refreshWslBinding(),false);assert.equal(projectCanStart(f.controller.snapshot()),false);assert.match(f.controller.snapshot().wslBindingError??'',/保存状态尚未确认/);
 }finally{f.controller.dispose();}
});

test('WSLUI saved-state responses from another project are discarded',async()=>{
 const f=fixture();let release!:()=>void;try{f.control.getGate=new Promise<void>(resolve=>{release=resolve;});const old=f.controller.setProject(project.projectId);
  for(let i=0;i<5;i++)await Promise.resolve();f.control.getGate=null;await f.controller.setProject('project-b');release();await old;
  assert.equal(f.controller.snapshot().projectId,'project-b');assert.equal(f.controller.snapshot().wslProjectId,'project-b');assert.equal(f.controller.snapshot().wslBinding,null);assert.equal(f.selects.length,0);
 }finally{release?.();f.controller.dispose();}
});

test('WSLUI history resolve is local-only and checking the current source is a distinct explicit action',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);const projection=projectReadEvents(f.controller.snapshot().events);
  assert.deepEqual(projectMessageCitations('[资料:wsl-citation-a] [资料:invented]',projection.wslCitations).map(c=>c.citationId),[read.citationId]);
  await f.controller.openCitation(read.citationId);assert.deepEqual(f.resolves,[{contractVersion:V,runId:f.run.runId,citationId:read.citationId}]);assert.equal(f.checks.length,0);assert.equal(f.controller.snapshot().wslCitation?.text,read.text);
  for(const state of ['current','changed','unavailable'] as const){f.control.checkState=state;await f.controller.checkCitation();assert.equal(f.controller.snapshot().citationCheck?.state,state);assert.equal(f.controller.snapshot().wslCitation?.text,read.text);
   const html=renderToStaticMarkup(createElement(WslCitationContext,{value:read,state:f.controller.snapshot(),onCheck:()=>{}}));assert.match(html,/打开历史引用不会访问 WSL 源文件/);assert(html.includes(state==='current'?'文件版本一致':state==='changed'?'源文件已变化':'当前文件无法核对'));}
  assert.equal(f.resolves.length,1);assert.equal(f.checks.length,3);f.controller.closeCitation();assert.equal(f.controller.snapshot().wslCitation,null);
 }finally{f.controller.dispose();}
});

test('WSLUI mismatched citation identities and late resolve replies do not replace a validated view',async()=>{
 const f=fixture();let release!:()=>void;try{await f.controller.setProject(project.projectId);
  f.control.resolved={...read,text:'changed history'};await f.controller.openCitation(read.citationId);assert.equal(f.controller.snapshot().wslCitation,null);assert.match(f.controller.snapshot().citationError??'',/来源或版本无法确认/);
  f.control.resolved=read;f.control.resolveGate=new Promise<void>(resolve=>{release=resolve;});const old=f.controller.openCitation(read.citationId);f.controller.closeCitation();release();await old;assert.equal(f.controller.snapshot().wslCitation,null);
  f.control.resolveGate=null;await f.controller.openCitation(read.citationId);f.control.checkMismatch=true;await f.controller.checkCitation();assert.equal(f.controller.snapshot().citationCheck,null);assert.equal(f.controller.snapshot().wslCitation?.text,read.text);
  const previous=f.controller.snapshot().selectedRun;Object.assign(f.run,{wslResultsBinding:{...binding,rootIdentity:'9:9'}});await f.controller.poll();assert.equal(f.controller.snapshot().selectedRun,previous);assert.match(f.controller.snapshot().error??'',/身份\/顺序异常/);
 }finally{release?.();f.controller.dispose();}
});

test('WSLUI directory metadata suffix coverage and source errors remain accurately labelled',()=>{
 const list:WslResultsListValue={kind:'wsl_results_list',binding,relativeDirectory:'',entries:[{name:'ac.ac',relativePath:'ac.ac',kind:'file',readability:'binary_result',bytes:240,fileId:null,version:null}],nextCursor:'wsl-page-next',complete:false,scannedCandidates:24,physicalReadBytes:0};
 const listHtml=renderToStaticMarkup(createElement(WslResultsView,{value:list,onCitation:()=>{}}));assert.match(listHtml,/本次目录查询尚未结束/);assert.match(listHtml,/尚未读取波形/);assert.match(listHtml,/未读取文件正文/);
 const suffix=renderToStaticMarkup(createElement(WslResultsView,{value:{...read,startLine:2,text:'1000,20'},onCitation:()=>{}}));assert.match(suffix,/本片段不包含此前各行/);assert.doesNotMatch(suffix,/完整文件已读取/);
 const error=renderToStaticMarkup(createElement(ProjectReadResults,{toolName:'wsl_results_read',result:{ok:false,error:{code:'ROOT_UNAVAILABLE'},coverage:null},onCitation:()=>{}}));assert.match(error,/实验 WSL 结果目录暂时无法访问/);assert.doesNotMatch(error,/原项目目录/);
});

test('WSLUI readonly WSL task explains new-task requirement without disabling unrelated source-free continuation',async()=>{
 const f=fixture();try{await f.controller.setProject(project.projectId);assert.equal(await f.controller.continueRun(),false);assert.match(f.controller.snapshot().error??'',/该任务使用了 WSL 结果，请新建任务/);
  const html=renderToStaticMarkup(createElement(ProjectReadView,{state:f.controller.snapshot(),choices:{activeId:project.projectId,projects:[{id:project.projectId,name:project.name}]},actions:f.controller,onCreate:()=>{}}));
  assert.match(html,/本任务的 WSL 来源/);assert.match(html,/读取 WSL 结果/);assert.match(html,/已读取 WSL 依据/);assert.match(html,/请新建任务重新读取当前来源/);assert.doesNotMatch(html,/开始后续任务/);
  const clean={...f.controller.snapshot(),events:[f.events[0]!,{...f.events[3]!,sequence:2}],error:null};
  const cleanHtml=renderToStaticMarkup(createElement(ProjectReadView,{state:clean,choices:{activeId:project.projectId,projects:[{id:project.projectId,name:project.name}]},actions:f.controller,onCreate:()=>{}}));assert.match(cleanHtml,/开始后续任务/);
 }finally{f.controller.dispose();}
});

