import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {EnginePilotView} from '../apps/desktop/src/renderer/agent/EnginePilotPanel';
import {ProjectCitationViewer} from '../apps/desktop/src/renderer/agent/ProjectCitationViewer';
import {ProjectReadResults} from '../apps/desktop/src/renderer/agent/ProjectReadResults';
import type {ProjectReadCoverage} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {ProjectReadEvent,ProjectReadEventData,ProjectReadRef,ProjectReadStatus,ProjectReadSummary,ProjectReadCitation,ProjectReadRequests,WorkbenchAgentProjectReadApi} from '../apps/desktop/src/shared/agent/agent-project-read';
import {createProjectReadController,initialProjectReadState,projectCanStart} from '../apps/desktop/src/renderer/agent/project-read-controller';
import {projectReadEvents,projectMessageCitations} from '../apps/desktop/src/renderer/agent/project-read-presentation';
import {ProjectReadView} from '../apps/desktop/src/renderer/agent/ProjectReadPanel';
import {ProjectTaskScope,projectChoiceSnapshot} from '../apps/desktop/src/renderer/agent/ProjectTaskScope';
import {initialEnginePilotState,projectPilotEvents} from '../apps/desktop/src/renderer/agent/engine-pilot-controller';
import {PILOT_RULES_REVISION,parsePilotEvent,type PilotEvent} from '../apps/desktop/src/shared/agent/engine-pilot';
import type {AgentSkillDescriptor,AgentSkillSource} from '../apps/desktop/src/shared/agent/agent-skills';
import type {ProjectReadCitationPreview,ProjectReadToolValue,ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';
import {parseProjectReadEvent,parseProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import type {WorkCycleRecovery} from '../apps/desktop/src/shared/agent/agent-work-cycle';
import {PROJECT_READ_DEFAULT_MODEL,type ProjectReadModel} from '../apps/desktop/src/shared/agent/agent-project-model';
import {ModelSettingsDialog} from '../apps/desktop/src/renderer/agent/ModelSettingsDialog';
import {AGENT_PROJECT_READ_VERSION} from '../apps/desktop/src/shared/agent/agent-project-read';

const runId='pilot.11111111-1111-4111-8111-111111111111',time='2026-09-11T08:00:00.000Z';
function event(sequence:number,type:PilotEvent['type'],data:unknown){return parsePilotEvent({runId,sequence,time,type,data});}
const accepted=()=>event(1,'run.accepted',{goal:'合成任务',constraint:'',engineKind:'opencode',engineVersion:'1.18.17',model:{provider:'deepseek',model:'deepseek-v4-flash'},rulesRevision:PILOT_RULES_REVISION});
const actions={start:async()=>false,answer:async()=>false,stop:async()=>{},select:async()=>{},refresh:async()=>{}};

const projectA:Extract<ProjectReadRef,{bindingId:string}>={projectId:'project-a',bindingId:'binding-a',name:'项目A',directoryName:'fixture-a',directorySegments:['C','synthetic','fixture-a'],identity:'identity-a'};
const projectB:ProjectReadRef={...projectA,projectId:'project-b',bindingId:'binding-b',name:'项目B',directoryName:'fixture-b',directorySegments:['C','synthetic','fixture-b'],identity:'identity-b'};
const projectModel={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const accounting={providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null};
const budget={providerAttempts:24,httpDispatches:24,toolAttempts:64,physicalReadBytes:268435456,visitedCandidates:100000,contextBytes:196608,outputBytes:65536,maxOutputTokens:16384,deadlineMs:600000,waitMs:600000};
function projectEvent<K extends keyof ProjectReadEventData>(sequence:number,type:K,data:ProjectReadEventData[K],run='run-a'):ProjectReadEvent{return {runId:run,sequence,time,type,data} as ProjectReadEvent;}
const projectAccepted=(project=projectA,run='run-a')=>projectEvent(1,'run.accepted',{project,model:projectModel,continuedFrom:null,budget},run);
function projectFixture(overrides:Partial<WorkbenchAgentProjectReadApi>={}){
  const runs:ProjectReadSummary[]=[],events=new Map<string,ProjectReadEvent[]>(),calls:string[]=[],starts:ProjectReadRequests['startRun'][]=[];
  const scheduled=new Map<number,()=>void>();let serial=0,requestSerial=0;
  const status=(projectId:string):ProjectReadStatus=>({model:projectModel,project:projectId===projectB.projectId?projectB:projectA,availability:'unchecked',canStart:!runs.some(run=>['preparing','running','waiting_user'].includes(run.status)||run.cleanupState!=='idle'),processState:'idle',cleanupState:'idle',reason:null,activeTask:null});
  const api:WorkbenchAgentProjectReadApi={getStatus:async input=>{calls.push('status');return{ok:true,value:status(input.projectId)};},selectModel:async()=>{throw Error('Unexpected model selection');},listRuns:async()=>{calls.push('list');return{ok:true,value:{runs:[...runs],nextBefore:null}};},
    resolveWaveformCitation:async()=>{throw Error('Unexpected waveform history resolve');},checkWaveformCitation:async()=>{throw Error('Unexpected waveform source check');},
    getWslResultsBinding:async()=>({ok:true,value:{binding:null}}),selectWslResultsBinding:async()=>{throw Error('Unexpected WSL selection');},clearWslResultsBinding:async()=>{throw Error('Unexpected WSL clear');},resolveWslResultsCitation:async()=>{throw Error('Unexpected WSL citation');},checkWslResultsCitation:async()=>{throw Error('Unexpected WSL source check');},
    getTaskCapacity:async()=>({ok:true,value:{runs:runs.map(run=>({runId:run.runId,projectId:run.project.projectId,expectedEventCount:run.eventCount,capacityVersion:'a'.repeat(64),complete:true,canDelete:true,blockedReason:null,dependentRunIds:[],deletionState:'none',taskBytes:0,logBytes:0,workspaceBytes:0,totalBytes:0})),totals:{taskBytes:0,logBytes:0,workspaceBytes:0,totalBytes:0},complete:true,measuredAt:time,scope:'tool_tasks',byteMeasure:'logical_file_bytes'}}),
    startWorkRun:async()=>{throw Error('Unexpected work start');},prepareWorkContinuation:async()=>{throw Error('Unexpected work preparation');},listWorkFiles:async()=>{throw Error('Unexpected work list');},readWorkFile:async()=>{throw Error('Unexpected work read');},readWorkChange:async()=>{throw Error('Unexpected work diff');},
    inspectCommandEnvironment:async()=>{throw Error('Unexpected command environment');},listCommandExecutions:async()=>{throw Error('Unexpected command list');},openCommandDiagnostics:async()=>{throw Error('Unexpected diagnostic open');},readCommandDiagnostics:async()=>{throw Error('Unexpected diagnostic read');},readCommandExecution:async()=>{throw Error('Unexpected command status');},readCommandLog:async()=>{throw Error('Unexpected command log');},stopCommandExecution:async()=>{throw Error('Unexpected command stop');},
    startRun:async input=>{calls.push('start');starts.push(input);const project=input.projectId===projectB.projectId?projectB:projectA;events.set('run-a',[projectEvent(1,'run.accepted',{project,model:input.model,continuedFrom:null,budget})]);runs.unshift({runId:'run-a',clientRequestId:input.clientRequestId,project,model:input.model,goal:input.goal,constraint:input.constraint,continuedFrom:null,status:'preparing',cleanupState:'idle',createdAt:time,updatedAt:time,accounting,eventCount:1,continuation:null});return{ok:true,value:{runId:'run-a'}};},
    readRun:async input=>{calls.push('read');const run=runs.find(item=>item.runId===input.runId)!;const all=events.get(input.runId)??[],page=all.slice(input.after,input.after+32);return{ok:true,value:{run:{...run,eventCount:all.length},events:page,nextAfter:input.after+page.length,hasMore:input.after+page.length<all.length}};},
    answerQuestion:async()=>{calls.push('answer');return{ok:true,value:{accepted:true}};},stopRun:async()=>{calls.push('stop');return{ok:true,value:{accepted:true}};},
    revalidateProject:async()=>{throw Error('Unexpected revalidation');},resolveCitation:async()=>{calls.push('citation');return{ok:false,error:{code:'FILE_UNAVAILABLE'}};},
    checkCitation:async()=>{throw Error('Unexpected current file read');},browseProject:async()=>{throw Error('Unexpected browsing');},cancelInspection:async()=>{throw Error('Unexpected inspection');},deleteRun:async()=>{throw Error('Delete not yet frozen');},...overrides};
  const controller=createProjectReadController(api,{set:fn=>{scheduled.set(++serial,fn);return serial;},clear:key=>{scheduled.delete(key as number);}},()=>`client-${++requestSerial}`);
  return {api,controller,runs,events,calls,starts,scheduled};
}

const modelStatus=(model:ProjectReadModel):ProjectReadStatus=>({model,project:projectA,availability:'available',canStart:true,processState:'idle',cleanupState:'idle',reason:null,activeTask:null});
function modelFixture(){
 const control={model:PROJECT_READ_DEFAULT_MODEL,loseResponse:false,failStatus:false,selectGate:null as Promise<void>|null,staleStatusGate:null as Promise<void>|null};
 const selections:ProjectReadRequests['selectModel'][]=[];
 const f=projectFixture({
  selectModel:async input=>{selections.push(input);await control.selectGate;control.model=input.model;if(control.loseResponse)throw Error('Synthetic lost response');return{ok:true,value:{model:control.model}};},
  getStatus:async()=>{if(control.failStatus)throw Error('Synthetic unavailable status');const model=control.model,gate=control.staleStatusGate;control.staleStatusGate=null;await gate;return{ok:true,value:modelStatus(model)};},
 });return{...f,control,selections};
}

test('MODELUI confirmed K3 and DeepSeek selections reach the actual next start request',async()=>{
 for(const target of [{provider:'kimi',model:'kimi-k3'},projectModel] as const){
  const f=modelFixture();try{
   await f.controller.setProject(projectA.projectId);assert.deepEqual(f.controller.snapshot().status?.model,{provider:'kimi',model:'kimi-k3'});
   assert(await f.controller.selectModel(target));assert.deepEqual(f.selections,[{contractVersion:AGENT_PROJECT_READ_VERSION,model:target}]);
   assert.deepEqual(f.controller.snapshot().status?.model,target);assert(await f.controller.start('Model identity fixture',''));
   assert.deepEqual(f.starts[0]?.model,target);assert.deepEqual(f.controller.snapshot().selectedRun?.model,target);
  }finally{f.controller.dispose();}
 }
});

test('MODELUI lost selection responses read back actual state without retries or fallback',async()=>{
 const f=modelFixture();try{
  await f.controller.setProject(projectA.projectId);f.control.loseResponse=true;
  assert.equal(await f.controller.selectModel(projectModel),false);assert.equal(f.selections.length,1);
  assert.deepEqual(f.controller.snapshot().status?.model,projectModel);assert.match(f.controller.snapshot().modelSelectionError!,/未确认/);
  f.control.failStatus=true;assert.equal(await f.controller.selectModel(PROJECT_READ_DEFAULT_MODEL),false);
  assert.equal(f.selections.length,2);assert.equal(f.controller.snapshot().status,null);assert.equal(projectCanStart(f.controller.snapshot()),false);
  assert.equal(await f.controller.start('Must not start',''),false);assert.equal(f.starts.length,0);
 }finally{f.controller.dispose();}
});

test('MODELUI changing the next model does not block stopping or relabel the active run',async()=>{
 const f=modelFixture();let release!:()=>void;
 try{
  await f.controller.setProject(projectA.projectId);assert(await f.controller.start('Active model fixture',''));
  const original=structuredClone(f.controller.snapshot().selectedRun!.model);
  f.control.selectGate=new Promise<void>(resolve=>{release=resolve;});const changing=f.controller.selectModel(projectModel);
  assert.equal(f.controller.snapshot().modelSelecting,true);assert.equal(f.controller.snapshot().pending,null);
  await f.controller.stop();assert(f.calls.includes('stop'));assert.equal(f.controller.snapshot().stopAccepted,true);
  release();assert(await changing);assert.deepEqual(f.controller.snapshot().status?.model,projectModel);
  assert.deepEqual(f.controller.snapshot().selectedRun?.model,original);assert.equal(f.starts.length,1);
 }finally{release?.();f.controller.dispose();}
});

test('MODELUI an earlier status response cannot overwrite a newly confirmed model',async()=>{
 const f=modelFixture();let release!:()=>void;
 try{
  await f.controller.setProject(projectA.projectId);
  f.control.staleStatusGate=new Promise<void>(resolve=>{release=resolve;});const refreshing=f.controller.refresh();
  assert(await f.controller.selectModel(projectModel));release();await refreshing;
  assert.deepEqual(f.controller.snapshot().status?.model,projectModel);assert.equal(f.controller.snapshot().modelSelecting,false);
 }finally{release?.();f.controller.dispose();}
});

test('MODELUI next model picker and saved run labels remain separate and settings open the selected service',async()=>{
 const f=modelFixture();try{
  await f.controller.setProject(projectA.projectId);await f.controller.selectModel(projectModel);await f.controller.start('Historical DeepSeek fixture','');
  await f.controller.selectModel(PROJECT_READ_DEFAULT_MODEL);
  const render=(state=f.controller.snapshot())=>renderToStaticMarkup(createElement(ProjectReadView,{state,choices:{projects:[],activeId:projectA.projectId},actions:f.controller,onCreate:()=>{throw Error('No action from static markup');}}));
  const html=render();assert.match(html,/value="kimi-k3" selected=""/);assert.match(html,/本次模型：DeepSeek V4 Flash/);assert.match(html,/>Kimi K3</);
  assert.doesNotMatch(html,/<select aria-label="下次任务模型"[^>]*disabled/);assert.match(render({...f.controller.snapshot(),startUnconfirmed:true}),/<select aria-label="下次任务模型"[^>]*disabled/);
  const never=()=>{throw Error('Static settings must not access persisted data');};
  const settings=renderToStaticMarkup(createElement(ModelSettingsDialog,{api:{readSettings:never,saveSettings:never},running:false,purpose:'tools',initialProvider:'kimi',onClose:never,onSaved:never}));
  assert.match(settings,/value="kimi" selected=""/);assert.match(settings,/支持 Kimi K3 和 DeepSeek V4 Flash/);assert.doesNotMatch(settings,/仅支持 DeepSeek/);
 }finally{f.controller.dispose();}
});

function workContinuationFixture(){
  const prepared:ProjectReadRequests['prepareWorkContinuation'][]=[],started:ProjectReadRequests['startWorkRun'][]=[];
  const statusReads:('CLEANUP_FAILED'|'HISTORY_FULL'|null)[]=[];
  const controls:{prepareCode:'CONFLICT'|'BUSY'|'CLEANUP_FAILED'|null;startCode:'CONFLICT'|'CLEANUP_FAILED'|null;blocked:'CLEANUP_FAILED'|'HISTORY_FULL'|null;lost:boolean;wrongBaseline:boolean;recovery:WorkCycleRecovery|null;unblockOnPrepare:boolean;lostAfterAccept:boolean;prepareGate:Promise<void>|null}={prepareCode:null,startCode:null,blocked:null,lost:false,wrongBaseline:false,recovery:null,unblockOnPrepare:false,lostAfterAccept:false,prepareGate:null};
  let child=0;
  const f=projectFixture({
    getStatus:async()=>{statusReads.push(controls.blocked);return{ok:true,value:{model:projectModel,project:projectA,availability:controls.blocked?'unavailable':'available',canStart:!controls.blocked,processState:'idle',cleanupState:controls.blocked==='CLEANUP_FAILED'?'failed':'idle',reason:controls.blocked,activeTask:null}};},
    prepareWorkContinuation:async input=>{prepared.push(input);if(controls.prepareGate)await controls.prepareGate;if(controls.prepareCode)return{ok:false,error:{code:controls.prepareCode}};const parent=f.runs.find(run=>run.runId===input.runId)!;if(controls.unblockOnPrepare)controls.blocked=null;return{ok:true,value:{baseline:{runId:parent.runId,workspaceId:controls.wrongBaseline?'foreign-workspace':parent.workCycle!.workspaceId,eventCount:parent.eventCount,baselineVersion:'c'.repeat(64),...(controls.recovery?{recovery:structuredClone(controls.recovery)}:{})},fileCount:2,bytes:25}};},
    startWorkRun:async input=>{started.push(input);if(controls.lost)throw Error('Lost response');if(controls.startCode)return{ok:false,error:{code:controls.startCode}};
      const runId=`child-${++child}`,parent=f.runs.find(run=>run.runId===input.continuedFrom);
      const workCycle={workspaceId:`workspace-${runId}`,...(input.continuedFrom!==null?{continuation:{runId:input.continuedFrom,workspaceId:parent!.workCycle!.workspaceId,eventCount:input.expectedEventCount,baselineVersion:input.baselineVersion,...(input.recoveryVersion&&controls.recovery?{recovery:structuredClone(controls.recovery)}:{})}}:{})};
      const run:ProjectReadSummary={runId,clientRequestId:input.clientRequestId,project:projectA,model:input.model,goal:input.goal,constraint:input.constraint,continuedFrom:input.continuedFrom,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting,eventCount:2,continuation:null,workCycle};
      f.runs.unshift(run);f.events.set(runId,[projectEvent(1,'run.accepted',{project:projectA,model:projectModel,continuedFrom:input.continuedFrom,budget,workCycle},runId),projectEvent(2,'run.completed',{citations:[]},runId)]);if(controls.lostAfterAccept)throw Error('Acceptance reply lost');return{ok:true,value:{runId}};
    },
  });
  const workCycle={workspaceId:'workspace-parent'};
  f.runs.push({runId:'parent',clientRequestId:'client-parent',project:projectA,model:projectModel,goal:'原目标：生成分析报告',constraint:'保留缺失数据说明',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting,eventCount:2,continuation:null,workCycle});
  f.events.set('parent',[projectEvent(1,'run.accepted',{project:projectA,model:projectModel,continuedFrom:null,budget,workCycle},'parent'),projectEvent(2,'run.completed',{citations:[]},'parent')]);
  return {...f,prepared,started,controls,statusReads};
}
const continuationHtml=(f:ReturnType<typeof workContinuationFixture>)=>renderToStaticMarkup(createElement(ProjectReadView,{state:f.controller.snapshot(),choices:{activeId:projectA.projectId,projects:[{id:projectA.projectId,name:projectA.name}]},actions:f.controller,onCreate:()=>{throw Error('No creation while rendering');}}));

const interruptedRecovery=():WorkCycleRecovery=>({version:'d'.repeat(64),parentEventsSha256:'e'.repeat(64),controller:{guardianId:'12345678-1234-4123-8123-123456789abc',guardianPid:50101,enginePid:50102,intentVersion:'f'.repeat(64),readyVersion:'1'.repeat(64),resultVersion:'2'.repeat(64)},commands:[{executionId:'command-a',requestId:'request-a',signature:'3'.repeat(64),revision:7,recordVersion:'4'.repeat(64),cleanupProofSha256:'5'.repeat(64),termination:'stopped',shellExitCode:1}]});
function interruptedFixture(){
 const f=workContinuationFixture(),parent=f.runs[0]!;f.runs[0]={...parent,status:'interrupted',cleanupState:'failed',eventCount:4};
 f.events.set(parent.runId,[f.events.get(parent.runId)![0]!,projectEvent(2,'cleanup.started',{reason:'close'},parent.runId),projectEvent(3,'cleanup.completed',{outcome:'failed'},parent.runId),projectEvent(4,'run.interrupted',{reason:'restart'},parent.runId)]);
 f.controls.recovery=interruptedRecovery();return f;
}

test('ICUI main review enables explicit continuation while the interrupted parent and its events remain unchanged',async()=>{
 const f=interruptedFixture();try{f.controls.blocked='CLEANUP_FAILED';f.controls.unblockOnPrepare=true;await f.controller.setProject(projectA.projectId);
  const parent=JSON.stringify(f.runs[0]),events=JSON.stringify(f.events.get('parent'));const before=continuationHtml(f);assert.match(before,/<button type="button">核对后继续<\/button>/);assert.match(before,/已中断/);
  assert.equal(await f.controller.continueWork('尚未核对不能开始',''),false);assert(await f.controller.prepareWorkContinuation());assert.equal(f.started.length,0);assert.deepEqual(f.statusReads.slice(-2),['CLEANUP_FAILED',null]);assert(projectCanStart(f.controller.snapshot()));
  const html=continuationHtml(f);assert.match(html,/已核对 2 个文件，共 25 字节/);assert.match(html,/已核定控制进程收尾及 1 次命令记录/);assert.match(html,/原任务仍为已中断/);assert.match(html,/不会自动重跑旧命令/);assert(!html.includes(f.controls.recovery!.version));assert(!html.includes('50101'));assert(!html.includes(f.controls.recovery!.controller.guardianId));
  assert(await f.controller.continueWork('承接已确认报告，核对下一步','保持数据来源说明'));const request=f.started[0]!;assert('recoveryVersion' in request);assert.equal(request.recoveryVersion,f.controls.recovery!.version);assert.equal(request.continuedFrom,'parent');assert.equal(f.controller.snapshot().selectedRun?.runId,'child-1');
  assert.equal(JSON.stringify(f.runs.find(run=>run.runId==='parent')),parent);assert.equal(JSON.stringify(f.events.get('parent')),events);assert.equal(f.controller.snapshot().selectedRun?.workCycle?.continuation?.recovery?.controller.resultVersion,'2'.repeat(64));
 }finally{f.controller.dispose();}
});

test('ICUI missing lifecycle evidence or mismatched review never yields a submit-ready preview',async()=>{
 const f=interruptedFixture();try{await f.controller.setProject(projectA.projectId);f.controls.prepareCode='CLEANUP_FAILED';assert.equal(await f.controller.prepareWorkContinuation(),false);assert.equal(f.controller.snapshot().workContinuation?.preview,null);
  assert.match(continuationHtml(f),/生命周期依据尚未核定/);assert.match(continuationHtml(f),/历史、文件和日志仍可查看/);assert.match(continuationHtml(f),/<button type="submit" disabled="">开始后续工作<\/button>/);
  f.controls.prepareCode=null;f.controls.recovery=null;assert.equal(await f.controller.prepareWorkContinuation(),false);assert.match(f.controller.snapshot().error??'',/核定依据或文件基线未能确认/);
  f.controls.recovery=interruptedRecovery();f.controls.wrongBaseline=true;assert.equal(await f.controller.prepareWorkContinuation(),false);assert.equal(f.controller.snapshot().workContinuation?.preview,null);assert.equal(await f.controller.continueWork('保留这项后续目标',''),false);assert.equal(f.started.length,0);
  f.controls.wrongBaseline=false;f.controls.blocked='HISTORY_FULL';assert(await f.controller.prepareWorkContinuation());assert.equal(projectCanStart(f.controller.snapshot()),false);assert.match(continuationHtml(f),/当前任务启动条件尚未满足/);assert.equal(await f.controller.continueWork('容量仍不能绕过',''),false);
 }finally{f.controller.dispose();}
});

test('ICUI conflict or newly unconfirmed cleanup invalidates only the recovery preview and requires fresh review',async()=>{
 const f=interruptedFixture();try{await f.controller.setProject(projectA.projectId);const parent=f.controller.snapshot().selectedRun;
  for(const code of ['CONFLICT','CLEANUP_FAILED'] as const){assert(await f.controller.prepareWorkContinuation());f.controls.startCode=code;const count=f.started.length;assert.equal(await f.controller.continueWork('保留后续目标','保留约束'),false);assert.equal(f.controller.snapshot().workContinuation?.preview,null);assert.equal(f.controller.snapshot().workContinuation?.parent.runId,'parent');assert.match(f.controller.snapshot().error??'',/后续要求已保留/);assert.equal(await f.controller.continueWork('保留后续目标','保留约束'),false);assert.equal(f.started.length,count+1);f.controls.startCode=null;}
  f.controls.recovery={...interruptedRecovery(),version:'6'.repeat(64)};assert(await f.controller.prepareWorkContinuation());assert(await f.controller.continueWork('保留后续目标','保留约束'));const first=f.started[0]!,last=f.started.at(-1)!;assert.notEqual(last.clientRequestId,first.clientRequestId);assert('recoveryVersion' in last);assert.equal(last.recoveryVersion,'6'.repeat(64));assert.equal(last.goal,first.goal);assert.equal(f.runs.find(run=>run.runId==='parent')?.cleanupState,parent?.cleanupState);
 }finally{f.controller.dispose();}
});

test('ICUI uncertain recovery creation matches the complete persisted proof before accepting an existing child',async()=>{
 const f=interruptedFixture();try{await f.controller.setProject(projectA.projectId);assert(await f.controller.prepareWorkContinuation());f.controls.lost=true;
  assert.equal(await f.controller.continueWork('原后续目标','约束'),false);const request=f.started[0]!;assert(f.controller.snapshot().startUnconfirmed);assert.equal(await f.controller.continueWork('不同目标','约束'),false);assert.equal(await f.controller.prepareWorkContinuation(),false);assert.equal(f.controller.cancelWorkContinuation(),false);assert.equal(f.started.length,1);
  f.controls.lost=false;f.controls.lostAfterAccept=true;assert.equal(await f.controller.continueWork('原后续目标','约束'),false);assert.deepEqual(f.started[1],request);const child=f.runs.find(run=>run.runId==='child-1')!;const lineage=child.workCycle!.continuation!,recovery=lineage.recovery!;
  f.runs[0]={...child,workCycle:{...child.workCycle!,continuation:{...lineage,recovery:{...recovery,controller:{...recovery.controller,resultVersion:'7'.repeat(64)}}}}};
  await f.controller.refresh();assert(f.controller.snapshot().startUnconfirmed);assert.equal(f.controller.snapshot().workContinuation?.parent.runId,'parent');assert.equal(f.started.length,2);
  f.runs[0]=child;await f.controller.refresh();assert.equal(f.controller.snapshot().startUnconfirmed,false);assert.equal(f.controller.snapshot().selectedRun?.runId,'child-1');assert.equal(f.started.length,2);assert.equal(f.runs.filter(run=>run.continuedFrom==='parent').length,1);
 }finally{f.controller.dispose();}
});

test('ICUI reopened recovery lineage remains bound to full controller and command evidence',async()=>{
 const f=interruptedFixture();try{await f.controller.setProject(projectA.projectId);assert(await f.controller.prepareWorkContinuation());assert(await f.controller.continueWork('继续核对成果',''));const child=f.runs[0]!,lineage=child.workCycle!.continuation!,recovery=lineage.recovery!;
  const reopened=createProjectReadController(f.api,{set:()=>0,clear:()=>{}});try{await reopened.setProject(projectA.projectId);assert.equal(reopened.snapshot().selectedRun?.runId,child.runId);assert.equal(reopened.snapshot().workContinuation,null);assert.equal(f.started.length,1);assert.equal(f.prepared.length,1);
   f.runs[0]={...child,workCycle:{...child.workCycle!,continuation:{...lineage,recovery:{...recovery,commands:recovery.commands.map(c=>({...c,recordVersion:'8'.repeat(64)}))}}}};await reopened.poll();assert.match(reopened.snapshot().error??'',/身份\/顺序异常/);assert.equal(reopened.snapshot().selectedRun?.workCycle?.continuation?.recovery?.commands[0]?.recordVersion,'4'.repeat(64));
  }finally{reopened.dispose();}
 }finally{f.controller.dispose();}
});

test('ICUI a superseded review response cannot create a preview or start work and cancelling stays local',async()=>{
 const f=interruptedFixture();let release!:()=>void;try{await f.controller.setProject(projectA.projectId);f.controls.prepareGate=new Promise<void>(resolve=>{release=resolve;});const waiting=f.controller.prepareWorkContinuation();for(let n=0;n<12;n++)await Promise.resolve();assert.equal(f.prepared.length,1);assert.equal(f.controller.cancelWorkContinuation(),false);
  await f.controller.refresh();release();assert.equal(await waiting,false);assert.equal(f.controller.snapshot().workContinuation?.preview,null);assert.equal(f.started.length,0);assert(f.controller.cancelWorkContinuation());assert.equal(f.controller.snapshot().workContinuation,null);assert.equal(f.controller.snapshot().selectedRun?.status,'interrupted');
 }finally{release?.();f.controller.dispose();}
});

test('C1C explicit continuation prepares without starting and supports successive independent children and cold history',async()=>{
  const f=workContinuationFixture();try{
    await f.controller.setProject(projectA.projectId);const original=JSON.stringify(f.runs[0]);assert.match(continuationHtml(f),/>继续工作<\/button>/);
    assert(await f.controller.prepareWorkContinuation());assert.equal(f.started.length,0);assert.equal(f.prepared[0]?.runId,'parent');assert.equal(f.prepared[0]?.expectedEventCount,2);
    assert.match(continuationHtml(f),/本次后续目标/);assert.match(continuationHtml(f),/不会自动同步项目目录/);assert.match(continuationHtml(f),/返回普通新建（不继承文件）/);
    await f.controller.setProject(projectB.projectId);assert.equal(f.controller.snapshot().projectId,projectA.projectId);
    assert(await f.controller.continueWork('将倍率改为 3','本次输出中文报告'));assert.equal(f.started[0]?.continuedFrom,'parent');assert.equal(f.started[0]?.goal,'将倍率改为 3');assert.equal(f.started[0]?.constraint,'本次输出中文报告');
    assert.equal(f.controller.snapshot().selectedRun?.runId,'child-1');assert.equal(f.controller.snapshot().selectedRun?.workCycle?.workspaceId,'workspace-child-1');assert.equal(f.controller.snapshot().workContinuation,null);assert.match(continuationHtml(f),/继续自：/);
    assert(await f.controller.prepareWorkContinuation());assert.equal(f.controller.snapshot().workContinuation?.preview?.baseline.runId,'child-1');
    assert(await f.controller.continueWork('补充中位数','继续保留缺失数据说明'));assert.equal(f.started[1]?.continuedFrom,'child-1');assert.notEqual(f.started[0]?.clientRequestId,f.started[1]?.clientRequestId);
    assert.equal(f.controller.snapshot().selectedRun?.workCycle?.continuation?.workspaceId,'workspace-child-1');assert.equal(JSON.stringify(f.runs.find(run=>run.runId==='parent')),original);
    await f.controller.select('parent');assert.equal(f.controller.snapshot().events[0]?.runId,'parent');assert.equal(f.controller.snapshot().selectedRun?.workCycle?.workspaceId,'workspace-parent');
    const reopened=createProjectReadController(f.api,{set:()=>0,clear:()=>{}});try{await reopened.setProject(projectA.projectId);assert.equal(reopened.snapshot().workContinuation,null);assert.equal(f.started.length,2);assert.equal(f.prepared.length,2);}finally{reopened.dispose();}
  }finally{f.controller.dispose();}
});

test('C1C blocked preparation preserves its draft and stale start requires explicit preparation again',async()=>{
  const f=workContinuationFixture();try{await f.controller.setProject(projectA.projectId);
    for(const code of ['CONFLICT','BUSY','CLEANUP_FAILED'] as const){f.controls.prepareCode=code;assert.equal(await f.controller.prepareWorkContinuation(),false);assert.equal(f.controller.snapshot().workContinuation?.parent.runId,'parent');assert.equal(f.controller.snapshot().workContinuation?.preview,null);assert.match(continuationHtml(f),/后续要求.*保留/);assert.equal(f.started.length,0);}
    f.controls.prepareCode=null;f.controls.wrongBaseline=true;assert.equal(await f.controller.prepareWorkContinuation(),false);assert.equal(f.controller.snapshot().workContinuation?.preview,null);
    f.controls.wrongBaseline=false;assert(await f.controller.prepareWorkContinuation());f.controls.startCode='CONFLICT';assert.equal(await f.controller.continueWork('保留这次后续要求','约束仍保留'),false);assert.match(f.controller.snapshot().error??'',/基线已变化.*未确认操作/);assert.equal(f.controller.snapshot().workContinuation?.preview,null);
    assert.equal(await f.controller.continueWork('保留这次后续要求','约束仍保留'),false);assert.equal(f.started.length,1);
    f.controls.startCode=null;assert(await f.controller.prepareWorkContinuation());assert(await f.controller.continueWork('保留这次后续要求','约束仍保留'));assert.equal(f.started.length,2);assert.equal(f.started[1]?.goal,f.started[0]?.goal);assert.notEqual(f.started[1]?.clientRequestId,f.started[0]?.clientRequestId);
  }finally{f.controller.dispose();}
});

test('C1C uncertain continuation retries only the exact request and cannot switch baseline or mode',async()=>{
  const f=workContinuationFixture();try{await f.controller.setProject(projectA.projectId);assert(await f.controller.prepareWorkContinuation());f.controls.lost=true;
    assert.equal(await f.controller.continueWork('原输入','原约束'),false);const request=f.started[0];assert(f.controller.snapshot().startUnconfirmed);
    assert.equal(f.controller.cancelWorkContinuation(),false);assert.equal(await f.controller.prepareWorkContinuation(),false);assert.equal(await f.controller.startWork('原输入','原约束'),false);assert.equal(await f.controller.continueWork('改变输入','原约束'),false);assert.equal(f.started.length,1);
    await f.controller.refresh();assert.equal(f.started.length,1);assert.equal(f.prepared.length,1);f.controls.lost=false;assert(await f.controller.continueWork('原输入','原约束'));assert.deepEqual(f.started[1],request);
  }finally{f.controller.dispose();}
});

test('C1C returning to ordinary creation cannot bypass history capacity or failed cleanup',async()=>{
  const f=workContinuationFixture();try{await f.controller.setProject(projectA.projectId);assert(await f.controller.prepareWorkContinuation());
    for(const code of ['CLEANUP_FAILED','HISTORY_FULL'] as const){f.controls.blocked=code;await f.controller.refresh();assert.equal(projectCanStart(f.controller.snapshot()),false);assert(f.controller.cancelWorkContinuation());assert.equal(await f.controller.startWork('普通任务',''),false);assert.equal(f.started.length,0);assert.match(continuationHtml(f),code==='HISTORY_FULL'?/存储用量/:/不能开始新任务/);if(code==='CLEANUP_FAILED')assert(await f.controller.prepareWorkContinuation());}
  }finally{f.controller.dispose();}
});

test('C1C acceptance and later pages reject changed parent workspace identities',async()=>{
  const f=workContinuationFixture();try{await f.controller.setProject(projectA.projectId);assert(await f.controller.prepareWorkContinuation());assert(await f.controller.continueWork('后续目标',''));
    const child=f.runs.find(run=>run.runId==='child-1')!;const baseline=child.workCycle!.continuation!;
    f.runs[0]={...child,workCycle:{...child.workCycle!,continuation:{...baseline,workspaceId:'foreign-parent-workspace'}}};
    await f.controller.poll();assert.match(f.controller.snapshot().error??'',/身份\/顺序异常/);assert.equal(f.controller.snapshot().selectedRun?.workCycle?.continuation?.workspaceId,'workspace-parent');
    await f.controller.select('child-1');assert.match(f.controller.snapshot().error??'',/身份\/顺序异常/);assert.equal(f.controller.snapshot().events.length,0);
  }finally{f.controller.dispose();}
});

test('project flow starts unchecked directly and preserves accepted scope after project switching',async()=>{
  const f=projectFixture();try{await f.controller.setProject(projectA.projectId);assert.deepEqual(f.calls.sort(),['list','status']);assert(projectCanStart(f.controller.snapshot()));
    assert(await f.controller.start('查找采样时钟说明','只引用实际读取片段'));assert.equal(f.starts.length,1);assert.equal(f.starts[0]?.projectId,projectA.projectId);assert.equal(f.starts[0]?.bindingId,projectA.bindingId);assert.equal(f.starts[0]?.continuedFrom,null);
    await f.controller.setProject(projectB.projectId);assert.equal(f.controller.snapshot().projectId,projectB.projectId);assert.equal(f.controller.snapshot().selectedRun?.project.projectId,projectA.projectId);assert.equal(f.starts.length,1);
    assert(!projectCanStart(f.controller.snapshot()));
  }finally{f.controller.dispose();assert.equal(f.scheduled.size,0);}
});

test('project flow does not replay uncertain starts and reuses the same request for explicit retry',async()=>{
  const attempted:ProjectReadRequests['startRun'][]=[];const f=projectFixture({startRun:async input=>{attempted.push(input);throw Error('Lost response');}});
  try{await f.controller.setProject(projectA.projectId);assert.equal(await f.controller.start('查找时钟',''),false);assert(f.controller.snapshot().startUnconfirmed);assert.equal(await f.controller.start('不同的任务',''),false);assert.equal(attempted.length,1);
    await f.controller.refresh();assert.equal(attempted.length,1);await f.controller.start('查找时钟','');assert.equal(attempted.length,2);assert.deepEqual(attempted[0],attempted[1]);
  }finally{f.controller.dispose();}
});

test('work task starts use the versioned work method and never reuse an uncertain ID for another mode',async()=>{
 const attempted:ProjectReadRequests['startWorkRun'][]=[];
 const f=projectFixture({startWorkRun:async input=>{attempted.push(input);throw Error('Lost response');}});
 try{await f.controller.setProject(projectA.projectId);assert.equal(await f.controller.startWork('分析 CSV 并生成报告','保留日志'),false);assert.equal(attempted.length,1);assert.equal(attempted[0]?.continuedFrom,null);assert.equal(attempted[0]?.projectId,projectA.projectId);assert(f.controller.snapshot().startUnconfirmed);
  await f.controller.start('分析 CSV 并生成报告','保留日志');assert.equal(f.starts.length,0);assert.equal(attempted.length,1);
  await f.controller.startWork('分析 CSV 并生成报告','保留日志');assert.equal(attempted.length,2);assert.deepEqual(attempted[0],attempted[1]);
 }finally{f.controller.dispose();}
});

test('work task successful acceptance selects its own workspace without replaying execution',async()=>{
 let starts=0;
 const f=projectFixture({startWorkRun:async input=>{starts++;const workCycle={workspaceId:'workspace-a'};
  f.events.set('work-run',[projectEvent(1,'run.accepted',{project:projectA,model:projectModel,continuedFrom:null,budget,workCycle},'work-run')]);
  f.runs.push({runId:'work-run',clientRequestId:input.clientRequestId,project:projectA,model:input.model,goal:input.goal,constraint:input.constraint,continuedFrom:null,status:'running',cleanupState:'idle',createdAt:time,updatedAt:time,accounting,eventCount:1,continuation:null,workCycle});return{ok:true,value:{runId:'work-run'}};
 }});
 try{await f.controller.setProject(projectA.projectId);assert(await f.controller.startWork('分析项目数据','输出报告'));assert.equal(f.controller.snapshot().selectedRun?.workCycle?.workspaceId,'workspace-a');assert.equal(f.controller.snapshot().events.length,1);await f.controller.refresh();assert.equal(starts,1);assert.equal(f.starts.length,0);await f.controller.stop();assert(f.controller.snapshot().stopAccepted);}
 finally{f.controller.dispose();}
});

test('work history blocks readonly continuation and unreviewed deletion while exposing capacity management',async()=>{
 const f=projectFixture();try{await f.controller.setProject(projectA.projectId);await f.controller.start('生成报告','');
  const workCycle={workspaceId:'workspace-a'};f.runs[0]={...f.runs[0]!,workCycle,status:'completed'};
  f.events.set('run-a',[projectEvent(1,'run.accepted',{project:projectA,model:projectModel,continuedFrom:null,budget,workCycle}),projectEvent(2,'run.completed',{citations:[]})]);await f.controller.refresh();await f.controller.select('run-a');
  assert.equal(f.controller.snapshot().selectedRun?.workCycle?.workspaceId,'workspace-a');assert.equal(await f.controller.continueRun(),false);assert.equal(await f.controller.deleteRun('run-a'),false);
  const html=renderToStaticMarkup(createElement(ProjectReadView,{state:f.controller.snapshot(),choices:{activeId:'project-a',projects:[{id:'project-a',name:'项目A'}]},actions:f.controller,onCreate:()=>{}}));
  assert.match(html,/创建文件与分析/);assert.match(html,/查看容量与删除/);assert.doesNotMatch(html,/工作任务暂不支持删除|开始后续任务/);
 }finally{f.controller.dispose();}
});

test('project flow keeps stop acceptance separate from terminal cleanup and never replays answers',async()=>{
  const f=projectFixture();try{await f.controller.setProject(projectA.projectId);await f.controller.start('确认搜索范围','');
    f.runs[0]={...f.runs[0]!,status:'waiting_user'};f.events.set('run-a',[projectAccepted(),projectEvent(2,'question.asked',{questionId:'q1',prompt:'检查哪一个目录？'})]);await f.controller.poll();
    assert(await f.controller.answer('q1','文档目录'));assert.equal(await f.controller.answer('q1','文档目录'),false);assert.equal(f.calls.filter(item=>item==='answer').length,1);
    f.events.get('run-a')!.push(projectEvent(3,'question.answered',{questionId:'q1',answer:'文档目录'}));await f.controller.poll();let projection=projectReadEvents(f.controller.snapshot().events);assert.equal(projection.question?.delivered,false);
    f.events.get('run-a')!.push(projectEvent(4,'question.delivered',{questionId:'q1'}));await f.controller.poll();projection=projectReadEvents(f.controller.snapshot().events);assert.equal(projection.question?.delivered,true);
    await f.controller.stop();assert(f.controller.snapshot().stopAccepted);assert.equal(f.controller.snapshot().selectedRun?.status,'waiting_user');
    f.runs[0]={...f.runs[0]!,status:'stopped',cleanupState:'pending'};f.events.get('run-a')!.push(projectEvent(5,'run.stopped',{reason:'user'}));await f.controller.poll();assert.equal(f.scheduled.size,1);assert(!projectCanStart(f.controller.snapshot()));
    f.runs[0]={...f.runs[0]!,cleanupState:'idle'};f.events.get('run-a')!.push(projectEvent(6,'cleanup.completed',{outcome:'confirmed'}));await f.controller.poll();assert.equal(f.scheduled.size,0);
  }finally{f.controller.dispose();}
});

test('project flow rejects a wrong-project event page instead of relabeling a run',async()=>{
  const f=projectFixture();try{await f.controller.setProject(projectA.projectId);await f.controller.start('查看说明','');const accepted=f.controller.snapshot().events;
    f.runs[0]={...f.runs[0]!,project:projectB};await f.controller.poll();assert(f.controller.snapshot().error?.includes('身份/顺序异常'));assert.deepEqual(f.controller.snapshot().events,accepted);assert.equal(f.controller.snapshot().selectedRun?.project.projectId,projectA.projectId);
  }finally{f.controller.dispose();}
});

test('project flow validates versioned citation and ignores model-invented IDs without current file reads',async()=>{
  const citation:ProjectReadCitation={citationId:'cite-valid',runId:'run-a',project:projectA,snapshotId:'snapshot-a',fileId:'file-a',fileIdentity:'file-identity',relativePath:'docs/large.md',version:'a'.repeat(64),normalizedSha256:'b'.repeat(64),range:{start:{line:12001,column:3},end:{line:12002,column:1}},excerpt:'😀后部说明\n',excerptSha256:'c'.repeat(64),totalLines:20000,fileBytes:1100000,source:'read',createdAt:time,origin:null};
  const {runId:ignoredRun,project:ignoredProject,snapshotId:ignoredSnapshot,fileIdentity:ignoredIdentity,createdAt:ignoredCreated,origin:ignoredOrigin,...preview}=citation;
  let mismatch=false;const f=projectFixture({resolveCitation:async()=>{f.calls.push('citation');return{ok:true,value:mismatch?{...citation,project:projectB}:citation};},checkCitation:async()=>{f.calls.push('check');return{ok:true,value:{citationId:citation.citationId,state:'changed',reason:'SOURCE_CHANGED'}};}});
  try{await f.controller.setProject(projectA.projectId);await f.controller.start('查找后部说明','');const coverage:ProjectReadCoverage={scope:{projectId:projectA.projectId,bindingId:projectA.bindingId,identity:projectA.identity,directoryId:null,relativeDirectory:''},complete:false,scannedCandidates:1,scannedFiles:0,scannedBytes:20,returned:1,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},remaining:{directories:null,files:null,position:{line:12002,column:1}},nextCursor:'private-cursor',limitReason:'page'};
    f.events.get('run-a')!.push(projectEvent(2,'tool.completed',{sessionId:'session-a',messageId:'message-a',callId:'call-a',toolName:'project_read',arguments:{fileId:'file-a',version:citation.version,start:{line:12001,column:3},cursor:null},result:{ok:true,value:{kind:'read',phase:'data',snapshotId:'snapshot-a',coverage,rules:[],resume:null,citation:preview,empty:false,next:{line:12002,column:1}}}}));await f.controller.poll();
    await f.controller.openCitation('invented');assert.equal(f.calls.filter(call=>call==='citation').length,0);
    await f.controller.openCitation('cite-valid');assert.equal(f.controller.snapshot().citation?.range.start.line,12001);assert.equal(f.controller.snapshot().citation?.excerpt,'😀后部说明\n');
    assert.equal(f.calls.filter(call=>call==='check').length,0);await f.controller.checkCitation();assert.equal(f.controller.snapshot().citationCheck?.state,'changed');assert.equal(f.controller.snapshot().citation?.excerpt,citation.excerpt);
    f.controller.closeCitation();mismatch=true;await f.controller.openCitation('cite-valid');assert.equal(f.controller.snapshot().citation,null);assert(f.controller.snapshot().citationError?.includes('身份或版本'));
    const projection=projectReadEvents(f.controller.snapshot().events);assert.deepEqual(projectMessageCitations('[资料:invented] [资料:cite-valid]',projection.citations).map(value=>value.citationId),['cite-valid']);
  }finally{f.controller.dispose();}
});

test('project message IDs preserve Markdown chunks and separate native messages',()=>{
  const events=[projectAccepted(),projectEvent(2,'message.delta',{messageId:'m1',step:1,text:'## 检索\n\n**时'}),projectEvent(3,'model.response',{request:1,responseModel:null,usage:{inputTokens:0,outputTokens:0}}),projectEvent(4,'message.delta',{messageId:'m1',step:1,text:'钟**'}),projectEvent(5,'message.delta',{messageId:'m2',step:1,text:'另一条消息'})];
  const projection=projectReadEvents(events);assert.equal(projection.timeline.length,2);assert.equal(projection.timeline[0]?.kind==='text'&&projection.timeline[0].text,'## 检索\n\n**时钟**');assert.equal(projection.responses[0]?.usage?.inputTokens,0);
});

test('project flow discards an in-flight page when another history task is selected',async()=>{
  let release:((value:Awaited<ReturnType<WorkbenchAgentProjectReadApi['readRun']>>)=>void)|null=null,hold=false;
  const f=projectFixture();const original=f.api.readRun;
  Object.assign(f.api,{readRun:async(request:ProjectReadRequests['readRun'])=>hold&&request.runId==='run-a'?new Promise(resolve=>{release=resolve;}):original(request)});
  try{await f.controller.setProject(projectA.projectId);await f.controller.start('第一个任务','');
    const second:ProjectReadSummary={...f.runs[0]!,runId:'run-b',clientRequestId:'client-b',project:projectB,goal:'第二个任务',status:'completed',eventCount:2};
    f.runs.push(second);f.events.set('run-b',[projectAccepted(projectB,'run-b'),projectEvent(2,'run.completed',{citations:[]},'run-b')]);await f.controller.refresh();
    hold=true;const pending=f.controller.poll();await f.controller.select('run-b');const deliver=release as unknown as (value:Awaited<ReturnType<WorkbenchAgentProjectReadApi['readRun']>>)=>void;
    deliver({ok:true,value:{run:{...f.runs[0]!,eventCount:1},events:[],nextAfter:1,hasMore:false}});await pending;await f.controller.poll();
    assert.equal(f.controller.snapshot().selectedRun?.runId,'run-b');assert(f.controller.snapshot().events.every(event=>event.runId==='run-b'));assert.equal(f.controller.snapshot().events.length,2);
  }finally{f.controller.dispose();}
});

test('project flow rejects malformed status through the shared parser before start',async()=>{
  const f=projectFixture({getStatus:async()=>({ok:true,value:{model:projectModel,project:projectA,availability:'unchecked',canStart:true,processState:'idle',cleanupState:'idle',reason:null,activeTask:null,extra:'unknown-field'}})});
  try{await f.controller.setProject(projectA.projectId);assert.equal(f.controller.snapshot().status,null);assert.equal(await f.controller.start('读取说明',''),false);assert.equal(f.starts.length,0);}
  finally{f.controller.dispose();}
});

test('project view shows unavailable capability and legacy history has no new calculation form',()=>{
  const projectActions={...actions,setProject:async()=>{},older:async()=>{},openCitation:async()=>{},closeCitation:()=>{},continueRun:async()=>false,deleteRun:async()=>false,revalidate:async()=>{},browse:async()=>{},checkCitation:async()=>{},cancelInspection:async()=>false};
  const html=renderToStaticMarkup(createElement(ProjectReadView,{state:{...initialProjectReadState,projectId:projectA.projectId,statusError:'项目工具能力尚未接通'},choices:{activeId:projectA.projectId,projects:[{id:projectA.projectId,name:projectA.name}]},actions:projectActions,onCreate:()=>{throw Error('No creation on render');}}));
  assert(html.includes('项目工具能力尚未接通'));assert.match(html,/<button type="submit" disabled="">开始任务<\/button>/);assert(!html.includes('重新验证'));
  const legacy=renderToStaticMarkup(createElement(EnginePilotView,{state:initialEnginePilotState,actions,mode:'live',historyOnly:true}));assert(!legacy.includes('pilot-goal'));assert(!legacy.includes('开始新任务'));
});

test('project browse covers 2501 metadata entries through its own explicit pages without model work',async()=>{
  const requests:ProjectReadRequests['browseProject'][]=[];let cancelled=0;
  const f=projectFixture({browseProject:async request=>{
    requests.push(request);const offset=request.cursor?Number(request.cursor.split(':')[1]):0,end=Math.min(offset+50,2501),complete=end===2501;
    const entries=Array.from({length:end-offset},(_,index)=>({fileId:`file-${offset+index}`,directoryId:null,parentId:null,name:`entry-${offset+index}.txt`,relativePath:`entry-${offset+index}.txt`,kind:'file' as const,bytes:10,readability:'readable' as const,version:null}));
    return{ok:true,value:{snapshotId:'inspection-a',entries,coverage:{scope:{projectId:projectA.projectId,bindingId:projectA.bindingId,identity:projectA.identity,directoryId:null,relativeDirectory:''},complete,scannedCandidates:end,scannedFiles:0,scannedBytes:0,returned:entries.length,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},remaining:{directories:0,files:2501-end,position:null},nextCursor:complete?null:`page:${end}`,limitReason:complete?null:'page'}}};
  },cancelInspection:async()=>{cancelled++;return{ok:true,value:{accepted:true}};}});
  try{await f.controller.setProject(projectA.projectId);assert.equal(requests.length,0);await f.controller.browse();
    while(f.controller.snapshot().inspection?.value.coverage.nextCursor)await f.controller.browse(null,'',true);
    assert.equal(f.controller.snapshot().inspection?.returnedTotal,2501);assert.equal(f.controller.snapshot().inspection?.page,51);assert.equal(f.controller.snapshot().inspection?.value.coverage.complete,true);assert.equal(f.starts.length,0);assert(!f.calls.includes('read'));assert.equal(requests[0]?.refresh,true);assert(requests.slice(1).every(request=>!request.refresh&&request.cursor));
    await f.controller.cancelInspection();assert.equal(cancelled,1);assert.equal(f.controller.snapshot().inspection,null);
  }finally{f.controller.dispose();}
});

test('project browse cancellation discards a late page and never starts a task',async()=>{
  let release:((result:Awaited<ReturnType<WorkbenchAgentProjectReadApi['browseProject']>>)=>void)|null=null;
  const f=projectFixture({browseProject:async()=>new Promise(resolve=>{release=resolve;}),cancelInspection:async()=>({ok:true,value:{accepted:true}})});
  try{await f.controller.setProject(projectA.projectId);const pending=f.controller.browse();assert(f.controller.snapshot().inspecting);await f.controller.cancelInspection();
    const deliver=release as unknown as (result:Awaited<ReturnType<WorkbenchAgentProjectReadApi['browseProject']>>)=>void;deliver({ok:false,error:{code:'BUSY'}});await pending;
    assert.equal(f.controller.snapshot().inspection,null);assert.equal(f.controller.snapshot().inspectionError,null);assert.equal(f.controller.snapshot().inspecting,false);assert.equal(f.starts.length,0);
  }finally{f.controller.dispose();}
});

test('project continuation sends original scope goal and constraint with only a parent ID',async()=>{
  const f=projectFixture();try{await f.controller.setProject(projectA.projectId);await f.controller.start('找出时钟约束','保留原始范围');
    f.runs[0]={...f.runs[0]!,status:'stopped',eventCount:2};f.events.get('run-a')!.push(projectEvent(2,'run.stopped',{reason:'user'}));await f.controller.poll();await f.controller.setProject(projectB.projectId);
    let received:ProjectReadRequests['startRun']|null=null;Object.assign(f.api,{startRun:async(input:ProjectReadRequests['startRun'])=>{received=input;const parent=f.runs[0]!;
      const next:ProjectReadSummary={...parent,runId:'run-c',clientRequestId:input.clientRequestId,continuedFrom:'run-a',status:'preparing',eventCount:1,continuation:{fromRunId:'run-a',evidenceCount:0,confirmedQuestions:0,resumedFilePositions:0,restartedQueries:1}};
      f.runs.unshift(next);f.events.set('run-c',[projectEvent(1,'run.accepted',{project:projectA,model:projectModel,continuedFrom:'run-a',budget},'run-c')]);return{ok:true,value:{runId:'run-c'}};}});
    assert(await f.controller.continueRun());const request=received as unknown as ProjectReadRequests['startRun'];assert.equal(request.projectId,projectA.projectId);assert.equal(request.bindingId,projectA.bindingId);assert.equal(request.goal,'找出时钟约束');assert.equal(request.constraint,'保留原始范围');assert.equal(request.continuedFrom,'run-a');assert(!Object.hasOwn(request,'cursor'));assert(!Object.hasOwn(request,'messages'));assert.equal(f.controller.snapshot().selectedRun?.continuation?.restartedQueries,1);
  }finally{f.controller.dispose();}
});

test('project deletion retains dependent or changed records and only removes confirmed terminal history',async()=>{
  const requests:ProjectReadRequests['deleteRun'][]=[];let mode:'dependencies'|'conflict'|'success'='dependencies';
  const f=projectFixture({deleteRun:async input=>{requests.push(input);return mode==='dependencies'?{ok:false,error:{code:'RUN_HAS_DEPENDENTS',dependentRunIds:['run-child']}}:mode==='conflict'?{ok:false,error:{code:'CONFLICT'}}:{ok:true,value:{deleted:true}};}});
  try{await f.controller.setProject(projectA.projectId);await f.controller.start('读取说明','');assert.equal(await f.controller.deleteRun('run-a'),false);assert.equal(requests.length,0);
    f.runs[0]={...f.runs[0]!,status:'stopped',eventCount:2};f.events.get('run-a')!.push(projectEvent(2,'run.stopped',{reason:'user'}));await f.controller.poll();
    assert(await f.controller.prepareDeletion('run-a'));assert.equal(await f.controller.deleteRun('run-a'),false);assert.deepEqual(f.controller.snapshot().deleteDependents,['run-child']);assert.equal(f.controller.snapshot().runs.length,1);
    mode='conflict';assert(await f.controller.prepareDeletion('run-a'));assert.equal(await f.controller.deleteRun('run-a'),false);assert.equal(f.controller.snapshot().runs.length,1);
    mode='success';assert(await f.controller.prepareDeletion('run-a'));assert(await f.controller.deleteRun('run-a'));assert.equal(f.controller.snapshot().runs.length,0);assert.equal(f.controller.snapshot().selectedRun,null);assert(requests.every(input=>input.expectedEventCount===2&&input.expectedCapacityVersion==='a'.repeat(64)));
  }finally{f.controller.dispose();}
});

test('project revalidation is explicit and uses only the saved project binding',async()=>{
  const requests:ProjectReadRequests['revalidateProject'][]=[];const f=projectFixture({revalidateProject:async input=>{requests.push(input);return{ok:true,value:{model:projectModel,project:projectA,availability:'root_changed',canStart:false,processState:'idle',cleanupState:'idle',reason:'ROOT_CHANGED',activeTask:null}};}});
  try{await f.controller.setProject(projectA.projectId);assert.equal(requests.length,0);await f.controller.revalidate();assert.equal(requests.length,1);assert.equal(requests[0]?.bindingId,projectA.bindingId);assert(!Object.hasOwn(requests[0]!,'path'));assert.equal(f.controller.snapshot().status?.availability,'root_changed');assert(!projectCanStart(f.controller.snapshot()));}
  finally{f.controller.dispose();}
});

test('project recovery permits failed cleanup record deletion but keeps pending and current lease gates',async()=>{
  let currentLocked=true,allowDelete=false;const deletes:ProjectReadRequests['deleteRun'][]=[];
  const f=projectFixture({getStatus:async()=>({ok:true,value:{project:projectA,model:projectModel,availability:currentLocked?'unavailable':'available',canStart:!currentLocked,processState:currentLocked?'failed':'idle',cleanupState:currentLocked?'failed':'idle',reason:currentLocked?'CLEANUP_FAILED':null,activeTask:null}}),
    deleteRun:async request=>{deletes.push(request);return allowDelete?{ok:true,value:{deleted:true}}:{ok:false,error:{code:'BUSY'}};}});
  try{
    f.runs.push({runId:'run-old',clientRequestId:'client-old',project:projectA,model:projectModel,goal:'恢复前的任务',constraint:'',continuedFrom:null,status:'interrupted',cleanupState:'pending',createdAt:time,updatedAt:time,accounting,eventCount:2,continuation:null});
    f.events.set('run-old',[projectAccepted(projectA,'run-old'),projectEvent(2,'run.interrupted',{reason:'restart'},'run-old')]);await f.controller.setProject(projectA.projectId);
    assert.equal(await f.controller.deleteRun('run-old'),false);assert.equal(deletes.length,0);assert(!projectCanStart(f.controller.snapshot()));
    f.runs[0]={...f.runs[0]!,cleanupState:'failed',eventCount:3};f.events.get('run-old')!.push(projectEvent(3,'cleanup.completed',{outcome:'failed'},'run-old'));await f.controller.refresh();
    assert.equal(await f.controller.continueRun(),false);assert.equal(f.starts.length,0);assert(!projectCanStart(f.controller.snapshot()));
    const html=renderToStaticMarkup(createElement(ProjectReadView,{state:f.controller.snapshot(),choices:{activeId:projectA.projectId,projects:[{id:projectA.projectId,name:projectA.name}]},actions:f.controller,onCreate:()=>{throw Error('No create on render');}}));
    assert(html.includes('查看容量与删除'));assert(!html.includes('开始后续任务'));assert(html.includes('本条记录不能接续'));assert(html.includes('重新读取'));assert(html.includes('历史容量已满'));
    assert(await f.controller.prepareDeletion('run-old'));assert.equal(await f.controller.deleteRun('run-old'),false);assert.equal(deletes.length,1);assert.equal(f.controller.snapshot().runs.length,1);assert.equal(f.controller.snapshot().selectedRun?.cleanupState,'failed');
    currentLocked=false;await f.controller.refresh();assert(projectCanStart(f.controller.snapshot()));assert.equal(await f.controller.continueRun(),false);
    allowDelete=true;assert(await f.controller.prepareDeletion('run-old'));assert(await f.controller.deleteRun('run-old'));assert.equal(f.controller.snapshot().runs.length,0);assert.equal(f.controller.snapshot().selectedRun,null);assert(deletes.every(request=>request.expectedEventCount===3));
  }finally{f.controller.dispose();}
});

test('project history cannot answer a stale question before all event pages are read',async()=>{
  const f=projectFixture();try{await f.controller.setProject(projectA.projectId);await f.controller.start('历史任务','');
    const events=[projectAccepted(),...Array.from({length:30},(_,index)=>projectEvent(index+2,'message.delta',{messageId:'m1',step:1,text:'说明。'})),
      projectEvent(32,'question.asked',{questionId:'q1',prompt:'哪个范围？'}),projectEvent(33,'question.answered',{questionId:'q1',answer:'已经回答'}),projectEvent(34,'question.delivered',{questionId:'q1'})];
    f.events.set('run-a',events);f.runs[0]={...f.runs[0]!,status:'running',eventCount:events.length};await f.controller.refresh();await f.controller.select('run-a');
    assert(f.controller.snapshot().hasMore);assert.equal(projectReadEvents(f.controller.snapshot().events).question?.answered,false);
    assert.equal(await f.controller.answer('q1','不能重发'),false);assert(!f.calls.includes('answer'));await f.controller.poll();assert.equal(projectReadEvents(f.controller.snapshot().events).question?.delivered,true);
  }finally{f.controller.dispose();}
});

const skillDigest='d'.repeat(64),skillPath='skills/analyze/SKILL.md';
const skillDescriptor:AgentSkillDescriptor={skillId:'skill-entry',entryRelativePath:skillPath,directoryId:'skill-directory',discoveryVersion:skillDigest,versionMethod:'metadata-observation-sha256-v1',name:'分析数据',description:'生成数据汇总。',metadataStatus:'ready',baseRelativeDirectory:'skills/analyze'};
function skillCoverage(returned:number,complete=true):ProjectReadCoverage{return{scope:{projectId:projectA.projectId,bindingId:projectA.bindingId,identity:projectA.identity,directoryId:null,relativeDirectory:''},complete,scannedCandidates:3,scannedFiles:1,scannedBytes:128,returned,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},remaining:{directories:complete?0:1,files:complete?0:1,position:null},nextCursor:complete?null:'skill-page',limitReason:complete?null:'page'};}
function skillRead(role:'entry'|'reference',complete:boolean,phase:'data'|'rules'='data'):Extract<ProjectReadToolValue,{kind:'read'}>{
 const path=role==='entry'?skillPath:'skills/analyze/reference.md';
 const citation:ProjectReadCitationPreview={citationId:`skill-cite-${role}`,fileId:`skill-${role}`,relativePath:path,version:skillDigest,normalizedSha256:skillDigest,range:{start:{line:1,column:1},end:{line:2,column:1}},excerpt:'# 技能资料\n',excerptSha256:skillDigest,totalLines:3,fileBytes:128,source:'read'};
 const skill:AgentSkillSource={sourceKind:'selected_project',skillId:skillDescriptor.skillId,entryRelativePath:skillPath,discoveryVersion:skillDigest,entryVersion:skillDigest,entryComplete:role==='reference'||complete,resourceRole:role,resourceRelativePath:path,resourceVersion:phase==='data'?skillDigest:role==='entry'?skillDigest:null};
 return{kind:'read',phase,snapshotId:'skill-snapshot',coverage:skillCoverage(phase==='data'?1:0,complete),rules:[],resume:null,citation:phase==='data'?citation:null,empty:false,next:phase==='data'&&!complete?citation.range.end:null,skill};
}
function renderSkillResult(value:ProjectReadToolValue){const result=parseProjectReadToolResult({ok:true,value});assert(result,'Fixture must pass the actual shared parser');return renderToStaticMarkup(createElement(ProjectReadResults,{result,onCitation:()=>{throw Error('Rendering never opens a citation');}}));}

