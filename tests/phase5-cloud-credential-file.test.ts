import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readCloudCredentialFileV1} from '../apps/desktop/src/main/cloud/credential-file';
import {CloudChatErrorV1} from '../packages/agent-adapters/src/cloud-chat-contract';

const root=path.resolve('.local/phase5-credential-test-fixtures');fs.mkdirSync(root,{recursive:true});
function fixture(run:(file:string)=>void){const dir=fs.mkdtempSync(path.join(root,'case-'));const file=path.join(dir,'catalog.txt');try{run(file);}finally{for(const name of fs.readdirSync(dir)){const target=path.resolve(dir,name);assert.ok(target.startsWith(dir+path.sep));fs.unlinkSync(target);}fs.rmdirSync(dir);}}
test('P5 credential file reads only authorized regular local fixture',()=>fixture(file=>{
  fs.writeFileSync(file,'deepseek:\nsk-FAKE_FIXTURE_CREDENTIAL\n');
  assert.equal(readCloudCredentialFileV1({provider:'deepseek',filePath:file,authorizedFilePath:file}),'sk-FAKE_FIXTURE_CREDENTIAL');
  assert.throws(()=>readCloudCredentialFileV1({provider:'deepseek',filePath:file,authorizedFilePath:path.join(root,'different.txt')}),CloudChatErrorV1);
}));
test('P5 credential file rejects non-file, oversized and invalid UTF8 without raw errors',()=>fixture(file=>{
  for(const value of [Buffer.alloc(65537,65),Buffer.from([0xff])]){fs.writeFileSync(file,value);assert.throws(()=>readCloudCredentialFileV1({provider:'deepseek',filePath:file,authorizedFilePath:file}),(e:unknown)=>e instanceof CloudChatErrorV1&&e.message==='Cloud chat failed: NOT_CONFIGURED');}
  assert.throws(()=>readCloudCredentialFileV1({provider:'deepseek',filePath:root,authorizedFilePath:root}),CloudChatErrorV1);
}));
test('P5 credential file accepts exact byte limit and closes file descriptor',()=>fixture(file=>{
  const header='deepseek:\nsk-FAKE_FIXTURE_CREDENTIAL\n';fs.writeFileSync(file,header+' '.repeat(65536-Buffer.byteLength(header)));
  assert.equal(fs.statSync(file).size,65536);assert.equal(readCloudCredentialFileV1({provider:'deepseek',filePath:file,authorizedFilePath:file}),'sk-FAKE_FIXTURE_CREDENTIAL');
  fs.renameSync(file,file+'.moved');
}));
test('P5 credential file rejects symlink metadata before open (injected fs observation)',()=>fixture(file=>{
  fs.writeFileSync(file,'deepseek:\nsk-FAKE_FIXTURE_CREDENTIAL\n');
  const original=fs.lstatSync;const originalOpen=fs.openSync;let opened=0;
  Object.defineProperty(fs,'lstatSync',{value:(...args:Parameters<typeof fs.lstatSync>)=>{const stat=Reflect.apply(original,fs,args)!;stat.isSymbolicLink=()=>true;return stat;}});
  fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{opened++;return Reflect.apply(originalOpen,fs,args);}) as typeof fs.openSync;
  try{assert.throws(()=>readCloudCredentialFileV1({provider:'deepseek',filePath:file,authorizedFilePath:file}),CloudChatErrorV1);assert.equal(opened,0);}finally{Object.defineProperty(fs,'lstatSync',{value:original});fs.openSync=originalOpen;}
}));
