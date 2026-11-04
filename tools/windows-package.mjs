import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {auditSource} from './public-release/index.mjs';
import {ordinary,sha,findToolchain,download,NODE_SHA256,NODE_LICENSE_SHA256,OPENCODE_SHA256} from './portable-runtime-lib.mjs';
import {buildPackagedNative} from './packaged-native-build.mjs';
import {installerScript,preflightHeader,packageDirectories,safePackagePath,INSTALLER_MARKER,INSTALLER_MARKER_BYTES,UNINSTALLER} from './windows-installer-script.mjs';

export const NSIS_VERSION='3.13';
export const NSIS_SHA256='ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
export const ELECTRON_ARCHIVE_SHA256='ef0709cfa719739acce73de6f9b684304baf38c6454376638a70d34a7cecffe0';
const root=path.resolve(import.meta.dirname,'..');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const slash=value=>value.replaceAll(path.sep,'/');
const locations={opencode:'.local/runtime/opencode/1.18.17/opencode.exe',guardian:'.local/runtime/native/guardian.exe',windowsFs:'.local/runtime/native/windows-fs-native.node',commandRunner:'.local/runtime/native/command-runner.exe',workRunner:'.local/runtime/native/work-runner.exe',node:'.local/runtime/node/node.exe',nodeLicense:'.local/runtime/node/LICENSE',commandBootstrap:'tools/agent-command-runner-bootstrap.ps1'};
const toolFiles=['tools/agent-engine-pilot-sum.mjs','tools/agent-project-read-tools.mjs','tools/agent-command-runner-bootstrap.ps1'];
function mkdir(directory){fs.mkdirSync(directory,{recursive:true});ordinary(directory,true);}
function write(file,bytes){mkdir(path.dirname(file));fs.writeFileSync(file,bytes,{flag:'wx'});ordinary(file);}
function copy(source,target){ordinary(source);mkdir(path.dirname(target));fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);if(sha(source)!==sha(target))throw Error('PACKAGE_COPY_MISMATCH');}
export function inventory(directory){
  ordinary(directory,true);const files=[];
  function visit(current){for(const item of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const absolute=path.join(current,item.name),relative=slash(path.relative(directory,absolute));if(!safePackagePath(relative))throw Error('PACKAGE_PATH_INVALID');if(item.isDirectory()){ordinary(absolute,true);visit(absolute);}else{const info=ordinary(absolute);files.push({path:relative,bytes:info.size,sha256:sha(absolute)});}}}
  visit(directory);return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
function copyTree(source,target,exclude=()=>false){for(const file of inventory(source)){if(!exclude(file.path))copy(path.join(source,...file.path.split('/')),path.join(target,...file.path.split('/')));}}
function run(executable,args,{cwd=root,timeout=180000,log,env=process.env}={}){const clean={...env};for(const name of Object.keys(clean))if(/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|ELECTRON_OVERRIDE_DIST_PATH|NSISDIR|NSISCONFDIR)$/iu.test(name))delete clean[name];const r=spawnSync(executable,args,{cwd,env:clean,shell:false,windowsHide:true,encoding:'utf8',timeout,maxBuffer:8*1024*1024});if(log)write(log,(r.stdout??'')+(r.stderr??''));if(r.error||r.status!==0)throw Error('PACKAGE_TOOL_FAILED_'+(r.error?.code??r.status));return r.stdout;}
function git(args){return run('C:/Program Files/Git/cmd/git.exe',args,{timeout:30000}).trim();}
async function sdk(directory,explicitArchive){
  const cache=path.join(root,'.local/windows-installer/downloads');mkdir(cache);let archive;
  if(explicitArchive){archive=path.resolve(explicitArchive);if(ordinary(archive).size>8*1024*1024||sha(archive)!==NSIS_SHA256)throw Error('NSIS_CACHE_CHANGED');}
  else{archive=path.join(cache,'nsis-3.13.zip');await download('https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip',archive,NSIS_SHA256,8*1024*1024);}
  if(sha(archive)!==NSIS_SHA256)throw Error('NSIS_ARCHIVE_CHANGED');
  const target=path.join(directory,'nsis-sdk');const{extract}=await import('@electron-internal/extract-zip');await extract(archive,{dir:target});
  const sdkRoot=path.join(target,'nsis-3.13');ordinary(sdkRoot,true);if(!run(path.join(sdkRoot,'makensis.exe'),['/VERSION'],{cwd:sdkRoot}).includes('v3.13'))throw Error('NSIS_VERSION_CHANGED');
  return {root:sdkRoot,archive:{bytes:ordinary(archive).size,sha256:NSIS_SHA256}};
}
async function electronSdk(directory,explicitArchive){
  const cache=path.join(root,'.local/windows-installer/downloads');mkdir(cache);let archive;
  if(explicitArchive){archive=path.resolve(explicitArchive);if(ordinary(archive).size>256*1024*1024||sha(archive)!==ELECTRON_ARCHIVE_SHA256)throw Error('ELECTRON_CACHE_CHANGED');}
  else{archive=path.join(cache,'electron-v43.4.0-win32-x64.zip');await download('https://github.com/electron/electron/releases/download/v43.4.0/electron-v43.4.0-win32-x64.zip',archive,ELECTRON_ARCHIVE_SHA256,256*1024*1024);}
  if(sha(archive)!==ELECTRON_ARCHIVE_SHA256)throw Error('ELECTRON_ARCHIVE_CHANGED');
  const target=path.join(directory,'electron-sdk');const{extract}=await import('@electron-internal/extract-zip');await extract(archive,{dir:target});
  // Only this fresh extraction of the fixed official ZIP is an input. A mutable
  // node_modules/electron/dist directory is never promoted into a distribution.
  ordinary(path.join(target,'electron.exe'));const files=inventory(target);
  return {root:target,archive:{bytes:ordinary(archive).size,sha256:ELECTRON_ARCHIVE_SHA256},files};
}
export function compilePreflight(directory,files){
  const target=path.join(directory,'preflight');mkdir(target);write(path.join(target,'installer-files.h'),preflightHeader(files));
  const toolchain=findToolchain(),{vc,sdkRoot,sdk,compiler}=toolchain,output=path.join(target,'preflight.exe');
  const arguments_=['/nologo','/MT','/EHsc','/W4','/WX','/utf-8','/std:c++20','/DUNICODE','/D_UNICODE','/sdl','/guard:cf','/Brepro','/I'+path.join(vc,'include'),'/I'+target,...['ucrt','shared','um'].map(part=>'/I'+path.join(sdkRoot,'Include',sdk,part)),'/Fo'+path.join(target,'preflight.obj'),'/Fe'+output,path.join(root,'tools/windows-installer-preflight.cc'),'/link','/SUBSYSTEM:WINDOWS','/LIBPATH:'+path.join(vc,'lib/x64'),'/LIBPATH:'+path.join(sdkRoot,'Lib',sdk,'ucrt/x64'),'/LIBPATH:'+path.join(sdkRoot,'Lib',sdk,'um/x64'),'kernel32.lib','shell32.lib','ole32.lib','user32.lib','advapi32.lib','/DYNAMICBASE','/NXCOMPAT','/CETCOMPAT','/guard:cf','/Brepro'];
  run(compiler,arguments_,{cwd:target,log:path.join(target,'compiler.log')});return {path:output,bytes:ordinary(output).size,sha256:sha(output),sourceSha256:sha(path.join(root,'tools/windows-installer-preflight.cc')),headerSha256:sha(path.join(target,'installer-files.h'))};
}
function thirdPartyNotices(appRoot,electronRoot,nsisRoot){
  const target=path.join(appRoot,'licenses');mkdir(target);copy(path.join(root,'LICENSE'),path.join(target,'Workbench-LICENSE'));
  copy(path.join(root,'docs/public/THIRD_PARTY_NOTICES.md'),path.join(target,'THIRD_PARTY_NOTICES.md'));
  copy(path.join(root,'docs/public/DEPENDENCY_LICENSES.json'),path.join(target,'DEPENDENCY_LICENSES.json'));
  copy(path.join(electronRoot,'LICENSE'),path.join(target,'Electron-LICENSE'));copy(path.join(electronRoot,'LICENSES.chromium.html'),path.join(target,'Electron-LICENSES.chromium.html'));
  for(const name of ['COPYING','LICENSE','License.txt']){const file=path.join(nsisRoot,name);if(fs.existsSync(file))copy(file,path.join(target,'NSIS-'+name));}
  const runtimeNotices=path.join(root,'tools/runtime-licenses');if(!fs.existsSync(runtimeNotices))throw Error('RUNTIME_LICENSE_NOTICES_REQUIRED');copyTree(runtimeNotices,path.join(target,'runtime'));
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  const included=[];
  for(const[relative,item]of Object.entries(lock.packages)){if(!relative||!relative.startsWith('node_modules/')||relative.includes('..'))continue;const directory=path.join(root,...relative.split('/'));if(!fs.existsSync(directory))continue;ordinary(directory,true);const metadata=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));if(metadata.version!==item.version)throw Error('DEPENDENCY_LICENSE_VERSION_CHANGED');const destination=relative.replaceAll('node_modules/','').replaceAll('/','__');for(const name of fs.readdirSync(directory).sort()){if(!/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(name))continue;const source=path.join(directory,name);if(!fs.lstatSync(source).isFile())continue;if(ordinary(source).size>2*1024*1024)throw Error('DEPENDENCY_NOTICE_TOO_LARGE');copy(source,path.join(target,'npm',destination,name));included.push({package:metadata.name,version:metadata.version,path:'licenses/npm/'+destination+'/'+name});}}
  write(path.join(target,'notice-inventory.json'),JSON.stringify({schemaVersion:'aaw.binary-notices/v1',scope:'License texts for installed npm build/runtime dependencies and fixed binary SDKs; inclusion does not mean every listed development package is linked into the product.',included},null,2)+'\n');
}
export async function buildWindowsInstaller(options={}){
  if(process.platform!=='win32'||process.arch!=='x64'||process.version!=='v24.20.0')throw Error('WINDOWS_X64_PINNED_NODE_REQUIRED');
  const start=await auditSource({sourceRoot:root});if(start.blockers.length)throw Error('PACKAGE_SOURCE_AUDIT_FAILED');
  const commit=git(['rev-parse','HEAD']),dirty=!!git(['status','--porcelain']);if(dirty&&!options.allowDirty)throw Error('PACKAGE_CLEAN_SOURCE_REQUIRED');
  const directory=path.join(root,'.local/windows-installer','build-'+crypto.randomUUID());mkdir(directory);
  const dependency=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),version=dependency.version;
  const nsis=await sdk(directory,options.nsisArchive),electron=await electronSdk(directory,options.electronArchive);
  const vite=path.join(root,'node_modules/vite/bin/vite.js');
  for(const config of ['vite.main.cloud.config.mts','vite.preload.cloud.config.mts','vite.config.mts'])run(process.execPath,[vite,'build','--config',path.join(root,'apps/desktop',config)],{log:path.join(directory,config+'.log')});
  const {build}=await import('vite');
  const initializer=path.join(directory,'initializer');
  await build({configFile:false,root,define:{__AAW_MAIN_DEVELOPMENT__:'false'},build:{emptyOutDir:false,minify:false,outDir:initializer,ssr:path.join(root,'tools/packaged-runtime-init.ts'),target:'node24',rollupOptions:{output:{format:'cjs',entryFileNames:'packaged-runtime-init.cjs'}}},ssr:{noExternal:true,target:'node'}});
  const native=options.nativeResult?JSON.parse(fs.readFileSync(path.resolve(options.nativeResult),'utf8')):await buildPackagedNative({root,outputDirectory:path.join(directory,'native-build')});
  if(!Array.isArray(native.sources)||native.sources.length<8||!native.sources.some(source=>source.path==='tools/packaged-native-build.mjs')||native.sources.some(source=>!safePackagePath(source.path)||sha(path.join(root,...source.path.split('/')))!==source.sha256))throw Error('PACKAGED_NATIVE_SOURCES_CHANGED');
  const payloadRoot=path.join(directory,'payload');mkdir(payloadRoot);const electronRoot=electron.root;
  copyTree(electronRoot,payloadRoot,file=>file==='electron.exe'||file.startsWith('resources/default_app.asar'));
  copy(path.join(electronRoot,'electron.exe'),path.join(payloadRoot,'AnalogAIWorkbench.exe'));
  if(fs.existsSync(path.join(payloadRoot,'electron_wer.dll')))fs.renameSync(path.join(payloadRoot,'electron_wer.dll'),path.join(payloadRoot,'AnalogAIWorkbench_wer.dll'));
  const appRoot=path.join(payloadRoot,'resources/app');mkdir(appRoot);
  write(path.join(appRoot,'package.json'),JSON.stringify({name:'analog-ai-workbench',productName:'Analog AI Workbench',version,private:true,license:'MIT',main:'dist/cloud/main/index.js'},null,2)+'\n');
  for(const directoryName of ['cloud','renderer'])copyTree(path.join(root,'dist',directoryName),path.join(appRoot,'dist',directoryName));
  for(const name of ['cloud.js','sessions.js'])copy(path.join(root,'dist/preload/preload',name),path.join(appRoot,'dist/preload/preload',name));
  copyTree(initializer,path.join(appRoot,'dist'));
  for(const file of toolFiles)copy(path.join(root,...file.split('/')),path.join(appRoot,...file.split('/')));
  for(const id of ['guardian','commandRunner','workRunner','windowsFs']){const pin=native.artifacts[id];if(!pin||ordinary(pin.path).size!==pin.bytes||sha(pin.path)!==pin.sha256)throw Error('PACKAGED_NATIVE_ARTIFACT_CHANGED');copy(pin.path,path.join(appRoot,...locations[id].split('/')));}
  for(const[id,expected]of [['node',NODE_SHA256],['nodeLicense',NODE_LICENSE_SHA256],['opencode',OPENCODE_SHA256]]){const file=path.join(root,...locations[id].split('/'));if(sha(file)!==expected)throw Error('FIXED_SDK_CHANGED');copy(file,path.join(appRoot,...locations[id].split('/')));}
  thirdPartyNotices(appRoot,electronRoot,nsis.root);
  const files=inventory(appRoot),components=Object.fromEntries(Object.entries(locations).map(([id,file])=>{const pin=files.find(f=>f.path===file);if(!pin)throw Error('PACKAGE_COMPONENT_MISSING');return[id,pin];}));
  const manifest={schemaVersion:'aaw.packaged-runtime/v1',platform:'win32',arch:'x64',nodeVersion:'24.20.0',version,sourceRevision:{commit,dirty,sourceSha256:start.planSha256},components,files};
  write(path.join(appRoot,'.local/runtime/package-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  // Exercise the production parser and exact byte inventory before compressing.
  // This checker remains a build artifact, never a second runtime admission path.
  const checker=path.join(directory,'distribution-check');
  await build({configFile:false,root,build:{emptyOutDir:false,minify:false,outDir:checker,ssr:path.join(root,'apps/desktop/src/main/packaged-runtime.ts'),target:'node24',rollupOptions:{output:{format:'cjs',entryFileNames:'check.cjs'}}},ssr:{noExternal:true,target:'node'}});
  const checked=JSON.parse(run(process.execPath,['-e','const {loadPackagedDistribution}=require(process.argv[1]); const value=loadPackagedDistribution(process.argv[2],{exactInventory:true}); console.log(JSON.stringify({status:"PASS",manifestSha256:value.pin.sha256,files:value.manifest.files.length,components:Object.keys(value.components).length}));',path.join(checker,'check.cjs'),appRoot]));
  if(checked.status!=='PASS'||checked.manifestSha256!==sha(path.join(appRoot,'.local/runtime/package-manifest.json'))||checked.files!==files.length||checked.components!==8)throw Error('PACKAGE_PRODUCTION_VERIFIER_FAILED');
  write(path.join(checker,'result.json'),JSON.stringify(checked,null,2)+'\n');
  write(path.join(payloadRoot,INSTALLER_MARKER),INSTALLER_MARKER_BYTES);
  const payload=inventory(payloadRoot),preflight=compilePreflight(directory,payload.map(f=>f.path));
  const output=path.join(directory,`AnalogAIWorkbench-${version}-windows-x64-setup.exe`);
  const script=path.join(directory,'installer.nsi');write(script,'\uFEFF'+installerScript({payloadRoot,files:payload.map(f=>f.path),preflight:preflight.path,licenseFile:path.join(root,'LICENSE'),outputFile:output,version}));
  run(path.join(nsis.root,'makensis.exe'),['/NOCONFIG','/WX',script],{cwd:directory,timeout:600000,log:path.join(directory,'makensis.log')});
  const end=await auditSource({sourceRoot:root});if(end.planSha256!==start.planSha256)throw Error('PACKAGE_SOURCE_CHANGED_DURING_BUILD');
  const receipt={schemaVersion:'aaw.windows-installer-build/v1',status:'BUILT_NOT_YET_INSTALLED',version,sourceRevision:manifest.sourceRevision,packageManifestSha256:sha(path.join(appRoot,'.local/runtime/package-manifest.json')),distributionCheck:checked,payloadRoot,payload,preflight,native,nsis:{version:NSIS_VERSION,...nsis.archive},electron:{version:'43.4.0',...electron.archive,files:electron.files},output:{path:output,bytes:ordinary(output).size,sha256:sha(output)},signed:false,scope:'Offline current-user binary installer; no user data, source SDK, prior runtime admission or model credentials included.'};
  write(path.join(directory,'build-result.json'),JSON.stringify(receipt,null,2)+'\n');write(output+'.sha256',receipt.output.sha256+'  '+path.basename(output)+'\n');
  console.log(JSON.stringify({status:receipt.status,output:receipt.output,receipt:path.join(directory,'build-result.json')}));return receipt;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const options={};for(const value of process.argv.slice(2)){if(value==='--allow-dirty')options.allowDirty=true;else if(value.startsWith('--nsis-archive='))options.nsisArchive=value.slice(15);else if(value.startsWith('--electron-archive='))options.electronArchive=value.slice(19);else if(value.startsWith('--native-result='))options.nativeResult=value.slice(16);else throw Error('WINDOWS_PACKAGE_ARGUMENT_INVALID');}
  await buildWindowsInstaller(options);
}
