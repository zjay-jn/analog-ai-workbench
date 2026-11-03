import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { WslCommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command';
import { createCommandRecord } from '../apps/desktop/src/main/agent-command/state';
import { createWslRequest, readWslCommandRecovery, wslWindowsPath, type WslCommandDriverProfile } from '../apps/desktop/src/main/agent-command/wsl-driver';
import { decodeWslBytes, parseWslTerminal, wslIdentity, type WslTerminal } from '../apps/desktop/src/main/agent-command/wsl-protocol';
import type { WorkCycleBaseline } from '../apps/desktop/src/main/agent-work-cycle/types';
import {readWslPrestartRecovery,type WslPrestartRecoveryPin} from '../apps/desktop/src/main/agent-command/wsl-prestart-recovery';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),sha=hash('fixture');
const env:WslCommandEnvironment={environmentId:'test-wsl',revision:sha,displayName:'Synthetic WSL',platform:'wsl',shell:{kind:'bash',version:'synthetic',sha256:sha,scriptEncoding:'utf8',interactive:false},tools:[],isolation:'wsl-bubblewrap',profileRevision:sha,availability:'ready',reason:null,projectAccess:'declared_roots',baselineAccess:'verified_copy',workAccess:'execution_copy',network:'inherited',hostEnvironment:'controlled',packageInstallation:'not_provided',executableScope:'wsl_user_permissions',survivesAppClose:false,limits:{processes:8,logBytes:16777216,defaultTimeoutMs:120000,maxTimeoutMs:600000},wsl:{distribution:'ROCKY9_LLM_LAB',user:'maxwell',homeDirectory:'/home/maxwell',shellPath:'/bin/bash',executionRoot:'/home/maxwell/isolated',sourceRoots:[{path:'/home/maxwell/source',access:'read_only',enforcement:'os_read_only'}]}};
const baseline:WorkCycleBaseline={runId:'test-run',workspaceId:'test-work',version:sha,files:[]};
const pinnedEnvironment:WslCommandEnvironment={...env,tools:[{name:'python3',version:'synthetic',sha256:sha},{name:'bubblewrap',version:'synthetic',sha256:sha}]};
const row=createCommandRecord(baseline.runId,{requestId:'test-request',environmentId:env.environmentId,environmentRevision:sha,workspaceId:baseline.workspaceId,baselineVersion:sha,cwdRelativePath:'',commandText:"printf '中文\\n'",timeoutMs:120000},pinnedEnvironment,baseline,Date.now());
const pin={path:'C:\\work\\analog_ai_workbench\\tools\\fixture.py',sha256:sha,bytes:1};
const profile:WslCommandDriverProfile={environment:pinnedEnvironment,supervisor:pin,proof:pin,wslPath:'C:\\Windows\\System32\\wsl.exe',linuxPythonPath:'/usr/bin/python3',bubblewrapPath:'/usr/bin/bwrap'};
function terminal():WslTerminal{
  const when=new Date().toISOString(),log={observedBytes:0,persistedBytes:0,sha256:hash(''),eof:true,coverage:'complete' as const};
  return {schema:'aaw.command.wsl.result.v1',identity:wslIdentity(row),startedAt:when,completedAt:when,exit:{shellExited:true,shellExitCode:0,observedAt:when,termination:'exited'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:when},cleanupConfirmed:true,logs:{stdout:log,stderr:log},error:null,lifecycle:{supervisorPid:10,supervisorStartTicks:'1',namespacePid:11,namespaceStartTicks:'2',namespaceInode:'pid:[12345]',namespaceProcessesRemaining:0,namespaceInitReaped:true},exported:[],deleted:[],skippedFiles:0};
}
test('WSL request binds script, target, work baseline and private Windows mirror',()=>{
  const request=createWslRequest(profile,row,'run',baseline);
  assert.equal(request.identity.scriptSha256,hash(row.execution.commandText));
  assert.equal(request.hostControl,'/mnt/c/work/analog_ai_workbench/.local/agent-command-runner/executions/'+row.execution.executionId+'/control');
  assert.equal(request.distribution,'ROCKY9_LLM_LAB');assert.deepEqual(request.baseline,[]);
  assert.throws(()=>createWslRequest(profile,row,'run',{...baseline,version:hash('other')}));
  assert.throws(()=>createWslRequest(profile,{...row,execution:{...row.execution,scriptSha256:hash('\ufeff'+row.execution.commandText)}},'run',baseline));
});
test('WSL paths and wire bytes reject ambiguous encodings and traversal',()=>{
  assert.equal(wslWindowsPath('C:\\work\\中文 name\\script.py'),'/mnt/c/work/中文 name/script.py');
  for(const bad of ['C:\\work\\..\\escape','C:\\work\\file:stream','\\\\server\\share\\x'])assert.throws(()=>wslWindowsPath(bad));
  assert.equal(decodeWslBytes('5Lit5paH',6).toString(),'中文');
  for(const bad of ['Zg=','Zh==','Zm9v\n','===='])assert.throws(()=>decodeWslBytes(bad,100));
});
test('WSL recovery reads only exact flushed local evidence and detects alteration',()=>{
  const receipt=terminal();const files=new Map<string,Buffer>([['wsl-linux-result.json',Buffer.from(JSON.stringify(receipt))],['wsl-stdout.bin',Buffer.alloc(0)],['wsl-stderr.bin',Buffer.alloc(0)]]);
  const read=(name:string)=>{const bytes=files.get(name);if(!bytes)throw new Error('missing');return bytes;};
  const recovered=readWslCommandRecovery(row,read);assert.equal(recovered?.outcome.cleanup.state,'confirmed');assert.equal(recovered?.outcome.artifactCollection?.scope,'bounded_text_exports');
  files.set('wsl-stdout.bin',Buffer.from('tamper'));assert.equal(readWslCommandRecovery(row,read),null);
  files.delete('wsl-linux-result.json');assert.equal(readWslCommandRecovery(row,read),null);
});
test('WSL killed namespace can be confirmed without inventing inner shell exit',()=>{
  const receipt=terminal();const stopped={...receipt,exit:{...receipt.exit,shellExited:false,shellExitCode:null,termination:'stopped' as const}};
  assert.equal(parseWslTerminal(stopped,row).cleanupConfirmed,true);
  assert.throws(()=>parseWslTerminal({...stopped,exit:{...stopped.exit,shellExitCode:0}},row));
  assert.throws(()=>parseWslTerminal({...receipt,lifecycle:{...receipt.lifecycle,namespacePid:null,namespaceStartTicks:null,namespaceInode:null}},row));
});
test('WSL prestart cancellation needs affirmative no-child or reaped-subtree proof',()=>{
  const base=terminal();
  const before:WslTerminal={...base,startedAt:null,exit:{...base.exit,shellExited:false,shellExitCode:null,termination:'stopped'},lifecycle:{...base.lifecycle,namespacePid:null,namespaceStartTicks:null,namespaceInode:null,namespaceProcessesRemaining:null,namespaceInitReaped:false,cleanupProof:{method:'not_spawned',spawnAttempted:false,childReaped:false,subreaperEmpty:true,gateOpened:false}}};
  assert.equal(parseWslTerminal(before,row).cleanupConfirmed,true);
  const during:WslTerminal={...before,lifecycle:{...before.lifecycle,cleanupProof:{method:'prestart_children_reaped',spawnAttempted:true,childReaped:true,subreaperEmpty:true,gateOpened:false}}};
  assert.equal(parseWslTerminal(during,row).cleanupConfirmed,true);
  for(const value of [before,during]){
    const proof=value.lifecycle.cleanupProof!;
    for(const patch of [{subreaperEmpty:false},{gateOpened:true},{method:'unconfirmed'},{method:'namespace_empty'},{spawnAttempted:!proof.spawnAttempted},{childReaped:!proof.childReaped}])assert.throws(()=>parseWslTerminal({...value,lifecycle:{...value.lifecycle,cleanupProof:{...proof,...patch}}},row));
    for(const patch of [{startedAt:base.startedAt},{exit:{...value.exit,shellExited:true,shellExitCode:0}},{job:{...value.job,emptyConfirmed:false}}])assert.throws(()=>parseWslTerminal({...value,...patch},row));
    const {cleanupProof:omitted,...lifecycle}=value.lifecycle;assert.throws(()=>parseWslTerminal({...value,lifecycle},row));
  }
  assert.throws(()=>parseWslTerminal({...before,logs:{...before.logs,stdout:{...before.logs.stdout,observedBytes:1,persistedBytes:1}}},row));
  const files=new Map<string,Buffer>([['wsl-linux-result.json',Buffer.from(JSON.stringify(before))],['wsl-stdout.bin',Buffer.alloc(0)],['wsl-stderr.bin',Buffer.alloc(0)]]);
  assert.equal(readWslCommandRecovery(row,name=>files.get(name)!)?.outcome.cleanup.state,'confirmed');
});