test('C1S skill discovery renders bounded metadata as text and distinguishes partial discovery from loading',()=>{
 const metadata:Extract<ProjectReadToolValue,{kind:'skills'}>={kind:'skills',phase:'data',snapshotId:'skill-snapshot',sourceKind:'selected_project',entries:[{...skillDescriptor,name:'<script>分析数据</script>',description:'<img src=x onerror=alert(1)>'}],coverage:skillCoverage(1),rules:[],resume:null};
 const html=renderSkillResult(metadata);assert.match(html,/skills\/analyze\/SKILL.md/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script|<img|<button|<select|已完整加载/);assert(!html.includes(skillDigest));assert(!html.includes(skillDescriptor.skillId));
 for(const metadataStatus of ['missing_frontmatter','invalid_frontmatter','header_too_large','unsupported_encoding'] as const){const invalid=renderSkillResult({...metadata,entries:[{...skillDescriptor,name:null,description:null,metadataStatus}]});assert.match(invalid,/技能信息/);assert.match(invalid,/skills\/analyze\/SKILL.md/);assert.doesNotMatch(invalid,/undefined|已完整加载/);}
 const duplicate=renderSkillResult({...metadata,entries:[skillDescriptor,{...skillDescriptor,skillId:'another-skill',entryRelativePath:'other/SKILL.md',baseRelativeDirectory:'other'}],coverage:skillCoverage(2)});assert.match(duplicate,/skills\/analyze\/SKILL.md/);assert.match(duplicate,/other\/SKILL.md/);
 const empty={...metadata,entries:[],coverage:skillCoverage(0)};assert.match(renderSkillResult(empty),/本次范围内未发现技能/);
 assert.match(renderSkillResult({...empty,coverage:skillCoverage(0,false)}),/尚有未检查或跳过/);
 assert.match(renderSkillResult({...empty,coverage:{...skillCoverage(0),skipped:{policy:1,unsupported:0,fileLimit:0,unavailable:0}}}),/尚有未检查或跳过/);
 assert.doesNotMatch(renderSkillResult({...empty,phase:'rules',coverage:skillCoverage(0,false)}),/未发现技能/);
});

