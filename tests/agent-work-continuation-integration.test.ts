import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AGENT_PROJECT_READ_VERSION as V, PROJECT_READ_LIMITS as L, type ProjectReadRequests, type ProjectReadToolCall, type ProjectReadToolName, type ProjectReadToolResult, type ProjectReadToolValue } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadRequest, parseProjectReadValue } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore, type ProjectReadStoredRun } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { workContinuationContext } from '../apps/desktop/src/main/agent-work-cycle/continuation';
import { WorkCycleError, type WorkCycleRunner, type WorkCycleWorkspaceFactory } from '../apps/desktop/src/main/agent-work-cycle/types';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';

const product='C:/work/analog_ai_workbench';
const fixtures=path.resolve(product,'.local/agent-project-read-tests');
const model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const hash=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const ok=<T>(result:{ok:true;value:T}|{ok:false;error:unknown}):T=>result.ok?result.value:assert.fail(JSON.stringify(result));
function fixture(){
  const base=path.join(fixtures,randomUUID()),source=path.join(base,'source');fs.mkdirSync(path.join(source,'sub'),{recursive:true});
  fs.writeFileSync(path.join(source,'AGENTS.md'),'Only use this synthetic task project.\n');
  fs.writeFileSync(path.join(source,'sub','AGENTS.md'),'Keep the THRESHOLD_RULE in integer units.\n');
  fs.writeFileSync(path.join(source,'sub','script.js'),'\ufeffconst threshold = 17;\r\n');
  const root=captureFolderRoot(randomUUID(),randomUUID(),source),other=captureFolderRoot(randomUUID(),randomUUID(),source);
  return {base,source,root,other,workspaces:path.join(base,'agent-work-cycle','workspaces'),remove(){const resolved=fs.realpathSync.native(base);assert.equal(resolved,base);assert.match(path.relative(fixtures,resolved),/^[0-9a-f-]{36}$/u);fs.rmSync(resolved,{recursive:true});}};
}
function snapshot(directory:string):Record<string,string>{
  const result:Record<string,string>={};
  const visit=(relative:string)=>{
    for(const entry of fs.readdirSync(path.join(directory,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const child=path.join(relative,entry.name),stat=fs.lstatSync(path.join(directory,child));assert.equal(stat.isSymbolicLink(),false);
      if(stat.isDirectory())visit(child);else{assert.ok(stat.isFile());result[child]=hash(fs.readFileSync(path.join(directory,child)));}
    }
  };visit('');return result;
}
function harness(f:ReturnType<typeof fixture>,action:(input:ProjectReadEngineInput)=>Promise<void>,factory:WorkCycleWorkspaceFactory=createWorkCycleWorkspace){
  const store=createProjectReadStore(product,path.join(f.base,'agent-project-read')),arbiter=createAgentRuntimeArbiter();
  let starts=0,seeds=0,programs=0,freezes=0;const prompts:string[]=[];
  const runner:WorkCycleRunner={available:()=>({available:true,language:'javascript',isolation:'windows-appcontainer'}),async run(){programs++;throw Error('No analysis program is allowed in author continuation tests');},async close(){}};
  const engine:ProjectReadEngine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),
    async start(input){starts++;prompts.push(input.prompt.initialUserText);input.callbacks.notice({type:'started',sessionId:'session-'+input.runId});input.callbacks.notice({type:'step',step:1,usage:null});await action(input);if(!input.signal.aborted)input.callbacks.notice({type:'completed'});},answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{}};
  const host=createProjectReadHost({store,arbiter,
    models:{status:()=>({model,canStart:true,reason:null}),freeze:()=>{freezes++;return model;},get:()=>({apiKey:'synthetic-only',model,maxRequests:24,maxOutputTokens:16384,requestTimeoutMs:600000}),forget(){},close(){}},
    bindings:{snapshotBinding:projectId=>({ok:true,value:{folder:projectId===f.other.projectId?f.other:f.root,name:'Continuation fixture'}})},createEngine:()=>engine,
    workCycle:{directory:f.workspaces,createWorkspace:async options=>{if(options.seed)seeds++;return factory(options);},createRunner:()=>runner}});
  const request=(goal='Initial task',constraint='Initial constraint'):ProjectReadRequests['startWorkRun']=>({contractVersion:V,clientRequestId:randomUUID(),projectId:f.root.projectId,bindingId:f.root.bindingId,model,goal,constraint,continuedFrom:null});
  const record=(runId:string)=>store.load().runs.find(row=>row.run.runId===runId)??assert.fail('missing run');
  return {host,store,request,record,prompts,counts:()=>({starts,seeds,programs,freezes}),
    async wait(runId:string){const deadline=performance.now()+10000;while(performance.now()<deadline){const value=record(runId);if(['completed','failed','stopped','interrupted'].includes(value.run.status)&&value.run.cleanupState==='idle')return value;await new Promise(resolve=>setTimeout(resolve,5));}return assert.fail('bounded host completion timeout');},
    async prepare(runId:string){const parent=record(runId);return ok(await host.invoke('prepareWorkContinuation',{contractVersion:V,runId,projectId:f.root.projectId,bindingId:f.root.bindingId,expectedEventCount:parent.run.eventCount},()=>true));},
    async close(){host.revoke();await host.shutdown();await arbiter.close();store.close();}};
}
function call(input:ProjectReadEngineInput,toolName:ProjectReadToolName,args:unknown,callId=randomUUID()):Promise<ProjectReadToolResult>{
  return input.callbacks.tool({sessionId:'session-'+input.runId,messageId:'message',callId,toolName,arguments:args} as ProjectReadToolCall);
}
async function createParent(input:ProjectReadEngineInput){
  const found=ok(await call(input,'project_find',{directoryId:null,query:'script.js',cursor:null,refresh:false}));
  assert.equal(found.kind,'find');if(found.kind!=='find')return;
  const fileId=found.entries[0]!.fileId!;
  let version:string|null=null,cursor:string|null=null,start={line:1,column:1};
  for(let n=0;n<8;n++){
    const read:ProjectReadToolValue=ok(await call(input,'project_read',{fileId,version,cursor,start}));assert.equal(read.kind,'read');if(read.kind!=='read')return;
    if(read.citation){version=read.citation.version;break;}
    assert.ok(read.coverage.nextCursor&&read.next);cursor=read.coverage.nextCursor;start=read.next!;version=read.resume?.version??null;
  }
  assert.ok(version);
  const imported=ok(await call(input,'work_import',{fileId,version,relativePath:'script.js',expectedVersion:null}));
  assert.equal(imported.kind,'work_import');
}
const initialContext=(input:ProjectReadEngineInput)=>JSON.parse(input.prompt.initialUserText.slice(input.prompt.initialUserText.lastIndexOf('\n')+1));
function continuationRequest(h:ReturnType<typeof harness>,baseline:{runId:string;eventCount:number;baselineVersion:string},goal:string,constraint:string):ProjectReadRequests['startWorkRun']{
  return {...h.request(goal,constraint),continuedFrom:baseline.runId,expectedEventCount:baseline.eventCount,baselineVersion:baseline.baselineVersion};
}
async function start(h:ReturnType<typeof harness>,request=h.request()){
  return ok(await h.host.invoke('startWorkRun',request,()=>true)).runId;
}

