import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_LIMITS as L, type CommandEnvironment, type WslCommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command';
import { isCommandEnvironment, isCommandExecution } from '../apps/desktop/src/shared/agent/agent-command-validation';
import { commandDigest } from '../apps/desktop/src/main/agent-command/logs';
import { createCommandRecord, validateCommandRecord } from '../apps/desktop/src/main/agent-command/state';
import { createCommandController } from '../apps/desktop/src/main/agent-command/controller';
import { createWslRecoveryDriver, createWslRequest, parseWslJob, readWslCommandRecovery, type WslCommandDriverProfile } from '../apps/desktop/src/main/agent-command/wsl-driver';
import { parseWslTerminal, wslIdentity, type WslTerminal } from '../apps/desktop/src/main/agent-command/wsl-protocol';
import type { CommandRecord, CommandRepository } from '../apps/desktop/src/main/agent-command/types';
import type { WorkCycleBaseline } from '../apps/desktop/src/main/agent-work-cycle/types';

const sha=commandDigest('synthetic policy'),empty=commandDigest(''),when='2026-09-16T00:00:00.000Z';
const environment:WslCommandEnvironment={environmentId:'synthetic-policy',revision:sha,displayName:'Synthetic policy; no process',platform:'wsl',shell:{kind:'bash',version:'synthetic',sha256:sha,scriptEncoding:'utf8',interactive:false},tools:[{name:'python3',version:'synthetic',sha256:sha},{name:'bubblewrap',version:'synthetic',sha256:sha}],isolation:'wsl-bubblewrap',profileRevision:sha,availability:'ready',reason:null,projectAccess:'declared_roots',baselineAccess:'verified_copy',workAccess:'execution_copy',network:'inherited',hostEnvironment:'controlled',packageInstallation:'not_provided',executableScope:'wsl_user_permissions',survivesAppClose:false,limits:{processes:null,logBytes:L.logBytes,defaultTimeoutMs:L.defaultTimeoutMs,maxTimeoutMs:L.maxTimeoutMs},wsl:{distribution:'SYNTHETIC_LAB',user:'tester',homeDirectory:'/home/tester',shellPath:'/bin/bash',executionRoot:'/home/tester/executions',sourceRoots:[]}};
const windows:CommandEnvironment={environmentId:'synthetic-windows',revision:sha,displayName:'Synthetic Windows',platform:'windows',shell:{kind:'powershell',version:'synthetic',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{...environment.limits,processes:8}};
const baseline:WorkCycleBaseline={runId:'policy-run',workspaceId:'policy-work',version:sha,files:[]};
function record(env:CommandEnvironment=environment):CommandRecord{
  return createCommandRecord(baseline.runId,{requestId:'request-1',environmentId:env.environmentId,environmentRevision:env.revision,workspaceId:baseline.workspaceId,baselineVersion:sha,cwdRelativePath:'',commandText:'printf synthetic',timeoutMs:120000},env,baseline,Date.parse(when));
}
function running(row:CommandRecord):CommandRecord{
  const env=row.intent.environment;assert.equal(env.platform,'wsl');if(env.platform!=='wsl')throw Error('fixture');
  const work=env.wsl.executionRoot+'/'+row.execution.executionId+'/work';
  return {...row,execution:{...row.execution,phase:'running',startedAt:when,runtime:{platform:'wsl',distribution:env.wsl.distribution,user:env.wsl.user,cwd:work,workDirectory:work,baselineDirectory:null}}};
}
function terminal(row:CommandRecord,count=0):WslTerminal{
  const log={observedBytes:0,persistedBytes:0,sha256:empty,eof:true,coverage:'complete' as const},limit=row.intent.environment.limits.processes;
  return {schema:'aaw.command.wsl.result.v1',identity:wslIdentity(row),startedAt:when,completedAt:when,exit:{shellExitCode:0,shellExited:true,observedAt:when,termination:'exited'},job:{activeProcesses:count,emptyConfirmed:count===0,observedAt:when},cleanupConfirmed:count===0,logs:{stdout:log,stderr:log},error:null,lifecycle:{supervisorPid:10,supervisorStartTicks:'100',namespacePid:11,namespaceStartTicks:'101',namespaceInode:'pid:[12345]',namespaceProcessesRemaining:count,namespaceInitReaped:count===0,processObservation:{policy:limit===null?'observe_only':'terminate_above_limit',limit,peakProcesses:65,samples:2}},exported:[],deleted:[],skippedFiles:0};
}

test('process policy: explicit WSL null, legacy numeric 1..8 and Windows 8 remain separate',()=>{
  for(const processes of [null,1,8])assert.equal(isCommandEnvironment({...environment,limits:{...environment.limits,processes}}),true);
  for(const processes of [undefined,0,9,32,64,100000,NaN,Infinity,'none',false])assert.equal(isCommandEnvironment({...environment,limits:{...environment.limits,processes}}),false);
  assert.equal(isCommandEnvironment(windows),true);
  for(const processes of [null,9])assert.equal(isCommandEnvironment({...windows,limits:{...windows.limits,processes}}),false);
});

test('process policy: live/public/persistent counts bind the observed runtime and frozen limit',()=>{
  const row=running(record()),legacy=running(record({...environment,limits:{...environment.limits,processes:8}}));
  for(const count of [0,8,9,33,65,500]){
    const next={...row,execution:{...row.execution,job:{activeProcesses:count,emptyConfirmed:false,observedAt:when}}};
    assert.equal(isCommandExecution(next.execution),true);validateCommandRecord(next);
    assert.equal(parseWslJob(next.execution.job,row,true).activeProcesses,count);
    if(count>8){assert.throws(()=>validateCommandRecord({...legacy,execution:{...legacy.execution,job:next.execution.job}}));assert.throws(()=>parseWslJob(next.execution.job,legacy,true));}
  }
  for(const count of [-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'9']){
    const job={activeProcesses:count,emptyConfirmed:false,observedAt:when};
    assert.equal(isCommandExecution({...row.execution,job}),false);assert.throws(()=>parseWslJob(job,row,true));
  }
  const job={activeProcesses:9,emptyConfirmed:false,observedAt:when};
  assert.throws(()=>parseWslJob(job,row,false));
  assert.equal(isCommandExecution({...record().execution,job}),false);
  assert.equal(isCommandExecution({...record(windows).execution,job}),false);
  assert.throws(()=>validateCommandRecord({...record(windows),execution:{...record(windows).execution,runtime:row.execution.runtime,startedAt:when,job}}));
  assert.equal(parseWslJob({...job,activeProcesses:null},row,true).activeProcesses,null);
});

test('process policy: request carries explicit null and cannot borrow a different profile',()=>{
  const row=record(),pin={path:'C:\\work\\analog_ai_workbench\\synthetic.py',bytes:1,sha256:sha};
  const profile:WslCommandDriverProfile={environment,supervisor:pin,proof:pin,wslPath:'C:\\Windows\\System32\\wsl.exe',linuxPythonPath:'/usr/bin/python3',bubblewrapPath:'/usr/bin/bwrap'};
  assert.equal(createWslRequest(profile,row,'run',baseline).processLimit,null);
  assert.throws(()=>createWslRequest({...profile,environment:{...environment,limits:{...environment.limits,processes:8}}},row,'run',baseline));
});

test('process policy: terminal requires null-policy observation, preserves legacy receipts and unknown exit',()=>{
  const row=running(record()),receipt=terminal(row),legacy=running(record({...environment,limits:{...environment.limits,processes:8}}));
  assert.equal(parseWslTerminal(terminal(row,65),row).job.activeProcesses,65);
  assert.throws(()=>parseWslTerminal(terminal(legacy,9),legacy));
  const {processObservation:_observation,...oldLifecycle}=receipt.lifecycle;
  assert.throws(()=>parseWslTerminal({...receipt,lifecycle:oldLifecycle},row));
  assert.equal(parseWslTerminal({...terminal(legacy),lifecycle:oldLifecycle},legacy).cleanupConfirmed,true);
  for(const patch of [{limit:8},{policy:'terminate_above_limit'},{peakProcesses:-1},{peakProcesses:null},{samples:0},{samples:1.5}])assert.throws(()=>parseWslTerminal({...receipt,lifecycle:{...receipt.lifecycle,processObservation:{...receipt.lifecycle.processObservation,...patch}}},row));
  assert.equal(parseWslTerminal({...receipt,lifecycle:{...receipt.lifecycle,processObservation:{policy:'observe_only',limit:null,samples:0,peakProcesses:null}}},row).lifecycle.processObservation?.peakProcesses,null);
  const stopped={...receipt,exit:{...receipt.exit,shellExited:false,shellExitCode:null,termination:'stopped' as const}};
  assert.equal(parseWslTerminal(stopped,row).exit.shellExited,false);
  assert.throws(()=>parseWslTerminal({...stopped,exit:{...stopped.exit,shellExitCode:0}},row));
  assert.throws(()=>parseWslTerminal({...receipt,lifecycle:{...receipt.lifecycle,namespaceProcessesRemaining:null}},row));
});

test('process policy: new and legacy recovery read only mirrors; recovery-only drivers cannot launch',async()=>{
  for(const limit of [null,8]){
    const row=running(record({...environment,limits:{...environment.limits,processes:limit}})),receipt=terminal(row);
    const files=new Map([['wsl-linux-result.json',Buffer.from(JSON.stringify(receipt))],['wsl-stdout.bin',Buffer.alloc(0)],['wsl-stderr.bin',Buffer.alloc(0)]]);
    let reads=0;const recovered=readWslCommandRecovery(row,name=>{reads++;const value=files.get(name);if(!value)throw Error('missing');return value;});
    assert.equal(recovered?.outcome.cleanup.state,'confirmed');assert.equal(reads,3);
  }
  const old=createWslRecoveryDriver({...environment,limits:{...environment.limits,processes:8}}),row=record(old.environment);
  assert.equal(old.recoveryOnly,true);await assert.rejects(old.start(row,baseline,{async started(){},async log(){},async shellExit(){},async job(){}}));
  const repository:CommandRepository={load:()=>[],create(){throw Error('must not write');},save(){throw Error('must not write');},writeChunk(){throw Error('must not write');},readChunk(){throw Error('must not read');},close(){}};
  const controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository,drivers:[old],exportBaseline:async()=>baseline});
  assert.deepEqual((await controller.inspect()).environments,[]);await assert.rejects(controller.start(row.intent.args));await controller.close('shutdown');
});
