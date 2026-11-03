import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { COMMAND_LIMITS as L, type CommandEnvironment, type CommandStartArguments, type CommandStopReason } from '../apps/desktop/src/shared/agent/agent-command';
import { isCommandExecution, isCommandLogPage, parseCommandArguments } from '../apps/desktop/src/shared/agent/agent-command-validation';
import { fileNameAllowed } from '../apps/desktop/src/shared/agent/file-context';
import { createCommandController } from '../apps/desktop/src/main/agent-command/controller';
import { createCommandRepository } from '../apps/desktop/src/main/agent-command/store';
import { assertCommandRecovery, assertCommandTransition, createCommandRecord } from '../apps/desktop/src/main/agent-command/state';
import { commandDigest } from '../apps/desktop/src/main/agent-command/logs';
import { CommandError, CommandPreparationError, type CommandRecord, type CommandRepository, type CommandChunk, type CommandDriver, type CommandDriverOutcome } from '../apps/desktop/src/main/agent-command/types';
import type { WorkCycleBaseline } from '../apps/desktop/src/main/agent-work-cycle/types';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { commandChangesVersion } from '../apps/desktop/src/main/agent-command/changes';
import { checkCommandPreparation, commandPreparationReserve } from '../apps/desktop/src/main/agent-command/preparation';
import { reconcileCommandRecords } from '../apps/desktop/src/main/agent-command/recovery';
import { nativeManifestSha, parseNativeResult } from '../apps/desktop/src/main/agent-command/native-protocol';
import { prepareWindowsCommand, recoverWindowsPreparation } from '../apps/desktop/src/main/agent-command/windows-preparation';
import { recoverWindowsCommand } from '../apps/desktop/src/main/agent-command/windows-recovery';
import { COMMAND_EXECUTIONS, nativeReadStatus, prepareNativeDirectory, type NativeFilePin } from '../apps/desktop/src/main/agent-command/native-files';
import { createWindowsCommandDriver, type CommandDriverProfile } from '../apps/desktop/src/main/agent-command/windows-driver';

const sha=commandDigest('synthetic identity'),empty=commandDigest('');
const environment:CommandEnvironment={environmentId:'synthetic-powershell',revision:sha,displayName:'Synthetic driver; no process',platform:'windows',shell:{kind:'powershell',version:'synthetic',sha256:sha,scriptEncoding:'utf8_bom',interactive:false},tools:[{name:'node',version:'synthetic',sha256:sha}],isolation:'windows-appcontainer-job',profileRevision:sha,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:L.logBytes,defaultTimeoutMs:L.defaultTimeoutMs,maxTimeoutMs:L.maxTimeoutMs}};
const baseline:WorkCycleBaseline={runId:'command-run',workspaceId:'command-workspace',version:sha,files:[]};
const args=(requestId=randomUUID()):CommandStartArguments=>({requestId,environmentId:environment.environmentId,environmentRevision:sha,workspaceId:baseline.workspaceId,baselineVersion:sha,cwdRelativePath:'',commandText:'Write-Output "合成"',timeoutMs:120000});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
class MemoryRepository implements CommandRepository {
  rows:CommandRecord[]=[];chunks=new Map<string,Uint8Array>();failSave=false;closed=false;
  load(){return structuredClone(this.rows);}
  create(r:CommandRecord){this.rows.push(structuredClone(r));}
  save(p:CommandRecord,n:CommandRecord){if(this.failSave)throw new CommandError('STORAGE_FAILED');assertCommandTransition(p,n);const i=this.rows.findIndex(r=>r.execution.executionId===p.execution.executionId);assert.deepEqual(this.rows[i],p);this.rows[i]=structuredClone(n);}
  recover(p:CommandRecord,n:CommandRecord){assertCommandRecovery(p,n);const i=this.rows.findIndex(r=>r.execution.executionId===p.execution.executionId);assert.deepEqual(this.rows[i],p);this.rows[i]=structuredClone(n);}
  writeChunk(_id:string,b:Uint8Array){const object='chunk-'+randomUUID()+'.bin';this.chunks.set(object,b.slice());return object;}
  readChunk(_id:string,c:CommandChunk){const b=this.chunks.get(c.object)!;assert.equal(commandDigest(b),c.sha256);return b.slice();}
  close(){this.closed=true;}
}
function fixture(repo:CommandRepository=new MemoryRepository(),env:CommandEnvironment=environment){
  const finished=deferred<CommandDriverOutcome>(),ready=deferred<void>();let callbacks!:Parameters<CommandDriver['start']>[2],starts=0,autoStop=false;
  const stops:CommandStopReason[]=[],raw={stdout:[] as Buffer[],stderr:[] as Buffer[]};
  const driver:CommandDriver={environment:env,async start(record,base,cb){starts++;assert.ok(repo.load().some(r=>r.execution.signature===record.execution.signature),'durable intent exists before driver');assert.deepEqual(base,baseline);callbacks=cb;await cb.started(new Date().toISOString());ready.resolve();return {stop(reason){stops.push(reason);if(autoStop)finish('stopped');},done:finished.promise};}};
  const controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository:repo,drivers:[driver],exportBaseline:async()=>baseline});
  function finish(termination:CommandDriverOutcome['exit']['termination']='exited',eof=true,overrides:Partial<CommandDriverOutcome>={}){const time=new Date().toISOString();finished.resolve({exit:{shellExitCode:0,shellExited:true,observedAt:time,termination},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},eof:{stdout:eof,stderr:eof},logSha256:{stdout:commandDigest(Buffer.concat(raw.stdout)),stderr:commandDigest(Buffer.concat(raw.stderr))},error:null,...overrides});}
  return {controller,repo,driver,ready:ready.promise,stops,get starts(){return starts;},get callbacks(){return callbacks;},async log(stream:'stdout'|'stderr',bytes:Uint8Array){raw[stream].push(Buffer.from(bytes));await callbacks.log(stream,bytes);},finish,autoStop(){autoStop=true;}};
}
function decode(p:ReturnType<ReturnType<typeof fixture>['controller']['log']>):Buffer{return p.format==='base64'?Buffer.from(p.data,'base64'):Buffer.from(p.data);}
const fails=(code:string)=>(e:unknown)=>e instanceof CommandError&&e.code===code;

