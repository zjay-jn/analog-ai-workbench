import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import type {ProjectReadEngine,ProjectReadEngineInput,ProjectReadFailureDiagnostic} from '../apps/desktop/src/main/agent-project-read/engine';
import type {NativeEngineFailure} from '../apps/desktop/src/shared/agent/native-engine-failure';
import {parseChatFailureDiagnostic,type ChatFailureDiagnostic} from '../apps/desktop/src/shared/agent/chat-turns';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk,type SessionMethod} from '../apps/desktop/src/shared/agent/chat-sessions';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import {localToolFailureMessage} from '../apps/desktop/src/shared/agent/local-tool-failure';
import {providerUsageDiagnostic} from '../apps/desktop/src/shared/agent/provider-response-diagnostic';

// Real coordinator, session host and persistence parser. Native/project IO is
// synthetic; this suite has no credentials, external API or socket activity.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'failure-diagnostic',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(done:()=>boolean){for(let n=0;n<100;n++){if(done())return;await tick();}assert.fail('synthetic operation did not settle');}
function fixture(diagnostic:ChatFailureDiagnostic,initial:SessionDisk={version:6,selectedId:null,sessions:[]},stop?:()=>Promise<void>,nativeFailure:NativeEngineFailure|undefined=diagnostic.nativeFailure){
 let disk=parseSessionDisk(structuredClone(initial)),stops=0,failed=false;
 const starts:ProjectReadEngineInput[]=[];
 const forbidden=():never=>assert.fail('unexpected project IO or legacy transport');
 const engine:ProjectReadEngine={dispose(){},shutdown:async()=>{},health:async()=>true,status:()=>({model:{provider:'kimi',model:'kimi-k3'},canStart:true,processState:'ready',reason:null}),
  accept:(_id,model)=>model,acceptChat:(_id,model)=>model,canDeliver:()=>true,
  accounting:()=>({providerAttempts:failed?diagnostic.providerAttempts:0,httpDispatches:failed?diagnostic.httpDispatches:0,contextBytes:0,...(failed&&diagnostic.stage!=='native_engine'?{failureReason:(diagnostic as ProjectReadFailureDiagnostic).reason,failureDiagnostic:diagnostic as ProjectReadFailureDiagnostic}:{})}),
  start:async input=>{starts.push(input);input.callbacks.notice({type:'started',sessionId:'native-failure-fixture'});if(nativeFailure)input.callbacks.notice({type:'text',messageId:'synthetic-partial',step:1,text:'已收到的部分回答'});failed=true;input.callbacks.notice({type:'failed',...(nativeFailure?{nativeFailure}:{})});},
  answer:async()=>forbidden(),stop:async()=>{stops++;await stop?.();},
 };
 const project={captureChat:(projectId:string)=>({projectId,scope:null,wsl:Promise.resolve(null),commandEnvironmentVersion:'a'.repeat(64)}),createChatEngine:()=>engine,
  attachChat:forbidden,finishChat:forbidden,answerChat:forbidden,chatRun:()=>null,chatRuns:()=>[]} as unknown as ProjectReadHost;
 const arbiter=createAgentRuntimeArbiter();let host:ReturnType<typeof createSessionHost>;
 const service=createUnifiedChatCoordinator({project,arbiter,workspace:emptyWorkspace,getSession:id=>host.getSession(id),plain:forbidden});
 host=createSessionHost({owner,store:{load:()=>structuredClone(disk),save:value=>{disk=parseSessionDisk(structuredClone(value));}},configured:{kimi:true,deepseek:true},execute:forbidden,executeMultimodal:forbidden,turns:service});
 const invoke=<M extends SessionMethod>(method:M,args:object={})=>host.invoke(owner,method,{contractVersion:SESSION_VERSION,...args});
 const state=()=>{const result=invoke('readState');assert(result.ok);return result.value;};
 if(!disk.selectedId)assert(invoke('createSession',{provider:'kimi',title:'synthetic diagnostic'}).ok);
 const sessionId=state().selectedId!;
 return {host,state,starts,invoke,sessionId,durable:()=>structuredClone(disk),stops:()=>stops,
  send(){assert(invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'synthetic failure diagnosis'}).ok);},
  async close(){host.revoke();await tick();await arbiter.close();},
 };
}

