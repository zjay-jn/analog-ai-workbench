import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveProviderServices, type LiveProviderServices, type LiveProviderOptions } from '../apps/desktop/src/main/engine-live/provider-gateway';
import { LIVE_ENDPOINT, LIVE_MODEL, LIVE_LIMITS, liveUserText, liveTools, liveQuestionResult, parseLiveQuestionArguments, parseLiveSse, type LiveCompletion } from '../apps/desktop/src/main/engine-live/protocol';
import { executePilotSum } from '../apps/desktop/src/main/engine-pilot/tool';

const runId='pilot.12345678-1234-4234-8234-123456789abc',goal='请先问我需要相加的整数，再使用工具计算。',constraint='不要猜测缺失数据。';
const model='deepseek-v4.1-flash';
const chunk=(delta:unknown,finish_reason:string|null=null,extra:object={})=>`data: ${JSON.stringify({id:'chatcmpl_live_1',object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta,finish_reason}],...extra})}\n\n`;
const callSse=(id:string,name:string,args:unknown,extra:object={})=>{const serialized=JSON.stringify(args),split=Math.floor(serialized.length/2);return chunk({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:serialized.slice(0,split)}}]})+chunk({tool_calls:[{index:0,function:{arguments:serialized.slice(split)}}]})+chunk({},'tool_calls',extra)+'data: [DONE]\n\n';};
const finalSse=(text='已通过工具计算。',extra:object={})=>chunk({role:'assistant',content:text})+chunk({},'stop',extra)+'data: [DONE]\n\n';
const response=(wire:string)=>new Response(wire,{headers:{'content-type':'text/event-stream'}});
const question=(prompt:string)=>({questions:[{question:prompt,header:'澄清',options:[],multiple:false}]});
const base=()=>[{role:'system',content:'Native private path C:/do-not-upload/secret and internal rules'},{role:'user',content:liveUserText(goal,constraint)}];
const request=(messages:unknown[]=base())=>({model:LIVE_MODEL.model,stream:true,messages,tools:liveTools(),max_tokens:2048,stream_options:{include_usage:true}});
const post=(service:LiveProviderServices,value:unknown,tool=false,path=tool?'/tool':'/v1/chat/completions')=>fetch(`http://127.0.0.1:${service.port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${tool?service.toolToken:service.providerToken}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
const defaults=(fetchImpl:LiveProviderOptions['fetchImpl'],extra:Partial<LiveProviderOptions>={}):LiveProviderOptions=>({fetchImpl,getRunCredentials:()=>({apiKey:'synthetic-main-key',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:5000}),onResponse:()=>{},...extra});
const begin=(service:LiveProviderServices,onTool:Parameters<LiveProviderServices['begin']>[0]['onTool']=async call=>executePilotSum(call.arguments),onFailure=()=>{})=>{const run=service.begin({runId,goal,constraint,onTool,onFailure});run.bindSession('ses_live');return run;};
const assistant=(value:LiveCompletion)=>({role:'assistant',content:value.text||null,...(value.calls.length?{tool_calls:value.calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}: {})});
async function completion(service:LiveProviderServices,messages:unknown[]=base()){const result=await post(service,request(messages));assert.equal(result.status,200);return parseLiveSse(await result.text());}

test('live protocol validates fragmented tool calls and both final usage layouts',()=>{
  const args={values:[3,-1]},native=callSse('call_any_1','pilot_sum',args,{usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}}),parsed=parseLiveSse(native);
  assert.deepEqual(parsed.calls[0]?.arguments,args);assert.equal(parsed.responseModel,model);assert.deepEqual(parsed.usage,{inputTokens:11,outputTokens:7});
  const withoutDone=finalSse('done').replace('data: [DONE]\n\n','');
  const usageOnly=`data: ${JSON.stringify({id:'chatcmpl_live_1',model,choices:[],usage:{prompt_tokens:21,completion_tokens:3,total_tokens:24}})}\n\n`;
  assert.deepEqual(parseLiveSse(withoutDone+usageOnly+'data: [DONE]\n\n').usage,{inputTokens:21,outputTokens:3});
  assert.equal(parseLiveSse(finalSse()).usage,null);
  for(const bad of [native.replace('data: [DONE]\n\n',''),native+chunk({content:'tail'}),native.replace('"tool_calls"}', '"length"}'),chunk({reasoning_content:'unexpected thinking'})+finalSse(),chunk({tool_calls:[{index:0,id:'x',type:'function',function:{name:'shell',arguments:'{}'}}]},'tool_calls')+'data: [DONE]\n\n',chunk({content:'x'},'length')+'data: [DONE]\n\n'])assert.throws(()=>parseLiveSse(bad));
  assert.throws(()=>parseLiveSse(callSse('call_bad','pilot_sum',{values:[1],path:'leak'})));
  assert.throws(()=>parseLiveSse(finalSse('x',{usage:{prompt_tokens:1,completion_tokens:2049}}),2048));
});

test('live questions preserve arbitrary free text and normalize only compatible single-question defaults',()=>{
  const parsed=parseLiveQuestionArguments(question('哪个输入缺失？\n请直接回答。'));
  assert.equal(parsed.questions[0].custom,true);assert.equal(parsed.questions[0].multiple,false);assert.equal(Object.isFrozen(parsed.questions[0].options),true);
  assert.equal(liveQuestionResult('何值？','two lines\n第二行'),'User has answered your questions: "何值？"="two lines\n第二行". You can now continue with the user\'s answers in mind.');
  for(const value of [{questions:[]},{questions:[...question('a').questions,...question('b').questions]}, {questions:[{question:'a',header:'h',options:[{label:'x'}]}]}, {questions:[{question:'a',header:'h',options:[],multiple:true}]}, {questions:[{question:'a',header:'h',options:[],custom:false}]}, {questions:[{question:'a',header:'h',options:[],hidden:'x'}]}])assert.throws(()=>parseLiveQuestionArguments(value));
});

test('live gateway owns destination/key/system/schema and binds two sequential free-text questions to exact results',async()=>{
  const outbound:Array<{url:string;init:RequestInit;body:Record<string,unknown>}>=[],observed:unknown[]=[];let toolCalls=0;
  const wires=[callSse('call_first','question',question('第一个整数是多少？')),callSse('call_second','question',question('第二个整数是多少？')),callSse('call_calc','pilot_sum',{values:[4,9]}),finalSse('工具返回 13。',{usage:{prompt_tokens:80,completion_tokens:8}})];
  const service=await createLiveProviderServices(defaults(async(url,init)=>{outbound.push({url,init,body:JSON.parse(String(init.body))});return response(wires.shift()!);},{onResponse:(id,value)=>observed.push({id,...value})}));
  try{const run=begin(service,async call=>{toolCalls++;return executePilotSum(call.arguments);}),messages:unknown[]=base();
    for(const [prompt,answer,id] of [['第一个整数是多少？','4','que_first'],['第二个整数是多少？','9','que_second']]){const value=await completion(service,messages),call=value.calls[0]!;run.question({questionID:id!,messageID:`msg_${id}`,callID:call.id,prompt:prompt!,arguments:question(prompt!)});run.answer(answer!,id!);run.answerDelivery(id!,Promise.resolve());messages.push(assistant(value),{role:'tool',tool_call_id:call.id,content:liveQuestionResult(prompt!,answer!)});}
    const sum=await completion(service,messages),call=sum.calls[0]!,tool={sessionID:'ses_live',messageID:'msg_sum',callID:call.id,toolName:'pilot_sum',arguments:{values:[4,9]}};
    const first=await post(service,tool,true),replay=await post(service,tool,true);assert.equal(first.status,200);assert.equal(replay.status,200);const result=await first.json();assert.deepEqual(await replay.json(),result);assert.equal(toolCalls,1);
    messages.push(assistant(sum),{role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});await completion(service,messages);
    assert.equal(run.evidence().complete,true);assert.equal(outbound.length,4);assert.deepEqual(observed.map(v=>(v as {request:number}).request),[1,2,3,4]);
    for(const sent of outbound){assert.equal(sent.url,LIVE_ENDPOINT);assert.equal(sent.init.redirect,'error');assert.equal(new Headers(sent.init.headers).get('Authorization'),'Bearer synthetic-main-key');assert.deepEqual(sent.body.thinking,{type:'disabled'});assert.equal(sent.body.model,LIVE_MODEL.model);assert.equal(JSON.stringify(sent.body).includes('do-not-upload'),false);assert.equal(JSON.stringify(sent.body).includes('synthetic-main-key'),false);assert.deepEqual(sent.body.tools,liveTools());}
    assert.equal(service.traffic().totalHttpRequests,4);assert.equal(service.traffic().totalProviderAttempts,4);assert.equal(service.traffic().totalToolAttempts,2);
  }finally{await service.close();}
});

test('live gateway cannot release parseable tool arguments before complete validated response',async()=>{
  let writer:ReadableStreamDefaultController<Uint8Array>|undefined,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});const encoder=new TextEncoder();let executions=0,notices=0;
  const service=await createLiveProviderServices(defaults(async()=>{const stream=new ReadableStream<Uint8Array>({start(controller){writer=controller;controller.enqueue(encoder.encode(chunk({tool_calls:[{index:0,id:'call_late',type:'function',function:{name:'pilot_sum',arguments:'{"values":[2,5]}'}}]})));}});entered();return new Response(stream,{headers:{'content-type':'text/event-stream'}});},{onResponse:()=>{notices++;}}));
  try{const run=begin(service,async call=>{executions++;return executePilotSum(call.arguments);}),pending=post(service,request());await enteredPromise;
    assert.deepEqual(run.evidence().issued,[]);assert.equal(notices,0);assert.equal(executions,0);
    writer!.enqueue(encoder.encode(chunk({},'tool_calls')+'data: [DONE]\n\n'));writer!.close();const result=await pending;assert.equal(result.status,200);await result.text();assert.deepEqual(run.evidence().issued,['call_late']);assert.equal(notices,1);
    const tool=await post(service,{sessionID:'ses_live',messageID:'msg_late',callID:'call_late',toolName:'pilot_sum',arguments:{values:[2,5]}},true);assert.equal(tool.status,200);assert.equal(executions,1);
  }finally{await service.close();}
});

test('live gateway truncated or changed tail never grants a tool ticket or model response',async()=>{
  for(const wire of [callSse('call_truncated','pilot_sum',{values:[1]}).replace('data: [DONE]\n\n',''),callSse('call_changed','pilot_sum',{values:[1]}).replace('data: [DONE]\n\n',chunk({tool_calls:[{index:0,function:{arguments:'{"values":[100]}'}}]})+'data: [DONE]\n\n')]){
    let events=0,tools=0;const service=await createLiveProviderServices(defaults(async()=>response(wire),{onResponse:()=>{events++;}}));
    try{const run=begin(service,async call=>{tools++;return executePilotSum(call.arguments);});const result=await post(service,request());assert.equal(result.status,400);assert.deepEqual(run.evidence().issued,[]);assert.equal(events,0);assert.equal(tools,0);assert.equal(service.traffic().totalHttpRequests,1);}finally{await service.close();}
  }
});

test('live gateway rejects changed transcript, invented results and unbound tool identities before another fetch',async()=>{
  for(const mode of ['changed_result','changed_text','foreign_tool','rebound_question']){
    let fetches=0,executions=0;const service=await createLiveProviderServices(defaults(async()=>{fetches++;return response(mode==='rebound_question'?callSse('call_q','question',question('说明？')):callSse('call_sum','pilot_sum',{values:[5]}));}));
    try{const run=begin(service,async call=>{executions++;return executePilotSum(call.arguments);}),value=await completion(service);
      if(mode==='rebound_question'){run.question({questionID:'que_1',messageID:'msg_q',callID:'call_q',prompt:'说明？',arguments:question('说明？')});assert.throws(()=>run.question({questionID:'que_2',messageID:'msg_q',callID:'call_q',prompt:'说明？',arguments:question('说明？')}));}
      else if(mode==='foreign_tool'){const tool=await post(service,{sessionID:'ses_foreign',messageID:'msg_sum',callID:'call_sum',toolName:'pilot_sum',arguments:{values:[5]}},true);assert.equal(tool.status,400);assert.equal(executions,0);}
      else {const tool=await post(service,{sessionID:'ses_live',messageID:'msg_sum',callID:'call_sum',toolName:'pilot_sum',arguments:{values:[5]}},true);assert.equal(tool.status,200);const data=await tool.json(),message=assistant(value);if(mode==='changed_text')message.content='invented assistant text';if(mode==='changed_result')data.sum=6;const result=await post(service,request([...base(),message,{role:'tool',tool_call_id:'call_sum',content:JSON.stringify(data)}]));assert.equal(result.status,400);}
      assert.equal(fetches,1);assert.equal(run.evidence().complete,false);
    }finally{await service.close();}
  }
});

test('live gateway counts authenticated auxiliary/invalid routes and retries but never grants extra HTTP budget',async()=>{
  let fetches=0;const service=await createLiveProviderServices(defaults(async()=>{fetches++;return response(callSse('call_one','pilot_sum',{values:[1]}));},{getRunCredentials:()=>({apiKey:'synthetic',maxRequests:1,maxOutputTokens:2048,requestTimeoutMs:5000})}));
  try{begin(service);await completion(service);const retry=await post(service,request());assert.equal(retry.status,429);assert.equal(fetches,1);assert.equal(service.traffic().totalProviderAttempts,2);assert.equal(service.traffic().totalHttpRequests,1);}finally{await service.close();}
  const route=await createLiveProviderServices(defaults(async()=>{throw Error('must not dispatch');}));
  try{begin(route);const rejected=await post(route,{},false,'/models');assert.equal(rejected.status,403);assert.equal(route.traffic().totalProviderAttempts,1);assert.equal(route.traffic().totalHttpRequests,0);assert.ok(route.traffic().entries.some(e=>e.reason==='route'));}finally{await route.close();}
  const unbound=await createLiveProviderServices(defaults(async()=>{throw Error('must not dispatch');}));
  try{assert.equal((await post(unbound,request())).status,409);assert.equal(unbound.traffic().unboundProviderAttempts,1);assert.equal(unbound.traffic().totalHttpRequests,0);assert.throws(()=>begin(unbound));}finally{await unbound.close();}
});

test('live gateway times out even an injected transport ignoring AbortSignal and never retries',async()=>{
  let fetches=0,failed=0;const service=await createLiveProviderServices(defaults(async()=>{fetches++;return new Promise<Response>(()=>{});},{getRunCredentials:()=>({apiKey:'synthetic',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:25})}));
  try{begin(service,undefined,()=>{failed++;});const result=await post(service,request());assert.equal(result.status,400);assert.equal(fetches,1);assert.equal(failed,1);assert.equal(service.traffic().totalHttpRequests,1);}finally{await service.close();}
});

test('live end cancels in-flight transport and a late valid response cannot issue tools or response events',async()=>{
  let resolveFetch!:(value:Response)=>void,entered!:()=>void,notices=0,cancelled=false,signal:AbortSignal|undefined;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
  const service=await createLiveProviderServices(defaults(async(_url,init)=>{signal=init.signal!;entered();return new Promise<Response>(resolve=>{resolveFetch=resolve;});},{onResponse:()=>{notices++;}}));
  try{begin(service);const pending=post(service,request());await enteredPromise;service.end(runId);assert.equal(signal?.aborted,true);resolveFetch(new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(callSse('call_late','pilot_sum',{values:[1]})));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));assert.equal((await pending).status,400);assert.equal(notices,0);assert.equal(cancelled,true);assert.deepEqual(service.evidence(runId)?.issued,[]);}finally{await service.close();}
});

test('live gateway rejects unsupported inputs and missing injection without external fallback',async()=>{
  assert.equal(LIVE_LIMITS.requests,8);assert.equal(LIVE_LIMITS.outputTokens,16384);
  await assert.rejects(createLiveProviderServices({getRunCredentials:()=>({apiKey:'unused',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:5000}),onResponse:()=>{}} as unknown as LiveProviderOptions));
  for(const change of [{model:'kimi-k3'},{thinking:{type:'enabled'}},{max_tokens:16385},{tool_choice:{type:'function',function:{name:'pilot_sum'}}},{messages:[{role:'user',content:'not the frozen goal'}]},{tools:[...liveTools(),{type:'function',function:{name:'shell',parameters:{}}}]}]){
    let fetches=0;const service=await createLiveProviderServices(defaults(async()=>{fetches++;return response(finalSse());}));
    try{begin(service);assert.equal((await post(service,{...request(),...change})).status,400);assert.equal(fetches,0);assert.equal(service.traffic().totalProviderAttempts,1);}finally{await service.close();}
  }
});

test('live gateway rejects wrong final URL, cancels unread errors, and never releases echoed credentials',async()=>{
  for(const mode of ['url','status','key','escaped_key']){
    let cancelled=false,events=0;const service=await createLiveProviderServices(defaults(async()=>{
      if(mode==='key')return response(finalSse('synthetic-main-key'));
      if(mode==='escaped_key')return response(finalSse('synthetic-main-key').replaceAll('synthetic-main-key','\\u0073ynthetic-main-key'));
      const value=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{status:mode==='status'?401:200,headers:{'content-type':'text/event-stream'}});if(mode==='url')Object.defineProperty(value,'url',{value:'https://other.example/chat/completions'});return value;
    },{onResponse:()=>{events++;}}));
    try{begin(service);const result=await post(service,request());assert.equal(result.status,400);assert.equal((await result.text()).includes('synthetic-main-key'),false);assert.equal(events,0);if(mode==='url'||mode==='status')assert.equal(cancelled,true);}finally{await service.close();}
  }
});

test('live timing first byte excludes headers and empty chunks and bounds an abort-ignoring fetch',async()=>{
  for(const mode of ['fetch','headers','empty']){
    let fetches=0,cancelled=false;const service=await createLiveProviderServices(defaults(async()=>{
      fetches++;if(mode==='fetch')return new Promise<Response>(()=>{});
      return new Response(new ReadableStream<Uint8Array>({start(controller){if(mode==='empty')controller.enqueue(new Uint8Array(0));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
    },{timeouts:{firstByteTimeoutMs:30,idleTimeoutMs:100},getRunCredentials:()=>({apiKey:'synthetic',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:3000})}));
    try{const run=begin(service),result=await post(service,request());assert.equal(result.status,400);assert.equal(fetches,1);assert.equal(run.evidence().responses,0);assert.ok(service.traffic().entries.some(e=>e.reason==='first_byte_timeout'));if(mode!=='fetch')assert.equal(cancelled,true);}finally{await service.close();}
  }
});

test('live timing idle ignores empty chunks and releases a reader even when read and cancel ignore abort',async()=>{
  for(const mode of ['empty','ignoring_reader']){
    let interval:ReturnType<typeof setInterval>|undefined,cancelled=0,released=false;
    const service=await createLiveProviderServices(defaults(async()=>{
      const value=new Response(new ReadableStream<Uint8Array>({start(controller){if(mode==='empty'){controller.enqueue(new TextEncoder().encode(': body started\n\n'));interval=setInterval(()=>controller.enqueue(new Uint8Array(0)),10);}},cancel(){cancelled++;if(interval)clearInterval(interval);}}),{headers:{'content-type':'text/event-stream'}});
      if(mode==='ignoring_reader'){let reads=0;Object.defineProperty(value.body!,'getReader',{value:()=>({read:()=>reads++===0?Promise.resolve({done:false,value:new TextEncoder().encode(': body started\n\n')}):new Promise(()=>{}),cancel:()=>{cancelled++;return new Promise(()=>{});},releaseLock:()=>{released=true;}})});}
      return value;
    },{timeouts:{firstByteTimeoutMs:300,idleTimeoutMs:40},getRunCredentials:()=>({apiKey:'synthetic',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:3000})}));
    try{begin(service);assert.equal((await post(service,request())).status,400);assert.ok(service.traffic().entries.some(e=>e.reason==='idle_timeout'));assert.ok(cancelled>=1);if(mode==='ignoring_reader')assert.equal(released,true);}finally{if(interval)clearInterval(interval);await service.close();}
  }
});

test('live timing total deadline never resets while nonempty body progress continues',async()=>{
  let interval:ReturnType<typeof setInterval>|undefined,progress=0;const service=await createLiveProviderServices(defaults(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(': start\n\n'));interval=setInterval(()=>{progress++;controller.enqueue(new TextEncoder().encode(': progressing\n\n'));},20);},cancel(){if(interval)clearInterval(interval);}}),{headers:{'content-type':'text/event-stream'}}),{timeouts:{firstByteTimeoutMs:500,idleTimeoutMs:500},getRunCredentials:()=>({apiKey:'synthetic',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:120})}));
  try{begin(service);assert.equal((await post(service,request())).status,400);assert.ok(progress>0);assert.ok(service.traffic().entries.some(e=>e.reason==='request_timeout'));assert.equal(service.traffic().totalHttpRequests,1);}finally{if(interval)clearInterval(interval);await service.close();}
});

test('live timing nonempty bytes reset idle and retire first byte timer before a valid final response',async()=>{
  let interval:ReturnType<typeof setInterval>|undefined,ticks=0;const service=await createLiveProviderServices(defaults(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(': start\n\n'));interval=setInterval(()=>{if(++ticks===3){clearInterval(interval);controller.enqueue(new TextEncoder().encode(finalSse('Finished after transport progress.')));controller.close();}else controller.enqueue(new TextEncoder().encode(': progress\n\n'));},80);},cancel(){if(interval)clearInterval(interval);}}),{headers:{'content-type':'text/event-stream'}}),{timeouts:{firstByteTimeoutMs:200,idleTimeoutMs:200},getRunCredentials:()=>({apiKey:'synthetic',maxRequests:8,maxOutputTokens:2048,requestTimeoutMs:3000})}));
  try{const run=begin(service);assert.equal((await completion(service)).text,'Finished after transport progress.');assert.equal(run.evidence().complete,true);assert.equal(service.traffic().entries.some(e=>e.reason.endsWith('_timeout')),false);}finally{if(interval)clearInterval(interval);await service.close();}
});

test('live timing and wire ceilings are fixed and injected timing may only be narrowed',async()=>{
  assert.equal(LIVE_LIMITS.requestTimeoutMs,600000);assert.equal(LIVE_LIMITS.firstByteTimeoutMs,120000);assert.equal(LIVE_LIMITS.idleTimeoutMs,60000);assert.equal(LIVE_LIMITS.wireBytes,16*1024*1024);assert.equal(LIVE_LIMITS.contextBytes,65536);assert.equal(LIVE_LIMITS.outputBytes,65536);
  const extraWire=': '+ 'x'.repeat(2*1024*1024)+'\n\n';assert.equal(parseLiveSse(extraWire+finalSse('within16MiB')).text,'within16MiB');assert.throws(()=>parseLiveSse('x'.repeat(LIVE_LIMITS.wireBytes+1)));
  for(const timeouts of [{firstByteTimeoutMs:120001,idleTimeoutMs:60000},{firstByteTimeoutMs:120000,idleTimeoutMs:60001},{firstByteTimeoutMs:0,idleTimeoutMs:1}])await assert.rejects(createLiveProviderServices(defaults(async()=>{throw Error('must not dispatch');},{timeouts})));
  const allowed=await createLiveProviderServices(defaults(async()=>{throw Error('must not dispatch');},{getRunCredentials:()=>({apiKey:'synthetic',maxRequests:8,maxOutputTokens:16384,requestTimeoutMs:600000})}));try{begin(allowed);assert.equal(allowed.traffic().totalHttpRequests,0);}finally{await allowed.close();}
  let cancelled=false;const bounded=await createLiveProviderServices(defaults(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(LIVE_LIMITS.wireBytes+1));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})));
  try{begin(bounded);assert.equal((await post(bounded,request())).status,400);assert.equal(cancelled,true);assert.equal(bounded.traffic().totalHttpRequests,1);assert.ok(bounded.traffic().entries.some(e=>e.reason==='budget'));}finally{await bounded.close();}
});

test('live answer delivery pending acknowledgement gates dispatch and confirmed acknowledgement resumes once',async()=>{
  let acknowledge!:()=>void,waiting!:()=>void,fetches=0;const delivery=new Promise<void>(resolve=>{acknowledge=resolve;}),waitingPromise=new Promise<void>(resolve=>{waiting=resolve;});
  const service=await createLiveProviderServices(defaults(async()=>{fetches++;return response(fetches===1?callSse('call_ack','question',question('整数是多少？')):finalSse('已收到确认。'));},{onTraffic:value=>{if((value as {reason:string}).reason==='answer_pending')waiting();}}));
  try{const run=begin(service),value=await completion(service);run.question({questionID:'que_ack',messageID:'msg_ack',callID:'call_ack',prompt:'整数是多少？',arguments:question('整数是多少？')});run.answer('9','que_ack');run.answerDelivery('que_ack',delivery);
    const pending=post(service,request([...base(),assistant(value),{role:'tool',tool_call_id:'call_ack',content:liveQuestionResult('整数是多少？','9')}]));await waitingPromise;
    assert.equal(service.traffic().totalProviderAttempts,2);assert.equal(service.traffic().totalHttpRequests,1);assert.equal(fetches,1);assert.equal(run.evidence().pendingAnswerDeliveries,1);assert.equal(run.evidence().resolvedCalls,0);
    acknowledge();const result=await pending;assert.equal(result.status,200);assert.equal(parseLiveSse(await result.text()).text,'已收到确认。');assert.equal(fetches,2);assert.equal(run.evidence().pendingAnswerDeliveries,0);assert.equal(run.evidence().resolvedCalls,1);assert.equal(run.evidence().complete,true);
  }finally{await service.close();}
});

test('live answer delivery rejection, missing registration or stop during acknowledgement cannot dispatch continuation',async()=>{
  for(const mode of ['rejected','stopped','unregistered']){
    let acknowledge!:()=>void,rejectDelivery!:(error:Error)=>void,waiting!:()=>void,fetches=0;const delivery=new Promise<void>((resolve,reject)=>{acknowledge=resolve;rejectDelivery=reject;}),waitingPromise=new Promise<void>(resolve=>{waiting=resolve;});
    const service=await createLiveProviderServices(defaults(async()=>{fetches++;return response(callSse('call_uncertain','question',question('请确认整数。')));},{onTraffic:value=>{if((value as {reason:string}).reason==='answer_pending')waiting();}}));
    try{const run=begin(service),value=await completion(service);run.question({questionID:'que_uncertain',messageID:'msg_uncertain',callID:'call_uncertain',prompt:'请确认整数。',arguments:question('请确认整数。')});run.answer('17','que_uncertain');if(mode!=='unregistered')run.answerDelivery('que_uncertain',delivery);
      const pending=post(service,request([...base(),assistant(value),{role:'tool',tool_call_id:'call_uncertain',content:liveQuestionResult('请确认整数。','17')}]));
      if(mode!=='unregistered'){await waitingPromise;assert.equal(fetches,1);if(mode==='rejected')rejectDelivery(new Error('synthetic reply acknowledgement failed'));else {service.end(runId);acknowledge();}}
      assert.equal((await pending).status,400);assert.equal(fetches,1);assert.equal(service.traffic().totalHttpRequests,1);assert.equal(run.evidence().resolvedCalls,0);assert.equal(run.evidence().complete,false);
    }finally{await service.close();}
  }
});