test('work continuation supports two new goals after reopen, revalidates scoped rules and preserves every parent byte',async()=>{
  const f=fixture();let parentId='',firstChildId='',secondChildId='';
  const parentHost=harness(f,createParent);
  let parentRecord='',parentBytes:Record<string,string>={},parentWorkspace='';
  try{parentId=await start(parentHost);const parent=await parentHost.wait(parentId);assert.equal(parent.run.status,'completed');parentRecord=JSON.stringify(parent);parentWorkspace=path.join(f.workspaces,parent.run.workCycle!.workspaceId);parentBytes=snapshot(parentWorkspace);}
  finally{await parentHost.close();}
  let phase=0;
  const h=harness(f,async input=>{
    phase++;const context=initialContext(input);
    assert.equal(context.priorUserGoals.length,phase);
    assert.equal(context.priorUserGoals[0].goal,'Initial task');
    if(phase===2){assert.equal(context.priorUserGoals[1].goal,'Change threshold to 29');assert.equal(context.priorUserGoals[1].constraint,'Use the prior method');}
    assert.ok(context.scopedRules.some((rule:{source:string;text:string|null})=>rule.source==='sub/AGENTS.md'&&rule.text?.includes('THRESHOLD_RULE')));
    assert.equal(context.currentFiles.length,1);assert.equal(context.currentFiles[0].readOnly,false);
    const listed=ok(await call(input,'work_list',{}));assert.equal(listed.kind,'work_list');if(listed.kind!=='work_list')return;
    const file=listed.files[0]!;assert.equal(file.fileId,context.currentFiles[0].fileId);assert.equal(file.origin.kind,'continuation');
    assert.ok(input.prompt.initialUserText.includes('not a claim that the current source project is synchronized'));
    const edited=ok(await call(input,'work_edit',{fileId:file.fileId,expectedVersion:file.version,oldText:phase===1?'17':'29',newText:phase===1?'29':'31'}));
    assert.equal(edited.kind,'work_edit');
  });
  let firstRequest:ProjectReadRequests['startWorkRun'];
  try{
    assert.deepEqual(h.counts(),{starts:0,seeds:0,programs:0,freezes:0});
    const preview=await h.prepare(parentId);assert.equal(preview.fileCount,1);assert.equal(h.counts().starts,0);assert.equal(fs.readdirSync(f.workspaces).length,1);
    firstRequest=continuationRequest(h,preview.baseline,'Change threshold to 29','Use the prior method');
    const replies=await Promise.all([h.host.invoke('startWorkRun',firstRequest,()=>true),h.host.invoke('startWorkRun',firstRequest,()=>true)]);
    firstChildId=ok(replies[0]!).runId;assert.equal(ok(replies[1]!).runId,firstChildId);
    assert.equal((await h.wait(firstChildId)).run.status,'completed');assert.equal(h.counts().seeds,1);
    const changed=await h.host.invoke('startWorkRun',{...firstRequest,goal:'Different same request'},()=>true);assert.equal(changed.ok,false);if(!changed.ok)assert.equal(changed.error.code,'CONFLICT');
    assert.equal(JSON.stringify(h.record(parentId)),parentRecord);assert.deepEqual(snapshot(parentWorkspace),parentBytes);
    const firstRecord=JSON.stringify(h.record(firstChildId)),firstWorkspace=path.join(f.workspaces,h.record(firstChildId).run.workCycle!.workspaceId),firstBytes=snapshot(firstWorkspace);
    const next=await h.prepare(firstChildId);
    secondChildId=await start(h,continuationRequest(h,next.baseline,'Now use 31','Keep integer units'));assert.equal((await h.wait(secondChildId)).run.status,'completed');
    assert.equal(h.record(secondChildId).run.continuedFrom,firstChildId);assert.equal(h.record(secondChildId).run.continuation,null);
    assert.equal(JSON.stringify(h.record(firstChildId)),firstRecord);assert.deepEqual(snapshot(firstWorkspace),firstBytes);
    assert.equal(JSON.stringify(h.record(parentId)),parentRecord);assert.deepEqual(snapshot(parentWorkspace),parentBytes);
    const childPreview=await h.prepare(secondChildId);
    fs.writeFileSync(path.join(f.source,'sub','AGENTS.md'),'Changed directory rule: use fractional units.\n');
    const rejectedId=await start(h,continuationRequest(h,childPreview.baseline,'Try changed rules',''));
    const rejected=await h.wait(rejectedId);assert.equal(rejected.run.status,'failed');
    assert.ok(rejected.run.events.some(event=>event.type==='run.failed'&&event.data.code==='SOURCE_CHANGED'));
    assert.equal(h.counts().starts,2);assert.equal(h.counts().seeds,2);assert.equal(h.counts().programs,0);
  }finally{await h.close();}
  const cold=harness(f,async()=>assert.fail('cold history never starts engine'));
  try{
    const ledger=fs.readFileSync(path.join(f.base,'agent-project-read','runs.json'));
    assert.equal(ok(await cold.host.invoke('readRun',{contractVersion:V,runId:secondChildId,after:0},()=>true)).run.status,'completed');
    assert.equal(await start(cold,firstRequest!),firstChildId);assert.deepEqual(cold.counts(),{starts:0,seeds:0,programs:0,freezes:0});
    assert.deepEqual(fs.readFileSync(path.join(f.base,'agent-project-read','runs.json')),ledger);assert.deepEqual(snapshot(parentWorkspace),parentBytes);
  }finally{await cold.close();f.remove();}
});