test('chat failure diagnostics accept only bounded fixed fields and never raw provider details',()=>{
 const safe:ChatFailureDiagnostic={stage:'response_validation',reason:'PROTOCOL_ERROR',providerAttempts:1,httpDispatches:1,httpStatus:200};
 assert.deepEqual(parseChatFailureDiagnostic(safe),safe);
 for(const extra of [{message:'private upstream error'},{apiKey:'synthetic-secret'},{headers:{Authorization:'synthetic-secret'}},{arguments:{path:'private-source'}}])assert.throws(()=>parseChatFailureDiagnostic({...safe,...extra}));
 for(const invalid of [{stage:'raw_response'},{reason:'private upstream error'},{providerAttempts:-1},{httpDispatches:NaN},{httpStatus:700},{httpStatus:'401'}])assert.throws(()=>parseChatFailureDiagnostic({...safe,...invalid}));
 let read=false;const accessor=Object.defineProperty({...safe},'httpStatus',{enumerable:true,get(){read=true;return 200;}});assert.throws(()=>parseChatFailureDiagnostic(accessor));assert.equal(read,false);
});

test('local host execution errors retain their true cause through persistence and cold history',async()=>{
 for(const toolFailure of ['CLEANUP_FAILED','STORAGE_FAILED','UNEXPECTED'] as const){
  const diagnostic:ChatFailureDiagnostic={stage:'tool_execution',reason:'ENGINE_FAILED',providerAttempts:1,httpDispatches:1,toolFailure};
  assert.deepEqual(parseChatFailureDiagnostic(diagnostic),diagnostic);
  for(const patch of [{httpStatus:200},{toolFailure:'private failure detail'},{toolFailure:undefined},{stage:'tool_validation'},{reason:'PROTOCOL_ERROR'},{nativeFailure:{origin:'native_client',stage:'event_decode',reason:'stream_closed'}}])assert.throws(()=>parseChatFailureDiagnostic({...diagnostic,...patch}));
  const f=fixture(diagnostic);try{
   f.send();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;
   assert.equal(turn.status,'failed');assert.deepEqual(turn.execution!.failureDiagnostic,diagnostic);assert.equal(turn.error,localToolFailureMessage(toolFailure));assert.doesNotMatch(turn.error,/校验|模型服务/);
   const cold=fixture(diagnostic,f.durable());try{await tick();assert.equal(cold.starts.length,0);assert.equal(cold.state().selected!.turns[0]!.error,turn.error);assert.deepEqual(cold.state().selected!.turns[0]!.execution!.failureDiagnostic,diagnostic);}finally{await cold.close();}
  }finally{await f.close();}
 }
});

test('detailed response failure survives cleanup and cold reopen with no replay or private values',async()=>{
 const diagnostic:ChatFailureDiagnostic={stage:'response_validation',reason:'PROTOCOL_ERROR',providerAttempts:3,httpDispatches:3,httpStatus:200,responseFailure:{code:'sse.tool.arguments_schema',frame:14,receivedBytes:2048,textBytes:0,toolCalls:1,done:true,finish:'tool_calls'}};
 assert.deepEqual(parseChatFailureDiagnostic(diagnostic),diagnostic);
 for(const patch of [{stage:'tool_validation'},{reason:'UPSTREAM'},{providerAttempts:0,httpDispatches:0},{responseFailure:{...diagnostic.responseFailure,message:'private'}},{responseFailure:{...diagnostic.responseFailure,code:'private'}}])assert.throws(()=>parseChatFailureDiagnostic({...diagnostic,...patch}));
 let release!:()=>void;const cleaning=new Promise<void>(resolve=>{release=resolve;});const f=fixture(diagnostic,undefined,()=>cleaning);
 try{f.send();await until(()=>f.stops()===1);assert.deepEqual(f.durable().sessions[0]!.turns[0]!.execution!.failureDiagnostic,diagnostic);release();await until(()=>!f.host.isRunning());
  const cold=fixture(diagnostic,f.durable());try{await tick();assert.equal(cold.starts.length,0);assert.equal(cold.stops(),0);assert.deepEqual(cold.state().selected!.turns[0]!.execution!.failureDiagnostic,diagnostic);}finally{await cold.close();}
 }finally{release();await f.close();}
});

