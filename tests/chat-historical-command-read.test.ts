import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import {createProjectReadStore,parseProjectReadDisk,projectReadDependents} from '../apps/desktop/src/main/agent-project-read/store';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {createWorkCycleWorkspace} from '../apps/desktop/src/main/agent-work-cycle/workspace';
import {captureFolderRoot} from '../apps/desktop/src/main/cloud/project-folder-files';
import {ProjectReadFsError} from '../apps/desktop/src/main/cloud/project-read-files';
import {commandDigest} from '../apps/desktop/src/main/agent-command/logs';
import {createCommandDiagnosticJournal} from '../apps/desktop/src/main/agent-command/diagnostics';
import {createCommandHistoryAudit} from '../apps/desktop/src/main/agent-command/history';
import type {CommandDriver,CommandDriverOutcome} from '../apps/desktop/src/main/agent-command/types';
import type {CommandEnvironment} from '../apps/desktop/src/shared/agent/agent-command';
import type {ProjectReadEngine,ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import type {ProjectReadModelSnapshots} from '../apps/desktop/src/main/agent-project-read/runtime';
import {AGENT_PROJECT_READ_VERSION as V,type ProjectReadToolCall,type ProjectReadToolName,type ProjectReadToolArguments} from '../apps/desktop/src/shared/agent/agent-project-read';

const product=path.resolve('C:/work/analog_ai_workbench'),parent=path.join(product,'.local','agent-project-read-tests');
const sha=commandDigest('synthetic historical command'),model={provider:'kimi',model:'kimi-k3'} as const;
const environment:CommandEnvironment={environmentId:'synthetic-env',revision:sha,displayName:'No process',platform:'windows',shell:{kind:'powershell',version:'fake',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16*1024*1024,defaultTimeoutMs:120000,maxTimeoutMs:600000}};
const ok=<T>(r:{ok:true;value:T}|{ok:false;error:unknown}):T=>r.ok?r.value:assert.fail(JSON.stringify(r));
const call=<K extends ProjectReadToolName>(toolName:K,args:ProjectReadToolArguments[K]):ProjectReadToolCall=>({sessionId:'native',messageId:'message',callId:randomUUID(),toolName,arguments:args}) as ProjectReadToolCall;
function fingerprint(directory:string):unknown[]{return fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(entry=>{const target=path.join(directory,entry.name);if(entry.isDirectory())return [entry.name,fingerprint(target)];const stat=fs.statSync(target,{bigint:true});return [entry.name,stat.mtimeNs.toString(),commandDigest(fs.readFileSync(target))];});}

test('chat reads its previous command after host/store reopen without work, recovery, driver calls or changing old evidence',async()=>{
  const base=path.join(parent,randomUUID()),directory=path.join(base,'source');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'AGENTS.md'),'Synthetic only.');
  const projectId=randomUUID(),chatId=randomUUID(),root=captureFolderRoot(projectId,randomUUID(),directory);
  const journal=createCommandDiagnosticJournal({directory:path.join(base,'diagnostics'),appVersion:'0.1.0-test'});
  let selectedRoot=root,store=createProjectReadStore(product,path.join(base,'agent-project-read')),arbiter=createAgentRuntimeArbiter();
  const counters={workspaces:0,runners:0,heads:0,starts:0,stops:0,recoveries:0,engineStarts:0};
  let diagnosticReveals=0;
  const logText='Synthetic durable stdout.\n';
  const driver:CommandDriver={environment,async start(_record,_baseline,callbacks){
    counters.starts++;let resolve!:(value:CommandDriverOutcome)=>void;const done=new Promise<CommandDriverOutcome>(r=>{resolve=r;});
    await callbacks.started(new Date().toISOString());await callbacks.log('stdout',Buffer.from(logText));
    return {done,stop(){counters.stops++;const time=new Date().toISOString();resolve({exit:{shellExitCode:125,shellExited:true,observedAt:time,termination:'stopped'},job:{activeProcesses:null,emptyConfirmed:false,observedAt:time},cleanup:{state:'failed',observedAt:time,proofSha256:null},eof:{stdout:true,stderr:true},logSha256:{stdout:commandDigest(logText),stderr:commandDigest('')},error:null});}};
  },async recover(){counters.recoveries++;return null;}};
  const engine:ProjectReadEngine&{setProjectContext():void}={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),async start(){counters.engineStarts++;assert.fail('No model transport');},answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{},setProjectContext(){}};
  const models:ProjectReadModelSnapshots={status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>assert.fail('No API credentials'),forget(){},close(){}};
  const makeHost=()=>createProjectReadHost({store,arbiter,bindings:{snapshotBinding:id=>({ok:true,value:{folder:{...selectedRoot,projectId:id},name:'Synthetic'}})},models,createEngine:()=>engine,
    workCycle:{directory:path.join(base,'agent-work-cycle','workspaces'),createWorkspace:async o=>{counters.workspaces++;return createWorkCycleWorkspace(o);},createRunner:()=>{counters.runners++;return {available:()=>({available:true,language:'javascript',isolation:'windows-appcontainer'}),run:async()=>assert.fail('No program'),close:async()=>{}};}},commands:{directory:path.join(base,'agent-command','runs'),drivers:[driver],diagnostics:journal,revealDiagnostics:async()=>{diagnosticReveals++;return true;}}});
  let host=makeHost();
  async function attach(sessionId=chatId,project=projectId){
    const runId=randomUUID(),abort=new AbortController(),lease=arbiter.reserveRun({mode:'conversation',runId,project:null,status:'running',cleanupState:'idle'},()=>abort.abort());
    const links:unknown[]=[];
    const callbacks=await host.attachChat({runId,origin:{chatSessionId:sessionId,turnId:randomUUID(),executionId:randomUUID(),inputDigest:sha},model,snapshot:host.captureChat(project),lease,abort,engine,outputBytes:65536,
      history:[{type:'run.started',data:{sessionId:'native',engine:'opencode',version:'1.18.17'}},{type:'model.step',data:{step:1}}],
      prepareWorkHead:async()=>{counters.heads++;return null;},onLinked:link=>links.push(link),onReady(){},onFailure(){}},null);
    return {runId,callbacks,links};
  }
  async function reopen(){await host.shutdown().catch(()=>{});await arbiter.close().catch(()=>{});store.close();store=createProjectReadStore(product,path.join(base,'agent-project-read'));arbiter=createAgentRuntimeArbiter();host=makeHost();}
  try{
    const first=await attach(),environmentValue=ok(await first.callbacks.tool(call('command_environment',{})));assert.equal(environmentValue.kind,'command_environment');
    if(environmentValue.kind!=='command_environment'||!environmentValue.workspace)return assert.fail('Workspace required');
    const startArgs={requestId:randomUUID(),environmentId:environment.environmentId,environmentRevision:sha,workspaceId:environmentValue.workspace.workspaceId,baselineVersion:environmentValue.workspace.baselineVersion,cwdRelativePath:'',commandText:'synthetic command only',timeoutMs:120000};
    const launched=ok(await first.callbacks.tool(call('command_start',startArgs)));assert.equal(launched.kind,'command_start');if(launched.kind!=='command_start')return;
    assert.equal(launched.execution.phase,'intent');assert.equal(launched.execution.startedAt,null);
    const repeated=ok(await first.callbacks.tool(call('command_start',startArgs)));assert.equal(repeated.kind,'command_start');if(repeated.kind!=='command_start')return;
    assert.equal(repeated.execution.executionId,launched.execution.executionId);assert.equal(counters.starts,1);
    const live=ok(await first.callbacks.tool(call('command_status',{executionId:launched.execution.executionId,afterRevision:null,waitMs:0})));assert.equal(live.kind,'command_status');if(live.kind!=='command_status')return;
    assert.equal(live.observation,undefined);assert.equal(live.execution.runId,first.runId);
    await assert.rejects(host.finishChat(first.runId,'failed'));
    const oldRun=structuredClone(store.load().runs[0]!);assert.equal(oldRun.run.cleanupState,'failed');
    await reopen();
    const before={...counters},commandDirectory=path.join(base,'agent-command','runs'),oldCommandFiles=fingerprint(commandDirectory),oldWorkspaceFiles=fingerprint(path.join(base,'agent-work-cycle','workspaces'));
    const second=await attach(),statusCall=call('command_status',{executionId:launched.execution.executionId,afterRevision:1,waitMs:25000}),started=performance.now();
    const pending=second.callbacks.tool(statusCall);assert.equal(second.callbacks.tool(statusCall),pending);
    const status=ok(await pending);assert(performance.now()-started<2000,'Uncertain persisted status returns immediately');
    assert.equal(status.kind,'command_status');if(status.kind!=='command_status')return;
    assert.equal(status.execution.executionId,launched.execution.executionId);assert.equal(status.execution.runId,first.runId);assert.equal(status.execution.workspaceId,launched.execution.workspaceId);
    assert.equal(status.execution.phase,'reconciliation_required');assert.equal(status.execution.cleanup.state,'failed');assert.equal(status.execution.error?.code,'RECONCILIATION_REQUIRED');
    assert.equal(status.execution.stopRequested?.reason,'engine_failure','Engine failure must not be attributed to a user stop');
    assert.deepEqual(status.observation,{runId:first.runId,startSequence:oldRun.run.events.find(e=>e.type==='tool.completed'&&e.data.toolName==='command_start')!.sequence});
    const logged=ok(await second.callbacks.tool(call('command_log',{executionId:launched.execution.executionId,stream:'stdout',offset:0,maxBytes:4096,expectedPrefixVersion:null})));assert.equal(logged.kind,'command_log');
    if(logged.kind!=='command_log')return;assert.equal(logged.page.data,logText);assert.deepEqual(logged.observation,status.observation);
    await host.finishChat(second.runId,'completed');
    assert.deepEqual(counters,before);assert.deepEqual(fingerprint(commandDirectory),oldCommandFiles);assert.deepEqual(fingerprint(path.join(base,'agent-work-cycle','workspaces')),oldWorkspaceFiles);
    const diagnostic=ok(await host.invoke('readCommandDiagnostics',{contractVersion:V,runId:first.runId,executionId:launched.execution.executionId},()=>true));
    assert.equal(diagnostic.diagnostics.unavailable,false);assert(diagnostic.diagnostics.records.some(r=>r.operation==='controller.close'&&r.kind==='cleanup'));
    assert(diagnostic.diagnostics.records.every(r=>r.runId===first.runId&&r.executionId===launched.execution.executionId&&r.chatSessionId===chatId));
    const unpublished='cmd-'+randomUUID();assert(journal.append({runId:first.runId,workspaceId:launched.execution.workspaceId,executionId:unpublished,component:'controller',operation:'record.create',kind:'failure',causeCode:'STORAGE_FAILED'}));
    const beforeReceipt=ok(await host.invoke('readCommandDiagnostics',{contractVersion:V,runId:first.runId,executionId:unpublished},()=>true));assert.equal(beforeReceipt.diagnostics.records[0]!.operation,'record.create');
    const unknownDiagnostic=await host.invoke('readCommandDiagnostics',{contractVersion:V,runId:second.runId,executionId:launched.execution.executionId},()=>true);assert.deepEqual(unknownDiagnostic,{ok:false,error:{code:'RUN_NOT_FOUND'}});
    assert.deepEqual(await host.invoke('openCommandDiagnostics',{contractVersion:V,runId:second.runId,executionId:launched.execution.executionId},()=>true),{ok:false,error:{code:'RUN_NOT_FOUND'}});assert.equal(diagnosticReveals,0);
    assert.deepEqual(ok(await host.invoke('openCommandDiagnostics',{contractVersion:V,runId:first.runId,executionId:launched.execution.executionId},()=>true)),{opened:true});assert.equal(diagnosticReveals,1);
    assert.deepEqual(await host.invoke('openCommandDiagnostics',{contractVersion:V,runId:first.runId,executionId:launched.execution.executionId},()=>false),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.equal(diagnosticReveals,1);
    assert.deepEqual(counters,before);assert.deepEqual(fingerprint(commandDirectory),oldCommandFiles);
    assert.deepEqual(store.load().runs[0],oldRun);assert.deepEqual(second.links,[{runId:second.runId,workspaceId:null}]);
    const saved=store.load(),readRun=saved.runs.find(r=>r.run.runId===second.runId)!.run;assert.equal(readRun.workCycle,undefined);assert.equal(readRun.continuedFrom,null);assert.equal(readRun.status,'completed');
    assert.equal(readRun.events.filter(e=>e.type==='tool.started').length,2);assert.equal(readRun.events.some(e=>(e.type==='tool.started'||e.type==='tool.completed')&&e.data.toolName==='command_start'),false);
    assert.deepEqual(projectReadDependents(saved,first.runId),[second.runId]);
    assert(parseProjectReadDisk(JSON.parse(JSON.stringify(saved))));
    // Preparing work later in this same run must not reset prior observation ordering.
    let workspace:string|undefined;
    const audit=createCommandHistoryAudit(second.runId,()=>workspace,()=>{throw Error('Rejected history');},()=>launched.execution);
    const observed=readRun.events.find(e=>e.type==='tool.completed'&&e.data.toolName==='command_status')!;assert(observed.type==='tool.completed');audit(observed.data);
    workspace='work-'+randomUUID();assert(status.execution.revision>1);
    assert.throws(()=>audit({...observed.data,result:{ok:true,value:{...status,execution:{...status.execution,revision:status.execution.revision-1}}}}),/Rejected history/u);
    // Both durable ledgers reopen again, retaining explicit provenance and original IDs.
    await reopen();assert.deepEqual(store.load(),saved);assert.deepEqual(counters,before);assert.deepEqual(fingerprint(commandDirectory),oldCommandFiles);
    const page=ok(await host.invoke('readRun',{contractVersion:V,runId:second.runId,after:0},()=>true));assert.equal(page.run.status,'completed');
    const mutations:Array<(disk:any)=>void>=[
      disk=>disk.runs.splice(0,1),
      disk=>disk.runs.reverse(),
      disk=>{const r=disk.runs[1].run;r.origin.chatSessionId=randomUUID();r.events[0].data.origin.chatSessionId=r.origin.chatSessionId;},
      disk=>{const r=disk.runs[1].run;r.project.projectId=randomUUID();r.events[0].data.project.projectId=r.project.projectId;disk.runs[1].root.projectId=r.project.projectId;},
      disk=>{disk.runs[1].run.events.find((e:any)=>e.type==='tool.completed').data.result.value.observation.startSequence=2;},
      disk=>{delete disk.runs[1].run.events.find((e:any)=>e.type==='tool.completed').data.result.value.observation;},
      disk=>{disk.runs[1].run.events.find((e:any)=>e.type==='tool.completed').data.result.value.execution.requestId=randomUUID();},
    ];
    for(const mutate of mutations){const forged=structuredClone(saved);mutate(forged);assert.equal(parseProjectReadDisk(forged),null,'Forged observation must fail durable audit');}
    // Known ID possession alone cannot cross chat, project or binding boundaries.
    for(const scope of ['chat','project','binding','unknown'] as const){
      selectedRoot=scope==='binding'?captureFolderRoot(projectId,randomUUID(),directory):root;
      const denied=await attach(scope==='chat'?randomUUID():chatId,scope==='project'?randomUUID():projectId);
      const result=await denied.callbacks.tool(call('command_status',{executionId:scope==='unknown'?'cmd-'+randomUUID():launched.execution.executionId,afterRevision:1,waitMs:25000}));
      assert.deepEqual(result,{ok:false,error:{code:'RUN_NOT_FOUND'},coverage:null});
      const log=await denied.callbacks.tool(call('command_log',{executionId:scope==='unknown'?'cmd-'+randomUUID():launched.execution.executionId,stream:'stdout',offset:0,maxBytes:4096,expectedPrefixVersion:null}));
      assert.deepEqual(log,{ok:false,error:{code:'RUN_NOT_FOUND'},coverage:null});await host.finishChat(denied.runId,'completed');
      assert.equal(store.load().runs.find(r=>r.run.runId===denied.runId)!.run.workCycle,undefined);
    }
    assert.deepEqual(counters,before);assert.deepEqual(fingerprint(commandDirectory),oldCommandFiles);assert.deepEqual(store.load().runs[0],oldRun);
    // Reclaiming only the observation ledger cannot select the old command's files.
    const capacity=ok(await host.invoke('getTaskCapacity',{contractVersion:V,projectId:null},()=>true));
    const readCapacity=capacity.runs.find(r=>r.runId===second.runId)!;assert(readCapacity.canDelete);
    ok(await host.invoke('deleteRun',{contractVersion:V,runId:second.runId,expectedEventCount:readRun.eventCount},()=>true));
    assert(!store.load().runs.some(r=>r.run.runId===second.runId));assert.deepEqual(store.load().runs[0],oldRun);assert.deepEqual(fingerprint(commandDirectory),oldCommandFiles);
    selectedRoot=root;
    // A separate new mutation still passes the original pending-cleanup admission.
    const blocked=await attach();await assert.rejects(blocked.callbacks.tool(call('command_start',{...startArgs,requestId:randomUUID()})),(error:unknown)=>error instanceof ProjectReadFsError&&error.code==='CLEANUP_FAILED');
    await host.finishChat(blocked.runId,'failed');assert.equal(counters.starts,before.starts);assert.equal(counters.workspaces,before.workspaces);assert.equal(counters.runners,before.runners);assert.equal(counters.recoveries,before.recoveries+1);
    assert.deepEqual(store.load().runs[0],oldRun);assert.deepEqual(fingerprint(commandDirectory),oldCommandFiles);
  }finally{await host.shutdown().catch(()=>{});await arbiter.close().catch(()=>{});store.close();const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});
