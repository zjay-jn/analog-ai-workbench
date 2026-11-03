import test from 'node:test';
import assert from 'node:assert/strict';
import {performCloudChatV1,listCloudModelsV1,type CloudFetchV1} from '../apps/desktop/src/main/cloud/cloud-transport';
import {CloudChatErrorV1} from '../packages/agent-adapters/src/cloud-chat-contract';

const apiKey='sk-FAKE_TEST_ONLY_123456';
const input={provider:'deepseek',model:'deepseek-v4-flash',messages:[{role:'user',content:'Reply exactly OK.'}],maxOutputTokens:64};
const wire=(s:string)=>new TextEncoder().encode(s);
const valid='data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const response=()=>new Response(valid,{headers:{'Content-Type':'text/event-stream'}});
const code=(expected:string)=>(error:unknown)=>error instanceof CloudChatErrorV1&&error.code===expected&&!error.message.includes(apiKey);

test('P5 transport uses only fixed origin, header and bounded body with no tools',async()=>{
  let calls=0;const chunks:string[]=[];
  const fetchImpl:CloudFetchV1=async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+apiKey);const body=JSON.parse(init.body as string);assert.deepEqual(body.messages,input.messages);assert.equal(body.max_tokens,64);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.tools,undefined);assert.equal(body.stream,true);return response();};
  const result=await performCloudChatV1(input,{apiKey,fetchImpl,onText:text=>chunks.push(text)});
  assert.equal(result.text,'OK');assert.deepEqual(chunks,['OK']);assert.equal(calls,1);
});

test('P5 Kimi request has low reasoning and no unsupported thinking toggle',async()=>{
  const fetchImpl:CloudFetchV1=async(url,init)=>{assert.equal(url,'https://api.moonshot.cn/v1/chat/completions');const body=JSON.parse(init.body as string);assert.equal(body.reasoning_effort,'low');assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,256);return response();};
  await performCloudChatV1({...input,provider:'kimi',model:'kimi-k3',maxOutputTokens:256},{apiKey,fetchImpl,onText:()=>{}});
});

test('P5 pre-cancel has zero fetches and zero text callbacks',async()=>{
  const controller=new AbortController();controller.abort();let calls=0,deliveries=0;
  await assert.rejects(performCloudChatV1(input,{apiKey,signal:controller.signal,fetchImpl:async()=>{calls++;return response();},onText:()=>{deliveries++;}}),code('CANCELLED'));
  assert.equal(calls,0);assert.equal(deliveries,0);
});

test('P5 HTTP errors never consume or echo error body and never retry',async()=>{
  for(const [status,expected] of [[401,'AUTHENTICATION_FAILED'],[403,'AUTHENTICATION_FAILED'],[429,'RATE_LIMITED'],[500,'UPSTREAM_UNAVAILABLE']] as const){
    let calls=0,cancelled=0;const body=new ReadableStream<Uint8Array>({cancel(){cancelled++;}});
    await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>{assert.fail('unexpected body delivery');},fetchImpl:async()=>{calls++;return new Response(body,{status});}}),code(expected));
    assert.equal(calls,1);assert.equal(cancelled,1);
  }
});

test('P5 response MIME and raw transport errors are safely rejected',async()=>{
  await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>{},fetchImpl:async()=>new Response(apiKey,{headers:{'content-type':'text/html'}})}),code('PROTOCOL_ERROR'));
  await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>{},fetchImpl:async()=>{throw new Error(apiKey);}}),code('UPSTREAM_UNAVAILABLE'));
});

test('P5 deadline covers stalled fetch even when fake transport ignores abort',async()=>{
  await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>{},timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),code('TIMEOUT'));
});

test('P5 deadline covers stalled tail after stop and DONE; partial is not success',async()=>{
  let cancelled=0;const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(wire(valid));},cancel(){cancelled++;}});
  await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>{},timeoutMs:10,fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})}),code('TIMEOUT'));
  assert.equal(cancelled,1);
});

test('P5 abort after partial text refuses late data and cancels reader',async()=>{
  const abort=new AbortController();let delivered=0,cancelled=0;
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(wire(valid));},cancel(){cancelled++;}});
  await assert.rejects(performCloudChatV1(input,{apiKey,signal:abort.signal,onText:()=>{delivered++;abort.abort();},fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})}),code('CANCELLED'));
  assert.equal(delivered,1);assert.equal(cancelled,1);
});

test('P5 late response after timeout is cancelled without text delivery',async()=>{
  let resolve!: (r:Response)=>void,cancelled=0,delivered=0;
  const pending=new Promise<Response>(r=>{resolve=r;});
  await assert.rejects(performCloudChatV1(input,{apiKey,timeoutMs:10,onText:()=>{delivered++;},fetchImpl:()=>pending}),code('TIMEOUT'));
  resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}}));
  await new Promise(r=>setImmediate(r));assert.equal(delivered,0);assert.equal(cancelled,1);
});

test('P5 model list accepts bounded IDs only and no provider metadata',async()=>{
  const result=await listCloudModelsV1('deepseek',{apiKey,fetchImpl:async(url,init)=>{assert.equal(url,'https://api.deepseek.com/models');assert.equal(init.method,'GET');return new Response(JSON.stringify({data:[{id:'deepseek-v4-flash',privateMetadata:'DO_NOT_RETURN'}]}),{headers:{'content-type':'application/json'}});}});
  assert.deepEqual(result,['deepseek-v4-flash']);assert.ok(Object.isFrozen(result));
  await assert.rejects(listCloudModelsV1('deepseek',{apiKey,fetchImpl:async()=>new Response(' '.repeat(65537),{headers:{'content-type':'application/json'}})}),code('RESPONSE_LIMIT'));
});

test('P5 model list count limit and body byte limit are inclusive',async()=>{
  const make=(n:number)=>new Response(JSON.stringify({data:Array.from({length:n},(_,i)=>({id:`model-${i}`}))}),{headers:{'content-type':'application/json'}});
  assert.equal((await listCloudModelsV1('kimi',{apiKey,fetchImpl:async()=>make(512)})).length,512);
  await assert.rejects(listCloudModelsV1('kimi',{apiKey,fetchImpl:async()=>make(513)}),code('RESPONSE_LIMIT'));
  const json=JSON.stringify({data:[{id:'kimi-k3'}]});
  assert.deepEqual(await listCloudModelsV1('kimi',{apiKey,fetchImpl:async()=>new Response(json+' '.repeat(65536-json.length),{headers:{'content-type':'application/json'}})}),['kimi-k3']);
});

test('P5 rejects an unexpected redirected response even if injected fetch returns one',async()=>{
  const value=response();Object.defineProperty(value,'redirected',{value:true});
  await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>assert.fail('redirect delivery'),fetchImpl:async()=>value}),code('PROTOCOL_ERROR'));
});

test('P5 public transport rejects malformed whitespace at EOF without reporting success',async()=>{
  for(const tail of [' ','\t','\u00a0','\ufeff'])for(const ending of ['','\n'])for(const split of [false,true]){
    const body=new ReadableStream<Uint8Array>({start(c){if(split){c.enqueue(wire(valid));for(const byte of wire(tail+ending))c.enqueue(new Uint8Array([byte]));}else c.enqueue(wire(valid+tail+ending));c.close();}});
    await assert.rejects(performCloudChatV1(input,{apiKey,onText:()=>{},fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})}),code('PROTOCOL_ERROR'));
  }
});
