import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { parseProjectReadDisk, ProjectReadStoreError, type ProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { type WorkCycleSeed, type WorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/types';
import { reviewInterruptedWork, verifyFrozenWorkRecovery, workRecoveryDigest } from '../apps/desktop/src/main/agent-work-cycle/interrupted-continuation';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadRequests, type ProjectReadToolCall } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { ProjectReadEngineInput, ProjectReadEngine } from '../apps/desktop/src/main/agent-project-read/engine';
import type { WorkCycleControllerRef } from '../apps/desktop/src/shared/agent/agent-work-cycle';

const guardian = require('../apps/desktop/src/main/engine-pilot/engine-guardian') as typeof import('../apps/desktop/src/main/engine-pilot/engine-guardian');
const nativeFiles = require('../apps/desktop/src/main/agent-command/native-files') as typeof import('../apps/desktop/src/main/agent-command/native-files');
const product = path.resolve('C:/work/analog_ai_workbench');
const sha = workRecoveryDigest('independent new synthetic fixture');
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const controller: WorkCycleControllerRef = { guardianId: randomUUID(), guardianPid: 4242, enginePid: 4343, intentVersion: sha, readyVersion: sha };
const ok = <T>(value: {ok:true;value:T}|{ok:false;error:unknown}): T => value.ok ? value.value : assert.fail(JSON.stringify(value));
const codeIs = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await tick();
  assert.ok(predicate(), 'bounded synthetic callback completion');
}
function fixture(t: TestContext) {
  const base = path.join(product, '.local/agent-project-read-tests', randomUUID());
  assert.equal(fs.existsSync(base), false);
  const source = path.join(base, 'source'); fs.mkdirSync(source, {recursive:true});
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'New independent synthetic security fixture only.\n', {flag:'wx'});
  t.diagnostic(`retained new synthetic fixture: ${base}`);
  return {base,root:captureFolderRoot(randomUUID(),randomUUID(),source),workspaces:path.join(base,'agent-work-cycle/workspaces')};
}
type Hooks = {save?: (next:ProjectReadDisk)=>void};
function harness(f: ReturnType<typeof fixture>, action: (input:ProjectReadEngineInput)=>Promise<void>, initial:ProjectReadDisk={version:1,runs:[]}, hooks:Hooks={}) {
  let disk = structuredClone(initial), starts = 0, stops = 0, seeds = 0, programs = 0;
  const store = {load:()=>structuredClone(disk),save(next:ProjectReadDisk){hooks.save?.(next);disk=structuredClone(next);},close(){}};
  const arbiter = createAgentRuntimeArbiter();
  const engine:ProjectReadEngine = {status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,
    accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),
    async start(input){starts++;await action(input);if(!input.signal.aborted)input.callbacks.notice({type:'completed'});},answer:async()=>{},async stop(){stops++;},dispose(){},shutdown:async()=>{}};
  const host = createProjectReadHost({store,arbiter,bindings:{snapshotBinding:()=>({ok:true,value:{folder:f.root,name:'Independent synthetic security'}})},
    models:{status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>({apiKey:'synthetic-unusable',model,maxRequests:24,maxOutputTokens:16384,requestTimeoutMs:600000}),forget(){},close(){}},createEngine:()=>engine,
    workCycle:{directory:f.workspaces,async createWorkspace(options){if(options.seed)seeds++;return createWorkCycleWorkspace(options);},createRunner:()=>({available:()=>({available:true,language:'javascript',isolation:'windows-appcontainer'}),async run(){programs++;return assert.fail('no actual program in independent module tests');},async close(){}})}});
  const request=():ProjectReadRequests['startWorkRun']=>({contractVersion:V,clientRequestId:randomUUID(),projectId:f.root.projectId,bindingId:f.root.bindingId,model,goal:'Independent synthetic check',constraint:'No actual process',continuedFrom:null});
  return {host,request,disk:()=>structuredClone(disk),counts:()=>({starts,stops,seeds,programs}),
    async settled(id:string){await until(()=>disk.runs.some(r=>r.run.runId===id&&['completed','failed','stopped'].includes(r.run.status)&&r.run.cleanupState==='idle'));},
    async close(expectFailure=false){const result=await Promise.allSettled([host.shutdown(),arbiter.close()]);if(!expectFailure)assert.ok(result.every(r=>r.status==='fulfilled'),JSON.stringify(result));}};
}
function started(input:ProjectReadEngineInput) { input.callbacks.notice({type:'started',sessionId:'session-'+input.runId,controller}); }
function write(input:ProjectReadEngineInput, relativePath='confirmed.txt') {
  return input.callbacks.tool({sessionId:'session-'+input.runId,messageId:'message',callId:randomUUID(),toolName:'work_write',arguments:{relativePath,expectedVersion:null,text:'Known confirmed bytes 42\n'}} satisfies ProjectReadToolCall);
}
async function interruptedFixture(t:TestContext) {
  const f=fixture(t);let captured:ProjectReadDisk|undefined;
  const h=harness(f,async input=>{started(input);ok(await write(input));captured=h.disk();});
  const id=ok(await h.host.invoke('startWorkRun',h.request(),()=>true)).runId;
  try{await h.settled(id);}finally{await h.close();}
  assert.ok(captured);assert.ok(parseProjectReadDisk(captured));
  return {f,captured,id};
}

