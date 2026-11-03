import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memory,B} from './helpers/filesystem-read-memory';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {createProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import {parseProjectReadDisk,type ProjectReadDisk} from '../apps/desktop/src/main/agent-project-read/store';
import type {ProjectReadEngine,ProjectReadEngineInput,ProjectReadFailureDiagnostic} from '../apps/desktop/src/main/agent-project-read/engine';
import type {ProjectReadModelSnapshots} from '../apps/desktop/src/main/agent-project-read/runtime';
import type {ProjectReadToolCall} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {NativeEngineFailure} from '../apps/desktop/src/shared/agent/native-engine-failure';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk,type SessionMethod} from '../apps/desktop/src/shared/agent/chat-sessions';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';

// Real session/coordinator/project hosts, arbiter, parsers and filesystem broker.
// All file metadata/body and engine events are synthetic; no sockets or credentials.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'linked-diagnostic',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const model={provider:'kimi',model:'kimi-k3'} as const;
const nativeFailure:NativeEngineFailure={origin:'native_client',stage:'event_decode',reason:'stream_closed'};
const gate=()=>{let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(done:()=>boolean){for(let n=0;n<200;n++){if(done())return;await tick();}assert.fail('synthetic linked turn did not settle');}
function fixture(t:TestContext,config:{delayedFailure?:boolean;upstream?:ProjectReadFailureDiagnostic;initial?:{chat:SessionDisk;project:ProjectReadDisk}}={}){
 const files=memory(t,{[B+'\\synthetic.txt']:{text:'Synthetic file content, never read from disk.'}});
 let chatDisk=parseSessionDisk(structuredClone(config.initial?.chat??{version:6,selectedId:null,sessions:[]}));
 let projectDisk:ProjectReadDisk=structuredClone(config.initial?.project??{version:1,runs:[]});
 const cleanup=gate(),failure=gate(),starts:ProjectReadEngineInput[]=[];let stops=0,readCompleted=false,failed=false;
 const forbidden=():never=>assert.fail('unexpected real execution or credentials');
 const engine:ProjectReadEngine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,acceptChat:()=>model,canDeliver:()=>true,
  accounting:()=>({providerAttempts:4,httpDispatches:4,contextBytes:0,...(failed&&config.upstream?{failureReason:config.upstream.reason,failureDiagnostic:config.upstream}:{})}),
  start:async input=>{
   starts.push(input);input.callbacks.notice({type:'started',sessionId:'synthetic-native'});input.callbacks.notice({type:'step',step:1,usage:null});
   let call:ProjectReadToolCall={sessionId:'synthetic-native',messageId:'synthetic-message',callId:randomUUID(),toolName:'fs_read',arguments:{path:B+'\\synthetic.txt',fileId:null,version:null,start:{line:1,column:1},cursor:null}};
   for(let n=0;n<8;n++){
    const result=await input.callbacks.tool(call);assert(result.ok,JSON.stringify(result));
    if(result.value.kind==='read'&&result.value.citation){readCompleted=true;break;}
    assert('nextArguments' in result.value&&result.value.nextArguments,'fixture expected staged source read');
    call={...call,callId:randomUUID(),...result.value.nextArguments} as ProjectReadToolCall;
   }
   assert(readCompleted);input.callbacks.notice({type:'text',messageId:'synthetic-message',step:1,text:'文件已读取，以下是部分回答。'});
   if(config.delayedFailure)await failure.promise;
   failed=true;input.callbacks.notice({type:'failed',nativeFailure});
  },
  answer:async()=>forbidden(),stop:async()=>{stops++;await cleanup.promise;},dispose(){},shutdown:async()=>{},
 };
 const models={status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:forbidden,forget(){},close(){}} as ProjectReadModelSnapshots;
 const arbiter=createAgentRuntimeArbiter();
 const project=createProjectReadHost({store:{load:()=>structuredClone(projectDisk),save:next=>{const parsed=parseProjectReadDisk(next);assert(parsed);projectDisk=parsed;},close(){}},models,arbiter,createEngine:()=>engine,bindings:{snapshotBinding:()=>({ok:false,error:{code:'NOT_BOUND'}})}});
 let host:ReturnType<typeof createSessionHost>;
 const service=createUnifiedChatCoordinator({project,arbiter,workspace:emptyWorkspace,getSession:id=>host.getSession(id),plain:forbidden});
 host=createSessionHost({owner,store:{load:()=>structuredClone(chatDisk),save:next=>{chatDisk=parseSessionDisk(structuredClone(next));}},configured:{kimi:true,deepseek:true},execute:forbidden,executeMultimodal:forbidden,turns:service});
 const invoke=<M extends SessionMethod>(method:M,args:object={})=>host.invoke(owner,method,{contractVersion:SESSION_VERSION,...args});
 const state=()=>{const result=invoke('readState');assert(result.ok);return result.value;};
 if(!chatDisk.selectedId)assert(invoke('createSession',{provider:'kimi',title:'synthetic linked failure'}).ok);
 const sessionId=state().selectedId!;
 return {host,project,files,starts,cleanup,failure,state,invoke,sessionId,readCompleted:()=>readCompleted,stops:()=>stops,
  durable:()=>({chat:structuredClone(chatDisk),project:structuredClone(projectDisk)}),
  send(){const turnId=randomUUID();assert(invoke('sendMessage',{sessionId,requestId:turnId,text:'Read the explicit synthetic file and answer.'}).ok);return turnId;},
  async close(){cleanup.release();failure.release();host.revoke();project.revoke();await project.shutdown();await arbiter.close();},
 };
}

