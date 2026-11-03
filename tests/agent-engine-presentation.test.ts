import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createEnginePilotController,initialEnginePilotState,projectPilotEvents} from '../apps/desktop/src/renderer/agent/engine-pilot-controller';
import {EnginePilotView} from '../apps/desktop/src/renderer/agent/EnginePilotPanel';
import {App} from '../apps/desktop/src/renderer/App';
import {PILOT_RULES_REVISION,parsePilotEvent,type EnginePilotApi,type PilotEvent,type PilotState,type PilotSummary} from '../apps/desktop/src/shared/agent/engine-pilot';

const A='pilot.11111111-1111-4111-8111-111111111111',B='pilot.22222222-2222-4222-8222-222222222222';
const time='2026-09-10T10:00:00.000Z',clientId='33333333-3333-4333-8333-333333333333';
const engine={engineKind:'fake' as const,engineVersion:'fake-1',ready:true,capabilities:['pilot.sum.v1'] as const,maxRuns:32 as const};
function event(runId:string,sequence:number,type:PilotEvent['type'],data:unknown):PilotEvent{return parsePilotEvent({runId,sequence,time,type,data});}
const accepted=(id=A)=>event(id,1,'run.accepted',{goal:'计算 1 + 2',constraint:'',engineKind:'fake',engineVersion:'fake-1',rulesRevision:PILOT_RULES_REVISION});
const initial=(id=A)=>[accepted(id),event(id,2,'engine.started',{sessionId:'session.1'})];
const summary=(id:string,status:PilotState='running'):PilotSummary=>({runId:id,goal:'计算 1 + 2',status,createdAt:time,updatedAt:time,engineKind:'fake'});
const deferred=<T,>()=>{let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
  const logs=new Map<string,PilotEvent[]>(),runs:PilotSummary[]=[],calls:string[]=[];
  const scheduled=new Map<number,()=>void>();let timerId=0;
  const clock={set:(fn:()=>void)=>{scheduled.set(++timerId,fn);return timerId;},clear:(id:unknown)=>{scheduled.delete(id as number);}};
  const api:EnginePilotApi={
    getStatus:async()=>{calls.push('status');return{ok:true,value:engine};},listRuns:async()=>{calls.push('list');return{ok:true,value:{runs:[...runs]}};},
    startRun:async()=>{calls.push('start');logs.set(A,initial());runs.push(summary(A));return{ok:true,value:{runId:A}};},
    readRun:async r=>{calls.push(`read:${r.runId}:${r.afterSequence}`);const all=logs.get(r.runId)??[],events=all.slice(r.afterSequence,r.afterSequence+32),nextSequence=r.afterSequence+events.length;
      return{ok:true,value:{runId:r.runId,events,nextSequence,terminal:nextSequence===all.length&&['run.completed','run.failed','run.stopped','run.interrupted'].includes(all.at(-1)?.type??'')}};},
    answerQuestion:async()=>{calls.push('answer');return{ok:true,value:{accepted:true}};},stopRun:async()=>{calls.push('stop');return{ok:true,value:{status:'stopped'}};},
  };
  const create=(override:Partial<EnginePilotApi>={})=>createEnginePilotController({...api,...override},clock,()=>clientId);
  return{logs,runs,calls,scheduled,create,api};
}