test('IC security: failed run.started persistence closes tool capability immediately and cannot manufacture recoverability',async t=>{
  const f=fixture(t);let checked=false,attempted=0,aborted=false;
  const h=harness(f,async input=>{
    started(input);aborted=input.signal.aborted;
    for(let i=0;i<2;i++){attempted++;await assert.rejects(write(input,'forbidden-'+i+'.txt'),codeIs('CANCELLED'));await tick();}
    checked=true;
  },undefined,{save(next){if(next.runs.some(r=>r.run.events.some(e=>e.type==='run.started')))throw new ProjectReadStoreError('STORAGE_FAILED');}});
  try{
    const id=ok(await h.host.invoke('startWorkRun',h.request(),()=>true)).runId;await until(()=>checked);
    assert.equal(aborted,true);assert.equal(attempted,2);assert.equal(h.counts().programs,0);assert.ok(h.counts().stops>0);
    const disk=h.disk(),row=disk.runs.find(r=>r.run.runId===id)!;
    assert.equal(row.run.events.some(e=>e.type==='run.started'||e.type==='tool.started'||e.type==='tool.completed'),false);
    const saved=JSON.parse(fs.readFileSync(path.join(f.workspaces,row.run.workCycle!.workspaceId,'workspace.json'),'utf8'));
    assert.deepEqual(saved.files,[]);assert.deepEqual(saved.changes,[]);
    const status=ok(await h.host.invoke('getStatus',{contractVersion:V,projectId:f.root.projectId},()=>true));assert.equal(status.canStart,false);
    assert.throws(()=>reviewInterruptedWork(row,{runId:id,workspaceId:row.run.workCycle!.workspaceId,version:sha,files:[]},[],{...controller,resultVersion:sha}),codeIs('CLEANUP_FAILED'));
  }finally{await h.close(true);}
});

test('IC security: final review after accepted persistence rejects a changed controller proof before seed or engine',async t=>{
  const {f,captured,id}=await interruptedFixture(t);let currentProof=sha;
  t.mock.method(guardian,'verifyClosedEngineController',(ref:WorkCycleControllerRef)=>({...ref,resultVersion:currentProof}));
  const h=harness(f,async()=>assert.fail('raced child must not reach engine'),captured,{save(next){if(next.runs.some(r=>r.run.continuedFrom===id))currentProof=workRecoveryDigest('changed after accepted');}});
  try{
    const parent=h.disk().runs[0]!,before=JSON.stringify(parent);
    const preview=ok(await h.host.invoke('prepareWorkContinuation',{contractVersion:V,projectId:f.root.projectId,bindingId:f.root.bindingId,runId:id,expectedEventCount:parent.run.eventCount},()=>true));
    assert.ok(preview.baseline.recovery);
    const child=ok(await h.host.invoke('startWorkRun',{...h.request(),continuedFrom:id,expectedEventCount:parent.run.eventCount,baselineVersion:preview.baseline.baselineVersion,recoveryVersion:preview.baseline.recovery.version},()=>true)).runId;
    await h.settled(child);const row=h.disk().runs.find(r=>r.run.runId===child)!;
    assert.equal(row.run.status,'failed');assert.ok(row.run.events.some(e=>e.type==='run.failed'&&e.data.code==='CONFLICT'));
    assert.equal(h.counts().seeds,0);assert.equal(h.counts().starts,0);assert.equal(h.counts().programs,0);
    assert.equal(fs.existsSync(path.join(f.workspaces,row.run.workCycle!.workspaceId)),false);
    assert.equal(JSON.stringify(h.disk().runs.find(r=>r.run.runId===id)),before);
    verifyFrozenWorkRecovery(parent,row.run.workCycle!.continuation!);
    const cold=structuredClone(h.disk());assert.ok(parseProjectReadDisk(cold),'accepted historical proof survives changed current resource');
    const bad=structuredClone(row.run.workCycle!.continuation!);
    const wrong={...bad,recovery:{...bad.recovery!,controller:{...bad.recovery!.controller,resultVersion:currentProof}}};
    assert.throws(()=>verifyFrozenWorkRecovery(parent,wrong),codeIs('CLEANUP_FAILED'));
  }finally{await h.close();}
});