test('command wire limits retain shell source and explicitly readable ps1 without granting launch',()=>{
  assert.ok(parseCommandArguments('command_start',args()));assert.equal(parseCommandArguments('command_start',{...args(),argv:['-Command']}),null);
  assert.equal(parseCommandArguments('command_start',{...args(),cwdRelativePath:'../outside'}),null);
  assert.equal(parseCommandArguments('command_start',{...args(),commandText:'a\u0000b'}),null);
  assert.equal(parseCommandArguments('command_start',{...args(),commandText:'中'.repeat(2731)}),null);
  assert.equal(parseCommandArguments('command_status',{executionId:'id',afterRevision:null,waitMs:25001}),null);
  assert.equal(fileNameAllowed('pipeline.ps1'),true);assert.equal(fileNameAllowed('credentials.ps1'),false);
});

test('durable intent, concurrent dedup, bounded wait and separate stop/exit/job observations',async()=>{
  const f=fixture(),a=args();const [first,duplicate]=await Promise.all([f.controller.start(a),f.controller.start({...a})]);assert.equal(first.executionId,duplicate.executionId);assert.ok(isCommandExecution(first));await f.ready;assert.equal(f.starts,1);
  await assert.rejects(f.controller.start({...a,commandText:'different'}),fails('CONFLICT'));
  await assert.rejects(f.controller.start(args()),fails('BUSY'));
  const running=await f.controller.status({executionId:first.executionId,afterRevision:null,waitMs:0});let woke=false;
  const waiting=f.controller.status({executionId:first.executionId,afterRevision:running.revision,waitMs:25000}).then(v=>{woke=true;return v;});await turn();assert.equal(woke,false);
  const stopped=await f.controller.stop(first.executionId);assert.equal(stopped.stopRequested?.reason,'user');assert.equal(stopped.exit,null);assert.equal(stopped.job.emptyConfirmed,false);assert.ok((await waiting).revision>running.revision);
  const time=new Date().toISOString();await f.callbacks.shellExit({shellExitCode:0,shellExited:true,observedAt:time,termination:'exited'});assert.equal(f.controller.idle(),false);
  const middle=f.controller.list()[0]!;assert.equal(middle.phase,'settling');assert.equal(middle.cleanup.state,'pending');
  f.finish('stopped');await turn();assert.equal(f.controller.list()[0]!.cleanup.state,'confirmed');assert.equal(f.controller.idle(),true);assert.equal(f.starts,1);await f.controller.close('shutdown');
});

test('raw byte prefixes remain stable across appends, escaped JSON pages shrink and EOF requires proof',async()=>{
  const f=fixture(),e=await f.controller.start(args());await f.ready;
  const original=Buffer.from('中间日志\r\n');await f.log('stdout',original);
  const old=f.controller.log({executionId:e.executionId,stream:'stdout',offset:0,maxBytes:2,expectedPrefixVersion:null});assert.equal(old.format,'base64');assert.deepEqual(decode(old),original.subarray(0,2));assert.ok(isCommandLogPage(old));
  await f.log('stdout',Buffer.from([0xff,0x00,0x22]));
  const tail=f.controller.log({executionId:e.executionId,stream:'stdout',offset:2,maxBytes:16384,expectedPrefixVersion:old.prefixVersion});assert.deepEqual(decode(tail),original.subarray(2));assert.equal(tail.nextCursor,null);assert.equal(tail.hasNewerBytes,true);assert.equal(tail.streamClosed,false);
  const newest=f.controller.log({executionId:e.executionId,stream:'stdout',offset:original.length,maxBytes:16384,expectedPrefixVersion:null});assert.deepEqual(decode(newest),Buffer.from([0xff,0x00,0x22]));
  await f.log('stderr',Buffer.alloc(16384,0));const escaped=f.controller.log({executionId:e.executionId,stream:'stderr',offset:0,maxBytes:16384,expectedPrefixVersion:null});assert.ok(escaped.endOffset<16384);assert.ok(Buffer.byteLength(JSON.stringify(escaped))<24576);assert.ok(isCommandLogPage(escaped));
  f.finish('exited',false);await turn();const done=f.controller.list()[0]!;assert.equal(done.exit?.shellExitCode,0);assert.equal(done.logs.stdout.coverage,'incomplete');assert.equal(done.error?.code,'LOG_INCOMPLETE');await f.controller.close('shutdown');
});