test('fixed usage shape and numeric evidence persist and cold reopen without raw provider fields',async()=>{
 const usage=providerUsageDiagnostic({prompt_tokens:10,completion_tokens:2,total_tokens:12,private_key:'private-value'},'choice',null);
 const diagnostic:ChatFailureDiagnostic={stage:'response_validation',reason:'PROTOCOL_ERROR',providerAttempts:3,httpDispatches:3,httpStatus:200,responseFailure:{code:'sse.choice.usage.finish',frame:32,receivedBytes:7768,textBytes:0,toolCalls:1,done:false,finish:'none',usage}};
 assert.deepEqual(parseChatFailureDiagnostic(diagnostic),diagnostic);assert(!JSON.stringify(diagnostic).includes('private'));
 const f=fixture(diagnostic);try{f.send();await until(()=>!f.host.isRunning());const cold=fixture(diagnostic,f.durable());try{await tick();assert.equal(cold.starts.length,0);assert.deepEqual(cold.state().selected!.turns[0]!.execution!.failureDiagnostic,diagnostic);}finally{await cold.close();}}finally{await f.close();}
});

test('request admission and response validation failures remain distinguishable without blaming network connectivity',async()=>{
 for(const diagnostic of [
  {stage:'request_validation',reason:'PROTOCOL_ERROR',providerAttempts:1,httpDispatches:0},
  {stage:'response_validation',reason:'PROTOCOL_ERROR',providerAttempts:1,httpDispatches:1,httpStatus:200},
 ] satisfies ChatFailureDiagnostic[]){
  const f=fixture(diagnostic);try{
   f.send();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;
   assert.equal(turn.status,'failed');assert.equal(turn.assistant,'');assert.equal(turn.execution!.cleanupState,'idle');assert.deepEqual(turn.execution!.failureDiagnostic,diagnostic);
   assert.doesNotMatch(turn.error,/暂时无法连接模型服务/u);assert.match(turn.error,diagnostic.stage==='request_validation'?/请求|发送前|本地/u:/回复|响应/u);
   assert.equal(f.starts.length,1);assert.equal(f.stops(),1);assert.equal(turn.execution!.runLink,null);
  }finally{await f.close();}
 }
});

test('authentication rejection is durable before cleanup and cold history never retries the failed K3 request',async()=>{
 const diagnostic:ChatFailureDiagnostic={stage:'upstream_http',reason:'AUTHENTICATION_FAILED',providerAttempts:1,httpDispatches:1,httpStatus:401};
 let release!:()=>void;const cleaning=new Promise<void>(resolve=>{release=resolve;});const f=fixture(diagnostic,undefined,()=>cleaning);
 try{
  f.send();await until(()=>f.stops()===1);assert(f.host.isRunning());
  const during=f.durable().sessions[0]!.turns[0]!;assert.deepEqual(during.execution!.failureDiagnostic,diagnostic);assert.match(during.error,/凭据|认证/u);assert.doesNotMatch(during.error,/暂时无法连接/u);
  release();await until(()=>!f.host.isRunning());const saved=f.durable();assert.equal(saved.sessions[0]!.turns[0]!.status,'failed');assert.equal(saved.sessions[0]!.turns[0]!.execution!.cleanupState,'idle');
  const cold=fixture(diagnostic,saved);try{
   await tick();assert.deepEqual(cold.durable(),saved);assert.equal(cold.starts.length,0);assert.equal(cold.stops(),0);
   assert(cold.invoke('readTurnActivity',{sessionId:cold.sessionId,turnId:saved.sessions[0]!.turns[0]!.id,afterSequence:0}).ok);assert.equal(cold.starts.length,0);
  }finally{await cold.close();}
 }finally{release();await f.close();}
});

