import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {layout, mkdir, ordinary, sha, ref, sources, download, run, publish, findToolchain, nodeGyp, findPython, parseOptions, OPENCODE_SHA256, NODE_SHA256, NODE_LICENSE_SHA256} from './portable-runtime-lib.mjs';
import {buildPortableNative} from './portable-native-build.mjs';
import {installedElectron} from './electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'install';
const options = parseOptions(process.argv.slice(mode === process.argv[2] ? 3 : 2));
if (!['install','download','download-native','build','doctor'].includes(mode)) throw Error('USAGE_INSTALL_DOWNLOAD_BUILD_OR_DOCTOR');
const paths = layout(root, options.storageRoot);

function doctor() {
  const checks = [];
  function check(name, operation, requiredFor='runtime') { try { operation(); checks.push({name, requiredFor, ready:true}); } catch(error) { checks.push({name,requiredFor,ready:false,reason:error.message}); } }
  check('locked-npm-node-gyp', () => nodeGyp(), 'build');
  check('visual-studio-cpp-and-windows-sdk', () => findToolchain(), 'build');
  check('python-3-native-build-prerequisite', () => findPython(), 'build');
  check('electron', () => installedElectron(root));
  check('runtime-manifest', () => {
    const file=path.join(paths.runtimeRoot,'runtime-manifest.json'); ordinary(file);
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(value.schemaVersion!=='aaw.desktop-runtime/v1'||value.platform!=='win32'||value.arch!=='x64'||value.nodeVersion!=='24.20.0'||value.dataRoot!==paths.dataRoot)throw Error('RUNTIME_SETUP_FOR_CURRENT_STORAGE_ROOT_REQUIRED');
    const keys=['opencode','guardian','windowsFs','commandRunner','workRunner','workProof','node','nodeLicense','commandBootstrap','commandAdmission'];
    if(Object.keys(value.components).sort().join()!==keys.sort().join())throw Error('RUNTIME_COMPONENT_SET_INVALID');
    for(const component of Object.values(value.components)){const absolute=path.resolve(root,component.path);if(!absolute.startsWith(root+path.sep))throw Error('RUNTIME_COMPONENT_ESCAPE');if(ordinary(absolute).size!==component.bytes||sha(absolute)!==component.sha256)throw Error('RUNTIME_COMPONENT_CHANGED');for(const source of component.sources)if(sha(path.join(root,source.path))!==source.sha256)throw Error('RUNTIME_SOURCE_CHANGED');}
    for(const file of value.build.generated){const absolute=path.resolve(root,file.path);if(!absolute.startsWith(paths.runtimeRoot+path.sep)||ordinary(absolute).size!==file.bytes||sha(absolute)!==file.sha256)throw Error('RUNTIME_BUILD_INPUT_CHANGED');}
    const pathHeaders=value.build.generated.filter(file=>file.path.endsWith('/runtime-paths.h'));
    if(pathHeaders.length!==1)throw Error('RUNTIME_ROOT_BINDING_MISSING');
    const pathHeader=fs.readFileSync(path.join(root,pathHeaders[0].path),'utf8');
    if(!pathHeader.includes('inline constexpr wchar_t dataLocal[]=L'+JSON.stringify(paths.dataRoot+path.sep)+';')||!pathHeader.includes('inline constexpr wchar_t installationRuntime[]=L'+JSON.stringify(paths.runtimeRoot+path.sep)+';'))throw Error('RUNTIME_REBUILD_AFTER_MOVE_REQUIRED');
    const admission=JSON.parse(fs.readFileSync(path.join(root,value.components.commandAdmission.path),'utf8'));
    if(admission.status!=='SCOPED_NATIVE_READY_FOR_INTEGRATION')throw Error('COMMAND_SELF_TEST_REQUIRED');
    const proof=JSON.parse(fs.readFileSync(path.join(root,value.components.workProof.path),'utf8'));
    if(proof.status!=='PASS'||proof.nativeSha256!==value.components.workRunner.sha256||proof.runtimeSha256!==value.components.node.sha256||proof.appContainer!==true||proof.capabilityCount!==0||proof.atomicJob!==true||proof.cleanupConfirmed!==true||proof.aclRestored!==true||proof.profileDeleted!==true||proof.activeProcesses!==0)throw Error('WORK_SELF_TEST_REQUIRED');
    if(value.build.guardianSelfTest?.status!=='PASS'||value.build.guardianSelfTest.nativeSha256!==value.components.guardian.sha256||value.build.guardianSelfTest.engineSha256!==value.components.opencode.sha256)throw Error('GUARDIAN_SELF_TEST_REQUIRED');
  });
  const ready=checks.filter(check=>check.requiredFor==='runtime').every(check=>check.ready),buildPrerequisitesReady=checks.filter(check=>check.requiredFor==='build').every(check=>check.ready);
  console.log(JSON.stringify({status:ready?'READY':'SETUP_REQUIRED',buildPrerequisitesReady,platform:'win32',arch:'x64',storageRoot:paths.storageRoot,checks},null,2));return ready;
}

