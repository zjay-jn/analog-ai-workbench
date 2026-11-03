import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { PILOT_VERSION, PILOT_RULES_REVISION, parsePilotDisk, parsePilotResult, type PilotDisk, type PilotModel } from '../apps/desktop/src/shared/agent/engine-pilot';
import { createLiveRuntime, type LiveRuntimeOptions } from '../apps/desktop/src/main/engine-live/runtime';
import * as gatewayModule from '../apps/desktop/src/main/engine-live/provider-gateway';
import * as engineModule from '../apps/desktop/src/main/engine-pilot/opencode-engine';
import { liveQuestionResult } from '../apps/desktop/src/main/engine-live/protocol';
import { liveNativeUserText } from '../apps/desktop/src/main/engine-pilot/opencode-client';
import { createPilotHost } from '../apps/desktop/src/main/engine-pilot/host';
import type { EngineNotice, PilotEngine } from '../apps/desktop/src/main/engine-pilot/engine';
import type { OpenCodeSupervisor, OpenCodeSupervisorExit } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import { pilotPrompt } from '../apps/desktop/src/main/engine-pilot/prompt';

const model: PilotModel={provider:'deepseek',model:'deepseek-v4-flash'};
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'live-test',windowId:'live-test',webContentsId:1,workspaceId:'live-test',rootId:'live-test'};
const runId=()=>`pilot.${randomUUID()}`;
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
function memory(initial:PilotDisk={version:1,runs:[]}){let disk=parsePilotDisk(initial),writes=0;return {load:()=>disk,save(value:PilotDisk){disk=parsePilotDisk(value);writes++;},close(){},state:()=>({disk,writes})};}
const request=()=>({contractVersion:PILOT_VERSION,clientRequestId:randomUUID(),goal:'请先确认我说的单位，再计算整数之和。',constraint:'保留负数。',model});

/** Replaces the gateway listener and native engine factory, so runtime orchestration performs no socket/process I/O. */
function runtimeFixture(t:TestContext,options:{nativeGate?:Promise<void>;disposeThrows?:boolean}={}){
  const config={model:'deepseek-v4-flash',key:'sk-synthetic_original_1234',configured:true};
  const stats={gateway:0,native:0,fetch:0,keyReads:0,engineDispose:0,engineShutdown:0,serviceClose:0,nativeStop:0};
  const starts:Array<Parameters<PilotEngine['start']>[0]>=[],nativeInputs:unknown[]=[],ends:string[]=[];
  const entered=deferred<void>(),exit=deferred<OpenCodeSupervisorExit>(),executions=new Map<string,ReturnType<typeof deferred<void>>>();
  let providerOptions:gatewayModule.LiveProviderOptions|undefined;
  const settings:LiveRuntimeOptions['settings']={
    key(){stats.keyReads++;return config.configured?config.key:undefined;},defaultModel:()=>config.model,
    read:()=>({ok:true,value:{storage:'ready',encryptionAvailable:true,providers:[{provider:'deepseek',address:'https://api.deepseek.com',model:config.model,configured:config.configured,source:'file',maxOutputTokens:8192,timeoutMs:600000},{provider:'kimi',address:'https://api.moonshot.cn',model:'kimi-k3',configured:false,source:'none',maxOutputTokens:8192,timeoutMs:600000}]}}),
  };
  const services={port:43123,providerToken:'a'.repeat(64),toolToken:'b'.repeat(64),end(id:string){ends.push(id);},async close(){stats.serviceClose++;}};
  t.mock.method(gatewayModule,'createLiveProviderServices',async(value:gatewayModule.LiveProviderOptions)=>{stats.gateway++;providerOptions=value;return services as unknown as gatewayModule.LiveProviderServices;});
  const projected: PilotEngine={kind:'opencode',version:'1.18.17',health:async()=>true,
    async start(input){const execution=deferred<void>();executions.set(input.runId,execution);starts.push(input);input.callbacks.notice({type:'started',sessionId:'session_live'});entered.resolve();await execution.promise;},
    answer:async()=>{},stop:async id=>{executions.get(id)?.resolve();},dispose(){stats.engineDispose++;for(const execution of executions.values())execution.resolve();if(options.disposeThrows)throw Error('synthetic private dispose detail');},
    async shutdown(){stats.engineShutdown++;for(const execution of executions.values())execution.resolve();},
  };
  t.mock.method(engineModule,'createOpenCodePilotEngine',()=>projected);
  const supervisor:OpenCodeSupervisor={port:43124,password:'c'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/synthetic/cwd',pid:45678,
    health:async()=>true,diagnostics:()=>({stdoutBytes:0,stderrBytes:0,outputLimitExceeded:false,markers:[]}),exited:exit.promise,
    async stop(){stats.nativeStop++;return {exited:true,code:0,signal:null};},
  };
  const runtime=createLiveRuntime({settings,fetchImpl:async()=>{stats.fetch++;throw Error('No real provider transport in runtime fixture');},startNative:async input=>{stats.native++;nativeInputs.push(input);if(options.nativeGate)await options.nativeGate;return supervisor;}});
  const input=(id:string,controller=new AbortController())=>({runId:id,prompt:pilotPrompt('使用自然语言提问。',''),model,signal:controller.signal,callbacks:{notice:(_event:EngineNotice)=>{},tool:async()=>{throw Error('No calculator in runtime fixture');}}});
  return {runtime,settings,config,stats,starts,nativeInputs,ends,entered:entered.promise,input,unexpectedExit:()=>exit.resolve({exited:true,code:23,signal:null}),provider:()=>{assert.ok(providerOptions);return providerOptions;}};
}

