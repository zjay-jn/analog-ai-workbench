import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {createOpenCodePilotClient} from '../apps/desktop/src/main/engine-pilot/opencode-client';
import {createProjectReadNativeEngine} from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import {createNativeConversationStore} from '../apps/desktop/src/main/agent-project-read/native-conversation-store';
import type {ProjectReadEngineNotice} from '../apps/desktop/src/main/agent-project-read/engine';
import type {ProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';

const sessionID='ses_observer_synthetic',messageID='msg_observer_assistant',partID='prt_observer_text';
const model={provider:'kimi',model:'kimi-k3'} as const;
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const until=async(predicate:()=>boolean)=>{for(let i=0;i<100;i++){if(predicate())return;await setImmediate();}assert(predicate(),'Expected bounded local fixture progress');};
const text=(events:ProjectReadEngineNotice[])=>events.filter(event=>event.type==='text').map(event=>event.text).join('');

/** Real native HTTP/SSE parsers, an in-memory native server, and a mock clock.
 * No socket, provider, command, WSL process or user state is used. */
function fixture(){
  const conversationId=randomUUID(),controller=new AbortController(),events:ProjectReadEngineNotice[]=[];
  let writer!:ReadableStreamDefaultController<Uint8Array>,submitted=false,finished=false,current='A';
  let prompts=0,aborts=0,tools=0,reads=0,stalled=0,statusReads=0,malformed=false,stallNext=false,busy=true;
  let invalidFinish=false,invalidTool=false,invalidStatus=false;
  let onStatus:undefined|(()=>void);
  const event=(type:string,properties?:unknown)=>writer.enqueue(Buffer.from('data: '+JSON.stringify({type,...(properties?{properties}:{})})+'\n\n'));
  const rows=()=>submitted?[
    {info:{id:'msg_observer_user',sessionID,role:'user',time:{created:1}},parts:[{id:'prt_observer_user',sessionID,messageID:'msg_observer_user',type:'text',text:'synthetic observer test'}]},
    {info:{id:messageID,sessionID,role:'assistant',parentID:'msg_observer_user',agent:'pilot',providerID:'workbench',modelID:model.model,time:{created:2,...(finished?{completed:invalidFinish?'invalid':3}:{})},...(finished?{finish:'stop'}:{})},
      parts:[{id:partID,sessionID,messageID,type:'text',text:current,time:{start:2,...(finished?{end:3}:{})}},...(invalidTool?[{id:'prt_unproven_tool',sessionID,messageID,type:'tool',tool:'pilot_sum',callID:'call_unproven',state:{status:'completed',input:{values:[1,2]},output:'{}'}}]:[])]},
  ]:[];
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/conversations/cwd',profile:'work-cycle',conversation:true,fetchImpl:async(url,init)=>{
    const route=new URL(url).pathname;
    if(route==='/session'&&init.method==='POST')return json({id:sessionID});
    if(route==='/event')return new Response(new ReadableStream<Uint8Array>({start(value){writer=value;event('server.connected');}}),{headers:{'content-type':'text/event-stream'}});
    if(route.endsWith('/prompt_async')){
      prompts++;submitted=true;event('message.updated',{sessionID,info:rows()[1]!.info});
      event('message.part.updated',{sessionID,part:rows()[1]!.parts[0]});return new Response(null,{status:204});
    }
    if(route.endsWith('/message')){
      reads++;
      if(stallNext){stallNext=false;stalled++;return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('Synthetic delayed GET aborted')),{once:true}));}
      if(malformed){malformed=false;return json({unexpected:true});}
      return json(rows());
    }
    if(route==='/session/status'){statusReads++;onStatus?.();return json({[sessionID]:{type:invalidStatus?'invalid':busy?'busy':'idle'}});}
    if(route==='/question')return json([]);
    if(route.endsWith('/abort')){aborts++;return json(true);}
    throw new Error('Unexpected synthetic route');
  }});
  const services:Parameters<typeof createProjectReadNativeEngine>[0]['services']={begin:()=>({bindSession(){},bindNativeContext(){},compactions:()=>[],evidence:()=>({complete:finished})} as unknown as ReturnType<ProjectReadProviderServices['begin']>),end(){},close:async()=>{}};
  const engine=createProjectReadNativeEngine({client,services,conversationStore:createNativeConversationStore('C:/work/analog_ai_workbench/.local/command-repair-20261028/native-observer-unit/'+conversationId)});
  const start=()=>engine.start({runId:'observer_synthetic',model,signal:controller.signal,nativeConversation:{conversationId},
    chatContext:{provider:model.provider,model:model.model,maxOutputTokens:8192,timeoutMs:600000,messages:[{role:'user',content:'synthetic observer test'}]},
    prompt:{goal:'synthetic',constraint:'',rules:'synthetic only',systemText:'synthetic only',initialUserText:'synthetic observer test'},
    callbacks:{notice:value=>events.push(value),tool:async()=>{tools++;throw new Error('Unexpected synthetic tool');},questionDelivered:async()=>{}},
  });
  return {engine,events,controller,start,counts:()=>({prompts,aborts,tools,reads,stalled,statusReads}),
    stall:()=>{stallNext=true;},malform:()=>{malformed=true;},setBusy:(value:boolean)=>{busy=value;},onStatus:(fn:()=>void)=>{onStatus=fn;},
    corrupt:(kind:'finish'|'tool'|'status')=>{if(kind==='finish')invalidFinish=true;else if(kind==='tool')invalidTool=true;else invalidStatus=true;},
    emit:(suffix:string)=>{current+=suffix;event('message.part.delta',{sessionID,messageID,partID,field:'text',delta:suffix});},
    duplicate:()=>event('message.part.updated',{sessionID,part:rows()[1]!.parts[0]}),
    finish:()=>{finished=true;busy=false;},eof:()=>writer.close(),
    nativeError:()=>event('session.error',{sessionID,error:{name:'UnknownError'}}),
  };
}

