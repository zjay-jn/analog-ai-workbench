import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { CommandDriverProfile } from './windows-driver';
import type { CommandDriver, CommandRecord } from './types';
import { CommandError } from './types';
import { validateCommandRecord } from './state';
import { COMMAND_LIMITS as L } from '../../shared/agent/agent-command';
import { WORK_CYCLE_LIMITS as W } from '../../shared/agent/agent-work-cycle';
import { nativeManifestSha, parseNativeResult } from './native-protocol';
import { nativeDigest, nativePinned, nativeRead, prepareNativeDirectory, type NativeFilePin } from './native-files';
import { recoverWindowsPreparation } from './windows-preparation';

export const recoverWindowsCommand: (profile:CommandDriverProfile,record:CommandRecord)=>ReturnType<NonNullable<CommandDriver['recover']>>=async(profile,record)=>{
  const preparation=recoverWindowsPreparation(record);if(preparation){const time=preparation.observedAt;return {logs:{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)},outcome:{exit:{shellExitCode:null,shellExited:false,observedAt:time,termination:'failed_start'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:preparation.proofSha256},eof:{stdout:true,stderr:true},logSha256:{stdout:nativeDigest(Buffer.alloc(0)),stderr:nativeDigest(Buffer.alloc(0))},error:{code:preparation.code,stage:'prepare',nativeCode:null},changes:null}};}
  nativePinned(profile.native,4*1024*1024);nativePinned(profile.proof,L.recordBytes);nativePinned(profile.bootstrap,65536);
  if(!isDeepStrictEqual(profile.environment,record.intent.environment))return null;
  const directory=prepareNativeDirectory(record.execution.executionId,true);
  const manifest=record.intent.baseline.map(f=>({relativePath:f.relativePath,bytes:f.bytes,sha256:f.version})),manifestSha=nativeManifestSha(manifest);
  const intentBytes=nativeRead(directory.target('control/intent.json'),L.recordBytes),intent=JSON.parse(intentBytes.toString('utf8'));validateCommandRecord(intent.record);
  if(!isDeepStrictEqual(intent.record.intent,record.intent)||intent.record.execution.signature!==record.execution.signature||intent.baselineManifestSha256!==manifestSha||!isDeepStrictEqual(intent.native,profile.native)||!isDeepStrictEqual(intent.bootstrap,profile.bootstrap)||!isDeepStrictEqual(intent.proof,profile.proof)||!Array.isArray(intent.runtime)||intent.runtime.length!==4)throw new CommandError('CONFLICT');
  const expected=[['node.exe',profile.node],['LICENSE',profile.license],['bootstrap.ps1',profile.bootstrap],['command.ps1',{bytes:Buffer.byteLength(record.execution.commandText)+3,sha256:record.execution.scriptSha256}]] as const;
  const pins:NativeFilePin[]=expected.map(([name,p])=>({path:directory.target('runtime/'+name),bytes:p.bytes,sha256:p.sha256}));if(!isDeepStrictEqual(pins,intent.runtime))throw new CommandError('CONFLICT');
  let raw:Buffer;try{raw=nativeRead(directory.target('control/result.json'),L.recordBytes);}catch(e){if(e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT')return null;throw e;}
  const result=parseNativeResult(JSON.parse(raw.toString('utf8')),record,manifestSha);if(result.cleanup.state!=='confirmed'||!result.job.emptyConfirmed||!result.jobClosed||!result.profileDeleted||!result.aclRestored||!result.shellExit)return null;
  for(const f of manifest){const b=nativeRead(directory.target('baseline/'+f.relativePath),W.fileBytes);if(b.length!==f.bytes||nativeDigest(b)!==f.sha256)throw new CommandError('SOURCE_CHANGED');}
  const logs={stdout:nativeRead(directory.target('control/stdout.bin'),L.logBytes),stderr:nativeRead(directory.target('control/stderr.bin'),L.logBytes)};
  for(const stream of ['stdout','stderr'] as const){const l=result.logs[stream];if(logs[stream].length!==l.persistedBytes||l.sha256!==null&&nativeDigest(logs[stream])!==l.sha256)throw new CommandError('SOURCE_CHANGED');}
  if(!directory.disposeRuntime(pins))return null;
  const observedAt=new Date().toISOString(),proof=directory.write('control/recovery-'+randomUUID()+'.json',Buffer.from(JSON.stringify({schema:'aaw.command.recovery.v1',executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,nativeResultSha256:nativeDigest(raw),intentSha256:nativeDigest(intentBytes),verifiedAt:observedAt,runtimeDisposed:true,programsStarted:0,artifactsAdopted:0,logs:{stdout:nativeDigest(logs.stdout),stderr:nativeDigest(logs.stderr)}})));
  return {logs,outcome:{exit:result.shellExit,job:result.job,cleanup:{state:'confirmed',observedAt,proofSha256:proof.sha256},eof:{stdout:result.logs.stdout.eof,stderr:result.logs.stderr.eof},logSha256:{stdout:result.logs.stdout.coverage==='complete'?nativeDigest(logs.stdout):null,stderr:result.logs.stderr.coverage==='complete'?nativeDigest(logs.stderr):null},logMetadata:result.logs,error:result.error,changes:null}};
};