test('live runtime status and history stay readable without credentials, native startup, gateway or provider I/O',async t=>{
  const f=runtimeFixture(t),store=memory(),host=createPilotHost({owner,engine:f.runtime,store});
  try{
    await host.initialization;
    const status=parsePilotResult('getStatus',await host.invoke('getStatus',owner,{contractVersion:PILOT_VERSION}));assert.ok(status.ok);
    if(status.ok){assert.equal(status.value.canStart,true);assert.equal(status.value.ready,false);assert.equal(status.value.processState,'idle');}
    assert.deepEqual(await host.invoke('listRuns',owner,{contractVersion:PILOT_VERSION}),{ok:true,value:{runs:[]}});
    f.config.configured=false;
    const unavailable=parsePilotResult('getStatus',await host.invoke('getStatus',owner,{contractVersion:PILOT_VERSION}));assert.ok(unavailable.ok);
    if(unavailable.ok)assert.equal(unavailable.value.availability,'not_configured');
    assert.deepEqual(await host.invoke('startRun',owner,request()),{ok:false,error:{code:'NOT_READY'}});
    assert.deepEqual({gateway:f.stats.gateway,native:f.stats.native,fetch:f.stats.fetch,keyReads:f.stats.keyReads},{gateway:0,native:0,fetch:0,keyReads:0});
    assert.equal(store.state().writes,0);
  }finally{host.revoke();await f.runtime.shutdown?.();}
});

test('live acceptance freezes model key and budgets before settings changes and persists actual response identity without replay',async t=>{
  const f=runtimeFixture(t),store=memory(),host=createPilotHost({owner,engine:f.runtime,store});
  try{
    await host.initialization;const start=request(),accepting=host.invoke('startRun',owner,start);
    f.config.key='sk-synthetic_changed_5678';f.config.model='deepseek-v4-flash-vision-exp';
    const result=parsePilotResult('startRun',await accepting);assert.ok(result.ok);if(!result.ok)throw Error();const id=result.value.runId;
    await f.entered;
    assert.deepEqual(f.provider().getRunCredentials(id),{apiKey:'sk-synthetic_original_1234',maxRequests:8,maxOutputTokens:16384,requestTimeoutMs:600000});
    assert.equal(f.stats.keyReads,1);assert.equal(f.stats.native,1);assert.equal(f.starts.length,1);assert.deepEqual(f.starts[0]!.model,model);
    assert.deepEqual(store.state().disk.runs[0]!.model,model);const accepted=store.state().disk.runs[0]!.events[0]!;assert.ok(accepted.type==='run.accepted');if(accepted.type==='run.accepted')assert.deepEqual(accepted.data.model,model);
    assert.deepEqual(await host.invoke('startRun',owner,start),{ok:true,value:{runId:id}});assert.equal(f.starts.length,1);
    assert.deepEqual(await host.invoke('startRun',owner,{...start,model:undefined}),{ok:false,error:{code:'INVALID_REQUEST'}});
    f.provider().onResponse(id,{request:8,responseModel:'deepseek-v4.1-flash',usage:null});
    f.starts[0]!.callbacks.notice({type:'text',text:'结果已确认。'});f.starts[0]!.callbacks.notice({type:'completed'});await setImmediate();
    const saved=store.state().disk.runs[0]!;assert.equal(saved.status,'completed');
    assert.deepEqual(saved.events.find(e=>e.type==='model.response')?.data,{request:8,responseModel:'deepseek-v4.1-flash',usage:null});
    assert.throws(()=>f.provider().getRunCredentials(id));
    const listing=parsePilotResult('listRuns',await host.invoke('listRuns',owner,{contractVersion:PILOT_VERSION}));assert.ok(listing.ok);if(listing.ok)assert.deepEqual(listing.value.runs[0]!.model,model);
    f.config.model='deepseek-v4-flash';
    const next=parsePilotResult('startRun',await host.invoke('startRun',owner,request()));assert.ok(next.ok);if(!next.ok)throw Error();await setImmediate();
    assert.equal(f.provider().getRunCredentials(next.value.runId).apiKey,'sk-synthetic_changed_5678');assert.equal(f.stats.native,1);assert.equal(f.starts.length,2);
    await host.invoke('stopRun',owner,{contractVersion:PILOT_VERSION,runId:next.value.runId});await setImmediate();
    assert.ok(!JSON.stringify({disk:store.state().disk,native:f.nativeInputs}).includes('sk-synthetic'));
    assert.equal(f.stats.fetch,0);
  }finally{host.revoke();await f.runtime.shutdown?.();}
});