test('log byte cap requests stop without inventing complete logs; storage failure never publishes a cursor',async()=>{
  const limited=fixture(undefined,{...environment,limits:{...environment.limits,logBytes:1024}}),e=await limited.controller.start(args());await limited.ready;await limited.log('stdout',Buffer.alloc(4096,65));
  assert.ok(limited.stops.includes('log_limit'));const row=limited.controller.list()[0]!;assert.equal(row.logs.stdout.persistedBytes,1024);assert.equal(row.logs.stdout.observedBytes,4096);assert.equal(row.logs.stdout.coverage,'partial_at_limit');assert.equal(row.cleanup.state,'pending');limited.finish('log_limit');await turn();await limited.controller.close('shutdown');
  const repo=new MemoryRepository(),f=fixture(repo),started=await f.controller.start(args());await f.ready;repo.failSave=true;
  await assert.rejects(f.log('stdout',Buffer.from('unpublished')),fails('STORAGE_FAILED'));assert.throws(()=>f.controller.log({executionId:started.executionId,stream:'stdout',offset:0,maxBytes:1,expectedPrefixVersion:null}),fails('STORAGE_FAILED'));assert.ok(f.stops.includes('storage_failure'));assert.equal(repo.rows[0]!.execution.logs.stdout.persistedBytes,0);f.finish('fault');await turn();assert.equal((await f.controller.close('shutdown')).cleanupConfirmed,false);
});

test('model final reports outstanding work even after stop cleanup; reopened active intent never launches',async()=>{
  const f=fixture(),e=await f.controller.start(args());await f.ready;f.autoStop();const closure=await f.controller.close('model_finished');assert.deepEqual(closure,{hadOutstanding:true,cleanupConfirmed:true});assert.equal(f.controller.list()[0]!.stopRequested?.reason,'model_finished');
  const repo=new MemoryRepository(),source=fixture(repo),a=args();await source.controller.start(a);await source.ready;
  const reopened=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository:repo,drivers:[source.driver],exportBaseline:async()=>baseline,readOnly:true});assert.equal(reopened.list()[0]!.phase,'reconciliation_required');assert.equal(source.starts,1);assert.equal(reopened.idle(),false);await assert.rejects(reopened.start(args()),fails('CAPABILITY_DENIED'));await reopened.close('shutdown');source.finish();await turn();await source.controller.close('shutdown');
});

test('real repository persists exact binary logs and cold read performs zero driver calls; tampering fails closed',async()=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID()),directory=path.join(base,'agent-command','runs',baseline.runId);
  fs.mkdirSync(base,{recursive:true});
  try{
    const repository=createCommandRepository({directory,runId:baseline.runId,readOnly:false}),f=fixture(repository),e=await f.controller.start(args());await f.ready;
    const raw=Buffer.from([0,1,2,255,13,10]);await f.log('stdout',raw);f.finish();await turn();const version=f.controller.list()[0]!.logs.stdout.prefixVersion;await f.controller.close('shutdown');
    const cold=createCommandRepository({directory,runId:baseline.runId,readOnly:true}),reopened=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository:cold,drivers:[f.driver],exportBaseline:async()=>{throw Error('history touched workspace');},readOnly:true});
    assert.equal(reopened.list()[0]!.phase,'terminal');const p=reopened.log({executionId:e.executionId,stream:'stdout',offset:0,maxBytes:16384,expectedPrefixVersion:version});assert.deepEqual(decode(p),raw);assert.equal(p.coverage,'complete');assert.equal(p.streamClosed,true);assert.equal(f.starts,1);
    const chunk=cold.load()[0]!.chunks.stdout[0]!;fs.writeFileSync(path.join(directory,e.executionId,chunk.object),Buffer.from('tampered'));assert.throws(()=>reopened.log({executionId:e.executionId,stream:'stdout',offset:0,maxBytes:1,expectedPrefixVersion:version}));await reopened.close('shutdown');
    assert.throws(()=>createCommandRepository({directory,runId:baseline.runId,readOnly:true}));
  }finally{const absolute=fs.realpathSync.native(base),relative=path.relative(parent,absolute);assert.equal(absolute,base);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(absolute,{recursive:true});}
});

