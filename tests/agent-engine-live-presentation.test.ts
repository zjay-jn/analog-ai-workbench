import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {App} from '../apps/desktop/src/renderer/App';
import SessionModule = require('../apps/desktop/src/renderer/agent/SessionWorkspace');
import {EnginePilotView} from '../apps/desktop/src/renderer/agent/EnginePilotPanel';
import {ToolWorkspaceModes,ToolWorkspaceModesView} from '../apps/desktop/src/renderer/agent/ToolWorkspaceModes';
import {createEnginePilotController,initialEnginePilotState,pilotCanStart,projectPilotEvents} from '../apps/desktop/src/renderer/agent/engine-pilot-controller';
import {PILOT_RULES_REVISION,parsePilotEvent,type EnginePilotApi,type PilotEvent,type PilotStatus,type PilotSummary,type PilotRequests} from '../apps/desktop/src/shared/agent/engine-pilot';

const id='pilot.11111111-1111-4111-8111-111111111111',clientId='33333333-3333-4333-8333-333333333333',time='2026-09-11T08:00:00.000Z';
const model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const idle:PilotStatus={engineKind:'opencode',engineVersion:'1.18.17',model,canStart:true,processState:'idle',availability:'available',ready:false,capabilities:['pilot.sum.v1'],maxRuns:32};
const event=(sequence:number,type:PilotEvent['type'],data:unknown)=>parsePilotEvent({runId:id,sequence,time,type,data});
const accepted=(goal='请计算 18、-7 和 4 的和。')=>event(1,'run.accepted',{goal,constraint:'',engineKind:'opencode',engineVersion:'1.18.17',rulesRevision:PILOT_RULES_REVISION,model});
function fixture(overrides:Partial<EnginePilotApi>={}){
  const data:{status:PilotStatus;runs:PilotSummary[];events:PilotEvent[]}={status:idle,runs:[],events:[]};
  const calls:string[]=[],starts:PilotRequests['startRun'][]=[],answers:PilotRequests['answerQuestion'][]=[];
  const scheduled=new Map<number,()=>void>();let serial=0;
  const api:EnginePilotApi={
    getStatus:async()=>{calls.push('status');return{ok:true,value:data.status};},
    listRuns:async()=>{calls.push('list');return{ok:true,value:{runs:data.runs}};},
    startRun:async request=>{calls.push('start');starts.push(request);data.events=[accepted(request.goal),event(2,'engine.started',{sessionId:'native.live.1'})];return{ok:true,value:{runId:id}};},
    readRun:async request=>{calls.push('read');const events=data.events.slice(request.afterSequence,request.afterSequence+32);return{ok:true,value:{runId:id,events,nextSequence:request.afterSequence+events.length,terminal:['run.completed','run.failed','run.stopped','run.interrupted'].includes(data.events.at(-1)?.type??'')}};},
    answerQuestion:async request=>{calls.push('answer');answers.push(request);return{ok:true,value:{accepted:true}};},
    stopRun:async()=>{calls.push('stop');return{ok:true,value:{status:'stopped'}};},...overrides,
  };
  const c=createEnginePilotController(api,{set:fn=>{scheduled.set(++serial,fn);return serial;},clear:handle=>{scheduled.delete(handle as number);}},()=>clientId);
  const history=(events:PilotEvent[])=>{data.events=events;data.runs=[{runId:id,goal:'历史任务',status:'completed',createdAt:time,updatedAt:time,engineKind:'opencode',model}];};
  return{data,c,calls,starts,answers,scheduled,api,history};
}
function inWindow(value:unknown,run:()=>void){const old=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value});try{run();}finally{if(old)Object.defineProperty(globalThis,'window',old);else Reflect.deleteProperty(globalThis,'window');}}

test('normal App composition defaults to the chat child and does not eagerly render or call tools',context=>{
  // The existing session external store has no SSR snapshot. Keep this test at
  // the App composition boundary; real chat state preservation is desktop QA.
  context.mock.method(SessionModule,'SessionWorkspace',()=>createElement('p',null,'现有聊天区域'));
  let calls=0;const bridge=new Proxy({}, {get(){calls++;throw new Error('Tool bridge accessed before entry');}});
  inWindow({workbenchEnginePilot:bridge,workbenchAgentProjectRead:bridge,workbenchSessions:{}},()=>{
    const html=renderToStaticMarkup(createElement(App));
    assert(html.includes('聊天与文件'));assert(html.includes('工具任务'));assert(html.includes('现有聊天区域'));
    assert(!html.includes('data-engine-pilot="true"'));assert(!html.includes('fixture-notes.txt'));assert(!html.includes('flat-basic.schematic'));assert.equal(calls,0);
    assert.match(html,/id="workspace-tools"[^>]*hidden=""[^>]*inert=""/);
  });
});