test('live runtime rejects missing model and forgets acceptance stopped before deferred startup',async t=>{
  const f=runtimeFixture(t),id=runId();
  try{
    assert.throws(()=>f.runtime.accept!(id,undefined));f.runtime.accept!(id,model);
    const started=f.runtime.start(f.input(id));const stopping=f.runtime.stop(id);assert.equal(stopping,f.runtime.stop(id));
    await stopping;await started;
    assert.equal(f.stats.gateway,0);assert.equal(f.stats.native,0);assert.equal(f.stats.fetch,0);
    assert.throws(()=>f.runtime.start(f.input(id)));
  }finally{await f.runtime.shutdown?.();}
});

test('live runtime cancelled startup never starts a task and shares shutdown through native settlement',async t=>{
  const gate=deferred<void>(),f=runtimeFixture(t,{nativeGate:gate.promise}),id=runId(),controller=new AbortController();
  f.runtime.accept!(id,model);const started=f.runtime.start(f.input(id,controller));await setImmediate();assert.equal(f.stats.native,1);
  controller.abort();const first=f.runtime.shutdown!(),second=f.runtime.shutdown!();assert.equal(first,second);
  assert.equal(f.runtime.liveStatus!().canStart,false);gate.resolve();await first;await started;
  assert.equal(f.starts.length,0);assert.equal(f.stats.fetch,0);assert.ok(f.stats.serviceClose>=1);assert.ok(f.stats.nativeStop>=1);
  assert.throws(()=>f.provider().getRunCredentials(id));await assert.rejects(f.runtime.answer(id,'question_late','晚到的回答'));
});

test('live runtime dispose failure still revokes credentials closes services stops native and reports one shared shutdown failure',async t=>{
  const f=runtimeFixture(t,{disposeThrows:true}),id=runId();f.runtime.accept!(id,model);const started=f.runtime.start(f.input(id));await f.entered;
  assert.equal(f.provider().getRunCredentials(id).apiKey,'sk-synthetic_original_1234');
  const first=f.runtime.shutdown!(),second=f.runtime.shutdown!();assert.equal(first,second);
  assert.throws(()=>f.provider().getRunCredentials(id));assert.equal(f.runtime.liveStatus!().availability,'unavailable');
  await assert.rejects(first,error=>error instanceof Error&&error.message==='OpenCode pilot unavailable');await started;
  assert.equal(f.stats.engineDispose,1);assert.equal(f.stats.engineShutdown,1);assert.equal(f.stats.serviceClose,1);assert.equal(f.stats.nativeStop,1);
  assert.equal(f.runtime.shutdown!(),first);assert.equal(f.stats.fetch,0);
});

