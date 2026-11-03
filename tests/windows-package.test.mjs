import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {inventory} from '../tools/windows-package.mjs';
import {safePackagePath,packageDirectories,preflightHeader,installerScript,INSTALLER_MARKER} from '../tools/windows-installer-script.mjs';
const root=path.resolve(import.meta.dirname,'..'),temp=path.join(root,'.local/windows-package-tests');fs.mkdirSync(temp,{recursive:true});
test('package paths cannot target an ancestor, stream, device or installer interpolation',()=>{
  for(const file of ['../outside','/absolute','a//b','a/../b','C:/other','a\\b','a:$stream','a/$INSTDIR','a/name.','con.txt','LPT²','a/line\nbreak'])assert.equal(safePackagePath(file),false,file);
  for(const file of ['resources/app/dist/cloud/main/index.js','.aaw-installation','locales/zh-CN.pak','licenses/npm/@scope/LICENSE'])assert.equal(safePackagePath(file),true,file);
});
test('installer header owns only the explicit files and their directories',()=>{
  const files=['AnalogAIWorkbench.exe','resources/app/package.json','resources/app/dist/main.js',INSTALLER_MARKER];
  assert.deepEqual(packageDirectories(files),['resources','resources/app','resources/app/dist']);
  const header=preflightHeader(files);assert(header.includes('L"resources/app/package.json"'));assert(header.includes('L"Uninstall.exe"'));assert.throws(()=>preflightHeader([...files,'ANALOGAIWORKBENCH.EXE']));
});
test('generated install and uninstall remain user scoped and fail closed without recursive deletion',()=>{
  const folder=fs.mkdtempSync(path.join(temp,'script-')),files=['AnalogAIWorkbench.exe','resources/app/package.json',INSTALLER_MARKER];
  const script=installerScript({payloadRoot:folder,files,preflight:path.join(folder,'preflight.exe'),licenseFile:path.join(root,'LICENSE'),outputFile:path.join(folder,'test-setup.exe'),version:'0.1.0-alpha.0'});
  assert(!/RMDir\s+\/r|Delete\s+"[^"\n]*\*|File\s+\/r|HKLM|REBOOTOK/iu.test(script));
  assert.equal((script.match(/SetShellVarContext current/gu)??[]).length,2);assert(script.includes('RequestExecutionLevel user'));assert(script.includes('CRCCheck force'));
  assert(script.includes('validate-install "$INSTDIR"'));assert(script.includes('validate-uninstall "$INSTDIR"'));
  assert.equal((script.match(/IfErrors invalid_root/gu)??[]).length,2);assert(script.includes('StrCmp $1 0 remove_registration'));
  assert.equal((script.match(/InitPluginsDir\n  SetOutPath "\$PLUGINSDIR"\n  File \/oname=preflight.exe/gu)??[]).length,2);
  assert(!script.includes('Delete "$APPDATA'));assert(script.includes('Delete "$INSTDIR\\resources\\app\\package.json"'));
  assert.throws(()=>installerScript({payloadRoot:folder,files:['../user.txt'],preflight:path.join(folder,'x'),licenseFile:path.join(root,'LICENSE'),outputFile:path.join(folder,'out.exe'),version:'0.1.0'}));
});
test('payload inventory rejects hard links and records exact ordinary bytes',()=>{
  const folder=fs.mkdtempSync(path.join(temp,'inventory-')),file=path.join(folder,'safe.txt');fs.writeFileSync(file,'synthetic');assert.equal(inventory(folder)[0].bytes,9);
  fs.linkSync(file,path.join(folder,'alias.txt'));assert.throws(()=>inventory(folder),/RUNTIME_NOT_ORDINARY/);
});