test('C1S skill loading and reference pages keep independent completion states and real citation controls',()=>{
 const partial=renderSkillResult(skillRead('entry',false));assert.match(partial,/技能入口尚未完整加载/);assert.match(partial,/<button/);assert(!partial.includes(skillDigest));
 const full=renderSkillResult(skillRead('entry',true));assert.match(full,/技能入口已完整加载/);assert.doesNotMatch(full,/尚未完整加载/);
 const waiting=renderSkillResult(skillRead('entry',false,'rules'));assert.match(waiting,/正在准备.*规则/);assert.match(waiting,/尚未完整加载/);assert.doesNotMatch(waiting,/<button/);
 const reference=renderSkillResult(skillRead('reference',false));assert.match(reference,/技能入口已完整加载/);assert.match(reference,/技能资料尚未读完/);assert.match(reference,/skills\/analyze\/reference.md/);
 assert.match(renderSkillResult(skillRead('reference',true)),/本次资料读取已到文件末尾/);
 const error:ProjectReadToolResult={ok:false,error:{code:'SOURCE_CHANGED'},coverage:null};const failed=renderToStaticMarkup(createElement(ProjectReadResults,{result:error,onCitation:()=>{throw Error('No citation on failure');}}));assert.match(failed,/文件已发生变化/);assert.doesNotMatch(failed,/已完整加载|<button/);
});

