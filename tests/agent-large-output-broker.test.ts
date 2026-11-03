import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandBroker} from '../apps/desktop/src/main/agent-command/broker';
import {readCommandLog,commandDigest,emptyLog,chunkPrefix} from '../apps/desktop/src/main/agent-command/logs';
import {CommandError,type CommandController,type CommandRepository,type CommandRecord,type CommandChunk} from '../apps/desktop/src/main/agent-command/types';
import {createWorkCycleBroker} from '../apps/desktop/src/main/agent-work-cycle/broker';
import {WorkCycleError,type WorkCycleWorkspace,type WorkCycleRunner} from '../apps/desktop/src/main/agent-work-cycle/types';
import type {ProjectReadPublication} from '../apps/desktop/src/main/cloud/project-read-broker';
import {PROJECT_READ_LIMITS as P,type ProjectReadToolCall,type ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {CommandLogPage} from '../apps/desktop/src/shared/agent/agent-command';
import type {WorkCycleFile} from '../apps/desktop/src/shared/agent/agent-work-cycle';
import {parseProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import {describeToolOutput} from '../apps/desktop/src/shared/agent/tool-output';

// Synthetic immutable chunks and work objects only; no files, program, network, or credentials.
const base={sessionId:'synthetic-session',messageId:'synthetic-message'};
const sha=commandDigest('synthetic-identity');
const logCall=(id:string,offset=0,version:string|null=null,maxBytes=16384):Extract<ProjectReadToolCall,{toolName:'command_log'}>=>({...base,callId:id,toolName:'command_log',arguments:{executionId:'synthetic-command',stream:'stdout',offset,maxBytes,expectedPrefixVersion:version}});
const decode=(p:CommandLogPage)=>Buffer.from(p.data,p.format==='base64'?'base64':'utf8');
const page=(r:ProjectReadToolResult):CommandLogPage=>{assert(r.ok&&r.value.kind==='command_log');return r.value.page;};
function delivery(cap=2000,remaining=P.toolContextBytes){
 let used=0;const published:ProjectReadPublication[]=[];
 return {published,remainingToolBytes:()=>remaining-used,canDeliver:(p:ProjectReadPublication)=>Buffer.byteLength(JSON.stringify(p.result))+(p.reserveBytes??0)<=Math.min(cap,remaining-used),
  async publish(p:ProjectReadPublication){assert(parseProjectReadToolResult(p.result));const bytes=Buffer.byteLength(JSON.stringify(p.result));assert(bytes<=cap&&used+bytes<=remaining);used+=bytes;published.push(p);},used:()=>used};
}
function logFixture(raw:Buffer,cap=2000,closed=true){
 const chunks=new Map<string,Uint8Array>(),reads:Parameters<CommandController['log']>[0][]=[],signal=new AbortController();let effects=0;
 let record={execution:{executionId:'synthetic-command',logs:{stdout:emptyLog('synthetic-command','stdout'),stderr:emptyLog('synthetic-command','stderr')}},chunks:{stdout:[],stderr:[]}} as unknown as CommandRecord;
 const repo={readChunk(id:string,c:CommandChunk){assert.equal(id,'synthetic-command');const bytes=chunks.get(c.object)!;assert.equal(commandDigest(bytes),c.sha256);return bytes;}} as CommandRepository;
 function append(bytes:Buffer){const previous=record.execution.logs.stdout,chunk={object:'chunk-'+chunks.size,offset:previous.persistedBytes,bytes:bytes.length,sha256:commandDigest(bytes)};chunks.set(chunk.object,bytes);const prefixVersion=chunkPrefix(previous.prefixVersion,chunk);
  record={...record,chunks:{...record.chunks,stdout:[...record.chunks.stdout,{...chunk,prefixVersion}]},execution:{...record.execution,logs:{...record.execution.logs,stdout:{...previous,persistedBytes:chunk.offset+chunk.bytes,observedBytes:chunk.offset+chunk.bytes,prefixVersion,closed,coverage:closed?'complete':'open',sha256:closed?commandDigest(Buffer.concat([...chunks.values()].map(b=>Buffer.from(b)))):null}}}};
 }
 if(raw.length)append(raw);
 const budget=delivery(cap),controller={log(args:Parameters<CommandController['log']>[0]){reads.push(args);return readCommandLog(repo,record,args);},async start(){effects++;assert.fail('no command starts');},async stop(){effects++;assert.fail('no command stops');}} as unknown as CommandController;
 const broker=createCommandBroker({...budget,controller,signal:signal.signal,authorize:c=>c.arguments&&'executionId' in c.arguments&&c.arguments.executionId==='synthetic-command',legacyBusy:()=>false});
 return {broker,budget,reads,append,signal,effects:()=>effects,controller};
}

test('command pages fit actual escaped JSON, retain raw hashes, and concatenate without gaps',async()=>{
 const raw=Buffer.concat([Buffer.from('中🙂'.repeat(800)),Buffer.alloc(1800,0),Buffer.from([255,254,34,10])]),f=logFixture(raw,1900);
 let offset=0,version:string|null=null;const parts:Buffer[]=[];
 for(let index=0;index<50;index++){
  const call=logCall('page-'+index,offset,version),r=await f.broker.execute(call),p=page(r);assert.equal(p.offset,offset);assert(p.endOffset>offset);assert(p.endOffset-offset<=4096);
  const bytes=decode(p);assert.equal(bytes.length,p.endOffset-p.offset);assert.equal(commandDigest(bytes),p.bytesSha256);parts.push(bytes);assert.equal(p.snapshotBytes,raw.length);
  const d=describeToolOutput({runId:'run',call,result:r})!;assert.equal(d.state,'partial');
  if(!p.nextCursor){assert.equal(p.endOffset,raw.length);break;}assert.equal(d.continuation?.toolName,'command_log');assert(d.continuation?.toolName==='command_log');assert.equal(d.continuation.arguments.offset,p.endOffset);offset=p.nextCursor.offset;version=p.nextCursor.prefixVersion;
 }
 assert.deepEqual(Buffer.concat(parts),raw);assert.equal(f.effects(),0);assert(f.budget.used()<=P.toolContextBytes);
});

test('adaptive command retries pin the first prefix even when more bytes arrive',async()=>{
 const original=Buffer.from('original'.repeat(900)),f=logFixture(original,1200,false),budget=delivery(1200);let appended=false;
 const broker=createCommandBroker({...budget,controller:f.controller,signal:f.signal.signal,authorize:()=>true,legacyBusy:()=>false,canDeliver(p){if(p.result.ok&&!appended){appended=true;f.append(Buffer.from('APPENDED'));}return budget.canDeliver(p);}});
 const call=logCall('append-during-fit'),p=page(await broker.execute(call));assert.equal(p.snapshotBytes,original.length);assert.equal(p.hasNewerBytes,true);assert.equal(p.streamClosed,false);assert(f.reads.length>1);
 assert(f.reads.slice(1).every(a=>a.expectedPrefixVersion===p.prefixVersion));assert.deepEqual(decode(p),original.subarray(0,p.endOffset));
 const suffix=page(await broker.execute(logCall('refresh',original.length)));assert.equal(decode(suffix).toString(),'APPENDED');
 const endCall=logCall('open-eof',suffix.snapshotBytes),end=await broker.execute(endCall);assert.equal(page(end).endOffset,suffix.snapshotBytes);
 const d=describeToolOutput({runId:'run',call:endCall,result:end})!;assert.equal(d.state,'pending');assert.equal(d.sourceState,'open');assert.equal(d.continuation?.mode,'refresh');assert(d.continuation?.toolName==='command_log');assert.equal(d.continuation.arguments.offset,suffix.snapshotBytes);assert.equal(f.effects(),0);
});

test('command cancellation, exhausted metadata capacity and wrong execution remain closed',async()=>{
 const f=logFixture(Buffer.from('中'),90);const result=await f.broker.execute(logCall('cannot-fit'));assert.deepEqual(result,{ok:false,error:{code:'BUDGET_EXCEEDED'},coverage:null});assert(f.reads.length<=3);
 const before=f.reads.length;await assert.rejects(f.broker.execute({...logCall('foreign'),arguments:{...logCall('foreign').arguments,executionId:'foreign-run-command'}}),e=>e instanceof CommandError&&e.code==='CAPABILITY_DENIED');assert.equal(f.reads.length,before);
 f.signal.abort();await assert.rejects(f.broker.execute(logCall('cancelled')),e=>e instanceof CommandError&&e.code==='CANCELLED');assert.equal(f.reads.length,before);assert.equal(f.effects(),0);
});

test('command fitting checks a whole UTF-8 scalar when its base64 byte prefix costs more',async()=>{
 const raw=Buffer.from('中'.repeat(2000)),f=logFixture(raw),three=f.controller.log({...logCall('three').arguments,maxBytes:3});
 const budget=delivery(Buffer.byteLength(JSON.stringify({ok:true,value:{kind:'command_log',page:three}})));
 const broker=createCommandBroker({...budget,controller:f.controller,signal:f.signal.signal,authorize:()=>true,legacyBusy:()=>false});
 const p=page(await broker.execute(logCall('minimum-scalar')));assert.equal(p.data,'中');assert.equal(p.format,'utf8');assert.equal(p.endOffset,3);assert.equal(p.nextCursor?.offset,3);assert.equal(f.effects(),0);
});

function workFixture(text:string,cap=1800){
 const file:WorkCycleFile={fileId:'synthetic-file',relativePath:'result.txt',version:commandDigest(text),bytes:Buffer.byteLength(text),confirmation:'confirmed',origin:{kind:'write',changeId:'synthetic-change'}};
 let reads=0,mutations=0;const signal=new AbortController(),budget=delivery(cap);
 const workspace={read(id:string,version:string){reads++;if(id!==file.fileId)throw new WorkCycleError('FILE_UNAVAILABLE');if(version!==file.version)throw new WorkCycleError('SOURCE_CHANGED');return {file,text,verified:true};},list(){return[file];},async write(){mutations++;assert.fail('unexpected write');},async edit(){mutations++;assert.fail('unexpected edit');},async importFile(){mutations++;assert.fail('unexpected import');},async snapshot(){mutations++;assert.fail('unexpected program');}} as unknown as WorkCycleWorkspace;
 const runner:WorkCycleRunner={available(){mutations++;assert.fail('unexpected execution probe');},async run(){mutations++;assert.fail('unexpected program execution');},async close(){}};
 const broker=createWorkCycleBroker({...budget,workspace,runner,signal:signal.signal,authorize:()=>true,async importSource(){mutations++;assert.fail('unexpected import source');},beforeMutation(){mutations++;}});
 const call=(id:string,offset=0):Extract<ProjectReadToolCall,{toolName:'work_read'}>=>({...base,callId:id,toolName:'work_read',arguments:{fileId:file.fileId,version:file.version,offset}});
 return {file,broker,budget,signal,call,reads:()=>reads,mutations:()=>mutations};
}

test('work long-line Unicode and escaping paginate within actual capacity without scalar loss',async()=>{
 const text='中🙂"\\'.repeat(1000)+'尾',f=workFixture(text,1700);let offset=0,combined='';
 for(let i=0;i<50;i++){
  const call=f.call('page-'+i,offset),r=await f.broker.execute(call);assert(r.ok&&r.value.kind==='work_read');const v=r.value;
  assert(!v.text.includes('\ufffd'));assert.equal(v.offset,offset);assert(v.text.length>0);assert(Buffer.byteLength(v.text)<=4096);assert.equal(v.file.version,f.file.version);combined+=v.text;
  if(v.nextOffset===null){assert.equal(offset+Buffer.byteLength(v.text),f.file.bytes);break;}
  assert.equal(v.nextOffset,offset+Buffer.byteLength(v.text));offset=v.nextOffset;
 }
 assert.equal(combined,text);assert.equal(f.reads(),f.budget.published.length);assert.equal(f.mutations(),0);assert((await f.broker.execute({...base,callId:'list',toolName:'work_list',arguments:{}})).ok);
});

test('work can return one whole scalar, but never successful empty progress or split offsets',async()=>{
 const text='🙂'.repeat(1600),f=workFixture(text,1000),one={ok:true,value:{kind:'work_read',file:f.file,text:'🙂',offset:0,nextOffset:4}};
 const exact=workFixture(text,Buffer.byteLength(JSON.stringify(one))),r=await exact.broker.execute(exact.call('one'));assert.deepEqual(r,one);
 const short=workFixture(text,Buffer.byteLength(JSON.stringify(one))-1);assert.deepEqual(await short.broker.execute(short.call('no-scalar')),{ok:false,error:{code:'BUDGET_EXCEEDED'},coverage:null});
 assert.deepEqual(await f.broker.execute(f.call('split',1)),{ok:false,error:{code:'INVALID_REQUEST'},coverage:null});
 const stale=f.call('stale');assert.deepEqual(await f.broker.execute({...stale,arguments:{...stale.arguments,version:sha}}),{ok:false,error:{code:'SOURCE_CHANGED'},coverage:null});
 const foreign=f.call('foreign');assert.deepEqual(await f.broker.execute({...foreign,arguments:{...foreign.arguments,fileId:'foreign-file'}}),{ok:false,error:{code:'FILE_UNAVAILABLE'},coverage:null});
 const before=f.reads();f.signal.abort();await assert.rejects(f.broker.execute(f.call('cancelled')),e=>e instanceof WorkCycleError&&e.code==='CANCELLED');assert.equal(f.reads(),before);assert.equal(f.mutations(),0);
});

test('work mutations keep full reservation and failed durable publication never becomes success',async()=>{
 const f=workFixture('stored',1500);
 const args=[['work_write',{relativePath:'new.txt',expectedVersion:null,text:'new'}],['work_edit',{fileId:f.file.fileId,expectedVersion:f.file.version,oldText:'stored',newText:'new'}],['work_import',{fileId:f.file.fileId,version:f.file.version,relativePath:'import.txt',expectedVersion:null}],['work_run',{fileId:f.file.fileId,version:f.file.version}]] as const;
 for(const [toolName,a] of args)assert.deepEqual(await f.broker.execute({...base,callId:toolName,toolName,arguments:a} as ProjectReadToolCall),{ok:false,error:{code:'BUDGET_EXCEEDED'},coverage:null});assert.equal(f.mutations(),0);
 const budget=delivery(),broker=createWorkCycleBroker({...budget,workspace:{read(){return {file:f.file,text:'stored',verified:true};}} as unknown as WorkCycleWorkspace,runner:{} as WorkCycleRunner,signal:new AbortController().signal,authorize:()=>true,async importSource(){assert.fail('unexpected');},async publish(){throw Error('synthetic durable failure');}});
 await assert.rejects(broker.execute(f.call('durable')),e=>e instanceof WorkCycleError&&e.code==='STORAGE_FAILED');assert.equal(budget.published.length,0);
});