test('upstream transport failure remains the first cause when the user stops during cleanup',async()=>{
 const diagnostic:ChatFailureDiagnostic={stage:'upstream_transport',reason:'UPSTREAM',providerAttempts:2,httpDispatches:2};
 let release!:()=>void;const cleaning=new Promise<void>(resolve=>{release=resolve;});const f=fixture(diagnostic,undefined,()=>cleaning);try{
  f.send();await until(()=>f.stops()===1);assert(f.host.isRunning());
  const during=f.durable().sessions[0]!.turns[0]!,firstError=during.error;
  assert.deepEqual(during.execution!.failureDiagnostic,diagnostic);assert.equal(during.stopReason,'unavailable');assert.match(firstError,/连接|网络|传输|模型服务/u);assert.doesNotMatch(firstError,/本地.*校验/u);
  assert(f.invoke('cancelReply',{sessionId:f.sessionId,turnId:during.id}).ok);assert(f.host.isRunning());
  release();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;
  assert.equal(turn.status,'failed');assert.equal(turn.execution!.phase,'failed');assert.equal(turn.execution!.cleanupState,'idle');assert.equal(turn.stopReason,'unavailable');assert.equal(turn.error,firstError);assert.deepEqual(turn.execution!.failureDiagnostic,diagnostic);
  assert.equal(f.starts.length,1);assert.equal(f.stops(),1);
 }finally{release();await f.close();}
});

test('a timeout at response headers keeps the timeout message even when HTTP status is 200',async()=>{
 const diagnostic:ChatFailureDiagnostic={stage:'upstream_http',reason:'TIMEOUT',providerAttempts:1,httpDispatches:1,httpStatus:200};
 const f=fixture(diagnostic);try{
  f.send();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;
  assert.equal(turn.status,'failed');assert.equal(turn.execution!.cleanupState,'idle');assert.deepEqual(turn.execution!.failureDiagnostic,diagnostic);
  assert.match(turn.error,/单次模型请求超过30秒/u);assert.doesNotMatch(turn.error,/HTTP\s*200/u);
  assert.equal(f.starts.length,1);assert.equal(f.stops(),1);
 }finally{await f.close();}
});

test('native stream failures preserve partial text, bounded cause and cold history without replay',async()=>{
 const nativeFailure:NativeEngineFailure={origin:'native_client',stage:'event_decode',reason:'stream_closed'};
 const diagnostic:ChatFailureDiagnostic={stage:'native_engine',reason:'ENGINE_FAILED',providerAttempts:4,httpDispatches:4,nativeFailure};
 assert.deepEqual(parseChatFailureDiagnostic(diagnostic),diagnostic);
 for(const patch of [{httpStatus:200},{nativeFailure:{...nativeFailure,message:'private content'}},{nativeFailure:undefined},{stage:'response_validation'},{reason:'PROTOCOL_ERROR'}])assert.throws(()=>parseChatFailureDiagnostic({...diagnostic,...patch}));
 const f=fixture(diagnostic);try{
  f.send();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;
  assert.equal(turn.assistant,'已收到的部分回答');assert.equal(turn.status,'failed');assert.equal(turn.execution!.cleanupState,'idle');
  assert.deepEqual(turn.execution!.failureDiagnostic,diagnostic);assert.match(turn.error,/接收引擎实时消息时连接中断/);assert.doesNotMatch(turn.error,/模型服务|凭据/);
  const cold=fixture(diagnostic,f.durable());try{await tick();assert.equal(cold.starts.length,0);assert.deepEqual(cold.state().selected!.turns[0]!.execution!.failureDiagnostic,diagnostic);}finally{await cold.close();}
 }finally{await f.close();}
});

test('known upstream cause wins over the resulting native session error',async()=>{
 const diagnostic:ChatFailureDiagnostic={stage:'upstream_http',reason:'AUTHENTICATION_FAILED',providerAttempts:1,httpDispatches:1,httpStatus:401};
 const f=fixture(diagnostic,undefined,undefined,{origin:'native_client',stage:'event_decode',reason:'native_session_error'});try{
  f.send();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;
  assert.deepEqual(turn.execution!.failureDiagnostic,diagnostic);assert.match(turn.error,/凭据/);assert.equal(turn.assistant,'已收到的部分回答');
 }finally{await f.close();}
});