test('live history restart preserves requested model and adds only interruption without reaccepting or replaying',async t=>{
  const id=runId(),time='2026-09-11T00:00:00.000Z',goal='历史中的自然语言任务';
  const store=memory(parsePilotDisk({version:1,runs:[{runId:id,clientRequestId:randomUUID(),goal,constraint:'',status:'running',createdAt:time,updatedAt:time,engineKind:'opencode',engineVersion:'1.18.17',model,events:[{runId:id,sequence:1,time,type:'run.accepted',data:{goal,constraint:'',engineKind:'opencode',engineVersion:'1.18.17',rulesRevision:PILOT_RULES_REVISION,model}}]}]}));
  const f=runtimeFixture(t);f.config.configured=false;const host=createPilotHost({owner,engine:f.runtime,store});
  try{
    await host.initialization;const read=parsePilotResult('readRun',await host.invoke('readRun',owner,{contractVersion:PILOT_VERSION,runId:id,afterSequence:0}));assert.ok(read.ok);
    if(read.ok){assert.equal(read.value.terminal,true);assert.deepEqual(read.value.events.at(-1)?.data,{reason:'restart'});}
    assert.deepEqual(store.state().disk.runs[0]!.model,model);assert.equal(store.state().disk.runs[0]!.status,'interrupted');assert.equal(store.state().writes,1);
    assert.deepEqual([f.stats.gateway,f.stats.native,f.stats.fetch,f.stats.keyReads],[0,0,0,0]);
  }finally{host.revoke();await f.runtime.shutdown?.();}
});

/** Real projection code over in-memory native snapshots; knownCalls stands for the gateway's completed-response registry. */
function questionFixture(){
  const goal='请依次确认单位和负数处理方式。',prompts=['第一个数使用什么单位？','负数应当保留，还是取绝对值？'],answers=new Map<string,string>();
  const events:EngineNotice[]=[],nativeAnswers:Array<{id:string;answer:string}>=[],rejects:string[]=[],registered:unknown[]=[],knownCalls=new Set(['call_free_91','call_free_203']);
  const controller=new AbortController(),waiters:Array<{type:EngineNotice['type'];count:number;resolve:(event:EngineNotice)=>void}>=[];
  let phase=0,pending=true,tamper:'none'|'message'|'unknown-call'='none',aborts=0;
  const qid=(index:number)=>`question_${index}`,mid=(index:number)=>`assistant_${index}`,callid=(index:number)=>tamper==='unknown-call'&&index===phase?'call_not_issued':index===0?'call_free_91':'call_free_203';
  const args=(index:number)=>({questions:[{question:prompts[index]!,header:`澄清 ${index+1}`,options:[],multiple:false,custom:true}]});
  const part=(index:number)=>({id:`part_question_${index}`,sessionID:'session_live',messageID:mid(index),type:'tool',tool:'question',callID:callid(index),state:answers.has(qid(index))?{status:'completed',input:args(index),output:liveQuestionResult(prompts[index]!,answers.get(qid(index))!),metadata:{answers:[[answers.get(qid(index))!]]}}:{status:'running',input:args(index)}});
  const info=(index:number)=>({id:mid(index),sessionID:'session_live',role:'assistant',parentID:'user_live',agent:'pilot',providerID:'workbench',modelID:'deepseek-v4-flash',time:{created:index+2}});
  const rows=()=>[
    {info:{id:'user_live',sessionID:'session_live',role:'user',time:{created:1}},parts:[{id:'part_user',sessionID:'session_live',messageID:'user_live',type:'text',text:liveNativeUserText(goal,'')}]},
    ...Array.from({length:Math.min(phase+1,2)},(_,index)=>({info:info(index),parts:[{id:`part_step_${index}`,sessionID:'session_live',messageID:mid(index),type:'step-start'},part(index)]})),
    ...(phase===2?[{info:{...info(2),finish:'stop',time:{created:5,completed:6}},parts:[{id:'part_final',sessionID:'session_live',messageID:mid(2),type:'text',text:'两项要求已分别确认。'}]}]:[]),
  ];
  const client={health:async()=>true,createSession:async()=>'session_live',prompt:async()=>{},messages:async()=>structuredClone(rows()),
    questions:async()=>pending&&phase<2?[{id:qid(phase),sessionID:'session_live',questions:args(phase).questions,tool:{messageID:tamper==='message'?'unverified_message':mid(phase),callID:callid(phase)}}]:[],
    async answer(_session:string,id:string,answer:string){nativeAnswers.push({id,answer});answers.set(id,answer);phase++;pending=phase<2;},
    async abort(){aborts++;},async reject(_session:string,id:string){rejects.push(id);pending=false;},dispose(){},
  };
  const services:engineModule.OpenCodeEngineServices={begin:()=>({bindSession(id){assert.equal(id,'session_live');},
    question(binding){assert.ok(knownCalls.has(binding.callID),'question must originate in a complete verified provider response');registered.push(structuredClone(binding));},
    answer(answer,id){assert.ok(id);assert.ok(!answers.has(id));assert.equal(typeof answer,'string');},evidence:()=>({complete:phase===2})}),end(){},close:async()=>{}};
  const engine=engineModule.createOpenCodePilotEngine({client,services,profile:'live-deepseek'}),id=runId();
  function notice(event:EngineNotice){events.push(event);for(const waiter of [...waiters])if(waiter.type===event.type&&events.filter(e=>e.type===event.type).length>=waiter.count){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(event);}}
  const wait=(type:EngineNotice['type'],count=1)=>{const found=events.filter(e=>e.type===type)[count-1];return found?Promise.resolve(found):new Promise<EngineNotice>(resolve=>waiters.push({type,count,resolve}));};
  const start=()=>{const done=engine.start({runId:id,prompt:pilotPrompt(goal,''),model,signal:controller.signal,callbacks:{notice,tool:async()=>{throw Error('No calculator expected');}}});void done.catch(()=>{});return done;};
  return {engine,id,controller,events,nativeAnswers,rejects,registered,wait,start,tamper(value:typeof tamper){tamper=value;},aborts:()=>aborts};
}

