import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCommandDiagnosticJournal} from '../apps/desktop/src/main/agent-command/diagnostics';
import {WorkCycleError} from '../apps/desktop/src/main/agent-work-cycle/types';
import {CommandPreparationError} from '../apps/desktop/src/main/agent-command/types';
import {isCommandDiagnosticReadResult,isCommandDiagnosticRecord,type CommandDiagnosticInput} from '../apps/desktop/src/shared/agent/command-diagnostics';
const product=path.resolve('C:/work/analog_ai_workbench'),parent=path.join(product,'.local/command-diagnostics-tests'),version='0.1.0-alpha.0';
const input:CommandDiagnosticInput={runId:'run-synthetic',executionId:'cmd-synthetic',workspaceId:'work-synthetic',chatSessionId:'chat-synthetic',turnId:'turn-synthetic',component:'controller',operation:'finish.persist',kind:'failure'};
function fixture(){
 const base=path.join(parent,randomUUID()),directory=path.join(base,'diagnostics');fs.mkdirSync(base,{recursive:true});
 return {base,directory,journal:createCommandDiagnosticJournal({directory,appVersion:version}),close(){const resolved=fs.realpathSync.native(base);assert.equal(resolved,base);assert.match(path.relative(parent,resolved),/^[a-f0-9-]{36}$/u);fs.rmSync(resolved,{recursive:true});}};
}
test('first command failure and later cleanup retain separate durable causes and correlation after reopening',()=>{
 const f=fixture();try{
  const first=f.journal.append(input,new WorkCycleError('CONFLICT'));assert(first);assert.equal(first.causeCode,'CONFLICT');
  const cleanup=f.journal.append({...input,operation:'controller.close',kind:'cleanup',causeCode:'CLEANUP_FAILED'},new Error('private cleanup text'));assert(cleanup);
  assert(f.journal.append({...input,executionId:'cmd-other'},new WorkCycleError('STORAGE_FAILED')));
  const cold=createCommandDiagnosticJournal({directory:f.directory,appVersion:version}),read=cold.read(input.runId,input.executionId);
  assert(isCommandDiagnosticReadResult(read));assert.equal(read.unavailable,false);assert.equal(read.truncated,false);assert.deepEqual(read.records.map(r=>r.id),[first.id,cleanup.id]);assert.deepEqual(read.records.map(r=>r.causeCode),['CONFLICT','CLEANUP_FAILED']);assert.equal(read.records[0]!.chatSessionId,input.chatSessionId);
  assert.deepEqual(cold.read('other-run',input.executionId).records,[]);assert.deepEqual(cold.read(input.runId,'missing-command').records,[]);
 }finally{f.close();}
});
test('exception diagnostics exclude secret messages, function names, absolute paths and unrecognized error codes',()=>{
 const f=fixture();try{
  const error=Object.assign(new Error('sk-secret and private command'),{code:'PRIVATE_SECRET_CODE'});
  error.stack='Error: sk-secret\n    at privateSecretFunction (C:\\work\\analog_ai_workbench\\apps\\desktop\\src\\main\\agent-command\\controller.ts:97:5)\n    at secret (C:\\Users\\private-user\\secret.js:2:3)\n    at native (node:fs:3:4)';
  const record=f.journal.append(input,error);assert(record);assert.equal(record.causeCode,'UNKNOWN_ERROR');assert.deepEqual(record.stack,['apps/desktop/src/main/agent-command/controller.ts:97:5']);
  const bytes=fs.readFileSync(path.join(f.directory,'diagnostics.jsonl'),'utf8');assert.doesNotMatch(bytes,/sk-secret|privateSecretFunction|PRIVATE_SECRET_CODE|C:|Users|private-user|secret\.js/);
  const compiled=new Error('private');compiled.stack='Error: private\n    at fn (C:\\work\\analog_ai_workbench\\.local\\sample-batch\\test-build\\apps\\desktop\\src\\main\\agent-command\\diagnostics.js:20:4)';
  assert.deepEqual(f.journal.append(input,compiled)!.stack,['apps/desktop/src/main/agent-command/diagnostics.js:20:4']);
 }finally{f.close();}
});
test('sanitization reads only data fields, preserves approved classifications and never invokes error getters',()=>{
 const f=fixture();try{
  let reads=0;const spoof=Object.defineProperty({},'code',{get(){reads++;return 'EACCES';}});assert.equal(f.journal.append(input,spoof)!.causeCode,'UNKNOWN_ERROR');
  const accessor=new Error('private');Object.defineProperty(accessor,'code',{get(){reads++;return 'EPERM';}});Object.defineProperty(accessor,'stack',{get(){reads++;return 'private';}});
  const recorded=f.journal.append(input,accessor)!;assert.equal(recorded.causeCode,'UNKNOWN_ERROR');assert.deepEqual(recorded.stack,[]);assert.equal(reads,0);
  const accessorMessage=new Error('private');Object.defineProperty(accessorMessage,'message',{get(){reads++;return 'secret';}});assert.deepEqual(f.journal.append(input,accessorMessage)!.stack,[]);assert.equal(reads,0);
  assert.equal(f.journal.append(input,Object.assign(new Error('private host path'),{code:'ENOSPC'}))!.causeCode,'ENOSPC');
  assert.equal(f.journal.append(input,new CommandPreparationError('INSUFFICIENT_DISK_SPACE','a'.repeat(64)))!.causeCode,'INSUFFICIENT_DISK_SPACE');
  assert.equal(f.journal.append(input,new TypeError('private'))!.causeCode,'TYPE_ERROR');
 }finally{f.close();}
});
test('bounded rotation survives cold read and never grows beyond the admitted files',()=>{
 const f=fixture();try{
  const journal=createCommandDiagnosticJournal({directory:f.directory,appVersion:version,maxFileBytes:1024,maxFiles:3});
  for(let n=0;n<20;n++)assert(journal.append({...input,operation:n?'controller.close':'driver.start',kind:n?'cleanup':'failure'},new WorkCycleError('CLEANUP_FAILED')));
  const files=fs.readdirSync(f.directory);assert.equal(files.length,3);for(const name of files){assert.match(name,/^diagnostics(?:\.[12])?\.jsonl$/u);assert(fs.statSync(path.join(f.directory,name)).size<=1024);}
  const cold=createCommandDiagnosticJournal({directory:f.directory,appVersion:version,maxFileBytes:1024,maxFiles:3}),read=cold.read(input.runId,input.executionId);assert.equal(read.unavailable,false);assert.equal(read.truncated,true);assert(read.records.length>0&&read.records.length<20);
 }finally{f.close();}
});
test('bounded query retains the earliest available failure alongside recent cleanup rather than overwriting it',()=>{
 const f=fixture();try{
  const first=f.journal.append(input,new WorkCycleError('SOURCE_CHANGED'))!;for(let n=0;n<80;n++)assert(f.journal.append({...input,kind:'cleanup',operation:'controller.close',causeCode:'CLEANUP_FAILED'}));
  const read=f.journal.read(input.runId,input.executionId);assert.equal(read.records.length,64);assert.equal(read.records[0]!.id,first.id);assert.equal(read.records[0]!.causeCode,'SOURCE_CHANGED');assert.equal(read.records.at(-1)!.kind,'cleanup');assert.equal(read.truncated,true);
 }finally{f.close();}
});
test('reading diagnostics does not create folders or append observation records',()=>{
 const f=fixture();try{assert.deepEqual(f.journal.read(input.runId,input.executionId),{records:[],unavailable:false,truncated:false});assert.equal(fs.existsSync(f.directory),false);assert.equal(f.journal.health().available,true);}finally{f.close();}
});
test('diagnostic storage failure is nonthrowing and visible without replacing another file',()=>{
 const f=fixture();try{
  fs.writeFileSync(f.directory,'existing ordinary file');assert.doesNotThrow(()=>assert.equal(f.journal.append(input,new Error('private')),null));assert.equal(f.journal.health().available,false);assert.equal(f.journal.read(input.runId,input.executionId).unavailable,true);assert.equal(fs.readFileSync(f.directory,'utf8'),'existing ordinary file');
 }finally{f.close();}
});
test('malformed or incomplete log records fail visibly and are preserved without silent overwrite',()=>{
 for(const content of ['{"private":"invalid schema"}\n','{"version":1']){const f=fixture();try{
  fs.mkdirSync(f.directory);const file=path.join(f.directory,'diagnostics.jsonl');fs.writeFileSync(file,content);assert.equal(f.journal.append(input),null);assert.equal(f.journal.read(input.runId,input.executionId).unavailable,true);assert.equal(fs.readFileSync(file,'utf8'),content);
 }finally{f.close();}}
});
test('linked diagnostic files and directory junctions are never followed or modified',()=>{
 const f=fixture();try{
  fs.mkdirSync(f.directory);const original=path.join(f.base,'retained.jsonl');fs.writeFileSync(original,'do not modify');fs.linkSync(original,path.join(f.directory,'diagnostics.jsonl'));
  assert.equal(f.journal.append(input),null);assert.equal(f.journal.read(input.runId,input.executionId).unavailable,true);assert.equal(fs.readFileSync(original,'utf8'),'do not modify');
  const target=path.join(f.base,'target'),junction=path.join(f.base,'junction');fs.mkdirSync(target);fs.symlinkSync(target,junction,'junction');const journal=createCommandDiagnosticJournal({directory:junction,appVersion:version});assert.equal(journal.append(input),null);assert.deepEqual(fs.readdirSync(target),[]);
 }finally{f.close();}
});
test('schema guards reject unknown fields and accessors without reading them',()=>{
 const f=fixture();try{
  const record=f.journal.append(input)!;assert(isCommandDiagnosticRecord(record));assert(!isCommandDiagnosticRecord({...record,message:'private'}));assert(!isCommandDiagnosticRecord({...record,operation:'private command'}));assert(!isCommandDiagnosticRecord({...record,causeCode:'secret'}));assert(!isCommandDiagnosticRecord({...record,stack:['C:/private.js:1:2']}));
  let reads=0;const unsafe=Object.defineProperty({...record},'causeCode',{enumerable:true,get(){reads++;return 'STORAGE_FAILED';}});assert(!isCommandDiagnosticRecord(unsafe));
  const records=[record];Object.defineProperty(records,'0',{get(){reads++;return record;}});assert(!isCommandDiagnosticReadResult({records,unavailable:false,truncated:false}));assert.equal(reads,0);
  const bad=Object.defineProperty({...input},'runId',{enumerable:true,get(){reads++;return 'secret';}});assert.equal(f.journal.append(bad),null);assert.equal(reads,0);
 }finally{f.close();}
});
test('out-of-product paths and invalid version/native codes never write diagnostic files',()=>{
 const journal=createCommandDiagnosticJournal({directory:path.resolve(product,'..','must-not-create-diagnostics-'+randomUUID()),appVersion:version});assert.equal(journal.append(input),null);assert.equal(journal.read(input.runId,input.executionId).unavailable,true);
 const f=fixture();try{const invalid=createCommandDiagnosticJournal({directory:f.directory,appVersion:'private version text'});assert.equal(invalid.append(input),null);const single=createCommandDiagnosticJournal({directory:f.directory,appVersion:version,maxFiles:1});assert.equal(single.append(input),null);assert.equal(f.journal.append({...input,nativeCode:Infinity}),null);assert.equal(fs.existsSync(f.directory),false);}finally{f.close();}
});