test('work continuation rejects cross-project, stale baseline, malformed and cross-mode requests before child admission',async()=>{
  const f=fixture(),h=harness(f,createParent);
  try{
    const parentId=await start(h);assert.equal((await h.wait(parentId)).run.status,'completed');
    const baseline=(await h.prepare(parentId)).baseline,request=continuationRequest(h,baseline,'New goal',''),before=snapshot(f.workspaces),count=h.record(parentId).run.eventCount;
    for(const invalid of [
      {...request,projectId:f.other.projectId,bindingId:f.other.bindingId},
      {...request,baselineVersion:'0'.repeat(64)},
      {...request,expectedEventCount:count-1},
    ]){const reply=await h.host.invoke('startWorkRun',invalid,()=>true);assert.equal(reply.ok,false);if(!reply.ok)assert.equal(reply.error.code,'CONFLICT');}
    const missing={...request} as Record<string,unknown>;delete missing.baselineVersion;
    const malformed=await h.host.invoke('startWorkRun',missing,()=>true);assert.equal(malformed.ok,false);if(!malformed.ok)assert.equal(malformed.error.code,'INVALID_REQUEST');
    const readonly=await h.host.invoke('startRun',{...h.request(),continuedFrom:parentId},()=>true);assert.equal(readonly.ok,false);if(!readonly.ok)assert.equal(readonly.error.code,'CAPABILITY_DENIED');
    assert.equal(h.store.load().runs.length,1);assert.deepEqual(snapshot(f.workspaces),before);assert.deepEqual(h.counts(),{starts:1,seeds:0,programs:0,freezes:1});
  }finally{await h.close();f.remove();}
});