test('live native projection permits two sequential free-text questions with distinct call IDs and exact per-question answers',{timeout:4000},async()=>{
  const f=questionFixture(),done=f.start();
  try{
    const first=await f.wait('question');assert.ok(first.type==='question');if(first.type!=='question')throw Error();
    await assert.rejects(f.engine.answer(f.id,'question_unknown','不可发送'));assert.equal(f.nativeAnswers.length,0);
    const answer1='单位是毫安，不要转换。';await f.engine.answer(f.id,first.questionId,answer1);
    await assert.rejects(f.engine.answer(f.id,first.questionId,'重复回答'));
    const second=await f.wait('question',2);assert.ok(second.type==='question');if(second.type!=='question')throw Error();
    const answer2='请保留负数。\n第二个条件与单位无关。';await f.engine.answer(f.id,second.questionId,answer2);await done;
    assert.deepEqual(f.nativeAnswers,[{id:'question_0',answer:answer1},{id:'question_1',answer:answer2}]);
    assert.equal(f.registered.length,2);assert.equal(f.events.at(-1)?.type,'completed');assert.ok(!f.events.some(e=>e.type==='failed'));assert.deepEqual(f.rejects,[]);
    await assert.rejects(f.engine.answer(f.id,second.questionId,'迟到回答'));assert.equal(f.nativeAnswers.length,2);
  }finally{f.controller.abort();await f.engine.shutdown?.();}
});

test('live native changed question tuple cannot acquire cleanup authority or forward a late answer',{timeout:4000},async()=>{
  const f=questionFixture(),done=f.start();await f.wait('question');f.tamper('message');f.controller.abort();
  await assert.rejects(f.engine.stop(f.id));await assert.rejects(done);assert.deepEqual(f.rejects,[]);assert.equal(f.aborts(),1);
  await assert.rejects(f.engine.answer(f.id,'question_0','此答案不得发送'));assert.deepEqual(f.nativeAnswers,[]);assert.equal(await f.engine.health(),false);
  await assert.rejects(f.engine.shutdown!());
});

test('live native unknown provider call remains unanswerable even when native question and tool part agree',{timeout:4000},async()=>{
  const f=questionFixture();f.tamper('unknown-call');const done=f.start();await f.wait('failed');await assert.rejects(done);
  assert.equal(f.events.filter(e=>e.type==='question').length,0);assert.equal(f.registered.length,0);assert.deepEqual(f.rejects,[]);
  await assert.rejects(f.engine.answer(f.id,'question_0','不可获得回答权限'));assert.deepEqual(f.nativeAnswers,[]);await assert.rejects(f.engine.shutdown!());
});

