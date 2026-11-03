// Explicit local integration: the pinned native engine and production runtime/gateway.
// The provider is an in-process, gated synthetic stream; there are no external API requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.version,'v24.20.0');
const compiled=rel=>require(path.join(root,'.local/test-build/apps/desktop/src',rel));
const {createProjectReadRuntime}=compiled('main/agent-project-read/runtime.js');
const {startOpenCodeSupervisor}=compiled('main/engine-pilot/opencode-supervisor.js');
const directory=path.join(root,'.local/font-stream-20261027','integration-'+Date.now());
fs.mkdirSync(directory,{recursive:true});
const model={provider:'kimi',model:'kimi-k3'},conversationId=randomUUID(),encoder=new TextEncoder();
const inspectEvents=process.argv.includes('--inspect-events');
const trailingWhitespace=inspectEvents&&process.argv.includes('--trailing-whitespace');
const frozen=new Map(),nativeStarts=[],requests=[],traffic=[],turns=[],toolCalls=[],nativeEvents=[];
let runtime,activeCase,cleanupError,nativeHandle,nativeWatch;
const hash=text=>createHash('sha256').update(text).digest('hex');
const testedFiles=['tests/native-streaming.integration.mjs','apps/desktop/src/main/engine-pilot/opencode-client.ts','.local/test-build/apps/desktop/src/main/engine-pilot/opencode-client.js',...['protocol','provider-gateway','opencode-engine','runtime'].flatMap(name=>[
  'apps/desktop/src/main/agent-project-read/'+name+'.ts',
  '.local/test-build/apps/desktop/src/main/agent-project-read/'+name+'.js',
])].map(file=>({path:file,sha256:hash(fs.readFileSync(path.join(root,file)))}));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function until(predicate,label,timeout=15000){const end=Date.now()+timeout;while(!predicate()){assert(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,20));}}
const ownedSession=()=>activeCase?.events.find(event=>event.type==='started')?.sessionId;
const nativeHeaders=native=>({Authorization:'Basic '+Buffer.from('opencode:'+native.password).toString('base64'),'x-opencode-directory':native.directory});
async function watchSyntheticEvents(native){
  const abort=new AbortController(),ready=deferred();
  const response=await fetch(`http://127.0.0.1:${native.port}/event`,{headers:{...nativeHeaders(native),Accept:'text/event-stream'},signal:abort.signal});assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  const task=(async()=>{let pending='';try{for(;;){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});let at;
    while((at=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,at);pending=pending.slice(at+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;
      const value=JSON.parse(data);if(value.type==='server.connected'){ready.resolve();continue;}
      const p=value.properties,part=p?.part,info=p?.info,id=p?.sessionID??part?.sessionID??info?.sessionID;
      if(!id||id!==ownedSession())continue;
      if(nativeEvents.length>256)continue;
      nativeEvents.push({receivedAt:Date.now(),case:activeCase.name,type:value.type,propertyKeys:Object.keys(p),
        ...(part?{partKeys:Object.keys(part),part:{id:part.id,sessionID:part.sessionID,messageID:part.messageID,type:part.type,text:part.type==='text'?part.text:undefined,time:part.time,ignored:part.ignored,synthetic:part.synthetic}}:{}),
        ...(info?{infoKeys:Object.keys(info),info:{id:info.id,sessionID:info.sessionID,role:info.role,time:info.time,finish:info.finish,parentID:info.parentID,summary:info.summary,agent:info.agent,mode:info.mode,modelID:info.modelID,providerID:info.providerID}}:{}),
        sessionID:p.sessionID,messageID:p.messageID,partID:p.partID,field:p.field,delta:p.field==='text'?p.delta:undefined});
    }
  }}catch(error){if(!abort.signal.aborted)throw error;}finally{reader.releaseLock();}})();void task.catch(()=>{});await ready.promise;
  return {close:async()=>{abort.abort();await task;}};
}
async function syntheticSnapshot(){
  const id=ownedSession();if(!id||!nativeHandle)return null;
  const response=await fetch(`http://127.0.0.1:${nativeHandle.port}/session/${encodeURIComponent(id)}/message`,{headers:nativeHeaders(nativeHandle),signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);
  const rows=await response.json();return rows.map(row=>({info:{id:row.info.id,sessionID:row.info.sessionID,role:row.info.role,time:row.info.time,finish:row.info.finish},parts:row.parts.map(part=>({id:part.id,sessionID:part.sessionID,messageID:part.messageID,type:part.type,text:part.type==='text'?part.text:undefined,time:part.time}))}));
}
const finishUsage={usage:{prompt_tokens:144,completion_tokens:50,total_tokens:194,prompt_tokens_details:{cache_write_tokens:0},completion_tokens_details:{reasoning_tokens:34}}};
function providerResponse(owner,number){
  const frame=(delta,finish_reason=null,extra={})=>'data: '+JSON.stringify({id:'stream_'+owner.name+'_'+number,object:'chat.completion.chunk',model:model.model,choices:[{index:0,delta,finish_reason}],...extra})+'\n\n';
  if(owner.mode==='plain'||owner.mode==='tool'&&number===2){
    owner.providerDoneAt=Date.now();
    return new Response(frame({role:'assistant',content:owner.finalText})+frame({},'stop',finishUsage)+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  let cancelled=false;
  return new Response(new ReadableStream({
    start(controller){
      const send=value=>{if(!cancelled)controller.enqueue(encoder.encode(value));};
      owner.providerFirstAt=Date.now();send(frame({role:'assistant',content:owner.prefix}));
      if(owner.mode==='tool')send(frame({tool_calls:[{index:0,id:'call_stream_sum',type:'function',function:{name:'pilot_sum',arguments:'{"values":['}}]}));
      void (async()=>{
        await owner.firstGate.promise;if(cancelled)return;
        if(owner.mode==='bad-tail'){
          owner.providerDoneAt=Date.now();send('data: {"bad":\n\n');controller.close();return;
        }
        if(owner.mode==='tool')send(frame({tool_calls:[{index:0,function:{arguments:'1,2]}'}}]}));
        else send(frame({content:owner.suffix}));
        owner.providerSecondAt=Date.now();
        await owner.finishGate.promise;if(cancelled)return;
        owner.providerDoneAt=Date.now();send(frame({},owner.mode==='tool'?'tool_calls':'stop',finishUsage));send('data: [DONE]\n\n');controller.close();
      })().catch(error=>{if(!cancelled){cancelled=true;controller.error(error);}});
    },
    cancel(){cancelled=true;owner.providerCancelledAt=Date.now();},
  }),{headers:{'content-type':'text/event-stream'}});
}
const models={status:()=>({model,canStart:true,reason:null}),freeze(){assert.fail('Ordinary chat must use freezeChat');},
  freezeChat(runId,selected,limits){assert.deepEqual(selected,model);frozen.set(runId,{apiKey:'sk-synthetic-offline-streaming',model,maxRequests:null,maxOutputTokens:limits.maxOutputTokens,requestTimeoutMs:limits.timeoutMs,replyLimits:limits});return model;},
  get(runId){assert(frozen.has(runId));return frozen.get(runId);},forget:runId=>frozen.delete(runId),close:()=>frozen.clear()};
function createRuntime(){return createProjectReadRuntime({models,workCycle:true,conversation:true,
  onTraffic:value=>traffic.push({case:activeCase?.name,time:Date.now(),value}),
  startNative:async options=>{const native=await startOpenCodeSupervisor(options);nativeHandle=native;nativeStarts.push({directory:native.directory,conversationDirectory:native.conversationDirectory,pid:native.pid});nativeWatch=await watchSyntheticEvents(native);return native;},
  fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.moonshot.cn/v1/chat/completions');assert.equal(init.redirect,'error');
    const owner=activeCase;assert(owner);const body=JSON.parse(init.body);assert.equal(body.model,model.model);assert(body.tools?.length,'No compaction was requested by this fixture');
    owner.dispatches++;assert(owner.dispatches<=(owner.mode==='tool'?2:1),'No custom retry or unintended provider replay');
    const encoded=JSON.stringify(body.messages);requests.push({case:owner.name,number:owner.dispatches,time:Date.now(),bytes:Buffer.byteLength(encoded),sha256:hash(encoded)});
    if(turns.length)assert(encoded.includes('STREAM-FIRST-SECOND'),'Same-session prior answer must remain in native history');
    if(owner.mode==='tool'&&owner.dispatches===2)assert(encoded.includes('deterministic-local'),'Tool continuation includes its actual result');
    return providerResponse(owner,owner.dispatches);
  }});}
function begin(name,mode,prefix='',suffix='',finalText=''){
  const owner={name,mode,prefix,suffix,finalText,dispatches:0,firstGate:deferred(),finishGate:deferred(),events:[],toolsBefore:toolCalls.length,startedAt:Date.now()};
  activeCase=owner;
  const runId='stream-'+randomUUID(),text='Explicit synthetic streaming integration case: '+name,abort=new AbortController();
  const deadline=setTimeout(()=>abort.abort(),45000);
  runtime.acceptChat(runId,model,{maxOutputTokens:8192,timeoutMs:30000});
  const operation=runtime.start({runId,model,signal:abort.signal,workCycle:true,chatContext:{...model,maxOutputTokens:8192,timeoutMs:30000,messages:[{role:'user',content:text}]},nativeConversation:{conversationId,legacyMessages:[]},
    prompt:{goal:'Complete this synthetic streaming check.',constraint:'',rules:'Only registered synthetic tools are available.',systemText:'This isolated integration uses synthetic inputs and deterministic local tool results.',initialUserText:text},
    callbacks:{notice:event=>owner.events.push({time:Date.now(),...event}),questionDelivered:async()=>assert.fail('Unexpected question'),tool:async call=>{
      assert.equal(owner.mode,'tool');assert.equal(call.toolName,'pilot_sum');assert.deepEqual(call.arguments,{values:[1,2]});assert(owner.providerDoneAt,'No tool before provider validation completes');
      assert.equal(toolCalls.length,owner.toolsBefore,'Only one physical tool execution');toolCalls.push({case:name,time:Date.now(),callId:call.callId});
      return {ok:true,value:{kind:'sum',sum:3,count:2,source:'deterministic-local',toolVersion:'pilot.sum.v1'}};
    }},
  });
  void operation.catch(()=>{});
  return Object.assign(owner,{runId,abort,deadline,operation});
}
const answer=owner=>owner.events.filter(event=>event.type==='text').map(event=>event.text).join('');
async function settle(owner,expected){
  await owner.operation;assert(!owner.abort.signal.aborted,'Integration deadline must not stop the native run');
  if(expected==='failed'){assert(owner.events.some(event=>event.type==='failed'));assert(!owner.events.some(event=>event.type==='completed'));}
  else assert.equal(owner.events.at(-1)?.type,'completed',JSON.stringify(owner.events.slice(-4)));
  const nativeId=owner.events.find(event=>event.type==='started')?.sessionId;assert(nativeId);if(turns.length)assert.equal(nativeId,turns[0].nativeId);
  const accounting=runtime.accounting(owner.runId);await runtime.stop(owner.runId);
  assert.equal(accounting.httpDispatches,owner.mode==='tool'?2:1);assert.equal(accounting.providerAttempts,accounting.httpDispatches);
  clearTimeout(owner.deadline);owner.abort.abort();owner.firstGate.resolve();owner.finishGate.resolve();
  const {firstGate,finishGate,operation,abort,deadline,...saved}=owner;turns.push({...saved,status:expected,nativeId,answer:answer(owner),accounting,finishedAt:Date.now(),cleanup:'stop resolved'});
  console.log(JSON.stringify({case:owner.name,status:expected,providerDispatches:owner.dispatches,textDeltas:owner.events.filter(event=>event.type==='text').length}));
}
try{
  runtime=createRuntime();
  let owner=begin('gated-text','text','STREAM-FIRST',trailingWhitespace?'-SECOND \n\n':'-SECOND');
  await until(()=>inspectEvents?nativeEvents.some(event=>event.type==='message.part.delta'&&event.delta==='STREAM-FIRST'):answer(owner)==='STREAM-FIRST','Expected first native text before provider EOF');
  assert.equal(owner.providerDoneAt,undefined);assert(!owner.events.some(event=>event.type==='completed'));owner.firstProjectedAt=Date.now();owner.firstGate.resolve();
  await until(()=>inspectEvents?nativeEvents.some(event=>event.type==='message.part.delta'&&event.delta===owner.suffix):answer(owner)==='STREAM-FIRST-SECOND','Expected second native text before provider EOF');
  assert.equal(owner.providerDoneAt,undefined);assert(!owner.events.some(event=>event.type==='completed'));owner.secondProjectedAt=Date.now();owner.finishGate.resolve();
  await settle(owner,'completed');assert.equal(inspectEvents?answer(owner).trimEnd():answer(owner),'STREAM-FIRST-SECOND');if(!inspectEvents)assert(owner.events.filter(event=>event.type==='text').length>=2);
  if(!inspectEvents){
  owner=begin('same-session-follow-up','plain','','','FOLLOW-UP-OK');await settle(owner,'completed');assert.equal(answer(owner),'FOLLOW-UP-OK');

  owner=begin('gated-tool','tool','PRE-TOOL','','POST-TOOL-OK');
  await until(()=>answer(owner)==='PRE-TOOL','Expected tool-preface text before provider EOF');assert.equal(toolCalls.length,0);owner.firstGate.resolve();
  await until(()=>owner.providerSecondAt!==undefined,'Expected complete tool arguments');await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(toolCalls.length,0,'Even complete arguments cannot execute before valid terminal stream');assert.equal(owner.providerDoneAt,undefined);owner.finishGate.resolve();
  await settle(owner,'completed');assert.equal(answer(owner),'PRE-TOOLPOST-TOOL-OK');assert.equal(toolCalls.length,1);

  owner=begin('malformed-tail','bad-tail','VISIBLE-PARTIAL');
  await until(()=>answer(owner)==='VISIBLE-PARTIAL','Expected visible partial reply before invalid tail');assert.equal(owner.providerDoneAt,undefined);owner.firstProjectedAt=Date.now();owner.firstGate.resolve();
  await settle(owner,'failed');assert.equal(answer(owner),'VISIBLE-PARTIAL');assert.equal(toolCalls.length,1);assert.equal(turns.at(-1).accounting.failureReason,'PROTOCOL_ERROR');

  owner=begin('explicit-follow-up-after-failure','plain','','','RECOVERY-OK');await settle(owner,'completed');assert.equal(answer(owner),'RECOVERY-OK');
  assert.equal(turns.length,5);assert.equal(requests.length,6);assert.equal(toolCalls.length,1);
  }
}catch(error){process.exitCode=1;let snapshot;try{snapshot=await syntheticSnapshot();}catch{snapshot='snapshot unavailable';}fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error),stack:error?.stack,currentCase:activeCase?.name,events:activeCase?.events,nativeEvents,snapshot,accounting:activeCase?.runId?runtime?.accounting(activeCase.runId):null},null,2));console.error(String(error));}
finally{
  if(activeCase){clearTimeout(activeCase.deadline);activeCase.abort?.abort();activeCase.firstGate.resolve();activeCase.finishGate.resolve();}
  try{await nativeWatch?.close();}catch{cleanupError='Synthetic event observer close failed';}
  try{if(runtime)await runtime.shutdown();}catch(error){cleanupError=String(error);process.exitCode=1;}
  const result={status:process.exitCode?'FAILED':inspectEvents?'OBSERVED':'PASS',mode:inspectEvents?'native-events-only-not-product-streaming-validation':'end-to-end',trailingWhitespace,externalApiRequests:0,scope:'Pinned native engine + production runtime/client/gateway; gated local synthetic provider, synthetic pilot_sum callback, no user data or credentials.',node:process.version,testedFiles,conversationId,nativeStarts,nativeEvents,turns,requests,toolCalls,traffic,cleanupError};
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,evidence:path.join(directory,'result.json'),turns:turns.length,providerDispatches:requests.length,toolCalls:toolCalls.length}));
}