test('IC security: stopped-writer export refuses live or unknown PID and rechecks ownership before cloning seed',async t=>{
  const f=fixture(t),runId='run-'+randomUUID(),workspaceId='work-'+randomUUID(),directory=path.join(f.workspaces,workspaceId);
  const options={directory,runId,workspaceId,readOnly:false,signal:new AbortController().signal};
  const writer=await createWorkCycleWorkspace(options);await writer.write('new-confirmed',{relativePath:'report.txt',expectedVersion:null,text:'Independent exact bytes\n'});await writer.confirm('new-confirmed');await writer.close();
  const manifest=fs.readFileSync(path.join(directory,'workspace.json'));
  const reader=await createWorkCycleWorkspace({...options,readOnly:true,requireStoppedWriter:true});
  let second:WorkCycleWorkspace|undefined;
  try{
    const baseline=await reader.exportConfirmedBase();
    second=await createWorkCycleWorkspace(options);
    await assert.rejects(reader.exportConfirmedBase(),codeIs('CLEANUP_FAILED'));
    const childId='work-'+randomUUID(),childDirectory=path.join(f.workspaces,childId);
    const seed:WorkCycleSeed={source:{runId,workspaceId,eventCount:6,baselineVersion:baseline.version},files:baseline.files};
    await assert.rejects(createWorkCycleWorkspace({directory:childDirectory,runId:'run-'+randomUUID(),workspaceId:childId,readOnly:false,signal:new AbortController().signal,seed}),codeIs('CLEANUP_FAILED'));
    assert.equal(fs.existsSync(childDirectory),false);await second.close();second=undefined;
    const lock=path.join(directory,'writer.lock'),pid=2147483000,bytes=Buffer.from(JSON.stringify({pid,nonce:randomUUID()}));fs.writeFileSync(lock,bytes,{flag:'wx'});
    const probe=t.mock.method(process,'kill',(actualPid:number,signal?:string|number)=>{assert.equal(actualPid,pid);assert.equal(signal,0);throw Object.assign(Error('unknown identity'),{code:'EPERM'});});
    await assert.rejects(reader.exportConfirmedBase(),codeIs('CLEANUP_FAILED'));assert.deepEqual(fs.readFileSync(lock),bytes);
    probe.mock.mockImplementation((actualPid:number,signal?:string|number)=>{assert.equal(actualPid,pid);assert.equal(signal,0);throw Object.assign(Error('dead synthetic owner'),{code:'ESRCH'});});
    assert.equal((await reader.exportConfirmedBase()).version,baseline.version);assert.deepEqual(fs.readFileSync(lock),bytes,'read-only check must not delete lock');
    assert.deepEqual(fs.readFileSync(path.join(directory,'workspace.json')),manifest);
  }finally{await second?.close();await reader.close();}
});

