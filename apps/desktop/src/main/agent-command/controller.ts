import { COMMAND_LIMITS as L, type CommandExecution, type CommandStopReason, type CommandToolArguments } from '../../shared/agent/agent-command';
import { isCommandArtifactCollection, isCommandEnvironment, isCommandRuntime, parseCommandArguments } from '../../shared/agent/agent-command-validation';
import { CommandError, CommandPreparationError, type CommandController, type CommandDriver, type CommandDriverOutcome, type CommandRecord, type CommandRepository } from './types';
import type { WorkCycleBaseline, WorkCycleWorkspace } from '../agent-work-cycle/types';
import { validateCommandChanges } from './changes';
import { appendCommandLog, commandDigest, readCommandLog, sealCommandLog } from './logs';
import { assertCommandRuntime, assertCommandTransition, commandOutstanding, commandRequestSignature, createCommandRecord } from './state';
import type {CommandDiagnosticInput,CommandDiagnosticOperation} from '../../shared/agent/command-diagnostics';
import type {CommandDiagnosticJournal} from './diagnostics';

type Timer = ReturnType<typeof setTimeout>;
type Handle = Awaited<ReturnType<CommandDriver['start']>>;
/** No process API here. Only admitted drivers may create processes, after repository.create succeeds. */
export function createCommandController(options:Readonly<{
  runId:string;workspaceId:string;repository:CommandRepository;drivers:readonly CommandDriver[];
  exportBaseline:()=>Promise<WorkCycleBaseline>;readOnly?:boolean;
  workspace?:Pick<WorkCycleWorkspace,'publishCommandArtifacts'|'confirmCommandArtifacts'>;
  diagnostics?:CommandDiagnosticJournal;
  diagnosticContext?:Pick<CommandDiagnosticInput,'chatSessionId'|'turnId'>;
  now?:()=>number;setTimer?:(fn:()=>void,ms:number)=>Timer;clearTimer?:(timer:Timer)=>void;
}>):CommandController {
  const repository=options.repository,now=options.now??Date.now,setTimer=options.setTimer??setTimeout,clearTimer=options.clearTimer??clearTimeout;
  const rows=new Map<string,CommandRecord>(),drivers=new Map<string,CommandDriver>(),handles=new Map<string,Handle>(),jobs=new Set<Promise<void>>(),deadlines=new Map<string,Timer>();
  const listeners=new Map<string,Set<()=>void>>();let tail=Promise.resolve(),closing=false,storageFailed=false;
  const reported=new WeakSet<object>();
  function report(id:string,operation:CommandDiagnosticOperation,error?:unknown,kind:CommandDiagnosticInput['kind']='failure'){
    if(options.readOnly)return;
    if(kind==='failure'&&error&&typeof error==='object'){if(reported.has(error))return;reported.add(error);}
    try{options.diagnostics?.append({runId:options.runId,workspaceId:options.workspaceId,executionId:id,...options.diagnosticContext,component:'controller',operation,kind},error);}catch{/* Diagnostics cannot replace execution or cleanup facts. */}
  }
  function check<T>(id:string,operation:CommandDiagnosticOperation,fn:()=>T):T{try{return fn();}catch(error){report(id,operation,error);throw error;}}
  async function attempt<T>(id:string,operation:CommandDiagnosticOperation,fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch(error){report(id,operation,error);throw error;}}
  for(const driver of options.drivers){if(!isCommandEnvironment(driver.environment))throw new CommandError('INVALID_REQUEST');if(driver.recoveryOnly)continue;if(drivers.has(driver.environment.environmentId))throw new CommandError('INVALID_REQUEST');drivers.set(driver.environment.environmentId,driver);}
  for(const row of repository.load()){
    if(row.execution.runId!==options.runId||row.execution.workspaceId!==options.workspaceId)throw new CommandError('STORAGE_FAILED');
    // A reopened controller observes uncertainty; it never recreates a handle or replays an intent.
    rows.set(row.execution.executionId,commandOutstanding(row.execution)?{...row,execution:{...row.execution,phase:'reconciliation_required',error:row.execution.error??{code:'RECONCILIATION_REQUIRED',stage:'recovery',nativeCode:null}}}:row);
  }
  const enqueue=<T>(fn:()=>T|Promise<T>):Promise<T>=>{const result=tail.then(fn);tail=result.then(()=>{},()=>{});return result;};
  const get=(id:string):CommandRecord=>{if(storageFailed)throw new CommandError('STORAGE_FAILED');const row=rows.get(id);if(!row)throw new CommandError('RUN_NOT_FOUND');return row;};
  const writable=():void=>{if(options.readOnly)throw new CommandError('CAPABILITY_DENIED');if(storageFailed)throw new CommandError('STORAGE_FAILED');};
  const notify=(id:string):void=>{for(const wake of [...listeners.get(id)??[]])wake();};
  function poison():void{storageFailed=true;for(const handle of handles.values())try{handle.stop('storage_failure');}catch{/* Cleanup remains unconfirmed. */}for(const id of rows.keys())notify(id);}
  function save(old:CommandRecord,next:CommandRecord):CommandRecord{
    const changed={...next,execution:{...next.execution,revision:old.execution.revision+1}};
    try{check(old.execution.executionId,'record.validate',()=>assertCommandTransition(old,changed));check(old.execution.executionId,'record.save',()=>repository.save(old,changed));}catch(e){poison();throw e;}
    rows.set(changed.execution.executionId,changed);notify(changed.execution.executionId);return changed;
  }
  const result=(id:string):CommandExecution=>structuredClone(get(id).execution);
  async function requestStop(id:string,reason:CommandStopReason):Promise<CommandExecution>{
    return enqueue(()=>{writable();let row=get(id);if(row.execution.phase==='reconciliation_required')throw new CommandError('CLEANUP_FAILED');
      if(row.execution.phase==='terminal')return structuredClone(row.execution);
      if(!row.execution.stopRequested)row=save(row,{...row,execution:{...row.execution,stopRequested:{reason,requestedAt:new Date(now()).toISOString()}}});
      try{handles.get(id)?.stop(row.execution.stopRequested!.reason);}catch(error){report(id,'driver.stop',error,'cleanup');save(row,{...row,execution:{...row.execution,error:row.execution.error??{code:'STOP_DELIVERY_FAILED',stage:'run',nativeCode:null}}});}
      return result(id);
    });
  }
  function update(id:string,change:(row:CommandRecord)=>CommandRecord):Promise<void>{return enqueue(()=>{const row=get(id);if(row.execution.phase==='terminal'||row.execution.phase==='reconciliation_required')throw new CommandError('CONFLICT');save(row,change(row));});}
  async function finish(id:string,outcome:CommandDriverOutcome):Promise<void>{
    await enqueue(async()=>{let row=get(id);let old=row;
      check(id,'finish.validate',()=>{if(outcome.artifactCollection!==undefined&&!isCommandArtifactCollection(outcome.artifactCollection))throw new CommandError('CONFLICT');});
      const observed=row.execution.exit?.shellExited?row.execution.exit:null;
      check(id,'finish.validate',()=>{if(observed&&(!outcome.exit.shellExited||observed.shellExitCode!==outcome.exit.shellExitCode))throw new CommandError('CONFLICT');});
      row={...row,execution:{...row.execution,phase:'terminal',completedAt:new Date(now()).toISOString(),exit:{...outcome.exit,observedAt:observed?.observedAt??outcome.exit.observedAt},job:outcome.job,cleanup:outcome.cleanup,error:row.execution.error??outcome.error,changes:{...row.execution.changes,state:'unavailable'},...(outcome.artifactCollection?{artifactCollection:outcome.artifactCollection}:{})}};
      for(const stream of ['stdout','stderr'] as const){
        const native=outcome.logMetadata?.[stream],saved=row.execution.logs[stream];
        if(native){check(id,stream==='stdout'?'finish.log.stdout':'finish.log.stderr',()=>{if(!Number.isSafeInteger(native.observedBytes)||!Number.isSafeInteger(native.persistedBytes)||native.observedBytes<native.persistedBytes||native.persistedBytes<saved.persistedBytes)throw new CommandError('CONFLICT');});
          row={...row,execution:{...row.execution,logs:{...row.execution.logs,[stream]:{...saved,observedBytes:Math.max(saved.observedBytes,native.observedBytes),coverage:native.coverage==='partial_at_limit'?'partial_at_limit':saved.coverage}}}};
        }
        row=check(id,stream==='stdout'?'finish.log.stdout':'finish.log.stderr',()=>sealCommandLog(repository,row,stream,outcome.eof[stream],native&&(native.coverage!=='complete'||native.persistedBytes!==saved.persistedBytes)?null:outcome.logSha256[stream]));
      }
      if(!row.execution.error&&(row.execution.logs.stdout.coverage==='incomplete'||row.execution.logs.stderr.coverage==='incomplete'))row={...row,execution:{...row.execution,error:{code:'LOG_INCOMPLETE',stage:'log',nativeCode:null}}};
      if(outcome.changes){
        try{
        check(id,'finish.changes.validate',()=>{if(!options.workspace||outcome.cleanup.state!=='confirmed'||!outcome.job.emptyConfirmed||outcome.changes!.baselineVersion!==row.execution.baselineVersion)throw new CommandError('CONFLICT');validateCommandChanges(outcome.changes!,row.intent.baseline);});
        if(outcome.changes.files.length===0&&outcome.changes.deleted.length===0){
          const current=await attempt(id,'finish.baseline',options.exportBaseline);
          check(id,'finish.baseline',()=>{if(current.runId!==row.execution.runId||current.workspaceId!==row.execution.workspaceId||current.version!==row.execution.baselineVersion)throw new CommandError('CONFLICT');});
          // The command record is the durable receipt; an empty workspace publication would change its baseline.
          row={...row,execution:{...row.execution,changes:{state:'verified',manifestVersion:outcome.changes.manifestVersion,count:0,acceptance:'not_requested'}}};
        }else{
        row=save(old,{...row,execution:{...row.execution,phase:'settling',completedAt:null}});old=row;
        const artifacts=await attempt(id,'finish.artifacts.publish',()=>options.workspace!.publishCommandArtifacts(id,outcome.changes!));
        row=save(old,{...row,execution:{...row.execution,artifacts:artifacts.map(f=>({fileId:f.fileId,version:f.version})),changes:{state:'verified',manifestVersion:outcome.changes.manifestVersion,count:outcome.changes.files.length+outcome.changes.deleted.length,acceptance:'not_requested'}}});old=row;
        const confirmed=await attempt(id,'finish.artifacts.confirm',()=>options.workspace!.confirmCommandArtifacts(id,outcome.changes!.manifestVersion));
        check(id,'finish.artifacts.confirm',()=>{if(confirmed.length!==artifacts.length||confirmed.some((f,i)=>f.confirmation!=='confirmed'||f.fileId!==artifacts[i]!.fileId||f.version!==artifacts[i]!.version))throw new CommandError('CONFLICT');});
        row={...row,execution:{...row.execution,phase:'terminal',completedAt:new Date(now()).toISOString()}};
        }
        }catch(error){
          // Cancellation revokes workspace mutation, not the driver's already verified
          // process/cleanup receipt. Keep the receipt without adopting file changes.
          if(!(error instanceof CommandError&&error.code==='CANCELLED'&&row.execution.stopRequested&&outcome.cleanup.state==='confirmed'&&outcome.job.emptyConfirmed))throw error;
          row={...row,execution:{...row.execution,phase:'terminal',completedAt:new Date(now()).toISOString(),changes:{state:'unavailable',manifestVersion:null,count:null,acceptance:'not_requested'},error:row.execution.error??{code:'RESULT_ADOPTION_CANCELLED',stage:'run',nativeCode:null}}};
        }
      }
      check(id,'finish.persist',()=>save(old,row));
    });
  }
  async function launch(initial:CommandRecord,baseline:WorkCycleBaseline,driver:CommandDriver):Promise<void>{
    const id=initial.execution.executionId;
    try{
      await update(id,row=>({...row,execution:{...row.execution,phase:'starting'}}));
      const handle=await attempt(id,'driver.start',()=>driver.start(get(id),baseline,{
        diagnostic:(input,error)=>{try{options.diagnostics?.append({runId:options.runId,workspaceId:options.workspaceId,executionId:id,...options.diagnosticContext,...input},error);}catch{}},
        started:(time,runtime)=>attempt(id,'callback.started',()=>update(id,row=>{if(runtime!==undefined&&!isCommandRuntime(runtime))throw new CommandError('CONFLICT');const next:CommandRecord={...row,execution:{...row.execution,phase:row.execution.exit?'settling':'running',startedAt:time,...(runtime?{runtime}: {})}};assertCommandRuntime(next,next.execution.runtime);return next;})),
        shellExit:exit=>attempt(id,'callback.exit',()=>update(id,row=>({...row,execution:{...row.execution,phase:'settling',exit}}))),
        job:job=>attempt(id,'callback.job',()=>update(id,row=>({...row,execution:{...row.execution,job}}))),
        log:async(stream,bytes)=>attempt(id,'callback.log',async()=>{let limited=false;await update(id,row=>{const next=appendCommandLog(repository,row,stream,bytes);limited=next.limited;return next.record;});if(limited)await requestStop(id,'log_limit');}),
      }));
      handles.set(id,handle);
      if(storageFailed)handle.stop('storage_failure');else{const stop=get(id).execution.stopRequested;if(stop)handle.stop(stop.reason);}
      const outcome=await attempt(id,'driver.wait',()=>handle.done);
      if(!storageFailed)await finish(id,outcome);
    }catch(e){
      report(id,'driver.wait',e);
      if(e instanceof CommandPreparationError&&!storageFailed){const time=new Date(now()).toISOString();await finish(id,{exit:{shellExitCode:null,shellExited:false,observedAt:time,termination:'failed_start'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:e.proofSha256},eof:{stdout:true,stderr:true},logSha256:{stdout:commandDigest(''),stderr:commandDigest('')},error:{code:e.detailCode,stage:'prepare',nativeCode:null}});return;}
      if(!storageFailed)try{await update(id,row=>({...row,execution:{...row.execution,phase:'reconciliation_required',error:row.execution.error??{code:'DRIVER_EVIDENCE_FAILED',stage:'run',nativeCode:null}}}));}catch(error){report(id,'record.save',error,'cleanup');poison();}
      try{handles.get(id)?.stop('storage_failure');}catch(error){report(id,'driver.stop',error,'cleanup');/* Never infer Job zero from a failed control call. */}
    }finally{const timer=deadlines.get(id);if(timer)clearTimer(timer);deadlines.delete(id);handles.delete(id);notify(id);}
  }
  async function status(args:CommandToolArguments['command_status']):Promise<CommandExecution>{
    if(!parseCommandArguments('command_status',args))throw new CommandError('INVALID_REQUEST');
    const e=get(args.executionId).execution;
    if(args.afterRevision!==null&&args.afterRevision>e.revision)throw new CommandError('CONFLICT');
    if(args.waitMs===0||args.afterRevision===null||e.revision>args.afterRevision||e.phase==='terminal'||e.phase==='reconciliation_required')return result(args.executionId);
    await new Promise<void>(resolve=>{let timer:Timer|undefined;const wake=():void=>{if(timer)clearTimer(timer);const group=listeners.get(args.executionId);group?.delete(wake);if(!group?.size)listeners.delete(args.executionId);resolve();};const group=listeners.get(args.executionId)??new Set();group.add(wake);listeners.set(args.executionId,group);timer=setTimer(wake,args.waitMs);});
    return result(args.executionId);
  }
  return {
    async inspect(){const environments=[...drivers.values()].map(d=>structuredClone(d.environment));if(closing||options.readOnly)return {environments,workspace:null};const baseline=await options.exportBaseline();if(baseline.runId!==options.runId||baseline.workspaceId!==options.workspaceId)throw new CommandError('CONFLICT');return {environments,workspace:{workspaceId:baseline.workspaceId,baselineVersion:baseline.version,files:baseline.files.length,bytes:baseline.files.reduce((n,f)=>n+f.bytes.byteLength,0)}};},
    list(){if(storageFailed)throw new CommandError('STORAGE_FAILED');return [...rows.values()].map(row=>structuredClone(row.execution));},
    start(args){return enqueue(async()=>{writable();if(!parseCommandArguments('command_start',args))throw new CommandError('INVALID_REQUEST');const existing=[...rows.values()].find(r=>r.execution.requestId===args.requestId);if(existing){if(existing.execution.signature!==commandRequestSignature(options.runId,args))throw new CommandError('CONFLICT');return structuredClone(existing.execution);}
      if(closing)throw new CommandError('CANCELLED');if([...rows.values()].some(r=>commandOutstanding(r.execution)))throw new CommandError('BUSY');if(rows.size>=L.executions)throw new CommandError('BUDGET_EXCEEDED');
      const driver=drivers.get(args.environmentId);if(!driver||driver.environment.availability!=='ready')throw new CommandError('CAPABILITY_DENIED');
      const baseline=await options.exportBaseline();if(closing)throw new CommandError('CANCELLED');const row=createCommandRecord(options.runId,args,driver.environment,baseline,now());
      try{repository.create(row);}catch(e){report(row.execution.executionId,'record.create',e);poison();throw e;}rows.set(row.execution.executionId,row);
      const timer=setTimer(()=>{void requestStop(row.execution.executionId,'deadline').catch(()=>{});},args.timeoutMs);deadlines.set(row.execution.executionId,timer);
      const job=launch(row,baseline,driver);jobs.add(job);void job.finally(()=>jobs.delete(job));return structuredClone(row.execution);
    });},
    status,
    log(args){return readCommandLog(repository,get(args.executionId),args);},
    stop(id,reason='user'){return requestStop(id,reason);},
    idle(){return !storageFailed&&![...rows.values()].some(r=>commandOutstanding(r.execution));},
    async close(reason){closing=true;const outstanding=[...rows.values()].filter(r=>commandOutstanding(r.execution));const hadOutstanding=outstanding.length>0;
      if(!options.readOnly)await Promise.all(outstanding.filter(r=>r.execution.phase!=='reconciliation_required').map(r=>requestStop(r.execution.executionId,reason).catch(()=>{})));
      if(jobs.size){let timer:Timer|undefined;await Promise.race([Promise.all([...jobs]),new Promise<void>(resolve=>{timer=setTimer(resolve,L.cleanupMs);})]);if(timer)clearTimer(timer);}
      const cleanupConfirmed=!storageFailed&&![...rows.values()].some(r=>commandOutstanding(r.execution));
      if(!cleanupConfirmed)for(const row of rows.values())if(commandOutstanding(row.execution))report(row.execution.executionId,'controller.close',new CommandError('CLEANUP_FAILED'),'cleanup');
      if(!jobs.size)repository.close();return {hadOutstanding,cleanupConfirmed};
    },
  };
}
