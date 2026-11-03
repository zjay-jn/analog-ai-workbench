import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createOpenCodePilotClient,OpenCodePilotError,nativeFailureOf} from '../apps/desktop/src/main/engine-pilot/opencode-client';
import {parseNativeEngineFailure,type NativeEngineFailure} from '../apps/desktop/src/shared/agent/native-engine-failure';

const directory='C:/work/analog_ai_workbench/.local/agent-engine-pilot/conversations/cwd',sessionID='ses_failure_synthetic';
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const fallback={origin:'native_adapter',stage:'engine_start',reason:'unknown'} as const;

test('native failure diagnostic accepts enum evidence only and never invokes arbitrary getters',()=>{
  const valid={origin:'native_client',stage:'message_read',reason:'timeout'} as const;
  assert.deepEqual(parseNativeEngineFailure(valid),valid);assert(Object.isFrozen(parseNativeEngineFailure(valid)));
  let invoked=0;const accessor={origin:'native_client',stage:'message_read',get reason(){invoked++;return 'timeout';}};
  for(const value of [null,[],{...valid,body:'private body'},{...valid,stage:'C:/private/file'},{...valid,reason:'sk-private'},{...valid,origin:'native_adapter'},Object.create(valid),accessor])assert.equal(parseNativeEngineFailure(value),null);
  const arbitraryError={get nativeFailure(){invoked++;throw new Error('private');},get message(){invoked++;throw new Error('private');}};
  assert.deepEqual(nativeFailureOf(arbitraryError,fallback),fallback);assert.equal(invoked,0);
  assert.deepEqual(nativeFailureOf(new Proxy({}, {getPrototypeOf(){throw new Error('private');}}),fallback),fallback);
  const trusted=new OpenCodePilotError(valid);assert.deepEqual(nativeFailureOf(trusted,fallback),valid);
  assert(!JSON.stringify(trusted).includes(directory));assert.equal(trusted.message,'OpenCode pilot unavailable');
});

test('native request diagnostics distinguish transport, HTTP and malformed successful payload without retaining bodies',async()=>{
  for(const mode of ['transport','http','payload'] as const){
    let calls=0;const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>{
      if(url.endsWith('/session/'+sessionID))return json({id:sessionID,directory});calls++;
      if(mode==='transport')throw new Error('C:/private/file sk-private-response');
      return new Response('private body sk-private-response',{status:mode==='http'?503:200,headers:{'content-type':'application/json'}});
    }});
    try{await client.openSession(sessionID);await assert.rejects(client.messages(sessionID),error=>{
      assert(error instanceof OpenCodePilotError);assert.deepEqual(error.nativeFailure,{origin:'native_client',stage:'message_read',reason:mode==='transport'?'transport':mode==='http'?'http_status':'response_format'});
      assert(!JSON.stringify(error).includes('private'));return true;
    });assert.equal(calls,1,'diagnostics must not retry a native request');}finally{client.dispose();}
  }
});

test('native request timeout retains its own enum cause rather than an abort transport exception',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let calls=0;
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async(url,init)=>{
    if(url.endsWith('/session/'+sessionID))return json({id:sessionID,directory});calls++;
    return new Promise((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(new Error('private abort detail')),{once:true}));
  }});
  try{await client.openSession(sessionID);const pending=client.questions(sessionID);const rejected=assert.rejects(pending,error=>{assert(error instanceof OpenCodePilotError);assert.deepEqual(error.nativeFailure,{origin:'native_client',stage:'question_read',reason:'timeout'});return true;});t.mock.timers.tick(10000);await rejected;assert.equal(calls,1);}finally{client.dispose();}
});

test('native event EOF and invalid JSON retain distinct first causes without exposing a response',async()=>{
  for(const mode of ['eof','json'] as const){
    let writer!:ReadableStreamDefaultController<Uint8Array>;const received:unknown[]=[];
    const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>url.endsWith('/event')?new Response(new ReadableStream<Uint8Array>({start(controller){writer=controller;controller.enqueue(Buffer.from('data: {"type":"server.connected"}\n\n'));}}),{headers:{'content-type':'text/event-stream'}}):json({id:sessionID,directory})});
    try{await client.openSession(sessionID);const watch=await client.watchSessionErrors(sessionID,error=>received.push(error),new AbortController().signal);
      if(mode==='eof')writer.close();else writer.enqueue(Buffer.from('data: private-path C:/secret sk-private\n\n'));
      await setImmediate();assert.equal(received.length,1);const error=received[0];assert(error instanceof OpenCodePilotError);
      const expected:NativeEngineFailure={origin:'native_client',stage:mode==='eof'?'event_connect':'event_decode',reason:mode==='eof'?'stream_closed':'response_format'};
      assert.deepEqual(error.nativeFailure,expected);assert(!JSON.stringify(error).includes('private'));await watch.close();assert.equal(received.length,1);
    }finally{client.dispose();}
  }
});
