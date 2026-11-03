import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadToolCall, type ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { WSL_RESULTS_VERSION, type WslResultsBinding, type WslResultsReadValue } from '../apps/desktop/src/shared/agent/wsl-results';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore, parseProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { WslResultsError, type WslResultsService } from '../apps/desktop/src/main/wsl-results/service';
import { projectReadTools, validateProjectReadNativeTools } from '../apps/desktop/src/main/agent-project-read/protocol';
const product = path.resolve('C:/work/analog_ai_workbench'), model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => r.ok ? r.value : assert.fail(JSON.stringify(r));
const frozen: WslResultsBinding = { distro:'ROCKY9_LLM_LAB',user:'maxwell',rootPath:'/home/maxwell/simulation/folded/results',id:'wsl-binding-test',rootIdentity:'1:2',readerVersion:WSL_RESULTS_VERSION,selectedAt:'2026-09-15T00:00:00.000Z' };
const body = 'frequency,gain\n1,67\n2,66', raw = Buffer.byteLength(body), version = '10:20:' + raw + ':1:1';
function fixture() { const base = path.join(product, '.local', 'agent-project-read-tests', randomUUID()), source = path.join(base, 'source'); assert.ok(base.startsWith(product + path.sep)); fs.mkdirSync(source, {recursive:true}); return { base, root:captureFolderRoot(randomUUID(),randomUUID(),source) }; }
function harness(f:ReturnType<typeof fixture>,action:(input:ProjectReadEngineInput)=>Promise<void>, initial:WslResultsBinding|null=frozen) {
  const store=createProjectReadStore(product,path.join(f.base,'agent-project-read')),arbiter=createAgentRuntimeArbiter();let binding=initial,starts=0,reads=0,lists=0,closes=0,failClose=false,hold=false,twoPages=false;
  let release:()=>void=()=>{};
  const factory=():WslResultsService=>({
    restoreBinding:value=>value as WslResultsBinding,
    select:async(selection,signal)=>{ if(hold)await new Promise<void>((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(new WslResultsError('CANCELLED')),{once:true});}); return {...frozen,...selection}; },
    list:async(selected,args)=>{lists++;const first=twoPages&&args.cursor===null;return {kind:'wsl_results_list',binding:selected,relativeDirectory:'',entries:[{name:first?'gain.csv.old':'gain.csv',relativePath:first?'gain.csv.old':'gain.csv',kind:'file',readability:'text_result',bytes:raw,fileId:first?'wsl-file-old':'wsl-file-test',version}],nextCursor:first?'wsl-cursor-next':null,complete:!first,scannedCandidates:1,physicalReadBytes:0};},
    read:async(selected,args)=>{reads++;const lines=body.split('\n'),end=Math.min(lines.length,args.startLine+args.maxLines-1),text=lines.slice(args.startLine-1,end).join('\n');return {kind:'wsl_results_read',source:{...selected,relativePath:'gain.csv',absolutePath:selected.rootPath+'/gain.csv'},fileId:'wsl-file-test',fileIdentity:'10:20',version,rawSha256:hash(body),excerptSha256:hash(text),startLine:args.startLine,endLine:end,totalLines:lines.length,fileBytes:raw,text,nextLine:end===lines.length?null:end+1,complete:end===lines.length,citationId:'wsl-cite-'+reads,physicalReadBytes:raw,scannedCandidates:1};},
    close:async()=>{closes++;if(failClose)throw new WslResultsError('CLEANUP_FAILED');},
  });
  const models:ProjectReadModelSnapshots={status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>({apiKey:'synthetic-only',model,maxRequests:24,maxOutputTokens:1000,requestTimeoutMs:1000}),forget(){},close(){}};
  const engine:ProjectReadEngine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),
    async start(input){starts++;input.callbacks.notice({type:'started',sessionId:'wsl-session'});input.callbacks.notice({type:'step',step:1,usage:null});await action(input);if(!input.signal.aborted)input.callbacks.notice({type:'completed'});},answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{}};
  const host=createProjectReadHost({store,arbiter,models,bindings:{snapshotBinding:()=>({ok:true,value:{folder:f.root,name:'WSL synthetic'}})},createEngine:()=>engine,wslResults:{settings:{get:async()=>binding,set:async(_p,b)=>{binding=b;}},createService:factory}});
  const request={contractVersion:V,projectId:f.root.projectId,bindingId:f.root.bindingId,clientRequestId:randomUUID(),model,goal:'Read historical experimental WSL gain export',constraint:'',continuedFrom:null};
  return {host,store,request,counts:()=>({starts,reads,lists,closes}),setBinding:(next:WslResultsBinding|null)=>{binding=next;},twoPages:()=>{twoPages=true;},failClose:()=>{failClose=true;},hold:()=>{hold=true;},release:()=>release(),
    async wait(runId:string){const deadline=performance.now()+5000;while(performance.now()<deadline){const run=store.load().runs.find(r=>r.run.runId===runId)!.run;if(run.status==='completed'&&run.cleanupState==='idle')return run;await new Promise(r=>setTimeout(r,5));}return assert.fail(JSON.stringify(store.load()));},
    async close(expectFailure=false){host.revoke();if(expectFailure)await assert.rejects(host.shutdown());else await host.shutdown();await arbiter.close();store.close();},
  };
}
const call=(input:ProjectReadEngineInput,name:'wsl_results_list'|'wsl_results_read',args:unknown):Promise<ProjectReadToolResult>=>input.callbacks.tool({sessionId:'wsl-session',messageId:'m',callId:randomUUID(),toolName:name,arguments:args} as ProjectReadToolCall);

