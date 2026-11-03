import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCommandBroker} from '../apps/desktop/src/main/agent-command/broker';
import {CommandError,type CommandController} from '../apps/desktop/src/main/agent-command/types';
import {COMMAND_LIMITS as L,type CommandLogPage} from '../apps/desktop/src/shared/agent/agent-command';
import {PROJECT_READ_LIMITS,type ProjectReadToolCall} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {ProjectReadPublication} from '../apps/desktop/src/main/cloud/project-read-broker';

// Entirely synthetic, in-memory log and delivery budget. No filesystem or program execution.
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const prefix=digest('synthetic-prefix');
const logCall=(callId:string,offset=0,maxBytes=16384):ProjectReadToolCall=>({sessionId:'synthetic-session',messageId:'synthetic-message',callId,toolName:'command_log',arguments:{executionId:'synthetic-command',stream:'stdout',offset,maxBytes,expectedPrefixVersion:prefix}});
function fixture(consumed:number,durableCapacityExhausted=false){
 let used=consumed,reads=0,sideEffects=0;
 const raw='x'.repeat(40000),published:ProjectReadPublication[]=[],admissions:ProjectReadPublication[]=[];
 const controller={
  async inspect(){return {environments:[],workspace:null};},
  log(args:Parameters<CommandController['log']>[0]):CommandLogPage{
   reads++;const data=raw.slice(args.offset,args.offset+args.maxBytes),endOffset=args.offset+data.length;
   return {executionId:args.executionId,stream:args.stream,prefixVersion:prefix,offset:args.offset,endOffset,snapshotBytes:raw.length,availableBytes:raw.length,format:'utf8',data,bytesSha256:digest(data),nextCursor:endOffset<raw.length?{offset:endOffset,prefixVersion:prefix}:null,streamClosed:true,coverage:'complete',hasNewerBytes:false};
  },
  async start(){sideEffects++;throw Error('unexpected command start');},
  async stop(){sideEffects++;throw Error('unexpected command stop');},
 } as unknown as CommandController;
 const broker=createCommandBroker({controller,signal:new AbortController().signal,authorize:()=>true,legacyBusy:()=>false,
  remainingToolBytes:()=>PROJECT_READ_LIMITS.toolContextBytes-used,
  canDeliver(publication){admissions.push(publication);return Buffer.byteLength(JSON.stringify(publication.result))+(publication.reserveBytes??0)<=PROJECT_READ_LIMITS.toolContextBytes-used;},
  async publish(publication){if(durableCapacityExhausted)throw new CommandError('BUDGET_EXCEEDED');const bytes=Buffer.byteLength(JSON.stringify(publication.result));assert(used+bytes<=PROJECT_READ_LIMITS.toolContextBytes);used+=bytes;published.push(publication);},
 });
 return {broker,published,admissions,used:()=>used,reads:()=>reads,sideEffects:()=>sideEffects};
}

test('read-only log tail is delivered with exact budget even when a maximum event reservation would not fit',async()=>{
 const f=fixture(55000),call=logCall('tail',36864);
 assert(PROJECT_READ_LIMITS.toolContextBytes-f.used()<L.eventBytes);
 const result=await f.broker.execute(call);assert(result.ok&&result.value.kind==='command_log');
 if(!result.ok||result.value.kind!=='command_log')assert.fail('missing synthetic log tail');
 assert.equal(result.value.page.data,'x'.repeat(3136));assert.equal(result.value.page.nextCursor,null);assert.equal(result.value.page.streamClosed,true);assert.equal(f.reads(),1);assert.equal(f.published.length,1);
 assert.deepEqual(await f.broker.execute(call),result);assert.equal(f.reads(),1);assert.equal(f.published.length,1);
});

test('read-only logs shrink successfully within the actual remaining result budget',async()=>{
 const f=fixture(PROJECT_READ_LIMITS.toolContextBytes-2048);
 const result=await f.broker.execute(logCall('adaptive'));assert(result.ok&&result.value.kind==='command_log');
 assert(result.value.page.endOffset>0&&result.value.page.endOffset<4096);assert.equal(result.value.page.nextCursor?.offset,result.value.page.endOffset);
 assert.equal(f.published.length,1);assert(f.reads()>1);
 const environment:ProjectReadToolCall={sessionId:'synthetic-session',messageId:'synthetic-message',callId:'inspect-small',toolName:'command_environment',arguments:{}};
 assert((await f.broker.execute(environment)).ok);assert(f.used()<=PROJECT_READ_LIMITS.toolContextBytes);assert.equal(f.sideEffects(),0);
});

test('explicit 16 KiB command log pages are honored when actual delivery capacity permits',async()=>{
 const f=fixture(0),call=logCall('explicit-large',0,16384),result=await f.broker.execute(call);
 assert(result.ok&&result.value.kind==='command_log');assert.equal(result.value.page.endOffset,16384);assert.equal(result.value.page.data,'x'.repeat(16384));assert.equal(result.value.page.nextCursor?.offset,16384);assert.equal(f.reads(),1);assert.equal(f.sideEffects(),0);
 const small=await f.broker.execute(logCall('explicit-small',16384,512));assert(small.ok&&small.value.kind==='command_log');assert.equal(small.value.page.endOffset,16896);assert.equal(small.value.page.data.length,512);
});

test('command start and stop keep their full reservation before any execution side effect',async()=>{
 const f=fixture(55000),base={sessionId:'synthetic-session',messageId:'synthetic-message'};
 const start:ProjectReadToolCall={...base,callId:'start',toolName:'command_start',arguments:{requestId:'request',environmentId:'synthetic-env',environmentRevision:prefix,workspaceId:'synthetic-work',baselineVersion:prefix,cwdRelativePath:'',commandText:'synthetic only',timeoutMs:1000}};
 const stop:ProjectReadToolCall={...base,callId:'stop',toolName:'command_stop',arguments:{executionId:'synthetic-command'}};
 for(const call of [start,stop])await assert.rejects(f.broker.execute(call),(error:unknown)=>error instanceof CommandError&&error.code==='BUDGET_EXCEEDED');
 assert.equal(f.sideEffects(),0);assert.equal(f.published.length,0);assert(f.admissions.every(p=>p.reserveBytes===L.eventBytes));
});

test('a readable log is never reported as delivered when durable event capacity is exhausted',async()=>{
 const f=fixture(55000,true);
 await assert.rejects(f.broker.execute(logCall('no-event-capacity',32768)),(error:unknown)=>error instanceof CommandError&&error.code==='BUDGET_EXCEEDED');
 assert.equal(f.reads(),1);assert.equal(f.published.length,0);assert.equal(f.used(),55000);assert.equal(f.sideEffects(),0);
});
