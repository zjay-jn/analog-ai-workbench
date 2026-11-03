import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import {parseInstallerSmokeArguments,validateInstallerReceipt,verifyInstallerBuildInput,snapshotInstallerTree,sameInstallerSnapshot,assertFreshInstallerRoots,installerSmokeEnvironment,parseInstalledSmokeOutput,validateInstalledSmokeSummary} from '../tools/windows-installer-smoke.mjs';
import {INSTALLER_MARKER,INSTALLER_MARKER_BYTES} from '../tools/windows-installer-script.mjs';

const root=path.resolve(import.meta.dirname,'..'),parent=path.join(root,'.local/windows-installer-smoke-tests');fs.mkdirSync(parent,{recursive:true});
const fixture=()=>fs.mkdtempSync(path.join(parent,'case-')),digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function buildFixture(){const directory=fixture(),payloadRoot=path.join(directory,'payload');fs.mkdirSync(payloadRoot);const files=[
  [INSTALLER_MARKER,INSTALLER_MARKER_BYTES],['AnalogAIWorkbench.exe','synthetic executable; never run'],['resources/app/.local/runtime/native/command-runner.exe','synthetic profile executable; never run'],['resources/app/.local/runtime/package-manifest.json','synthetic package manifest'],
  ...['resources/app/.local/runtime/native/guardian.exe','resources/app/.local/runtime/native/work-runner.exe','resources/app/.local/runtime/native/windows-fs-native.node','resources/app/.local/runtime/node/node.exe','resources/app/.local/runtime/node/LICENSE','resources/app/.local/runtime/opencode/1.18.17/opencode.exe','resources/app/tools/agent-command-runner-bootstrap.ps1'].map(name=>[name,'synthetic required '+name]),
  ...Array.from({length:156},(_,index)=>['assets/asset-'+index+'.txt','synthetic asset '+index])];
  const payload=files.map(([name,body])=>{const file=path.join(payloadRoot,...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);return {path:name,bytes:Buffer.byteLength(body),sha256:digest(body)};});
  const output=path.join(directory,'AnalogAIWorkbench-0.1.0-alpha.0-windows-x64-setup.exe'),text='synthetic installer; never executed';fs.writeFileSync(output,text);
  const receipt={schemaVersion:'aaw.windows-installer-build/v1',status:'BUILT_NOT_YET_INSTALLED',version:'0.1.0-alpha.0',payloadRoot,payload,packageManifestSha256:digest('synthetic package manifest'),output:{path:output,bytes:Buffer.byteLength(text),sha256:digest(text)}},receiptFile=path.join(directory,'build-result.json');fs.writeFileSync(receiptFile,JSON.stringify(receipt));return {directory,receipt,receiptFile};}

