import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectReadNativeEngine} from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import type {ProjectReadEngineNotice} from '../apps/desktop/src/main/agent-project-read/engine';
import type {ProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import {randomUUID} from 'node:crypto';
import {createNativeConversationStore} from '../apps/desktop/src/main/agent-project-read/native-conversation-store';
import {OpenCodePilotError,type NativeTextSnapshot} from '../apps/desktop/src/main/engine-pilot/opencode-client';
import {splitCloudDeltaV2} from '../apps/desktop/src/main/cloud/cloud-budget';
import {PROJECT_READ_LIMITS,type ProjectReadToolCall} from '../apps/desktop/src/shared/agent/agent-project-read';
import {parseProjectReadEvent} from '../apps/desktop/src/shared/agent/agent-project-read-validation';

function fixture(persistent=false) {
  const sessionID='ses_text_stream',messageID='msg_assistant',model={provider:'kimi',model:'kimi-k3'} as const;
  const events:ProjectReadEngineNotice[]=[],controller=new AbortController();
  let text='第一段',finished=false,error=false,aborts=0,polls=0,submitted=false;
  let onText:((value:NativeTextSnapshot)=>void)|undefined;
  let onTool:Parameters<ProjectReadProviderServices['begin']>[0]['onTool'];
  const order:string[]=[];
  const client={health:async()=>true,createSession:async()=>sessionID,openSession:async()=>sessionID,seed:async()=>{},prompt:async()=>{submitted=true;},isIdle:async()=>finished,
    watchSessionErrors:async(_id:string,_error:(error?:unknown)=>void,_signal:AbortSignal,observer?:{onText:(value:NativeTextSnapshot)=>void})=>{onText=observer?.onText;return {close:async()=>{}};},
    messages:async()=>{polls++;if(persistent&&!submitted)return [];return [
      {info:{id:'msg_user',sessionID,role:'user',time:{created:1}},parts:[{id:'prt_user',sessionID,messageID:'msg_user',type:'text',text:'synthetic streaming test'}]},
      {info:{id:messageID,sessionID,role:'assistant',parentID:'msg_user',agent:'pilot',providerID:'workbench',modelID:model.model,time:{created:2,...(finished?{completed:3}:{})},...(finished?{finish:'stop'}:{}),...(error?{error:{name:'APIError'}}:{})},
       parts:[{id:'prt_text',sessionID,messageID,type:'text',text,time:{start:2,...(finished?{end:3}:{})}}]},
    ];},questions:async()=>[],answer:async()=>{},abort:async()=>{aborts++;},dispose(){}};
  const services:Parameters<typeof createProjectReadNativeEngine>[0]['services']={
    begin:input=>{onTool=input.onTool;return {bindSession(){},bindNativeContext(){},compactions:()=>[],evidence:()=>({complete:finished})} as unknown as ReturnType<ProjectReadProviderServices['begin']>;},end(){},close:async()=>{},
  };
  const conversationId=randomUUID(),engine=createProjectReadNativeEngine({client,services,conversationStore:createNativeConversationStore('C:/work/analog_ai_workbench/.local/font-stream-20261027/unit/'+conversationId)});
  const start=()=>engine.start({runId:'stream_synthetic',model,signal:controller.signal,
    ...(persistent?{nativeConversation:{conversationId}}:{}),
    chatContext:{provider:model.provider,model:model.model,maxOutputTokens:8192,timeoutMs:120000,messages:[{role:'user',content:'synthetic streaming test'}]},
    prompt:{goal:'synthetic',constraint:'',rules:'synthetic only',systemText:'synthetic only',initialUserText:'synthetic streaming test'},
    callbacks:{notice:event=>{events.push(event);if(event.type==='text')order.push(event.text);},tool:async()=>{order.push('TOOL');return {ok:true,value:{kind:'sum',sum:1,count:1,source:'deterministic-local',toolVersion:'pilot.sum.v1'}};},questionDelivered:async()=>{}},
  });
  const wait=async(predicate:()=>boolean)=>{const end=Date.now()+2000;while(!predicate()){assert(Date.now()<end,'Expected streaming projection before completion');await new Promise(resolve=>setTimeout(resolve,10));}};
  return {engine,client,events,controller,start,wait,order,tool:(call:ProjectReadToolCall)=>onTool(call),setText:(next:string)=>{text=next;},emit:(text:string,partId='prt_text',id=messageID)=>onText!({messageId:id,partId,text}),ready:()=>!!onText,finish:()=>{finished=true;},fail:()=>{error=true;},polls:()=>polls,aborts:()=>aborts};
}
const deltas=(events:ProjectReadEngineNotice[])=>events.filter(e=>e.type==='text').map(e=>e.text);

for(const mode of ['client-timeout','unknown'] as const)test('partial reply preserves bounded failure cause on '+mode,{timeout:4000},async()=>{
  const f=fixture(),running=f.start();try{
    await f.wait(()=>deltas(f.events).length===1);
    f.client.messages=async()=>{throw mode==='client-timeout'?new OpenCodePilotError({origin:'native_client',stage:'message_read',reason:'timeout'}):new Error('private body C:/private/file sk-private');};
    await running;const failures=f.events.filter(e=>e.type==='failed');assert.equal(failures.length,1);
    assert.deepEqual(failures[0]!.nativeFailure,mode==='client-timeout'?{origin:'native_client',stage:'message_read',reason:'timeout'}:{origin:'native_adapter',stage:'snapshot_validate',reason:'unknown'});
    assert.deepEqual(deltas(f.events),['第一段']);assert.equal(f.aborts(),1);assert(!JSON.stringify(failures).includes('private'));
  }finally{f.controller.abort();await f.engine.shutdown();}
});

test('native text is projected before text-end and only new suffixes are emitted', {timeout:4000},async()=>{
  const f=fixture(),running=f.start();
  try {
    await f.wait(()=>deltas(f.events).length===1);
    assert.deepEqual(deltas(f.events),['第一段']);assert(!f.events.some(e=>e.type==='completed'));
    const before=f.polls();await f.wait(()=>f.polls()>before);assert.deepEqual(deltas(f.events),['第一段']);
    f.setText('第一段，第二段');await f.wait(()=>deltas(f.events).length===2);
    assert.deepEqual(deltas(f.events),['第一段','，第二段']);assert(!f.events.some(e=>e.type==='completed'));
    f.finish();await running;
    assert.equal(f.events.at(-1)?.type,'completed');assert.equal(f.aborts(),1);
    assert.deepEqual(deltas(f.events),['第一段','，第二段']);
  }finally{f.controller.abort();await f.engine.shutdown();}
});

for(const mode of ['cancel','failure','rewritten-prefix'] as const)test('partial native reply stays partial on '+mode,{timeout:4000},async()=>{
  const f=fixture(),running=f.start();
  try {
    await f.wait(()=>deltas(f.events).length===1);
    if(mode==='cancel')f.controller.abort();else if(mode==='failure')f.fail();else f.setText('改写已有内容');
    await running;
    assert.deepEqual(deltas(f.events),['第一段']);assert(!f.events.some(e=>e.type==='completed'));
    assert.equal(f.events.filter(e=>e.type==='failed').length,mode==='cancel'?0:1);assert.equal(f.aborts(),1);
    if(mode!=='cancel')assert.deepEqual(f.events.find(e=>e.type==='failed')?.nativeFailure,{origin:'native_adapter',stage:mode==='failure'?'snapshot_validate':'text_projection',reason:mode==='failure'?'native_session_error':'text_regression'});
  }finally{f.controller.abort();await f.engine.shutdown();}
});

test('native events stream across stale snapshots and late events without duplication',{timeout:5000},async()=>{
  const f=fixture(true);f.setText('');const running=f.start();
  try {
    await f.wait(f.ready);f.emit('首段');await f.wait(()=>deltas(f.events).length===1);
    assert.deepEqual(deltas(f.events),['首段']);assert(!f.events.some(e=>e.type==='completed'));
    const before=f.polls();await f.wait(()=>f.polls()>before);assert.deepEqual(deltas(f.events),['首段']);
    f.emit('首段续段');await f.wait(()=>deltas(f.events).length===2);assert.deepEqual(deltas(f.events),['首段','续段']);
    f.setText('首段续段末段');await f.wait(()=>deltas(f.events).length===3);
    f.emit('首段续段末');assert.deepEqual(deltas(f.events),['首段','续段','末段']);
    f.finish();await running;assert.equal(f.events.at(-1)?.type,'completed');
  }finally{f.controller.abort();await f.engine.shutdown();}
});

test('one buffered native batch coalesces 200 deltas while later batches remain visible',{timeout:4000},async()=>{
  const f=fixture(true),running=f.start();
  try{
    await f.wait(()=>deltas(f.events).length===1);
    for(let n=1;n<=200;n++)f.emit('第一段'+'字'.repeat(n));
    await f.wait(()=>deltas(f.events).join('').length===203);
    assert.deepEqual(deltas(f.events),['第一段','字'.repeat(200)]);
    assert(!f.events.some(e=>e.type==='completed'));
    f.emit('第一段'+'字'.repeat(200)+'下一批');await f.wait(()=>deltas(f.events).length===3);
    f.setText('第一段'+'字'.repeat(200)+'下一批');f.finish();await running;
    assert.equal(f.events.at(-1)?.type,'completed');assert.equal(deltas(f.events).join(''),'第一段'+'字'.repeat(200)+'下一批');
  }finally{f.controller.abort();await f.engine.shutdown();}
});

for(const mode of ['stop','cancel','failure','rewritten-prefix','wrong-message'] as const)test('queued native text respects '+mode+' boundary',{timeout:4000},async()=>{
  const f=fixture(true),running=f.start();
  try{
    await f.wait(()=>deltas(f.events).length===1);f.emit('第一段合法续段');
    if(mode==='stop')await f.engine.stop('stream_synthetic');
    else if(mode==='cancel')f.controller.abort();
    else if(mode==='failure')f.fail();
    else f.emit(mode==='rewritten-prefix'?'改写':'第一段合法续段坏身份','prt_text',mode==='wrong-message'?'msg_foreign':'msg_assistant');
    await running;const count=f.events.length;f.emit('第一段合法续段迟到');await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.events.length,count);assert(!f.events.some(e=>e.type==='completed'));
    assert.equal(deltas(f.events).join(''),mode==='cancel'?'第一段':'第一段合法续段');
    assert.equal(f.events.filter(e=>e.type==='failed').length,['stop','cancel'].includes(mode)?0:1);
  }finally{f.controller.abort();await f.engine.shutdown();}
});

