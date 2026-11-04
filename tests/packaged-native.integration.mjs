import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {ordinary} from '../tools/portable-runtime-lib.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),buildFile=process.env.AAW_PACKAGED_NATIVE_RESULT;
test('precompiled packaged roots relocate, ignore environment overrides and reject aliases without executing a command',{skip:!buildFile},()=>{
  assert(path.isAbsolute(buildFile));assert(ordinary(buildFile).size<=1048576);const build=JSON.parse(fs.readFileSync(buildFile,'utf8'));
  const parent=path.join(root,'.local/packaged-native-tests');fs.mkdirSync(parent,{recursive:true});const directory=fs.mkdtempSync(path.join(parent,'smoke-'));
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for(const id of ['guardian','commandRunner','workRunner','windowsFs']){const item=build.artifacts[id];assert(path.isAbsolute(item.path));assert.equal(ordinary(item.path).size,item.bytes);assert.equal(digest(item.path),item.sha256);}
  const command=build.artifacts.commandRunner;
  const stage=name=>{const app=path.join(directory,name,'resources/app'),native=path.join(app,'.local/runtime/native');fs.mkdirSync(native,{recursive:true});const exe=path.join(native,'command-runner.exe');fs.copyFileSync(command.path,exe,fs.constants.COPYFILE_EXCL);return {app,native,exe};};
  const env={SystemRoot:'Z:\\AAW_FAKE_WINDOWS',windir:'Z:\\AAW_FAKE_WINDOWS',APPDATA:path.join(directory,'fake-appdata'),LOCALAPPDATA:path.join(directory,'fake-localappdata'),USERPROFILE:path.join(directory,'fake-home'),AAW_DATA_ROOT:path.join(directory,'fake-data')};
  const observations=[];
  const run=(exe,args)=>{const result=spawnSync(exe,args,{cwd:directory,env,shell:false,windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:65536});observations.push({image:exe,args,exitCode:result.status,error:result.error?.code??null,stdout:result.stdout??'',stderr:result.stderr??''});assert.equal(result.error,undefined);return result;};
  const first=stage('install one'),a=run(first.exe,['--probe-profile']);assert.equal(a.status,0,a.stderr);const before=JSON.parse(a.stdout);
  assert.equal(before.schema,'aaw.packaged-native-profile/v1');assert.match(before.profileRevision,/^[a-f0-9]{64}$/u);assert.equal(before.profile.installationRoot.toLowerCase(),first.app.toLowerCase());assert.equal(before.profile.runtimeRoot.toLowerCase(),path.dirname(first.native).toLowerCase());
  assert.equal(before.profile.storageRoot.endsWith('\\AnalogAIWorkbench'),true);assert.equal(before.profile.dataRoot,before.profile.storageRoot+'\\.local');assert.notEqual(before.profile.storageRoot,env.APPDATA);assert.notEqual(before.profile.systemRoot,env.SystemRoot);
  assert.equal(before.profile.shellVersion,'5.1');assert.deepEqual(before.profile.systemFiles.map(file=>file.role),['shell','shellConfig','automation','clr']);assert(before.profile.systemFiles.every(file=>file.bytes>0&&/^[a-f0-9]{64}$/u.test(file.sha256)));
  const second=stage('relocated 二'),b=run(second.exe,['--probe-profile']);assert.equal(b.status,0,b.stderr);const after=JSON.parse(b.stdout);assert.equal(after.profile.installationRoot.toLowerCase(),second.app.toLowerCase());assert.notEqual(after.profileRevision,before.profileRevision);assert.deepEqual(after.profile.systemFiles,before.profile.systemFiles);
  const denied=run(second.exe,['--profile-revision='+'0'.repeat(64)]);assert.equal(denied.status,2);assert.match(denied.stderr,/packaged_profile_changed/u);
  const wrong=path.join(directory,'wrong-name.exe');fs.copyFileSync(command.path,wrong,fs.constants.COPYFILE_EXCL);assert.equal(run(wrong,['--probe-profile']).status,2);
  const hard=stage('hardlink rejected');fs.linkSync(hard.exe,path.join(directory,'hardlink-copy.exe'));assert.equal(run(hard.exe,['--probe-profile']).status,2);
  const alias=path.join(directory,'junction rejected');fs.symlinkSync(path.join(directory,'install one'),alias,'junction');assert.equal(run(path.join(alias,'resources/app/.local/runtime/native/command-runner.exe'),['--probe-profile']).status,2);
  const require=createRequire(import.meta.url);const addon=require(build.artifacts.windowsFs.path);assert.equal(typeof addon.getCapabilities,'function');assert.equal(typeof addon.openValidatedRoot,'function');assert.equal(typeof addon.closeRoot,'function');
  assert.equal(fs.existsSync(env.APPDATA),false);assert.equal(fs.existsSync(env.AAW_DATA_ROOT),false);
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({schema:'aaw.packaged-native-readonly-smoke/v1',status:'PASS',buildFile,observations,addonExports:Object.getOwnPropertyNames(addon),scope:'Read-only native probes only; no command, profile creation, AppData writes, model or private project access.'},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'PASS',evidence:directory}));
});
