import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_LIMITS as L, type CommandEnvironment, type CommandRuntime, type CommandStartArguments, type WslCommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command';
import { isCommandArtifactCollection, isCommandEnvironment, isCommandExecution, commandLinuxPath } from '../apps/desktop/src/shared/agent/agent-command-validation';
import { fileNameAllowed } from '../apps/desktop/src/shared/agent/file-context';
import { commandDigest } from '../apps/desktop/src/main/agent-command/logs';
import { assertCommandTransition, commandRequestSignature, commandScriptBytes, createCommandRecord, validateCommandRecord } from '../apps/desktop/src/main/agent-command/state';
import { createCommandController } from '../apps/desktop/src/main/agent-command/controller';
import { createCommandHistoryAudit } from '../apps/desktop/src/main/agent-command/history';
import { reconcileCommandRecords } from '../apps/desktop/src/main/agent-command/recovery';
import type { CommandDriver, CommandDriverOutcome, CommandRecord, CommandRepository } from '../apps/desktop/src/main/agent-command/types';
import type { WorkCycleBaseline } from '../apps/desktop/src/main/agent-work-cycle/types';
import type { ProjectReadEventData } from '../apps/desktop/src/shared/agent/agent-project-read';

const sha=commandDigest('synthetic WSL contract'),empty=commandDigest('');
const limits={processes:8,logBytes:L.logBytes,defaultTimeoutMs:L.defaultTimeoutMs,maxTimeoutMs:L.maxTimeoutMs};
const windows:CommandEnvironment={environmentId:'synthetic-windows',revision:sha,displayName:'Legacy Windows',platform:'windows',shell:{kind:'powershell',version:'synthetic',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits};
const environment:WslCommandEnvironment={environmentId:'synthetic-wsl',revision:sha,displayName:'Synthetic Linux contract; no process',platform:'wsl',shell:{kind:'bash',version:'synthetic',sha256:sha,scriptEncoding:'utf8',interactive:false},tools:[],isolation:'wsl-bubblewrap',profileRevision:sha,availability:'ready',reason:null,projectAccess:'declared_roots',baselineAccess:'verified_copy',workAccess:'execution_copy',network:'inherited',hostEnvironment:'controlled',packageInstallation:'not_provided',executableScope:'wsl_user_permissions',survivesAppClose:false,limits,wsl:{distribution:'SYNTHETIC_LAB',user:'tester',homeDirectory:'/home/tester',shellPath:'/bin/bash',executionRoot:'/home/tester/command-tests',sourceRoots:[{path:'/home/tester/source',access:'read_only',enforcement:'os_read_only'}]}};
const baseline:WorkCycleBaseline={runId:'wsl-contract-run',workspaceId:'wsl-contract-workspace',version:sha,files:[]};
const args=(env:CommandEnvironment=environment):CommandStartArguments=>({requestId:'request-1',environmentId:env.environmentId,environmentRevision:env.revision,workspaceId:baseline.workspaceId,baselineVersion:baseline.version,cwdRelativePath:'',commandText:'printf "你好\\n"',timeoutMs:120000});
const runtime=(row:CommandRecord):CommandRuntime=>({platform:'wsl',distribution:environment.wsl.distribution,user:environment.wsl.user,cwd:environment.wsl.executionRoot+'/'+row.execution.executionId+'/work',workDirectory:environment.wsl.executionRoot+'/'+row.execution.executionId+'/work',baselineDirectory:null});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
class MemoryRepository implements CommandRepository {
  rows:CommandRecord[]=[];
  load(){return structuredClone(this.rows);}
  create(row:CommandRecord){validateCommandRecord(row);this.rows.push(structuredClone(row));}
  save(previous:CommandRecord,next:CommandRecord){assertCommandTransition(previous,next);this.rows[this.rows.findIndex(r=>r.execution.executionId===previous.execution.executionId)]=structuredClone(next);}
  recover(previous:CommandRecord,next:CommandRecord){validateCommandRecord(next);this.rows[this.rows.findIndex(r=>r.execution.executionId===previous.execution.executionId)]=structuredClone(next);}
  writeChunk():string{throw Error('This fixture never produces raw log bytes');}
  readChunk():Uint8Array{throw Error('This fixture never produces raw log bytes');}
  close(){}
}
function outcome():CommandDriverOutcome {const time=new Date().toISOString();return {exit:{shellExited:true,shellExitCode:0,observedAt:time,termination:'exited'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},eof:{stdout:true,stderr:true},logSha256:{stdout:empty,stderr:empty},error:null,artifactCollection:{scope:'bounded_text_exports',skippedEntries:3}};}

test('Windows BOM and absent runtime remain byte/signature compatible; Linux uses exact UTF-8',()=>{
  const win=createCommandRecord(baseline.runId,args(windows),windows,baseline,Date.now()),wsl=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now());
  assert.equal(isCommandEnvironment(windows),true);assert.equal(isCommandEnvironment(environment),true);
  assert.equal(Object.hasOwn(win.execution,'runtime'),false);assert.equal(wsl.execution.runtime,null);
  assert.equal(win.execution.scriptSha256,commandDigest(Buffer.concat([Buffer.from([239,187,191]),Buffer.from(win.execution.commandText)])));
  assert.equal(wsl.execution.scriptSha256,wsl.execution.commandSha256);assert.deepEqual(commandScriptBytes(environment,args().commandText),Buffer.from(args().commandText));
  assert.equal(win.execution.signature,commandRequestSignature(baseline.runId,args(windows)));validateCommandRecord(win);validateCommandRecord(wsl);
  assert.throws(()=>validateCommandRecord({...wsl,execution:{...wsl.execution,scriptSha256:win.execution.scriptSha256}}));
});

