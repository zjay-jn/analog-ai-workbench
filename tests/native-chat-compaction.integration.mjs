// Explicit local integration: pinned OpenCode + production gateway/projection.
// The provider and tool broker are synthetic; no external model or user file is used.
// First compile tests, then run this file with the pinned repository Node toolchain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const compiled=rel=>require(path.join(root,'.local/test-build/apps/desktop/src',rel));
const {createProjectReadProviderServices}=compiled('main/agent-project-read/provider-gateway.js');
const {createProjectReadNativeEngine}=compiled('main/agent-project-read/opencode-engine.js');
const {startOpenCodeSupervisor}=compiled('main/engine-pilot/opencode-supervisor.js');
const {createOpenCodePilotClient}=compiled('main/engine-pilot/opencode-client.js');
const directory=path.join(root,'.local/prd-native-execution-20261019','native-'+Date.now());
fs.mkdirSync(directory,{recursive:true});
const hash=text=>createHash('sha256').update(text).digest('hex');
const model={provider:'deepseek',model:'deepseek-v4-flash'},runId='synthetic-'+randomUUID();
const current='Preserve constraint KEEP-ONE-WRITE. Finish all 70 synthetic operations, never repeat a completed write.';
const prior='HISTORY-MUST-BE-SUMMARIZED. Original constraint: KEEP-ONE-WRITE. '+ 'Synthetic context. '.repeat(500);
const summary='The original constraint is KEEP-ONE-WRITE. The synthetic write completed once. Continue only unfinished numbered calculations; never replay completed tool calls.';
const events=[],requests=[],calls=new Map(),responses=[];let normal=0,summaries=0,writes=0,retried=false,services,supervisor,engine,configuration,cleanup;
const abort=new AbortController();let deadline;
function wire(step,tool,inputTokens=100){
 const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'synthetic_call_'+step,type:'function',function:tool}]}:{role:'assistant',content:step==='summary'?summary:'Completed all synthetic operations.'};
 const frame=(delta,finish_reason=null,extra={})=>'data: '+JSON.stringify({id:'completion_'+String(step),model:model.model,choices:[{index:0,delta,finish_reason}],...extra})+'\n\n';
 return frame(delta)+frame({},tool?'tool_calls':'stop',{usage:{prompt_tokens:inputTokens,completion_tokens:40,total_tokens:inputTokens+40}})+'data: [DONE]\n\n';
}
function response(text){return new Response(text,{headers:{'Content-Type':'text/event-stream'}});}
try{
 services=await createProjectReadProviderServices({
  getRunCredentials:()=>({apiKey:'synthetic-offline-credential',model,maxRequests:null,maxOutputTokens:8192,requestTimeoutMs:120000,replyLimits:{maxOutputTokens:8192,timeoutMs:120000}}),
  onResponse:(_id,notice)=>responses.push(notice),
  fetchImpl:async(url,init)=>{
   assert.equal(url,'https://api.deepseek.com/chat/completions');
   // Deliberately no network fetch: all provider results are local scripted SSE.
   const body=JSON.parse(init.body),text=JSON.stringify(body.messages),compact=!body.tools?.length;
   requests.push({number:requests.length+1,compact,bytes:Buffer.byteLength(text),sourceHash:hash(text),history:text.includes('HISTORY-MUST-BE-SUMMARIZED'),constraint:text.includes('KEEP-ONE-WRITE')});
   assert(text.includes('KEEP-ONE-WRITE'));
   if(compact){summaries++;assert.equal(body.tool_choice,'none');if(summaries===1)assert(text.includes('HISTORY-MUST-BE-SUMMARIZED'));return response(wire('summary'));}
   if(normal===30&&!retried){retried=true;return new Response(JSON.stringify({error:{message:'synthetic transient'}}),{status:503,headers:{'retry-after-ms':'1'}});}
   normal++;assert(normal<=71,'unexpected model continuation');
   if(normal===71)return response(wire('final'));
   const tool=normal===1?{name:'work_write',arguments:JSON.stringify({relativePath:'synthetic.txt',expectedVersion:null,text:'Written once.'})}:{name:'pilot_sum',arguments:JSON.stringify({values:[normal,1]})};
   return response(wire(normal,tool,normal===30||normal===60?60000:100));
  },
 });
 supervisor=await startOpenCodeSupervisor({services:{port:services.port,providerToken:services.providerToken,toolToken:services.toolToken},profile:'work-cycle',conversation:true});
 const headers={Authorization:'Basic '+Buffer.from('opencode:'+supervisor.password).toString('base64'),'x-opencode-directory':supervisor.directory};
 const configResponse=await fetch('http://127.0.0.1:'+supervisor.port+'/config?directory='+encodeURIComponent(supervisor.directory),{headers,signal:AbortSignal.timeout(10000)});
 assert.equal(configResponse.status,200);const config=await configResponse.json();
 configuration={auto:config.compaction?.auto,prune:config.compaction?.prune,tailTurns:config.compaction?.tail_turns,pilotStepsPresent:Object.hasOwn(config.agent?.pilot??{},'steps'),compactionDisabled:config.agent?.compaction?.disable??false};
 assert.deepEqual(configuration,{auto:true,prune:false,tailTurns:0,pilotStepsPresent:false,compactionDisabled:false});
 const client=createOpenCodePilotClient({port:supervisor.port,password:supervisor.password,directory:supervisor.directory,profile:'work-cycle',conversation:true});
 engine=createProjectReadNativeEngine({client,services});
 deadline=setTimeout(()=>abort.abort(),120000);
 await engine.start({runId,model,signal:abort.signal,workCycle:true,chatContext:{...model,maxOutputTokens:8192,timeoutMs:120000,messages:[{role:'user',content:prior},{role:'assistant',content:'Prior synthetic acknowledgement.'},{role:'user',content:current}]},prompt:{goal:'Synthetic integration',constraint:'',rules:'Main supplies accepted synthetic context.',systemText:'Use only the scripted synthetic tool contract. KEEP-ONE-WRITE.',initialUserText:current},callbacks:{
  notice:event=>events.push(event),questionDelivered:async()=>assert.fail('unexpected question'),
  tool:async call=>{
   assert(!calls.has(call.callId),'completed tool was executed again');
   let result;
   if(call.toolName==='work_write'){
    assert.equal(++writes,1);fs.writeFileSync(path.join(directory,'synthetic.txt'),call.arguments.text,{flag:'wx'});
    const file={fileId:'synthetic_file',relativePath:'synthetic.txt',version:hash(call.arguments.text),bytes:Buffer.byteLength(call.arguments.text),confirmation:'confirmed',origin:{kind:'write',changeId:'synthetic_change'}};
    result={ok:true,value:{kind:'work_write',file,previousVersion:null,changeId:'synthetic_change',changed:true}};
   }else{assert.equal(call.toolName,'pilot_sum');result={ok:true,value:{kind:'sum',sum:call.arguments.values.reduce((a,b)=>a+b,0),count:call.arguments.values.length,source:'deterministic-local',toolVersion:'pilot.sum.v1'}};}
   calls.set(call.callId,result);return result;
  },
 }});
 assert(!abort.signal.aborted,'integration deadline');
 assert.equal(events.at(-1)?.type,'completed',JSON.stringify(events.slice(-5)));
 assert.equal(normal,71);assert.equal(summaries,2);assert.equal(writes,1);assert.equal(calls.size,70);assert.equal(retried,true);
 assert.deepEqual(events.filter(e=>e.type==='compaction').map(e=>e.version),[1,2]);
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Completed all synthetic operations.');
 const firstSummary=requests.findIndex(r=>r.compact);assert(firstSummary>24);assert(requests[firstSummary+1].bytes<requests[firstSummary].bytes,'actual post-summary provider context must shrink');
 assert.equal(requests[firstSummary+1].history,false,'covered host history must not be re-injected');
 assert.equal(fs.readFileSync(path.join(directory,'synthetic.txt'),'utf8'),'Written once.');
}catch(error){
 process.exitCode=1;fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error),stack:error?.stack,events:events.slice(-12),requests,normal,summaries,writes,toolCount:calls.size,configuration,traffic:services?.traffic(),evidence:services?.evidence(runId)},null,2));console.error(String(error));
}finally{
 if(deadline)clearTimeout(deadline);abort.abort();
 try{await engine?.shutdown();await services?.close();cleanup=await supervisor?.stop();assert(!supervisor||cleanup?.exited);}catch(error){process.exitCode=1;cleanup={error:String(error)};}
 const result={status:process.exitCode?'FAILED':'PASS',normalResponses:normal,summaryResponses:summaries,providerDispatches:requests.length,toolCalls:calls.size,syntheticWrites:writes,nativeRetry:retried,configuration,compactions:events.filter(e=>e.type==='compaction'),cleanup,externalApiRequests:0,scope:'Actual pinned native engine, gateway and projection; synthetic provider and tool callback. Token pressure is injected synthetic usage, not real model measurement.',requests};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,evidence:path.join(directory,'result.json'),providerDispatches:requests.length,toolCalls:calls.size,compactions:result.compactions.length,cleanup}));
}
