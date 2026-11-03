import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createOpenCodePilotClient,OpenCodePilotError} from '../apps/desktop/src/main/engine-pilot/opencode-client';
const directory='C:/work/analog_ai_workbench/.local/agent-engine-pilot/conversations/cwd',sessionID='ses_synthetic_client';
const json=(value:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json',...headers}});

test('native history pagination keeps chronological order above four MiB without a lifetime byte cap',async()=>{
  const calls:string[]=[],text='x'.repeat(1250000);
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET');calls.push(url);
    if(url.endsWith('/session/'+sessionID))return json({id:sessionID,directory});
    if(url.includes('before='))return json([{id:1,text},{id:2,text}]);
    return json([{id:3,text},{id:4,text}],{'x-next-cursor':'c3ludGhldGlj'});
  }});
  await client.openSession(sessionID);const result=await client.messages(sessionID) as {id:number;text:string}[];
  assert.deepEqual(result.map(r=>r.id),[1,2,3,4]);assert(Buffer.byteLength(JSON.stringify(result))>4*1024*1024);assert.equal(calls.length,3);client.dispose();
});

test('missing mapped session and mismatched native directory never fall back to create',async()=>{
  for(const status of [404,200]){
    const calls:string[]=[];const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async(url,init)=>{calls.push(init.method+' '+url);return status===404?new Response('{}',{status,headers:{'content-type':'application/json'}}):json({id:sessionID,directory:directory+'/other'});}});
    await assert.rejects(client.openSession(sessionID));assert.equal(calls.length,1);assert(calls[0]!.startsWith('GET '));client.dispose();
  }
});

test('official noReply migration and current prompt carry the same exact image file shape',async()=>{
  const calls:{url:string;body:Record<string,unknown>}[]=[],image='data:image/jpeg;base64,/9j/2Q==';
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async(url,init)=>{
    if(init.method==='GET')return json({id:sessionID,directory});
    const body=JSON.parse(String(init.body)) as Record<string,unknown>;calls.push({url,body});
    return url.endsWith('/prompt_async')?new Response(null,{status:204}):json({info:{sessionID,role:'user'},parts:body.parts});
  }});
  await client.openSession(sessionID);const model={provider:'kimi',model:'kimi-k3'} as const;
  await client.seed(sessionID,'historical reference',model,[image]);await client.prompt(sessionID,{rules:'synthetic',goal:'current',constraint:'',initialUserText:'current',model,imageUrls:[image]});
  assert.equal(calls[0]!.body.noReply,true);assert.equal(calls[1]!.body.noReply,undefined);
  for(const call of calls)assert.deepEqual((call.body.parts as unknown[])[1],{type:'file',mime:'image/jpeg',url:image});
  client.dispose();
});

test('repeated native pagination cursor fails instead of looping over old history',async()=>{
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async(url)=>url.endsWith('/session/'+sessionID)?json({id:sessionID,directory}):json([{id:'same'}],{'x-next-cursor':'c3ludGhldGlj'})});
  await client.openSession(sessionID);await assert.rejects(client.messages(sessionID));client.dispose();
});

test('native idle is read from the owned session status, including compaction and retry activity',async()=>{
  let status:unknown={};const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>url.endsWith('/status')?json(status):json({id:sessionID,directory})});
  await client.openSession(sessionID);assert.equal(await client.isIdle(sessionID),true);
  for(const type of ['busy','retry']){status={[sessionID]:{type}};assert.equal(await client.isIdle(sessionID),false);}
  status={[sessionID]:{type:'unexpected'}};await assert.rejects(client.isIdle(sessionID));client.dispose();
});

test('native error observation waits for connected, handles fragmented SSE, and ignores foreign sessions',async()=>{
  let writer!:ReadableStreamDefaultController<Uint8Array>,errors=0,ready=false,cancelled=0;const delivered:unknown[]=[];
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>url.endsWith('/event')?new Response(new ReadableStream<Uint8Array>({start(value){writer=value;},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}}):json({id:sessionID,directory})});
  await client.openSession(sessionID);const opening=client.watchSessionErrors(sessionID,error=>{errors++;delivered.push(error);},new AbortController().signal).then(value=>{ready=true;return value;});await setImmediate();assert.equal(ready,false);
  const send=(value:unknown)=>{const bytes=Buffer.from('event: message\r\ndata: '+JSON.stringify(value)+'\r\n\r\n');for(const byte of bytes)writer.enqueue(Uint8Array.of(byte));};
  send({type:'server.connected',properties:{}});const watch=await opening;
  send({type:'session.error',properties:{sessionID:'ses_foreign',error:{message:'private foreign detail'}}});await setImmediate();assert.equal(errors,0);
  send({type:'session.error',properties:{sessionID,error:{message:'合成私密内容 sk-private-never-forward'}}});await setImmediate();assert.equal(errors,1);assert(delivered[0] instanceof OpenCodePilotError);assert.deepEqual(delivered[0].nativeFailure,{origin:'native_client',stage:'event_message',reason:'native_session_error'});assert(!JSON.stringify(delivered).includes('sk-private'));
  await watch.close();assert.equal(cancelled,1);client.dispose();
  const timeoutBody='{"error":{"message":"Upstream request timed out"}}';
  for(const body of [timeoutBody,'{"error":{"message":"Upstream request timed out","private":"sk-do-not-forward"}}']){
    let stream!:ReadableStreamDefaultController<Uint8Array>,received:unknown='not-delivered';
    const source=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>url.endsWith('/event')?new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;controller.enqueue(Buffer.from('data: {"type":"server.connected","properties":{}}\n\n'));}}),{headers:{'content-type':'text/event-stream'}}):json({id:sessionID,directory})});
    await source.openSession(sessionID);const subscription=await source.watchSessionErrors(sessionID,error=>{received=error;},new AbortController().signal);
    stream.enqueue(Buffer.from('data: '+JSON.stringify({type:'session.error',properties:{sessionID,error:{name:'APIError',message:'private native message',data:{statusCode:504,responseBody:body,private:'sk-also-do-not-forward'}}}})+'\n\n'));
    await setImmediate();if(body===timeoutBody)assert.deepEqual(received,{name:'APIError',data:{statusCode:504,responseBody:timeoutBody}});else{assert(received instanceof OpenCodePilotError);assert.deepEqual(received.nativeFailure,{origin:'native_client',stage:'event_message',reason:'native_session_error'});assert(!JSON.stringify(received).includes('sk-do-not-forward'));}
    await subscription.close();source.dispose();
  }
});

test('aborted native error subscription cancels its reader before handshake without a timer',async()=>{
  let cancelled=0;const signal=new AbortController();
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>url.endsWith('/event')?new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}}):json({id:sessionID,directory})});
  await client.openSession(sessionID);const opening=client.watchSessionErrors(sessionID,()=>assert.fail('cancel is not a native error'),signal.signal);await setImmediate();signal.abort();await assert.rejects(opening,/OpenCode pilot unavailable/u);assert.equal(cancelled,1);client.dispose();
});