test('linked native failure reaches the tool ledger before session abort; late cancel preserves first cause',async t=>{
 const f=fixture(t);try{
  const turnId=f.send();await until(()=>f.stops()===1);assert(f.host.isRunning());assert(f.readCompleted());
  const during=f.durable(),turn=during.chat.sessions[0]!.turns[0]!,run=during.project.runs[0]!.run;
  assert.equal(run.status,'failed');assert(run.events.some(e=>e.type==='run.failed'&&e.data.code==='ENGINE_FAILED'));
  assert(!run.events.some(e=>e.type==='run.stopped'));assert.equal(run.cleanupState,'pending');
  assert.deepEqual(turn.execution!.failureDiagnostic,{stage:'native_engine',reason:'ENGINE_FAILED',providerAttempts:4,httpDispatches:4,nativeFailure});
  assert.match(turn.error,/接收引擎实时消息时连接中断/);const firstError=turn.error;
  assert(f.invoke('cancelReply',{sessionId:f.sessionId,turnId}).ok);f.cleanup.release();await until(()=>!f.host.isRunning());
  const saved=f.durable(),final=saved.chat.sessions[0]!.turns[0]!;
  assert.equal(final.status,'failed');assert.equal(final.execution!.phase,'failed');assert.equal(final.execution!.cleanupState,'idle');assert.equal(final.error,firstError);
  assert.equal(saved.project.runs[0]!.run.status,'failed');assert.equal(saved.project.runs[0]!.run.cleanupState,'idle');
  assert.equal(final.assistant,'文件已读取，以下是部分回答。');assert.equal(f.starts.length,1);assert.equal(f.stops(),1);
  await f.close();t.mock.restoreAll();
  const cold=fixture(t,{initial:saved});try{await tick();assert.equal(cold.starts.length,0);assert.deepEqual(cold.durable(),saved);assert.equal(cold.files.seen.reads,0);}finally{await cold.close();}
 }finally{await f.close();}
});

test('linked upstream diagnostic wins over a secondary native session error and remains failed',async t=>{
 const upstream:ProjectReadFailureDiagnostic={stage:'upstream_http',reason:'AUTHENTICATION_FAILED',providerAttempts:4,httpDispatches:4,httpStatus:401};
 const f=fixture(t,{upstream});try{
  f.send();await until(()=>f.stops()===1);const during=f.durable();
  assert.equal(during.project.runs[0]!.run.status,'failed');assert.deepEqual(during.chat.sessions[0]!.turns[0]!.execution!.failureDiagnostic,upstream);
  assert.match(during.chat.sessions[0]!.turns[0]!.error,/凭据/);f.cleanup.release();await until(()=>!f.host.isRunning());
  assert.equal(f.state().selected!.turns[0]!.status,'failed');assert.equal(f.durable().project.runs[0]!.run.status,'failed');
 }finally{await f.close();}
});

test('user cancellation before a late native failure stays cancelled with no invented failure diagnostic',async t=>{
 const f=fixture(t,{delayedFailure:true});try{
  const turnId=f.send();await until(()=>f.readCompleted()&&f.state().selected!.turns[0]!.assistant.length>0);
  assert(f.invoke('cancelReply',{sessionId:f.sessionId,turnId}).ok);f.failure.release();await until(()=>f.stops()===1);
  f.cleanup.release();await until(()=>!f.host.isRunning());const saved=f.durable(),turn=saved.chat.sessions[0]!.turns[0]!;
  assert.equal(turn.status,'cancelled');assert.equal(turn.execution!.failureDiagnostic,undefined);assert.equal(turn.error,'');
  assert.equal(saved.project.runs[0]!.run.status,'stopped');assert(!saved.project.runs[0]!.run.events.some(e=>e.type==='run.failed'));
 }finally{await f.close();}
});
