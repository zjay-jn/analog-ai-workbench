import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCommandController} from '../apps/desktop/src/main/agent-command/controller';
import {createCommandRepository} from '../apps/desktop/src/main/agent-command/store';
import {createCommandDiagnosticJournal} from '../apps/desktop/src/main/agent-command/diagnostics';
import {createWorkCycleWorkspace} from '../apps/desktop/src/main/agent-work-cycle/workspace';
import {commandDigest} from '../apps/desktop/src/main/agent-command/logs';
import {commandChangesVersion} from '../apps/desktop/src/main/agent-command/changes';
import {CommandError,type CommandDriver,type CommandDriverOutcome,type CommandRepository} from '../apps/desktop/src/main/agent-command/types';
import type {CommandEnvironment} from '../apps/desktop/src/shared/agent/agent-command';
const parent=path.resolve('C:/work/analog_ai_workbench/.local/command-diagnostics-20261027/controller-tests'),sha=commandDigest('synthetic'),empty=commandDigest('');
const environment:CommandEnvironment={environmentId:'synthetic-env',revision:sha,displayName:'Synthetic only',platform:'windows',shell:{kind:'powershell',version:'fake',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16*1024*1024,defaultTimeoutMs:120000,maxTimeoutMs:600000}};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Fault='none'|'start'|'wait'|'log'|'save'|'publish'|'confirm';
async function fixture(fault:Fault='none',delta=false,proof=true){
 const base=path.join(parent,randomUUID()),runId=randomUUID(),workspaceId='work-'+randomUUID(),abort=new AbortController(),directory=path.join(base,'diagnostics');
 fs.mkdirSync(base,{recursive:true});const workspace=await createWorkCycleWorkspace({directory:path.join(base,'agent-work-cycle','workspaces',workspaceId),runId,workspaceId,signal:abort.signal,readOnly:false});
 const baseline=await workspace.exportConfirmedBase(),journal=createCommandDiagnosticJournal({directory,appVersion:'0.1.0-test'}),repository=createCommandRepository({directory:path.join(base,'agent-command','runs',runId),runId,readOnly:false});
 let ready!:()=>void,doneResolve!:(outcome:CommandDriverOutcome)=>void,doneReject!:(error:unknown)=>void,emitDiagnostic!:()=>void,starts=0,stops=0,publishes=0,confirms=0;
 const prepared=new Promise<void>(resolve=>{ready=resolve;}),done=new Promise<CommandDriverOutcome>((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
 const changes={baselineVersion:baseline.version,files:delta?[{relativePath:'synthetic.txt',beforeVersion:null,version:sha,bytes:Buffer.from('synthetic')}]:[],deleted:[]};if(delta)changes.files[0]!.version=commandDigest('synthetic');
 const finish=()=>{if(fault==='wait'){doneReject(new CommandError('CONFLICT'));return;}const time=new Date().toISOString();doneResolve({exit:{shellExitCode:null,shellExited:false,observedAt:time,termination:'stopped'},job:{activeProcesses:proof?0:null,emptyConfirmed:proof,observedAt:time},cleanup:{state:proof?'confirmed':'failed',observedAt:time,proofSha256:proof?sha:null},eof:{stdout:true,stderr:true},logSha256:{stdout:empty,stderr:empty},error:null,changes:{...changes,manifestVersion:commandChangesVersion(changes)},...(fault==='log'?{logMetadata:{stdout:{observedBytes:0,persistedBytes:1,coverage:'complete' as const},stderr:{observedBytes:0,persistedBytes:0,coverage:'complete' as const}}}:{})});};
 const driver:CommandDriver={environment,async start(_record,_baseline,callbacks){starts++;emitDiagnostic=()=>callbacks.diagnostic?.({component:'windows_driver',operation:'prepare',kind:'observation'});if(fault==='start'){ready();throw new Error('SECRET_API_KEY and private command');}await callbacks.started(new Date().toISOString());ready();return {done,stop(){stops++;if(fault==='wait')throw new Error('private cleanup error');finish();}};}};
 const wrapped:CommandRepository={...repository,save(old,next){if(fault==='save'&&next.execution.phase==='terminal')throw new CommandError('STORAGE_FAILED');repository.save(old,next);}};
 const controller=createCommandController({runId,workspaceId,repository:wrapped,drivers:[driver],workspace:{async publishCommandArtifacts(...args){publishes++;if(fault==='publish')throw new CommandError('CONFLICT');return workspace.publishCommandArtifacts(...args);},async confirmCommandArtifacts(...args){confirms++;if(fault==='confirm')throw new CommandError('CONFLICT');return workspace.confirmCommandArtifacts(...args);}},exportBaseline:()=>workspace.exportConfirmedBase(),diagnostics:journal,diagnosticContext:{chatSessionId:'synthetic-chat',turnId:'synthetic-turn'}});
 const started=await controller.start({requestId:randomUUID(),environmentId:environment.environmentId,environmentRevision:sha,workspaceId,baselineVersion:baseline.version,cwdRelativePath:'',commandText:'synthetic only; never executed',timeoutMs:120000});await prepared;
 const records=()=>createCommandDiagnosticJournal({directory,appVersion:'0.1.0-test'}).read(runId,started.executionId);
 return {controller,abort,runId,workspaceId,base,journal,started,records,finish,emitDiagnostic:()=>emitDiagnostic(),counts:()=>({starts,stops,publishes,confirms}),
  async settle(){for(let i=0;i<80;i++){await tick();try{const e=controller.list()[0]!;if(['terminal','reconciliation_required'].includes(e.phase))return;}catch{return;}}assert.fail('fixture did not settle');},
  async close(){await controller.close('shutdown');await workspace.close();repository.close();const actual=fs.realpathSync.native(base);assert.equal(actual,base);assert.match(path.relative(parent,actual),/^[a-f0-9-]{36}$/);fs.rmSync(actual,{recursive:true});},
 };
}

test('cancelled workspace adoption preserves verified cleanup for empty and real file deltas',async()=>{
 for(const delta of [false,true]){const f=await fixture('none',delta);try{
  f.abort.abort();const closing=await f.controller.close('user'),e=f.controller.list()[0]!;
  assert.equal(e.phase,'terminal');assert.equal(e.cleanup.state,'confirmed');assert.equal(e.cleanup.proofSha256,sha);assert.equal(e.job.emptyConfirmed,true);assert.equal(closing.cleanupConfirmed,true);
  assert.equal(e.changes.state,'unavailable');assert.equal(e.artifacts.length,0);assert.equal(e.error?.code,'RESULT_ADOPTION_CANCELLED');assert.equal(f.counts().stops,1);assert.equal(f.counts().confirms,0);
  const log=f.records();assert.equal(log.unavailable,false);assert.equal(log.records[0]!.causeCode,'CANCELLED');assert.equal(log.records[0]!.operation,delta?'finish.artifacts.publish':'finish.baseline');assert(log.records.every(r=>r.chatSessionId==='synthetic-chat'&&r.turnId==='synthetic-turn'));
 }finally{await f.close();}}
});

test('cancellation without cleanup proof still leaves cleanup unconfirmed',async()=>{
 const f=await fixture('none',false,false);try{f.abort.abort();const result=await f.controller.close('user'),e=f.controller.list()[0]!;assert.equal(result.cleanupConfirmed,false);assert.notEqual(e.cleanup.state,'confirmed');assert(f.records().records.some(r=>r.operation==='finish.changes.validate'));}finally{await f.close();}
});

test('failure stages survive cold journal reads and cleanup does not replace the first cause',async()=>{
 for(const [fault,operation,code] of [['start','driver.start','UNKNOWN_ERROR'],['wait','driver.wait','CONFLICT'],['log','finish.log.stdout','CONFLICT'],['save','record.save','STORAGE_FAILED'],['publish','finish.artifacts.publish','CONFLICT'],['confirm','finish.artifacts.confirm','CONFLICT']] as const){
  const f=await fixture(fault,fault==='publish'||fault==='confirm');try{
   if(fault!=='start')f.finish();await f.settle();await f.controller.close('user');const read=f.records();assert.equal(read.unavailable,false);assert.equal(read.records[0]!.operation,operation);assert.equal(read.records[0]!.causeCode,code);
   assert(read.records.some(r=>r.kind==='cleanup'));assert.doesNotMatch(JSON.stringify(read),/SECRET_API_KEY|private command|private cleanup/);
  }finally{await f.close();}
 }
});

test('diagnostic append failure cannot break successful execution or confirm cleanup without proof',async()=>{
 const f=await fixture();try{let attempts=0;f.journal.append=()=>{attempts++;throw new Error('diagnostic disk unavailable');};f.emitDiagnostic();assert.equal(attempts,1);f.finish();await f.settle();assert.equal(f.controller.list()[0]!.phase,'terminal');assert.equal(f.controller.list()[0]!.cleanup.state,'confirmed');}finally{await f.close();}
});
