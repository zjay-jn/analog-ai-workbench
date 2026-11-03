import { isDeepStrictEqual } from 'node:util';
import { COMMAND_LIMITS as L } from '../../shared/agent/agent-command';
import { CommandError, type CommandDriver, type CommandRecord, type CommandRepository } from './types';
import { commandOutstanding } from './state';
import { appendCommandLog, commandDigest, sealCommandLog } from './logs';
import type {CommandDiagnosticJournal} from './diagnostics';
import type {CommandDiagnosticInput,CommandDiagnosticOperation} from '../../shared/agent/command-diagnostics';

/** Called only with a reconciliation writer. Old tool events remain untouched; no artifacts are adopted. */
export async function reconcileCommandRecords(repository:CommandRepository,drivers:readonly CommandDriver[],diagnostics?:CommandDiagnosticJournal):Promise<boolean>{
  if(!repository.recover)throw new CommandError('CAPABILITY_DENIED');
  for(const previous of repository.load()){
    if(!commandOutstanding(previous.execution))continue;
    let operation:CommandDiagnosticOperation='recovery.read';
    try{
    const driver=drivers.find(d=>d.environment.environmentId===previous.execution.environment.environmentId&&d.environment.revision===previous.execution.environment.revision);
    if(!driver?.recover)continue;const proof=await driver.recover(previous);if(!proof||proof.outcome.cleanup.state!=='confirmed'||!proof.outcome.job.emptyConfirmed)continue;
    operation='recovery.validate';
    const old=previous.execution.exit,actual=proof.outcome.exit;if(old?.shellExited&&(!actual.shellExited||actual.shellExitCode!==old.shellExitCode))throw new CommandError('CONFLICT');
    let committed:CommandRecord=previous,candidate:CommandRecord=previous;
    const facts={exit:{...actual,observedAt:old?.shellExited?old.observedAt:actual.observedAt},job:proof.outcome.job,cleanup:proof.outcome.cleanup,...(proof.outcome.artifactCollection?{artifactCollection:proof.outcome.artifactCollection}:{})};
    // At most one new chunk is uncommitted if recovery itself is interrupted.
    const checkpoint=():void=>{candidate={...candidate,execution:{...candidate.execution,...facts,revision:committed.execution.revision+1,phase:'reconciliation_required',completedAt:null}};operation='recovery.persist';repository.recover!(committed,candidate);committed=repository.load().find(r=>r.execution.executionId===previous.execution.executionId)!;candidate=committed;operation='recovery.validate';};
    // Verify every already-published byte before writing any recovered suffix.
    for(const stream of ['stdout','stderr'] as const){const raw=proof.logs[stream];if(!(raw instanceof Uint8Array)||raw.byteLength>L.logBytes||raw.byteLength<previous.execution.logs[stream].persistedBytes)throw new CommandError('SOURCE_CHANGED');for(const chunk of previous.chunks[stream])if(commandDigest(raw.slice(chunk.offset,chunk.offset+chunk.bytes))!==chunk.sha256||!Buffer.from(repository.readChunk(previous.execution.executionId,chunk)).equals(raw.slice(chunk.offset,chunk.offset+chunk.bytes)))throw new CommandError('SOURCE_CHANGED');}
    for(const stream of ['stdout','stderr'] as const){const saved=candidate.execution.logs[stream],raw=proof.logs[stream],native=proof.outcome.logMetadata?.[stream];
      candidate={...candidate,execution:{...candidate.execution,logs:{...candidate.execution.logs,[stream]:{...saved,closed:false,sha256:null,coverage:saved.coverage==='partial_at_limit'?'partial_at_limit':'open'}}}};
      for(let offset=saved.persistedBytes;offset<raw.length;offset+=L.logChunkBytes){candidate=appendCommandLog(repository,candidate,stream,raw.slice(offset,offset+L.logChunkBytes)).record;checkpoint();}
      if(candidate.execution.logs[stream].persistedBytes!==raw.length)throw new CommandError('BUDGET_EXCEEDED');
      const observed=candidate.execution.logs[stream];candidate={...candidate,execution:{...candidate.execution,logs:{...candidate.execution.logs,[stream]:{...observed,observedBytes:Math.max(observed.observedBytes,native?.observedBytes??raw.length),coverage:native?.coverage==='partial_at_limit'?'partial_at_limit':observed.coverage}}}};
      candidate=sealCommandLog(repository,candidate,stream,proof.outcome.eof[stream],native&&native.coverage!=='complete'?null:proof.outcome.logSha256[stream]);
    }
    const verifiedAt=new Date().toISOString();candidate={...candidate,execution:{...candidate.execution,...facts,revision:committed.execution.revision+1,phase:'terminal',completedAt:verifiedAt,changes:previous.execution.artifacts.length?previous.execution.changes:{state:'unavailable',manifestVersion:null,count:null,acceptance:'not_requested'},error:previous.execution.error??proof.outcome.error??{code:'RECOVERED_CONTROLLER_LOSS',stage:'recovery',nativeCode:null}}};
    operation='recovery.persist';repository.recover(committed,candidate);
    }catch(error){try{const e=previous.execution;diagnostics?.append({runId:e.runId,workspaceId:e.workspaceId,executionId:e.executionId,component:'recovery',operation,kind:'cleanup'},error);}catch{}throw error;}
  }
  return !repository.load().some(r=>commandOutstanding(r.execution));
}
