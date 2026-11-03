import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore, parseProjectReadDisk, ProjectReadStoreError, type ProjectReadDisk, type ProjectReadStoredRun } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { createCommandRepository } from '../apps/desktop/src/main/agent-command/store';
import { reviewInterruptedWork, verifyFrozenWorkRecovery, workRecoveryDigest } from '../apps/desktop/src/main/agent-work-cycle/interrupted-continuation';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadRequests, type ProjectReadToolArguments, type ProjectReadToolCall, type ProjectReadToolName } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadRequest } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import type { WorkCycleControllerRef, WorkCycleContinuationRef } from '../apps/desktop/src/shared/agent/agent-work-cycle';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { CommandDriver } from '../apps/desktop/src/main/agent-command/types';
import type { CommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command';
import { commandDigest } from '../apps/desktop/src/main/agent-command/logs';
import { commandChangesVersion } from '../apps/desktop/src/main/agent-command/changes';

const guardian = require('../apps/desktop/src/main/engine-pilot/engine-guardian') as typeof import('../apps/desktop/src/main/engine-pilot/engine-guardian');
const product = path.resolve('C:/work/analog_ai_workbench'), fixtures = path.join(product, '.local/agent-project-read-tests');
const sha = commandDigest('new synthetic interrupted fixture'), empty = commandDigest('');
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const controller: WorkCycleControllerRef = { guardianId: '12345678-1234-4123-8123-123456789abc', guardianPid: 1234, enginePid: 5678, intentVersion: sha, readyVersion: sha };
const environment: CommandEnvironment = { environmentId:'synthetic-env',revision:sha,displayName:'No real program',platform:'windows',shell:{kind:'powershell',version:'fake',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16*1024*1024,defaultTimeoutMs:120000,maxTimeoutMs:600000} };
const ok = <T>(result: {ok:true;value:T}|{ok:false;error:unknown}): T => result.ok ? result.value : assert.fail(JSON.stringify(result));
function fixture() {
  const base = path.join(fixtures, randomUUID()), source = path.join(base, 'source'); fs.mkdirSync(source, {recursive:true});
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Synthetic interrupted continuation author checks only.\n');
  const ledgers = new Map<string,string>([['live-ledger',base]]);
  return { base, ledgers, root:captureFolderRoot(randomUUID(),randomUUID(),source), workspaces:path.join(base,'agent-work-cycle','workspaces'), commands:path.join(base,'agent-command','runs'),
    remove() { for(const folder of ledgers.values()){const exact=fs.realpathSync.native(folder);assert.equal(exact,folder);assert.match(path.relative(fixtures,exact),/^[a-f0-9-]{36}$/u);fs.rmSync(exact,{recursive:true});} } };
}
function call<K extends ProjectReadToolName>(input: ProjectReadEngineInput, name: K, args: ProjectReadToolArguments[K]) {
  return input.callbacks.tool({sessionId:'session-'+input.runId,messageId:'message',callId:randomUUID(),toolName:name,arguments:args} as ProjectReadToolCall);
}
function harness(f: ReturnType<typeof fixture>, ledger: string, action: (input:ProjectReadEngineInput)=>Promise<void>, initial?: ProjectReadDisk, rejectStarted=false) {
  let folder=f.ledgers.get(ledger);if(!folder){folder=path.join(fixtures,randomUUID());f.ledgers.set(ledger,folder);}
  const directory = path.join(folder,'agent-project-read'), store = createProjectReadStore(product,directory); store.load(); if(initial)store.save(initial);
  const arbiter = createAgentRuntimeArbiter(); let starts=0, programs=0;
  const driver:CommandDriver = {environment,async start(_record,baseline,callbacks) {
    programs++; const time=new Date().toISOString(); await callbacks.started(time);
    const reports = ['summary.txt','values.json'].map((relativePath,i)=>{const bytes=Buffer.from(i===0?'Confirmed synthetic result\n':'{"result":42}\n');return {relativePath,beforeVersion:null,version:commandDigest(bytes),bytes};});
    const changes={baselineVersion:baseline.version,files:reports,deleted:[]};
    return {stop(){assert.fail('settled synthetic command must not be stopped');},done:Promise.resolve({exit:{shellExitCode:0,shellExited:true,observedAt:time,termination:'exited'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},eof:{stdout:true,stderr:true},logSha256:{stdout:empty,stderr:empty},error:null,changes:{...changes,manifestVersion:commandChangesVersion(changes)}})};
  }};
  const engine:ProjectReadEngine = {status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),
    async start(input){starts++;input.callbacks.notice({type:'started',sessionId:'session-'+input.runId,controller});input.callbacks.notice({type:'step',step:1,usage:null});await action(input);if(!input.signal.aborted)input.callbacks.notice({type:'completed'});},answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{}};
  const checkedStore={load:()=>store.load(),save(next:ProjectReadDisk){if(rejectStarted&&next.runs.some(row=>row.run.events.some(e=>e.type==='run.started')))throw new ProjectReadStoreError();store.save(next);},close:()=>store.close()};
  const host=createProjectReadHost({store:checkedStore,arbiter,bindings:{snapshotBinding:()=>({ok:true,value:{folder:f.root,name:'Recovery synthetic'}})},models:{status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>({apiKey:'synthetic',model,maxRequests:24,maxOutputTokens:16384,requestTimeoutMs:600000}),forget(){},close(){}},createEngine:()=>engine,
    workCycle:{directory:f.workspaces,createWorkspace:createWorkCycleWorkspace,createRunner:()=>({available:()=>({available:true,language:'javascript',isolation:'windows-appcontainer'}),async run(){assert.fail('no legacy program');},async close(){}})},commands:{directory:f.commands,drivers:[driver]}});
  const request=():ProjectReadRequests['startWorkRun']=>({contractVersion:V,clientRequestId:randomUUID(),projectId:f.root.projectId,bindingId:f.root.bindingId,model,goal:'New explicit goal',constraint:'Synthetic only',continuedFrom:null});
  const record=(id:string)=>store.load().runs.find(row=>row.run.runId===id)??assert.fail('missing record');
  return {host,store,request,record,counts:()=>({starts,programs}),async wait(id:string){const deadline=performance.now()+5000;while(performance.now()<deadline){const row=record(id);if(['completed','failed','stopped'].includes(row.run.status)&&row.run.cleanupState==='idle')return row;await new Promise<void>(resolve=>setImmediate(resolve));}return assert.fail('bounded author host timeout');},
    async close(uncertain=false){if(uncertain){await host.shutdown().catch(()=>{});await arbiter.close().catch(()=>{});}else{await host.shutdown();await arbiter.close();}store.close();}};
}
const previewRequest=(f:ReturnType<typeof fixture>,parent:ProjectReadStoredRun)=>({contractVersion:V,projectId:f.root.projectId,bindingId:f.root.bindingId,runId:parent.run.runId,expectedEventCount:parent.run.eventCount});
const continued=(h:ReturnType<typeof harness>,source:WorkCycleContinuationRef):ProjectReadRequests['startWorkRun']=>({...h.request(),continuedFrom:source.runId,expectedEventCount:source.eventCount,baselineVersion:source.baselineVersion,...(source.recovery?{recoveryVersion:source.recovery.version}:{})});
async function parentCommand(input:ProjectReadEngineInput) {
  ok(await call(input,'work_write',{relativePath:'notes.txt',expectedVersion:null,text:'Original confirmed note\n'}));
  const inspected=ok(await call(input,'command_environment',{})); if(inspected.kind!=='command_environment'||!inspected.workspace)return assert.fail('missing workspace');
  const launched=ok(await call(input,'command_start',{requestId:randomUUID(),environmentId:environment.environmentId,environmentRevision:sha,workspaceId:inspected.workspace.workspaceId,baselineVersion:inspected.workspace.baselineVersion,cwdRelativePath:'',commandText:'synthetic only; never executed',timeoutMs:120000}));
  if(launched.kind!=='command_start')return assert.fail('missing command');
  let current=launched.execution;
  for(let i=0;i<8&&current.phase!=='terminal'&&current.phase!=='reconciliation_required';i++){const read=ok(await call(input,'command_status',{executionId:current.executionId,afterRevision:current.revision,waitMs:25000}));if(read.kind!=='command_status')return assert.fail('missing status');current=read.execution;}
  assert.equal(current.phase,'terminal');assert.equal(current.artifacts.length,2);assert.equal(current.cleanup.state,'confirmed');
}

