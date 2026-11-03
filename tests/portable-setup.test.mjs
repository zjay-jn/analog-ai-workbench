import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseOptions,ordinary,publish,download,layout,ref} from '../tools/portable-runtime-lib.mjs';
import {installedElectron} from '../tools/electron-runtime.mjs';
import {portableWorkSelfTestPaths} from '../tools/portable-native-build.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=path.join(root,'.local/portable-setup-tests');fs.mkdirSync(temporary,{recursive:true});
function fixture(){return fs.mkdtempSync(path.join(temporary,'case-'));}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

test('setup accepts only explicit absolute cache and storage paths',()=>{
  const storage=path.resolve(root,'../synthetic-storage'),cache=path.resolve(root,'../synthetic-engine.exe');
  assert.deepEqual(parseOptions([`--storage-root=${storage}`,`--opencode-file=${cache}`]),{storageRoot:storage,opencodeFile:cache,nodeHeadersArchive:undefined,nodeLibFile:undefined});
  for(const values of [['--storage-root=relative'],['--opencode-file=relative'],[`--storage-root=${storage}`,`--storage-root=${storage}`],['--unknown=value']])assert.throws(()=>parseOptions(values));
});
test('component references cannot escape the selected installation',()=>{
  const folder=fixture(),source=path.join(folder,'input.txt');fs.writeFileSync(source,'synthetic');
  assert.equal(ref(folder,source).sha256,hash('synthetic'));
  assert.throws(()=>ref(path.join(folder,'elsewhere'),source),/RUNTIME_REFERENCE_ESCAPED/);
});
test('runtime component reads reject hard links without weakening the source checks',()=>{
  const folder=fixture(),source=path.join(folder,'input.txt'),linked=path.join(folder,'linked.txt');fs.writeFileSync(source,'synthetic');fs.linkSync(source,linked);
  assert.throws(()=>ordinary(source),/RUNTIME_NOT_ORDINARY/);assert.throws(()=>ordinary(linked),/RUNTIME_NOT_ORDINARY/);
  fs.unlinkSync(linked);assert.equal(ordinary(source).nlink,1);
});
test('publishing preserves prior bytes and refuses destinations outside runtime',()=>{
  const folder=fixture(),input=path.join(folder,'input.txt'),target=path.join(folder,'.local/runtime/native/sample.exe');fs.writeFileSync(input,'first');
  publish(folder,input,target,'first-build');fs.writeFileSync(input,'second');publish(folder,input,target,'second-build');
  assert.equal(fs.readFileSync(target,'utf8'),'second');assert.equal(fs.readFileSync(path.join(folder,'.local/runtime/backups/second-build/native/sample.exe'),'utf8'),'first');
  assert.throws(()=>publish(folder,input,path.join(folder,'unapproved.exe'),'third-build'),/PUBLISH_OUTSIDE_RUNTIME/);
});
test('offline cached download still verifies the entire content and never overwrites mismatch',async()=>{
  const folder=fixture(),input=path.join(folder,'archive.zip');fs.writeFileSync(input,'synthetic-archive');
  await download('https://127.0.0.1:9/never-requested',input,hash('synthetic-archive'),1024);
  await assert.rejects(download('https://127.0.0.1:9/never-requested',input,hash('different'),1024),/EXISTING_DOWNLOAD_HASH_MISMATCH/);
  assert.equal(fs.readFileSync(input,'utf8'),'synthetic-archive');
});
test('setup keeps storage separate from installation',()=>{
  if(process.platform!=='win32')return;
  assert.throws(()=>layout(root,root),/INSTALL_AND_STORAGE_ROOTS_MUST_BE_SEPARATE/);
  assert.throws(()=>layout(root,path.join(root,'userdata')),/INSTALL_AND_STORAGE_ROOTS_MUST_BE_SEPARATE/);
});
test('work setup self-test receipts stay in the native test scope outside the production execution ledger',()=>{
  const folder=fixture(),dataRoot=path.join(folder,'.local'),buildId='11111111-2222-4333-8444-555555555555',id='wce-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const scope=portableWorkSelfTestPaths({dataRoot},buildId,id),testRoot=path.join(dataRoot,'agent-work-cycle-runner/native-tests'),production=path.join(dataRoot,'agent-work-cycle-runner/executions');
  // Match the existing native Parse whitelist: <UUID>/executions/<same wce-id>.
  assert.equal(path.relative(testRoot,scope.execution).replaceAll('\\','/'),buildId+'/executions/'+id);
  assert.equal(scope.runtime,path.join(scope.execution,'runtime'));assert(path.relative(production,scope.execution).startsWith('..'+path.sep));
  fs.mkdirSync(scope.execution,{recursive:true});fs.writeFileSync(path.join(scope.execution,'cleanup.json'),'{"synthetic":true}');
  assert.equal(fs.existsSync(production),false);assert.equal(fs.readFileSync(path.join(scope.execution,'cleanup.json'),'utf8'),'{"synthetic":true}');
  assert.throws(()=>portableWorkSelfTestPaths({dataRoot},'../executions',id),/WORK_SELF_TEST_IDENTITY/);
  assert.throws(()=>portableWorkSelfTestPaths({dataRoot},buildId,'../production-id'),/WORK_SELF_TEST_IDENTITY/);
});
test('Electron diagnosis reads fixed files without importing an installer',()=>{
  const folder=fixture(),dependency=path.join(folder,'node_modules/electron'),marker=path.join(folder,'unexpected-install.txt');
  fs.mkdirSync(dependency,{recursive:true});fs.writeFileSync(path.join(dependency,'package.json'),JSON.stringify({version:'43.4.0'}));
  fs.writeFileSync(path.join(dependency,'index.js'),`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected install');`);
  assert.throws(()=>installedElectron(folder),/ELECTRON_DESKTOP_SETUP_REQUIRED/);assert.equal(fs.existsSync(marker),false);
  fs.mkdirSync(path.join(dependency,'dist'));fs.writeFileSync(path.join(dependency,'dist/version'),'v43.4.0');fs.writeFileSync(path.join(dependency,'path.txt'),'electron.exe');
  const executable=path.join(dependency,'dist/electron.exe');fs.writeFileSync(executable,'synthetic file; never executed');
  assert.equal(installedElectron(folder),executable);assert.equal(fs.existsSync(marker),false);
});
