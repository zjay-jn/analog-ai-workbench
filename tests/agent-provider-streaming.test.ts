import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectReadProviderServices,type ProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import {parseProjectReadSse,projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';
import {buildUnifiedChatContext} from '../apps/desktop/src/main/cloud/unified-chat-context';
import type {ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';

const model={provider:'kimi',model:'kimi-k3'} as const;
const key='sk-synthetic-stream-only-key',user='Synthetic streaming test only';
const limits={maxOutputTokens:2048,timeoutMs:30000};
const args={directoryId:null,cursor:null,refresh:false};
const result:ProjectReadToolResult={ok:false,error:{code:'NOT_BOUND'},coverage:null};
const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'synthetic_stream',model:model.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
const ending=(finish='stop')=>frame({},finish)+'data: [DONE]\n\n';
const body=(messages:unknown[]=[{role:'user',content:user}])=>({model:model.model,messages,tools:projectReadTools(),stream:true});
const tool=(callId='synthetic_call')=>({index:0,id:callId,type:'function',function:{name:'project_list',arguments:JSON.stringify(args)}});
const post=(service:ProjectReadProviderServices,value:unknown=body(),isTool=false)=>fetch(`http://127.0.0.1:${service.port}${isTool?'/tool':'/v1/chat/completions'}`,{
  method:'POST',headers:{Authorization:'Bearer '+(isTool?service.toolToken:service.providerToken),'Content-Type':'application/json'},body:JSON.stringify(value),
});
function gate(){
  let controller!:ReadableStreamDefaultController<Uint8Array>,pulls=0,cancelled=false;
  const waiters:Array<{count:number;resolve:()=>void}>=[];
  const stream=new ReadableStream<Uint8Array>({
    start(value){controller=value;},
    pull(){pulls++;for(const waiter of [...waiters])if(pulls>=waiter.count){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve();}},
    cancel(){cancelled=true;},
  },{highWaterMark:0});
  const waitForPull=(count:number)=>pulls>=count?Promise.resolve():new Promise<void>(resolve=>waiters.push({count,resolve}));
  return {response:new Response(stream,{headers:{'Content-Type':'text/event-stream'}}),waitForPull,
    async send(value:string){const next=pulls+1;controller.enqueue(new TextEncoder().encode(value));await waitForPull(next);},
    enqueue(value:string){controller.enqueue(new TextEncoder().encode(value));},
    close(){controller.close();},error(){controller.error(new Error('Synthetic upstream reader failure'));},cancelled:()=>cancelled};
}
async function fixture(respond:(attempt:number)=>Promise<Response>|Response,timeouts?:{firstByteTimeoutMs:number;idleTimeoutMs:number}){
  let sent=0,failures=0,tools=0,responses=0;
  const context=buildUnifiedChatContext({...model,text:user,images:[],files:[],schematics:[],history:[],replyLimits:limits}).request;
  const service=await createProjectReadProviderServices({
    getRunCredentials:()=>({apiKey:key,model,maxRequests:8,maxOutputTokens:limits.maxOutputTokens,requestTimeoutMs:limits.timeoutMs,replyLimits:limits}),
    fetchImpl:async(url,init)=>{assert.equal(url,'https://api.moonshot.cn/v1/chat/completions');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+key);return respond(++sent);},
    onResponse:()=>{responses++;},
    ...(timeouts?{timeouts}:{}),
  });
  const run=service.begin({runId:'synthetic_stream_run',goal:'synthetic',constraint:'',systemText:'Only synthetic inputs.',initialUserText:user,chatContext:context,
    onFailure:()=>{failures++;},onTool:async()=>{tools++;return result;}});
  run.bindSession('synthetic_session');
  return {service,run,counts:()=>({sent,failures,tools,responses})};
}
async function readThrough(reader:ReadableStreamDefaultReader<Uint8Array>,needle:string,prefix=''){
  const decoder=new TextDecoder();let value=prefix;
  while(!value.includes(needle)){const next=await reader.read();assert.equal(next.done,false,'stream ended before '+needle);value+=decoder.decode(next.value,{stream:true});}
  return value;
}
async function started(upstream:ReturnType<typeof gate>,pending:Promise<Response>){
  await Promise.race([upstream.waitForPull(1),pending.then(response=>{throw new Error('Gateway responded before reading the synthetic provider stream: '+response.status);})]);
}
async function remainder(reader:ReadableStreamDefaultReader<Uint8Array>){
  const decoder=new TextDecoder();let value='';while(true){const next=await reader.read();if(next.done)return value+decoder.decode();value+=decoder.decode(next.value,{stream:true});}
}

test('chat streaming sends validated text through a real HTTP reader before upstream EOF', {timeout:10000},async()=>{
  const upstream=gate(),f=await fixture(()=>upstream.response);
  try{
    const pending=post(f.service);await started(upstream,pending);
    await upstream.send(frame({role:'assistant',reasoning_content:'private reasoning',content:'first ' }));
    const response=await pending;assert.equal(response.status,200);const reader=response.body!.getReader();
    let wire=await readThrough(reader,'first ');assert.equal(wire.includes('[DONE]'),false);assert.equal(wire.includes('private reasoning'),false);
    assert.equal(f.run.evidence().responses,0);assert.equal(f.run.evidence().complete,false);
    await upstream.send(frame({content:'second'}));wire=await readThrough(reader,'second',wire);
    await upstream.send(ending());assert.equal(f.run.evidence().responses,0,'DONE is not EOF');
    upstream.close();wire+=await remainder(reader);
    assert.equal(parseProjectReadSse(wire,2048,model,limits).text,'first second');
    assert.deepEqual(f.counts(),{sent:1,failures:0,tools:0,responses:1});assert.equal(f.run.evidence().complete,true);
  }finally{await f.service.close();}
});

test('chat streaming withholds tool arguments and final markers until the whole response is validated', {timeout:10000},async()=>{
  const upstream=gate(),f=await fixture(()=>upstream.response);
  try{
    const pending=post(f.service);await started(upstream,pending);await upstream.send(frame({role:'assistant',content:'Checking the synthetic list.'}));
    const response=await pending,reader=response.body!.getReader();let wire=await readThrough(reader,'synthetic list.');
    await upstream.send(frame({tool_calls:[tool()]}));await upstream.send(ending('tool_calls'));
    assert.deepEqual(f.run.evidence().issued,[]);assert.equal(f.counts().tools,0);assert.equal(f.counts().responses,0);
    assert.equal(wire.includes('tool_calls'),false);assert.equal(wire.includes('[DONE]'),false);
    upstream.close();wire+=await remainder(reader);const completed=parseProjectReadSse(wire,2048,model,limits);
    assert.equal(completed.finish,'tool_calls');assert.deepEqual(completed.calls[0]!.arguments,args);assert.deepEqual(f.run.evidence().issued,['synthetic_call']);
    const toolResponse=await post(f.service,{sessionID:'synthetic_session',messageID:'synthetic_message',callID:'synthetic_call',toolName:'project_list',arguments:args},true);
    assert.equal(toolResponse.status,200);assert.deepEqual(await toolResponse.json(),result);assert.equal(f.counts().tools,1);
  }finally{await f.service.close();}
});

for(const failure of ['malformed','network'] as const)test('chat streaming retains the visible prefix but terminates on '+failure+' without committing tools', {timeout:10000},async()=>{
  const upstream=gate(),f=await fixture(()=>upstream.response);
  try{
    const pending=post(f.service);await started(upstream,pending);await upstream.send(frame({role:'assistant',content:'Visible partial reply.'}));
    const response=await pending,reader=response.body!.getReader();const visible=await readThrough(reader,'Visible partial reply.');
    if(failure==='malformed')upstream.enqueue(frame({tool_calls:[tool()]}).replace('"project_list"','"unknown_tool"'));else upstream.error();
    await assert.rejects(()=>remainder(reader));assert.equal(response.status,200);assert.equal(visible.includes('[DONE]'),false);
    assert.equal(f.run.evidence().failed,true);assert.equal(f.run.evidence().complete,false);assert.equal(f.run.evidence().responses,0);assert.deepEqual(f.run.evidence().issued,[]);
    assert.equal(f.run.evidence().failureReason,failure==='network'?'UPSTREAM':'PROTOCOL_ERROR');assert.equal(f.run.evidence().recoverableReason,undefined);
    assert.equal((await post(f.service)).status,400);assert.deepEqual(f.counts(),{sent:1,failures:1,tools:0,responses:0});
  }finally{await f.service.close();}
});

test('chat streaming never publishes a credential assembled across separate content frames', {timeout:10000},async()=>{
  const upstream=gate(),f=await fixture(()=>upstream.response),split=12;
  try{
    const pending=post(f.service);await started(upstream,pending);
    await upstream.send(frame({role:'assistant',content:'Safe text. '+key.slice(0,split)}));
    const response=await pending,reader=response.body!.getReader();const visible=await readThrough(reader,'Safe text. ');
    assert.equal(visible.includes(key.slice(0,split)),false,'credential prefix must remain unpublished');
    upstream.enqueue(frame({content:key.slice(split)}));await assert.rejects(()=>remainder(reader));
    assert.equal(f.run.evidence().failureReason,'PROTOCOL_ERROR');assert.equal(f.run.evidence().responses,0);assert.equal(visible.includes(key),false);
    assert.equal(JSON.stringify(f.service.traffic()).includes(key),false);
  }finally{await f.service.close();}
});

test('chat streaming checks cumulative output capacity before publishing an over-budget delta', {timeout:10000},async()=>{
  const upstream=gate(),firstText='A'.repeat(65520);
  const f=await fixture(attempt=>attempt===1?new Response(frame({role:'assistant',content:firstText,tool_calls:[tool()]})+ending('tool_calls'),{headers:{'Content-Type':'text/event-stream'}}):upstream.response);
  try{
    const first=await post(f.service);assert.equal(first.status,200);await first.text();
    const toolResponse=await post(f.service,{sessionID:'synthetic_session',messageID:'synthetic_message',callID:'synthetic_call',toolName:'project_list',arguments:args},true);
    assert.equal(toolResponse.status,200);const saved=await toolResponse.text();
    const pending=post(f.service,body([{role:'user',content:user},{role:'assistant',content:firstText,tool_calls:[{id:'synthetic_call',type:'function',function:{name:'project_list',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:'synthetic_call',content:saved}]));
    await started(upstream,pending);await upstream.send(frame({role:'assistant',content:'0123456789'}));
    const response=await pending,reader=response.body!.getReader();const visible=await readThrough(reader,'0123456789');
    upstream.enqueue(frame({content:'OVER_BUDGET'}));await assert.rejects(()=>remainder(reader));
    assert.equal(visible.includes('OVER_BUDGET'),false);assert.equal(f.run.evidence().failureReason,'CONTEXT_LIMIT');
    assert.equal(f.run.evidence().responses,1);assert.equal(f.counts().tools,1);assert.equal(f.counts().sent,2);
  }finally{await f.service.close();}
});

test('chat streaming preserves native retry admission when no response text was published', {timeout:10000},async()=>{
  const f=await fixture(attempt=>attempt===1?new Response('synthetic unavailable',{status:503}):new Response(frame({role:'assistant',content:'Recovered.'})+ending(),{headers:{'Content-Type':'text/event-stream'}}));
  try{
    const first=await post(f.service);assert.equal(first.status,503);assert.deepEqual(await first.json(),{error:{message:'Upstream temporarily unavailable'}});
    assert.equal(f.run.evidence().failed,false);assert.equal(f.run.evidence().recoverableReason,'UPSTREAM');
    const second=await post(f.service);assert.equal(second.status,200);assert.equal(parseProjectReadSse(await second.text(),2048,model,limits).text,'Recovered.');
    assert.deepEqual(f.counts(),{sent:2,failures:0,tools:0,responses:1});
  }finally{await f.service.close();}
});

for(const mode of ['idle','request'] as const)test('chat streaming preserves '+mode+' timeout classification after a visible prefix', {timeout:10000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const upstream=gate(),f=await fixture(()=>upstream.response,{firstByteTimeoutMs:120000,idleTimeoutMs:mode==='idle'?20:60000});
  try{
    const pending=post(f.service);await started(upstream,pending);await upstream.send(frame({role:'assistant',content:'Visible before timeout.'}));
    const response=await pending,reader=response.body!.getReader();const visible=await readThrough(reader,'Visible before timeout.');
    t.mock.timers.tick(mode==='idle'?20:30000);await assert.rejects(()=>remainder(reader));
    assert.equal(response.status,200);assert.equal(visible.includes('[DONE]'),false);assert.equal(f.run.evidence().responses,0);
    assert.equal(f.run.evidence().failureReason,mode==='idle'?'IDLE_TIMEOUT':'TIMEOUT');
    assert.equal(f.run.evidence().failureDiagnostic?.httpStatus,200);assert.equal(f.run.evidence().recoverableReason,undefined);
    assert.deepEqual(f.counts(),{sent:1,failures:1,tools:0,responses:0});
  }finally{await f.service.close();t.mock.timers.reset();}
});
