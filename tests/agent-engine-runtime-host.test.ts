import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PILOT_VERSION, parsePilotDisk, parsePilotResult, type PilotDisk, type PilotEvent } from '../apps/desktop/src/shared/agent/engine-pilot';
import { createPilotHost } from '../apps/desktop/src/main/engine-pilot/host';
import { createFakePilotEngine } from '../apps/desktop/src/main/engine-pilot/fake-engine';
import type { PilotEngine } from '../apps/desktop/src/main/engine-pilot/engine';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'pilot',windowId:'pilot',webContentsId:1,workspaceId:'pilot',rootId:'pilot'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function memory(initial:PilotDisk={version:1,runs:[]}){let disk=parsePilotDisk(initial),writes=0,broken=false;return {load:()=>disk,save:(value:PilotDisk)=>{if(broken)throw Error();disk=parsePilotDisk(value);writes++;},close(){},stats:()=>({disk,writes}),break:()=>{broken=true;}};}
async function setup(engine:PilotEngine=createFakePilotEngine('sum'),store=memory(),timing: {deadlineMs?:number;waitMs?:number}={}) {
  const host=createPilotHost({owner,engine,store,...timing});await host.initialization;
  const startRequest={contractVersion:PILOT_VERSION,clientRequestId:randomUUID(),goal:'sum demonstration',constraint:''};
  async function start(request=startRequest){const result=parsePilotResult('startRun',await host.invoke('startRun',owner,request));assert.equal(result.ok,true);if(!result.ok)throw Error();return result.value.runId;}
  async function events(runId:string){let afterSequence=0;const all:PilotEvent[]=[];for(;;){const result=parsePilotResult('readRun',await host.invoke('readRun',owner,{contractVersion:PILOT_VERSION,runId,afterSequence}));if(!result.ok)throw Error(result.error.code);all.push(...result.value.events);if(result.value.events.length===0||result.value.terminal)return all;afterSequence=result.value.nextSequence;}}
  return {host,store,start,startRequest,events};
}
test('pilot fake loop persists exact tool arguments/result before final and does not confuse fake with model',async()=>{
  const s=await setup();try{const id=await s.start();await tick();const events=await s.events(id);assert.equal(events.at(-1)?.type,'run.completed');const started=events.find(e=>e.type==='tool.started'),completed=events.find(e=>e.type==='tool.completed');assert.ok(started?.type==='tool.started'&&completed?.type==='tool.completed');assert.equal(started.data.callId,completed.data.callId);assert.equal(completed.data.result.sum,6);assert.equal(s.store.stats().disk.runs[0]?.engineKind,'fake');assert.ok(s.store.stats().writes>=7);}finally{s.host.revoke();}
});
test('pilot question pauses active deadline; answer is durable before forwarding and cannot replay',async()=>{
  const s=await setup(createFakePilotEngine('question'),memory(),{deadlineMs:100,waitMs:1000});try{const id=await s.start();await tick();await new Promise(r=>setTimeout(r,150));assert.equal(s.store.stats().disk.runs[0]?.status,'waiting_user');const question=(await s.events(id)).find(e=>e.type==='question.asked');assert.ok(question?.type==='question.asked');const request={contractVersion:PILOT_VERSION,runId:id,questionId:question.data.questionId,answer:'continue local fixture'};assert.deepEqual(await s.host.invoke('answerQuestion',owner,request),{ok:true,value:{accepted:true}});await tick();assert.equal((await s.events(id)).at(-1)?.type,'run.completed');assert.deepEqual(await s.host.invoke('answerQuestion',owner,request),{ok:false,error:{code:'STALE_QUESTION'}});}finally{s.host.revoke();}
});
test('pilot owner/idempotency before busy; stop is unique and denies late notices',async()=>{
  const s=await setup(createFakePilotEngine('stall'));try{const id=await s.start();assert.deepEqual(await s.host.invoke('startRun',owner,s.startRequest),{ok:true,value:{runId:id}});assert.deepEqual(await s.host.invoke('startRun',{...owner,navigationEpoch:2},s.startRequest),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.deepEqual(await s.host.invoke('startRun',owner,{...s.startRequest,clientRequestId:randomUUID()}),{ok:false,error:{code:'BUSY'}});assert.deepEqual(await s.host.invoke('stopRun',owner,{contractVersion:PILOT_VERSION,runId:id}),{ok:true,value:{status:'stopped'}});assert.deepEqual(await s.host.invoke('stopRun',owner,{contractVersion:PILOT_VERSION,runId:id}),{ok:true,value:{status:'already_terminal'}});assert.equal((await s.events(id)).filter(e=>e.type==='run.stopped').length,1);}finally{s.host.revoke();}
});
test('pilot restart marks active disk interrupted without replaying engine',async()=>{
  const first=await setup(createFakePilotEngine('stall'));const id=await first.start();await tick();const crashImage=first.store.stats().disk;first.host.revoke();let starts=0;const engine: PilotEngine={kind:'fake',version:'test',health:async()=>true,start:async()=>{starts++;},answer:async()=>{},stop:async()=>{},dispose(){}};const second=await setup(engine,memory(crashImage));try{assert.equal((await second.events(id)).at(-1)?.type,'run.interrupted');assert.equal(second.store.stats().disk.runs[0]?.status,'interrupted');assert.equal(starts,0);}finally{second.host.revoke();}
});
test('pilot storage failure prevents executor start and fails closed',async()=>{
  let starts=0;const engine: PilotEngine={kind:'fake',version:'test',health:async()=>true,start:async()=>{starts++;},answer:async()=>{},stop:async()=>{},dispose(){}};const s=await setup(engine);s.store.break();try{assert.deepEqual(await s.host.invoke('startRun',owner,s.startRequest),{ok:false,error:{code:'STORAGE_FAILED'}});await tick();assert.equal(starts,0);}finally{s.host.revoke();}
});
test('pilot rejects callback before native session binding and repeated no-progress calls',async()=>{
  for(const early of [true,false]){let toolCalls=0;const engine: PilotEngine={kind:'fake',version:'test',health:async()=>true,async start({callbacks}){if(early){callbacks.notice({type:'text',text:'unbound'});return;}callbacks.notice({type:'started',sessionId:'native.session'});callbacks.notice({type:'step',step:1,usage:null});for(let i=0;i<3;i++){toolCalls++;await callbacks.tool({sessionId:'native.session',callId:`call.${i}`,toolName:'pilot.sum.v1',arguments:{values:[1]}});}},answer:async()=>{},stop:async()=>{},dispose(){}};const s=await setup(engine);try{const id=await s.start();await tick();const end=(await s.events(id)).at(-1);assert.ok(end?.type==='run.failed');assert.equal(end.data.code,early?'PROTOCOL_ERROR':'NO_PROGRESS');assert.equal(toolCalls,early?0:3);}finally{s.host.revoke();}}
});
test('pilot timeout interrupts user wait separately from active execution failure',async()=>{
  for(const scenario of ['stall','question'] as const){const s=await setup(createFakePilotEngine(scenario),memory(),{deadlineMs:20,waitMs:40});try{const id=await s.start();await new Promise(r=>setTimeout(r,70));const end=(await s.events(id)).at(-1);assert.equal(end?.type,scenario==='stall'?'run.failed':'run.interrupted');}finally{s.host.revoke();}}
});
test('pilot cleanup rejection disables readiness without rewriting the durable stopped terminal',async()=>{
  const engine={...createFakePilotEngine('stall'),stop:async()=>{throw Error('cleanup failed');}},s=await setup(engine);
  try{const id=await s.start();await tick();await s.host.invoke('stopRun',owner,{contractVersion:PILOT_VERSION,runId:id});await tick();const status=parsePilotResult('getStatus',await s.host.invoke('getStatus',owner,{contractVersion:PILOT_VERSION}));assert.ok(status.ok);if(status.ok)assert.equal(status.value.ready,false);assert.equal((await s.events(id)).at(-1)?.type,'run.stopped');assert.deepEqual(await s.host.invoke('startRun',owner,{...s.startRequest,clientRequestId:randomUUID()}),{ok:false,error:{code:'NOT_READY'}});}finally{s.host.revoke();}
});