async function prepareDownloads() {
  mkdir(paths.runtimeRoot);
  const downloads=path.join(paths.runtimeRoot,'downloads');mkdir(downloads);
  const receipts={};
  function verifiedCache(source,target,expected,maxBytes){if(ordinary(source).size>maxBytes||sha(source)!==expected)throw Error('OFFLINE_CACHE_IDENTITY_MISMATCH');publish(root,source,target,'cache-'+crypto.randomUUID());}
  async function engine(){
    const target=path.join(paths.runtimeRoot,'opencode/1.18.17/opencode.exe');
    if(options.opencodeFile){
      const source=path.resolve(options.opencodeFile);if(ordinary(source).size!==178721160||sha(source)!==OPENCODE_SHA256)throw Error('OPENCODE_CACHE_IDENTITY_MISMATCH');
      publish(root,source,target,'opencode-cache-'+crypto.randomUUID());receipts.opencode={source:'explicit_verified_cache',bytes:178721160,sha256:OPENCODE_SHA256};
    }else if(!fs.existsSync(target)){
      const archive=path.join(downloads,'opencode-v1.18.17-windows-x64-baseline.zip');
      await download('https://github.com/anomalyco/opencode/releases/download/v1.18.17/opencode-windows-x64-baseline.zip',archive,'236c0ba23739bf997cdadf121f64c4b7b087e80854bf3175f7327aa137fdd498',64*1024*1024);
      const extracted=path.join(downloads,'opencode-extract-'+crypto.randomUUID());mkdir(extracted);
      const {extract}=await import('@electron-internal/extract-zip');await extract(archive,{dir:extracted});
      const source=path.join(extracted,'opencode.exe');if(ordinary(source).size!==178721160||sha(source)!==OPENCODE_SHA256)throw Error('OPENCODE_EXECUTABLE_HASH_MISMATCH');
      publish(root,source,target,'opencode-'+crypto.randomUUID());receipts.opencode={source:'verified_official_archive',bytes:178721160,sha256:OPENCODE_SHA256};
    }else receipts.opencode={source:'existing_verified_component',bytes:178721160,sha256:OPENCODE_SHA256};
    if(ordinary(target).size!==178721160||sha(target)!==OPENCODE_SHA256)throw Error('OPENCODE_EXECUTABLE_HASH_MISMATCH');
  }
  async function nodeHeaders(){
    const node=path.join(paths.runtimeRoot,'node/node.exe'),license=path.join(paths.runtimeRoot,'node/LICENSE'),nodeLicense=path.join(path.dirname(process.execPath),'LICENSE');
    if(sha(process.execPath)!==NODE_SHA256||sha(nodeLicense)!==NODE_LICENSE_SHA256)throw Error('PINNED_NODE_RUNTIME_REQUIRED');
    publish(root,process.execPath,node,'node-'+crypto.randomUUID());publish(root,nodeLicense,license,'node-'+crypto.randomUUID());
    const archive=path.join(downloads,'node-v24.20.0-headers.tar.gz');
    if(options.nodeHeadersArchive)verifiedCache(path.resolve(options.nodeHeadersArchive),archive,'7b2141e77e66ab23ead6b200c546afc5837136e3075d8a3ac5a67e540dcc59c1',16*1024*1024);
    await download('https://nodejs.org/dist/v24.20.0/node-v24.20.0-headers.tar.gz',archive,'7b2141e77e66ab23ead6b200c546afc5837136e3075d8a3ac5a67e540dcc59c1',16*1024*1024);
    const headers=path.join(paths.runtimeRoot,'node/headers');
    if(!fs.existsSync(path.join(headers,'include/node/node_api.h'))){
      const extracted=path.join(downloads,'node-headers-'+crypto.randomUUID());mkdir(extracted);const tar=path.join(process.env.SystemRoot??'C:/Windows','System32/tar.exe');ordinary(tar,false,true);
      const names=run(tar,['-tzf',archive]).split(/\r?\n/u).filter(Boolean);if(names.some(name=>!name.startsWith('node-v24.20.0/')||name.includes('..')||name.includes('\\')||name.startsWith('/')))throw Error('NODE_HEADER_ARCHIVE_PATH_INVALID');
      run(tar,['-xzf',archive,'-C',extracted]);const source=path.join(extracted,'node-v24.20.0');ordinary(source,true);mkdir(headers);fs.cpSync(source,headers,{recursive:true,errorOnExist:true,force:false});
    }
    if(sha(path.join(headers,'include/node/node_api.h'))!=='2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a')throw Error('NODE_API_HEADER_MISMATCH');
    const nodeLib=path.join(headers,'win-x64/node.lib');if(options.nodeLibFile)verifiedCache(path.resolve(options.nodeLibFile),nodeLib,'63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9',64*1024*1024);
    await download('https://nodejs.org/dist/v24.20.0/win-x64/node.lib',nodeLib,'63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9',64*1024*1024);
    mkdir(path.join(headers,'Release'));fs.copyFileSync(path.join(headers,'win-x64/node.lib'),path.join(headers,'Release/node.lib'));
    receipts.node={source:'current_pinned_node_and_verified_official_headers',version:'24.20.0',sha256:NODE_SHA256,headers:options.nodeHeadersArchive?'explicit_verified_cache':'verified_download_or_existing_archive',importLibrary:options.nodeLibFile?'explicit_verified_cache':'verified_download_or_existing_file'};
  }
  async function electron(){
    if(JSON.parse(fs.readFileSync(path.join(root,'node_modules/electron/package.json'),'utf8')).version!=='43.4.0')throw Error('NPM_CI_REQUIRED');
    const environment={...process.env};for(const name of Object.keys(environment))if(/^ELECTRON_|^npm_config_electron/iu.test(name)||['GH_TOKEN','GITHUB_TOKEN','NODE_AUTH_TOKEN','NPM_TOKEN'].includes(name))delete environment[name];
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(root,'node_modules/electron/install.js')],{cwd:root,env:environment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();
      const timer=setTimeout(()=>{child.kill();reject(Error('ELECTRON_INSTALL_TIMEOUT'));},1800000);const progress=setInterval(()=>console.log(JSON.stringify({event:'electron-installer-running',version:'43.4.0'})),30000);const clear=()=>{clearTimeout(timer);clearInterval(progress);};child.once('error',error=>{clear();reject(error);});child.once('close',code=>{clear();code===0?resolve():reject(Error('ELECTRON_LOCKED_INSTALL_FAILED'));});
    });
    installedElectron(root);receipts.electron={source:'locked_official_installer_with_checksum_validated_cache_support',version:'43.4.0'};
  }
  const outcomes=await Promise.allSettled([engine(),nodeHeaders(),...(mode==='download-native'?[]:[electron()])]);
  const failures=outcomes.flatMap((outcome,index)=>outcome.status==='rejected'?[{component:['opencode','node','electron'][index],reason:outcome.reason?.message??'DOWNLOAD_FAILED'}]:[]);
  const receipt={status:failures.length?'INCOMPLETE':'VERIFIED',mode,scope:mode==='download-native'?'native SDK dependencies only; Electron excluded':'desktop runtime dependency preparation',completedAt:new Date().toISOString(),receipts,failures};
  const history=path.join(downloads,'history');mkdir(history);
  const receiptText=JSON.stringify(receipt,null,2)+'\n';fs.writeFileSync(path.join(history,crypto.randomUUID()+'.json'),receiptText,{flag:'wx'});
  fs.writeFileSync(path.join(paths.runtimeRoot,'downloads-receipt.json'),receiptText);
  if(failures.length){console.log(JSON.stringify({status:'DOWNLOADS_INCOMPLETE',failures}));throw Error('RUNTIME_DOWNLOADS_INCOMPLETE');}
  console.log(JSON.stringify({status:'DOWNLOADS_VERIFIED',receipts}));
}

if(mode==='doctor'){if(!doctor())process.exitCode=1;}
else{
  mkdir(paths.runtimeRoot);
  const lock=path.join(paths.runtimeRoot,'setup.lock');const descriptor=fs.openSync(lock,'wx');
  try{
    fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');
    if(mode==='install'||mode==='download'||mode==='download-native')await prepareDownloads();
    if(mode==='install'||mode==='build'){
      await buildPortableNative(paths);
      const verifier=path.join(root,'tools/verify-desktop-runtime.mjs');ordinary(verifier);
      run(process.execPath,[verifier,'--storage-root='+paths.storageRoot],{cwd:root,timeout:180000});
    }
  }finally{fs.closeSync(descriptor);fs.unlinkSync(lock);}
  if(!['download','download-native'].includes(mode)&&!doctor())process.exitCode=1;
}