test('IC security: mutable tool failure in a valid interrupted ledger remains unreviewable despite confirmed files',async t=>{
  const f=fixture(t);let captured:ProjectReadDisk|undefined;
  const live=harness(f,async input=>{started(input);ok(await write(input));const result=await write(input);assert.equal(result.ok,false);captured=live.disk();});
  const id=ok(await live.host.invoke('startWorkRun',live.request(),()=>true)).runId;await live.settled(id);await live.close();assert.ok(captured);
  const h=harness(f,async()=>assert.fail('review cannot run'),captured);
  t.mock.method(guardian,'verifyClosedEngineController',(ref:WorkCycleControllerRef)=>({...ref,resultVersion:sha}));
  try{
    assert.ok(parseProjectReadDisk(h.disk()));const parent=h.disk().runs[0]!;
    assert.equal(parent.run.status,'interrupted');assert.ok(parent.run.events.some(e=>e.type==='tool.completed'&&e.data.toolName==='work_write'&&!e.data.result.ok));
    const workspace=await createWorkCycleWorkspace({directory:path.join(f.workspaces,parent.run.workCycle!.workspaceId),runId:id,workspaceId:parent.run.workCycle!.workspaceId,readOnly:true,requireStoppedWriter:true,signal:new AbortController().signal});
    try{const baseline=await workspace.exportConfirmedBase();assert.equal(baseline.files.length,1);assert.throws(()=>reviewInterruptedWork(parent,baseline,[],{...controller,resultVersion:sha}),codeIs('CLEANUP_FAILED'));}finally{await workspace.close();}
    const preview=await h.host.invoke('prepareWorkContinuation',{contractVersion:V,projectId:f.root.projectId,bindingId:f.root.bindingId,runId:id,expectedEventCount:parent.run.eventCount},()=>true);
    assert.equal(preview.ok,false);if(!preview.ok)assert.equal(preview.error.code,'CLEANUP_FAILED');assert.equal(h.counts().starts,0);
  }finally{await h.close();}
});

test('IC security: exact guardian reader rejects missing closure and same-PID engine substitution without any process launch',t=>{
  const fixed=guardian.ENGINE_GUARDIAN_IDENTITY,nonce=randomUUID(),root=path.join(product,'.local/agent-engine-pilot/native',nonce),port=43127;
  const owner={pid:4242,creationTime100ns:'134000000000000001',image:fixed.binary.path},engine={pid:4343,creationTime100ns:'134000000000000002',image:fixed.engine.path,sha256:fixed.engine.sha256};
  const intent={schema:'aaw.engine.guardian.intent.v1',nonce,root,port,guardian:owner,engineImage:engine.image,engineSha256:engine.sha256,hostCapabilityBoundaryChanged:false};
  const ready={schema:'aaw.engine.guardian.ready.v1',nonce,root,port,guardian:owner,engine,startedAt:'2026-09-14T00:00:00.000Z',job:{atomic:true,killOnClose:true,breakawayAllowed:false}};
  const end={schema:'aaw.engine.guardian.result.v1',nonce,root,port,guardian:owner,engine,engineExited:true,engineExitCode:125,termination:'parent_lost',job:{activeProcesses:0,emptyConfirmed:true,closed:true},cleanupConfirmed:true,error:null};
  let result:unknown=end;const reads:string[]=[],pins:string[]=[];
  const pin=t.mock.method(nativeFiles,'nativePinned',(file:{path:string})=>{pins.push(file.path);return Buffer.from('mocked pinned bytes; no actual native read');});
  t.mock.method(childProcess,'spawn',()=>assert.fail('review must never launch a process'));
  t.mock.method(nativeFiles,'nativeRead',(file:string,limit:number)=>{assert.equal(path.dirname(file),path.join(root,'guardian-control'));assert.equal(limit,16384);const name=path.basename(file);reads.push(name);assert.ok(['intent.json','ready.json','result.json'].includes(name));const value=name==='intent.json'?intent:name==='ready.json'?ready:result;if(value===null)throw Object.assign(Error('missing synthetic result'),{code:'ENOENT'});return Buffer.from(JSON.stringify(value));});
  const ref={guardianId:nonce,guardianPid:owner.pid,enginePid:engine.pid,intentVersion:nativeFiles.nativeDigest(Buffer.from(JSON.stringify(intent))),readyVersion:nativeFiles.nativeDigest(Buffer.from(JSON.stringify(ready)))};
  assert.equal(guardian.verifyClosedEngineController(ref).resultVersion,nativeFiles.nativeDigest(Buffer.from(JSON.stringify(end))));
  for(const invalid of [null,{...end,engineExited:false},{...end,cleanupConfirmed:false},{...end,job:{...end.job,closed:false}},{...end,engine:{...engine,creationTime100ns:'134000000000000099'}},{...end,nonce:randomUUID()}]){result=invalid;assert.throws(()=>guardian.verifyClosedEngineController(ref));}
  result=end;pin.mock.mockImplementation(()=>{throw Error('pinned bytes changed');});assert.throws(()=>guardian.verifyClosedEngineController(ref));
  assert.ok(reads.length>0);assert.deepEqual([...new Set(pins)],[fixed.binary.path,fixed.proof.path,fixed.engine.path]);
});