test('published OS exit cannot be rewritten by terminal driver evidence',async()=>{
  const f=fixture(),e=await f.controller.start(args());await f.ready;const observedAt=new Date().toISOString();
  await f.callbacks.shellExit({shellExitCode:7,shellExited:true,observedAt,termination:'exited'});f.finish();await turn();
  const result=f.controller.list()[0]!;assert.equal(result.phase,'reconciliation_required');assert.equal(result.exit?.shellExitCode,7);assert.equal(result.exit?.observedAt,observedAt);assert.equal(f.controller.idle(),false);await f.controller.close('shutdown');
});

test('cold storage rejects a false sealed digest and orphan bytes without deleting either',async()=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID()),directory=path.join(base,'agent-command','runs',baseline.runId);fs.mkdirSync(base,{recursive:true});
  try{const repo=createCommandRepository({directory,runId:baseline.runId,readOnly:false}),f=fixture(repo),e=await f.controller.start(args());await f.ready;await f.log('stdout',Buffer.from('full original log'));f.finish();await turn();await f.controller.close('shutdown');
    const manifest=path.join(directory,e.executionId,'execution.json'),original=fs.readFileSync(manifest),record=JSON.parse(original.toString());record.execution.logs.stdout.sha256=empty;fs.writeFileSync(manifest,JSON.stringify(record));
    assert.throws(()=>createCommandRepository({directory,runId:baseline.runId,readOnly:true}),fails('STORAGE_FAILED'));fs.writeFileSync(manifest,original);
    const orphan=path.join(directory,e.executionId,'chunk-'+randomUUID()+'.bin');fs.writeFileSync(orphan,'uncommitted tail');assert.throws(()=>createCommandRepository({directory,runId:baseline.runId,readOnly:true}),fails('STORAGE_FAILED'));assert.equal(fs.readFileSync(orphan,'utf8'),'uncommitted tail');
  }finally{const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});

test('command output publication is versioned readonly evidence and exact work_edit is the only logical change',async()=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID()),directory=path.join(base,'agent-work-cycle','workspaces',baseline.workspaceId);fs.mkdirSync(base,{recursive:true});const abort=new AbortController();
  const workspace=await createWorkCycleWorkspace({directory,runId:baseline.runId,workspaceId:baseline.workspaceId,readOnly:false,signal:abort.signal});
  try{const script=await workspace.write('initial',{relativePath:'pipeline.ps1',expectedVersion:null,text:'Write-Output 19\r\n'});await workspace.confirm('initial');const before=await workspace.exportConfirmedBase();
    const files=[{relativePath:'pipeline.ps1',beforeVersion:script.file.version,version:commandDigest('Write-Output 42\r\n'),bytes:Buffer.from('Write-Output 42\r\n')},{relativePath:'nested/level two/report.json',beforeVersion:null,version:commandDigest('{"answer":42}'),bytes:Buffer.from('{"answer":42}')}];
    const raw={baselineVersion:before.version,files,deleted:[]},changes={...raw,manifestVersion:commandChangesVersion(raw)},executionId='cmd-'+randomUUID();
    const artifacts=await workspace.publishCommandArtifacts(executionId,changes);assert.equal(artifacts.length,2);assert.equal(artifacts[0]!.confirmation,'unconfirmed');await assert.rejects(workspace.exportConfirmedBase(),fails('CONFLICT'));
    const confirmed=await workspace.confirmCommandArtifacts(executionId,changes.manifestVersion);assert.ok(confirmed.every(f=>f.confirmation==='confirmed'&&f.origin.kind==='command'));assert.equal(workspace.read(script.file.fileId,script.file.version).text,'Write-Output 19\r\n');
    assert.equal(workspace.read(confirmed[1]!.fileId,confirmed[1]!.version).text,'{"answer":42}');assert.equal(confirmed[1]!.origin.kind==='command'&&confirmed[1]!.origin.sourceRelativePath,'nested/level two/report.json');
    assert.deepEqual(await workspace.publishCommandArtifacts(executionId,changes),confirmed);await assert.rejects(workspace.edit('readonly',{fileId:confirmed[0]!.fileId,expectedVersion:confirmed[0]!.version,oldText:'19',newText:'42'}),fails('UNSUPPORTED_PATH'));
    const edit=await workspace.edit('accept-change',{fileId:script.file.fileId,expectedVersion:script.file.version,oldText:'19',newText:'42'});await workspace.confirm('accept-change');assert.equal(workspace.read(edit.file.fileId,edit.file.version).text,'Write-Output 42\r\n');await workspace.exportConfirmedBase();
    await workspace.close();const cold=await createWorkCycleWorkspace({directory,runId:baseline.runId,workspaceId:baseline.workspaceId,readOnly:true,signal:abort.signal});try{assert.equal(cold.list().length,3);assert.equal(cold.read(confirmed[1]!.fileId,confirmed[1]!.version).text,'{"answer":42}');await cold.exportConfirmedBase();}finally{await cold.close();}
  }finally{await workspace.close();const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});

