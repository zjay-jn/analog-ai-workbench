import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadToolName, type ProjectReadToolArguments, type ProjectReadToolCall } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { CommandDriver, CommandDriverOutcome } from '../apps/desktop/src/main/agent-command/types';
import type { CommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command';
import { commandDigest } from '../apps/desktop/src/main/agent-command/logs';

const product=path.resolve('C:/work/analog_ai_workbench'),parent=path.join(product,'.local','agent-project-read-tests'),sha=commandDigest('synthetic command host'),empty=commandDigest(''),model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const environment:CommandEnvironment={environmentId:'synthetic-env',revision:sha,displayName:'No real program',platform:'windows',shell:{kind:'powershell',version:'fake',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16*1024*1024,defaultTimeoutMs:120000,maxTimeoutMs:600000}};
const ok=<T>(r:{ok:true;value:T}|{ok:false;error:unknown}):T=>r.ok?r.value:assert.fail(JSON.stringify(r));
function call<K extends ProjectReadToolName>(input:ProjectReadEngineInput,name:K,args:ProjectReadToolArguments[K]){return input.callbacks.tool({sessionId:'session-'+input.runId,messageId:'message',callId:randomUUID(),toolName:name,arguments:args} as ProjectReadToolCall);}

test('host early model final fails honestly and still closes workspace when command cleanup fails',async()=>{
  for(const clean of [true,false]){
    const base=path.join(parent,randomUUID()),source=path.join(base,'source');fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'AGENTS.md'),'Synthetic command integration only.');const root=captureFolderRoot(randomUUID(),randomUUID(),source);
    const store=createProjectReadStore(product,path.join(base,'agent-project-read'));let workspaceCloses=0,runnerCloses=0,engineStarts=0,driverStarts=0,commandId='';
    const driver:CommandDriver={environment,async start(_record,_baseline,callbacks){driverStarts++;let resolve!:(v:CommandDriverOutcome)=>void;const done=new Promise<CommandDriverOutcome>(r=>{resolve=r;});await callbacks.started(new Date().toISOString());return {done,stop(){const time=new Date().toISOString();resolve({exit:{shellExitCode:125,shellExited:true,observedAt:time,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:clean?'confirmed':'failed',observedAt:time,proofSha256:clean?sha:null},eof:{stdout:true,stderr:true},logSha256:{stdout:empty,stderr:empty},error:null});}};}};
    const engine:ProjectReadEngine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),async start(input){engineStarts++;input.callbacks.notice({type:'started',sessionId:'session-'+input.runId});input.callbacks.notice({type:'step',step:1,usage:null});
      const inspected=ok(await call(input,'command_environment',{}));assert.equal(inspected.kind,'command_environment');if(inspected.kind!=='command_environment'||!inspected.workspace)throw Error('missing baseline');
      const launched=ok(await call(input,'command_start',{requestId:randomUUID(),environmentId:environment.environmentId,environmentRevision:sha,workspaceId:inspected.workspace.workspaceId,baselineVersion:inspected.workspace.baselineVersion,cwdRelativePath:'',commandText:'synthetic only',timeoutMs:120000}));assert.equal(launched.kind,'command_start');if(launched.kind==='command_start')commandId=launched.execution.executionId;
      input.callbacks.notice({type:'completed'});
    },answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{}};
    const host=createProjectReadHost({store,arbiter:createAgentRuntimeArbiter(),bindings:{snapshotBinding:()=>({ok:true,value:{folder:root,name:'Synthetic'}})},models:{status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>({apiKey:'synthetic',model,maxRequests:24,maxOutputTokens:16384,requestTimeoutMs:600000}),forget(){},close(){}},createEngine:()=>engine,
      workCycle:{directory:path.join(base,'agent-work-cycle','workspaces'),createWorkspace:async o=>{const w=await createWorkCycleWorkspace(o);return {...w,async close(){workspaceCloses++;await w.close();}};},createRunner:()=>({available:()=>({available:true,language:'javascript',isolation:'windows-appcontainer'}),async run(){throw Error('no legacy program');},async close(){runnerCloses++;}})},commands:{directory:path.join(base,'agent-command','runs'),drivers:[driver]}});
    try{const runId=ok(await host.invoke('startWorkRun',{contractVersion:V,clientRequestId:randomUUID(),projectId:root.projectId,bindingId:root.bindingId,model,goal:'Exercise async cleanup',constraint:'Synthetic only',continuedFrom:null},()=>true)).runId;
      const deadline=performance.now()+3000;while(performance.now()<deadline&&!store.load().runs.find(r=>r.run.runId===runId)?.run.events.some(e=>e.type==='cleanup.completed'))await new Promise<void>(r=>setImmediate(r));
      const run=store.load().runs.find(r=>r.run.runId===runId)!.run;assert.equal(run.status,'failed');assert.equal(run.cleanupState,clean?'idle':'failed');assert.equal(workspaceCloses,1);assert.equal(runnerCloses,1);assert.equal(engineStarts,1);assert.equal(driverStarts,1);
      const command=ok(await host.invoke('readCommandExecution',{contractVersion:V,runId,executionId:commandId,afterRevision:null,waitMs:0},()=>true));assert.equal(command.execution.stopRequested?.reason,'model_finished');assert.equal(command.execution.cleanup.state,clean?'confirmed':'failed');
      assert.equal(ok(await host.invoke('readCommandLog',{contractVersion:V,runId,executionId:commandId,stream:'stdout',offset:0,maxBytes:1,expectedPrefixVersion:null},()=>true)).page.data,'');
    }finally{await host.shutdown().catch(()=>{});store.close();const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
  }
});
