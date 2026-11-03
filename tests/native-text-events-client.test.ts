import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createOpenCodePilotClient,OpenCodePilotError} from '../apps/desktop/src/main/engine-pilot/opencode-client';

const directory='C:/work/analog_ai_workbench/.local/agent-engine-pilot/conversations/cwd';
const sessionID='ses_synthetic_text',messageId='msg_synthetic_text',partId='prt_synthetic_text';
const model={provider:'kimi',model:'kimi-k3'} as const;
const message=(info:Record<string,unknown>={})=>({type:'message.updated',properties:{sessionID,info:{id:messageId,sessionID,role:'assistant',agent:'pilot',providerID:'workbench',modelID:model.model,parentID:'msg_synthetic_user',...info}}});
const part=(value:Record<string,unknown>={})=>({type:'message.part.updated',properties:{sessionID,time:2,part:{id:partId,messageID:messageId,sessionID,type:'text',text:'',time:{start:2},...value}}});
const delta=(text:string,value:Record<string,unknown>={})=>({type:'message.part.delta',properties:{sessionID,messageID:messageId,partID:partId,field:'text',delta:text,...value}});

async function fixture(){
  let writer!:ReadableStreamDefaultController<Uint8Array>,cancelled=0,ready=false;
  const seen:Array<{messageId:string;partId:string;text:string}>=[],errors:unknown[]=[],abort=new AbortController();
  const client=createOpenCodePilotClient({port:43210,password:'a'.repeat(64),directory,profile:'work-cycle',conversation:true,fetchImpl:async url=>{
    if(url.endsWith('/event'))return new Response(new ReadableStream<Uint8Array>({start(controller){writer=controller;},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});
    return new Response(JSON.stringify({id:sessionID,directory}),{headers:{'content-type':'application/json'}});
  }});
  await client.openSession(sessionID);
  const opening=client.watchSessionErrors(sessionID,error=>errors.push(error),abort.signal,{model,onText:value=>seen.push(value)}).then(watch=>{ready=true;return watch;});
  // Observe rejections immediately even in the intentionally invalid pre-handshake case.
  void opening.catch(()=>{});await setImmediate();
  const send=(value:unknown,fragmented=false)=>{const bytes=Buffer.from('event: message\r\ndata: '+JSON.stringify(value)+'\r\n\r\n');if(fragmented)for(const byte of bytes)writer.enqueue(Uint8Array.of(byte));else writer.enqueue(bytes);};
  return {seen,errors,abort,opening,send,ready:()=>ready,cancelled:()=>cancelled,
    async connect(){send({type:'server.connected',properties:{}});return opening;},
    async close(){abort.abort();const watch=await opening.catch(()=>undefined);await watch?.close();client.dispose();},
  };
}

test('native text events wait for handshake and publish cumulative fragmented UTF-8 before final part update',async()=>{
  const f=await fixture();
  try{
    assert.equal(f.ready(),false);await f.connect();assert.equal(f.ready(),true);
    f.send(message());f.send(part());f.send(delta('逐字'),true);await setImmediate();
    assert.deepEqual(f.seen,[{messageId,partId,text:'逐字'}]);
    f.send(delta('回复🌲'),true);await setImmediate();assert.equal(f.seen.at(-1)!.text,'逐字回复🌲');
    const count=f.seen.length;f.send(part({text:'逐字回复🌲',time:{start:2,end:3}}));f.send(part({text:'逐字回复🌲',time:{start:2,end:3}}));await setImmediate();
    assert.equal(f.seen.length,count,'final persisted snapshots must not duplicate streamed text');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('native text events ignore foreign, user, summary, reasoning, ignored and synthetic text',async()=>{
  const f=await fixture();
  try{
    await f.connect();
    f.send({type:'message.updated',properties:{sessionID:'ses_foreign',info:{id:'foreign',role:'assistant',providerID:'forged'}}});
    f.send(delta('foreign',{sessionID:'ses_foreign',messageID:'foreign',partID:'foreign'}));
    for(const [index,kind] of ['user','summary','reasoning','ignored','synthetic'].entries()){
      const id='msg_filtered_'+index,pid='prt_filtered_'+index;
      f.send(message({id,...(kind==='user'?{role:'user'}:kind==='summary'?{summary:true}:{})}));
      f.send(part({id:pid,messageID:id,...(kind==='reasoning'?{type:'reasoning'}:kind==='ignored'?{ignored:true}:kind==='synthetic'?{synthetic:true}:{})}));
      f.send(delta('private filtered text',{messageID:id,partID:pid}));
    }
    f.send(message());f.send(part());f.send(delta('visible'));await setImmediate();
    assert.deepEqual(f.seen,[{messageId,partId,text:'visible'}]);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('native text events reject forged assistant model, provider, agent or parent identity',async()=>{
  for(const identity of [{agent:'other'},{providerID:'foreign'},{modelID:'wrong-model'},{parentID:''}]){
    const f=await fixture();try{await f.connect();f.send(message(identity));await setImmediate();assert.equal(f.errors.length,1);assert(f.errors[0] instanceof OpenCodePilotError);assert.equal(f.errors[0].nativeFailure?.stage,'event_message');assert.deepEqual(f.seen,[]);}finally{await f.close();}
  }
});

test('native text events reject unknown parts, crossed message ownership and extra delta fields',async()=>{
  for(const mode of ['unknown','crossed','extra']){
    const f=await fixture();try{
      await f.connect();f.send(message());if(mode!=='unknown')f.send(part());
      f.send(delta('must not display',mode==='crossed'?{messageID:'msg_other'}:mode==='extra'?{raw:'private'}:{}));await setImmediate();
      assert.equal(f.errors.length,1);assert(f.errors[0] instanceof OpenCodePilotError);assert.equal(f.errors[0].nativeFailure?.stage,'event_text');assert.deepEqual(f.seen,[]);
    }finally{await f.close();}
  }
});

test('native text events reject final text rewrites while retaining the previously published prefix',async()=>{
  const f=await fixture();try{
    await f.connect();f.send(message());f.send(part());f.send(delta('already visible'));await setImmediate();
    f.send(part({text:'rewritten answer',time:{start:2,end:3}}));await setImmediate();
    assert.deepEqual(f.seen,[{messageId,partId,text:'already visible'}]);assert.equal(f.errors.length,1);assert(f.errors[0] instanceof OpenCodePilotError);assert.deepEqual(f.errors[0].nativeFailure,{origin:'native_client',stage:'event_text',reason:'text_regression'});
  }finally{await f.close();}
});

test('native text events reject deltas after a final part update and never emit the late suffix',async()=>{
  const f=await fixture();try{
    await f.connect();f.send(message());f.send(part({text:'complete',time:{start:2,end:3}}));await setImmediate();
    f.send(delta(' late'));await setImmediate();assert.deepEqual(f.seen,[{messageId,partId,text:'complete'}]);assert.equal(f.errors.length,1);assert(f.errors[0] instanceof OpenCodePilotError);assert.deepEqual(f.errors[0].nativeFailure,{origin:'native_client',stage:'event_text',reason:'text_after_end'});
  }finally{await f.close();}
});

test('native text events reject owned text before connected without delivering text or a post-handshake error',async()=>{
  const f=await fixture();try{
    f.send(message());await assert.rejects(f.opening,/OpenCode pilot unavailable/u);assert.deepEqual(f.seen,[]);assert.deepEqual(f.errors,[]);assert.equal(f.cancelled(),1);
  }finally{await f.close();}
});

test('native text close and abort suppress already queued late deltas and cancel the event reader',async()=>{
  for(const mode of ['close','abort']){
    const f=await fixture();try{
      const watch=await f.connect();f.send(message());f.send(part());f.send(delta('accepted'));await setImmediate();
      f.send(delta(' late'));if(mode==='close')await watch.close();else{f.abort.abort();await setImmediate();}
      assert.deepEqual(f.seen,[{messageId,partId,text:'accepted'}]);assert.deepEqual(f.errors,[]);assert.equal(f.cancelled(),1);
    }finally{await f.close();}
  }
});