test('mode layout keeps visited views in the tree and hides only the inactive view',()=>{
  let rendered=0;function Tools(){rendered++;return createElement('p',null,'工具回答草稿');}
  const chat=createElement('textarea',{defaultValue:'聊天草稿'}),tools=createElement(Tools);
  renderToStaticMarkup(createElement(ToolWorkspaceModes,{chat,tools}));assert.equal(rendered,0);
  for(const mode of ['tools','chat'] as const){
    const html=renderToStaticMarkup(createElement(ToolWorkspaceModesView,{mode,toolsVisited:true,chat,tools,onSelect:()=>{throw new Error('Rendering must not navigate');}}));
    assert(html.includes('聊天草稿'));assert(html.includes('工具回答草稿'));
    assert.match(html,new RegExp(`id="workspace-${mode==='chat'?'tools':'chat'}"[^>]*hidden=""[^>]*inert=""`));
    assert.doesNotMatch(html,new RegExp(`id="workspace-${mode}"[^>]*hidden=""`));
  }
});

test('idle live engine starts only on explicit natural language input and sends exactly the displayed model',async()=>{
  const f=fixture();try{
    await f.c.load();assert.deepEqual(f.calls,['status','list']);assert.equal(f.c.snapshot().engine?.ready,false);assert(pilotCanStart(f.c.snapshot().engine));
    const goal='请用计算工具把 18、-7 和 4 相加，然后解释结果。';assert.equal(await f.c.start(goal,''),true);
    assert.equal(f.starts.length,1);assert.deepEqual(f.starts[0],{contractVersion:'workbench.engine-pilot.v1',clientRequestId:clientId,goal,constraint:'',model});
    assert.deepEqual(projectPilotEvents(f.c.snapshot().events).model,model);assert.deepEqual(f.c.snapshot().runs[0]?.model,model);
  }finally{f.c.dispose();}
});

test('unavailable or unsupported configuration still shows the historical model and confirmed result',async()=>{
  for(const availability of ['not_configured','unsupported_model','unavailable'] as const){
    const f=fixture();try{
      f.data.status={engineKind:'opencode',engineVersion:'1.18.17',ready:false,canStart:false,processState:'idle',availability,capabilities:['pilot.sum.v1'],maxRuns:32};
      f.history([accepted(),event(2,'tool.started',{callId:'sum.actual',toolName:'pilot.sum.v1',arguments:{values:[18,-7,4]}}),event(3,'tool.completed',{callId:'sum.actual',result:{sum:15,count:3,source:'deterministic-local',toolVersion:'pilot.sum.v1'}}),event(4,'run.completed',{})]);
      await f.c.load();assert.equal(await f.c.start('新任务',''),false);assert(!f.calls.includes('start'));assert.equal(f.c.snapshot().terminal,true);
      const html=renderToStaticMarkup(createElement(EnginePilotView,{state:f.c.snapshot(),actions:f.c,mode:'live',onOpenSettings:()=>{}}));
      assert(html.includes('尚未确定可用模型'));assert(html.includes('本次模型：DeepSeek'));assert(html.includes('data-run-model="deepseek-v4-flash"'));assert(html.includes('模型设置'));assert(html.includes('15'));assert(html.includes('未知'));
    }finally{f.c.dispose();}
  }
});

test('status transport failure does not prevent independent history reads or invent availability',async()=>{
  const f=fixture({getStatus:async()=>{throw new Error('unavailable');}});try{
    f.history([accepted(),event(2,'run.interrupted',{reason:'window'})]);await f.c.load();
    assert.equal(f.c.snapshot().engine,null);assert.equal(projectPilotEvents(f.c.snapshot().events).status,'interrupted');assert(f.c.snapshot().error);assert(f.calls.includes('read'));assert(!f.calls.includes('start'));
  }finally{f.c.dispose();}
});

test('rejected stale settings require a manual refresh and a new explicit start without automatic retry',async()=>{
  let attempts=0;const f=fixture({startRun:async()=>{attempts++;return{ok:false,error:{code:'NOT_READY'}};}});try{
    await f.c.load();assert.equal(await f.c.start('计算 1 + 2',''),false);assert.equal(attempts,1);assert.equal(f.c.snapshot().selectedRunId,null);
    await f.c.refresh();assert.equal(attempts,1);assert.equal(f.c.snapshot().pending,null);
  }finally{f.c.dispose();}
});