function recoveryFixture(){
  const source=Buffer.from('reviewed synthetic supervisor'),auditor=Buffer.from('reviewed synthetic auditor'),base=terminal();
  const prior:WslTerminal={...base,startedAt:null,cleanupConfirmed:false,exit:{...base.exit,shellExited:false,shellExitCode:null,termination:'stopped'},job:{...base.job,activeProcesses:null,emptyConfirmed:false},error:{code:'WSL_CLEANUP_UNCONFIRMED',stage:'cleanup',nativeCode:null},lifecycle:{...base.lifecycle,namespacePid:null,namespaceStartTicks:null,namespaceInode:null,namespaceProcessesRemaining:null,namespaceInitReaped:false}};
  const raw=Buffer.from(JSON.stringify(prior)),driver=Buffer.from(JSON.stringify({receipt:{schema:'aaw.command.wsl.driver-result.v1',identity:prior.identity,supervisorSha256:hash(source.toString()),linuxResultSha256:hash(raw.toString()),wslExited:true,wslExitCode:0,linuxCleanupConfirmed:false,wireFailed:false,callbackFailed:false},snapshot:prior}));
  const filePin=(path:string,bytes:Buffer)=>({path,bytes:bytes.length,sha256:hash(bytes.toString())}),small=(bytes:Buffer)=>({bytes:bytes.length,sha256:hash(bytes.toString())});
  const identity={pid:100,ppid:1,startTicks:'200'},process={...identity,nspidDepth:1,sameOuterNamespace:true,executionMentioned:false,nonceMentioned:false,privateWorkMentioned:false,supervisorIdentityMatch:false,bubblewrap:false,supervisorSourceMentioned:false};
  const certificate={schema:'aaw.command.wsl.prestart-recovery.v1',method:'complete_outer_pid_census',runId:row.execution.runId,identity:prior.identity,distribution:'ROCKY9_LLM_LAB',user:'maxwell',supervisorSha256:hash(source.toString()),auditorSha256:hash(auditor.toString()),observedAt:prior.completedAt,bootId:'00000000-0000-4000-8000-000000000000',linuxReceipt:small(raw),driverReceipt:small(driver),logs:{stdout:small(Buffer.alloc(0)),stderr:small(Buffer.alloc(0))},census:{before:[identity],after:[identity],rows:[process],errors:[],outerNamespace:'pid:[1]',auditPid:100}};
  const files=new Map([['wsl-linux-result.json',raw],['wsl-driver-result.json',driver],['wsl-stdout.bin',Buffer.alloc(0)],['wsl-stderr.bin',Buffer.alloc(0)]]);
  const launcher=Buffer.from('reviewed synthetic Windows direct launcher'),auditorPath='C:\\work\\analog_ai_workbench\\auditor.py',certificatePath='C:\\work\\analog_ai_workbench\\certificate.json';
  const pinFiles=new Map([['source',source],[auditorPath,auditor],['launcher',launcher]]);
  const approve=(value:unknown):WslPrestartRecoveryPin=>{
    const cert=Buffer.from(JSON.stringify(value));pinFiles.set(certificatePath,cert);
    const certificatePin=filePin(certificatePath,cert),auditorPin=filePin(auditorPath,auditor),launcherPin=filePin('launcher',launcher);
    const launch={schema:'aaw.command.wsl.prestart-audit-launch.v1',platform:'win32',executable:'C:\\Windows\\System32\\wsl.exe',argv:['-d','ROCKY9_LLM_LAB','-u','maxwell','--exec','/usr/bin/python3','-I','/mnt/c/work/analog_ai_workbench/auditor.py','/mnt/c/work/analog_ai_workbench/request.json','/mnt/c/work/analog_ai_workbench/certificate.json'],shell:false,startedAt:prior.completedAt,completedAt:prior.completedAt,exitCode:0,signal:null,launcher:launcherPin,auditor:auditorPin,request:{path:'C:\\work\\analog_ai_workbench\\request.json'},certificate:certificatePin};
    const launchBytes=Buffer.from(JSON.stringify(launch));pinFiles.set('launch',launchBytes);
    return {certificate:certificatePin,auditor:auditorPin,supervisor:filePin('source',source),launch:filePin('launch',launchBytes),launcher:launcherPin};
  };
  const read=(name:string)=>{const bytes=files.get(name);if(!bytes)throw Error('missing');return bytes;};
  const readPin=(pin:{path:string})=>{const bytes=pinFiles.get(pin.path);if(!bytes)throw Error('missing pin');return bytes;};
  return {certificate,files,pinFiles,approve,read,readPin};
}
test('registered prestart recovery preserves old failure/unknown exit without rewriting mirrors',()=>{
  const f=recoveryFixture(),before=Buffer.from(f.read('wsl-linux-result.json')),pins=[f.approve(f.certificate)];
  const recovered=readWslPrestartRecovery(row,f.read,pins,f.readPin);
  assert.equal(recovered?.outcome.cleanup.state,'confirmed');assert.equal(recovered?.outcome.job.emptyConfirmed,true);
  assert.equal(recovered?.outcome.exit.shellExited,false);assert.equal(recovered?.outcome.exit.shellExitCode,null);
  assert.equal(recovered?.outcome.error?.code,'WSL_CLEANUP_UNCONFIRMED');assert.equal(recovered?.outcome.changes,null);
  assert.deepEqual(f.read('wsl-linux-result.json'),before);assert.equal(readWslPrestartRecovery(row,f.read,[],f.readPin),null);
});
test('prestart recovery rejects wrong identity, source, original hash and incomplete process evidence',()=>{
  const mutations:Array<(v:ReturnType<typeof recoveryFixture>['certificate'])=>void>=[
    v=>{v.runId='other';},v=>{v.identity={...v.identity,nonce:'11111111-1111-4111-8111-111111111111'};},v=>{v.supervisorSha256=sha;},v=>{v.auditorSha256=sha;},v=>{v.linuxReceipt.sha256=sha;},v=>{v.driverReceipt.sha256=sha;},v=>{v.logs.stdout.sha256=sha;},
    v=>{v.census.rows=[];},v=>{v.census.after=[];},v=>{v.census.before=[];},v=>{v.census.auditPid=999;},v=>{v.census.rows[0]!.nspidDepth=2;},v=>{v.census.rows[0]!.sameOuterNamespace=false;},v=>{v.census.rows[0]!.privateWorkMentioned=true;},v=>{v.census.rows[0]!.supervisorIdentityMatch=true;},v=>{v.census.rows[0]!.bubblewrap=true;},v=>{v.census.rows[0]!.supervisorSourceMentioned=true;},v=>{v.census.rows[0]!.startTicks='201';},
  ];
  for(const mutate of mutations){const f=recoveryFixture();mutate(f.certificate);assert.equal(readWslPrestartRecovery(row,f.read,[f.approve(f.certificate)],f.readPin),null);}
  const f=recoveryFixture(),approved=f.approve(f.certificate);f.pinFiles.set(approved.certificate.path,Buffer.from('{}'));assert.equal(readWslPrestartRecovery(row,f.read,[approved],f.readPin),null);
  const g=recoveryFixture(),valid=g.approve(g.certificate);g.files.set('wsl-stdout.bin',Buffer.from('changed'));assert.equal(readWslPrestartRecovery(row,g.read,[valid],g.readPin),null);
  const h=recoveryFixture();assert.equal(readWslPrestartRecovery({...row,execution:{...row.execution,startedAt:new Date().toISOString()}},h.read,[h.approve(h.certificate)],h.readPin),null);
  const i=recoveryFixture(),pins=i.approve(i.certificate);i.pinFiles.set('launch',Buffer.from('{}'));assert.equal(readWslPrestartRecovery(row,i.read,[pins],i.readPin),null);
});
