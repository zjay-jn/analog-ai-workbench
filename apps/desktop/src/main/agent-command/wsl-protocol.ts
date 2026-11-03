import { createHash } from 'node:crypto';
import { COMMAND_LIMITS as L, type CommandExecution } from '../../shared/agent/agent-command';
import { WORK_CYCLE_LIMITS as W, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { commandObject, commandProcessCount, commandSha } from '../../shared/agent/agent-command-validation';
import { CommandError, type CommandRecord, type CommandProducedChanges } from './types';
import { commandChangesVersion, validateCommandChanges } from './changes';

export const wslDigest=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex');
export type WslIdentity=Readonly<{executionId:string;signature:string;nonce:string;environmentRevision:string;baselineVersion:string;scriptSha256:string}>;
export function wslIdentity(record:CommandRecord):WslIdentity{return {executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,environmentRevision:record.execution.environment.revision,baselineVersion:record.execution.baselineVersion,scriptSha256:record.execution.scriptSha256};}
export function wslIdentityMatches(value:unknown,record:CommandRecord):boolean{return commandObject(value,['executionId','signature','nonce','environmentRevision','baselineVersion','scriptSha256'])&&Object.entries(wslIdentity(record)).every(([k,v])=>value[k]===v);}
export type WslLog=Readonly<{observedBytes:number;persistedBytes:number;sha256:string;eof:boolean;coverage:'complete'|'partial_at_limit'|'incomplete'}>;
export type WslProcessObservation=Readonly<{policy:'observe_only'|'terminate_above_limit';limit:number|null;peakProcesses:number|null;samples:number}>;
export type WslCleanupProof=Readonly<{method:'not_spawned'|'prestart_children_reaped'|'namespace_empty'|'unconfirmed';spawnAttempted:boolean;childReaped:boolean;subreaperEmpty:boolean;gateOpened:boolean}>;
export type WslTerminal=Readonly<{
  schema:'aaw.command.wsl.result.v1';identity:WslIdentity;startedAt:string|null;completedAt:string;
  exit:NonNullable<CommandExecution['exit']>;job:CommandExecution['job'];cleanupConfirmed:boolean;
  logs:Readonly<{stdout:WslLog;stderr:WslLog}>;error:CommandExecution['error'];
  lifecycle:Readonly<{supervisorPid:number;supervisorStartTicks:string;namespacePid:number|null;namespaceStartTicks:string|null;namespaceInode:string|null;namespaceProcessesRemaining:number|null;namespaceInitReaped:boolean;processObservation?:WslProcessObservation;cleanupProof?:WslCleanupProof}>;
  exported:readonly Readonly<{relativePath:string;version:string;bytes:number}>[];deleted:readonly Readonly<{relativePath:string;beforeVersion:string}>[];skippedFiles:number;
}>;
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)&&Number.isFinite(Date.parse(v));
export function parseWslTerminal(value:unknown,record:CommandRecord):WslTerminal{
  if(record.intent.environment.platform!=='wsl')throw new CommandError('SOURCE_CHANGED');
  const processLimit=record.intent.environment.limits.processes;
  if(!commandObject(value,['schema','identity','startedAt','completedAt','exit','job','cleanupConfirmed','logs','error','lifecycle','exported','deleted','skippedFiles'])||value.schema!=='aaw.command.wsl.result.v1'||!wslIdentityMatches(value.identity,record)||value.startedAt!==null&&!date(value.startedAt)||!date(value.completedAt)||typeof value.cleanupConfirmed!=='boolean')throw new CommandError('SOURCE_CHANGED');
  const x=value.exit,j=value.job,l=value.logs,p=value.lifecycle;
  if(!commandObject(x,['shellExitCode','shellExited','observedAt','termination'])||x.shellExitCode!==null&&!integer(x.shellExitCode,-2147483648,2147483647)||typeof x.shellExited!=='boolean'||!date(x.observedAt)||!['exited','failed_start','stopped','timed_out','log_limit','fault'].includes(String(x.termination))||!commandObject(j,['activeProcesses','emptyConfirmed','observedAt'])||j.activeProcesses!==null&&!commandProcessCount(j.activeProcesses,processLimit)||typeof j.emptyConfirmed!=='boolean'||!date(j.observedAt))throw new CommandError('SOURCE_CHANGED');
  if(!commandObject(l,['stdout','stderr']))throw new CommandError('SOURCE_CHANGED');
  for(const s of ['stdout','stderr']){const a=l[s];if(!commandObject(a,['observedBytes','persistedBytes','sha256','eof','coverage'])||!integer(a.observedBytes)||!integer(a.persistedBytes,0,Math.min(Number(a.observedBytes),L.logBytes))||!commandSha(a.sha256)||typeof a.eof!=='boolean'||!['complete','partial_at_limit','incomplete'].includes(String(a.coverage))||a.coverage==='complete'&&(!a.eof||a.observedBytes!==a.persistedBytes))throw new CommandError('SOURCE_CHANGED');}
  const hasObservation=!!p&&typeof p==='object'&&Object.hasOwn(p,'processObservation');
  const hasProof=!!p&&typeof p==='object'&&Object.hasOwn(p,'cleanupProof');
  if(!commandObject(p,['supervisorPid','supervisorStartTicks','namespacePid','namespaceStartTicks','namespaceInode','namespaceProcessesRemaining','namespaceInitReaped',...(hasObservation?['processObservation']:[]),...(hasProof?['cleanupProof']:[])])||!integer(p.supervisorPid,1)||typeof p.supervisorStartTicks!=='string'||!/^\d+$/u.test(p.supervisorStartTicks)||p.namespacePid!==null&&!integer(p.namespacePid,1)||p.namespaceStartTicks!==null&&(typeof p.namespaceStartTicks!=='string'||!/^\d+$/u.test(p.namespaceStartTicks))||p.namespaceInode!==null&&(typeof p.namespaceInode!=='string'||!/^pid:\[\d+\]$/u.test(p.namespaceInode))||p.namespaceProcessesRemaining!==null&&!integer(p.namespaceProcessesRemaining)||typeof p.namespaceInitReaped!=='boolean')throw new CommandError('SOURCE_CHANGED');
  if(processLimit===null&&!hasObservation)throw new CommandError('SOURCE_CHANGED');
  if(hasObservation){const o=p.processObservation;if(!commandObject(o,['policy','limit','peakProcesses','samples'])||o.limit!==processLimit||o.policy!==(processLimit===null?'observe_only':'terminate_above_limit')||!integer(o.samples)||o.peakProcesses!==null&&!integer(o.peakProcesses)||(o.samples===0)!==(o.peakProcesses===null))throw new CommandError('SOURCE_CHANGED');}
  if(x.shellExitCode!==null&&!x.shellExited||j.emptyConfirmed&&j.activeProcesses!==0)throw new CommandError('SOURCE_CHANGED');
  let prestartProof=false;
  if(hasProof){
    const proof=p.cleanupProof;
    if(!commandObject(proof,['method','spawnAttempted','childReaped','subreaperEmpty','gateOpened'])||!['not_spawned','prestart_children_reaped','namespace_empty','unconfirmed'].includes(String(proof.method))||['spawnAttempted','childReaped','subreaperEmpty','gateOpened'].some(k=>typeof proof[k]!=='boolean')||proof.childReaped&&!proof.spawnAttempted||proof.gateOpened&&(!proof.spawnAttempted||value.startedAt===null)||(proof.method==='unconfirmed')===value.cleanupConfirmed)throw new CommandError('SOURCE_CHANGED');
    if(proof.method==='not_spawned'||proof.method==='prestart_children_reaped'){
      prestartProof=true;
      if(!proof.subreaperEmpty||proof.gateOpened||value.startedAt!==null||x.shellExited||x.shellExitCode!==null||!['stopped','timed_out','log_limit','fault','failed_start'].includes(String(x.termination))||p.namespacePid!==null||p.namespaceStartTicks!==null||p.namespaceInode!==null||p.namespaceProcessesRemaining!==null||p.namespaceInitReaped||proof.spawnAttempted!==(proof.method==='prestart_children_reaped')||proof.childReaped!==proof.spawnAttempted)throw new CommandError('SOURCE_CHANGED');
      if(proof.method==='not_spawned')for(const stream of ['stdout','stderr']){const log=l[stream] as Record<string,unknown>;if(log.observedBytes!==0||log.persistedBytes!==0||log.sha256!==wslDigest('')||!log.eof||log.coverage!=='complete')throw new CommandError('SOURCE_CHANGED');}
    }else if(proof.method==='namespace_empty'&&(!proof.spawnAttempted||!proof.childReaped||!proof.subreaperEmpty))throw new CommandError('SOURCE_CHANGED');
  }
  if(value.startedAt!==null&&(p.namespacePid===null||p.namespaceStartTicks===null||p.namespaceInode===null)||value.cleanupConfirmed&&(!j.emptyConfirmed||j.activeProcesses!==0||!prestartProof&&(!p.namespaceInitReaped||p.namespaceProcessesRemaining!==0||p.namespacePid===null||p.namespaceStartTicks===null||p.namespaceInode===null)))throw new CommandError('SOURCE_CHANGED');
  if(p.namespacePid===p.supervisorPid||Number((l.stdout as Record<string,unknown>).persistedBytes)+Number((l.stderr as Record<string,unknown>).persistedBytes)>L.logBytes)throw new CommandError('SOURCE_CHANGED');
  if(!Array.isArray(value.exported)||value.exported.length>W.artifactsPerExecution||!Array.isArray(value.deleted)||value.deleted.length>W.files||!integer(value.skippedFiles))throw new CommandError('SOURCE_CHANGED');
  for(const f of value.exported)if(!commandObject(f,['relativePath','version','bytes'])||!isWorkCycleRelativePath(f.relativePath)||!commandSha(f.version)||!integer(f.bytes,0,W.fileBytes))throw new CommandError('SOURCE_CHANGED');
  for(const f of value.deleted)if(!commandObject(f,['relativePath','beforeVersion'])||!isWorkCycleRelativePath(f.relativePath)||!commandSha(f.beforeVersion))throw new CommandError('SOURCE_CHANGED');
  const e=value.error;if(e!==null&&(!commandObject(e,['code','stage','nativeCode'])||typeof e.code!=='string'||!/^WSL_[A-Z0-9_]{1,56}$/u.test(e.code)||!['prepare','start','run','log','cleanup','recovery'].includes(String(e.stage))||e.nativeCode!==null&&!integer(e.nativeCode,-2147483648,2147483647)))throw new CommandError('SOURCE_CHANGED');
  return value as unknown as WslTerminal;
}
export function wslChanges(terminal:WslTerminal,bodies:ReadonlyMap<string,Buffer>,record:CommandRecord):CommandProducedChanges|null{
  if(!terminal.cleanupConfirmed)return null;
  if(bodies.size!==terminal.exported.length)throw new CommandError('SOURCE_CHANGED');
  const files=terminal.exported.map(f=>{const bytes=bodies.get(f.relativePath);if(!bytes||bytes.length!==f.bytes||wslDigest(bytes)!==f.version)throw new CommandError('SOURCE_CHANGED');return {relativePath:f.relativePath,beforeVersion:record.intent.baseline.find(b=>b.relativePath===f.relativePath)?.version??null,version:f.version,bytes};});
  const delta={baselineVersion:record.execution.baselineVersion,files,deleted:terminal.deleted};const changes={...delta,manifestVersion:commandChangesVersion(delta)};validateCommandChanges(changes,record.intent.baseline);return changes;
}
export function decodeWslBytes(value:unknown,max:number):Buffer{
  if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))throw new CommandError('SOURCE_CHANGED');
  const bytes=Buffer.from(value,'base64');if(bytes.length>max||bytes.toString('base64')!==value)throw new CommandError('SOURCE_CHANGED');return bytes;
}
