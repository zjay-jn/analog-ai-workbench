import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadToolCall, type ProjectReadToolResult, type ProjectReadToolName } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { WslResultsBinding } from '../apps/desktop/src/shared/agent/wsl-results';
import { waveformExcerptPayload, type WaveformMetricsValue } from '../apps/desktop/src/shared/agent/waveform-results';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore, parseProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { prepareWaveformReaderDirectory } from '../apps/desktop/src/main/agent-project-read/waveform-directory';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import type { WslResultsService } from '../apps/desktop/src/main/wsl-results/service';
import { WaveformResultsError, type WaveformResultsService } from '../apps/desktop/src/main/waveform-results/service';
import { waveArguments as args, waveBinding as frozen, waveSource, waveDiscovery, waveList, waveRead, waveMetrics, waveRawBytes, waveHash } from './fixtures/waveform-results';
const product=path.resolve('C:/work/analog_ai_workbench'),model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const ok=<T>(r:{ok:true;value:T}|{ok:false;error:unknown}):T=>r.ok?r.value:assert.fail(JSON.stringify(r));
function fixture(){const base=path.join(product,'.local','agent-project-read-tests',randomUUID()),source=path.join(base,'source');assert.ok(base.startsWith(product+path.sep));fs.mkdirSync(source,{recursive:true});return {base,root:captureFolderRoot(randomUUID(),randomUUID(),source)};}
function harness(f:ReturnType<typeof fixture>,action:(input:ProjectReadEngineInput)=>Promise<void>,initial:WslResultsBinding|null=frozen){
  const store=createProjectReadStore(product,path.join(f.base,'agent-project-read')),arbiter=createAgentRuntimeArbiter();let binding=initial,starts=0,lists=0,reads=0,metrics=0,checks=0,closes=0,textLists=0,fail=false,failClose=false,hold=false,oversized=false;
  let release:()=>void=()=>{};
  const factory=():WaveformResultsService=>({
    list:async()=>{lists++;if(fail)throw new WaveformResultsError('IO_ERROR');return waveList;},read:async()=>{reads++;return waveRead;},metrics:async()=>{metrics++;if(oversized){const large=structuredClone(waveMetrics) as any;large.metrics.unityGain.crossings=Array(100).fill(large.metrics.unityGain.crossings[0]);return large as WaveformMetricsValue;}return waveMetrics;},
    checkSource:async()=>{checks++;if(hold)await new Promise<void>(resolve=>{release=resolve;});return {source:waveSource,physicalReadBytes:waveRawBytes*2,scannedCandidates:1};},
    close:async()=>{closes++;if(failClose)throw new WaveformResultsError('CLEANUP_FAILED');},
  });
  const textFactory=():WslResultsService=>({restoreBinding:v=>v as WslResultsBinding,select:async()=>frozen,list:async()=>{textLists++;return waveDiscovery;},read:async()=>assert.fail('No text read'),close:async()=>{}});
  const models:ProjectReadModelSnapshots={status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>({apiKey:'synthetic-only',model,maxRequests:24,maxOutputTokens:1000,requestTimeoutMs:1000}),forget(){},close(){}};
  const engine:ProjectReadEngine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),
    async start(input){starts++;input.callbacks.notice({type:'started',sessionId:'wave-session'});input.callbacks.notice({type:'step',step:1,usage:null});await action(input);if(!input.signal.aborted)input.callbacks.notice({type:'completed'});},answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{}};
  const host=createProjectReadHost({store,arbiter,models,bindings:{snapshotBinding:()=>({ok:true,value:{folder:f.root,name:'Wave synthetic'}})},createEngine:()=>engine,wslResults:{settings:{get:async()=>binding,set:async(_p,b)=>{binding=b;}},createService:textFactory,createWaveformService:factory}});
  const request={contractVersion:V,projectId:f.root.projectId,bindingId:f.root.bindingId,clientRequestId:randomUUID(),model,goal:'Read historical AC trace and deterministic gain',constraint:'',continuedFrom:null};
  return {host,store,request,counts:()=>({starts,lists,reads,metrics,checks,closes,textLists}),setBinding:(next:WslResultsBinding|null)=>{binding=next;},fail:()=>{fail=true;},failClose:()=>{failClose=true;},hold:()=>{hold=true;},oversized:()=>{oversized=true;},release:()=>release(),
    async wait(runId:string,cleanup='idle'){const deadline=performance.now()+5000;while(performance.now()<deadline){const run=store.load().runs.find(r=>r.run.runId===runId)!.run;if(run.status==='completed'&&run.cleanupState===cleanup)return run;await new Promise(r=>setTimeout(r,5));}return assert.fail(JSON.stringify(store.load()));},
    async close(expectFailure=false){host.revoke();if(expectFailure)await assert.rejects(host.shutdown());else await host.shutdown();await arbiter.close();store.close();},
  };
}
const call=(input:ProjectReadEngineInput,toolName:ProjectReadToolName,arguments_:unknown):Promise<ProjectReadToolResult>=>input.callbacks.tool({sessionId:'wave-session',messageId:'m',callId:randomUUID(),toolName,arguments:arguments_} as ProjectReadToolCall);
async function populate(input:ProjectReadEngineInput){ok(await call(input,'wsl_results_list',{bindingId:frozen.id,relativeDirectory:'',nameQuery:'',cursor:null}));ok(await call(input,'wsl_waveform_list',args.wsl_waveform_list));ok(await call(input,'wsl_waveform_read',args.wsl_waveform_read));ok(await call(input,'wsl_waveform_metrics',args.wsl_waveform_metrics));}
const citation=(runId:string,citationId=waveRead.citationId)=>({contractVersion:V,runId,citationId});

