import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {findToolchain} from '../tools/portable-runtime-lib.mjs';

const root=path.resolve(import.meta.dirname,'..');
const marker='aaw.windows-installation/v1\nAnalogAIWorkbench\n';
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('actual Windows preflight rejects unsafe synthetic install boundaries without mutating them',
  {skip:process.platform!=='win32'||process.arch!=='x64'},async t=>{
    const work=path.join(root,'.local/windows-installer-preflight-tests',randomUUID());
    fs.mkdirSync(work,{recursive:true});
    const localData=path.join(work,'LocalAppData'),target=path.join(localData,'Programs/AnalogAIWorkbench');
    const header=path.join(work,'installer-files.h');
    fs.writeFileSync(header,`#pragma once\nnamespace aaw_installer {\ninline constexpr const wchar_t* packageFiles[]={L"app.exe",L"resources/app/app.js"};\ninline constexpr const wchar_t* packageDirectories[]={L"resources",L"resources/app"};\n#ifdef AAW_INSTALLER_PREFLIGHT_TEST\ninline constexpr wchar_t testLocalAppData[]=L${JSON.stringify(localData)};\n#endif\n}\n`);
    const source=path.join(root,'tools/windows-installer-preflight.cc'),toolchain=findToolchain(),executable=path.join(work,'preflight-test.exe');
    const args=['/nologo','/MT','/EHsc','/std:c++20','/W4','/WX','/utf-8','/permissive-','/DUNICODE','/D_UNICODE','/DAAW_INSTALLER_PREFLIGHT_TEST=1',
      '/I'+work,'/I'+path.join(toolchain.vc,'include'),...['ucrt','shared','um'].map(part=>'/I'+path.join(toolchain.sdkRoot,'Include',toolchain.sdk,part)),
      '/Fo'+path.join(work,'test.obj'),'/Fd'+path.join(work,'test.pdb'),'/Fe'+executable,source,'/link','/SUBSYSTEM:WINDOWS',
      '/LIBPATH:'+path.join(toolchain.vc,'lib/x64'),'/LIBPATH:'+path.join(toolchain.sdkRoot,'Lib',toolchain.sdk,'ucrt/x64'),'/LIBPATH:'+path.join(toolchain.sdkRoot,'Lib',toolchain.sdk,'um/x64'),
      'kernel32.lib','shell32.lib','ole32.lib','user32.lib','advapi32.lib','/DYNAMICBASE','/NXCOMPAT','/MANIFESTUAC:level=\'asInvoker\' uiAccess=\'false\''];
    const compile=spawnSync(toolchain.compiler,args,{cwd:work,shell:false,windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
    fs.writeFileSync(path.join(work,'compile.log'),(compile.stdout??'')+(compile.stderr??''));
    assert.equal(compile.error,undefined);assert.equal(compile.status,0,compile.stdout+compile.stderr);
    // Compile the real KnownFolder branch too. Never execute this production
    // binary in a unit test: it addresses the actual user's installation root.
    const productionExecutable=path.join(work,'preflight-production.exe');
    const productionArgs=args.filter(value=>value!=='/DAAW_INSTALLER_PREFLIGHT_TEST=1').map(value=>value==='/Fo'+path.join(work,'test.obj')?'/Fo'+path.join(work,'production.obj'):value==='/Fe'+executable?'/Fe'+productionExecutable:value);
    const production=spawnSync(toolchain.compiler,productionArgs,{cwd:work,shell:false,windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
    fs.writeFileSync(path.join(work,'production-compile.log'),(production.stdout??'')+(production.stderr??''));
    assert.equal(production.error,undefined);assert.equal(production.status,0,production.stdout+production.stderr);
    const poisoned=spawnSync(productionExecutable,['validate-install',target],{cwd:work,shell:false,windowsHide:true,timeout:5000,encoding:'utf8',maxBuffer:16384,
      env:{...process.env,LOCALAPPDATA:localData,APPDATA:localData,USERPROFILE:localData,AAW_INSTALL_ROOT:target}});
    assert.equal(poisoned.error,undefined);assert.equal(poisoned.status,10,'the production KnownFolder branch must reject an environment-selected synthetic root');
    assert.equal(fs.existsSync(target),false);
    const executableSha256=sha(executable),results=[];
    let sequence=0;
    function fresh(){
      if(fs.existsSync(localData)){
        assert.equal(fs.lstatSync(localData).isSymbolicLink(),false);
        fs.renameSync(localData,path.join(work,'retained-'+(++sequence)));
      }
      fs.mkdirSync(localData);
    }
    function owned(){fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'.aaw-installation'),marker);}
    function check(verb,expected,args=[target]){
      const run=spawnSync(executable,[verb,...args],{cwd:work,shell:false,windowsHide:true,timeout:5000,encoding:'utf8',maxBuffer:16384});
      assert.equal(run.error,undefined);assert.equal(run.status,expected);assert.equal(run.stdout,'');assert.equal(run.stderr,'');
      results.push({verb,expected,exitCode:run.status});
    }
    await t.test('new absent installation and empty directory are accepted, uninstall requires ownership',()=>{
      fresh();check('validate-install',0);check('validate-uninstall',13);
      fs.mkdirSync(target,{recursive:true});check('validate-install',0);check('validate-uninstall',13);
    });
    await t.test('an occupied unmarked directory and an invalid marker are refused',()=>{
      fresh();fs.mkdirSync(target,{recursive:true});const file=path.join(target,'unknown.txt');fs.writeFileSync(file,'synthetic preserved');
      check('validate-install',14);assert.equal(fs.readFileSync(file,'utf8'),'synthetic preserved');
      fs.writeFileSync(path.join(target,'.aaw-installation'),marker.replaceAll('\n','\r\n'));check('validate-install',13);check('validate-uninstall',13);
    });
    await t.test('known ordinary payload and unknown user sentinel survive both readonly validations',()=>{
      fresh();owned();fs.mkdirSync(path.join(target,'resources/app'),{recursive:true});
      for(const file of ['app.exe','resources/app/app.js','unknown-sentinel.txt'])fs.writeFileSync(path.join(target,file),'synthetic '+file);
      const files=['.aaw-installation','app.exe','resources/app/app.js','unknown-sentinel.txt'];const before=files.map(file=>sha(path.join(target,file)));
      check('validate-install',0);check('validate-uninstall',0);assert.deepEqual(files.map(file=>sha(path.join(target,file))),before);
    });
    await t.test('another absolute target, alternate CLI overrides and malformed paths are rejected',()=>{
      fresh();check('validate-install',10,[path.join(work,'unrelated')]);
      check('validate-install',2,[target,'/D='+target]);check('validate-uninstall',2,[target,'_?='+target]);check('other-operation',2);
      check('validate-install',11,[target+'\\..\\AnalogAIWorkbench']);check('validate-install',11,[target+':stream']);check('validate-install',11,['\\\\server\\share\\AnalogAIWorkbench']);
    });
    await t.test('root and ancestor junctions are rejected without traversing or changing their target',()=>{
      fresh();const outside=path.join(work,'outside-'+randomUUID());fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel'),'untouched');
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.symlinkSync(outside,target,'junction');check('validate-install',11);assert.equal(fs.readFileSync(path.join(outside,'sentinel'),'utf8'),'untouched');
      fresh();fs.symlinkSync(outside,path.join(localData,'Programs'),'junction');check('validate-install',11);assert.equal(fs.readFileSync(path.join(outside,'sentinel'),'utf8'),'untouched');
    });
    await t.test('known payload directory junctions and files with multiple links are rejected',()=>{
      fresh();owned();const outside=path.join(work,'payload-outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(target,'resources'),'junction');check('validate-install',11);check('validate-uninstall',11);
      fresh();owned();fs.writeFileSync(path.join(target,'app.exe'),'synthetic');fs.linkSync(path.join(target,'app.exe'),path.join(work,'hardlink'));check('validate-install',16);check('validate-uninstall',16);
    });
    await t.test('a hardlinked marker, known file replaced by directory, or known directory replaced by file is refused',()=>{
      fresh();owned();fs.linkSync(path.join(target,'.aaw-installation'),path.join(work,'marker-alias'));check('validate-install',16);
      fresh();owned();fs.mkdirSync(path.join(target,'app.exe'));check('validate-install',15);
      fresh();owned();fs.writeFileSync(path.join(target,'resources'),'synthetic');check('validate-install',15);
    });
    await t.test('a held fixture payload refuses install and uninstall, then succeeds after close without a byte change',()=>{
      fresh();owned();const file=path.join(target,'app.exe');fs.writeFileSync(file,'synthetic locked payload');const before=sha(file),held=fs.openSync(file,'r');
      try{check('validate-install',20);check('validate-uninstall',20);assert.equal(sha(file),before);}finally{fs.closeSync(held);}
      check('validate-install',0);check('validate-uninstall',0);assert.equal(sha(file),before);
    });
    assert.equal(sha(executable),executableSha256);
    fs.writeFileSync(path.join(work,'receipt.json'),JSON.stringify({schema:'aaw.installer-preflight-test/v1',status:'PASS',
      fixtureRoot:work,sourceSha256:sha(source),headerSha256:sha(header),executableSha256,productionExecutableSha256:sha(productionExecutable),compilerSha256:toolchain.compilerSha256,
      results,scope:'AAW_INSTALLER_PREFLIGHT_TEST executable against UUID-owned synthetic LocalAppData only; no actual installation root, deletion, ACL or registry changes.'},null,2)+'\n');
  });