test('refreshing current settings does not relabel an accepted running task',async()=>{
  const f=fixture();try{
    await f.c.load();await f.c.start('计算 1 + 2','');
    f.data.status={engineKind:'opencode',engineVersion:'1.18.17',ready:false,canStart:false,processState:'ready',availability:'unsupported_model',capabilities:['pilot.sum.v1'],maxRuns:32};
    await f.c.refresh();assert.equal(f.c.snapshot().engine?.model,undefined);assert.deepEqual(projectPilotEvents(f.c.snapshot().events).model,model);
    assert.equal(f.starts.length,1);assert(!f.calls.includes('stop'));
  }finally{f.c.dispose();}
});

test('free text questions bind to the actual question ID and answers are not submitted twice',async()=>{
  const f=fixture();try{
    await f.c.load();await f.c.start('请按我补充的条件计算','');
    f.data.events.push(event(3,'question.asked',{questionId:'que.dynamic.987',prompt:'要排除哪一个数？'}));await f.c.poll();
    const answer='排除负数，剩余数字相加。';assert.equal(await f.c.answer('que.dynamic.987',answer),true);assert.equal(await f.c.answer('que.dynamic.987',answer),false);
    assert.deepEqual(f.answers,[{contractVersion:'workbench.engine-pilot.v1',runId:id,questionId:'que.dynamic.987',answer}]);
  }finally{f.c.dispose();}
});

test('disposing the UI cancels polling without submitting a stop or replaying execution',async()=>{
  const f=fixture();await f.c.load();await f.c.start('计算 1 + 2','');assert(f.scheduled.size>0);f.c.dispose();
  assert.equal(f.scheduled.size,0);assert.equal(f.calls.filter(call=>call==='start').length,1);assert(!f.calls.includes('stop'));assert(!f.calls.includes('answer'));
});

test('model.response owns live usage and response identity without counting or overwriting native steps',()=>{
  const events=[accepted(),event(2,'model.step',{step:1,usage:{inputTokens:0,outputTokens:0}})];
  assert.equal(projectPilotEvents(events).usage,null);
  events.push(event(3,'model.response',{request:1,responseModel:'actual-provider-model',usage:{inputTokens:100,outputTokens:20}}),event(4,'model.step',{step:2,usage:{inputTokens:0,outputTokens:0}}));
  assert.deepEqual(projectPilotEvents(events).usage,{inputTokens:100,outputTokens:20});
  events.push(event(5,'model.response',{request:3,responseModel:'reported-model-2',usage:{inputTokens:40,outputTokens:5}}),event(6,'model.step',{step:3,usage:{inputTokens:0,outputTokens:0}}));
  const run=projectPilotEvents(events);assert.deepEqual(run.usage,{inputTokens:40,outputTokens:5});assert.equal(run.response?.request,3);assert.equal(run.response?.responseModel,'reported-model-2');
  const f=fixture();try{
    const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,engine:idle,selectedRunId:id,events},actions:f.c,mode:'live'}));
    assert(html.includes('最近已验证响应用量'));assert(html.includes('输入 40 / 输出 5 tokens'));assert(html.includes('reported-model-2'));assert(html.includes('对应请求序号'));assert(!html.includes('最近模型步骤用量'));assert(!html.includes('输入 140'));assert(!html.includes('输入 0 / 输出 0'));
  }finally{f.c.dispose();}
});

test('model.response missing actual usage or response model stays unknown after native zero normalization',()=>{
  const events=[accepted(),event(2,'model.response',{request:1,responseModel:'earlier-model',usage:{inputTokens:100,outputTokens:20}}),
    event(3,'model.response',{request:2,responseModel:null,usage:null}),event(4,'model.step',{step:2,usage:{inputTokens:0,outputTokens:0}})];
  const run=projectPilotEvents(events);assert.equal(run.usage,null);assert.equal(run.response?.responseModel,null);
  const f=fixture();try{
    const html=renderToStaticMarkup(createElement(EnginePilotView,{state:{...initialEnginePilotState,engine:idle,selectedRunId:id,events},actions:f.c,mode:'live'}));
    assert.match(html,/最近已验证响应用量[^<]*(?:<!-- -->)*未知/);assert.match(html,/响应模型[^<]*(?:<!-- -->)*未知/);
    assert(!html.includes('earlier-model'));assert(!html.includes('输入 0'));assert(!html.includes('V4.1'));
  }finally{f.c.dispose();}
});

test('model.response addition preserves old mock model.step usage semantics',()=>{
  const legacy=event(1,'run.accepted',{goal:'旧模拟任务',constraint:'',engineKind:'fake',engineVersion:'fake-1',rulesRevision:PILOT_RULES_REVISION});
  const events=[legacy,event(2,'model.step',{step:1,usage:{inputTokens:7,outputTokens:2}})];
  assert.deepEqual(projectPilotEvents(events).usage,{inputTokens:7,outputTokens:2});
  events.push(event(3,'model.step',{step:2,usage:null}));assert.equal(projectPilotEvents(events).usage,null);assert.equal(projectPilotEvents(events).response,null);
});
