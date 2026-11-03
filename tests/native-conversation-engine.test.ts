import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeConversationStore,nativeHistoryHash} from '../apps/desktop/src/main/agent-project-read/native-conversation-store';
import {createProjectReadNativeEngine,parseConversationOpenCodeMessages} from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import type {NativeConversationInput,ProjectReadEngineInput,ProjectReadEngineNotice} from '../apps/desktop/src/main/agent-project-read/engine';
import {createProjectReadProviderServices,type ProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import {projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';
import type {ProjectReadModel} from '../apps/desktop/src/shared/agent/agent-project-model';

type Row={info:Record<string,unknown>;parts:Record<string,unknown>[]};
const deepseek:ProjectReadModel={provider:'deepseek',model:'deepseek-v4-flash'};
const kimi:ProjectReadModel={provider:'kimi',model:'kimi-k3'};
const directory=()=>path.resolve('C:/work/analog_ai_workbench/.local/native-session-execution-20261023/unit',randomUUID());
function fixture(){
  const store=createNativeConversationStore(directory()),db=new Map<string,Row[]>(),baselines:unknown[][]=[];
  let serial=0,created=0,prompts=0,seeds=0,aborts=0,tools=0;
  const user=(sessionID:string,text:string,model:ProjectReadModel,imageUrls:readonly string[]=[])=>{
    const id='msg_'+(++serial),created=serial;
    return {info:{id,role:'user',sessionID,time:{created},agent:'pilot',model:{providerID:'workbench',modelID:model.model}},parts:[{type:'text',text},...imageUrls.map(url=>({type:'file',mime:'image/jpeg',url}))].map((p,index)=>({...p,id:'prt_'+serial+'_'+index,sessionID,messageID:id}))};
  };
  const client={health:async()=>true,createSession:async()=>{const id='ses_synthetic_'+(++created);db.set(id,[]);return id;},openSession:async(id:string)=>{if(!db.has(id))throw new Error('Missing synthetic session');return id;},seed:async(id:string,text:string,model:ProjectReadModel,urls:readonly string[]=[])=>{seeds++;db.get(id)!.push(user(id,text,model,urls));},
    prompt:async(id:string,input:{initialUserText?:string;model?:ProjectReadModel;imageUrls?:readonly string[]})=>{prompts++;const first=user(id,input.initialUserText!,input.model!,input.imageUrls);const messageID='msg_'+(++serial),now=serial;db.get(id)!.push(first,{info:{id:messageID,role:'assistant',sessionID:id,parentID:first.info.id,agent:'pilot',providerID:'workbench',modelID:input.model!.model,finish:'stop',time:{created:now,completed:now+0.1}},parts:[{type:'text',text:'answer '+prompts,id:'prt_'+serial,sessionID:id,messageID,time:{start:now,end:now+0.1}}]});},
    messages:async(id:string)=>structuredClone(db.get(id)!),isIdle:async()=>true,watchSessionErrors:async(_id:string,_onError:()=>void,_signal:AbortSignal)=>({close:async()=>{}}),questions:async()=>[],answer:async()=>{},abort:async()=>{aborts++;},dispose() {}};
  const services:Parameters<typeof createProjectReadNativeEngine>[0]['services']={begin(){return {bindSession(){},bindNativeContext(input:{messages:unknown[]}){baselines.push(structuredClone(input.messages));},answer(){},compactions:()=>[],evidence:()=>({complete:true})} as unknown as ReturnType<ProjectReadProviderServices['begin']>;},end(){},close:async()=>{}};
  const engine=(overrideServices?:typeof services)=>createProjectReadNativeEngine({client,services:overrideServices??services,conversationStore:store});
  async function turn(runtime:ReturnType<typeof engine>,nativeConversation:NativeConversationInput,model=deepseek,imageUrls:readonly string[]=[]){
    const events:ProjectReadEngineNotice[]=[],text='current '+randomUUID(),input:ProjectReadEngineInput={runId:'project_read.'+randomUUID(),model,workCycle:true,nativeConversation,signal:new AbortController().signal,chatContext:{provider:model.provider,model:model.model,maxOutputTokens:8192,timeoutMs:600000,messages:[{role:'user',content:imageUrls.length?[{type:'text',text},...imageUrls.map(url=>({type:'image_url' as const,image_url:{url}}))]:text}]},prompt:{goal:text,constraint:'',rules:'synthetic only',systemText:'synthetic only',initialUserText:text},callbacks:{notice:event=>events.push(event),tool:async()=>{tools++;throw new Error('Historical tool replay');},questionDelivered:async()=>{}}};
    await runtime.start(input);return events;
  }
  return {store,db,client,engine,turn,baselines,user,counts:()=>({created,prompts,seeds,aborts,tools})};
}

test('conversation bindings stay cold until submission and preserve only integrity metadata',()=>{
  const dir=directory(),store=createNativeConversationStore(dir),conversationId=randomUUID();
  assert.equal(fs.existsSync(dir),false);assert.equal(store.load(conversationId),null);assert.equal(fs.existsSync(dir),false);
  const rows=[{privateSyntheticText:'must not be duplicated in main bindings'}];
  const binding={version:1 as const,conversationId,sessionId:'ses_store',migrationHash:nativeHistoryHash([]),migrationComplete:true,externalTurnIds:[],historyCount:0,historyHash:nativeHistoryHash([]),pending:false};
  const saved=store.checkpoint(binding,rows);assert.deepEqual(store.load(conversationId),saved);store.verify(saved,[...rows,{another:'row'}]);
  assert.throws(()=>store.verify(saved,[]));assert.throws(()=>store.verify(saved,[{privateSyntheticText:'altered'}]));
  assert.equal(fs.readFileSync(path.join(dir,'bindings',conversationId+'.json'),'utf8').includes('privateSyntheticText'),false);
});

test('native checkpoint hashing ignores API encoder key order while preserving every value and row order',()=>{
  const a=[{info:{id:'msg_a',time:{created:1},role:'user'},parts:[{type:'text',text:'a'}]},{info:{id:'msg_b'},parts:[]}];
  const b=[{parts:[{text:'a',type:'text'}],info:{role:'user',time:{created:1},id:'msg_a'}},{parts:[],info:{id:'msg_b'}}];
  assert.equal(nativeHistoryHash(a),nativeHistoryHash(b));assert.notEqual(nativeHistoryHash(a),nativeHistoryHash([...b].reverse()));
  b[0]!.info.time!.created=2;assert.notEqual(nativeHistoryHash(a),nativeHistoryHash(b));
});

test('same chat survives engine restart, imports legacy once, switches model, and projects only current output',async()=>{
  const f=fixture(),conversationId=randomUUID(),legacyMessages=[{role:'user' as const,content:'old user'},{role:'assistant' as const,content:'old reply'}];
  let engine=f.engine();const first=await f.turn(engine,{conversationId,legacyMessages});const sessionId=f.store.load(conversationId)!.sessionId;
  assert.deepEqual(first.filter(e=>e.type==='text').map(e=>e.text),['answer 1']);assert.equal(f.counts().seeds,2);
  await engine.shutdown();engine=f.engine();const second=await f.turn(engine,{conversationId,expectedSessionId:sessionId,legacyMessages},kimi);
  assert.deepEqual(second.filter(e=>e.type==='text').map(e=>e.text),['answer 2']);assert.equal(f.store.load(conversationId)!.sessionId,sessionId);
  assert.equal(f.counts().created,1);assert.equal(f.counts().seeds,2);assert.equal(f.baselines[1]!.length,4);
  const other=randomUUID();await f.turn(engine,{conversationId:other});assert.notEqual(f.store.load(other)!.sessionId,sessionId);await engine.shutdown();
});

test('persistent conversations continue beyond the old 32-run process cap',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();
  for(let i=0;i<35;i++){const events=await f.turn(engine,{conversationId});assert.equal(events.at(-1)?.type,'completed');}
  assert.equal(f.counts().created,1);assert.equal(f.counts().prompts,35);await engine.shutdown();
});

test('an assistant stop does not end a persistent turn while native compaction is still busy',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();let statusReads=0;
  f.client.isIdle=async()=>++statusReads>1;
  const events=await f.turn(engine,{conversationId});assert.equal(statusReads,2);assert.equal(events.at(-1)?.type,'completed');
  assert.deepEqual(events.filter(e=>e.type==='text').map(e=>e.text),['answer 1']);assert.equal(f.counts().aborts,1);await engine.shutdown();
});

