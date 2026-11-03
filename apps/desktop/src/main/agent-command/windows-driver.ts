import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { COMMAND_LIMITS as L, type CommandEnvironment, type CommandExecution, type CommandStream } from '../../shared/agent/agent-command';
import {commandDiagnosticCauseCode,type CommandDiagnosticOperation,type CommandDiagnosticCauseCode} from '../../shared/agent/command-diagnostics';
import { isCommandEnvironment } from '../../shared/agent/agent-command-validation';
import { WORK_CYCLE_LIMITS as W, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { inspectProjectFolderPath } from '../cloud/project-folder-files';
import { CommandError, CommandPreparationError, type CommandDriver, type CommandDriverOutcome, type CommandProducedChanges } from './types';
import { commandChangesVersion, validateCommandChanges } from './changes';
import { prepareWindowsCommand } from './windows-preparation';
import { recoverWindowsCommand } from './windows-recovery';
import { COMMAND_PRODUCT, createNativeLogReader, nativeDigest, nativePinned, nativeRead, nativeReadStatus, prepareNativeDirectory, type NativeFilePin } from './native-files';
import { nativeManifest, nativeManifestSha, parseNativeReady, parseNativeResult, parseNativeStatus, type NativeCommandResult, type NativeCommandStatus, type NativeManifestEntry } from './native-protocol';

export type CommandDriverProfile=Readonly<{
  environment:CommandEnvironment;native:NativeFilePin;node:NativeFilePin;license:NativeFilePin;bootstrap:NativeFilePin;proof:NativeFilePin;
}>;
const systemCode=(e:unknown):unknown=>e&&typeof e==='object'&&'code' in e?e.code:null;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const date=()=>new Date().toISOString();
/** Registration is main-private and requires root-pinned new production binary/bootstrap/proof. */
export function createWindowsCommandDriver(profile:CommandDriverProfile):CommandDriver{
  if(process.platform!=='win32'||!isCommandEnvironment(profile.environment)||profile.environment.platform!=='windows'||profile.environment.availability!=='ready')throw new CommandError('CAPABILITY_DENIED');
  nativePinned(profile.native,4*1024*1024);nativePinned(profile.bootstrap,65536);nativePinned(profile.proof,L.recordBytes);
  return {environment:structuredClone(profile.environment),recover:record=>recoverWindowsCommand(profile,record),async start(record,baseline,callbacks){
    const diagnosed=new Set<string>();
    const report=(operation:CommandDiagnosticOperation,error?:unknown,causeCode?:CommandDiagnosticCauseCode,nativeCode:number|null=null,kind:'failure'|'cleanup'='failure'):void=>{
      if(diagnosed.has(operation))return;diagnosed.add(operation);
      try{callbacks.diagnostic?.({component:'windows_driver',operation,kind,...(causeCode?{causeCode}:{}),nativeCode},error);}catch{/* Diagnostics never change command control. */}
    };
    let prepared:ReturnType<typeof prepareWindowsCommand>;
    try{prepared=prepareWindowsCommand(profile,record,baseline);}catch(error){report('prepare',error,error instanceof CommandPreparationError?commandDiagnosticCauseCode(error.detailCode):undefined);throw error;}
    const {directory,runtimePins,manifest,manifestSha,remaining}=prepared;
    const argv=[directory.root,record.execution.executionId,record.execution.signature,record.intent.nonce,record.execution.environment.revision,record.execution.commandSha256,record.execution.scriptSha256,record.execution.baselineVersion,manifestSha,record.execution.deadlineAt?String(Date.parse(record.execution.deadlineAt)):'',record.execution.cwdRelativePath,...manifest.map(f=>`${f.sha256}:${f.bytes}:${f.relativePath}`)];
    // Keep this supervisor outside libuv's kill-on-parent-exit Job so stdin EOF can trigger its own bounded Job cleanup.
    let child:ReturnType<typeof spawn>;
    try{child=spawn(profile.native.path,argv,{cwd:directory.root,shell:false,windowsHide:true,detached:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:\\Windows',windir:'C:\\Windows',SystemDrive:'C:'}});}catch(error){report('spawn',error);throw error;}
    let exited=false,exitCode:number|null=null,controlStopped=false,callbackFailed=false,evidenceFailed=false,nativeBytes=0,diagnosticBytes=0,diagnosticTruncated=false;
    const diagnostics:Buffer[]=[];let closeResolve!:()=>void;const closed=new Promise<void>(resolve=>{closeResolve=resolve;});
    // Ownership is installed before any main callback. Failure never loses stdin or the done promise.
    const stop=():void=>{if(controlStopped)return;controlStopped=true;try{child.stdin!.write('C');child.stdin!.end();}catch(error){report('stop_send',error,undefined,null,'cleanup');child.stdin!.destroy();}};
    child.stdin!.on('error',error=>{report('stdin_error',error);});child.on('error',error=>{report('spawn',error);evidenceFailed=true;stop();});child.once('close',code=>{exitCode=code;exited=true;closeResolve();});
    child.stdout!.on('data',(b:Buffer)=>{nativeBytes+=b.length;if(nativeBytes>128*1024){report('protocol_stdout_limit',undefined,'BUDGET_EXCEEDED');evidenceFailed=true;stop();}});
    child.stderr!.on('data',(b:Buffer)=>{const room=Math.max(0,4096-diagnosticBytes);if(room)diagnostics.push(b.subarray(0,room));diagnosticBytes+=b.length;if(b.length>room)diagnosticTruncated=true;});
    const deadline=performance.now()+remaining,hardEnd=deadline+L.cleanupMs;
    const done=(async():Promise<CommandDriverOutcome>=>{
      const readLog=createNativeLogReader(directory.root),offsets={stdout:0,stderr:0},hashes={stdout:createHash('sha256'),stderr:createHash('sha256')},pending={stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)},lastFlush={stdout:performance.now(),stderr:performance.now()};
      let started=false,last:NativeCommandStatus|null=null,terminal:NativeCommandResult|null=null,nativeResultBytes:Buffer|null=null,lastExit:CommandExecution['exit']=null,lastJob:CommandExecution['job']={activeProcesses:null,emptyConfirmed:false,observedAt:null};
      const call=async(operation:CommandDiagnosticOperation,fn:()=>Promise<void>):Promise<void>=>{if(callbackFailed)return;try{await fn();}catch(error){report(operation,error);callbackFailed=true;stop();}};
      const readJson=(name:string):Readonly<{value:unknown;bytes:Buffer}>|null=>{for(let attempt=0;attempt<(name==='status'?3:1);attempt++)try{directory.check();const bytes=(name==='status'?nativeReadStatus:nativeRead)(directory.target('control/'+name+'.json'),L.recordBytes);return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),bytes};}catch(e){if(systemCode(e)==='ENOENT')return null;if(name==='status'&&e instanceof CommandError&&e.code==='SOURCE_CHANGED')continue;throw e;}return null;};
      async function consume(next:NativeCommandStatus,final:boolean):Promise<void>{
        let operation:CommandDiagnosticOperation='status_sequence';try{
        if(last&&next.seq<last.seq)throw new CommandError('SOURCE_CHANGED');
        if(last&&next.seq===last.seq&&!isDeepStrictEqual(last,next))throw new CommandError('SOURCE_CHANGED');
        if(!started&&next.startedAt){started=true;await call('callback_started',()=>callbacks.started(next.startedAt!));}
        operation='status_exit';if(next.shellExit){if(lastExit?.shellExited&&(!next.shellExit.shellExited||lastExit.shellExitCode!==next.shellExit.shellExitCode||lastExit.observedAt!==next.shellExit.observedAt))throw new CommandError('SOURCE_CHANGED');if(!isDeepStrictEqual(next.shellExit,lastExit)){lastExit=next.shellExit;await call('callback_exit',()=>callbacks.shellExit(next.shellExit!));}}
        operation='status_job';if(next.job.activeProcesses!==lastJob.activeProcesses||next.job.emptyConfirmed!==lastJob.emptyConfirmed){if(lastJob.emptyConfirmed&&!next.job.emptyConfirmed)throw new CommandError('SOURCE_CHANGED');lastJob=next.job;await call('callback_job',()=>callbacks.job(next.job));}
        operation='log_read';
        for(const stream of ['stdout','stderr'] as const){const log=next.logs[stream];if(log.persistedBytes<offsets[stream]||last&&log.observedBytes<last.logs[stream].observedBytes)throw new CommandError('SOURCE_CHANGED');
          while(offsets[stream]<log.persistedBytes){const end=Math.min(log.persistedBytes,offsets[stream]+L.logChunkBytes-pending[stream].length),chunk=readLog(stream,offsets[stream],end);offsets[stream]=end;hashes[stream].update(chunk);pending[stream]=Buffer.concat([pending[stream],chunk]);if(pending[stream].length===L.logChunkBytes){const bytes=pending[stream];pending[stream]=Buffer.alloc(0);lastFlush[stream]=performance.now();await call('callback_log',()=>callbacks.log(stream,bytes));}}
          if(pending[stream].length&&(final||performance.now()-lastFlush[stream]>=2000)){const bytes=pending[stream];pending[stream]=Buffer.alloc(0);lastFlush[stream]=performance.now();await call('callback_log',()=>callbacks.log(stream,bytes));}
        }last=next;
        }catch(error){report(operation,error);throw error;}
      }
      let operation:CommandDiagnosticOperation='protocol_ready';
      try{
        while(!exited&&performance.now()<hardEnd){
          if(performance.now()>=deadline)stop();
          try{operation='protocol_ready';const ready=readJson('ready');if(ready&&!started){const r=parseNativeReady(ready.value,record,manifestSha);started=true;await call('callback_started',()=>callbacks.started(r.startedAt));}
            operation='protocol_status';const state=readJson('status');if(state)await consume(parseNativeStatus(state.value,record,manifestSha),false);
          }catch(error){report(operation,error);evidenceFailed=true;stop();}
          await Promise.race([closed,sleep(100)]);
        }
        if(!exited){report('process_wait',undefined,'NATIVE_CLEANUP_TIMEOUT',null,'cleanup');evidenceFailed=true;stop();try{child.kill();}catch(error){report('process_kill',error,undefined,null,'cleanup');}await Promise.race([closed,sleep(L.cleanupMs)]);}
        operation='protocol_result';if(exited){const raw=readJson('result');if(raw){terminal=parseNativeResult(raw.value,record,manifestSha);nativeResultBytes=raw.bytes;const {cleanup,jobClosed,profileDeleted,aclRestored,error,workManifest,workManifestSha256,...state}=terminal;await consume(state,true);}}
      }catch(error){report(operation,error);evidenceFailed=true;stop();}
      // A missing/invalid terminal receipt cannot erase raw bytes already checked against a trusted status.
      // Persist pending prefixes even after native failure; EOF/cleanup still require their own evidence.
      for(const stream of ['stdout','stderr'] as const)if(pending[stream].length){const bytes=pending[stream];pending[stream]=Buffer.alloc(0);await call('callback_log',()=>callbacks.log(stream,bytes));}
      const missingResult=exited&&!terminal;if(!terminal)evidenceFailed=true;
      const digests={stdout:hashes.stdout.digest('hex'),stderr:hashes.stderr.digest('hex')};
      if(terminal)for(const stream of ['stdout','stderr'] as const)if(terminal.logs[stream].persistedBytes!==offsets[stream]||terminal.logs[stream].sha256!==digests[stream]){report('log_digest',undefined,'SOURCE_CHANGED');evidenceFailed=true;}
      let changes:CommandProducedChanges|null=null,runtimeDisposed=false,adoptionError:CommandExecution['error']=null;
      if(terminal?.cleanup.state==='confirmed'&&terminal.job.emptyConfirmed&&!evidenceFailed){
        try{
          for(const f of manifest){const bytes=nativeRead(directory.target('baseline/'+f.relativePath),W.fileBytes);if(bytes.length!==f.bytes||nativeDigest(bytes)!==f.sha256)throw new CommandError('SOURCE_CHANGED');}
        }catch(error){report('baseline_verify',error);evidenceFailed=true;}
        if(!evidenceFailed&&terminal.workManifestSha256!==null)try{
          const actual:NativeManifestEntry[]=[],bodies=new Map<string,Buffer>();let visited=0,total=0;
          const walk=(relative:string):void=>{directory.check();const root=directory.target(relative?'work/'+relative:'work');inspectProjectFolderPath(root,true);const dir=fs.opendirSync(root);try{let entry:fs.Dirent|null;while((entry=dir.readSync())!==null){if(++visited>W.files*W.pathDepth)throw new CommandError('BUDGET_EXCEEDED');const rel=relative?relative+'/'+entry.name:entry.name;if(!isWorkCycleRelativePath(rel)||entry.isSymbolicLink())throw new CommandError('UNSUPPORTED_PATH');if(entry.isDirectory())walk(rel);else{const bytes=nativeRead(directory.target('work/'+rel),W.fileBytes);total+=bytes.length;if(total>W.workspaceBytes||actual.length>=W.files)throw new CommandError('BUDGET_EXCEEDED');bodies.set(rel,bytes);actual.push({relativePath:rel,bytes:bytes.length,sha256:nativeDigest(bytes)});}}}finally{dir.closeSync();}};walk('');
          if(!isDeepStrictEqual(nativeManifest(actual),terminal.workManifest))throw new CommandError('SOURCE_CHANGED');
          const files=nativeManifest(actual).filter(f=>manifest.find(b=>b.relativePath===f.relativePath)?.sha256!==f.sha256).map(f=>({relativePath:f.relativePath,beforeVersion:manifest.find(b=>b.relativePath===f.relativePath)?.sha256??null,version:f.sha256,bytes:bodies.get(f.relativePath)!}));
          const deleted=manifest.filter(f=>!bodies.has(f.relativePath)).map(f=>({relativePath:f.relativePath,beforeVersion:f.sha256}));const delta={baselineVersion:record.execution.baselineVersion,files,deleted};changes={...delta,manifestVersion:commandChangesVersion(delta)};validateCommandChanges(changes,record.intent.baseline);
        }catch(error){report('artifacts_verify',error);adoptionError={code:'ARTIFACTS_UNAVAILABLE',stage:'run',nativeCode:null};changes=null;}
        if(!evidenceFailed)try{runtimeDisposed=directory.disposeRuntime(runtimePins);if(!runtimeDisposed)report('runtime_dispose',undefined,'CLEANUP_FAILED',null,'cleanup');}catch(error){report('runtime_dispose',error,undefined,null,'cleanup');runtimeDisposed=false;}
      }
      const observedAt=date(),cleanupConfirmed=!!terminal&&terminal.cleanup.state==='confirmed'&&terminal.job.emptyConfirmed&&terminal.jobClosed&&terminal.profileDeleted&&terminal.aclRestored&&runtimeDisposed&&!evidenceFailed;
      const diagnostic=Buffer.concat(diagnostics),nativeFailureMatch=!diagnosticTruncated?/^([a-z_]{1,64}):([0-9]{1,10})\r?\n$/u.exec(diagnostic.toString('utf8')):null;
      const nativeFailure=nativeFailureMatch&&Number(nativeFailureMatch[2])<=4294967295?{stage:nativeFailureMatch[1]!,code:Number(nativeFailureMatch[2])}:null;
      if(nativeFailure)report('native_failure',undefined,'NATIVE_EVIDENCE_FAILED',nativeFailure.code);
      if(!terminal)report('result_missing',undefined,'NATIVE_RESULT_MISSING',exitCode,'cleanup');
      if(!cleanupConfirmed)report('cleanup_confirm',undefined,'CLEANUP_FAILED',null,'cleanup');
      const error:CommandExecution['error']=callbackFailed?{code:'CALLBACK_FAILED',stage:'log',nativeCode:null}:missingResult?{code:'NATIVE_RESULT_MISSING',stage:'cleanup',nativeCode:nativeFailure?.code??null}:evidenceFailed?{code:'NATIVE_EVIDENCE_FAILED',stage:'cleanup',nativeCode:nativeFailure?.code??null}:terminal?.error??adoptionError;
      const shellExit=terminal?.shellExit??lastExit??{shellExitCode:null,shellExited:false,observedAt,termination:'fault' as const};
      let proofSha256:string|null=null;
      try{const proof=directory.write('control/driver-result.json',Buffer.from(JSON.stringify({schema:'aaw.command.driver.result.v1',executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,environmentRevision:record.execution.environment.revision,nativeResultSha256:nativeResultBytes?nativeDigest(nativeResultBytes):null,nativeExitCode:exitCode,nativeExited:exited,nativeFailure,logs:{offsets,digests},runtimeDisposed,cleanupConfirmed,changes:changes?{manifestVersion:changes.manifestVersion,files:changes.files.map(f=>({relativePath:f.relativePath,version:f.version,bytes:f.bytes.byteLength})),deleted:changes.deleted}:null,error,diagnostics:diagnostic.toString('base64'),diagnosticTruncated})));proofSha256=proof.sha256;}catch(error){report('proof_write',error,undefined,null,'cleanup');evidenceFailed=true;}
      const eof={stdout:terminal?.logs.stdout.eof??false,stderr:terminal?.logs.stderr.eof??false};
      const full=(stream:CommandStream):string|null=>!evidenceFailed&&!callbackFailed&&terminal?.logs[stream].coverage==='complete'&&terminal.logs[stream].observedBytes===offsets[stream]&&eof[stream]?digests[stream]:null;
      return {exit:shellExit,job:terminal?.job??lastJob,cleanup:{state:cleanupConfirmed&&!evidenceFailed?'confirmed':'failed',observedAt,proofSha256},eof,logSha256:{stdout:full('stdout'),stderr:full('stderr')},error,changes:callbackFailed?null:changes,
        ...((terminal??last)?{logMetadata:{stdout:(terminal??last)!.logs.stdout,stderr:(terminal??last)!.logs.stderr}}:{})};
    })();
    // The native owns its Job. Closing main (E3) naturally closes stdin; no public test-control API exists.
    return {stop(_reason){stop();},done};
  }};
}