test('live final completion waits for native cleanup and preserves failed stopped or window terminals',{timeout:4000},async()=>{
  for(const mode of ['abort-fails','success','stop','close'] as const){
    const cleanupEntered=deferred<void>(),cleanupGate=deferred<void>(),store=memory(),goal='请用一句话说明本任务已完成。';
    let aborts=0,execution:Promise<void>|undefined;
    const client={health:async()=>true,createSession:async()=>'session_final',prompt:async()=>{},
      messages:async()=>[
        {info:{id:'user_final',sessionID:'session_final',role:'user',time:{created:1}},parts:[{id:'part_user_final',sessionID:'session_final',messageID:'user_final',type:'text',text:liveNativeUserText(goal,'')}]},
        {info:{id:'assistant_final',sessionID:'session_final',role:'assistant',parentID:'user_final',agent:'pilot',providerID:'workbench',modelID:'deepseek-v4-flash',finish:'stop',time:{created:2,completed:3}},parts:[{id:'part_step_final',sessionID:'session_final',messageID:'assistant_final',type:'step-start'},{id:'part_text_final',sessionID:'session_final',messageID:'assistant_final',type:'text',text:'本任务已经完成。'}]},
      ],
      questions:async()=>[],answer:async()=>{},reject:async()=>{throw Error('No question exists in completion fixture');},
      async abort(){aborts++;cleanupEntered.resolve();await cleanupGate.promise;if(mode==='abort-fails')throw Error('Synthetic abort failed');},dispose(){},
    };
    const services:engineModule.OpenCodeEngineServices={begin:()=>({bindSession(){},answer(){},evidence:()=>({complete:true})}),end(){},close:async()=>{}};
    const native=engineModule.createOpenCodePilotEngine({client,services,profile:'live-deepseek'});
    // The static identity injection models main acceptance; projection, persistence and terminal handling are the real implementations.
    const engine:PilotEngine={...native,liveStatus:()=>({model,canStart:true,processState:'ready',availability:'available'}),accept:(_id,requested)=>{assert.deepEqual(requested,model);return model;},start(input){execution=native.start(input);void execution.catch(()=>{});return execution;}};
    const host=createPilotHost({owner,engine,store});
    try{
      await host.initialization;const accepted=parsePilotResult('startRun',await host.invoke('startRun',owner,{...request(),goal,constraint:''}));assert.ok(accepted.ok);if(!accepted.ok)throw Error();const id=accepted.value.runId;
      await cleanupEntered.promise;
      const pending=store.state().disk.runs[0]!;assert.equal(pending.status,'running',mode);assert.equal(pending.events.some(e=>e.type==='run.completed'),false,mode);assert.equal(pending.events.filter(e=>e.type==='message.delta').map(e=>e.data.text).join(''),'本任务已经完成。');
      let terminalBeforeRelease:string|undefined;
      if(mode==='stop'){
        assert.deepEqual(await host.invoke('stopRun',owner,{contractVersion:PILOT_VERSION,runId:id}),{ok:true,value:{status:'stopped'}});
        assert.equal(store.state().disk.runs[0]!.status,'stopped');terminalBeforeRelease=JSON.stringify(store.state().disk);
      }else if(mode==='close'){
        host.revoke();assert.equal(store.state().disk.runs[0]!.status,'interrupted');assert.deepEqual(store.state().disk.runs[0]!.events.at(-1)?.data,{reason:'window'});terminalBeforeRelease=JSON.stringify(store.state().disk);
      }
      const firstCleanup=native.stop(id),secondCleanup=native.stop(id);assert.equal(firstCleanup,secondCleanup);void firstCleanup.catch(()=>{});
      cleanupGate.resolve();assert.ok(execution);
      if(mode==='abort-fails'){
        await assert.rejects(execution);await assert.rejects(firstCleanup);await setImmediate();
        const failed=store.state().disk.runs[0]!;assert.equal(failed.status,'failed');assert.equal(failed.events.some(e=>e.type==='run.completed'),false);assert.deepEqual(failed.events.at(-1)?.data,{code:'ENGINE_FAILED',stage:'engine'});assert.equal(await native.health(),false);
        const durable=JSON.stringify(store.state().disk);host.revoke();await setImmediate();assert.equal(JSON.stringify(store.state().disk),durable);
      }else{
        await execution;await firstCleanup;await setImmediate();
        if(mode==='success'){assert.equal(store.state().disk.runs[0]!.status,'completed');assert.equal(store.state().disk.runs[0]!.events.filter(e=>e.type==='run.completed').length,1);}
        else {assert.equal(JSON.stringify(store.state().disk),terminalBeforeRelease);assert.equal(store.state().disk.runs[0]!.events.some(e=>e.type==='run.completed'),false);}
      }
      assert.equal(aborts,1,mode);
    }finally{cleanupGate.resolve();host.revoke();if(mode==='abort-fails')await assert.rejects(native.shutdown!());else await native.shutdown?.();}
  }
});

