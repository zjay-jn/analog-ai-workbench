import type { CommandExecution, CommandStream } from '../../shared/agent/agent-command';
import { commandInteger, commandSha } from '../../shared/agent/agent-command-validation';
import { WORK_CYCLE_LIMITS as W, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { CommandError, type CommandRecord } from './types';
import { commandDigest } from './logs';

export type NativeManifestEntry=Readonly<{relativePath:string;bytes:number;sha256:string}>;
export const nativeManifest=(entries:readonly NativeManifestEntry[]):NativeManifestEntry[]=>[...entries].sort((a,b)=>a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0).map(e=>({relativePath:e.relativePath,bytes:e.bytes,sha256:e.sha256}));
export const nativeManifestSha=(entries:readonly NativeManifestEntry[]):string=>commandDigest(JSON.stringify(nativeManifest(entries)));
export type NativeCommandLog=Readonly<{observedBytes:number;persistedBytes:number;eof:boolean;sha256:string|null;coverage:'open'|'complete'|'partial_at_limit'|'incomplete'}>;
export type NativeCommandStatus=Readonly<{
  seq:number;startedAt:string|null;shellExit:CommandExecution['exit'];job:CommandExecution['job'];logs:Readonly<Record<CommandStream,NativeCommandLog>>;stopReason:string|null;
}>;
export type NativeCommandResult=NativeCommandStatus&Readonly<{
  cleanup:CommandExecution['cleanup'];jobClosed:boolean;profileDeleted:boolean;aclRestored:boolean;error:CommandExecution['error'];workManifest:readonly NativeManifestEntry[];workManifestSha256:string|null;
}>;
const bad=():never=>{throw new CommandError('ENGINE_FAILED');};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype?v as Record<string,unknown>:bad();
const time=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)&&Number.isFinite(Date.parse(v));
const enumeration=(v:unknown,values:readonly string[]):boolean=>typeof v==='string'&&values.includes(v);
function bound(value:unknown,kind:'ready'|'status'|'result',record:CommandRecord,manifestSha:string):Record<string,unknown>{
  const v=object(value),e=record.execution;
  if(v.schema!==`aaw.command.native.${kind}.v1`||v.executionId!==e.executionId||v.signature!==e.signature||v.nonce!==record.intent.nonce||v.environmentRevision!==e.environment.revision||v.commandSha256!==e.commandSha256||v.scriptSha256!==e.scriptSha256||v.baselineVersion!==e.baselineVersion||v.baselineManifestSha256!==manifestSha)return bad();return v;
}
export function parseNativeReady(value:unknown,record:CommandRecord,manifestSha:string):Readonly<{pid:number;created:string;startedAt:string}> {
  const v=bound(value,'ready',record,manifestSha);
  if(!commandInteger(v.pid,1,4294967295)||typeof v.creationTime100ns!=='string'||!/^\d{1,24}$/u.test(v.creationTime100ns)||v.appContainer!==true||v.capabilityCount!==0||v.lowIntegrity!==true||v.atomicJob!==true||!time(v.startedAt))return bad();
  return {pid:v.pid,created:v.creationTime100ns,startedAt:v.startedAt};
}
function status(v:Record<string,unknown>,record:CommandRecord):NativeCommandStatus{
  if(record.intent.environment.platform!=='windows')return bad();
  if(!commandInteger(v.seq,1)||v.startedAt!==null&&!time(v.startedAt)||v.stopReason!==null&&(typeof v.stopReason!=='string'||!/^[a-z_]{1,64}$/u.test(v.stopReason)))return bad();
  if(v.shellExit!==null){const e=object(v.shellExit);if(typeof e.shellExited!=='boolean'||e.shellExitCode!==null&&!commandInteger(e.shellExitCode,-4294967295,4294967295)||!time(e.observedAt)||!enumeration(e.termination,['exited','failed_start','stopped','timed_out','log_limit','fault'])||e.shellExitCode!==null&&!e.shellExited)return bad();}
  const job=object(v.job);if(job.activeProcesses!==null&&!commandInteger(job.activeProcesses,0,record.intent.environment.limits.processes)||typeof job.emptyConfirmed!=='boolean'||job.observedAt!==null&&!time(job.observedAt)||job.emptyConfirmed&&(job.activeProcesses!==0||!time(job.observedAt)))return bad();
  const logs=object(v.logs);let total=0;
  for(const stream of ['stdout','stderr']){const l=object(logs[stream]);if(!commandInteger(l.persistedBytes,0,record.intent.environment.limits.logBytes)||!commandInteger(l.observedBytes,Number(l.persistedBytes))||typeof l.eof!=='boolean'||l.sha256!==null&&!commandSha(l.sha256)||!enumeration(l.coverage,['open','complete','partial_at_limit','incomplete'])||l.coverage==='complete'&&(!l.eof||l.observedBytes!==l.persistedBytes||!commandSha(l.sha256)))return bad();total+=l.persistedBytes;}
  if(total>record.intent.environment.limits.logBytes)return bad();
  return {seq:v.seq,startedAt:v.startedAt as string|null,shellExit:v.shellExit as CommandExecution['exit'],job:job as CommandExecution['job'],logs:logs as NativeCommandStatus['logs'],stopReason:v.stopReason as string|null};
}
export function parseNativeStatus(value:unknown,record:CommandRecord,manifestSha:string):NativeCommandStatus{return status(bound(value,'status',record,manifestSha),record);}
export function parseNativeResult(value:unknown,record:CommandRecord,manifestSha:string):NativeCommandResult{
  const v=bound(value,'result',record,manifestSha),state=status(v,record),cleanup=object(v.cleanup);
  if(!enumeration(cleanup.state,['pending','confirmed','failed'])||cleanup.observedAt!==null&&!time(cleanup.observedAt)||cleanup.proofSha256!==null&&!commandSha(cleanup.proofSha256)||typeof v.jobClosed!=='boolean'||typeof v.profileDeleted!=='boolean'||typeof v.aclRestored!=='boolean'||cleanup.state==='confirmed'&&(!state.job.emptyConfirmed||!v.jobClosed||!v.profileDeleted||!v.aclRestored))return bad();
  if(v.error!==null){const e=object(v.error);if(typeof e.code!=='string'||!/^[A-Z0-9_]{1,64}$/u.test(e.code)||!enumeration(e.stage,['prepare','start','run','log','cleanup','recovery'])||e.nativeCode!==null&&!commandInteger(e.nativeCode,-4294967295,4294967295))return bad();}
  if(!Array.isArray(v.workManifest)||v.workManifest.length>W.files||v.workManifestSha256!==null&&!commandSha(v.workManifestSha256))return bad();const manifest:NativeManifestEntry[]=[],seen=new Set<string>();let bytes=0;
  for(const input of v.workManifest){const f=object(input);if(!isWorkCycleRelativePath(f.relativePath)||!commandInteger(f.bytes,0,W.fileBytes)||!commandSha(f.sha256)||seen.has(f.relativePath.toLowerCase()))return bad();seen.add(f.relativePath.toLowerCase());bytes+=f.bytes;manifest.push({relativePath:f.relativePath,bytes:f.bytes,sha256:f.sha256});}
  if(bytes>W.workspaceBytes||v.workManifestSha256!==null&&nativeManifestSha(manifest)!==v.workManifestSha256)return bad();
  return {...state,cleanup:cleanup as CommandExecution['cleanup'],jobClosed:v.jobClosed,profileDeleted:v.profileDeleted,aclRestored:v.aclRestored,error:v.error as CommandExecution['error'],workManifest:nativeManifest(manifest),workManifestSha256:v.workManifestSha256};
}