test('C1S skill tools reuse the existing timeline and only issued read citations become references',async()=>{
 const f=projectFixture();try{await f.controller.setProject(projectA.projectId);await f.controller.start('使用项目技能分析数据','');
  const results=[{toolName:'skill_discover' as const,arguments:{directoryId:null,cursor:null,refresh:false},value:{kind:'skills' as const,phase:'data' as const,snapshotId:'skill-snapshot',sourceKind:'selected_project' as const,entries:[skillDescriptor],coverage:skillCoverage(1),rules:[],resume:null}},
   {toolName:'skill_load' as const,arguments:{skillId:skillDescriptor.skillId,discoveryVersion:skillDigest,version:null,start:{line:1,column:1},cursor:null},value:skillRead('entry',true)},
   {toolName:'skill_read_reference' as const,arguments:{skillId:skillDescriptor.skillId,skillVersion:skillDigest,fileId:'skill-reference',version:null,start:{line:1,column:1},cursor:null},value:skillRead('reference',true)}];
  results.forEach((item,index)=>{const event=parseProjectReadEvent({runId:'run-a',sequence:index+2,time,type:'tool.completed',data:{sessionId:'skill-session',messageId:'skill-message',callId:`skill-call-${index}`,toolName:item.toolName,arguments:item.arguments,result:{ok:true,value:item.value}}});assert(event);f.events.get('run-a')!.push(event);});
  await f.controller.poll();const projection=projectReadEvents(f.controller.snapshot().events);assert.equal(projection.timeline.length,3);assert.equal(projection.citations.size,2);assert.equal(projection.workValues.length,0);assert.equal(projection.ruleChunks.length,0);
  assert.deepEqual(projectMessageCitations('[资料:skill-cite-entry] [资料:invented] [资料:skill-cite-reference]',projection.citations).map(c=>c.citationId),['skill-cite-entry','skill-cite-reference']);
  const html=renderToStaticMarkup(createElement(ProjectReadView,{state:f.controller.snapshot(),choices:{activeId:projectA.projectId,projects:[{id:projectA.projectId,name:projectA.name}]},actions:f.controller,onCreate:()=>{throw Error('No project creation');}}));
  for(const name of ['发现技能','加载技能','读取技能资料'])assert(html.includes(`<summary>${name} · 已返回</summary>`));assert.match(html,/已读取依据（2）/);assert(!html.includes(skillDigest));assert.doesNotMatch(html,/技能选择器|技能设置/);
 }finally{f.controller.dispose();}
});