test('WSL schema rejects copied Windows guarantees and malformed Linux source identities',()=>{
  for(const patch of [{network:'denied'},{hostEnvironment:'not_inherited'},{baselineAccess:'read_only'},{isolation:'windows-appcontainer-job'},{shell:windows.shell}])assert.equal(isCommandEnvironment({...environment,...patch}),false);
  for(const bad of ['/home/tester/../source','/home//source','/home/source/','C:/host','/home\\source','/home/\u0000'])assert.equal(commandLinuxPath(bad),false,bad);
  assert.equal(isCommandEnvironment({...environment,wsl:{...environment.wsl,distribution:'SYNTHETIC --user root'}}),false);
  assert.equal(isCommandEnvironment({...environment,wsl:{...environment.wsl,sourceRoots:[{path:'/source',access:'read_write',enforcement:'os_read_only'}]}}),false);
  assert.equal(fileNameAllowed('run-analysis.sh'),true);assert.equal(fileNameAllowed('source.py'),true);assert.equal(fileNameAllowed('secrets.sh'),false);assert.equal(fileNameAllowed('run.cjs'),false);
});

test('runtime binds actual distribution, Linux cwd and immutable start observation',()=>{
  const row=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now()),time=new Date().toISOString(),started:CommandRecord={...row,execution:{...row.execution,revision:2,phase:'running',startedAt:time,runtime:runtime(row)}};
  assertCommandTransition(row,started);assert.equal(isCommandExecution(started.execution),true);
  assert.throws(()=>validateCommandRecord({...row,execution:{...row.execution,runtime:runtime(row)}}));
  for(const patch of [{cwd:'/source'},{user:'root'},{workDirectory:'/wrong'},{baselineDirectory:'/other/baseline'}])assert.throws(()=>validateCommandRecord({...started,execution:{...started.execution,runtime:{...runtime(row),...patch}}}));
  assert.throws(()=>validateCommandRecord({...started,execution:{...started.execution,runtime:null}}));
  assert.throws(()=>assertCommandTransition(started,{...started,execution:{...started.execution,revision:3,runtime:{...runtime(row),baselineDirectory:environment.wsl.executionRoot+'/'+row.execution.executionId+'/baseline'}}}));
});

test('controller retains WSL runtime, idempotent requests and cold-open zero replay',async()=>{
  const repository=new MemoryRepository();let starts=0;
  const driver:CommandDriver={environment,async start(row,_base,callbacks){starts++;await callbacks.started(new Date().toISOString(),runtime(row));return {stop(){},done:Promise.resolve(outcome())};}};
  const controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository,drivers:[driver],exportBaseline:async()=>baseline});
  const first=await controller.start(args());await turn();assert.equal(controller.list()[0]!.phase,'terminal');assert.deepEqual(controller.list()[0]!.runtime,runtime(repository.rows[0]!));
  assert.deepEqual(controller.list()[0]!.artifactCollection,{scope:'bounded_text_exports',skippedEntries:3});
  assert.equal((await controller.start(args())).executionId,first.executionId);assert.equal(starts,1);await controller.close('shutdown');
  const cold=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository,drivers:[driver],readOnly:true,exportBaseline:async()=>baseline});assert.equal(cold.list()[0]!.phase,'terminal');assert.equal(starts,1);await cold.close('shutdown');
  assert.equal(cold.list()[0]!.artifactCollection?.skippedEntries,3);
});

test('bounded text collection is explicit and malformed omission counts fail validation',()=>{
  const row=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now());
  for(const skippedEntries of [-1,1.5,Number.NaN,'3'])assert.equal(isCommandArtifactCollection({scope:'bounded_text_exports',skippedEntries}),false);
  assert.equal(isCommandExecution({...row.execution,artifactCollection:{scope:'all_results',skippedEntries:0}}),false);
  const previous={...row,execution:{...row.execution,artifactCollection:{scope:'bounded_text_exports' as const,skippedEntries:3}}};
  assert.throws(()=>assertCommandTransition(previous,{...previous,execution:{...previous.execution,revision:2,artifactCollection:{scope:'bounded_text_exports',skippedEntries:0}}}));
});

test('missing WSL runtime fails closed; unrelated recovery identity does not replay',async()=>{
  const repository=new MemoryRepository();let starts=0,recovers=0;
  const driver:CommandDriver={environment,async start(_row,_base,callbacks){starts++;await callbacks.started(new Date().toISOString());throw Error('not reached');},async recover(){recovers++;return null;}};
  const controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository,drivers:[driver],exportBaseline:async()=>baseline});await controller.start(args());await turn();
  assert.equal(controller.list()[0]!.phase,'reconciliation_required');assert.equal(controller.idle(),false);assert.equal(starts,1);
  assert.equal(await reconcileCommandRecords(repository,[{...driver,environment:{...environment,revision:empty}}]),false);assert.equal(recovers,0);assert.equal(starts,1);await controller.close('shutdown');
});

test('history preserves observed runtime across later command status rows',()=>{
  const row=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now());
  const started={...row.execution,phase:'running' as const,startedAt:new Date().toISOString(),runtime:runtime(row)};
  const audit=createCommandHistoryAudit(baseline.runId,baseline.workspaceId,()=>{throw Error('history rejected');});
  const base={sessionId:'session',messageId:'message',callId:'call'};
  audit({...base,toolName:'command_start',arguments:args(),result:{ok:true,value:{kind:'command_start',execution:started}}} as ProjectReadEventData['tool.completed']);
  assert.throws(()=>audit({...base,toolName:'command_status',arguments:{executionId:started.executionId,afterRevision:null,waitMs:0},result:{ok:true,value:{kind:'command_status',execution:{...started,revision:2,runtime:{...runtime(row),user:'root'}}}}} as ProjectReadEventData['tool.completed']),/history rejected/u);
});