test('work continuation confirm failure and preparation cancellation remain non-executable across cold replay',async()=>{
  for(const mode of ['confirm-failure','cancel'] as const){
    const f=fixture(),parentHost=harness(f,createParent);let parentId='';
    try{parentId=await start(parentHost);assert.equal((await parentHost.wait(parentId)).run.status,'completed');}finally{await parentHost.close();}
    let seedReady!:()=>void;const ready=new Promise<void>(resolve=>{seedReady=resolve;});let confirms=0;
    const factory:WorkCycleWorkspaceFactory=async options=>{
      const workspace=await createWorkCycleWorkspace(options);if(!options.seed)return workspace;
      seedReady();
      if(mode==='cancel')await new Promise<void>(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',()=>resolve(),{once:true});});
      return {...workspace,async confirmSeed(){confirms++;if(mode==='confirm-failure')throw new WorkCycleError('STORAGE_FAILED');return workspace.confirmSeed();}};
    };
    const h=harness(f,async()=>assert.fail('failed or cancelled seed cannot start'),factory);let childId='',request:ProjectReadRequests['startWorkRun'];
    try{
      request=continuationRequest(h,(await h.prepare(parentId)).baseline,'Continue safely','');
      childId=await start(h,request);await ready;
      if(mode==='cancel')ok(await h.host.invoke('stopRun',{contractVersion:V,runId:childId},()=>true));
      const child=await h.wait(childId);assert.equal(child.run.status,mode==='cancel'?'stopped':'failed');assert.equal(h.counts().starts,0);assert.equal(h.counts().seeds,1);
      assert.equal(confirms,mode==='cancel'?0:1);
    }finally{await h.close();}
    const cold=harness(f,async()=>assert.fail('cold retry must not revive seed'));
    try{
      const workspace=snapshot(path.join(f.workspaces,cold.record(childId).run.workCycle!.workspaceId));
      assert.equal(await start(cold,request!),childId);
      const parent=cold.record(childId),reply=await cold.host.invoke('prepareWorkContinuation',{contractVersion:V,runId:childId,projectId:f.root.projectId,bindingId:f.root.bindingId,expectedEventCount:parent.run.eventCount},()=>true);
      assert.equal(reply.ok,false);if(!reply.ok)assert.equal(reply.error.code,'CONFLICT');
      assert.deepEqual(cold.counts(),{starts:0,seeds:0,programs:0,freezes:0});assert.deepEqual(snapshot(path.join(f.workspaces,parent.run.workCycle!.workspaceId)),workspace);
    }finally{await cold.close();f.remove();}
  }
});

test('work continuation public identities and inherited user intent remain bounded without old tool context',()=>{
  assert.equal(V,'workbench.agent-project-read.v3');
  const fields={contractVersion:V,clientRequestId:'new-request',projectId:'project',bindingId:'binding',model,goal:'New goal',constraint:'',continuedFrom:'parent',expectedEventCount:9,baselineVersion:'a'.repeat(64)};
  assert.ok(parseProjectReadRequest('startWorkRun',fields));
  for(const changed of [{...fields,contractVersion:'workbench.agent-project-read.v2'},{...fields,continuedFrom:null},{...fields,baselineVersion:null}])assert.equal(parseProjectReadRequest('startWorkRun',changed),null);
  const ref={runId:'parent',workspaceId:'parent-workspace',eventCount:9,baselineVersion:'a'.repeat(64)};
  const file={fileId:'new-file',relativePath:'script.js',version:hash('script'),bytes:6,confirmation:'confirmed' as const,origin:{kind:'continuation' as const,source:{runId:ref.runId,workspaceId:ref.workspaceId,fileId:'old-file',version:hash('script'),baselineVersion:ref.baselineVersion}}};
  assert.ok(parseProjectReadValue('readWorkFile',{file,text:'script',verified:true}));
  assert.equal(parseProjectReadValue('readWorkFile',{file:{...file,fileId:'old-file'},text:'script',verified:true}),null);
  const row={run:{runId:'parent',goal:'Original intent',constraint:'Preserve units'}} as ProjectReadStoredRun;
  const context=workContinuationContext([row],ref,[file],[]);
  assert.ok(context.includes('Original intent'));assert.ok(context.includes('new-file'));assert.equal(context.includes('old-file'),false);
  const over=Array.from({length:7},(_,index)=>({run:{runId:index===6?'parent':'prior-'+index,goal:'g'.repeat(L.goalBytes),constraint:'c'.repeat(L.constraintBytes)}} as ProjectReadStoredRun));
  assert.throws(()=>workContinuationContext(over,ref,[file],[]),(error:unknown)=>error instanceof WorkCycleError&&error.code==='BUDGET_EXCEEDED');
});