test('space and cwd preparation refusal prove zero native attempts and release the command slot',async()=>{
  const repo=new MemoryRepository();let nativeAttempts=0;
  const driver:CommandDriver={environment,async start(record){checkCommandPreparation(record,100000000,0n,Date.now());nativeAttempts++;throw Error('unreachable');}};
  const controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository:repo,drivers:[driver],exportBaseline:async()=>baseline});await controller.start(args());await turn();
  const failed=controller.list()[0]!;assert.equal(failed.phase,'terminal');assert.equal(failed.exit?.termination,'failed_start');assert.equal(failed.exit?.shellExited,false);assert.equal(failed.error?.code,'INSUFFICIENT_DISK_SPACE');assert.equal(failed.cleanup.state,'confirmed');assert.equal(controller.idle(),true);assert.equal(nativeAttempts,0);
  const cwd=createCommandRecord(baseline.runId,{...args(),cwdRelativePath:'missing'},environment,baseline,Date.now());assert.throws(()=>checkCommandPreparation(cwd,100000000,commandPreparationReserve(100000000),Date.now()),e=>typeof e==='object'&&e!==null&&'detailCode' in e&&e.detailCode==='CWD_UNAVAILABLE');await controller.close('shutdown');
});

test('native failure without a work snapshot still preserves exact cleanup and partial raw-log facts',()=>{
  const record=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now()),time=new Date().toISOString(),manifestSha=nativeManifestSha([]);
  const native={schema:'aaw.command.native.result.v1',executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,environmentRevision:sha,commandSha256:record.execution.commandSha256,scriptSha256:record.execution.scriptSha256,baselineVersion:sha,baselineManifestSha256:manifestSha,seq:2,startedAt:null,shellExit:{shellExitCode:null,shellExited:false,observedAt:time,termination:'failed_start'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},logs:{stdout:{observedBytes:0,persistedBytes:0,eof:false,sha256:empty,coverage:'incomplete'},stderr:{observedBytes:9,persistedBytes:4,eof:true,sha256:commandDigest('part'),coverage:'partial_at_limit'}},stopReason:null,cleanup:{state:'confirmed',observedAt:time,proofSha256:null},jobClosed:true,profileDeleted:true,aclRestored:true,error:{code:'NATIVE_FAILURE',stage:'prepare',nativeCode:5},workManifest:[],workManifestSha256:null};
  const parsed=parseNativeResult(native,record,manifestSha);assert.equal(parsed.cleanup.state,'confirmed');assert.equal(parsed.workManifestSha256,null);assert.equal(parsed.logs.stderr.coverage,'partial_at_limit');assert.equal(parsed.logs.stderr.observedBytes,9);assert.throws(()=>parseNativeResult({...native,signature:empty},record,manifestSha));
});

test('reconciliation appends only a verified old log suffix and never replays a process or adopts files',async()=>{
  const repo=new MemoryRepository(),row=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now());repo.create(row);let starts=0,recoveries=0;const raw=Buffer.from('native complete tail'),time=new Date().toISOString();
  const driver:CommandDriver={environment,async start(){starts++;throw Error('no replay');},async recover(){recoveries++;return {logs:{stdout:raw,stderr:Buffer.alloc(0)},outcome:{exit:{shellExitCode:125,shellExited:true,observedAt:time,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},eof:{stdout:true,stderr:true},logSha256:{stdout:commandDigest(raw),stderr:empty},error:null}};}};
  assert.equal(await reconcileCommandRecords(repo,[driver]),true);assert.equal(repo.rows[0]!.execution.phase,'terminal');assert.equal(repo.rows[0]!.execution.logs.stdout.coverage,'complete');assert.deepEqual(repo.rows[0]!.execution.artifacts,[]);assert.equal(repo.rows[0]!.execution.changes.state,'unavailable');assert.equal(await reconcileCommandRecords(repo,[driver]),true);assert.equal(recoveries,1);assert.equal(starts,0);
});

test('reconciled disk retains orphan objects explicitly and reopens as verified history',async()=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID()),directory=path.join(base,'agent-command','runs',baseline.runId);fs.mkdirSync(base,{recursive:true});
  try{const row=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now()),original=createCommandRepository({directory,runId:baseline.runId,readOnly:false});original.create(row);const orphan=original.writeChunk(row.execution.executionId,Buffer.from('uncertain old write'));original.close();const repo=createCommandRepository({directory,runId:baseline.runId,readOnly:false,reconcile:true}),time=new Date().toISOString(),raw=Buffer.from('authoritative raw log');
    const driver:CommandDriver={environment,async start(){throw Error('no spawn');},async recover(){return {logs:{stdout:raw,stderr:Buffer.alloc(0)},outcome:{exit:{shellExitCode:125,shellExited:true,observedAt:time,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},eof:{stdout:true,stderr:true},logSha256:{stdout:commandDigest(raw),stderr:empty},error:null}};}};
    assert.equal(await reconcileCommandRecords(repo,[driver]),true);assert.equal(repo.load()[0]!.retainedObjects?.[0]!.object,orphan);repo.close();const cold=createCommandRepository({directory,runId:baseline.runId,readOnly:true});assert.equal(cold.load()[0]!.execution.cleanup.state,'confirmed');assert.equal(fs.readFileSync(path.join(directory,row.execution.executionId,orphan),'utf8'),'uncertain old write');cold.close();
  }finally{const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});

