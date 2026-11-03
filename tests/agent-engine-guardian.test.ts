import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { parseGuardianReady, parseGuardianResult, startEngineGuardian, verifyClosedEngineController, type EngineGuardianIdentity } from '../apps/desktop/src/main/engine-pilot/engine-guardian';
import {runtimePaths} from '../apps/desktop/src/main/runtime-paths';
const files=require('../apps/desktop/src/main/agent-command/native-files') as typeof import('../apps/desktop/src/main/agent-command/native-files');
const manifest=require('../apps/desktop/src/main/runtime-manifest') as typeof import('../apps/desktop/src/main/runtime-manifest');
const locations=runtimePaths(),root=path.join(locations.pilotRoot,'native/12345678-1234-4123-8123-123456789abc'),sha='a'.repeat(64);
const identity:EngineGuardianIdentity={binary:{path:path.join(locations.nativeRoot,'guardian.exe'),bytes:1,sha256:sha},proof:{path:path.join(locations.runtimeRoot,'runtime-manifest.json'),bytes:1,sha256:sha},engine:{path:locations.opencodeExecutable,bytes:1,sha256:sha}};
const binding={root,port:43124,guardianPid:1234,identity},guardian={pid:1234,creationTime100ns:'134000000000000000',image:identity.binary.path},engine={pid:5678,creationTime100ns:'134000000000000001',image:identity.engine.path,sha256:sha};
const ready={schema:'aaw.engine.guardian.ready.v1',nonce:path.basename(root),root,port:43124,startedAt:'2026-09-14T00:00:00.000Z',guardian,engine,job:{atomic:true,killOnClose:true,breakawayAllowed:false}};
const result={schema:'aaw.engine.guardian.result.v1',nonce:path.basename(root),root,port:43124,guardian,engine,engineExited:true,engineExitCode:23,termination:'requested',job:{activeProcesses:0,emptyConfirmed:true,closed:true},cleanupConfirmed:true,error:null};
const intent={schema:'aaw.engine.guardian.intent.v1',nonce:path.basename(root),root,port:43124,guardian,engineImage:identity.engine.path,engineSha256:sha,hostCapabilityBoundaryChanged:false};

test('guardian receipt binds actual engine identity and requires observed job closure independently of exit',()=>{
  const actual=parseGuardianReady(ready,binding);assert.equal(actual.pid,5678);assert.deepEqual(parseGuardianResult(result,binding,actual),{exited:true,code:23,signal:null});
  assert.deepEqual(parseGuardianResult({...result,termination:'parent_lost',engineExitCode:125},binding,actual),{exited:true,code:125,signal:null});
  assert.equal(parseGuardianResult({...result,job:{...result.job,emptyConfirmed:false}},binding,actual).exited,false);
  assert.equal(parseGuardianResult({...result,cleanupConfirmed:false},binding,actual).exited,false);
  for(const wrong of [{...result,nonce:'other'},{...result,engine:{...engine,creationTime100ns:'134000000000000099'}},{...result,guardian:{...guardian,pid:9}}])assert.throws(()=>parseGuardianResult(wrong,binding,actual));
  assert.throws(()=>parseGuardianReady({...ready,job:{...ready.job,atomic:false}},binding));
});