test('CLI accepts exactly one explicit absolute build receipt, never installation/data overrides',()=>{
  const file=path.join(fixture(),'build-result.json');assert.deepEqual(parseInstallerSmokeArguments(['--build-result='+file]),{buildResult:file});
  for(const args of [[],['--build-result=relative.json'],['--build-result='+file,'--build-result='+file],['--build-result='+file,'--storage-root='+fixture()],['--exe='+file]])assert.throws(()=>parseInstallerSmokeArguments(args));
});
test('exact build payload and installer bytes must match the single receipt',()=>{
  const {receipt,receiptFile}=buildFixture();assert.equal(verifyInstallerBuildInput(receipt,receiptFile),receipt);
  fs.writeFileSync(receipt.output.path,'changed installer');assert.throws(()=>verifyInstallerBuildInput(receipt,receiptFile),/SMOKE_PIN_CHANGED/);
});
test('tampered, missing and extra source payload are refused before any install can start',()=>{
  for(const change of ['tamper','missing','extra']){const {receipt,receiptFile}=buildFixture(),file=path.join(receipt.payloadRoot,'assets/asset-0.txt');if(change==='tamper')fs.writeFileSync(file,'changed');if(change==='missing')fs.unlinkSync(file);if(change==='extra')fs.writeFileSync(path.join(receipt.payloadRoot,'unknown.txt'),'unexpected');assert.throws(()=>verifyInstallerBuildInput(receipt,receiptFile),/INSTALLER_SOURCE_PAYLOAD_CHANGED/);}
});
test('receipt paths, case collisions and count cannot expand installer authority',()=>{
  const {receipt,receiptFile}=buildFixture();const change=mutate=>{const value=structuredClone(receipt);mutate(value);assert.throws(()=>validateInstallerReceipt(value,receiptFile));};
  change(value=>{value.payload=[];});change(value=>{value.payload=Array(10001).fill(value.payload[0]);});change(value=>{value.payload.slice(0,3).forEach(item=>{item.bytes=512*1024*1024;});});change(value=>{value.payload[4].path='../outside';});change(value=>{value.payload[4].path='AnalogAIWorkbench.EXE';});change(value=>{value.payload[4].path='AnalogAIWorkbench.exe/child';});change(value=>{value.output.path=path.join(fixture(),'arbitrary.exe');});change(value=>{value.payloadRoot=fixture();});change(value=>{value.packageManifestSha256='0'.repeat(64);});
  const missing=structuredClone(receipt);missing.payload.pop();assert.throws(()=>verifyInstallerBuildInput(missing,receiptFile),/INSTALLER_SOURCE_PAYLOAD_CHANGED/);
});
test('even empty existing installation or data roots are rejected; only absent synthetic roots pass',()=>{
  const directory=fixture(),installation=path.join(directory,'install'),storage=path.join(directory,'userdata');assert.doesNotThrow(()=>assertFreshInstallerRoots(installation,storage));fs.mkdirSync(storage);assert.throws(()=>assertFreshInstallerRoots(installation,storage),/EXISTING_USER_INSTALLATION_OR_DATA_REFUSED/);
  const other=fixture();fs.mkdirSync(path.join(other,'install'));assert.throws(()=>assertFreshInstallerRoots(path.join(other,'install'),path.join(other,'data')),/EXISTING_USER_INSTALLATION_OR_DATA_REFUSED/);
});
test('userdata comparison hashes every file and detects byte or directory changes',()=>{
  const directory=fixture();fs.mkdirSync(path.join(directory,'nested'));fs.writeFileSync(path.join(directory,'nested/store.json'),'{"synthetic":true}');const before=snapshotInstallerTree(directory);assert(sameInstallerSnapshot(before,snapshotInstallerTree(directory)));
  fs.writeFileSync(path.join(directory,'nested/store.json'),'{"synthetic":false}');assert.equal(sameInstallerSnapshot(before,snapshotInstallerTree(directory)),false);fs.mkdirSync(path.join(directory,'extra'));assert.equal(sameInstallerSnapshot(before,snapshotInstallerTree(directory)),false);
});
test('userdata snapshots fail closed on links instead of traversing external contents',{skip:process.platform!=='win32'},()=>{
  const directory=fixture(),outside=fixture();fs.writeFileSync(path.join(outside,'sentinel'),'untouched');fs.symlinkSync(outside,path.join(directory,'alias'),'junction');assert.throws(()=>snapshotInstallerTree(directory));assert.equal(fs.readFileSync(path.join(outside,'sentinel'),'utf8'),'untouched');
  const hard=fixture();fs.writeFileSync(path.join(hard,'input.txt'),'synthetic');fs.linkSync(path.join(hard,'input.txt'),path.join(outside,'hard-link'));assert.throws(()=>snapshotInstallerTree(hard));
});
test('installer environment contains only explicit OS locations and no development/tool/credential inheritance',()=>{
  const directory=fixture(),folders=Object.fromEntries(['profile','localAppData','roamingAppData','temporaryDirectory'].map(name=>[name,path.join(directory,name)])),system=path.join(directory,'Windows'),env=installerSmokeEnvironment(folders,system);assert.equal(env.PATH,path.join(system,'System32'));assert.equal(env.APPDATA,folders.roamingAppData);assert.equal(env.LOCALAPPDATA,folders.localAppData);
  for(const name of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','PYTHONPATH','VSINSTALLDIR','VCINSTALLDIR','AAW_NATIVE_PYTHON','GH_TOKEN','GITHUB_TOKEN','NPM_TOKEN','OPENAI_API_KEY'])assert.equal(Object.hasOwn(env,name),false);
});
test('desktop evidence must be this subprocess final unique PASS JSON, never a scanned old summary',()=>{
  const item={schemaVersion:'aaw.installed-desktop-smoke-result/v1',status:'PASS',evidence:path.join(fixture(),'summary.json')},line=JSON.stringify(item);assert.deepEqual(parseInstalledSmokeOutput('routine log\n'+line+'\n'),item);
  for(const text of [line+'\ntrailing garbage',line+'\n'+line,JSON.stringify({...item,status:'FAIL'}),JSON.stringify({...item,evidence:'relative.json'}),''])assert.throws(()=>parseInstalledSmokeOutput(text));
});
test('installed first/cold reports must bind exact roots, package and executable and confirm both app closes',()=>{
  const installationRoot=path.join(fixture(),'install'),storageRoot=path.join(fixture(),'data'),exe=path.join(installationRoot,'AnalogAIWorkbench.exe'),context={installationRoot,storageRoot,exeSha256:'a'.repeat(64),packageSha256:'b'.repeat(64)},result={marker:'synthetic-owned-marker'};
  const summary={schemaVersion:'aaw.installed-desktop-smoke/v1',status:'PASS',phase:'both',exe,expectedExeSha:context.exeSha256,appRoot:path.join(installationRoot,'resources/app'),storageRoot,dataRoot:path.join(storageRoot,'.local'),packageSha:context.packageSha256,marker:result.marker,results:['first','cold'].map(phase=>({phase,status:'PASS',normalClose:true,executable:exe}))};
  assert.equal(validateInstalledSmokeSummary(summary,result,context),summary);
  for(const mutate of [value=>{value.phase='cold';},value=>{value.packageSha='c'.repeat(64);},value=>{value.exe=path.join(installationRoot,'other.exe');},value=>{value.results[1].normalClose=false;},value=>{value.results[1].phase='first';}]){const value=structuredClone(summary);mutate(value);assert.throws(()=>validateInstalledSmokeSummary(value,result,context));}
});