test('interrupted review creates one explicit child, freezes command evidence and preserves cold history and parent bytes',async t=>{
  t.mock.method(guardian,'verifyClosedEngineController',(ref:WorkCycleControllerRef)=>({...ref,resultVersion:sha}));
  const f=fixture();let captured:ProjectReadDisk|undefined;
  const live=harness(f,'live-ledger',async input=>{await parentCommand(input);captured=structuredClone(live.store.load());});
  const parentId=ok(await live.host.invoke('startWorkRun',live.request(),()=>true)).runId;
  try{assert.equal((await live.wait(parentId)).run.status,'completed');assert.deepEqual(live.counts(),{starts:1,programs:1});}finally{await live.close();}
  const h=harness(f,'recovery-ledger',async input=>{
    const files=ok(await call(input,'work_list',{}));if(files.kind!=='work_list')return assert.fail('missing files');assert.equal(files.files.length,3);
    for(const file of files.files){assert.equal(file.origin.kind,'continuation');ok(await call(input,'work_read',{fileId:file.fileId,version:file.version,offset:0}));}
    ok(await call(input,'work_write',{relativePath:'follow-up.txt',expectedVersion:null,text:'Read confirmed prior result 42.\n'}));
  },captured!);
  let childId='',childRequest:ProjectReadRequests['startWorkRun'];
  try{
    const parent=h.record(parentId),before=JSON.stringify(parent),manifest=path.join(f.workspaces,parent.run.workCycle!.workspaceId,'workspace.json'),workspaceBytes=fs.readFileSync(manifest);
    assert.equal(parent.run.status,'interrupted');assert.equal(parent.run.cleanupState,'failed');
    const preview=ok(await h.host.invoke('prepareWorkContinuation',previewRequest(f,parent),()=>true));assert.equal(preview.fileCount,3);assert.equal(preview.baseline.recovery?.commands.length,1);
    assert.deepEqual(ok(await h.host.invoke('prepareWorkContinuation',previewRequest(f,parent),()=>true)),preview);
    assert.equal(ok(await h.host.invoke('getStatus',{contractVersion:V,projectId:f.root.projectId},()=>true)).canStart,true);
    const stale=await h.host.invoke('startWorkRun',{...continued(h,preview.baseline),recoveryVersion:'b'.repeat(64)},()=>true);assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,'CONFLICT');
    assert.deepEqual(h.counts(),{starts:0,programs:0});
    childRequest=continued(h,preview.baseline);
    const [a,b]=await Promise.all([h.host.invoke('startWorkRun',childRequest,()=>true),h.host.invoke('startWorkRun',childRequest,()=>true)]);
    childId=ok(a).runId;assert.equal(ok(b).runId,childId);assert.equal((await h.wait(childId)).run.status,'completed');assert.deepEqual(h.counts(),{starts:1,programs:0});
    assert.equal(JSON.stringify(h.record(parentId)),before);assert.deepEqual(fs.readFileSync(manifest),workspaceBytes);
    const saved=h.record(childId).run.workCycle!.continuation!;assert.deepEqual(saved,preview.baseline);verifyFrozenWorkRecovery(parent,saved);
    const tampered=structuredClone(h.store.load());const child=structuredClone(tampered.runs.find(row=>row.run.runId===childId)!);const wrong={...saved,recovery:{...saved.recovery!,parentEventsSha256:empty}};
    const invalid={...child,run:{...child.run,workCycle:{...child.run.workCycle!,continuation:wrong},events:child.run.events.map(e=>e.type==='run.accepted'?{...e,data:{...e.data,workCycle:{...child.run.workCycle!,continuation:wrong}}}:e)}};
    assert.equal(parseProjectReadDisk({...tampered,runs:tampered.runs.map(row=>row.run.runId===childId?invalid:row)}),null);
    // Subsequent mutable command revision is deliberately outside cold disk decoding.
    const commandDirectory=path.join(f.commands,parentId),recordFile=fs.readdirSync(commandDirectory,{withFileTypes:true}).find(e=>e.isDirectory());assert.ok(recordFile);
    assert.ok(parseProjectReadDisk(h.store.load()));
  }finally{await h.close();}
  const cold=harness(f,'recovery-ledger',async()=>assert.fail('cold history must not execute'));
  try{assert.equal(ok(await cold.host.invoke('readRun',{contractVersion:V,runId:childId,after:0},()=>true)).run.status,'completed');assert.equal(ok(await cold.host.invoke('startWorkRun',childRequest!,()=>true)).runId,childId);assert.deepEqual(cold.counts(),{starts:0,programs:0});}finally{await cold.close();f.remove();}
});