test('pending text flushes before a verified tool callback',{timeout:4000},async()=>{
  const f=fixture(true),running=f.start();
  try{
    await f.wait(()=>deltas(f.events).length===1);
    const read=f.client.messages;f.client.messages=async()=>{const rows=await read();const row=rows[1]!;return [rows[0]!,{...row,parts:[...row.parts,{id:'prt_tool',sessionID:'ses_text_stream',messageID:'msg_assistant',type:'tool',tool:'pilot_sum',callID:'call_sum',state:{status:'running',input:{values:[1]},time:{start:3}}}]}] as Awaited<ReturnType<typeof read>>;};
    f.emit('第一段工具前');await f.tool({sessionId:'ses_text_stream',messageId:'msg_assistant',callId:'call_sum',toolName:'pilot_sum',arguments:{values:[1]}});
    assert.deepEqual(f.order,['第一段','工具前','TOOL']);await f.engine.stop('stream_synthetic');await running;
  }finally{f.controller.abort();await f.engine.shutdown();}
});

test('switching verified text parts keeps message order within a buffered batch',{timeout:4000},async()=>{
  const f=fixture(true),read=f.client.messages;
  f.client.messages=async()=>{const rows=await read();if(!rows.length)return rows;const row=rows[1]!,part=row.parts[0]!;return [...rows,{...row,info:{...row.info,id:'msg_next',time:{created:4}},parts:[{...part,id:'prt_next',messageID:'msg_next',text:''}]}];};
  const running=f.start();
  try{
    await f.wait(()=>deltas(f.events).length===1);
    f.emit('第一段前段');f.emit('后段','prt_next','msg_next');await f.wait(()=>deltas(f.events).length===3);
    assert.deepEqual(f.events.filter(e=>e.type==='text').map(e=>[e.messageId,e.text]),[['msg_assistant','第一段'],['msg_assistant','前段'],['msg_next','后段']]);
    await f.engine.stop('stream_synthetic');await running;
  }finally{f.controller.abort();await f.engine.shutdown();}
});

