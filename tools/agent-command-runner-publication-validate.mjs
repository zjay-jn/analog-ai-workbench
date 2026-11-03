import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root='C:\\work\\analog_ai_workbench';
const batch=path.join(root,'.local','quality-evidence','20260914-agent-command-native-01');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sha=file=>hash(fs.readFileSync(file));
const ordinary=file=>{const s=fs.lstatSync(file);if(s.isSymbolicLink()||fs.realpathSync(file).toLowerCase()!==file.toLowerCase())throw new Error('Aliased path: '+file);return s;};
const node=path.join(root,'.local','toolchains','node-v24.20.0-win-x64','node.exe');
const nodeSha='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
if(process.platform!=='win32'||process.arch!=='x64'||process.version!=='v24.20.0'||process.argv.length!==4||!/^native-build-[0-9]{2}$/.test(process.argv[2])||!/^[a-f0-9]{64}$/.test(process.argv[3])||sha(process.execPath)!==nodeSha)throw new Error('Reviewed single native validation required');
for(let folder=batch;folder.length>3;folder=path.dirname(folder))ordinary(folder);
const proofFile=path.join(batch,process.argv[2],'build-proof.json');
if(sha(proofFile)!==process.argv[3])throw new Error('Build proof mismatch');
const build=JSON.parse(fs.readFileSync(proofFile,'utf8'));
if(build.schema!=='aaw.command.native-build.v1'||build.exitCode!==0||!build.unchanged||!build.output)throw new Error('Production candidate build required');
for(const ref of build.sources){const file=path.resolve(root,ref.path);if(!file.startsWith(root+path.sep)||ordinary(file).size!==ref.bytes||sha(file)!==ref.sha256)throw new Error('Build source changed');}
const native=path.resolve(root,build.output.path);
if(native!==path.join(batch,process.argv[2],'agent-command-runner-native.exe')||ordinary(native).size!==build.output.bytes||sha(native)!==build.output.sha256)throw new Error('Native identity mismatch');
const environment=JSON.parse(fs.readFileSync(path.join(root,build.profile.path),'utf8'));
if(sha(path.join(root,build.profile.path))!==build.profile.sha256||environment.profileRevision!==build.profileRevision)throw new Error('Profile identity mismatch');
const nonce=crypto.randomUUID(),testId=crypto.randomUUID(),executionId='cmd-'+crypto.randomUUID();
const testRoot=path.join(root,'.local','agent-command-runner','native-tests',testId),run=path.join(testRoot,'executions',executionId);
// One fixed compatibility case with a concurrent status reader and one 120ms hold.
const script=String.raw`const fs=require('node:fs');
const path=require('node:path');
const input=JSON.parse(fs.readFileSync('input.json','utf8'));
const sum=require('./sum.cjs');
const denied=p=>{try{const fd=fs.openSync(p,'r+');fs.closeSync(fd);return false;}catch(e){return ['EACCES','EPERM','EBUSY'].includes(e.code);}};
const baseline=path.join(process.env.AAW_BASELINE,'space 中文','input.json');
const control=path.join(process.env.AAW_CONTROL,'native-intent.json');
const result={sum:sum(input),modulePath:require.resolve('./sum.cjs'),nodeOptions:process.env.NODE_OPTIONS,pid:process.pid,ppid:process.ppid,cwd:process.cwd(),runtime:process.execPath,baselineWriteDenied:denied(baseline),controlWriteDenied:denied(control)};
fs.mkdirSync('nested/level two',{recursive:true});fs.writeFileSync('nested/level two/result.json',JSON.stringify(result));
process.stdout.write('NODE_BEGIN\n'+JSON.stringify(result)+'\n'+'0123456789abcdef'.repeat(512)+'\nNODE_END\n');
process.stderr.write(Buffer.from([0x41,0x41,0x57,0xff,0x00,0x45,0x52,0x52,0x0a]));
setTimeout(()=>{process.exitCode=23;},350);
`;
const command=String.raw`$ErrorActionPreference = 'Stop'
[Console]::WriteLine('PRODUCTION_COMMAND_BEGIN')
[Console]::WriteLine('PWD=' + (Get-Location).ProviderPath)
[Console]::WriteLine('WIN32_CWD=' + [Environment]::CurrentDirectory)
[Console]::WriteLine('SCRIPT_ROOT_JOIN=' + (Join-Path $PSScriptRoot 'node.exe'))
New-Item -ItemType Directory -Path '.\provider' | Out-Null
New-Item -ItemType File -Path '.\provider\check.txt' -Value 'provider ok' | Out-Null
node '.\analysis.cjs'
`;
const scriptBytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(command)]);
const files=[{relativePath:'space 中文/analysis.cjs',body:Buffer.from(script)},{relativePath:'space 中文/input.json',body:Buffer.from('[19,23]\n')},{relativePath:'space 中文/sum.cjs',body:Buffer.from('module.exports = values => values.reduce((a,b) => a+b, 0);\n')}].sort((a,b)=>a.relativePath<b.relativePath?-1:1);
const manifest=files.map(file=>({relativePath:file.relativePath,bytes:file.body.length,sha256:hash(file.body)}));
const baselineManifestSha256=hash(Buffer.from(JSON.stringify(manifest))),baselineVersion=hash(Buffer.from('synthetic baseline '+baselineManifestSha256)),environmentRevision=hash(Buffer.from(JSON.stringify({profile:build.profile,native:build.output}))),commandSha256=hash(Buffer.from(command)),scriptSha256=hash(scriptBytes),signature=hash(Buffer.from(JSON.stringify({executionId,nonce,baselineVersion,commandSha256,environmentRevision})));
fs.mkdirSync(run,{recursive:true});for(let folder=run;folder.length>3;folder=path.dirname(folder))ordinary(folder);
for(const leaf of ['control','runtime','baseline','work','home','temp'])fs.mkdirSync(path.join(run,leaf));
for(const file of files)for(const tree of ['baseline','work']){const target=path.join(run,tree,...file.relativePath.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.body,{flag:'wx'});}
for(const [source,destination]of[[node,'node.exe'],[path.join(path.dirname(node),'LICENSE'),'LICENSE'],[path.join(root,'tools','agent-command-runner-bootstrap.ps1'),'bootstrap.ps1']]){ordinary(source);fs.copyFileSync(source,path.join(run,'runtime',destination),fs.constants.COPYFILE_EXCL);}
fs.writeFileSync(path.join(run,'runtime','command.ps1'),scriptBytes,{flag:'wx'});fs.writeFileSync(path.join(run,'baseline-manifest.json'),JSON.stringify(manifest),{flag:'wx'});
const deadline=Date.now()+20000;
const admission={schema:'aaw.command.native-publication-validation.intent.v1',createdAt:new Date().toISOString(),executionRoot:run,executionId,signature,nonce,environmentRevision,commandSha256,scriptSha256,baselineVersion,baselineManifestSha256,buildProofSha256:process.argv[3],native:build.output,profile:build.profile,command,manifest,
  launcher:{path:path.relative(root,fileURLToPath(import.meta.url)),sha256:sha(fileURLToPath(import.meta.url))},expected:{shellExitCode:23,nodeProcesses:1,sum:42,baselineWriteDenied:true,controlWriteDenied:true,statusRecoveredDuringHold:true},budgets:{nativeLaunches:1,shellLaunches:1,nodeLaunches:1,jobMembers:8,absoluteDeadlineUnixMs:deadline,statusReadIntervalMs:10,statusHoldMs:120},externalNetwork:false,realProjectAccess:false,credentials:false,bareHostFallback:false};
