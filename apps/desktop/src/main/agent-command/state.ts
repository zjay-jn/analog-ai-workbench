import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { COMMAND_LIMITS as L, type CommandEnvironment, type CommandExecution, type CommandRuntime, type CommandStartArguments } from '../../shared/agent/agent-command';
import { commandObject, commandId, commandInteger, commandProcessCount, commandSha, commandJsonFits, isCommandEnvironment, isCommandExecution, parseCommandArguments } from '../../shared/agent/agent-command-validation';
import { WORK_CYCLE_LIMITS as W, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { CommandError, type CommandRecord } from './types';
import type { WorkCycleBaseline } from '../agent-work-cycle/types';
import { commandDigest, commandSignature, emptyLog, emptyPrefix, chunkPrefix } from './logs';

export function canonicalCommandArgs(a:CommandStartArguments):CommandStartArguments {
  return {requestId:a.requestId,environmentId:a.environmentId,environmentRevision:a.environmentRevision,workspaceId:a.workspaceId,baselineVersion:a.baselineVersion,cwdRelativePath:a.cwdRelativePath,commandText:a.commandText,timeoutMs:a.timeoutMs};
}
export const commandRequestSignature=(runId:string,a:CommandStartArguments):string=>commandSignature(['aaw.command.intent.v1',runId,canonicalCommandArgs(a)]);
export const commandOutstanding=(e:CommandExecution):boolean=>e.phase!=='terminal'||e.cleanup.state!=='confirmed'||!e.job.emptyConfirmed;
/** Legacy Windows bytes retain their BOM; Linux scripts are exact UTF-8 source. */
export function commandScriptBytes(environment:CommandEnvironment,source:string):Buffer {
  const bytes=Buffer.from(source,'utf8');return environment.shell.scriptEncoding==='utf8_bom'?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]):bytes;
}
export function assertCommandRuntime(record:CommandRecord,runtime:CommandRuntime|null|undefined):void {
  const environment=record.intent.environment;
  if(environment.platform==='windows'){if(runtime!=null)throw new CommandError('CONFLICT');return;}
  if(runtime==null){if(record.execution.startedAt!==null)throw new CommandError('CONFLICT');return;}
  if(record.execution.startedAt===null)throw new CommandError('CONFLICT');
  const root=environment.wsl.executionRoot+'/'+record.execution.executionId,work=root+'/work',cwd=work+(record.execution.cwdRelativePath?'/'+record.execution.cwdRelativePath:'');
  if(runtime.platform!=='wsl'||runtime.distribution!==environment.wsl.distribution||runtime.user!==environment.wsl.user||runtime.workDirectory!==work||runtime.cwd!==cwd||runtime.baselineDirectory!==null&&runtime.baselineDirectory!==root+'/baseline')throw new CommandError('CONFLICT');
}
export function createCommandRecord(runId:string,args:CommandStartArguments,environment:CommandEnvironment,baseline:WorkCycleBaseline,now:number):CommandRecord {
  if(!commandId(runId)||!parseCommandArguments('command_start',args)||!isCommandEnvironment(environment)||environment.availability!=='ready')throw new CommandError('INVALID_REQUEST');
  if(args.workspaceId!==baseline.workspaceId||runId!==baseline.runId||args.baselineVersion!==baseline.version||args.environmentId!==environment.environmentId||args.environmentRevision!==environment.revision)throw new CommandError('CONFLICT');
  if(args.timeoutMs>environment.limits.maxTimeoutMs)throw new CommandError('BUDGET_EXCEEDED');
  const a=canonicalCommandArgs(args),executionId='cmd-'+randomUUID();
  const record:CommandRecord={schema:1,intent:{nonce:randomUUID(),args:a,environment:structuredClone(environment),baseline:baseline.files.map(({file})=>({fileId:file.fileId,relativePath:file.relativePath,version:file.version,bytes:file.bytes}))},chunks:{stdout:[],stderr:[]},execution:{artifacts:[],
    executionId,runId,workspaceId:a.workspaceId,requestId:a.requestId,signature:commandRequestSignature(runId,a),environment:{environmentId:environment.environmentId,revision:environment.revision,displayName:environment.displayName},...(environment.platform==='wsl'?{runtime:null}:{}),baselineVersion:a.baselineVersion,cwdRelativePath:a.cwdRelativePath,commandText:a.commandText,commandSha256:commandDigest(a.commandText),scriptSha256:commandDigest(commandScriptBytes(environment,a.commandText)),revision:1,phase:'intent',createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+a.timeoutMs).toISOString(),startedAt:null,completedAt:null,stopRequested:null,exit:null,job:{activeProcesses:null,emptyConfirmed:false,observedAt:null},cleanup:{state:'pending',observedAt:null,proofSha256:null},logs:{stdout:emptyLog(executionId,'stdout'),stderr:emptyLog(executionId,'stderr')},changes:{state:'pending',manifestVersion:null,count:null,acceptance:'not_requested'},error:null,
  }};
  validateCommandRecord(record);return record;
}
export function validateCommandRecord(value:unknown):asserts value is CommandRecord {
  const bad=():never=>{throw new CommandError('STORAGE_FAILED');};
  if(!commandObject(value,['schema','intent','execution','chunks',...(value&&typeof value==='object'&&Object.hasOwn(value,'retainedObjects')?['retainedObjects']:[])])||value.schema!==1||!commandJsonFits(value,L.recordBytes)||!isCommandExecution(value.execution))return bad();
  const i=value.intent,e=value.execution,chunks=value.chunks;
  if(!commandObject(i,['nonce','args','environment','baseline'])||typeof i.nonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(i.nonce)||!isCommandEnvironment(i.environment))return bad();
  const a=parseCommandArguments('command_start',i.args);if(!a)return bad();
  if(a.workspaceId!==e.workspaceId||a.requestId!==e.requestId||a.environmentId!==e.environment.environmentId||a.environmentRevision!==e.environment.revision||a.baselineVersion!==e.baselineVersion||a.cwdRelativePath!==e.cwdRelativePath||a.commandText!==e.commandText||i.environment.environmentId!==a.environmentId||i.environment.revision!==a.environmentRevision||i.environment.displayName!==e.environment.displayName||a.timeoutMs>i.environment.limits.maxTimeoutMs||e.signature!==commandRequestSignature(e.runId,a)||e.commandSha256!==commandDigest(a.commandText)||e.scriptSha256!==commandDigest(commandScriptBytes(i.environment,a.commandText))||Date.parse(e.deadlineAt)-Date.parse(e.createdAt)!==a.timeoutMs)return bad();
  if(i.environment.platform==='wsl'&&!Object.hasOwn(e,'runtime'))return bad();
  try{assertCommandRuntime(value as CommandRecord,e.runtime);}catch{return bad();}
  if(e.job.activeProcesses!==null&&!commandProcessCount(e.job.activeProcesses,i.environment.limits.processes))return bad();
  if(!Array.isArray(i.baseline)||i.baseline.length>W.files)return bad();let total=0;const paths=new Set<string>(),ids=new Set<string>();
  for(const f of i.baseline){if(!commandObject(f,['fileId','relativePath','version','bytes'])||!commandId(f.fileId)||!isWorkCycleRelativePath(f.relativePath)||!commandSha(f.version)||!commandInteger(f.bytes,0,W.fileBytes)||paths.has(f.relativePath.toLowerCase())||ids.has(f.fileId))return bad();paths.add(f.relativePath.toLowerCase());ids.add(f.fileId);total+=f.bytes;}
  if(total>W.workspaceBytes||!commandObject(chunks,['stdout','stderr']))return bad();let count=0;
  const objects=new Set<string>();
  for(const stream of ['stdout','stderr'] as const){const list=chunks[stream];if(!Array.isArray(list))return bad();let offset=0,prefix=emptyPrefix(e.executionId,stream);
    for(const c of list){if(!commandObject(c,['object','offset','bytes','sha256','prefixVersion'])||typeof c.object!=='string'||!/^chunk-[a-f0-9-]{36}\.bin$/u.test(c.object)||objects.has(c.object)||c.offset!==offset||!commandInteger(c.bytes,1,L.logChunkBytes)||!commandSha(c.sha256)||!commandSha(c.prefixVersion))return bad();objects.add(c.object);prefix=chunkPrefix(prefix,{offset,bytes:c.bytes,sha256:c.sha256});if(c.prefixVersion!==prefix)return bad();offset+=c.bytes;count++;}
    if(e.logs[stream].persistedBytes!==offset||e.logs[stream].prefixVersion!==prefix)return bad();
  }
  if(count>L.logRecords||e.logs.stdout.persistedBytes+e.logs.stderr.persistedBytes>i.environment.limits.logBytes)return bad();
  if(value.retainedObjects!==undefined){if(!Array.isArray(value.retainedObjects)||value.retainedObjects.length>16)return bad();for(const item of value.retainedObjects){if(!commandObject(item,['object','bytes','sha256'])||typeof item.object!=='string'||!/^(?:chunk-[a-f0-9-]{36}\.bin|state-[a-f0-9-]{36}\.tmp)$/u.test(item.object)||objects.has(item.object)||!commandInteger(item.bytes,0,L.recordBytes)||!commandSha(item.sha256))return bad();objects.add(item.object);}}
}
export function assertCommandTransition(previous:CommandRecord,next:CommandRecord):void {
  validateCommandRecord(next);
  if(!isDeepStrictEqual(previous.intent,next.intent)||previous.execution.executionId!==next.execution.executionId||previous.execution.runId!==next.execution.runId||next.execution.revision!==previous.execution.revision+1)throw new CommandError('CONFLICT');
  if(previous.execution.phase==='terminal'||previous.execution.phase==='reconciliation_required')throw new CommandError('CONFLICT');
  if(previous.execution.stopRequested&&!isDeepStrictEqual(previous.execution.stopRequested,next.execution.stopRequested))throw new CommandError('CONFLICT');
  if(previous.execution.runtime&&!isDeepStrictEqual(previous.execution.runtime,next.execution.runtime))throw new CommandError('CONFLICT');
  if(previous.execution.artifactCollection&&!isDeepStrictEqual(previous.execution.artifactCollection,next.execution.artifactCollection))throw new CommandError('CONFLICT');
  const beforeExit=previous.execution.exit,afterExit=next.execution.exit;
  if(beforeExit?.shellExited&&(!afterExit?.shellExited||beforeExit.shellExitCode!==afterExit.shellExitCode||beforeExit.observedAt!==afterExit.observedAt))throw new CommandError('CONFLICT');
  if(previous.execution.job.emptyConfirmed&&!next.execution.job.emptyConfirmed)throw new CommandError('CONFLICT');
  for(const s of ['stdout','stderr'] as const){if(next.chunks[s].length<previous.chunks[s].length||!isDeepStrictEqual(previous.chunks[s],next.chunks[s].slice(0,previous.chunks[s].length))||next.execution.logs[s].observedBytes<previous.execution.logs[s].observedBytes||previous.execution.logs[s].closed&&!isDeepStrictEqual(previous.execution.logs[s],next.execution.logs[s]))throw new CommandError('CONFLICT');}
}
export function assertCommandRecovery(previous:CommandRecord,next:CommandRecord):void{
  validateCommandRecord(next);
  if(!isDeepStrictEqual(previous.intent,next.intent)||previous.execution.executionId!==next.execution.executionId||previous.execution.runId!==next.execution.runId||next.execution.revision!==previous.execution.revision+1||!['terminal','reconciliation_required'].includes(next.execution.phase)||next.execution.cleanup.state!=='confirmed'||!next.execution.job.emptyConfirmed||!isDeepStrictEqual(previous.execution.stopRequested,next.execution.stopRequested)||!isDeepStrictEqual(previous.execution.artifacts,next.execution.artifacts))throw new CommandError('CONFLICT');
  const old=previous.execution.exit;if(old?.shellExited&&(!next.execution.exit?.shellExited||old.shellExitCode!==next.execution.exit.shellExitCode||old.observedAt!==next.execution.exit.observedAt))throw new CommandError('CONFLICT');
  if(!isDeepStrictEqual(previous.execution.runtime,next.execution.runtime))throw new CommandError('CONFLICT');
  if(previous.execution.artifactCollection&&!isDeepStrictEqual(previous.execution.artifactCollection,next.execution.artifactCollection))throw new CommandError('CONFLICT');
  for(const stream of ['stdout','stderr'] as const)if(!isDeepStrictEqual(previous.chunks[stream],next.chunks[stream].slice(0,previous.chunks[stream].length))||next.execution.logs[stream].observedBytes<previous.execution.logs[stream].observedBytes)throw new CommandError('CONFLICT');
}
