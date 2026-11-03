import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { COMMAND_LIMITS as L, type WslCommandEnvironment, type CommandRuntime, type CommandStream, type CommandStopReason } from '../../shared/agent/agent-command';
import type {CommandDiagnosticOperation,CommandDiagnosticCauseCode} from '../../shared/agent/command-diagnostics';
import { commandObject, commandProcessCount, isCommandEnvironment, isCommandRuntime } from '../../shared/agent/agent-command-validation';
import { WORK_CYCLE_LIMITS as W } from '../../shared/agent/agent-work-cycle';
import type { WorkCycleBaseline } from '../agent-work-cycle/types';
import { commandExecutions, nativePinned, nativeRead, prepareNativeDirectory, type NativeFilePin } from './native-files';
import { CommandError, type CommandDriver, type CommandDriverOutcome, type CommandRecord } from './types';
import { decodeWslBytes, parseWslTerminal, wslChanges, wslDigest, wslIdentity, wslIdentityMatches, type WslTerminal } from './wsl-protocol';
import {readWslPrestartRecovery,type WslPrestartRecoveryPin} from './wsl-prestart-recovery';

export type WslCommandDriverProfile=Readonly<{environment:WslCommandEnvironment;supervisor:NativeFilePin;proof:NativeFilePin;wslPath:string;linuxPythonPath:string;bubblewrapPath:string;prestartRecovery?:readonly WslPrestartRecoveryPin[]}>;
const BOOTSTRAP="import hashlib,sys; s=open(sys.argv[1],'rb').read(); assert hashlib.sha256(s).hexdigest()==sys.argv[2]; exec(compile(s,sys.argv[1],'exec'))";
const date=():string=>new Date().toISOString();
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function wslWindowsPath(value:string):string{
  if(!/^[A-Za-z]:\\/u.test(value)||value.slice(2).includes(':')||value.includes('\0')||value.split('\\').some(p=>p==='..'||p==='.'))throw new CommandError('UNSUPPORTED_PATH');
  return '/mnt/'+value[0]!.toLowerCase()+'/'+value.slice(3).replaceAll('\\','/');
}
export function createWslRequest(profile:WslCommandDriverProfile,record:CommandRecord,mode:'run'|'recover',baseline?:WorkCycleBaseline){
  if(profile.environment.platform!=='wsl'||record.intent.environment.platform!=='wsl'||!isDeepStrictEqual(record.intent.environment,profile.environment)||record.execution.environment.revision!==profile.environment.revision||wslDigest(record.execution.commandText)!==record.execution.scriptSha256)throw new CommandError('SOURCE_CHANGED');
  if(mode==='run'&&(!baseline||baseline.version!==record.execution.baselineVersion||baseline.runId!==record.execution.runId||baseline.workspaceId!==record.execution.workspaceId))throw new CommandError('CONFLICT');
  const files=baseline?.files.map(({file,bytes})=>{const expected=record.intent.baseline.find(f=>f.fileId===file.fileId);if(!expected||expected.relativePath!==file.relativePath||expected.version!==file.version||expected.bytes!==bytes.byteLength||wslDigest(bytes)!==file.version)throw new CommandError('SOURCE_CHANGED');return {relativePath:file.relativePath,version:file.version,bytes:bytes.byteLength,data:Buffer.from(bytes).toString('base64')};})??[];
  if(mode==='run'&&files.length!==record.intent.baseline.length)throw new CommandError('SOURCE_CHANGED');
  const wsl=profile.environment.wsl;
  const python=profile.environment.tools.find(t=>t.name==='python3'),bubblewrap=profile.environment.tools.find(t=>t.name==='bubblewrap');if(!python||!bubblewrap)throw new CommandError('CAPABILITY_DENIED');
  return {schema:'aaw.command.wsl.request.v1',mode,identity:wslIdentity(record),distribution:wsl.distribution,user:wsl.user,executionRoot:wsl.executionRoot,hostControl:wslWindowsPath(path.join(commandExecutions(),record.execution.executionId,'control')),shellPath:wsl.shellPath,bubblewrapPath:profile.bubblewrapPath,runtimeSha256:{bash:profile.environment.shell.sha256,python:python.sha256,bubblewrap:bubblewrap.sha256},sourceRoots:wsl.sourceRoots,cwdRelativePath:record.execution.cwdRelativePath,commandText:record.execution.commandText,timeoutMs:Math.max(1,Math.min(record.intent.args.timeoutMs,Date.parse(record.execution.deadlineAt)-Date.now())),logBytes:profile.environment.limits.logBytes,processLimit:profile.environment.limits.processes,baseline:files};
}
/** A live count is an observation, but legacy environments still bind its range. */
export function parseWslJob(value:unknown,record:CommandRecord,started:boolean):CommandRecord['execution']['job']{
  if(!started||record.intent.environment.platform!=='wsl'||!commandObject(value,['activeProcesses','emptyConfirmed','observedAt'])||value.emptyConfirmed!==false||typeof value.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.observedAt)||!Number.isFinite(Date.parse(value.observedAt))||value.activeProcesses!==null&&!commandProcessCount(value.activeProcesses,record.intent.environment.limits.processes))throw new CommandError('SOURCE_CHANGED');
  return {activeProcesses:value.activeProcesses as number|null,emptyConfirmed:false,observedAt:value.observedAt};
}
type Callbacks=Parameters<CommandDriver['start']>[2];
type BridgeResult=Readonly<{outcome:CommandDriverOutcome;logs:Readonly<Record<CommandStream,Uint8Array>>;missing:boolean}>;
/** Read only the supervisor's flushed Windows mirror. No WSL or user process starts. */
export function readWslCommandRecovery(record:CommandRecord,read:(name:string,max:number)=>Buffer):Readonly<{outcome:CommandDriverOutcome;logs:Readonly<Record<CommandStream,Uint8Array>>}>|null{
  try{
    const bytes=read('wsl-linux-result.json',L.recordBytes),terminal=parseWslTerminal(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),record);
    if(!terminal.cleanupConfirmed)return null;
    const logs={stdout:read('wsl-stdout.bin',L.logBytes),stderr:read('wsl-stderr.bin',L.logBytes)};
    for(const stream of ['stdout','stderr'] as const)if(logs[stream].length!==terminal.logs[stream].persistedBytes||wslDigest(logs[stream])!==terminal.logs[stream].sha256)return null;
    const bodies=new Map<string,Buffer>();terminal.exported.forEach((f,index)=>bodies.set(f.relativePath,read('wsl-artifact-'+index+'.bin',W.fileBytes)));
    const changes=wslChanges(terminal,bodies,record);
    return {logs,outcome:{exit:terminal.exit,job:terminal.job,cleanup:{state:'confirmed',observedAt:terminal.completedAt,proofSha256:wslDigest(bytes)},eof:{stdout:terminal.logs.stdout.eof,stderr:terminal.logs.stderr.eof},logSha256:{stdout:terminal.logs.stdout.coverage==='complete'?terminal.logs.stdout.sha256:null,stderr:terminal.logs.stderr.coverage==='complete'?terminal.logs.stderr.sha256:null},logMetadata:terminal.logs,error:terminal.error,changes,artifactCollection:{scope:'bounded_text_exports',skippedEntries:terminal.skippedFiles}}};
  }catch{return null;}
}
/** An immutable old admission can still verify its mirror after its runtime was replaced. */
export function createWslRecoveryDriver(environment:WslCommandEnvironment,prestartRecovery:readonly WslPrestartRecoveryPin[]=[]):CommandDriver{
  if(!isCommandEnvironment(environment))throw new CommandError('CAPABILITY_DENIED');
  const admitted=structuredClone(environment);
  return {environment:admitted,recoveryOnly:true,async start(){throw new CommandError('CAPABILITY_DENIED');},async recover(record){
    if(!/^cmd-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.execution.executionId)||!isDeepStrictEqual(record.intent.environment,admitted))return null;
    const read=(name:string,max:number)=>nativeRead(path.join(commandExecutions(),record.execution.executionId,'control',name),max);
    return readWslCommandRecovery(record,read)??readWslPrestartRecovery(record,read,prestartRecovery);
  }};
}
/** No fallback to the host WSL user. Only the admitted bubblewrap profile executes. */
export function createWslCommandDriver(profile:WslCommandDriverProfile):CommandDriver{
  if(process.platform!=='win32'||!isCommandEnvironment(profile.environment)||profile.environment.platform!=='wsl'||profile.environment.availability!=='ready'||profile.environment.isolation!=='wsl-bubblewrap'||profile.environment.wsl.distribution!=='ROCKY9_LLM_LAB'||profile.environment.wsl.user!=='maxwell'||profile.environment.wsl.shellPath!=='/bin/bash'||profile.bubblewrapPath!=='/usr/bin/bwrap'||profile.linuxPythonPath!=='/usr/bin/python3'||profile.wslPath.toLowerCase()!=='c:\\windows\\system32\\wsl.exe'||profile.environment.wsl.sourceRoots.some(s=>s.access!=='read_only'||s.enforcement!=='os_read_only'))throw new CommandError('CAPABILITY_DENIED');
  nativePinned(profile.supervisor,128*1024);nativePinned(profile.proof,L.recordBytes);
  function bridge(record:CommandRecord,mode:'run'|'recover',baseline?:WorkCycleBaseline,callbacks?:Callbacks){
    const diagnosed=new Set<string>();
    const report=(operation:CommandDiagnosticOperation,error?:unknown,causeCode?:CommandDiagnosticCauseCode,nativeCode:number|null=null,kind:'failure'|'cleanup'='failure'):void=>{
      if(diagnosed.has(operation))return;diagnosed.add(operation);
      try{callbacks?.diagnostic?.({component:'wsl_driver',operation,kind,...(causeCode?{causeCode}:{}),nativeCode},error);}catch{/* Diagnostics never change command control. */}
    };
    let request:ReturnType<typeof createWslRequest>,directory:ReturnType<typeof prepareNativeDirectory>|null,preparation:CommandDiagnosticOperation='profile_verify';
    try{
      nativePinned(profile.supervisor,128*1024);nativePinned(profile.proof,L.recordBytes);
      preparation='request_prepare';request=createWslRequest(profile,record,mode,baseline);
      preparation='directory_prepare';directory=mode==='run'?prepareNativeDirectory(record.execution.executionId):null;
      preparation='request_write';if(directory)directory.write('control/wsl-request.json',Buffer.from(JSON.stringify(request)));
    }catch(error){report(preparation,error);throw error;}
    const argv=['-d',profile.environment.wsl.distribution,'-u',profile.environment.wsl.user,'--exec',profile.linuxPythonPath,'-I','-c',BOOTSTRAP,wslWindowsPath(profile.supervisor.path),profile.supervisor.sha256];
    // wsl.exe requires the normal Windows console/pipe startup path; detached
    // launches did not enter Linux in the admitted host probe. Linux owns cleanup.
    let child:ReturnType<typeof spawn>;
    try{child=spawn(profile.wslPath,argv,{shell:false,windowsHide:true,detached:false,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:\\Windows',windir:'C:\\Windows',SystemDrive:'C:'}});}catch(error){report('spawn',error);throw error;}
    let stopped=false,exited=false,childCode:number|null=null,failed=false,callbackFailed=false,wireBytes=0,diagnosticBytes=0,missing=false,terminal:WslTerminal|null=null;
    let closeResolve!:()=>void;const closed=new Promise<void>(resolve=>{closeResolve=resolve;});
    let tail=Promise.resolve(),pending=Buffer.alloc(0),diagnostic=Buffer.alloc(0);
    const logs:Record<CommandStream,Buffer[]>={stdout:[],stderr:[]},offsets={stdout:0,stderr:0},hashes={stdout:createHash('sha256'),stderr:createHash('sha256')},bodies=new Map<string,Buffer>();
    const buffered={stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)},flushedAt={stdout:performance.now(),stderr:performance.now()};
    let started=false;
    const stop=(reason:CommandStopReason):void=>{if(stopped)return;stopped=true;try{child.stdin!.write(JSON.stringify({type:'stop',identity:wslIdentity(record),reason})+'\n');child.stdin!.end();}catch(error){report('stop_send',error,undefined,null,'cleanup');child.stdin!.destroy();}};
    const call=async(operation:CommandDiagnosticOperation,fn:()=>Promise<void>):Promise<void>=>{if(!callbacks||callbackFailed)return;try{await fn();}catch(error){report(operation,error);callbackFailed=true;stop('storage_failure');}};
    const flush=async(stream:CommandStream):Promise<void>=>{if(!buffered[stream].length)return;const bytes=buffered[stream];buffered[stream]=Buffer.alloc(0);flushedAt[stream]=performance.now();await call('callback_log',()=>callbacks!.log(stream,bytes));};
    child.stdin!.on('error',error=>{report('stdin_error',error);});child.on('error',error=>{report('spawn',error);failed=true;stop('shutdown');});child.once('close',code=>{childCode=code;exited=true;closeResolve();});
    child.stderr!.on('data',(chunk:Buffer)=>{diagnosticBytes+=chunk.length;if(diagnostic.length<8192)diagnostic=Buffer.concat([diagnostic,chunk.subarray(0,8192-diagnostic.length)]);});
    const consume=async(line:Buffer):Promise<void>=>{
      let operation:CommandDiagnosticOperation='protocol_decode';try{
      const event:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));if(!event||typeof event!=='object'||!('type' in event)||typeof event.type!=='string')throw new CommandError('SOURCE_CHANGED');
      const row=event as Record<string,unknown>;
      if(row.type==='fault'){operation='protocol_fault';report(operation,undefined,row.code==='WSL_BRIDGE_FAILED'?'WSL_BRIDGE_FAILED':'WSL_FAULT_FRAME');throw new CommandError('CAPABILITY_DENIED');}
      operation='protocol_result';if(row.type==='result'){if(terminal)throw new CommandError('SOURCE_CHANGED');terminal=parseWslTerminal(row.result,record);for(const stream of ['stdout','stderr'] as const)await flush(stream);await call('callback_exit',()=>callbacks!.shellExit(terminal!.exit));await call('callback_job',()=>callbacks!.job(terminal!.job));return;}
      operation='protocol_identity';
      if(terminal||!wslIdentityMatches(row.identity,record))throw new CommandError('SOURCE_CHANGED');
      if(row.type==='missing'){if(mode!=='recover'||missing)throw new CommandError('SOURCE_CHANGED');missing=true;return;}
      if(row.type==='started'){
        operation='protocol_started';
        if(mode!=='run'||started||typeof row.startedAt!=='string'||!Number.isFinite(Date.parse(row.startedAt))||!isCommandRuntime(row.runtime))throw new CommandError('SOURCE_CHANGED');
        const runtime=row.runtime as CommandRuntime,wsl=profile.environment.wsl,work=wsl.executionRoot+'/'+record.execution.executionId+'/work';
        if(runtime.platform!=='wsl'||runtime.distribution!==wsl.distribution||runtime.user!==wsl.user||runtime.workDirectory!==work||runtime.cwd!==work+(record.execution.cwdRelativePath?'/'+record.execution.cwdRelativePath:'')||runtime.baselineDirectory!==null)throw new CommandError('SOURCE_CHANGED');
        started=true;await call('callback_started',()=>callbacks!.started(row.startedAt as string,runtime));await call('callback_job',()=>callbacks!.job({activeProcesses:null,emptyConfirmed:false,observedAt:row.startedAt as string}));return;
      }
      if(row.type==='log'){
        operation='protocol_log';
        if(row.stream!=='stdout'&&row.stream!=='stderr')throw new CommandError('SOURCE_CHANGED');const stream=row.stream,bytes=decodeWslBytes(row.data,32768);
        if(row.offset!==offsets[stream]||offsets.stdout+offsets.stderr+bytes.length>profile.environment.limits.logBytes)throw new CommandError('SOURCE_CHANGED');
        logs[stream].push(bytes);offsets[stream]+=bytes.length;hashes[stream].update(bytes);
        if(callbacks){let at=0;while(at<bytes.length){const count=Math.min(L.logChunkBytes-buffered[stream].length,bytes.length-at);buffered[stream]=Buffer.concat([buffered[stream],bytes.subarray(at,at+count)]);at+=count;if(buffered[stream].length===L.logChunkBytes)await flush(stream);}if(performance.now()-flushedAt[stream]>=1000)await flush(stream);}return;
      }
      if(row.type==='job'){operation='protocol_job';const job=parseWslJob(row.job,record,started);await call('callback_job',()=>callbacks!.job(job));return;}
      if(row.type==='artifact'){
        operation='protocol_artifact';
        if(typeof row.relativePath!=='string'||bodies.has(row.relativePath)||bodies.size>=W.artifactsPerExecution)throw new CommandError('SOURCE_CHANGED');bodies.set(row.relativePath,decodeWslBytes(row.data,W.fileBytes));return;
      }
      operation='protocol_unknown';throw new CommandError('SOURCE_CHANGED');
      }catch(error){report(operation,error);throw error;}
    };
    child.stdout!.on('data',(chunk:Buffer)=>{
      wireBytes+=chunk.length;if(wireBytes>24*1024*1024){report('protocol_stdout_limit',undefined,'BUDGET_EXCEEDED');failed=true;stop('log_limit');return;}
      pending=Buffer.concat([pending,chunk]);let newline:number;
      while((newline=pending.indexOf(10))>=0){const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);if(line.length>512*1024){report('protocol_line_limit',undefined,'BUDGET_EXCEEDED');failed=true;stop('storage_failure');break;}tail=tail.then(()=>consume(line)).catch(()=>{failed=true;stop('storage_failure');});}
      if(pending.length>512*1024){report('protocol_line_limit',undefined,'BUDGET_EXCEEDED');failed=true;stop('storage_failure');pending=Buffer.alloc(0);}
    });
    // A live control pipe is the lease. EOF makes the Linux supervisor kill its own job.
    try{child.stdin!.write(JSON.stringify(request)+'\n');if(mode==='recover')child.stdin!.end();}catch(error){report('request_write',error);throw error;}
    const done=(async():Promise<BridgeResult>=>{
      const remaining=mode==='recover'?15000:request.timeoutMs,deadline=performance.now()+remaining;let nextFlush=performance.now()+1000;
      while(!exited&&performance.now()<deadline){
        if(performance.now()>=nextFlush){nextFlush=performance.now()+1000;tail=tail.then(async()=>{for(const stream of ['stdout','stderr'] as const)if(performance.now()-flushedAt[stream]>=1000)await flush(stream);}).catch(error=>{report('log_flush',error);failed=true;stop('storage_failure');});}
        await Promise.race([closed,sleep(100)]);
      }
      if(!exited){stop(mode==='recover'?'shutdown':'deadline');await Promise.race([closed,sleep(L.cleanupMs)]);}
      if(!exited){report('process_wait',undefined,'CLEANUP_FAILED',null,'cleanup');failed=true;try{child.kill();}catch(error){report('process_kill',error,undefined,null,'cleanup');}await Promise.race([closed,sleep(1000)]);}
      await tail;for(const stream of ['stdout','stderr'] as const)await flush(stream);if(pending.length){report('protocol_tail',undefined,'SOURCE_CHANGED');failed=true;}
      const snapshot=terminal as WslTerminal|null,digests={stdout:hashes.stdout.digest('hex'),stderr:hashes.stderr.digest('hex')};
      if(snapshot)for(const stream of ['stdout','stderr'] as const)if(snapshot.logs[stream].persistedBytes!==offsets[stream]||snapshot.logs[stream].sha256!==digests[stream]){report('log_digest',undefined,'SOURCE_CHANGED');failed=true;}
      if(childCode!==0||!exited)report('process_exit',undefined,'WSL_PROCESS_EXIT',childCode);
      if(!snapshot&&!missing)report('result_missing',undefined,'WSL_RESULT_MISSING',null,'cleanup');
      if(childCode!==0||!exited||!snapshot&&!missing)failed=true;
      const confirmed=!!snapshot&&snapshot.cleanupConfirmed&&!failed&&!callbackFailed;
      let changes:CommandDriverOutcome['changes']=null,artifactFailed=false;
      if(confirmed&&snapshot)try{changes=wslChanges(snapshot,bodies,record);}catch(error){report('artifacts_verify',error);artifactFailed=true;}
      if(!confirmed)report('cleanup_confirm',undefined,'CLEANUP_FAILED',null,'cleanup');
      const observedAt=date();
      const receipt={schema:'aaw.command.wsl.driver-result.v1',identity:wslIdentity(record),supervisorSha256:profile.supervisor.sha256,linuxResultSha256:snapshot?wslDigest(JSON.stringify(snapshot)):null,wslExited:exited,wslExitCode:childCode,linuxCleanupConfirmed:confirmed,wireFailed:failed,callbackFailed,diagnosticBase64:diagnostic.toString('base64'),diagnosticBytes,diagnosticTruncated:diagnosticBytes>diagnostic.length};
      let proofSha256=wslDigest(JSON.stringify({receipt,snapshot}));
      if(directory)try{proofSha256=directory.write('control/wsl-driver-result.json',Buffer.from(JSON.stringify({receipt,snapshot}))).sha256;}catch(error){report('proof_write',error,undefined,null,'cleanup');failed=true;}
      const cleanupConfirmed=confirmed&&!failed;
      const outcome:CommandDriverOutcome={exit:snapshot?.exit??{shellExitCode:null,shellExited:false,observedAt,termination:'fault'},job:cleanupConfirmed?snapshot!.job:{activeProcesses:null,emptyConfirmed:false,observedAt},cleanup:{state:cleanupConfirmed?'confirmed':'failed',observedAt,proofSha256},eof:{stdout:snapshot?.logs.stdout.eof??false,stderr:snapshot?.logs.stderr.eof??false},logSha256:{stdout:!failed&&snapshot?.logs.stdout.coverage==='complete'?digests.stdout:null,stderr:!failed&&snapshot?.logs.stderr.coverage==='complete'?digests.stderr:null},error:callbackFailed?{code:'CALLBACK_FAILED',stage:'log',nativeCode:null}:failed?{code:'WSL_EVIDENCE_FAILED',stage:mode==='recover'?'recovery':'cleanup',nativeCode:childCode}:artifactFailed?{code:'WSL_ARTIFACTS_UNAVAILABLE',stage:'run',nativeCode:null}:snapshot?.error??null,changes:cleanupConfirmed?changes:null,...(snapshot?{logMetadata:snapshot.logs,artifactCollection:{scope:'bounded_text_exports' as const,skippedEntries:snapshot.skippedFiles}}:{})};
      return {outcome,logs:{stdout:Buffer.concat(logs.stdout),stderr:Buffer.concat(logs.stderr)},missing};
    })();
    return {stop,done};
  }
  return {environment:structuredClone(profile.environment),async start(record,baseline,callbacks){const handle=bridge(record,'run',baseline,callbacks);return {stop:handle.stop,done:handle.done.then(r=>r.outcome)};},async recover(record){
    if(!/^cmd-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.execution.executionId)||!isDeepStrictEqual(record.intent.environment,profile.environment))return null;
    const read=(name:string,max:number)=>nativeRead(path.join(commandExecutions(),record.execution.executionId,'control',name),max);
    return readWslCommandRecovery(record,read)??readWslPrestartRecovery(record,read,profile.prestartRecovery??[]);
  }};
}