test('native preprocessing error ends a submitted turn without waiting for a user message or a new deadline',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();let error:()=>void=()=>{},closed=0;
  f.client.watchSessionErrors=async(_id,onError)=>{error=onError;return {close:async()=>{closed++;}};};
  f.client.prompt=async()=>{error();};
  const events=await f.turn(engine,{conversationId});assert.equal(events.at(-1)?.type,'failed');assert.equal(events.some(e=>e.type==='completed'),false);assert.equal(closed,1);
  assert.equal(f.db.get(f.store.load(conversationId)!.sessionId)!.length,0);assert.equal(f.store.load(conversationId)!.pending,false);await engine.shutdown();
});

test('a completed external turn is imported once when returning from a plain model',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();await f.turn(engine,{conversationId});
  const externalTurns=[{turnId:randomUUID(),messages:[{role:'user' as const,content:'plain user'},{role:'assistant' as const,content:'plain reply'}]}];
  await f.turn(engine,{conversationId,externalTurns});await f.turn(engine,{conversationId,externalTurns});
  assert.equal(f.counts().seeds,2);assert.deepEqual(f.store.load(conversationId)!.externalTurnIds,[externalTurns[0]!.turnId]);await engine.shutdown();
});

test('a lost migration acknowledgement recovers the existing reference without importing it twice',async()=>{
  const f=fixture(),conversationId=randomUUID(),legacyMessages=[{role:'user' as const,content:'archived constraint'}],seed=f.client.seed;let lose=true;
  f.client.seed=async(...args)=>{await seed(...args);if(lose){lose=false;throw new Error('Synthetic acknowledgement lost');}};
  let engine=f.engine();await assert.rejects(f.turn(engine,{conversationId,legacyMessages}));await assert.rejects(engine.shutdown());
  engine=f.engine();assert.equal((await f.turn(engine,{conversationId,legacyMessages})).at(-1)?.type,'completed');
  assert.equal(f.counts().created,1);assert.equal(f.counts().seeds,1);assert.equal(f.counts().prompts,1);await engine.shutdown();
});