test('project coverage distinguishes partial, skipped and fully searched zero matches without cursor actions',()=>{
  const coverage:ProjectReadCoverage={scope:{projectId:'a',bindingId:'b',identity:'i',directoryId:null,relativeDirectory:''},complete:false,
    scannedCandidates:5000,scannedFiles:120,scannedBytes:6000,returned:0,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},
    remaining:{directories:4,files:null,position:null},nextCursor:'opaque-cursor-never-rendered',limitReason:'slice'};
  const render=(current:ProjectReadCoverage,phase:'data'|'scan'|'rules'='data')=>renderToStaticMarkup(createElement(ProjectReadResults,{result:{ok:true,value:{kind:'search',phase,snapshotId:'snapshot',coverage:current,rules:[],resume:null,matches:[]}},onCitation:()=>{throw new Error('No citation in an empty search');}}));
  const partial=render(coverage);assert(partial.includes('尚未查完'));assert(partial.includes('尚不能判断'));assert(partial.includes('文件：未知'));
  assert(!partial.includes('opaque-cursor'));assert(!partial.includes('<button'));assert(!partial.includes('目标已完成'));
  const finished=render({...coverage,complete:true,remaining:{directories:0,files:0,position:null},nextCursor:null,limitReason:null});
  assert(finished.includes('本次搜索范围内没有匹配。'));assert(!finished.includes('尚不能判断'));
  const skipped=render({...coverage,complete:true,skipped:{policy:1,unsupported:0,fileLimit:0,unavailable:0}});
  assert(skipped.includes('有跳过的条目'));assert(skipped.includes('尚不能判断'));assert(!skipped.includes('本次搜索范围内没有匹配。'));
  for(const phase of ['scan','rules'] as const){const preparing=render({...coverage,complete:true},phase);assert(preparing.includes('尚未返回内容结果'));assert(!preparing.includes('没有匹配'));}
});

