import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {memory,A,B,base} from './helpers/filesystem-read-memory';
import {createProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {parseProjectReadDisk,type ProjectReadDisk} from '../apps/desktop/src/main/agent-project-read/store';
import {captureFolderRoot} from '../apps/desktop/src/main/cloud/project-folder-files';
import {ProjectReadFsError} from '../apps/desktop/src/main/cloud/project-read-files';
import type {ProjectReadEngine,ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import type {ProjectReadModelSnapshots} from '../apps/desktop/src/main/agent-project-read/runtime';
import type {WorkCycleWorkspace,WorkCycleWorkspaceFactory} from '../apps/desktop/src/main/agent-work-cycle/types';
import {AGENT_PROJECT_READ_VERSION as V,type ProjectReadToolCall,type ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {ChatRunLink} from '../apps/desktop/src/shared/agent/chat-turns';

const model={provider:'kimi',model:'kimi-k3'} as const,hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const code=(expected:string)=>(error:unknown)=>error instanceof ProjectReadFsError&&error.code===expected;
const call=(toolName:string,args:unknown,callId:string=randomUUID()):ProjectReadToolCall=>({toolName,arguments:args,callId,sessionId:'native',messageId:'message-'+callId}) as ProjectReadToolCall;
const read=(target=B+'\\notes.log')=>call('fs_read',{path:target,fileId:null,version:null,start:{line:1,column:1},cursor:null});
const gate=()=>{let release!:()=>void;return {promise:new Promise<void>(r=>{release=r;}),release:()=>release()};};
function fixture(t:TestContext,config:{bound?:boolean;initial?:ProjectReadDisk;head?:()=>Promise<string|null>;available?:boolean;workspaceGate?:Promise<void>}={}){
 const m=memory(t,{[A]:{directory:true},[B+'\\notes.log']:{text:'synthetic outside evidence'}}),projectId=config.initial?.runs[0]?.run.project.projectId??randomUUID(),root=captureFolderRoot(projectId,'binding',A);
 let disk=structuredClone(config.initial??{version:1 as const,runs:[]}),bound=config.bound??false;
 const counts={head:0,runners:0,workspaces:0,workspaceClosed:0,runnerClosed:0,imports:0,engineStops:0},links:ChatRunLink[]=[];
 const arbiter=createAgentRuntimeArbiter(),abort=new AbortController(),runId=randomUUID();
 const engine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,
  accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),start:async()=>assert.fail('host must not start model'),answer:async()=>{},stop:async()=>{counts.engineStops++;},dispose(){},shutdown:async()=>{},setProjectContext(){}} as ProjectReadEngine;
 const models={status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>assert.fail('no key snapshot'),forget(){},close(){}} as ProjectReadModelSnapshots;
 const createWorkspace:WorkCycleWorkspaceFactory=async input=>{
  counts.workspaces++;assert(disk.runs.find(r=>r.run.runId===runId)!.run.events.some(e=>e.type==='work.prepared'&&e.data.workCycle.workspaceId===input.workspaceId),'durable receipt before workspace');
  await config.workspaceGate;
  return {ref:{workspaceId:input.workspaceId},list:()=>[],confirm:async()=>{},close:async()=>{counts.workspaceClosed++;},importFile:async()=>{counts.imports++;assert.fail('external fs ID must never import');}} as unknown as WorkCycleWorkspace;
 };
 const options={store:{load:()=>structuredClone(disk),save:(next:ProjectReadDisk)=>{const parsed=parseProjectReadDisk(next);assert(parsed,'independent disk parser');disk=parsed;},close(){}},models,arbiter,createEngine:()=>engine,
  bindings:{snapshotBinding:()=>bound?{ok:true as const,value:{folder:root,name:'Organization A'}}:{ok:false as const,error:{code:'NOT_BOUND' as const}}},
  workCycle:{directory:base+'\\synthetic-workspaces',createWorkspace,createRunner:()=>{counts.runners++;return {available:()=>({available:config.available??true,language:'javascript' as const,isolation:'windows-appcontainer' as const}),run:async()=>assert.fail('no programs'),close:async()=>{counts.runnerClosed++;}};}}};
 const host=createProjectReadHost(options);
 return {m,host,counts,links,runId,root,options,disk:()=>structuredClone(disk),unbind:()=>{bound=false;},
  async attach(){const lease=arbiter.reserveRun({mode:'conversation',runId,project:null,status:'running',cleanupState:'idle'},()=>abort.abort());
   return host.attachChat({runId,origin:{chatSessionId:config.initial?.runs[0]?.run.origin?.chatSessionId??randomUUID(),turnId:randomUUID(),executionId:randomUUID(),inputDigest:hash('synthetic')},model,snapshot:host.captureChat(projectId,'Organization A'),lease,abort,engine,outputBytes:65536,
    history:[{type:'run.started',data:{sessionId:'native',engine:'opencode',version:'1.18.17'}},{type:'model.step',data:{step:1}}],
    prepareWorkHead:async()=>{counts.head++;return await config.head?.()??null;},onLinked:link=>links.push(link),onReady(){},onFailure(){}},null);},
  async close(){host.revoke();await host.shutdown();await arbiter.close();},
 };
}
async function completeRead(cb:ProjectReadEngineInput['callbacks'],initial=read()){
 let request=initial,result:ProjectReadToolResult|undefined;
 for(let n=0;n<6;n++){result=await cb.tool(request);assert(result.ok,JSON.stringify(result));if(result.value.kind==='read'&&result.value.citation)return result.value.citation;
  assert('nextArguments'in result.value&&result.value.nextArguments);request=call(result.value.nextArguments.toolName,result.value.nextArguments.arguments);}
 return assert.fail('no read evidence '+JSON.stringify(result));
}

test('unbound main admission reads explicit external path without work resources; saved citation cold resolution performs zero source IO',async t=>{
 const f=fixture(t);try{const cb=await f.attach(),citation=await completeRead(cb);assert.equal(citation.location!.absolutePath,B+'\\notes.log');assert.equal(f.disk().runs[0]!.run.project.bindingId,null);
  assert.equal(f.counts.head+f.counts.runners+f.counts.workspaces,0);assert.deepEqual(f.links,[{runId:f.runId,workspaceId:null}]);assert.deepEqual(f.m.seen.listed,[]);
  await f.host.finishChat(f.runId,'completed');const before=structuredClone(f.m.seen),coldArbiter=createAgentRuntimeArbiter();
  const cold=createProjectReadHost({...f.options,arbiter:coldArbiter,createEngine:()=>assert.fail('cold engine')});
  try{const result=await cold.invoke('resolveCitation',{contractVersion:V,runId:f.runId,citationId:citation.citationId},()=>true);assert(result.ok);assert.deepEqual(f.m.seen,before);assert.equal(f.counts.workspaces,0);}finally{cold.revoke();await cold.shutdown();await coldArbiter.close();}
 }finally{await f.close();}
});
test('bound read then work uses one durable late receipt, exact duplicate Promise, and never imports global source IDs',async t=>{
 const f=fixture(t,{bound:true});try{const cb=await f.attach(),citation=await completeRead(cb);assert.equal(f.counts.head,0);const request=call('work_list',{}),first=cb.tool(request);assert.equal(cb.tool(request),first);assert((await first).ok);
  assert.deepEqual([f.counts.head,f.counts.runners,f.counts.workspaces],[1,1,1]);const run=f.disk().runs.find(r=>r.run.runId===f.runId)!.run;
  assert.equal(run.events[0]!.type,'run.accepted');assert.equal((run.events[0]!.data as {workCycle?:unknown}).workCycle,undefined);
  const prepared=run.events.find(e=>e.type==='work.prepared')!;assert(prepared);assert(prepared.sequence<run.events.find(e=>e.type==='tool.started'&&e.data.toolName==='work_list')!.sequence);assert.equal(f.links.at(-1)!.workspaceId,run.workCycle!.workspaceId);
  const imported=await cb.tool(call('work_import',{fileId:citation.fileId,version:citation.version,relativePath:'copied.txt',expectedVersion:null}));assert.equal(imported.ok,false);assert.equal(f.counts.imports,0);await f.host.finishChat(f.runId,'completed');
 }finally{await f.close();}
});
test('unbound work and malformed work arguments reject before any workspace or runner creation',async t=>{
 for(const [bound,request,expected] of [[false,call('work_list',{}),'NOT_BOUND'],[true,call('work_list',{forged:true}),'INVALID_REQUEST']] as const){
  const f=fixture(t,{bound});try{const cb=await f.attach();await assert.rejects(cb.tool(request),code(expected));assert.equal(f.counts.head+f.counts.runners+f.counts.workspaces,0);}finally{await f.close();t.mock.restoreAll();}
 }
});
test('callId conflict and cached failed preparation do not invoke the work head twice',async t=>{
 const f=fixture(t,{bound:true,head:async()=>{throw new ProjectReadFsError('CONFLICT');}});try{const cb=await f.attach(),r=read();await completeRead(cb,r);
  await assert.rejects(cb.tool(call('work_list',{},r.callId)),code('CONFLICT'));assert.equal(f.counts.head,0);
  const request=call('work_list',{}),first=cb.tool(request);await assert.rejects(first,code('CONFLICT'));assert.equal(cb.tool(request),first);await assert.rejects(cb.tool(request),code('CONFLICT'));assert.equal(f.counts.head,1);assert.equal(f.counts.runners+f.counts.workspaces,0);
 }finally{await f.close();}
});
test('stop during late head preparation prevents resource creation and waits for the preparation to settle',async t=>{
 const entered=gate(),release=gate(),f=fixture(t,{bound:true,head:async()=>{entered.release();await release.promise;return null;}});try{const cb=await f.attach(),job=cb.tool(call('work_list',{}));await entered.promise;
  let stopped=false;const closing=f.host.finishChat(f.runId,'stop').then(()=>{stopped=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(stopped,false);release.release();await assert.rejects(job,code('CANCELLED'));await closing;assert.equal(f.counts.runners+f.counts.workspaces,0);
 }finally{release.release();await f.close();}
});
test('stop while workspace creation is pending retains its receipt and closes the eventual resource',async t=>{
 const release=gate(),f=fixture(t,{bound:true,workspaceGate:release.promise});try{const cb=await f.attach(),job=cb.tool(call('work_list',{}));for(let n=0;n<50&&!f.counts.workspaces;n++)await new Promise<void>(r=>setImmediate(r));assert.equal(f.counts.workspaces,1);
  const closing=f.host.finishChat(f.runId,'stop');release.release();await assert.rejects(job,code('CANCELLED'));await closing;assert.equal(f.counts.workspaceClosed,1);assert.equal(f.counts.runnerClosed,1);assert(f.disk().runs[0]!.run.workCycle);
 }finally{release.release();await f.close();}
});
test('changed binding and unavailable runtime do not create work receipts or workspaces',async t=>{
 for(const unavailable of [false,true]){let f:ReturnType<typeof fixture>;f=fixture(t,{bound:true,available:!unavailable,head:async()=>{if(!unavailable)f.unbind();return null;}});
  try{const cb=await f.attach();await assert.rejects(cb.tool(call('work_list',{})),code(unavailable?'CAPABILITY_DENIED':'NOT_BOUND'));assert.equal(f.counts.workspaces,0);assert(!f.disk().runs[0]!.run.workCycle);}finally{await f.close();t.mock.restoreAll();}
 }
});
test('a completed old workspace cannot make the next read recover work, and citation checking ignores a later removed organizational binding',async t=>{
 let initial:ProjectReadDisk;const prior=fixture(t,{bound:true});try{const cb=await prior.attach();assert((await cb.tool(call('work_list',{}))).ok);await prior.host.finishChat(prior.runId,'completed');initial=prior.disk();}finally{await prior.close();t.mock.restoreAll();}
 const f=fixture(t,{bound:true,initial,head:async()=>assert.fail('pure read must not recover old work')});try{const cb=await f.attach(),citation=await completeRead(cb);assert.equal(f.counts.head+f.counts.runners+f.counts.workspaces,0);await f.host.finishChat(f.runId,'completed');f.unbind();
  const checked=await f.host.invoke('checkCitation',{contractVersion:V,runId:f.runId,citationId:citation.citationId},()=>true);assert(checked.ok,JSON.stringify(checked));assert.equal(checked.value.state,'current');assert.equal(f.counts.workspaces,0);
 }finally{await f.close();}
});
