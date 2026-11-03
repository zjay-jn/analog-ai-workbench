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
  const received=await new Promise((resolve,reject)=>{
    const child=spawn(native,arguments_,{cwd:execution,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,SystemDrive:path.parse(process.env.SystemRoot??'C:/Windows').root.slice(0,2)}});
    const chunks=[],errors=[];let bytes=0;const timer=setTimeout(()=>{try{child.stdin.write('C');child.stdin.end();}catch{}},25000);
    const kill=setTimeout(()=>{child.kill();reject(Error('WORK_SELF_TEST_TIMEOUT'));},40000);
    child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384)child.stdin.end('C');else chunks.push(chunk);});child.stderr.on('data',chunk=>errors.push(chunk));
    child.once('error',reject);child.once('close',code=>{clearTimeout(timer);clearTimeout(kill);resolve({code,stdout:Buffer.concat(chunks).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8')});});
  });
  const report=JSON.parse(received.stdout.trim());
  const okay=received.code===0&&report.version===1&&report.executionId===id&&report.signature===signature&&report.termination==='exited'&&report.exitCode===0
    &&report.appContainer===true&&report.capabilityCount===0&&report.atomicJob===true&&report.lowIntegrity===true&&report.cleanupConfirmed===true&&report.aclRestored===true&&report.profileDeleted===true&&report.activeProcesses===0
    &&report.stdoutTruncated===false&&report.stderrTruncated===false&&Buffer.from(report.stdoutHex,'hex').toString('utf8').trim()===marker&&report.stderrHex==='';
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
  const child=spawn(path.join(root,components.guardian.path),[execution,String(port)],{cwd:directories.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:environment});let closed=false,exitCode=null;child.stdin.on('error',()=>{});child.stdout.resume();child.stderr.resume();
  const exited=new Promise(resolve=>{child.once('error',()=>{closed=true;resolve();});child.once('close',code=>{closed=true;exitCode=code;resolve();});});
  let healthy=false;const deadline=Date.now()+30000;
  try{while(!closed&&Date.now()<deadline){try{const response=await fetch(`http://127.0.0.1:${port}/global/health`,{headers:{Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')},signal:AbortSignal.timeout(1000),redirect:'error'});const body=await response.json();if(response.ok&&body.healthy===true&&body.version==='1.18.17'){healthy=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}}
  finally{try{child.stdin.write('C');child.stdin.end();}catch{}await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,6000))]);}
  if(!closed){child.kill();throw Error('GUARDIAN_CLEANUP_UNCONFIRMED');}
  const result=JSON.parse(fs.readFileSync(path.join(execution,'guardian-control/result.json'),'utf8'));
  if(!healthy||exitCode!==0||result.cleanupConfirmed!==true||result.engineExited!==true||result.job?.activeProcesses!==0||result.job.emptyConfirmed!==true||result.job.closed!==true)throw Error('GUARDIAN_SELF_TEST_FAILED');
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
