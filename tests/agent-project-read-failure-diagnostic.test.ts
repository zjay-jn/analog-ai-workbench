import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import http from 'node:http';
import {createProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import {projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';
import {DEFAULT_REPLY_LIMITS} from '../apps/desktop/src/shared/agent/reply-limits';
import type {ProjectReadFailureDiagnostic} from '../apps/desktop/src/main/agent-project-read/engine';

const user='Synthetic exact current request',sessionID='owned-session',runId='diagnostic-run',key='sk-synthetic-never-copy-to-diagnostic';
const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'synthetic_completion',model:'kimi-k3',choices:[{index:0,delta,finish_reason}]})+'\n\n';
const done=()=>new Response(frame({role:'assistant',content:'Synthetic answer'})+frame({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
async function fixture(t:TestContext,reply:(attempt:number)=>Promise<Response>){
 let handler!:(request:http.IncomingMessage,response:http.ServerResponse)=>Promise<void>;
 class Server extends EventEmitter{listen(_port:number,_host:string,ready:()=>void){ready();return this;}address(){return {port:43123};}close(callback:()=>void){callback();return this;}}
 t.mock.method(http,'createServer',((listener:typeof handler)=>{handler=listener;return new Server();}) as unknown as typeof http.createServer);
 const counts={dispatches:0,responses:0,tools:0,failures:0};
 const model={provider:'kimi',model:'kimi-k3'} as const;
 const service=await createProjectReadProviderServices({fetchImpl:async()=>reply(++counts.dispatches),getRunCredentials:()=>({apiKey:key,model,maxRequests:null,maxOutputTokens:DEFAULT_REPLY_LIMITS.maxOutputTokens,requestTimeoutMs:DEFAULT_REPLY_LIMITS.timeoutMs,replyLimits:DEFAULT_REPLY_LIMITS}),onResponse:()=>{counts.responses++;}});
 const run=service.begin({runId,goal:'Synthetic diagnostic',constraint:'',systemText:'Synthetic permission rules',initialUserText:user,workCycle:true,chatContext:{...model,...DEFAULT_REPLY_LIMITS,messages:[{role:'user',content:user}]},nativeConversation:{conversationId:'00000000-0000-4000-8000-000000000000'},onFailure:()=>{counts.failures++;},onTool:async()=>{counts.tools++;return {ok:false,error:{code:'CANCELLED'},coverage:null};}});
 run.bindSession(sessionID);run.bindNativeContext({sessionID,messages:[]});
 const body=(content=user)=>({model:model.model,stream:true,tools:projectReadTools(true),messages:[{role:'user',content}]});
 async function post(value:unknown=body(),tool=false){
  const request=Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{headers:{authorization:'Bearer '+(tool?service.toolToken:service.providerToken),'content-type':'application/json'},url:tool?'/tool':'/v1/chat/completions',method:'POST',socket:{remoteAddress:'127.0.0.1',setTimeout:()=>{}}});
  class Reply extends EventEmitter{status=0;body='';destroyed=false;headersSent=false;writableEnded=false;writeHead(status:number){this.status=status;this.headersSent=true;return this;}write(value:string){this.body+=value;return true;}end(value=''){this.body+=value;this.writableEnded=true;return this;}destroy(){this.destroyed=true;return this;}}
  const response=new Reply();await handler(request as unknown as http.IncomingMessage,response as unknown as http.ServerResponse);return response;
 }
 return {service,run,counts,body,post};
}
function safe(actual:ProjectReadFailureDiagnostic|undefined,expected:ProjectReadFailureDiagnostic){
 assert.deepEqual(actual,expected);assert.equal(Object.isFrozen(actual),true);
 const serialized=JSON.stringify(actual);assert(!serialized.includes(key));assert(!serialized.includes('private-provider-detail'));assert(!serialized.includes(user));
}

test('failure diagnostics distinguish request rejection before any external dispatch',async t=>{
 const f=await fixture(t,async()=>done());try{
  assert.equal((await f.post(f.body('untrusted replacement'))).status,400);assert.equal(f.counts.dispatches,0);
  const expected={stage:'request_validation',reason:'PROTOCOL_ERROR',providerAttempts:1,httpDispatches:0} as const;
  safe(f.run.evidence().failureDiagnostic,expected);assert.equal(f.run.evidence().failureReason,'PROTOCOL_ERROR');
  f.service.end(runId);safe(f.service.evidence(runId)?.failureDiagnostic,expected);
 }finally{await f.service.close();}
});

test('failure diagnostics distinguish upstream authentication and HTTP rejection without retaining bodies',async t=>{
 for(const status of [401,403,400]){
  const f=await fixture(t,async()=>new Response(JSON.stringify({error:'private-provider-detail',key}),{status}));try{
   assert.equal((await f.post()).status,400);assert.equal(f.counts.dispatches,1);assert.equal(f.counts.responses,0);
   safe(f.run.evidence().failureDiagnostic,{stage:'upstream_http',reason:status===400?'PROTOCOL_ERROR':'AUTHENTICATION_FAILED',providerAttempts:1,httpDispatches:1,httpStatus:status});
  }finally{await f.service.close();}
 }
});

test('failure diagnostics identify malformed successful SSE as response validation rather than a connection failure',async t=>{
 const f=await fixture(t,async()=>new Response('data: private-provider-detail\n\n',{headers:{'content-type':'text/event-stream'}}));try{
  assert.equal((await f.post()).status,400);assert.equal(f.counts.responses,0);assert.equal(f.counts.tools,0);
  safe(f.run.evidence().failureDiagnostic,{stage:'response_validation',reason:'PROTOCOL_ERROR',providerAttempts:1,httpDispatches:1,httpStatus:200,responseFailure:{code:'sse.json',frame:1,receivedBytes:Buffer.byteLength('data: private-provider-detail\n\n'),textBytes:0,toolCalls:0,done:false,finish:'none'}});
 }finally{await f.service.close();}
});

test('failure diagnostics retain native retry ownership and clear a recovered transport failure',async t=>{
 const f=await fixture(t,async attempt=>{if(attempt===1)throw Error('private-provider-detail '+key);return done();});try{
  assert.equal((await f.post()).status,503);assert.equal(f.counts.dispatches,1);assert.equal(f.counts.failures,0);assert.equal(f.run.evidence().failureDiagnostic,undefined);assert.equal(f.run.evidence().recoverableReason,'UPSTREAM');
  // Only this explicit second native request causes another dispatch.
  assert.equal((await f.post()).status,200);assert.equal(f.counts.dispatches,2);assert.equal(f.run.evidence().failureDiagnostic,undefined);assert.equal(f.run.evidence().recoverableReason,undefined);assert.equal(f.run.evidence().complete,true);
 }finally{await f.service.close();}
});

test('response diagnostics distinguish headers and invalid UTF-8 and survive finalization without another dispatch',async t=>{
 for(const [response,code,bytes] of [
  [new Response('private-body',{headers:{'content-type':'application/json'}}),'response.content_type',0],
  [new Response(new Uint8Array([0xff]),{headers:{'content-type':'text/event-stream'}}),'response.utf8',1],
 ] as const){const f=await fixture(t,async()=>response);try{
  assert.equal((await f.post()).status,400);const first=f.run.evidence().failureDiagnostic;assert(first?.responseFailure);assert.equal(first.responseFailure.code,code);assert.equal(first.responseFailure.receivedBytes,bytes);
  f.service.finalizeFailure(runId);assert.deepEqual(f.run.evidence().failureDiagnostic,first);assert.equal(f.counts.dispatches,1);assert.equal(f.counts.tools,0);assert(!JSON.stringify(first).includes('private-body'));
 }finally{await f.service.close();}}
});

test('third-dispatch duplicate tool identity retains exact response evidence and does not execute the rejected call',async t=>{
 const ids=['synthetic_call_1','synthetic_call_2','synthetic_call_2'];
 const wire=(id:string)=>frame({tool_calls:[{index:0,id,type:'function',function:{name:'command_environment',arguments:'{}'}}]},'tool_calls')+'data: [DONE]\n\n';
 const f=await fixture(t,async attempt=>new Response(wire(ids[attempt-1]!),{headers:{'content-type':'text/event-stream'}}));
 try{
  const messages:unknown[]=[{role:'user',content:user}];
  for(let i=0;i<2;i++){
   assert.equal((await f.post({...f.body(),messages})).status,200);
   assert.equal((await f.post({sessionID,messageID:'synthetic_message_'+i,callID:ids[i],toolName:'command_environment',arguments:{}},true)).status,200);
   messages.push({role:'assistant',content:null,tool_calls:[{id:ids[i],type:'function',function:{name:'command_environment',arguments:'{}'}}]},{role:'tool',tool_call_id:ids[i],content:JSON.stringify({ok:false,error:{code:'CANCELLED'},coverage:null})});
  }
  assert.equal((await f.post({...f.body(),messages})).status,400);
  const first=f.run.evidence().failureDiagnostic;assert(first?.responseFailure);assert.equal(first.httpDispatches,3);assert.equal(first.providerAttempts,3);assert.equal(first.responseFailure.code,'response.call_identity');assert.equal(first.responseFailure.frame,2);assert.equal(first.responseFailure.receivedBytes,Buffer.byteLength(wire(ids[2]!)));assert.equal(first.responseFailure.toolCalls,1);assert.equal(first.responseFailure.done,true);assert.equal(f.counts.tools,2);
  f.service.finalizeFailure(runId);assert.deepEqual(f.run.evidence().failureDiagnostic,first);assert.equal(f.counts.dispatches,3);
 }finally{await f.service.close();}
});

test('Kimi empty completion details permit the authenticated status tool and following native request without a false failure',async t=>{
 const args={executionId:'cmd-00000000-0000-4000-8000-000000000001',afterRevision:1,waitMs:25000},callId='synthetic_status';
 const usage={prompt_tokens:9936,completion_tokens:105,total_tokens:10041,completion_tokens_details:{},prompt_tokens_details:{cache_write_tokens:9728}};
 const wire=frame({tool_calls:[{index:0,id:callId,type:'function',function:{name:'command_status',arguments:JSON.stringify(args)}}]})+'data: '+JSON.stringify({id:'synthetic_completion',model:'kimi-k3',choices:[{index:0,delta:{},finish_reason:'tool_calls',usage}]})+'\n\ndata: [DONE]\n\n';
 const f=await fixture(t,async attempt=>attempt===1?new Response(new ReadableStream({start(controller){for(let i=0;i<wire.length;i+=13)controller.enqueue(new TextEncoder().encode(wire.slice(i,i+13)));controller.close();}}),{headers:{'content-type':'text/event-stream'}}):done());
 try{
  assert.equal((await f.post()).status,200);assert.equal(f.counts.responses,1);assert.equal(f.run.evidence().failureDiagnostic,undefined);
  assert.equal((await f.post({sessionID,messageID:'synthetic_message',callID:callId,toolName:'command_status',arguments:args},true)).status,200);assert.equal(f.counts.tools,1);
  const messages=[{role:'user',content:user},{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name:'command_status',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:callId,content:JSON.stringify({ok:false,error:{code:'CANCELLED'},coverage:null})}];
  assert.equal((await f.post({...f.body(),messages})).status,200);assert.equal(f.run.evidence().complete,true);assert.equal(f.counts.failures,0);assert.equal(f.counts.dispatches,2);assert.equal(f.counts.tools,1);
 }finally{await f.service.close();}
});

test('failure diagnostics freeze the last trusted transport or HTTP retry only when native finalizes failure',async t=>{
 for(const status of [undefined,503]){
  const f=await fixture(t,async()=>{if(status===undefined)throw Error('private-provider-detail');return new Response('private-provider-detail',{status});});try{
   assert.equal((await f.post()).status,503);assert.equal(f.run.evidence().failureDiagnostic,undefined);
   f.service.finalizeFailure(runId);
   const expected={stage:status===undefined?'upstream_transport':'upstream_http',reason:'UPSTREAM',providerAttempts:1,httpDispatches:1,...(status===undefined?{}:{httpStatus:status})} as const;
   safe(f.run.evidence().failureDiagnostic,expected);assert.equal((await f.post()).status,400);safe(f.run.evidence().failureDiagnostic,expected);assert.equal(f.counts.dispatches,1);
  }finally{await f.service.close();}
 }
});

test('failure diagnostics identify an unissued tool without executing it or storing its arguments',async t=>{
 const f=await fixture(t,async()=>done());try{
  assert.equal((await f.post({sessionID,messageID:'message',callID:'unissued',toolName:'fs_read',arguments:{path:'private-provider-detail'}},true)).status,400);
  assert.equal(f.counts.dispatches,0);assert.equal(f.counts.tools,0);
  safe(f.run.evidence().failureDiagnostic,{stage:'tool_validation',reason:'PROTOCOL_ERROR',providerAttempts:0,httpDispatches:0});
 }finally{await f.service.close();}
});