test('current interrupted checks reject missing lifecycle, incomplete claims, changed preview and live workspace writer',async t=>{
  let proof=sha;const stub=t.mock.method(guardian,'verifyClosedEngineController',(ref:WorkCycleControllerRef)=>({...ref,resultVersion:proof}));
  const f=fixture();let captured:ProjectReadDisk|undefined;
  const live=harness(f,'live-ledger',async input=>{await parentCommand(input);captured=structuredClone(live.store.load());});const parentId=ok(await live.host.invoke('startWorkRun',live.request(),()=>true)).runId;
  await live.wait(parentId);await live.close();
  const h=harness(f,'recovery-ledger',async()=>assert.fail('negative test cannot execute'),captured!);
  try{
    const parent=h.record(parentId),request=previewRequest(f,parent),preview=ok(await h.host.invoke('prepareWorkContinuation',request,()=>true));
    proof=empty;const stale=await h.host.invoke('startWorkRun',continued(h,preview.baseline),()=>true);assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,'CONFLICT');proof=sha;
    const workspace=await createWorkCycleWorkspace({directory:path.join(f.workspaces,parent.run.workCycle!.workspaceId),runId:parentId,workspaceId:parent.run.workCycle!.workspaceId,readOnly:true,requireStoppedWriter:true,signal:new AbortController().signal});
    const repository=createCommandRepository({directory:path.join(f.commands,parentId),runId:parentId,readOnly:true});
    try{
      const baseline=await workspace.exportConfirmedBase(),records=repository.load(),closed={...controller,resultVersion:sha};
      const recover=reviewInterruptedWork(parent,baseline,records,closed);assert.deepEqual(recover,preview.baseline);
      assert.throws(()=>reviewInterruptedWork(parent,baseline,[],closed));
      const missing={...parent,run:{...parent.run,events:parent.run.events.map(e=>e.type==='run.started'?{...e,data:{sessionId:e.data.sessionId,engine:e.data.engine,version:e.data.version}}:e)}};
      assert.throws(()=>reviewInterruptedWork(missing,baseline,records,closed));
      assert.throws(()=>reviewInterruptedWork(parent,{...baseline,files:[]},records,closed));
      assert.throws(()=>reviewInterruptedWork(parent,baseline,records,{...closed,enginePid:9999}));
      const pending={...parent,run:{...parent.run,events:[...parent.run.events,{runId:parentId,sequence:parent.run.events.length+1,time:parent.run.updatedAt,type:'tool.started' as const,data:{sessionId:'session-'+parentId,messageId:'message',callId:'unknown-write',toolName:'work_write' as const,arguments:{relativePath:'unknown.txt',expectedVersion:null,text:'unconfirmed'}}}],eventCount:parent.run.eventCount+1}};
      assert.throws(()=>reviewInterruptedWork(pending,baseline,records,closed));
      const old=records[0]!,changed={...old,execution:{...old.execution,revision:old.execution.revision+1}};
      const newer=reviewInterruptedWork(parent,baseline,[changed],closed);assert.notEqual(newer.recovery!.version,recover.recovery!.version);verifyFrozenWorkRecovery(parent,recover);
    }finally{repository.close();await workspace.close();}
    const lock=path.join(f.workspaces,parent.run.workCycle!.workspaceId,'writer.lock');fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:randomUUID()}),{flag:'wx'});
    const held=await h.host.invoke('prepareWorkContinuation',request,()=>true);assert.equal(held.ok,false);if(!held.ok)assert.equal(held.error.code,'CLEANUP_FAILED');
    assert.ok(stub.mock.callCount()>0);assert.deepEqual(h.counts(),{starts:0,programs:0});
  }finally{await h.close();f.remove();}
});