test('a slow observer GET does not abort a busy native run with fresh validated SSE text',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();
  for(let i=0;i<2;i++){
    f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===i+1);
    f.emit(i===0?'B':'C');await until(()=>text(f.events)===(i===0?'AB':'ABC'));
    t.mock.timers.tick(10000);await until(()=>f.counts().statusReads===i+1||f.events.some(event=>event.type==='failed'));await setImmediate();
    assert(!f.events.some(event=>event.type==='failed'||event.type==='completed'),'A busy native run with fresh SSE text must survive an observer GET timeout');assert.equal(f.counts().aborts,0);
  }
  f.finish();t.mock.timers.tick(250);await running;
  assert.equal(f.events.at(-1)?.type,'completed');assert.equal(text(f.events),'ABC');
  assert.equal(f.counts().prompts,1);assert.equal(f.counts().tools,0);assert.equal(f.counts().aborts,1);
  await f.engine.shutdown();
});

for(const condition of ['no-progress','duplicate-progress','idle'] as const)test('observer timeout remains fatal when '+condition,{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  if(condition==='duplicate-progress')f.duplicate();
  if(condition==='idle'){f.emit('B');f.setBusy(false);}
  await setImmediate();t.mock.timers.tick(10000);await running;
  assert.equal(f.events.at(-1)?.type,'failed');assert(!f.events.some(event=>event.type==='completed'));
  assert.deepEqual(f.events.find(event=>event.type==='failed')?.nativeFailure,{origin:'native_client',stage:'message_read',reason:'timeout'});
  assert.equal(f.counts().statusReads,condition==='idle'?1:0);assert.equal(f.counts().prompts,1);assert.equal(f.counts().aborts,1);
  await f.engine.shutdown();
});

test('malformed native message response is not excused by concurrent valid text',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.malform();f.emit('B');t.mock.timers.tick(250);await running;
  assert.deepEqual(f.events.find(event=>event.type==='failed')?.nativeFailure,{origin:'native_client',stage:'message_read',reason:'response_format'});
  assert.equal(f.counts().statusReads,0);assert.equal(f.counts().prompts,1);await f.engine.shutdown();
});