test('waveform tools require discovery and frozen binding, preserve exact citations and cold-reopen saved values with zero source replay',async()=>{
  const f=fixture();let h:ReturnType<typeof harness>;let runId='';
  h=harness(f,async input=>{
    const missing=await call(input,'wsl_waveform_list',args.wsl_waveform_list);assert.equal(missing.ok,false);if(!missing.ok)assert.equal(missing.error.code,'FILE_UNAVAILABLE');
    h.setBinding({...frozen,id:'wsl-binding-next'});const foreign=await call(input,'wsl_waveform_list',{...args.wsl_waveform_list,bindingId:'wsl-binding-next'});assert.equal(foreign.ok,false);if(!foreign.ok)assert.equal(foreign.error.code,'CAPABILITY_DENIED');
    await populate(input);
  });
  try{runId=ok(await h.host.invoke('startRun',h.request,()=>true)).runId;const run=await h.wait(runId);assert.deepEqual(run.wslResultsBinding,frozen);assert.equal(run.accounting.physicalReadBytes,9*waveRawBytes);assert.equal(h.counts().lists,1);
    assert.deepEqual(ok(await h.host.invoke('resolveWaveformCitation',citation(runId),()=>true)),waveRead);assert.deepEqual(ok(await h.host.invoke('resolveWaveformCitation',citation(runId,waveMetrics.citationId),()=>true)),waveMetrics);
    for(const corrupt of ['hash','trace','discovery','metric-count']){const copy=structuredClone(h.store.load()) as any;const events=copy.runs[0].run.events;const read=events.find((e:any)=>e.type==='tool.completed'&&e.data.result.ok&&e.data.result.value.kind==='wsl_waveform_read').data.result.value;
      if(corrupt==='hash')read.points[0].real=77;
      if(corrupt==='trace'){read.trace.signalName='forged';read.excerptSha256=waveHash(waveformExcerptPayload(read));}
      if(corrupt==='discovery')events.find((e:any)=>e.type==='tool.completed'&&e.data.result.ok&&e.data.result.value.kind==='wsl_results_list').data.result.value.entries=[];
      if(corrupt==='metric-count'){const metric=events.find((e:any)=>e.type==='tool.completed'&&e.data.result.ok&&e.data.result.value.kind==='wsl_waveform_metrics').data.result.value as WaveformMetricsValue;const altered=metric as any;altered.metrics.sampleCount=4;altered.excerptSha256=waveHash(waveformExcerptPayload(altered));}
      assert.equal(parseProjectReadDisk(copy),null,corrupt);
    }
    const continuation=await h.host.invoke('startRun',{...h.request,clientRequestId:randomUUID(),continuedFrom:runId},()=>true);assert.equal(continuation.ok,false);if(!continuation.ok)assert.equal(continuation.error.code,'CAPABILITY_DENIED');
  }finally{await h.close();}
  const reopened=harness(f,async()=>assert.fail('No model replay'),null);try{assert.deepEqual(ok(await reopened.host.invoke('resolveWaveformCitation',citation(runId,waveMetrics.citationId),()=>true)),waveMetrics);assert.deepEqual(reopened.counts(),{starts:0,lists:0,reads:0,metrics:0,checks:0,closes:0,textLists:0});
    assert.equal(ok(await reopened.host.invoke('checkWaveformCitation',citation(runId),()=>true)).state,'current');assert.equal(reopened.counts().checks,1);assert.equal(reopened.counts().metrics,0);
  }finally{await reopened.close();}
});

