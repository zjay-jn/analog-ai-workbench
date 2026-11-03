import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import net from 'node:net';
import {layout, mkdir, ordinary, sha, hash, ref, sources, publish, findToolchain, nodeGyp, findPython, parseOptions, NODE_SHA256} from './portable-runtime-lib.mjs';

function numericLimits(root) {
  const file=path.join(root,'apps/desktop/src/shared/agent/agent-work-cycle.ts'),text=fs.readFileSync(file,'utf8');
  const constants=Object.fromEntries([...text.matchAll(/const\s+([A-Z_]+)\s*=\s*([0-9]+)\s*;/gu)].map(match=>[match[1],Number(match[2])]));
  const body=text.match(/WORK_CYCLE_LIMITS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/u)?.[1];if(!body)throw Error('WORK_LIMITS_UNAVAILABLE');
  const keys=['files','fileBytes','workspaceBytes','artifactsPerExecution','relativePathBytes','pathDepth','logBytes','outputBytes','executionMs','cleanupMs','nativeCallMs','processes','processMemoryBytes','jobMemoryBytes'];
  return Object.fromEntries(keys.map(key=>{
    const expression=body.match(new RegExp('\\b'+key+'\\s*:\\s*([^,]+),','u'))?.[1]?.trim();if(!expression)throw Error('WORK_LIMIT_MISSING');
    const parts=expression.split('*').map(part=>part.trim());if(parts.some(part=>!/^\d+$/u.test(part)&&!Object.hasOwn(constants,part)))throw Error('WORK_LIMIT_EXPRESSION_UNSUPPORTED');
    const value=parts.map(part=>constants[part]??Number(part)).reduce((a,b)=>a*b,1);if(!Number.isSafeInteger(value)||value<1)throw Error('WORK_LIMIT_INVALID');return [key,value];
  }));
}
function shellProfile(root) {
  const windows=path.resolve(process.env.SystemRoot??'C:/Windows'),shell=path.join(windows,'System32/WindowsPowerShell/v1.0/powershell.exe');ordinary(shell,false,true);
  const probe=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',"[ordered]@{version=$PSVersionTable.PSVersion.ToString();automation=[System.Management.Automation.PSObject].Assembly.Location;clr=([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()+'clr.dll')} | ConvertTo-Json -Compress"],{shell:false,windowsHide:true,encoding:'utf8',timeout:15000});
  if(probe.error||probe.status!==0)throw Error('WINDOWS_POWERSHELL_UNAVAILABLE');const info=JSON.parse(probe.stdout.trim());
  if(!/^5\.1\.\d+\.\d+$/u.test(info.version))throw Error('WINDOWS_POWERSHELL_5_1_REQUIRED');
  const systemFiles=[shell,shell+'.config',info.automation,info.clr].map(file=>({path:path.resolve(file),bytes:ordinary(file,false,true).size,sha256:sha(file)}));
  return {shell,version:info.version,windows,systemFiles};
}
function write(file,text){fs.writeFileSync(file,text,{flag:'wx'});return file;}
const DIAGNOSTIC_BYTES=16384;
const SELF_TEST_RECORDS={work:['native-claim','profile-intent','profile-owned','started','cleanup','cleanup-failed'],guardian:['intent','ready','result']};
function boundedNativeRecord(file) {
  const before=ordinary(file);if(before.size>65536)throw Error('DIAGNOSTIC_RECORD_LIMIT');
  const descriptor=fs.openSync(file,'r');
  try{
    const opened=fs.fstatSync(descriptor),bytes=Buffer.alloc(65537);let count=0;
    while(count<bytes.length){const got=fs.readSync(descriptor,bytes,count,bytes.length-count,count);if(!got)break;count+=got;}
    const after=ordinary(file),closed=fs.fstatSync(descriptor);
    if(count>65536||[opened,after,closed].some(value=>value.dev!==before.dev||value.ino!==before.ino||value.size!==before.size||value.mtimeMs!==before.mtimeMs||value.ctimeMs!==before.ctimeMs)||count!==before.size)throw Error('DIAGNOSTIC_RECORD_CHANGED');
    return bytes.subarray(0,count);
  }finally{fs.closeSync(descriptor);}
}
/** Only fixed synthetic self-test records are copied; no environment/configuration or runtime binaries. */
export function persistNativeSelfTestDiagnostics(paths,details) {
  if(!Object.hasOwn(SELF_TEST_RECORDS,details.kind))throw Error('SELF_TEST_DIAGNOSTIC_KIND');
  const directory=path.join(paths.runtimeRoot,'verification',details.kind+'-'+crypto.randomUUID());mkdir(directory);
  const streams={};
  for(const name of ['stdout','stderr']){
    const bytes=Buffer.from(details.received?.[name]??'','utf8'),saved=bytes.subarray(0,DIAGNOSTIC_BYTES);
    write(path.join(directory,name+'.txt'),saved);
    streams[name]={savedBytes:saved.length,observedBytes:details.received?.[name+'ObservedBytes']??bytes.length,truncated:bytes.length>saved.length||details.received?.[name+'CaptureTruncated']===true};
  }
  const records=[];
  for(const name of SELF_TEST_RECORDS[details.kind])try{
    const bytes=boundedNativeRecord(path.join(details.recordRoot,name+'.json')),file='native-record-'+name+'.json';write(path.join(directory,file),bytes);records.push({name,file,status:'saved',bytes:bytes.length,sha256:hash(bytes)});
  }catch(error){records.push({name,status:error.code==='ENOENT'?'missing':'unavailable',code:/^[A-Z_]+$/u.test(error.message??'')?error.message:(error.code??'UNAVAILABLE')});}
  let reportCapture='absent';
  if(details.report!==null&&details.report!==undefined)try{
    const text=JSON.stringify(details.report);if(Buffer.byteLength(text)<=65536){write(path.join(directory,'report.json'),text+'\n');reportCapture='saved';}else reportCapture='limit';
  }catch{reportCapture='unavailable';}
  const summary={schema:'aaw.native-self-test-diagnostic/v1',kind:details.kind,status:details.okay?'PASS':'FAIL',buildId:details.buildId,executionId:details.executionId,
    exitCode:details.received?.code??null,signal:details.received?.signal??null,closed:details.received?.closed??false,transportError:details.received?.transportError??null,
    streams,reportCapture,failures:details.failures??[],cleanup:{confirmed:details.report?.cleanupConfirmed??false,activeProcesses:details.report?.activeProcesses??details.report?.job?.activeProcesses??null,aclRestored:details.report?.aclRestored??null,profileDeleted:details.report?.profileDeleted??null},
    records,...(details.health?{health:details.health}:{}),scope:'Fixed synthetic self-test only; no host environment, credentials, configuration or binary contents copied.'};
  write(path.join(directory,'result.json'),JSON.stringify(summary,null,2)+'\n');
  const relative=path.relative(paths.root,directory).replaceAll('\\','/');
  if(!details.okay)console.error(JSON.stringify({status:'FAIL',selfTest:details.kind,evidence:relative,failures:summary.failures,exitCode:summary.exitCode,cleanupConfirmed:summary.cleanup.confirmed}));
  return {directory:relative,summary};
}
function compile(toolchain,output,source,name) {
  const {vc,sdkRoot,sdk,compiler}=toolchain,executable=path.join(output,name+'.exe');
  const args=['/nologo','/MT','/EHsc','/W4','/WX','/utf-8','/std:c++20','/DUNICODE','/D_UNICODE','/DAAW_PORTABLE_RUNTIME=1','/sdl','/guard:cf','/Brepro','/I'+path.join(vc,'include'),'/I'+output,
    ...['ucrt','shared','um'].map(part=>'/I'+path.join(sdkRoot,'Include',sdk,part)),
    '/Fo'+path.join(output,name+'.obj'),'/Fd'+path.join(output,name+'.pdb'),'/Fe'+executable,source,'/link',
    '/LIBPATH:'+path.join(vc,'lib/x64'),'/LIBPATH:'+path.join(sdkRoot,'Lib',sdk,'ucrt/x64'),'/LIBPATH:'+path.join(sdkRoot,'Lib',sdk,'um/x64'),
    'userenv.lib','advapi32.lib','kernel32.lib','bcrypt.lib','ole32.lib','shell32.lib','/DYNAMICBASE','/NXCOMPAT','/CETCOMPAT','/guard:cf','/Brepro'];
  const result=spawnSync(compiler,args,{cwd:output,shell:false,windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024,timeout:120000});
  fs.writeFileSync(path.join(output,name+'-compiler.log'),(result.stdout??'')+(result.stderr??''));
  if(result.error||result.status!==0)throw Error('NATIVE_COMPILE_FAILED_'+name);return executable;
}
async function workSelfTest(paths,components,buildId) {
  const {root,dataRoot,runtimeRoot}=paths,id='wce-'+crypto.randomUUID(),execution=path.join(dataRoot,'agent-work-cycle-runner/executions',id),runtime=path.join(execution,'runtime');
  const snapshot=path.join(dataRoot,'runtime-self-test',buildId,id),input=path.join(snapshot,'input'),output=path.join(snapshot,'output');
  for(const directory of [execution,runtime,input,output])mkdir(directory);
  const marker='AAW_PORTABLE_WORK_SELF_TEST',program=`console.log('${marker}');\n`,scriptSha=hash(program),signature=hash(crypto.randomBytes(32)),nonce=crypto.randomBytes(16).toString('hex');
  write(path.join(input,'test.js'),program);write(path.join(runtime,'program.cjs'),program);
  fs.copyFileSync(path.join(root,components.node.path),path.join(runtime,'node.exe'),fs.constants.COPYFILE_EXCL);fs.copyFileSync(path.join(root,components.nodeLicense.path),path.join(runtime,'LICENSE'),fs.constants.COPYFILE_EXCL);
  const native=path.join(root,components.workRunner.path),arguments_=[execution,runtime,input,output,id,signature,nonce,'test.js',scriptSha,`${scriptSha}:${Buffer.byteLength(program)}:test.js`];
  const received=await new Promise(resolve=>{
    const child=spawn(native,arguments_,{cwd:execution,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,SystemDrive:path.parse(process.env.SystemRoot??'C:/Windows').root.slice(0,2)}});
    const chunks=[],errors=[];let bytes=0,errorBytes=0,savedErrors=0,settled=false;
    const finish=(code,signal,closed,transportError=null)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(kill);resolve({code,signal,closed,transportError,stdout:Buffer.concat(chunks).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8'),stdoutObservedBytes:bytes,stderrObservedBytes:errorBytes,stdoutCaptureTruncated:bytes>DIAGNOSTIC_BYTES,stderrCaptureTruncated:errorBytes>savedErrors});};
    const timer=setTimeout(()=>{try{child.stdin.write('C');child.stdin.end();}catch{}},25000);
    const kill=setTimeout(()=>{try{child.kill();}catch{}finish(null,null,false,'WORK_SELF_TEST_TIMEOUT');},40000);
    child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384)child.stdin.end('C');else chunks.push(chunk);});child.stderr.on('data',chunk=>{errorBytes+=chunk.length;const available=DIAGNOSTIC_BYTES-savedErrors;if(available>0){const saved=chunk.subarray(0,available);errors.push(saved);savedErrors+=saved.length;}});
    child.once('error',error=>finish(null,null,false,error.code??'WORK_SELF_TEST_START_ERROR'));child.once('close',(code,signal)=>finish(code,signal,true));
  });
  let report=null;try{report=JSON.parse(received.stdout.trim());}catch{}
  if(received.transportError||report===null){persistNativeSelfTestDiagnostics(paths,{kind:'work',buildId,executionId:id,recordRoot:execution,received,report,okay:false,failures:[received.transportError??'report_json_invalid']});throw Error(received.transportError==='WORK_SELF_TEST_TIMEOUT'?'WORK_SELF_TEST_TIMEOUT':'WORK_SELF_TEST_REPORT_INVALID');}
  let stdoutMarker=false;try{stdoutMarker=Buffer.from(report.stdoutHex,'hex').toString('utf8').trim()===marker;}catch{}
  const checks={launcher_exit:received.code===0,report_version:report.version===1,execution_identity:report.executionId===id,signature:report.signature===signature,termination:report.termination==='exited',exit_code:report.exitCode===0,
    appcontainer:report.appContainer===true,zero_capabilities:report.capabilityCount===0,atomic_job:report.atomicJob===true,low_integrity:report.lowIntegrity===true,cleanup:report.cleanupConfirmed===true,acl_restored:report.aclRestored===true,profile_deleted:report.profileDeleted===true,empty_job:report.activeProcesses===0,
    stdout_complete:report.stdoutTruncated===false,stderr_complete:report.stderrTruncated===false,stdout_marker:stdoutMarker,stderr_empty:report.stderrHex===''};
  const failures=Object.entries(checks).filter(([,okay])=>!okay).map(([name])=>name),okay=failures.length===0;
  persistNativeSelfTestDiagnostics(paths,{kind:'work',buildId,executionId:id,recordRoot:execution,received,report,okay,failures});
  write(path.join(execution,'self-test-report.json'),JSON.stringify({received,report},null,2)+'\n');
  if(!okay)throw Error('WORK_SELF_TEST_FAILED');
  const proof={schema:'aaw.portable.work-proof.v1',status:'PASS',nativeSha256:components.workRunner.sha256,runtimeSha256:components.node.sha256,
    appContainer:true,capabilityCount:0,atomicJob:true,cleanupConfirmed:true,aclRestored:true,profileDeleted:true,activeProcesses:0,
    executionId:id,signature,reportSha256:hash(received.stdout),testedAt:new Date().toISOString(),scope:'single synthetic stdout marker; no model/project/WSL/OA/EDA'};
  const proofFile=write(path.join(runtimeRoot,'build',buildId,'work-proof.json'),JSON.stringify(proof,null,2)+'\n');publish(root,proofFile,path.join(runtimeRoot,'work-proof.json'),buildId);
  return {...ref(root,path.join(runtimeRoot,'work-proof.json')),sources:[]};
}
async function guardianSelfTest(paths,components,buildId) {
  const {root,dataRoot,runtimeRoot}=paths,execution=path.join(dataRoot,'agent-engine-pilot/native',crypto.randomUUID());mkdir(execution);
  const directories={};for(const name of ['cwd','home','appdata','localappdata','temp','config','data','cache','state','managed']){directories[name]=path.join(execution,name);mkdir(directories[name]);}
  const configDirectory=path.join(directories.config,'opencode');mkdir(configDirectory);
  write(path.join(directories.cwd,'package.json'),'{"private":true}\n');write(path.join(directories.cwd,'tsconfig.json'),'{"compilerOptions":{}}\n');
  const userNpmrc=write(path.join(execution,'user.npmrc'),''),globalNpmrc=write(path.join(execution,'global.npmrc'),''),models=write(path.join(directories.cache,'models.json'),'{}\n');
  write(path.join(directories.cwd,'.npmrc'),'offline=true\naudit=false\nregistry=http://127.0.0.1:9\n');
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const password=crypto.randomBytes(32).toString('hex'),configuration={username:'setup-self-test',autoupdate:false,snapshot:false,share:'disabled',plugin:[],mcp:{},instructions:[],enabled_providers:[],skills:{paths:[],urls:[]},lsp:false,formatter:false,permission:{'*':'deny'}};
  const windows=path.resolve(process.env.SystemRoot??'C:/Windows'),environment={SystemRoot:windows,WINDIR:windows,PATH:path.join(windows,'System32'),HOME:directories.home,USERPROFILE:directories.home,APPDATA:directories.appdata,LOCALAPPDATA:directories.localappdata,TEMP:directories.temp,TMP:directories.temp,
    XDG_CONFIG_HOME:directories.config,XDG_DATA_HOME:directories.data,XDG_CACHE_HOME:directories.cache,XDG_STATE_HOME:directories.state,OPENCODE_TEST_HOME:directories.home,OPENCODE_TEST_MANAGED_CONFIG_DIR:directories.managed,OPENCODE_CONFIG_DIR:configDirectory,OPENCODE_MODELS_PATH:models,OPENCODE_CONFIG_CONTENT:JSON.stringify(configuration),
    OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_SERVER_PASSWORD:password,npm_config_offline:'true',npm_config_audit:'false',npm_config_registry:'http://127.0.0.1:9',npm_config_cache:directories.cache,npm_config_userconfig:userNpmrc,npm_config_globalconfig:globalNpmrc};
  for(const name of ['OPENCODE_PURE','OPENCODE_DISABLE_AUTOUPDATE','OPENCODE_DISABLE_MODELS_FETCH','OPENCODE_DISABLE_PROJECT_CONFIG','OPENCODE_DISABLE_DEFAULT_PLUGINS','OPENCODE_DISABLE_CLAUDE_CODE','OPENCODE_DISABLE_EXTERNAL_SKILLS','OPENCODE_DISABLE_LSP_DOWNLOAD','OPENCODE_DISABLE_EMBEDDED_WEB_UI','OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER'])environment[name]='true';
  const child=spawn(path.join(root,components.guardian.path),[execution,String(port)],{cwd:directories.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:environment});let closed=false,exitCode=null,exitSignal=null,spawnError=null,stdoutBytes=0,stderrBytes=0;
  child.stdin?.on('error',()=>{});child.stdout?.on('data',chunk=>{stdoutBytes+=chunk.length;});child.stderr?.on('data',chunk=>{stderrBytes+=chunk.length;});
  const exited=new Promise(resolve=>{child.once('error',error=>{closed=true;spawnError=error.code??'GUARDIAN_START_ERROR';resolve();});child.once('close',(code,signal)=>{closed=true;exitCode=code;exitSignal=signal;resolve();});});
  let healthy=false;const deadline=Date.now()+30000,health=[];
  const observe=value=>{health.push(value);if(health.length>8)health.shift();};
  try{while(!closed&&Date.now()<deadline){try{const response=await fetch(`http://127.0.0.1:${port}/global/health`,{headers:{Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')},signal:AbortSignal.timeout(1000),redirect:'error'});const body=await response.json();observe({status:response.status,healthy:body.healthy===true,version:typeof body.version==='string'?body.version.slice(0,64):null});if(response.ok&&body.healthy===true&&body.version==='1.18.17'){healthy=true;break;}}catch(error){observe({status:null,healthy:false,version:null,error:['TimeoutError','AbortError'].includes(error.name)?error.name:'HEALTH_REQUEST_FAILED'});}await new Promise(resolve=>setTimeout(resolve,100));}}
  finally{try{child.stdin.write('C');child.stdin.end();}catch{}await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,6000))]);}
  if(!closed)child.kill();
  let result=null,resultError=null;try{result=JSON.parse(boundedNativeRecord(path.join(execution,'guardian-control/result.json')).toString('utf8'));}catch(error){resultError=error.code==='ENOENT'?'GUARDIAN_RESULT_MISSING':'GUARDIAN_RESULT_INVALID';}
  const checks={closed,healthy,launcher_exit:exitCode===0,result_present:result!==null,cleanup:result?.cleanupConfirmed===true,engine_exited:result?.engineExited===true,empty_job:result?.job?.activeProcesses===0,job_empty_confirmed:result?.job?.emptyConfirmed===true,job_closed:result?.job?.closed===true};
  const failures=Object.entries(checks).filter(([,okay])=>!okay).map(([name])=>name),okay=failures.length===0;
  // Child output is counted only: it may contain the random loopback authentication
  // or startup configuration. Never upload output, environment or config here.
  const received={code:exitCode,signal:exitSignal,closed,transportError:spawnError??resultError??(!closed?'GUARDIAN_CLEANUP_UNCONFIRMED':null),stdout:'',stderr:'',stdoutObservedBytes:stdoutBytes,stderrObservedBytes:stderrBytes,stdoutCaptureTruncated:stdoutBytes>0,stderrCaptureTruncated:stderrBytes>0};
  persistNativeSelfTestDiagnostics(paths,{kind:'guardian',buildId,executionId:path.basename(execution),recordRoot:path.join(execution,'guardian-control'),received,report:result,okay,failures,health});
  if(!closed)throw Error('GUARDIAN_CLEANUP_UNCONFIRMED');
  if(!okay)throw Error('GUARDIAN_SELF_TEST_FAILED');
  const proof={status:'PASS',healthy:true,engineVersion:'1.18.17',nativeSha256:components.guardian.sha256,engineSha256:components.opencode.sha256,cleanupConfirmed:true,activeProcesses:0,testedAt:new Date().toISOString(),scope:'loopback health then stop; no model request'};
  write(path.join(runtimeRoot,'build',buildId,'guardian-self-test.json'),JSON.stringify(proof,null,2)+'\n');return proof;
}

export async function buildPortableNative(paths) {
  const {root,runtimeRoot,dataRoot}=paths,buildId=crypto.randomUUID(),output=path.join(runtimeRoot,'build',buildId);mkdir(output);mkdir(dataRoot);
  const sourceBaseline=sources(root,['tools/agent-engine-lifecycle-guardian.cc','tools/agent-command-runner-native.cc','tools/agent-work-cycle-runner-native.cc','tools/agent-work-cycle-runner-native-security.h','tools/agent-command-runner-bootstrap.ps1','tools/portable-native-build.mjs','tools/portable-runtime-lib.mjs','packages/windows-fs-native/src/addon.cc','packages/windows-fs-native/binding.gyp','apps/desktop/src/shared/agent/agent-work-cycle.ts']);
  const toolchain=findToolchain(),python=findPython(),shell=shellProfile(root),limits=numericLimits(root),wide=value=>'L'+JSON.stringify(value);
  const runtimeHeader=write(path.join(output,'runtime-paths.h'),'#pragma once\nnamespace portable_runtime {\ninline constexpr wchar_t dataLocal[]='+wide(dataRoot+path.sep)+';\ninline constexpr wchar_t installationRuntime[]='+wide(runtimeRoot+path.sep)+';\ninline constexpr wchar_t systemRoot[]='+wide(shell.windows)+';\n}\n');
  const limitHeader=write(path.join(output,'runner-limits.h'),'#pragma once\n#include <cstddef>\nnamespace limits {\n'+Object.entries(limits).map(([key,value])=>'inline constexpr std::size_t '+key+'='+value+';').join('\n')+'\n}\n');
  const declaration={schema:'aaw.command.native-profile.v1',sourceRefs:sources(root,['tools/agent-command-runner-native.cc','tools/agent-work-cycle-runner-native-security.h','tools/agent-command-runner-bootstrap.ps1','tools/portable-native-build.mjs','tools/portable-runtime-lib.mjs']),systemFiles:shell.systemFiles,shellVersion:shell.version,bootstrap:ref(root,path.join(root,'tools/agent-command-runner-bootstrap.ps1')),dataRoot,node:ref(root,path.join(runtimeRoot,'node/node.exe')),license:ref(root,path.join(runtimeRoot,'node/LICENSE')),networkCapabilities:0,projectAccess:'none',baselineReadOnly:true,hostEnvironment:'not_inherited',activeProcesses:8,killOnJobClose:true,breakawayAllowed:false};
  const profileRevision=hash(JSON.stringify(declaration));const environment={environmentId:'windows-powershell-5.1-native',displayName:'Windows PowerShell 5.1 · AppContainer',platform:'windows',shell:{kind:'powershell',version:shell.version,sha256:sha(shell.shell),scriptEncoding:'utf8_bom',interactive:false},tools:[{name:'node',version:'24.20.0',sha256:NODE_SHA256}],isolation:'windows-appcontainer-job',profileRevision,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:16777216,defaultTimeoutMs:120000,maxTimeoutMs:600000}};environment.revision=hash(JSON.stringify(environment));
  const commandHeader=write(path.join(output,'command-profile.h'),'#pragma once\nnamespace profile {\ninline constexpr wchar_t shellPath[]='+wide(shell.shell)+';\ninline constexpr char revision[]='+JSON.stringify(profileRevision)+';\ninline constexpr unsigned long long bootstrapBytes='+declaration.bootstrap.bytes+';\ninline constexpr char bootstrapSha256[]='+JSON.stringify(declaration.bootstrap.sha256)+';\nstruct File {const wchar_t* path;unsigned long long bytes;const char* sha256;};\ninline constexpr File systemFiles[]={\n'+shell.systemFiles.map(file=>'{'+wide(file.path)+','+file.bytes+','+JSON.stringify(file.sha256)+'}').join(',\n')+'\n};\n}\n');
  const generatedBaseline=[runtimeHeader,limitHeader,commandHeader].map(file=>ref(root,file));
  const unchanged=()=>sourceBaseline.every(file=>sha(path.join(root,file.path))===file.sha256)&&generatedBaseline.every(file=>sha(path.join(root,file.path))===file.sha256)&&sha(toolchain.compiler)===toolchain.compilerSha256;
  const binaries={guardian:compile(toolchain,output,path.join(root,'tools/agent-engine-lifecycle-guardian.cc'),'guardian'),commandRunner:compile(toolchain,output,path.join(root,'tools/agent-command-runner-native.cc'),'command-runner'),workRunner:compile(toolchain,output,path.join(root,'tools/agent-work-cycle-runner-native.cc'),'work-runner')};
  const fsSource=path.join(output,'fs-source');mkdir(path.join(fsSource,'src'));fs.copyFileSync(path.join(root,'packages/windows-fs-native/src/addon.cc'),path.join(fsSource,'src/addon.cc'));fs.copyFileSync(path.join(root,'packages/windows-fs-native/binding.gyp'),path.join(fsSource,'binding.gyp'));
  const gypArgs=[nodeGyp(),'rebuild','--release','--directory='+fsSource,'--nodedir='+path.join(runtimeRoot,'node/headers'),'--msvs_version=2022','--python='+python.path];
  const gyp=spawnSync(process.execPath,gypArgs,{cwd:root,shell:false,windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024,timeout:180000,env:{...process.env,GYP_MSVS_VERSION:'2022'}});fs.writeFileSync(path.join(output,'windows-fs-compiler.log'),(gyp.stdout??'')+(gyp.stderr??''));if(gyp.error||gyp.status!==0)throw Error('NODE_GYP_BUILD_FAILED_PYTHON_AND_VS_REQUIRED');
  const fsBinary=path.join(fsSource,'build/Release/aaw_windows_fs_native.node');
  if(!unchanged())throw Error('NATIVE_BUILD_INPUT_CHANGED');
  const components={opencode:{...ref(root,path.join(runtimeRoot,'opencode/1.18.17/opencode.exe')),version:'1.18.17',sources:[]},node:{...ref(root,path.join(runtimeRoot,'node/node.exe')),sources:[]},nodeLicense:{...ref(root,path.join(runtimeRoot,'node/LICENSE')),sources:[]},commandBootstrap:{...ref(root,path.join(root,'tools/agent-command-runner-bootstrap.ps1')),sources:[]}};
  for(const [id,filename,source] of [['guardian','guardian.exe','tools/agent-engine-lifecycle-guardian.cc'],['commandRunner','command-runner.exe','tools/agent-command-runner-native.cc'],['workRunner','work-runner.exe','tools/agent-work-cycle-runner-native.cc']]){const target=path.join(runtimeRoot,'native',filename);publish(root,binaries[id],target,buildId);components[id]={...ref(root,target),sources:sources(root,[source,'tools/agent-work-cycle-runner-native-security.h','tools/portable-native-build.mjs','tools/portable-runtime-lib.mjs'])};}
  const fsTarget=path.join(runtimeRoot,'native/windows-fs-native.node');publish(root,fsBinary,fsTarget,buildId);components.windowsFs={...ref(root,fsTarget),sources:sources(root,['packages/windows-fs-native/src/addon.cc','packages/windows-fs-native/binding.gyp','tools/portable-native-build.mjs','tools/portable-runtime-lib.mjs'])};
  const admission={schema:'aaw.command.runtime-admission.v1',status:'BUILT_ONLY',environment,native:components.commandRunner,runtime:{node:components.node,license:components.nodeLicense,bootstrap:components.commandBootstrap},profileRevision,profile:declaration,verificationRequired:'Run tools/verify-desktop-runtime.mjs with the same storage root; building alone does not grant command execution.'};
  const admissionCandidate=write(path.join(output,'command-admission.json'),JSON.stringify(admission,null,2)+'\n');publish(root,admissionCandidate,path.join(runtimeRoot,'command-admission.json'),buildId);components.commandAdmission={...ref(root,path.join(runtimeRoot,'command-admission.json')),sources:[]};
  components.workProof=await workSelfTest(paths,components,buildId);const guardianProof=await guardianSelfTest(paths,components,buildId);
  if(!unchanged())throw Error('NATIVE_BUILD_INPUT_CHANGED');
  const manifest={schemaVersion:'aaw.desktop-runtime/v1',platform:'win32',arch:'x64',nodeVersion:'24.20.0',dataRoot,components,build:{id:buildId,exitCode:0,compiler:{path:toolchain.compiler,sha256:toolchain.compilerSha256},python,sdk:toolchain.sdk,generated:[runtimeHeader,limitHeader,commandHeader].map(file=>ref(root,file)),guardianSelfTest:guardianProof,commandStatus:'built_only'}};
  const manifestCandidate=write(path.join(output,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n');publish(root,manifestCandidate,path.join(runtimeRoot,'runtime-manifest.json'),buildId);
  console.log(JSON.stringify({status:'BUILT_AND_NATIVE_SELF_TESTED',commandAdmission:'BUILT_ONLY',buildId,manifest:'.local/runtime/runtime-manifest.json'}));
  return manifest;
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename))await buildPortableNative(layout(path.resolve(import.meta.dirname,'..'),parseOptions(process.argv.slice(2)).storageRoot));
