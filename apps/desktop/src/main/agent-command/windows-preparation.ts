import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { COMMAND_LIMITS as L } from '../../shared/agent/agent-command';
import { WORK_CYCLE_LIMITS as W, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { inspectProjectFolderPath } from '../cloud/project-folder-files';
import type { WorkCycleBaseline } from '../agent-work-cycle/types';
import type { CommandDriverProfile } from './windows-driver';
import { CommandError, CommandPreparationError, type CommandRecord } from './types';
import { checkCommandPreparation } from './preparation';
import { commandSignature } from './logs';
import { nativeManifest, nativeManifestSha, type NativeManifestEntry } from './native-protocol';
import { COMMAND_PRODUCT, nativeDigest, nativePinned, nativeRead, prepareNativeDirectory, type NativeFilePin } from './native-files';

type Directory=ReturnType<typeof prepareNativeDirectory>;
const failurePath='control/preparation-failed.json';
const errorCode=(e:unknown):string=>e instanceof CommandError?e.code:'PREPARATION_FAILED';
function allowedFiles(record:CommandRecord):Map<string,number>{return new Map([
  ['baseline-manifest.json',L.recordBytes],['control/intent.json',L.recordBytes],
  ['runtime/node.exe',128*1024*1024],['runtime/LICENSE',1024*1024],['runtime/bootstrap.ps1',65536],['runtime/command.ps1',L.commandBytes+3],
  ...record.intent.baseline.flatMap(f=>[['baseline/'+f.relativePath,W.fileBytes],['work/'+f.relativePath,W.fileBytes]] as [string,number][]),
]);}
/** Account for every actual preparation object, including a short write. Keep bytes as evidence. */
function inventory(directory:Directory,record:CommandRecord){
  const allowed=allowedFiles(record),dirs=new Set(['control','runtime','baseline','work','home','temp']);
  for(const name of allowed.keys()){const parts=name.split('/');parts.pop();while(parts.length){dirs.add(parts.join('/'));parts.pop();}}
  const files:NativeFilePin[]=[],directories:string[]=[];let count=0;
  function walk(relative:string):void{directory.check();const current=relative?directory.target(relative):directory.root;inspectProjectFolderPath(current,true);const entries=fs.opendirSync(current);try{let entry:fs.Dirent|null;while((entry=entries.readSync())!==null){if(++count>W.files*2*W.pathDepth+32)throw new CommandError('BUDGET_EXCEEDED');const name=relative?relative+'/'+entry.name:entry.name;if(name===failurePath)continue;if(entry.isDirectory()&&dirs.has(name)){directories.push(name);walk(name);}else{const limit=allowed.get(name);if(limit===undefined||!entry.isFile()||entry.isSymbolicLink())throw new CommandError('SOURCE_CHANGED');const bytes=nativeRead(directory.target(name),limit);files.push({path:directory.target(name),bytes:bytes.length,sha256:nativeDigest(bytes)});}}}finally{entries.closeSync();}}
  walk('');directory.check();files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);directories.sort();return {files,directories};
}
function retainedFailure(directory:Directory,record:CommandRecord,code:string):CommandPreparationError{
  directory.directory('control');const resources=inventory(directory,record);
  const proof=directory.write(failurePath,Buffer.from(JSON.stringify({schema:'aaw.command.preparation-failed.v1',executionId:record.execution.executionId,signature:record.execution.signature,intent:record.intent,code,observedAt:new Date().toISOString(),nativeAttempted:false,processesCreated:0,jobCreated:false,profileCreated:false,resourceDisposition:'retained_unexecuted',resources})));
  return new CommandPreparationError(code,proof.sha256);
}
/** Synchronous, strictly before spawn. This module cannot create a process or native capability. */
export function prepareWindowsCommand(profile:CommandDriverProfile,record:CommandRecord,baseline:WorkCycleBaseline,now:()=>number=Date.now){
  let directory:Directory|undefined,allocationAttempted=false;
  try{
    if(profile.environment.platform!=='windows'||record.intent.environment.platform!=='windows'||record.execution.environment.environmentId!==profile.environment.environmentId||record.execution.environment.revision!==profile.environment.revision||!isDeepStrictEqual(record.intent.environment,profile.environment)||baseline.runId!==record.execution.runId||baseline.workspaceId!==record.execution.workspaceId||baseline.version!==record.execution.baselineVersion)throw new CommandError('CONFLICT');
    const volume=fs.statfsSync(COMMAND_PRODUCT,{bigint:true});checkCommandPreparation(record,profile.node.bytes+profile.license.bytes+profile.bootstrap.bytes+Buffer.byteLength(record.execution.commandText)+3,volume.bavail*volume.bsize,now());
    const entries:NativeManifestEntry[]=[];
    for(const file of baseline.files){if(!isWorkCycleRelativePath(file.file.relativePath)||file.bytes.byteLength!==file.file.bytes||nativeDigest(file.bytes)!==file.file.version)throw new CommandError('SOURCE_CHANGED');entries.push({relativePath:file.file.relativePath,bytes:file.bytes.byteLength,sha256:file.file.version});}
    if(!isDeepStrictEqual(record.intent.baseline,baseline.files.map(({file})=>({fileId:file.fileId,relativePath:file.relativePath,version:file.version,bytes:file.bytes}))))throw new CommandError('CONFLICT');
    const manifest=nativeManifest(entries),manifestSha=nativeManifestSha(manifest),runtimePins:NativeFilePin[]=[];
    allocationAttempted=true;directory=prepareNativeDirectory(record.execution.executionId);
    for(const name of ['control','runtime','baseline','work','home','temp'])directory.directory(name);
    for(const file of baseline.files){directory.write('baseline/'+file.file.relativePath,file.bytes);directory.write('work/'+file.file.relativePath,file.bytes);}
    directory.write('baseline-manifest.json',Buffer.from(JSON.stringify(manifest)));
    for(const [name,pin] of [['node.exe',profile.node],['LICENSE',profile.license],['bootstrap.ps1',profile.bootstrap]] as const)runtimePins.push(directory.write('runtime/'+name,nativePinned(pin)));
    const script=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(record.execution.commandText)]);if(nativeDigest(script)!==record.execution.scriptSha256)throw new CommandError('CONFLICT');runtimePins.push(directory.write('runtime/command.ps1',script));
    inspectProjectFolderPath(record.execution.cwdRelativePath?directory.target('work/'+record.execution.cwdRelativePath):directory.target('work'),true);
    directory.write('control/intent.json',Buffer.from(JSON.stringify({schema:'aaw.command.driver.intent.v1',record,native:profile.native,bootstrap:profile.bootstrap,proof:profile.proof,baselineManifestSha256:manifestSha,runtime:runtimePins})));
    nativePinned(profile.native,4*1024*1024);nativePinned(profile.proof,L.recordBytes);directory.check();
    const remaining=Date.parse(record.execution.deadlineAt)-now();if(remaining<=0)throw new CommandPreparationError('PREPARATION_DEADLINE','');
    return {directory,runtimePins,manifest,manifestSha,remaining};
  }catch(e){
    if(directory)throw retainedFailure(directory,record,e instanceof CommandPreparationError?e.detailCode:errorCode(e));
    if(e instanceof CommandPreparationError)throw e;
    if(!allocationAttempted)throw new CommandPreparationError(errorCode(e),commandSignature({schema:'aaw.command.no-process.v1',executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,code:errorCode(e),nativeAttempted:false,resourcesCreated:false}));
    throw e;
  }
}
/** A persisted pre-spawn refusal is independent of later native/profile file availability. */
export function recoverWindowsPreparation(record:CommandRecord):Readonly<{code:string;proofSha256:string;observedAt:string}>|null{
  let directory:Directory,bytes:Buffer;try{directory=prepareNativeDirectory(record.execution.executionId,true);bytes=nativeRead(directory.target(failurePath),L.recordBytes);}catch(e){if(e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT')return null;throw e;}
  const p=JSON.parse(bytes.toString('utf8'));
  if(p.schema!=='aaw.command.preparation-failed.v1'||p.executionId!==record.execution.executionId||p.signature!==record.execution.signature||!isDeepStrictEqual(p.intent,record.intent)||p.nativeAttempted!==false||p.processesCreated!==0||p.jobCreated!==false||p.profileCreated!==false||p.resourceDisposition!=='retained_unexecuted'||typeof p.code!=='string'||!/^[A-Z_]{1,64}$/u.test(p.code)||typeof p.observedAt!=='string'||!Number.isFinite(Date.parse(p.observedAt))||!isDeepStrictEqual(p.resources,inventory(directory,record)))throw new CommandError('SOURCE_CHANGED');
  return {code:p.code,observedAt:p.observedAt,proofSha256:nativeDigest(bytes)};
}