test('waveform failures retain conservative I/O reservation and stop the seventeenth 16 MiB attempt before service admission',async()=>{
  const f=fixture();let h:ReturnType<typeof harness>;
  h=harness(f,async input=>{ok(await call(input,'wsl_results_list',{bindingId:frozen.id,relativeDirectory:'',nameQuery:'',cursor:null}));for(let i=0;i<17;i++){const r=await call(input,'wsl_waveform_list',args.wsl_waveform_list);assert.equal(r.ok,false);if(!r.ok)assert.equal(r.error.code,i<16?'IO_ERROR':'BUDGET_EXCEEDED');}});h.fail();
  try{const run=await h.wait(ok(await h.host.invoke('startRun',h.request,()=>true)).runId);assert.equal(h.counts().lists,16);assert.equal(run.accounting.physicalReadBytes,0);}finally{await h.close();}
});

test('waveform citation checks share inspection admission, reject late results after cancellation and retain cleanup failure',async()=>{
  const f=fixture(),h=harness(f,populate);let runId='';try{runId=ok(await h.host.invoke('startRun',h.request,()=>true)).runId;await h.wait(runId);h.hold();const checking=h.host.invoke('checkWaveformCitation',citation(runId),()=>true);await new Promise(r=>setImmediate(r));
    const selecting=await h.host.invoke('selectWslResultsBinding',{contractVersion:V,projectId:f.root.projectId,selection:{distro:frozen.distro,user:frozen.user,rootPath:frozen.rootPath}},()=>true);assert.equal(selecting.ok,false);if(!selecting.ok)assert.equal(selecting.error.code,'BUSY');assert.equal((await h.host.invoke('startRun',{...h.request,clientRequestId:randomUUID()},()=>true)).ok,false);
    ok(await h.host.invoke('cancelInspection',{contractVersion:V,projectId:f.root.projectId},()=>true));h.release();const cancelled=await checking;assert.equal(cancelled.ok,false);if(!cancelled.ok)assert.equal(cancelled.error.code,'CANCELLED');
  }finally{await h.close();}
  const failed=harness(f,async()=>{},null);failed.failClose();try{const result=await failed.host.invoke('checkWaveformCitation',citation(runId),()=>true);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'CLEANUP_FAILED');const next=await failed.host.invoke('startRun',failed.request,()=>true);assert.equal(next.ok,false);if(!next.ok)assert.equal(next.error.code,'CLEANUP_FAILED');}finally{await failed.close(true);}
});

test('waveform converter receives an empty dedicated directory and rejects occupied or aliased directories without cleanup',()=>{
  const f=fixture(),directory=prepareWaveformReaderDirectory(product,f.base);assert.equal(directory,path.join(f.base,'waveform-reader'));assert.deepEqual(fs.readdirSync(directory),[]);assert.equal(prepareWaveformReaderDirectory(product,f.base),directory);
  fs.writeFileSync(path.join(directory,'sentinel'),'keep');assert.throws(()=>prepareWaveformReaderDirectory(product,f.base));assert.equal(fs.readFileSync(path.join(directory,'sentinel'),'utf8'),'keep');
  const alias=path.join(f.base,'alias');fs.symlinkSync(f.root.root,alias,'junction');assert.throws(()=>prepareWaveformReaderDirectory(product,alias));assert.throws(()=>prepareWaveformReaderDirectory(product,product));
});

test('oversized waveform metric envelopes are a budget error and never persist a truncated metric citation',async()=>{
  const f=fixture(),h=harness(f,async input=>{ok(await call(input,'wsl_results_list',{bindingId:frozen.id,relativeDirectory:'',nameQuery:'',cursor:null}));ok(await call(input,'wsl_waveform_list',args.wsl_waveform_list));const result=await call(input,'wsl_waveform_metrics',args.wsl_waveform_metrics);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'BUDGET_EXCEEDED');});h.oversized();
  try{const run=await h.wait(ok(await h.host.invoke('startRun',h.request,()=>true)).runId);assert.equal(run.accounting.physicalReadBytes,3*waveRawBytes);assert.equal(h.counts().metrics,1);assert.equal((await h.host.invoke('resolveWaveformCitation',citation(run.runId,waveMetrics.citationId),()=>true)).ok,false);}finally{await h.close();}
});
