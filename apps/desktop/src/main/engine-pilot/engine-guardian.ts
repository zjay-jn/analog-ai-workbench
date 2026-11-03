import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import {runtimePaths} from '../runtime-paths';
import {runtimeComponent, runtimeManifestPin} from '../runtime-manifest';
import { isDeepStrictEqual } from 'node:util';
import { inspectNativePath, nativePinned, nativeRead, nativeDigest, type NativeFilePin } from '../agent-command/native-files';
import type { WorkCycleControllerRef, WorkCycleRecovery } from '../../shared/agent/agent-work-cycle';
import { sameProjectFolderChain } from '../cloud/project-folder-files';

export type EngineGuardianIdentity=Readonly<{binary:NativeFilePin;proof:NativeFilePin;engine:NativeFilePin}>;
// Local setup verifies source/build provenance. The component loader also binds
// installation and data roots; no discovered binary or historical proof is used.
export const ENGINE_GUARDIAN_IDENTITY:EngineGuardianIdentity=Object.freeze({
  get binary() { return runtimeComponent('guardian'); },
  get proof() { return runtimeManifestPin(); },
  get engine() { return runtimeComponent('opencode'); },
});
/** Capture verified pins once per lifecycle; record polling must not rehash the engine. */
export function engineGuardianIdentity(): EngineGuardianIdentity {
  return Object.freeze({binary: runtimeComponent('guardian'), proof: runtimeManifestPin(), engine: runtimeComponent('opencode')});
}
type ProcessIdentity=Readonly<{pid:number;creationTime100ns:string;image:string}>;
export type EngineIdentity=ProcessIdentity&Readonly<{sha256:string}>;
export type GuardianExit=Readonly<{exited:boolean;code:number|null;signal:string|null}>;
type Binding=Readonly<{root:string;port:number;guardianPid:number;identity:EngineGuardianIdentity}>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const equalPath=(a:unknown,b:string):boolean=>typeof a==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function fail():never{throw new Error('ENGINE_GUARDIAN_EVIDENCE');}
function processIdentity(v:unknown,image:string):v is ProcessIdentity&Record<string,unknown>{return object(v)&&Number.isSafeInteger(v.pid)&&(v.pid as number)>0&&typeof v.creationTime100ns==='string'&&/^[1-9][0-9]{1,30}$/u.test(v.creationTime100ns)&&equalPath(v.image,image);}
function bind(value:unknown,b:Binding,schema:string):Record<string,unknown>{
  if(!object(value)||value.schema!==schema||value.nonce!==path.basename(b.root)||!equalPath(value.root,b.root)||value.port!==b.port||!processIdentity(value.guardian,b.identity.binary.path)||value.guardian.pid!==b.guardianPid)fail();return value;
}
export function parseGuardianReady(value:unknown,b:Binding):EngineIdentity{
  const v=bind(value,b,'aaw.engine.guardian.ready.v1');if(!processIdentity(v.engine,b.identity.engine.path)||!object(v.engine)||v.engine.sha256!==b.identity.engine.sha256||v.engine.pid===b.guardianPid||!object(v.job)||v.job.atomic!==true||v.job.killOnClose!==true||v.job.breakawayAllowed!==false||typeof v.startedAt!=='string'||!Number.isFinite(Date.parse(v.startedAt)))fail();return v.engine as EngineIdentity;
}
export function parseGuardianResult(value:unknown,b:Binding,ready:EngineIdentity|null):GuardianExit{
  const v=bind(value,b,'aaw.engine.guardian.result.v1');
  if(v.engine!==null&&(!processIdentity(v.engine,b.identity.engine.path)||!object(v.engine)||v.engine.sha256!==b.identity.engine.sha256)||ready&&!isDeepStrictEqual(ready,v.engine)||!object(v.job)||typeof v.job.emptyConfirmed!=='boolean'||typeof v.job.closed!=='boolean'||v.job.activeProcesses!==null&&(!Number.isSafeInteger(v.job.activeProcesses)||(v.job.activeProcesses as number)<0)||typeof v.cleanupConfirmed!=='boolean'||typeof v.engineExited!=='boolean'||v.engineExitCode!==null&&!Number.isSafeInteger(v.engineExitCode)||!['exited','requested','parent_lost','fault'].includes(String(v.termination)))fail();
  const confirmed=v.cleanupConfirmed&&v.job.emptyConfirmed&&v.job.activeProcesses===0&&v.job.closed&&(v.engine===null||v.engineExited&&Number.isSafeInteger(v.engineExitCode));
  return {exited:!!confirmed,code:v.engine===null?null:v.engineExitCode as number|null,signal:null};
}
function controllerRecords(b:Binding){
  const read=(name:string)=>{const bytes=nativeRead(path.join(b.root,'guardian-control',name+'.json'),16384);return {value:JSON.parse(bytes.toString('utf8')),version:nativeDigest(bytes)};};
  const intent=read('intent'),ready=read('ready'),engine=parseGuardianReady(ready.value,b);
  const value=bind(intent.value,b,'aaw.engine.guardian.intent.v1');
  if(!isDeepStrictEqual(value.guardian,ready.value.guardian)||!equalPath(value.engineImage,b.identity.engine.path)||value.engineSha256!==b.identity.engine.sha256||value.hostCapabilityBoundaryChanged!==false)fail();
  return {intent,ready,engine,read};
}
/** Exact persisted startup hashes bind creation times and image identity; a PID alone is never proof. */
export function verifyClosedEngineController(ref:WorkCycleControllerRef):WorkCycleRecovery['controller']{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(ref.guardianId))fail();
  const identity=engineGuardianIdentity(),root=path.join(runtimePaths().pilotRoot,'native',ref.guardianId);
  nativePinned(identity.binary,4*1024*1024);nativePinned(identity.proof,1024*1024);nativePinned(identity.engine,256*1024*1024);
  const bytes=nativeRead(path.join(root,'guardian-control/ready.json'),16384);if(nativeDigest(bytes)!==ref.readyVersion)fail();
  const port=JSON.parse(bytes.toString('utf8')).port;if(!Number.isSafeInteger(port)||port<1024||port>65535)fail();
  const binding={root,port,guardianPid:ref.guardianPid,identity},records=controllerRecords(binding);
  if(records.intent.version!==ref.intentVersion||records.ready.version!==ref.readyVersion||records.engine.pid!==ref.enginePid)fail();
  const result=records.read('result');if(!isDeepStrictEqual(result.value.guardian,records.ready.value.guardian)||!parseGuardianResult(result.value,binding,records.engine).exited)fail();
  return Object.freeze({...ref,resultVersion:result.version});
}
/** The engine inherits output pipes; only this exact guardian owns the parent-liveness stdin. */
export function startEngineGuardian(options:Readonly<{root:string;port:number;env:NodeJS.ProcessEnv;identity:EngineGuardianIdentity}>){
  const {identity,root,port}=options,base=path.join(runtimePaths().pilotRoot,'native');
  if(path.dirname(root)!==base||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(path.basename(root))||!Number.isSafeInteger(port)||port<1024||port>65535)fail();
  nativePinned(identity.binary,4*1024*1024);nativePinned(identity.proof,1024*1024);nativePinned(identity.engine,256*1024*1024);const rootChain=inspectNativePath(root,true).chain;
  // Keep this supervisor outside libuv's kill-on-parent-exit Job so stdin EOF can trigger its own bounded Job cleanup.
  const child:ChildProcessWithoutNullStreams=spawn(identity.binary.path,[root,String(port)],{cwd:path.join(root,'cwd'),env:options.env,windowsHide:true,detached:true,shell:false,stdio:['pipe','pipe','pipe']});
  let closed=false,spawned=false,stopSent=false,readyValue:EngineIdentity|null=null;let resolveClose!:()=>void;
  const close=new Promise<void>(resolve=>{resolveClose=resolve;});child.once('spawn',()=>{spawned=true;});child.stdin.on('error',()=>{});child.on('error',()=>{if(!child.pid){closed=true;resolveClose();}});child.once('close',()=>{closed=true;resolveClose();});
  const requestStop=():void=>{if(stopSent)return;stopSent=true;try{child.stdin.write('C');child.stdin.end();}catch{child.stdin.destroy();}};
  const read=(name:string):unknown|null=>{try{if(!sameProjectFolderChain(rootChain,inspectNativePath(root,true).chain))fail();return JSON.parse(nativeRead(path.join(root,'guardian-control',name+'.json'),16384).toString('utf8'));}catch(e){if(e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT')return null;throw e;}};
  const binding=():Binding=>({root,port,guardianPid:child.pid??0,identity});
  const ready=(async()=>{const deadline=Date.now()+30000;while(!closed&&Date.now()<deadline){const raw=read('ready');if(raw){readyValue=parseGuardianReady(raw,binding());return readyValue;}await Promise.race([close,new Promise<void>(resolve=>setTimeout(resolve,50))]);}throw Error('ENGINE_GUARDIAN_START');})();void ready.catch(()=>requestStop());
  const controller=ready.then(()=>{const records=controllerRecords(binding());return Object.freeze({guardianId:path.basename(root),guardianPid:child.pid!,enginePid:records.engine.pid,intentVersion:records.intent.version,readyVersion:records.ready.version});});void controller.catch(()=>requestStop());
  const exited=(async():Promise<GuardianExit>=>{await close;if(!spawned&&!child.pid)return {exited:true,code:null,signal:null};try{const raw=read('result');if(!raw)return {exited:false,code:null,signal:null};return parseGuardianResult(raw,binding(),readyValue);}catch{return {exited:false,code:null,signal:null};}})();
  const stop=async():Promise<GuardianExit>=>{requestStop();let timer:ReturnType<typeof setTimeout>|undefined;try{const value=await Promise.race([exited,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),5000);})]);if(value)return value;try{child.kill();}catch{}return {exited:false,code:null,signal:null};}finally{if(timer)clearTimeout(timer);}};
  return {child,ready,controller,exited,stop};
}