test('missing binding or native session fails without replacing history or poisoning unrelated chats',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();
  const missing=await f.turn(engine,{conversationId,expectedSessionId:'ses_expected'});assert(missing.some(e=>e.type==='failed'));assert.equal(f.counts().created,0);assert.equal(await engine.health(),true);
  await f.turn(engine,{conversationId});const binding=f.store.load(conversationId)!;f.db.delete(binding.sessionId);
  const events=await f.turn(engine,{conversationId,expectedSessionId:binding.sessionId});assert(events.some(e=>e.type==='failed'));assert.equal(f.counts().created,1);assert.equal(f.counts().prompts,1);assert.equal(await engine.health(),true);
  assert.equal((await f.turn(engine,{conversationId:randomUUID()})).at(-1)?.type,'completed');await engine.shutdown();
});

test('pending recovery aborts old execution and retains old tool results without replay',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();await f.turn(engine,{conversationId});const binding=f.store.load(conversationId)!,rows=f.db.get(binding.sessionId)!;
  rows[1]!.parts.push({id:'prt_old_tool',messageID:rows[1]!.info.id,sessionID:binding.sessionId,type:'tool',tool:'work_write',callID:'call_old',state:{status:'completed',input:{path:'synthetic.txt'},output:'already done'}});
  f.store.checkpoint(binding,rows,true);const before=f.counts().aborts;const events=await f.turn(engine,{conversationId});
  assert.equal(events.at(-1)?.type,'completed');assert.equal(f.counts().tools,0);assert.equal(f.counts().aborts-before,2);assert.equal(f.store.load(conversationId)!.pending,false);await engine.shutdown();
});