test('a final idle snapshot timeout is re-read once and fully validated',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.onStatus(()=>{if(f.counts().statusReads===1)f.stall();});f.finish();t.mock.timers.tick(250);
  await until(()=>f.counts().stalled===1);t.mock.timers.tick(10000);await running;
  assert.equal(f.events.at(-1)?.type,'completed');assert.equal(text(f.events),'A');
  assert.equal(f.counts().statusReads,2);assert.equal(f.counts().prompts,1);assert.equal(f.counts().tools,0);
  await f.engine.shutdown();
});

test('observer timeout after the native loop completed does not discard a verified final answer',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  f.emit('B');f.finish();await until(()=>text(f.events)==='AB');t.mock.timers.tick(10000);await running;
  assert.equal(f.events.at(-1)?.type,'completed');assert.equal(text(f.events),'AB');
  assert.equal(f.counts().prompts,1);assert.equal(f.counts().tools,0);assert.equal(f.counts().aborts,1);
  await f.engine.shutdown();
});

test('an idle observation re-read has one attempt and preserves another timeout',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  f.finish();f.onStatus(()=>f.stall());t.mock.timers.tick(10000);
  await until(()=>f.counts().stalled===2||f.events.some(event=>event.type==='failed'));
  assert.equal(f.counts().stalled,2);t.mock.timers.tick(10000);await running;
  assert.deepEqual(f.events.find(event=>event.type==='failed')?.nativeFailure,{origin:'native_client',stage:'message_read',reason:'timeout'});
  assert.equal(f.counts().statusReads,1);assert.equal(f.counts().prompts,1);assert(!f.events.some(event=>event.type==='completed'));
  await f.engine.shutdown();
});

test('an idle observation re-read still rejects a malformed snapshot',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  f.finish();f.onStatus(()=>f.malform());t.mock.timers.tick(10000);await running;
  assert.deepEqual(f.events.find(event=>event.type==='failed')?.nativeFailure,{origin:'native_client',stage:'message_read',reason:'response_format'});
  assert.equal(f.counts().statusReads,1);assert.equal(f.counts().prompts,1);assert(!f.events.some(event=>event.type==='completed'));
  await f.engine.shutdown();
});

for(const condition of ['finish','tool','status'] as const)test('idle observation recovery cannot hide invalid '+condition,{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  f.finish();f.onStatus(()=>f.corrupt(condition));t.mock.timers.tick(10000);await running;
  assert.equal(f.events.at(-1)?.type,'failed');assert(!f.events.some(event=>event.type==='completed'));
  const failure=f.events.find(event=>event.type==='failed')?.nativeFailure;
  assert.equal(failure?.stage,condition==='status'?'status_read':condition==='tool'?'tool_projection':'completion_validate');
  assert.equal(f.counts().prompts,1);assert.equal(f.counts().tools,0);
  await f.engine.shutdown();
});

test('gateway completion alone cannot recover a busy observer without progress',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  f.finish();f.setBusy(true);t.mock.timers.tick(10000);await running;
  assert.deepEqual(f.events.find(event=>event.type==='failed')?.nativeFailure,{origin:'native_client',stage:'message_read',reason:'timeout'});
  assert.equal(f.counts().stalled,1);assert.equal(f.counts().prompts,1);assert(!f.events.some(event=>event.type==='completed'));
  await f.engine.shutdown();
});

for(const condition of ['cancel','event-eof','native-error'] as const)test('busy observation cannot mask '+condition,{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),running=f.start();
  await until(()=>text(f.events)==='A');await setImmediate();f.stall();t.mock.timers.tick(250);await until(()=>f.counts().stalled===1);
  f.emit('B');await until(()=>text(f.events)==='AB');
  if(condition==='cancel')f.controller.abort();else if(condition==='event-eof')f.eof();else f.nativeError();
  await until(()=>f.counts().aborts===1);await setImmediate();t.mock.timers.tick(10000);await running;
  assert(!f.events.some(event=>event.type==='completed'));assert.equal(f.counts().prompts,1);assert.equal(f.counts().statusReads,0);
  const failures=f.events.filter(event=>event.type==='failed');assert.equal(failures.length,condition==='cancel'?0:1);
  if(condition!=='cancel')assert.deepEqual(failures[0]!.nativeFailure,{origin:'native_client',stage:condition==='event-eof'?'event_connect':'event_message',reason:condition==='event-eof'?'stream_closed':'native_session_error'});
  await f.engine.shutdown();
});