test('Q04 response details retain known, zero and missing actual values independently of native steps',()=>{
  const events=[accepted(),event(2,'model.response',{request:1,responseModel:'reported-model',usage:{inputTokens:17,outputTokens:0}}),
    event(3,'model.step',{step:1,usage:{inputTokens:0,outputTokens:0}}),event(4,'model.response',{request:3,responseModel:null,usage:null}),
    event(5,'model.step',{step:2,usage:{inputTokens:0,outputTokens:0}})];
  const run=projectPilotEvents(events);assert.equal(run.responses.length,2);assert.deepEqual(run.responses.map(item=>item.request),[1,3]);assert.equal(run.usage,null);
  assert.deepEqual(run.responses[0]?.usage,{inputTokens:17,outputTokens:0});assert.equal(run.responses[1]?.usage,null);
  const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,selectedRunId:runId,events},actions,mode:'live'}));
  assert.match(html,/data-response-request="1"><td>1<\/td><td>reported-model<\/td><td>17<\/td><td>0<\/td>/);
  assert.match(html,/data-response-request="3"><td>3<\/td><td>未知<\/td><td>未知<\/td><td>未知<\/td>/);
  assert(!html.includes('data-response-request="2"'));assert(html.includes('不代表全部请求或总费用'));
});

test('Q04 response model text stays escaped and absent responses do not create synthetic usage rows',()=>{
  const before=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,selectedRunId:runId,events:[accepted()]},actions,mode:'live'}));
  assert(!before.includes('data-response-request'));assert(before.includes('未知'));
  const events=[accepted(),event(2,'model.response',{request:2,responseModel:'<img src=x onerror=alert(1)>',usage:null})];
  const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,selectedRunId:runId,events},actions,mode:'live'}));
  assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('data-response-request="2"'));
});