test('WSL registered tools preserve frozen source, raw accounting and saved citation across cold reopen without any source read',async()=>{
  validateProjectReadNativeTools(projectReadTools());validateProjectReadNativeTools(projectReadTools(true),true);
  const f=fixture();let citation:WslResultsReadValue|undefined,runId='';let h:ReturnType<typeof harness>;
  h=harness(f,async input=>{
    assert.ok(input.prompt.systemText.includes(frozen.id));h.setBinding({...frozen,id:'wsl-binding-next',rootPath:'/home/maxwell/simulation/another/results'});
    const denied=await call(input,'wsl_results_list',{bindingId:'wsl-binding-next',relativeDirectory:'',nameQuery:'',cursor:null});assert.equal(denied.ok,false);if(!denied.ok)assert.equal(denied.error.code,'CAPABILITY_DENIED');
    ok(await call(input,'wsl_results_list',{bindingId:frozen.id,relativeDirectory:'',nameQuery:'',cursor:null}));
    const result=ok(await call(input,'wsl_results_read',{bindingId:frozen.id,fileId:'wsl-file-test',version,startLine:1,maxLines:200}));assert.equal(result.kind,'wsl_results_read');if(result.kind==='wsl_results_read')citation=result;
  });try{runId=ok(await h.host.invoke('startRun',h.request,()=>true)).runId;const run=await h.wait(runId);assert.deepEqual(run.wslResultsBinding,frozen);assert.equal(run.accounting.physicalReadBytes,raw);assert.equal(run.accounting.visitedCandidates,2);assert.equal(h.counts().reads,1);assert.ok(citation);
    assert.deepEqual(ok(await h.host.invoke('resolveWslResultsCitation',{contractVersion:V,runId,citationId:citation.citationId},()=>true)),citation);
    const malformed=structuredClone(h.store.load()) as any;const row=malformed.runs[0].run.events.find((e:any)=>e.type==='tool.completed'&&e.data.result.ok&&e.data.result.value.kind==='wsl_results_read');row.data.result.value.text='invented';assert.equal(parseProjectReadDisk(malformed),null);
    const continuation=await h.host.invoke('startRun',{...h.request,clientRequestId:randomUUID(),continuedFrom:runId},()=>true);assert.equal(continuation.ok,false);if(!continuation.ok)assert.equal(continuation.error.code,'CAPABILITY_DENIED');
  }finally{await h.close();}
  const reopened=harness(f,async()=>assert.fail('No replay'),null);try{assert.ok(citation);assert.deepEqual(ok(await reopened.host.invoke('resolveWslResultsCitation',{contractVersion:V,runId,citationId:citation.citationId},()=>true)),citation);assert.deepEqual(reopened.counts(),{starts:0,reads:0,lists:0,closes:0});
    reopened.twoPages();const checked=ok(await reopened.host.invoke('checkWslResultsCitation',{contractVersion:V,runId,citationId:citation.citationId},()=>true));assert.equal(checked.state,'current');assert.equal(reopened.counts().reads,1);assert.equal(reopened.counts().lists,2);
  }finally{await reopened.close();}
});

test('WSL inspections share admission with tool runs, cancel through existing API and cleanup failure blocks subsequent admission',async()=>{
  const f=fixture(),h=harness(f,async()=>{});try{
    h.hold();const selecting=h.host.invoke('selectWslResultsBinding',{contractVersion:V,projectId:f.root.projectId,selection:{distro:frozen.distro,user:frozen.user,rootPath:frozen.rootPath}},()=>true);
    await new Promise(r=>setImmediate(r));const second=await h.host.invoke('selectWslResultsBinding',{contractVersion:V,projectId:f.root.projectId,selection:{distro:frozen.distro,user:frozen.user,rootPath:frozen.rootPath}},()=>true);assert.equal(second.ok,false);if(!second.ok)assert.equal(second.error.code,'BUSY');
    assert.equal((await h.host.invoke('startRun',h.request,()=>true)).ok,false);ok(await h.host.invoke('cancelInspection',{contractVersion:V,projectId:f.root.projectId},()=>true));assert.equal((await selecting).ok,false);assert.equal(h.counts().starts,0);
  }finally{await h.close();}
  const failed=harness(f,async()=>{});try{failed.failClose();const result=await failed.host.invoke('selectWslResultsBinding',{contractVersion:V,projectId:f.root.projectId,selection:{distro:frozen.distro,user:frozen.user,rootPath:frozen.rootPath}},()=>true);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'CLEANUP_FAILED');
    const next=await failed.host.invoke('startRun',failed.request,()=>true);assert.equal(next.ok,false);if(!next.ok)assert.equal(next.error.code,'CLEANUP_FAILED');
  }finally{await failed.close(true);}
});