test('v6 schema keeps normal Q02 shape and rejects malformed recovery request values',()=>{
  const base={contractVersion:V,clientRequestId:randomUUID(),projectId:randomUUID(),bindingId:randomUUID(),model,goal:'Continue',constraint:'',continuedFrom:'project-parent',expectedEventCount:8,baselineVersion:sha};
  assert.ok(parseProjectReadRequest('startWorkRun',base));assert.ok(parseProjectReadRequest('startWorkRun',{...base,recoveryVersion:sha}));
  assert.equal(parseProjectReadRequest('startWorkRun',{...base,recoveryVersion:'unknown'}),null);
  assert.equal(parseProjectReadRequest('startWorkRun',{...base,continuedFrom:null,recoveryVersion:sha}),null);
  assert.equal(workRecoveryDigest({a:1,b:2}),workRecoveryDigest({b:2,a:1}));
});

test('started controller persistence failure aborts before any tool can write or launch',async()=>{
  const f=fixture();let done!:()=>void;const checked=new Promise<void>(resolve=>{done=resolve;});let writeDenied=false;
  const h=harness(f,'live-ledger',async input=>{try{assert.equal(input.signal.aborted,true);await assert.rejects(call(input,'work_write',{relativePath:'forbidden.txt',expectedVersion:null,text:'must not persist'}));writeDenied=true;}finally{done();}},undefined,true);
  try{const id=ok(await h.host.invoke('startWorkRun',h.request(),()=>true)).runId;await checked;assert.equal(writeDenied,true);assert.deepEqual(h.counts(),{starts:1,programs:0});
    const parent=h.record(id);assert.equal(parent.run.events.some(e=>e.type==='run.started'),false);const manifest=JSON.parse(fs.readFileSync(path.join(f.workspaces,parent.run.workCycle!.workspaceId,'workspace.json'),'utf8'));assert.deepEqual(manifest.files,[]);
    assert.equal(ok(await h.host.invoke('getStatus',{contractVersion:V,projectId:f.root.projectId},()=>true)).canStart,false);
  }finally{await h.close(true);f.remove();}
});