test('post-copy preparation failures retain audited resources, terminate zero-spawn and recover without native receipts',async()=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID());fs.mkdirSync(base,{recursive:true});const executionRoots:string[]=[];
  try{
    const pin=(name:string):NativeFilePin=>{const file=path.join(base,name),bytes=Buffer.from('synthetic inert '+name);fs.writeFileSync(file,bytes);return {path:file,bytes:bytes.length,sha256:commandDigest(bytes)};};
    const profile:CommandDriverProfile={environment,native:pin('native.txt'),node:pin('node.txt'),license:pin('license.txt'),bootstrap:pin('bootstrap.txt'),proof:pin('proof.txt')};
    for(const cause of ['deadline','changed_pin'] as const){
      const repo=new MemoryRepository();let attempts=0,ticks=0,caught:unknown;
      const chosen=cause==='changed_pin'?{...profile,native:{...profile.native,sha256:empty}}:profile;
      const driver:CommandDriver={environment,async start(row,b){executionRoots.push(path.join(COMMAND_EXECUTIONS,row.execution.executionId));try{prepareWindowsCommand(chosen,row,b,()=>++ticks===1?Date.parse(row.execution.createdAt):Date.parse(row.execution.deadlineAt));}catch(e){caught=e;throw e;}attempts++;throw Error('must not spawn');}};
      const controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository:repo,drivers:[driver],exportBaseline:async()=>baseline});await controller.start(args());await turn();
      const row=repo.load()[0]!,e=controller.list()[0]!;assert.ok(caught instanceof CommandPreparationError,String(caught instanceof Error?caught.stack:caught));assert.equal(attempts,0);assert.equal(e.phase,'terminal');assert.equal(e.exit?.termination,'failed_start');assert.equal(e.cleanup.state,'confirmed');assert.equal(controller.idle(),true);assert.equal(e.error?.code,cause==='deadline'?'PREPARATION_DEADLINE':'SOURCE_CHANGED');
      const proof=recoverWindowsPreparation(row)!;assert.equal(proof.proofSha256,e.cleanup.proofSha256);const receipt=JSON.parse(fs.readFileSync(path.join(executionRoots.at(-1)!,'control/preparation-failed.json'),'utf8'));assert.equal(receipt.resourceDisposition,'retained_unexecuted');assert.equal(receipt.resources.files.length,6);assert.equal(receipt.nativeAttempted,false);
      const recovered=await recoverWindowsCommand(chosen,row);assert.equal(recovered?.outcome.cleanup.state,'confirmed');assert.equal(recovered?.outcome.exit.shellExited,false);assert.equal(recovered?.logs.stdout.length,0);assert.equal(fs.existsSync(path.join(executionRoots.at(-1)!,'control/result.json')),false);
      await controller.close('shutdown');
    }
  }finally{for(const root of executionRoots){const absolute=fs.realpathSync.native(root);assert.equal(absolute,root);assert.match(path.relative(COMMAND_EXECUTIONS,absolute),/^cmd-[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});

test('native observed-but-unpersisted tail stays partial while verified cleanup releases the slot',async()=>{
  const f=fixture();await f.controller.start(args());await f.ready;await f.log('stderr',Buffer.from('part'));
  f.finish('log_limit',true,{logSha256:{stdout:empty,stderr:null},logMetadata:{stdout:{observedBytes:0,persistedBytes:0,coverage:'complete'},stderr:{observedBytes:9,persistedBytes:4,coverage:'partial_at_limit'}}});await turn();const e=f.controller.list()[0]!;
  assert.equal(e.logs.stderr.persistedBytes,4);assert.equal(e.logs.stderr.observedBytes,9);assert.equal(e.logs.stderr.coverage,'partial_at_limit');assert.equal(e.logs.stderr.closed,true);assert.equal(e.cleanup.state,'confirmed');assert.equal(f.controller.idle(),true);await f.controller.close('shutdown');
});

test('recovery interrupted after its seventeenth chunk resumes from durable checkpoints without replay',async()=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID()),directory=path.join(base,'agent-command','runs',baseline.runId);fs.mkdirSync(base,{recursive:true});
  try{
    const row=createCommandRecord(baseline.runId,args(),environment,baseline,Date.now()),initial=createCommandRepository({directory,runId:baseline.runId,readOnly:false});initial.create(row);initial.close();const repo=createCommandRepository({directory,runId:baseline.runId,readOnly:false,reconcile:true});let writes=0,starts=0;
    const raw=Buffer.alloc(21*L.logChunkBytes+37);for(let i=0;i<raw.length;i++)raw[i]=(i*17)%251;const time=new Date().toISOString();
    const driver:CommandDriver={environment,async start(){starts++;throw Error('no replay');},async recover(){return {logs:{stdout:raw,stderr:Buffer.alloc(0)},outcome:{exit:{shellExitCode:125,shellExited:true,observedAt:time,termination:'stopped'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:time},cleanup:{state:'confirmed',observedAt:time,proofSha256:sha},eof:{stdout:true,stderr:true},logSha256:{stdout:commandDigest(raw),stderr:empty},error:null}};}};
    const interrupted:CommandRepository={...repo,writeChunk(id,bytes){const object=repo.writeChunk(id,bytes);if(++writes===17)throw Error('synthetic interruption after write');return object;}};
    await assert.rejects(reconcileCommandRecords(interrupted,[driver]),/synthetic interruption/u);const checkpoint=repo.load()[0]!;assert.equal(checkpoint.chunks.stdout.length,16);assert.equal(checkpoint.execution.phase,'reconciliation_required');repo.close();
    const resumed=createCommandRepository({directory,runId:baseline.runId,readOnly:false,reconcile:true});assert.equal(await reconcileCommandRecords(resumed,[driver]),true);const terminal=resumed.load()[0]!;assert.deepEqual(terminal.chunks.stdout.slice(0,16),checkpoint.chunks.stdout);assert.equal(terminal.retainedObjects?.length,1);assert.equal(terminal.execution.logs.stdout.sha256,commandDigest(raw));assert.equal(terminal.execution.logs.stdout.coverage,'complete');assert.equal(starts,0);resumed.close();
    const cold=createCommandRepository({directory,runId:baseline.runId,readOnly:true});assert.equal(cold.load()[0]!.execution.phase,'terminal');cold.close();
  }finally{const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});

test('missing native terminal receipt preserves buffered raw prefixes and reports bounded native failure',async t=>{
  const parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-command-module-tests'),base=path.join(parent,randomUUID());fs.mkdirSync(base,{recursive:true});let executionRoot:string|undefined;
  const stdout=Buffer.from('prefix before crash\n'),stderr=Buffer.from([0x64,0xff,0]);
  try{
    const pin=(name:string):NativeFilePin=>{const file=path.join(base,name),bytes=Buffer.from('synthetic inert '+name);fs.writeFileSync(file,bytes);return {path:file,bytes:bytes.length,sha256:commandDigest(bytes)};};
    const profile:CommandDriverProfile={environment,native:pin('native.txt'),node:pin('node.txt'),license:pin('license.txt'),bootstrap:pin('bootstrap.txt'),proof:pin('proof.txt')};
    let done:Promise<CommandDriverOutcome>|undefined,attempts=0;
    t.mock.method(childProcess,'spawn',(_file:string,argv:string[],options:childProcess.SpawnOptions)=>{attempts++;assert.equal(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);assert.deepEqual(options.stdio,['pipe','pipe','pipe']);assert.deepEqual(options.env,{SystemRoot:'C:\\Windows',windir:'C:\\Windows',SystemDrive:'C:'});executionRoot=argv[0]!;const record:CommandRecord=JSON.parse(fs.readFileSync(path.join(executionRoot,'control/intent.json'),'utf8')).record,time=new Date().toISOString();
      fs.writeFileSync(path.join(executionRoot,'control/stdout.bin'),stdout);fs.writeFileSync(path.join(executionRoot,'control/stderr.bin'),stderr);
      fs.writeFileSync(path.join(executionRoot,'control/status.json'),JSON.stringify({schema:'aaw.command.native.status.v1',executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,environmentRevision:record.execution.environment.revision,commandSha256:record.execution.commandSha256,scriptSha256:record.execution.scriptSha256,baselineVersion:record.execution.baselineVersion,baselineManifestSha256:nativeManifestSha([]),seq:1,startedAt:time,shellExit:null,job:{activeProcesses:1,emptyConfirmed:false,observedAt:time},logs:{stdout:{observedBytes:stdout.length,persistedBytes:stdout.length,eof:false,sha256:null,coverage:'open'},stderr:{observedBytes:5,persistedBytes:stderr.length,eof:false,sha256:null,coverage:'incomplete'}},stopReason:null}));
      const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){throw Error('no actual kill');},unref(){assert.fail('command supervisor must remain owned by main');}});setTimeout(()=>{child.stderr.write('status_create:80\r\n');child.emit('close',2);},25);return child;
    });
    const actual=createWindowsCommandDriver(profile),driver:CommandDriver={...actual,async start(...args){const handle=await actual.start(...args);done=handle.done;return handle;}};
    const repo=new MemoryRepository(),controller=createCommandController({runId:baseline.runId,workspaceId:baseline.workspaceId,repository:repo,drivers:[driver],exportBaseline:async()=>baseline});await controller.start(args());await turn();assert.ok(done);const outcome=await done;await turn();const e=controller.list()[0]!;
    assert.equal(attempts,1,'one fake transport, zero OS spawn');assert.equal(e.logs.stdout.persistedBytes,20);assert.equal(e.logs.stderr.persistedBytes,3);assert.equal(e.logs.stderr.observedBytes,5);assert.equal(e.logs.stdout.coverage,'incomplete');assert.equal(e.logs.stderr.coverage,'incomplete');assert.equal(e.cleanup.state,'failed');assert.equal(controller.idle(),false);
    for(const [stream,raw] of [['stdout',stdout],['stderr',stderr]] as const){const page=controller.log({executionId:e.executionId,stream,offset:0,maxBytes:100,expectedPrefixVersion:null});assert.deepEqual(decode(page),raw);}
    assert.deepEqual(outcome.error,{code:'NATIVE_RESULT_MISSING',stage:'cleanup',nativeCode:80});const proof=JSON.parse(fs.readFileSync(path.join(executionRoot!,'control/driver-result.json'),'utf8'));assert.equal(proof.nativeExitCode,2);assert.deepEqual(proof.nativeFailure,{stage:'status_create',code:80});assert.equal(Buffer.from(proof.diagnostics,'base64').toString(),'status_create:80\r\n');assert.equal(proof.cleanupConfirmed,false);await controller.close('shutdown');
  }finally{if(executionRoot){const absolute=fs.realpathSync.native(executionRoot);assert.equal(absolute,executionRoot);assert.match(path.relative(COMMAND_EXECUTIONS,absolute),/^cmd-[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}const absolute=fs.realpathSync.native(base);assert.equal(absolute,base);assert.match(path.relative(parent,absolute),/^[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});

test('status snapshot keeps one checked body across pathname replacement and rejects in-place mutation',t=>{
  const directory=prepareNativeDirectory('cmd-'+randomUUID()),target=directory.target('control/status.json'),replacement=directory.target('control/next.json'),original=Buffer.from('{"seq":1,"value":"original"}'),next=Buffer.from('{"seq":2,"value":"replaced"}');directory.write('control/status.json',original);directory.write('control/next.json',next);
  try{
    const realpath=fs.realpathSync.native,read=fs.readSync;let action:'replace'|'mutate'|'none'='replace';
    t.mock.method(fs.realpathSync,'native',(value:fs.PathLike)=>{assert.notEqual(path.resolve(String(value)),target,'status final leaf must not take realpath share=0');return realpath(value);});
    // Stage the old name aside to exercise an actual changed directory entry while retaining its fd.
    // This is a reader consistency test, not evidence that Windows overwrite of an open target succeeds.
    t.mock.method(fs,'readSync',(fd:number,buffer:NodeJS.ArrayBufferView,offset:number,length:number,position:number|null)=>{const got=read(fd,buffer,offset,length,position);if(action==='replace'){action='none';fs.renameSync(target,directory.target('control/previous.json'));fs.renameSync(replacement,target);}else if(action==='mutate'){action='none';fs.writeFileSync(target,original);}return got;});
    assert.deepEqual(nativeReadStatus(target,65536),original);assert.deepEqual(nativeReadStatus(target,65536),next);
    action='mutate';assert.throws(()=>nativeReadStatus(target,65536),fails('SOURCE_CHANGED'));
    assert.throws(()=>nativeReadStatus(target,4),fails('SOURCE_CHANGED'),'snapshot byte limit is checked before reading');
    const alias=directory.target('control/alias.json');fs.linkSync(target,alias);try{assert.throws(()=>nativeReadStatus(target,65536),fails('SOURCE_CHANGED'),'a hard-linked published leaf is refused');}finally{fs.unlinkSync(alias);}
    const open=fs.openSync;let replaceAtOpen=true;
    t.mock.method(fs,'openSync',(value:fs.PathLike,flags:string|number,mode?:fs.Mode)=>{if(replaceAtOpen&&path.resolve(String(value))===target){replaceAtOpen=false;fs.renameSync(target,directory.target('control/displaced-before-open.json'));fs.writeFileSync(target,original);}return open(value,flags,mode);});
    assert.throws(()=>nativeReadStatus(target,65536),fails('SOURCE_CHANGED'),'a different object opened after lstat requires retry');
    assert.deepEqual(nativeReadStatus(target,65536),original,'the next attempt reads the replacement as one whole snapshot');
    assert.throws(()=>nativeReadStatus(directory.target('control/result.json'),65536),fails('UNSUPPORTED_PATH'));
  }finally{t.mock.restoreAll();const absolute=fs.realpathSync.native(directory.root);assert.equal(absolute,directory.root);assert.match(path.relative(COMMAND_EXECUTIONS,absolute),/^cmd-[a-f0-9-]{36}$/u);fs.rmSync(absolute,{recursive:true});}
});
