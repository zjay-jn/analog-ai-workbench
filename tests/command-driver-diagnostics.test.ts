import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createWindowsCommandDriver,type CommandDriverProfile} from '../apps/desktop/src/main/agent-command/windows-driver';
import {createWslCommandDriver,type WslCommandDriverProfile} from '../apps/desktop/src/main/agent-command/wsl-driver';
import {COMMAND_EXECUTIONS,type NativeFilePin} from '../apps/desktop/src/main/agent-command/native-files';
import {createCommandRecord} from '../apps/desktop/src/main/agent-command/state';
import {commandDigest} from '../apps/desktop/src/main/agent-command/logs';
import {nativeManifestSha} from '../apps/desktop/src/main/agent-command/native-protocol';
import {wslIdentity,type WslTerminal} from '../apps/desktop/src/main/agent-command/wsl-protocol';
import {CommandError,type CommandDriver} from '../apps/desktop/src/main/agent-command/types';
import type {CommandEnvironment,WslCommandEnvironment} from '../apps/desktop/src/shared/agent/agent-command';
import type {WorkCycleBaseline} from '../apps/desktop/src/main/agent-work-cycle/types';
import type {CommandDiagnosticInput} from '../apps/desktop/src/shared/agent/command-diagnostics';

const parent=path.resolve('C:/work/analog_ai_workbench/.local/command-diagnostics-20261027/driver-fixtures'),sha=commandDigest('synthetic'),empty=commandDigest('');
const windows:CommandEnvironment={environmentId:'synthetic-windows',revision:sha,displayName:'No process',platform:'windows',shell:{kind:'powershell',version:'synthetic',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16777216,defaultTimeoutMs:120000,maxTimeoutMs:600000}};
const wsl:WslCommandEnvironment={...windows,environmentId:'synthetic-wsl',platform:'wsl',shell:{kind:'bash',version:'synthetic',sha256:sha,scriptEncoding:'utf8',interactive:false},tools:[{name:'python3',version:'synthetic',sha256:sha},{name:'bubblewrap',version:'synthetic',sha256:sha}],isolation:'wsl-bubblewrap',projectAccess:'declared_roots',baselineAccess:'verified_copy',network:'inherited',hostEnvironment:'controlled',packageInstallation:'not_provided',executableScope:'wsl_user_permissions',wsl:{distribution:'ROCKY9_LLM_LAB',user:'maxwell',homeDirectory:'/home/maxwell',shellPath:'/bin/bash',executionRoot:'/home/maxwell/synthetic',sourceRoots:[]}};
type Entry={input:Pick<CommandDiagnosticInput,'component'|'operation'|'kind'|'causeCode'|'nativeCode'>;error?:unknown};
type Callbacks=Parameters<CommandDriver['start']>[2];
type MutableCallbacks={-readonly[K in keyof Callbacks]:Callbacks[K]};
function fixture(t:TestContext,environment:CommandEnvironment){
  const base=path.join(parent,randomUUID());fs.mkdirSync(base,{recursive:true});
  const pin=(name:string):NativeFilePin=>{const file=path.join(base,name),bytes=Buffer.from('inert fixture '+name);fs.writeFileSync(file,bytes);return {path:file,bytes:bytes.length,sha256:commandDigest(bytes)};};
  const baseline:WorkCycleBaseline={runId:'diagnostic-'+randomUUID(),workspaceId:'work-'+randomUUID(),version:sha,files:[]};
  const record=createCommandRecord(baseline.runId,{requestId:randomUUID(),environmentId:environment.environmentId,environmentRevision:sha,workspaceId:baseline.workspaceId,baselineVersion:sha,cwdRelativePath:'',commandText:'SYNTHETIC_ONLY_NEVER_EXECUTE',timeoutMs:120000},environment,baseline,Date.now());
  const entries:Entry[]=[],controls:string[]=[];let attempts=0;
  const callbacks:MutableCallbacks={started:async()=>{},shellExit:async()=>{},job:async()=>{},log:async()=>{},diagnostic(input,error){entries.push({input,error});}};
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){assert.fail('No actual kill');},unref(){assert.fail('No detached ownership');}});
  child.stdin.on('data',(bytes:Buffer)=>controls.push(bytes.toString()));
  const transport=(body:()=>void)=>t.mock.method(childProcess,'spawn',(_file:string,_argv:string[],options:childProcess.SpawnOptions)=>{attempts++;assert.equal(options.shell,false);assert.equal(options.windowsHide,true);setTimeout(()=>{body();child.emit('close',0);},15);return child;});
  const executionRoot=path.join(COMMAND_EXECUTIONS,record.execution.executionId);
  function cleanup(){t.mock.restoreAll();for(const target of [executionRoot,base])if(fs.existsSync(target)){const absolute=fs.realpathSync.native(target),root=target===base?parent:COMMAND_EXECUTIONS,relative=path.relative(root,absolute);assert.equal(absolute,target);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(absolute,{recursive:true});}}
  return {base,pin,baseline,record,entries,controls,callbacks,child,transport,executionRoot,cleanup,attempts:()=>attempts};
}
function linuxResult(row:ReturnType<typeof createCommandRecord>,stdout=''):WslTerminal{
  const time=new Date().toISOString(),log=(text:string)=>({observedBytes:Buffer.byteLength(text),persistedBytes:Buffer.byteLength(text),sha256:commandDigest(text),eof:true,coverage:'complete' as const});
  return {schema:'aaw.command.wsl.result.v1',identity:wslIdentity(row),startedAt:time,completedAt:time,exit:{shellExited:false,shellExitCode:null,observedAt:time,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanupConfirmed:true,logs:{stdout:log(stdout),stderr:log('')},error:null,lifecycle:{supervisorPid:10,supervisorStartTicks:'1',namespacePid:11,namespaceStartTicks:'2',namespaceInode:'pid:[12345]',namespaceProcessesRemaining:0,namespaceInitReaped:true},exported:[],deleted:[],skippedFiles:0};
}

for(const scenario of ['fault','decode','callback','proof','success','diagnostic_throw'] as const)test('WSL driver fixed diagnostics and unchanged control: '+scenario,async t=>{
  const f=fixture(t,wsl);try{
    const profile:WslCommandDriverProfile={environment:wsl,supervisor:f.pin('supervisor.py'),proof:f.pin('proof.json'),wslPath:'C:\\Windows\\System32\\wsl.exe',linuxPythonPath:'/usr/bin/python3',bubblewrapPath:'/usr/bin/bwrap'};
    const failure=new CommandError('STORAGE_FAILED'),out='synthetic';
    if(scenario==='callback')f.callbacks.log=async()=>{throw failure;};
    if(scenario==='diagnostic_throw')f.callbacks.diagnostic=()=>{throw Error('Logging unavailable');};
    if(scenario==='proof'){
      const open=fs.openSync;t.mock.method(fs,'openSync',((...args:Parameters<typeof fs.openSync>)=>{if(typeof args[0]==='string'&&args[0].endsWith('wsl-driver-result.json')&&args[1]==='wx')throw Object.assign(Error('private path deliberately omitted'),{code:'EACCES'});return open(...args);}) as typeof fs.openSync);
    }
    f.transport(()=>{
      if(scenario==='fault'||scenario==='diagnostic_throw'){const line=JSON.stringify({type:'fault',code:'WSL_BRIDGE_FAILED',detail:'PRIVATE_DETAIL_NOT_FOR_DIAGNOSTIC'})+'\n';f.child.stdout.write(line+line);}
      else if(scenario==='decode')f.child.stdout.write('{invalid-json\n{invalid-json\n');
      else{
        if(scenario==='callback')f.child.stdout.write(JSON.stringify({type:'log',identity:wslIdentity(f.record),stream:'stdout',offset:0,data:Buffer.from(out).toString('base64')})+'\n');
        f.child.stdout.write(JSON.stringify({type:'result',result:linuxResult(f.record,scenario==='callback'?out:'')})+'\n');
      }
    });
    const handle=await createWslCommandDriver(profile).start(f.record,f.baseline,f.callbacks),result=await handle.done;
    assert.equal(f.attempts(),1);assert.equal(new Set(f.entries.map(e=>e.input.operation)).size,f.entries.length);
    if(scenario==='success'){assert.equal(result.cleanup.state,'confirmed');assert.equal(result.exit.shellExited,false);assert.equal(f.entries.length,0);}
    else{
      assert.equal(result.cleanup.state,'failed');
      if(scenario!=='diagnostic_throw'){
        const operation={fault:'protocol_fault',decode:'protocol_decode',callback:'callback_log',proof:'proof_write'}[scenario];
        const entry=f.entries.find(e=>e.input.operation===operation);assert(entry,JSON.stringify(f.entries));
        if(scenario==='callback')assert.equal(entry.error,failure);
        if(scenario==='fault')assert.equal(entry.input.causeCode,'WSL_BRIDGE_FAILED');
        if(scenario==='proof')assert.equal((entry.error as NodeJS.ErrnoException).code,'EACCES');
        assert(!JSON.stringify(f.entries.map(e=>e.input)).includes('PRIVATE_DETAIL'));
      }
      if(scenario==='fault'||scenario==='decode'||scenario==='callback'||scenario==='diagnostic_throw')assert.equal(f.controls.filter(c=>c.includes('"type":"stop"')).length,1);
    }
  }finally{f.cleanup();}
});

for(const scenario of ['protocol','callback','spawn','native_failure'] as const)test('Windows driver preserves detailed failure and cleanup observation: '+scenario,async t=>{
  const f=fixture(t,windows);try{
    const profile:CommandDriverProfile={environment:windows,native:f.pin('native.txt'),node:f.pin('node.txt'),license:f.pin('license.txt'),bootstrap:f.pin('bootstrap.txt'),proof:f.pin('proof.txt')};
    if(scenario==='spawn'){
      const error=Object.assign(Error('Private spawn detail'),{code:'EACCES'});t.mock.method(childProcess,'spawn',()=>{throw error;});
      await assert.rejects(createWindowsCommandDriver(profile).start(f.record,f.baseline,f.callbacks),e=>e===error);assert.equal(f.entries[0]?.input.operation,'spawn');assert.equal(f.entries[0]?.error,error);return;
    }
    const failure=new CommandError('STORAGE_FAILED');if(scenario==='callback')f.callbacks.log=async()=>{throw failure;};
    f.transport(()=>{if(scenario==='native_failure')f.child.stderr.write('status_create:80\r\n');});
    const spawn=childProcess.spawn;t.mock.method(childProcess,'spawn',((...args:Parameters<typeof childProcess.spawn>)=>{
      const control=path.join(f.executionRoot,'control'),time=new Date().toISOString();
      if(scenario==='protocol')fs.writeFileSync(path.join(control,'status.json'),'{invalid');
      else if(scenario==='callback'){
        const log=Buffer.from('synthetic log');fs.writeFileSync(path.join(control,'stdout.bin'),log);
        fs.writeFileSync(path.join(control,'status.json'),JSON.stringify({schema:'aaw.command.native.status.v1',executionId:f.record.execution.executionId,signature:f.record.execution.signature,nonce:f.record.intent.nonce,environmentRevision:sha,commandSha256:f.record.execution.commandSha256,scriptSha256:f.record.execution.scriptSha256,baselineVersion:sha,baselineManifestSha256:nativeManifestSha([]),seq:1,startedAt:time,shellExit:null,job:{activeProcesses:1,emptyConfirmed:false,observedAt:time},logs:{stdout:{observedBytes:log.length,persistedBytes:log.length,eof:false,sha256:null,coverage:'open'},stderr:{observedBytes:0,persistedBytes:0,eof:false,sha256:null,coverage:'open'}},stopReason:null}));
      }
      return spawn(...args);
    }) as typeof childProcess.spawn);
    const handle=await createWindowsCommandDriver(profile).start(f.record,f.baseline,f.callbacks),result=await handle.done;
    assert.equal(result.cleanup.state,'failed');assert.equal(f.attempts(),1);assert.equal(new Set(f.entries.map(e=>e.input.operation)).size,f.entries.length);
    const entry=f.entries.find(e=>e.input.operation===(scenario==='protocol'?'protocol_status':scenario==='callback'?'callback_log':'native_failure'));assert(entry,JSON.stringify(f.entries));
    if(scenario==='protocol')assert(entry.error instanceof SyntaxError);else if(scenario==='callback')assert.equal(entry.error,failure);else {assert.equal(f.entries[0],entry);assert.equal(entry.input.nativeCode,80);}
    assert(f.entries.some(e=>e.input.operation==='result_missing'));assert(f.entries.some(e=>e.input.operation==='cleanup_confirm'));assert.equal(f.controls.filter(c=>c==='C').length,scenario==='native_failure'?0:1);
  }finally{f.cleanup();}
});