test('guardian transport sends one stop on private stdin and never treats child close without proof as confirmed',async t=>{
  t.mock.method(files,'nativePinned',()=>Buffer.from('x'));t.mock.method(files,'inspectNativePath',()=>({chain:[{dev:'1',ino:'2'}],stat:{} as never}));
  let currentResult:unknown=result;const launches:{file:string;args:string[];options:childProcess.SpawnOptions}[]=[],controls:string[]=[],kills:number[]=[];
  let child:ReturnType<typeof makeChild>;
  function makeChild(){const c=Object.assign(new EventEmitter(),{pid:1234,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){kills.push(1234);return true;},unref(){assert.fail('guardian must remain owned by main');}});c.stdin.on('data',(bytes:Buffer)=>{controls.push(bytes.toString());queueMicrotask(()=>c.emit('close',0));});return c;}
  t.mock.method(files,'nativeRead',(file:string)=>{const value=file.endsWith('ready.json')?ready:file.endsWith('intent.json')?intent:currentResult;if(!value)throw Object.assign(Error('absent'),{code:'ENOENT'});return Buffer.from(JSON.stringify(value));});
  t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{launches.push({file,args,options});child=makeChild();queueMicrotask(()=>child.emit('spawn'));return child;});
  const env={SystemRoot:'C:\\Windows',AAW_PILOT_TOOL_TOKEN:'synthetic-never-persisted'};
  const first=startEngineGuardian({root,port:43124,env,identity});assert.equal((await first.ready).pid,5678);assert.deepEqual(launches[0]!.args,[root,'43124']);assert.deepEqual(launches[0]!.options.stdio,['pipe','pipe','pipe']);assert.equal(launches[0]!.options.env,env);assert.equal(launches[0]!.options.shell,false);assert.equal(launches[0]!.options.detached,true);assert.equal(launches[0]!.options.windowsHide,true);
  assert.deepEqual(await first.stop(),{exited:true,code:23,signal:null});await first.stop();assert.deepEqual(controls,['C']);assert.deepEqual(kills,[]);
  currentResult=null;const second=startEngineGuardian({root,port:43124,env,identity});await second.ready;child!.emit('close',0);assert.deepEqual(await second.exited,{exited:false,code:null,signal:null});assert.equal(launches.length,2);
});

test('persisted controller review binds exact startup hashes and guardian creation identity without scanning',t=>{
  t.mock.method(manifest,'runtimeComponent',(id:string)=>{if(id==='guardian')return identity.binary;if(id==='opencode')return identity.engine;throw Error('unexpected component');});
  t.mock.method(manifest,'runtimeManifestPin',()=>identity.proof);
  const pinned=identity,owner={...guardian,image:pinned.binary.path},actual={...engine,image:pinned.engine.path,sha256:pinned.engine.sha256};
  const start={...ready,guardian:owner,engine:actual},intentRecord={...intent,guardian:owner,engineImage:pinned.engine.path,engineSha256:pinned.engine.sha256};
  let end:unknown={...result,guardian:owner,engine:actual};const reads:string[]=[];
  t.mock.method(files,'nativePinned',()=>Buffer.from('mocked fixed native bytes'));
  t.mock.method(files,'nativeRead',(file:string)=>{reads.push(file);assert.equal(path.dirname(file),path.join(root,'guardian-control'));return Buffer.from(JSON.stringify(file.endsWith('ready.json')?start:file.endsWith('intent.json')?intentRecord:end));});
  const ref={guardianId:path.basename(root),guardianPid:owner.pid,enginePid:actual.pid,intentVersion:files.nativeDigest(Buffer.from(JSON.stringify(intentRecord))),readyVersion:files.nativeDigest(Buffer.from(JSON.stringify(start)))};
  assert.equal(verifyClosedEngineController(ref).resultVersion,files.nativeDigest(Buffer.from(JSON.stringify(end))));
  assert.throws(()=>verifyClosedEngineController({...ref,readyVersion:'f'.repeat(64)}));
  assert.throws(()=>verifyClosedEngineController({...ref,intentVersion:'f'.repeat(64)}));
  assert.throws(()=>verifyClosedEngineController({...ref,guardianId:'../unknown'}));
  end={...result,guardian:{...owner,creationTime100ns:'134000000000000099'},engine:actual};assert.throws(()=>verifyClosedEngineController(ref));
  end={...result,guardian:owner,engine:actual,job:{activeProcesses:1,emptyConfirmed:false,closed:true}};assert.throws(()=>verifyClosedEngineController(ref));
  assert.ok(reads.every(file=>['intent.json','ready.json','result.json'].includes(path.basename(file))));
});