test('F08 keeps chunked Markdown together and separates steps, tools and answers in event order',()=>{
  const events=[accepted(),event(2,'model.step',{step:1,usage:null}),event(3,'message.delta',{text:'## 计算计划\n\n先**'}),
    event(4,'model.response',{request:1,responseModel:'reported',usage:null}),event(5,'message.delta',{text:'求和**。'}),
    event(6,'tool.started',{callId:'sum.1',toolName:'pilot.sum.v1',arguments:{values:[18,-7,4]}}),
    event(7,'tool.completed',{callId:'sum.1',result:{sum:15,count:3,source:'deterministic-local',toolVersion:'pilot.sum.v1'}}),
    event(8,'model.step',{step:2,usage:null}),event(9,'message.delta',{text:'已得到 **15**。'}),event(10,'question.asked',{questionId:'q.choose',prompt:'是否排除负数？'}),
    event(11,'question.answered',{questionId:'q.choose',answer:'排除负数。'}),event(12,'model.step',{step:3,usage:null}),event(13,'message.delta',{text:'按你的回答继续。'})];
  const run=projectPilotEvents(events);assert.deepEqual(run.transcript.map(item=>item.kind),['text','tool','text','answer','text']);
  assert.equal(run.transcript[0]?.kind==='text'&&run.transcript[0].text,'## 计算计划\n\n先**求和**。');
  assert.equal(run.transcript[1]?.kind==='tool'&&run.transcript[1].tool.result?.sum,15);
  const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,selectedRunId:runId,events},actions,mode:'live'}));
  assert(html.includes('<h2>计算计划</h2>'));assert(html.includes('<strong>求和</strong>'));
  assert(html.indexOf('data-message-event="3"')<html.indexOf('data-call-id="sum.1"'));assert(html.indexOf('data-call-id="sum.1"')<html.indexOf('data-message-event="9"'));
  assert(html.indexOf('你的回答')<html.indexOf('按你的回答继续'));assert.equal(html.split('排除负数。').length-1,1);
});