fs.writeFileSync(path.join(run,'control','intent.json'),JSON.stringify(admission),{flag:'wx'});
const receiptDir=path.join(batch,'native-publication-validation-'+testId);fs.mkdirSync(receiptDir);fs.writeFileSync(path.join(receiptDir,'admission.json'),JSON.stringify(admission,null,2)+'\n',{flag:'wx'});
const argv=[run,executionId,signature,nonce,environmentRevision,commandSha256,scriptSha256,baselineVersion,baselineManifestSha256,String(deadline),'space 中文',...manifest.map(file=>file.sha256+':'+file.bytes+':'+file.relativePath)];
const child=spawn(native,argv,{cwd:run,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:\\Windows',windir:'C:\\Windows',SystemDrive:'C:'}});
const stdout=[],stderr=[];let received=0,overflow=false,guardClosed=false,forcedExit=false;
for(const [stream,list]of[[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',bytes=>{received+=bytes.length;if(received<=131072)list.push(bytes);else{overflow=true;child.stdin.destroy();}});
child.stdin.on('error',()=>{});
const statusFile=path.join(run,'control','status.json'),samples=[];
let heldFd=null,hold=null,holdTimer=null,readerError=null,previous=null;
const releaseHold=()=>{if(heldFd!==null){fs.closeSync(heldFd);heldFd=null;if(hold)hold.releasedAt=new Date().toISOString();}};
const reader=setInterval(()=>{
  let fd=null,keep=false;
  try{
    fd=fs.openSync(statusFile,'r');const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>65536n)throw new Error('status_handle_identity');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true});
    if(bytes.length!==Number(before.size)||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs)throw new Error('status_handle_changed');
    const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    for(const [key,value]of Object.entries({executionId,signature,nonce,environmentRevision,commandSha256,scriptSha256,baselineVersion,baselineManifestSha256}))if(state[key]!==value)throw new Error('status_identity_'+key);
    if(state.schema!=='aaw.command.native.status.v1'||!Number.isSafeInteger(state.seq)||state.seq<1||previous&&state.seq<previous.seq)throw new Error('status_sequence');
    for(const stream of ['stdout','stderr'])if(!Number.isSafeInteger(state.logs?.[stream]?.persistedBytes)||state.logs[stream].persistedBytes<0||previous&&state.logs[stream].persistedBytes<previous.logs[stream].persistedBytes)throw new Error('status_offset');
    if(!previous||state.seq>previous.seq){if(samples.length>=512)throw new Error('status_sample_budget');samples.push({seq:state.seq,readAt:new Date().toISOString(),sha256:hash(bytes),shellExit:state.shellExit,job:state.job,logs:state.logs});previous=state;}
    if(!hold&&state.shellExit===null){heldFd=fd;keep=true;hold={seq:state.seq,dev:String(before.dev),ino:String(before.ino),startedAt:new Date().toISOString(),releasedAt:null,requestedMs:120};holdTimer=setTimeout(releaseHold,120);}
  }catch(error){if(error.code!=='ENOENT'){readerError=error.message;clearInterval(reader);releaseHold();child.stdin.destroy();}}
  finally{if(fd!==null&&!keep)fs.closeSync(fd);}
},10);
const guard=setTimeout(()=>{guardClosed=true;child.stdin.destroy();},30000),lastResort=setTimeout(()=>{forcedExit=true;child.kill();},45000);
const outcome=await new Promise(resolve=>{child.once('error',error=>resolve({exitCode:null,error:error.message}));child.once('close',exitCode=>resolve({exitCode,error:null}));});clearTimeout(guard);clearTimeout(lastResort);clearInterval(reader);clearTimeout(holdTimer);releaseHold();child.stdin.destroy();
fs.writeFileSync(path.join(receiptDir,'native.stdout.bin'),Buffer.concat(stdout),{flag:'wx'});fs.writeFileSync(path.join(receiptDir,'native.stderr.bin'),Buffer.concat(stderr),{flag:'wx'});
const resultFile=path.join(run,'control','result.json'),nativeResult=fs.existsSync(resultFile)?JSON.parse(fs.readFileSync(resultFile,'utf8')):null;
const artifact=path.join(run,'work','space 中文','nested','level two','result.json'),result=fs.existsSync(artifact)?JSON.parse(fs.readFileSync(artifact,'utf8')):null;
const raw={};for(const stream of ['stdout','stderr']){const file=path.join(run,'control',stream+'.bin');raw[stream]=fs.existsSync(file)?{bytes:fs.statSync(file).size,sha256:sha(file)}:null;}
const baselineUnchanged=manifest.every(file=>sha(path.join(run,'baseline',...file.relativePath.split('/')))===file.sha256);
const identities=fs.readdirSync(path.join(run,'control')).filter(name=>/^process-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(run,'control',name),'utf8')));
const nodeIdentity=identities.find(identity=>identity.pid===result?.pid&&identity.image.toLowerCase()===path.join(run,'runtime','node.exe').toLowerCase()&&identity.appContainer&&identity.capabilityCount===0&&identity.lowIntegrity&&identity.inJob);
const publication=nativeResult?.diagnostic?.statusPublication;
const contentionCovered=!readerError&&hold?.releasedAt&&samples.length>=2&&publication?.failures>=1&&publication?.recovered>=1&&[5,32,33].includes(publication.firstCode)&&Date.parse(publication.firstFailureAt)>=Date.parse(hold.startedAt)&&Date.parse(publication.firstFailureAt)<=Date.parse(hold.releasedAt)&&samples.some(sample=>sample.seq>hold.seq);
const passed=!!contentionCovered&&outcome.exitCode===0&&!overflow&&!guardClosed&&!forcedExit&&nativeResult?.shellExit?.shellExitCode===23&&nativeResult?.shellExit?.termination==='exited'&&nativeResult?.job?.emptyConfirmed&&nativeResult?.job?.activeProcesses===0&&nativeResult?.jobClosed&&nativeResult?.profileDeleted&&nativeResult?.aclRestored&&nativeResult?.cleanup?.state==='confirmed'&&nativeResult?.error===null&&baselineUnchanged&&result?.sum===42&&result?.nodeOptions==='--preserve-symlinks-main --preserve-symlinks'&&result?.modulePath===path.join(run,'work','space 中文','sum.cjs')&&result?.baselineWriteDenied&&result?.controlWriteDenied&&!!nodeIdentity&&['stdout','stderr'].every(stream=>nativeResult.logs[stream].eof&&nativeResult.logs[stream].coverage==='complete'&&raw[stream]?.bytes===nativeResult.logs[stream].persistedBytes&&raw[stream]?.sha256===nativeResult.logs[stream].sha256);
const receipt={schema:'aaw.command.native-publication-validation.result.v1',completedAt:new Date().toISOString(),scope:'single_compatibility_nonzero_exit_concurrent_status_read_and_120ms_contention',state:passed?'PASS':'FAIL',run,outcome,overflow,guardClosed,forcedExit,buildProofSha256:process.argv[3],native:build.output,profile:build.profile,nativeResultSha256:fs.existsSync(resultFile)?sha(resultFile):null,nativeResult,raw,baselineUnchanged,artifact:result,artifactSha256:fs.existsSync(artifact)?sha(artifact):null,nodeIdentity:nodeIdentity??null,statusReader:{error:readerError,hold,samples,publication,contentionCovered:!!contentionCovered}};
fs.writeFileSync(path.join(receiptDir,'result.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(receipt)+'\n');if(!passed)process.exitCode=1;