test('pending recovery uses the real gateway to keep unknown tool outcomes as history and reject reused IDs',async()=>{
  for(const replay of [false,true]){
    const f=fixture(),conversationId=randomUUID(),prior=f.engine();await f.turn(prior,{conversationId});await prior.shutdown();
    const binding=f.store.load(conversationId)!,rows=f.db.get(binding.sessionId)!,callID='call_unknown_outcome';
    rows[1]!.parts.push({id:'prt_unknown_tool',messageID:rows[1]!.info.id,sessionID:binding.sessionId,type:'tool',tool:'pilot_sum',callID,state:{status:'running',input:{values:[1,2]}}});f.store.checkpoint(binding,rows,true);
    let providerCalls=0,runId='';
    const real=await createProjectReadProviderServices({getRunCredentials:()=>({apiKey:'sk-synthetic-recovery-test',model:deepseek,maxRequests:null,maxOutputTokens:8192,requestTimeoutMs:600000,replyLimits:{maxOutputTokens:8192,timeoutMs:600000}}),onResponse(){},fetchImpl:async(_url,init)=>{
      providerCalls++;const body=JSON.parse(String(init.body));assert(body.messages.some((m:{role:string;content:string})=>m.role==='tool'&&m.content==='[Tool execution was interrupted]'));
      const delta=replay?{role:'assistant',tool_calls:[{index:0,id:callID,type:'function',function:{name:'pilot_sum',arguments:'{"values":[1,2]}'}}]}:{role:'assistant',content:'answer 2'};
      const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'synthetic',model:deepseek.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
      return new Response(frame(delta)+frame({},replay?'tool_calls':'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    }});
    const services={...real,begin(input:Parameters<typeof real.begin>[0]){runId=input.runId;return real.begin(input);}};
    const prompt=f.client.prompt;f.client.prompt=async(id,input)=>{
      // The fake native transport emits the pinned interrupted-tool projection;
      // the real gateway alone decides whether the model may reuse its call ID.
      const body={model:deepseek.model,stream:true,tools:projectReadTools(true),messages:[
        {role:'user',content:rows[0]!.parts[0]!.text},
        {role:'assistant',content:'answer 1',tool_calls:[{id:callID,type:'function',function:{name:'pilot_sum',arguments:'{"values":[1,2]}'}}]},
        {role:'tool',tool_call_id:callID,content:'[Tool execution was interrupted]'},
        {role:'user',content:input.initialUserText},
      ]};
      const response=await fetch(`http://127.0.0.1:${real.port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${real.providerToken}`,'content-type':'application/json'},body:JSON.stringify(body)});await response.text();
      if(response.status!==200)throw new Error('Synthetic replay was rejected');await prompt(id,input);
    };
    const engine=f.engine(services),before=f.counts().aborts;
    try{if(replay){await assert.rejects(f.turn(engine,{conversationId}));await assert.rejects(engine.shutdown());}
      else {assert.equal((await f.turn(engine,{conversationId})).at(-1)?.type,'completed');await engine.shutdown();}
      assert.equal(providerCalls,1);assert.equal(f.counts().tools,0);assert(f.counts().aborts>before);assert.deepEqual(real.evidence(runId)?.issued,[]);
    }finally{await real.close();}
  }
});

test('changed native checkpoint refuses to submit a new prompt',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID();await f.turn(engine,{conversationId});const sessionId=f.store.load(conversationId)!.sessionId;
  f.db.get(sessionId)![0]!.parts[0]!.text='tampered';await assert.rejects(f.turn(engine,{conversationId}));assert.equal(f.counts().prompts,1);await assert.rejects(engine.shutdown());
});

test('current image survives native projection and missing or changed image cannot complete a turn',async()=>{
  const f=fixture(),engine=f.engine(),conversationId=randomUUID(),url='data:image/jpeg;base64,/9j/2Q==';
  const events=await f.turn(engine,{conversationId},kimi,[url]);assert.equal(events.at(-1)?.type,'completed');
  const sessionId=f.store.load(conversationId)!.sessionId,rows=f.db.get(sessionId)!,text=String(rows[0]!.parts[0]!.text);
  assert.equal(parseConversationOpenCodeMessages(rows,sessionId,text,kimi,[],[url]).userId,rows[0]!.info.id);
  const partial=structuredClone(rows.slice(0,1));partial[0]!.parts.pop();assert.equal(parseConversationOpenCodeMessages(partial,sessionId,text,kimi,[],[url]).pendingUserId,rows[0]!.info.id);
  assert.throws(()=>parseConversationOpenCodeMessages(rows,sessionId,text,kimi,[],[url+'altered']));await engine.shutdown();
});