test('pilot load reads only the dedicated bridge and never starts or replays a run',async()=>{
  const f=fixture();f.logs.set(A,[...initial(),event(A,3,'run.interrupted',{reason:'restart'})]);f.runs.push(summary(A,'interrupted'));
  const c=f.create();await c.load();assert.equal(projectPilotEvents(c.snapshot().events).status,'interrupted');
  assert.equal(f.calls.includes('start'),false);assert.equal(f.scheduled.size,0);assert.equal(c.snapshot().terminal,true);c.dispose();
});
test('start is single-flight and uncertain retries preserve the same client request identity',async()=>{
  const f=fixture(),wait=deferred<Awaited<ReturnType<EnginePilotApi['startRun']>>>(),ids:string[]=[];let first=true;
  const c=f.create({startRun:async req=>{ids.push(req.clientRequestId);if(first){first=false;return wait.promise;}return f.api.startRun(req);}});await c.load();
  const pending=c.start('目标','');assert.equal(c.snapshot().pending,'start');assert.equal(await c.start('目标',''),false);
  wait.reject(new Error('Transport unavailable'));assert.equal(await pending,false);assert.equal(await c.start('目标',''),true);
  assert.deepEqual(ids,[clientId,clientId]);assert.equal(await c.start('第二个目标',''),false);c.dispose();
});
test('continuous pagination pairs actual tool results and reaches completion only at the terminal head',async()=>{
  const f=fixture(),log=initial();
  log.push(event(A,3,'tool.started',{callId:'call.1',toolName:'pilot.sum.v1',arguments:{values:[1,2]}}));
  log.push(event(A,4,'tool.completed',{callId:'call.1',result:{sum:3,count:2,source:'deterministic-local',toolVersion:'pilot.sum.v1'}}));
  for(let i=5;i<=34;i++)log.push(event(A,i,'message.delta',{text:'已完成'}));log.push(event(A,35,'run.completed',{}));
  f.logs.set(A,log);f.runs.push(summary(A,'completed'));const c=f.create();await c.load();
  assert.equal(c.snapshot().events.length,32);assert.equal(c.snapshot().terminal,false);assert.equal(projectPilotEvents(c.snapshot().events).status,'running');
  await c.poll();assert.equal(c.snapshot().events.length,35);assert.equal(projectPilotEvents(c.snapshot().events).tools[0]?.result?.sum,3);
  assert.equal(c.snapshot().terminal,true);assert.equal(f.scheduled.size,0);c.dispose();
});
test('late read for a previously selected run cannot replace the current run and no reads overlap',async()=>{
  const f=fixture();f.runs.push(summary(A),summary(B));f.logs.set(B,initial(B));
  const wait=deferred<Awaited<ReturnType<EnginePilotApi['readRun']>>>();let busy=0,maxBusy=0;
  const c=f.create({readRun:async req=>{busy++;maxBusy=Math.max(maxBusy,busy);try{return req.runId===A?await wait.promise:await f.api.readRun(req);}finally{busy--;}}});
  const loading=c.load();await flush();await c.select(B);
  wait.resolve({ok:true,value:{runId:A,events:initial(),nextSequence:2,terminal:false}});await loading;
  assert.equal(c.snapshot().selectedRunId,B);assert.equal(c.snapshot().events.length,0);await c.poll();
  assert(c.snapshot().events.every(e=>e.runId===B));assert.equal(maxBusy,1);c.dispose();
});
test('answer binds the current question and suppresses duplicate accepted submissions until events advance',async()=>{
  const f=fixture();f.logs.set(A,[...initial(),event(A,3,'question.asked',{questionId:'q.1',prompt:'继续？'})]);f.runs.push(summary(A,'waiting_user'));
  const c=f.create();await c.load();assert.equal(await c.answer('q.old','好'),false);assert.equal(await c.answer('q.1','好'),true);
  assert.equal(await c.answer('q.1','重复'),false);assert.equal(f.calls.filter(x=>x==='answer').length,1);
  f.logs.get(A)!.push(event(A,4,'question.answered',{questionId:'q.1',answer:'好'}));await c.poll();assert.equal(projectPilotEvents(c.snapshot().events).question,null);c.dispose();
});
test('stop request stays pending until acknowledgement and a late model message never implies completion',async()=>{
  const f=fixture();f.logs.set(A,[...initial(),event(A,3,'message.delta',{text:'我已经全部完成了'})]);f.runs.push(summary(A));
  const wait=deferred<Awaited<ReturnType<EnginePilotApi['stopRun']>>>();const c=f.create({stopRun:async()=>wait.promise});await c.load();
  const pending=c.stop();assert.equal(c.snapshot().pending,'stop');assert.equal(projectPilotEvents(c.snapshot().events).status,'running');
  wait.resolve({ok:true,value:{status:'stopped'}});await pending;assert.equal(c.snapshot().stopAck,'stopped');assert.equal(c.snapshot().terminal,false);
  f.logs.get(A)!.push(event(A,4,'run.stopped',{reason:'user'}));await c.poll();assert.equal(projectPilotEvents(c.snapshot().events).status,'stopped');assert.equal(f.scheduled.size,0);c.dispose();
});
test('failed stop reports uncertainty without fabricating a terminal state',async()=>{
  const f=fixture();f.logs.set(A,initial());f.runs.push(summary(A));const c=f.create({stopRun:async()=>({ok:false,error:{code:'STORAGE_FAILED'}})});await c.load();await c.stop();
  assert.equal(c.snapshot().stopAck,null);assert.equal(c.snapshot().terminal,false);assert(c.snapshot().error?.includes('保存失败'));c.dispose();
});
test('out-of-order and wrong-run pages are rejected without contaminating the selected timeline',async()=>{
  for(const foreign of [false,true]){
    const f=fixture();f.logs.set(A,initial());f.runs.push(summary(A));const c=f.create({readRun:async()=>({ok:true,value:{runId:foreign?B:A,events:foreign?initial(B):[event(A,2,'engine.started',{sessionId:'bad'})],nextSequence:2,terminal:false}})});await c.load();
    assert.equal(c.snapshot().events.length,0);assert(c.snapshot().error);assert.equal(f.scheduled.size,0);c.dispose();
  }
});
test('dispose clears the scheduled poll and ignores pending bridge responses',async()=>{
  const f=fixture();f.logs.set(A,initial());f.runs.push(summary(A));const c=f.create();await c.load();assert.equal(f.scheduled.size,1);
  const before=c.snapshot();c.dispose();assert.equal(f.scheduled.size,0);await c.poll();assert.equal(c.snapshot(),before);
  const wait=deferred<Awaited<ReturnType<EnginePilotApi['getStatus']>>>(),other=f.create({getStatus:async()=>wait.promise});const loading=other.load();other.dispose();wait.resolve({ok:true,value:engine});await loading;
  assert.equal(other.snapshot().engine,null);
});
test('presentation labels fake execution, escapes model text, and leaves unknown usage unknown',()=>{
  const events=[...initial(),event(A,3,'message.delta',{text:'<script>alert(1)</script> 已完成'}),event(A,4,'question.asked',{questionId:'q.1',prompt:'<img src=x onerror=alert(1)>'})];
  const actions={start:async()=>false,answer:async()=>false,stop:async()=>{},select:async()=>{},refresh:async()=>{}};
  const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,engine,loading:false,selectedRunId:A,events},actions}));
  assert(html.includes('本地模拟 provider'));assert(html.includes('等待回答'));assert(html.includes('未知'));assert(!html.includes('<script>'));assert(!html.includes('<img src='));assert(html.includes('&lt;script&gt;'));assert(!html.includes('已完成</strong>'));
});
test('oversized multibyte inputs are rejected locally without calling the bridge',async()=>{
  const f=fixture(),c=f.create();await c.load();assert.equal(await c.start('中'.repeat(1400),''),false);assert(!f.calls.includes('start'));assert(c.snapshot().error?.includes('4096'));
  f.logs.set(A,[...initial(),event(A,3,'question.asked',{questionId:'q.1',prompt:'回答'})]);await c.select(A);
  assert.equal(await c.answer('q.1','中'.repeat(1400)),false);assert(!f.calls.includes('answer'));c.dispose();
});
test('an uncertain answer cannot be resubmitted until the user reopens the authoritative record',async()=>{
  const f=fixture();f.logs.set(A,[...initial(),event(A,3,'question.asked',{questionId:'q.1',prompt:'回答'})]);f.runs.push(summary(A,'waiting_user'));let count=0;
  const c=f.create({answerQuestion:async()=>{count++;throw new Error('lost acknowledgement');}});await c.load();await c.answer('q.1','好');await c.answer('q.1','好');assert.equal(count,1);
  assert.equal(c.snapshot().answerUnconfirmed,true);
  const html=renderToStaticMarkup(createElement(EnginePilotView,{state:c.snapshot(),actions:c}));
  assert(html.includes('提交未确认，请核对记录'));assert(!html.includes('回答已提交'));assert(html.includes('disabled=""'));
  await c.select(A);assert.equal(c.snapshot().answeredQuestion,null);c.dispose();
});
test('a stale list refresh does not roll a newer terminal event back to running',async()=>{
  const f=fixture();f.logs.set(A,initial());f.runs.push(summary(A));const wait=deferred<Awaited<ReturnType<EnginePilotApi['listRuns']>>>();let delayed=false;
  const c=f.create({listRuns:async()=>delayed?wait.promise:f.api.listRuns({contractVersion:'workbench.engine-pilot.v1'})});await c.load();delayed=true;
  const refreshing=c.refresh();f.logs.get(A)!.push(event(A,3,'run.stopped',{reason:'user'}));await c.poll();
  wait.resolve({ok:true,value:{runs:[summary(A)]}});await refreshing;assert.equal(c.snapshot().runs[0]?.status,'stopped');assert.equal(c.snapshot().terminal,true);c.dispose();
});

test('App standalone pilot branch excludes legacy documents without a sessions bridge',()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'window'),f=fixture();
  try{
      Object.defineProperty(globalThis,'window',{configurable:true,value:{workbenchEnginePilot:f.api}});
      const html=renderToStaticMarkup(createElement(App));assert(html.includes('data-engine-pilot="true"'));
      for(const marker of ['document-pane','统一文档工作区','document-panel-text','document-panel-schematic','fixture-notes.txt','flat-basic.schematic'])assert(!html.includes(marker),`Pilot must exclude ${marker}`);
  }
  finally{if(old)Object.defineProperty(globalThis,'window',old);else Reflect.deleteProperty(globalThis,'window');}
});

test('App ordinary entry retains legacy documents without a pilot bridge',()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
  try{
    const html=renderToStaticMarkup(createElement(App));assert(!html.includes('data-engine-pilot="true"'));
    for(const marker of ['document-pane','统一文档工作区','document-panel-text','document-panel-schematic','fixture-notes.txt','flat-basic.schematic'])assert(html.includes(marker),`Ordinary entry must retain ${marker}`);
  }
  finally{if(old)Object.defineProperty(globalThis,'window',old);else Reflect.deleteProperty(globalThis,'window');}
});