test('live unexpected supervisor exit isolates dispose failure revokes snapshots and produces no unhandled rejection',async t=>{
  const f=runtimeFixture(t,{disposeThrows:true}),id=runId(),events:EngineNotice[]=[],unhandled:unknown[]=[];
  const observe=(reason:unknown)=>{unhandled.push(reason);};process.on('unhandledRejection',observe);t.after(()=>process.off('unhandledRejection',observe));
  f.runtime.accept!(id,model);const input=f.input(id),started=f.runtime.start({...input,callbacks:{...input.callbacks,notice:event=>events.push(event)}});await f.entered;
  assert.equal(f.provider().getRunCredentials(id).apiKey,'sk-synthetic_original_1234');f.unexpectedExit();
  await started;await setImmediate();await setImmediate();
  assert.deepEqual(unhandled,[]);assert.deepEqual(events.map(e=>e.type),['started','failed']);
  assert.deepEqual(f.runtime.liveStatus!(),{canStart:false,processState:'failed',availability:'unavailable'});
  assert.throws(()=>f.provider().getRunCredentials(id));assert.equal(f.stats.engineDispose,1);assert.equal(f.stats.serviceClose,1);assert.ok(f.ends.includes(id));
  await assert.rejects(f.runtime.answer(id,'question_late','退出后不得发送'));assert.throws(()=>f.runtime.accept!(runId(),model));
  const first=f.runtime.shutdown!(),second=f.runtime.shutdown!();assert.equal(first,second);
  await assert.rejects(first,error=>error instanceof Error&&error.message==='OpenCode pilot unavailable');await setImmediate();
  assert.deepEqual(unhandled,[]);assert.equal(f.stats.engineDispose,1);assert.equal(f.stats.engineShutdown,1);assert.equal(f.stats.nativeStop,1);assert.equal(f.stats.fetch,0);
});

test('live native finalization closes services after client dispose throws and shares an observed cleanup failure',async t=>{
  const unhandled:unknown[]=[],observe=(reason:unknown)=>{unhandled.push(reason);};
  process.on('unhandledRejection',observe);t.after(()=>process.off('unhandledRejection',observe));
  for(const entry of ['dispose','shutdown'] as const){
    const closeEntered=deferred<void>(),closeGate=deferred<void>();let clientDisposes=0,serviceCloses=0,nativeOperations=0;
    const forbidden=async():Promise<never>=>{nativeOperations++;throw Error('Native I/O is forbidden in finalization fixture');};
    const client={health:forbidden,createSession:forbidden,prompt:forbidden,messages:forbidden,questions:forbidden,answer:forbidden,reject:forbidden,abort:forbidden,
      dispose(){clientDisposes++;throw Error('Synthetic private client dispose failure');},
    };
    const services:engineModule.OpenCodeEngineServices={begin(){throw Error('No run is started by finalization');},end(){throw Error('No run is active');},async close(){serviceCloses++;closeEntered.resolve();await closeGate.promise;}};
    const engine=engineModule.createOpenCodePilotEngine({client,services,profile:'live-deepseek'});
    let first:Promise<void>|undefined,settled=false;
    if(entry==='dispose')engine.dispose();else{first=engine.shutdown!();void first.then(()=>{settled=true;},()=>{settled=true;});}
    await closeEntered.promise;
    assert.equal(clientDisposes,1,entry);assert.equal(serviceCloses,1,entry);assert.equal(settled,false,entry);
    engine.dispose();closeGate.resolve();
    // A void dispose must observe its own failure even before a shutdown caller asks for the result.
    await setImmediate();await setImmediate();assert.deepEqual(unhandled,[],entry);
    first??=engine.shutdown!();const repeated=engine.shutdown!();assert.equal(first,repeated,entry);
    await assert.rejects(first,error=>error instanceof engineModule.PilotNativeCleanupError&&error.code==='NATIVE_CLEANUP_FAILED'&&error.message==='OpenCode pilot unavailable');
    assert.equal(engine.shutdown!(),first,entry);assert.equal(await engine.health(),false,entry);
    await setImmediate();assert.deepEqual(unhandled,[],entry);assert.equal(clientDisposes,1,entry);assert.equal(serviceCloses,1,entry);assert.equal(nativeOperations,0,entry);
  }
});