test('F08 never interprets model HTML or Markdown file paths as executable project citations',()=>{
  const events=[accepted(),event(2,'message.delta',{text:'<img src=x onerror=alert(1)>\n\n[资料](file:///C:/private.txt)\n\n```txt\n<script>bad()</script>\n```'})];
  const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,selectedRunId:runId,events},actions,mode:'live'}));
  assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(!html.includes('href="file:'));assert(html.includes('&lt;script&gt;'));assert(html.includes('chat-code-block'));
});

test('citation frame renders the supplied excerpt without a file opener or HTML interpretation',()=>{
  const html=renderToStaticMarkup(createElement(ProjectCitationViewer,{title:'notes.md',context:createElement('p',null,'任务时版本 · 第12001行'),onClose:()=>{throw new Error('Rendering must not close');},restoreFocus:null,children:'<script>not code</script>\n后部片段'}));
  assert(html.includes('关闭引用片段'));assert(html.includes('第12001行'));assert(html.includes('后部片段'));assert(html.includes('tabindex="0"'));
  assert(!html.includes('<script>'));assert(!html.includes('iframe'));assert(!html.includes('file://'));
});

test('project choices export only IDs and display names without workspace file or chat content',()=>{
  const projects=[{id:'project-a',name:'项目A',documents:[{text:'private file'}],sessionIds:['private chat']},{id:'project-b',name:'项目B',documents:[],sessionIds:[]}];
  const choices=projectChoiceSnapshot('project-b',projects);assert.deepEqual(choices,{activeId:'project-b',projects:[{id:'project-a',name:'项目A'},{id:'project-b',name:'项目B'}]});
  assert(!JSON.stringify(choices).includes('private'));
  const html=renderToStaticMarkup(createElement(ProjectTaskScope,{choices,selectedId:'project-b',onSelect:()=>{throw new Error('Rendering must not switch');},onCreate:()=>{throw new Error('Rendering must not create');},children:'等待核对原目录'}));
  assert(html.includes('下次任务项目'));assert(html.includes('新建项目'));assert(html.includes('value="project-b" selected=""'));assert(!html.includes('input type="file"'));
});