for(const extra of [0,1])test('coalesced text at event budget '+(extra?'plus one':'exactly')+' uses existing UTF-8 event splitter',{timeout:4000},async()=>{
  const f=fixture(true),running=f.start();
  try{
    await f.wait(()=>deltas(f.events).length===1);
    const suffix='🧪'.repeat(PROJECT_READ_LIMITS.eventBytes/4)+'x'.repeat(extra);
    f.emit('第一段'+suffix);await f.wait(()=>deltas(f.events).length===2);
    const emitted=deltas(f.events)[1]!,parts=splitCloudDeltaV2(emitted);
    assert.equal(emitted,suffix);assert.equal(parts.join(''),suffix);assert(parts.length>1);
    for(const [index,text] of parts.entries())assert(parseProjectReadEvent({runId:'stream_synthetic',sequence:index+2,time:'2026-10-28T00:00:00.000Z',type:'message.delta',data:{messageId:'msg_assistant',step:1,text}}));
    f.setText('第一段'+suffix);f.finish();await running;assert.equal(f.events.at(-1)?.type,'completed');
  }finally{f.controller.abort();await f.engine.shutdown();}
});

for(const mode of ['contradictory-final','unverified-part'] as const)test('native event projection rejects '+mode,{timeout:4000},async()=>{
  const f=fixture(true);f.setText('');const running=f.start();
  try {
    await f.wait(f.ready);f.emit('首段',mode==='unverified-part'?'prt_foreign':'prt_text');
    if(mode==='contradictory-final')await f.wait(()=>deltas(f.events).length===1);
    else {const before=f.polls();await f.wait(()=>f.polls()>before);assert.deepEqual(deltas(f.events),[]);}
    f.setText(mode==='contradictory-final'?'改写':'合法正文');f.finish();await running;
    assert.equal(f.events.at(-1)?.type,'failed');assert(!f.events.some(e=>e.type==='completed'));
    assert.deepEqual(f.events.find(e=>e.type==='failed')?.nativeFailure,{origin:'native_adapter',stage:mode==='contradictory-final'?'text_projection':'completion_validate',reason:mode==='contradictory-final'?'text_regression':'incomplete_completion'});
    assert(!deltas(f.events).includes('改写'));
  }finally{f.controller.abort();await f.engine.shutdown();}
});
