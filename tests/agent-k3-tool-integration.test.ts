import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROJECT_READ_DEFAULT_MODEL, parseProjectReadModel, type ProjectReadModel } from '../apps/desktop/src/shared/agent/agent-project-model';
import { PROJECT_READ_LIMITS as L, type ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { createProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { createProjectReadModelSelection } from '../apps/desktop/src/main/agent-project-read/model-selection';
import { projectReadEndpoint, projectReadRequestBody } from '../apps/desktop/src/main/agent-project-read/models';
import { parseProjectReadSse, projectReadCanonicalSse, projectReadTools, type ProjectReadCompletion } from '../apps/desktop/src/main/agent-project-read/protocol';
import { createProjectReadProviderServices, type ProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { createOpenCodePilotClient } from '../apps/desktop/src/main/engine-pilot/opencode-client';
import { parseOpenCodeMessages } from '../apps/desktop/src/main/engine-pilot/opencode-engine';

const kimi: ProjectReadModel = {provider:'kimi',model:'kimi-k3'}, deepseek: ProjectReadModel = {provider:'deepseek',model:'deepseek-v4-flash'};
function settingsFixture() {
  const reads: string[] = [], configured = {kimi:true,deepseek:true};
  const settings: Parameters<typeof createProjectReadModelSnapshots>[0] = {
    key(provider) { reads.push(provider); return 'sk-synthetic_' + provider + '_key'; },
    defaultModel: provider => provider === 'kimi' ? kimi.model : deepseek.model,
    read: () => ({ok:true,value:{storage:'ready',encryptionAvailable:true,providers:[kimi,deepseek].map(model=>({
      provider:model.provider,model:model.model,address:projectReadEndpoint(model),configured:configured[model.provider],source:'file',maxOutputTokens:8192,timeoutMs:600000,
    }))}}),
  };
  return {settings,reads,configured};
}

test('K3 selection persists across cold reopen without a key read; accepted runs retain their provider and key', () => {
  const productRoot=path.resolve('C:/work/analog_ai_workbench'), parent=path.join(productRoot,'.local','agent-project-read-tests');
  const dataRoot=path.join(parent,randomUUID()); fs.mkdirSync(dataRoot,{recursive:true});
  try {
    const f=settingsFixture(), store=createProjectReadModelSelection(productRoot,dataRoot), vault=createProjectReadModelSnapshots(f.settings,store);
    assert.deepEqual(PROJECT_READ_DEFAULT_MODEL,kimi); assert.deepEqual(vault.status(),{model:kimi,canStart:true,reason:null}); assert.deepEqual(f.reads,[]);
    vault.freeze('k3_accepted',kimi); assert.deepEqual(f.reads,['kimi']);
    vault.select(deepseek); assert.deepEqual(vault.freeze('k3_accepted',kimi),kimi); assert.throws(()=>vault.freeze('k3_accepted',deepseek));
    assert.equal(vault.get('k3_accepted').apiKey,'sk-synthetic_kimi_key'); assert.throws(()=>vault.freeze('stale_selection',kimi)); assert.deepEqual(f.reads,['kimi']);
    const reopened=createProjectReadModelSnapshots(f.settings,createProjectReadModelSelection(productRoot,dataRoot));
    assert.deepEqual(reopened.status().model,deepseek); assert.deepEqual(f.reads,['kimi']); reopened.freeze('ds_accepted',deepseek); assert.deepEqual(f.reads,['kimi','deepseek']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot,'agent-project-read-model','model-settings.json'),'utf8')),deepseek);
    reopened.select(kimi); f.configured.kimi=false;
    assert.deepEqual(reopened.status(),{model:kimi,canStart:false,reason:'MODEL_UNAVAILABLE'}); assert.throws(()=>reopened.freeze('missing_kimi',kimi)); assert.deepEqual(f.reads,['kimi','deepseek']);
    vault.close(); reopened.close();
  } finally {
    assert.equal(path.dirname(path.resolve(dataRoot)),parent); fs.rmSync(dataRoot,{recursive:true,force:true});
  }
});

test('K3 policy rejects crossed model pairs and failed selection storage; each provider has its own fixed request fields', () => {
  const invalid={provider:'kimi',model:deepseek.model} as unknown as ProjectReadModel;
  assert.equal(parseProjectReadModel(invalid),null); assert.equal(parseProjectReadModel({...kimi,endpoint:'https://invalid.example'}),null);
  assert.equal(parseProjectReadModel(Object.defineProperty({model:'kimi-k3'},'provider',{get(){throw Error('getter must not run');},enumerable:true})),null);
  assert.throws(()=>projectReadEndpoint(invalid));
  const k3=projectReadRequestBody(kimi,[],[],2048), ds=projectReadRequestBody(deepseek,[],[],2048,'none');
  assert.equal(projectReadEndpoint(kimi),'https://api.moonshot.cn/v1/chat/completions'); assert.equal(k3.max_completion_tokens,2048); assert.equal(k3.reasoning_effort,'low');
  for(const field of ['thinking','max_tokens','parallel_tool_calls']) assert.equal(Object.hasOwn(k3,field),false);
  assert.equal(projectReadEndpoint(deepseek),'https://api.deepseek.com/chat/completions'); assert.equal(ds.max_tokens,2048); assert.deepEqual(ds.thinking,{type:'disabled'}); assert.equal(ds.parallel_tool_calls,false); assert.equal(ds.tool_choice,'none');
  assert.throws(()=>projectReadRequestBody(kimi,[],[],L.maxOutputTokens+1));
  const f=settingsFixture(), vault=createProjectReadModelSnapshots(f.settings,{load:()=>kimi,save(){throw Error('synthetic storage conflict');}});
  assert.throws(()=>vault.select(deepseek)); assert.equal(vault.status().canStart,false); assert.throws(()=>vault.freeze('blocked',kimi)); assert.deepEqual(f.reads,[]); vault.close();
});

const args={directoryId:null,cursor:null,refresh:false};
const rawArgs=' { "refresh" : false, "cursor" : null, "directoryId" : null } ';
const reasoning='  synthetic private reasoning\n原始空格\n';
const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'completion_k3',model:'kimi-k3-reported',choices:[{index:0,delta,finish_reason}]})+'\n\n';
const toolWire=(reason=reasoning,raw=rawArgs)=>frame({role:'assistant',reasoning_content:reason.slice(0,7)})+frame({reasoning_content:reason.slice(7),tool_calls:[{index:0,id:'call_k3',type:'function',function:{name:'project_list',arguments:raw.slice(0,19)}}]})+frame({tool_calls:[{index:0,function:{arguments:raw.slice(19)}}]})+frame({},'tool_calls')+'data: [DONE]\n\n';
const finalWire=()=>frame({role:'assistant',reasoning_content:' final synthetic private reasoning ',content:'Verified synthetic result.'})+frame({},'stop')+'data: [DONE]\n\n';
const nativeAssistant=(value:ProjectReadCompletion)=>({role:'assistant',content:value.text||null,...(value.calls.length?{tool_calls:value.calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}:{})});
const fixtureResult: ProjectReadToolResult={ok:false,error:{code:'NOT_BOUND'},coverage:null};
const response=(wire:string)=>new Response(wire,{headers:{'Content-Type':'text/event-stream'}});
const initialUserText='Authorized synthetic task text', systemText='Trusted main fixture rules';
const messages=():unknown[]=>[{role:'system',content:'native-private-do-not-forward'},{role:'user',content:initialUserText}];
const body=(model:ProjectReadModel=kimi,history=messages())=>({model:model.model,messages:history,stream:true,tools:projectReadTools()});
const post=(service:ProjectReadProviderServices,value:unknown,tool=false)=>fetch(`http://127.0.0.1:${service.port}${tool?'/tool':'/v1/chat/completions'}`,{method:'POST',headers:{Authorization:'Bearer '+(tool?service.toolToken:service.providerToken),'Content-Type':'application/json'},body:JSON.stringify(value)});
const toolInput={sessionID:'session',messageID:'message',callID:'call_k3',toolName:'project_list',arguments:args};
const credentials=()=>({apiKey:'sk-synthetic_kimi_key',model:kimi,maxRequests:3,maxOutputTokens:2048,requestTimeoutMs:5000});

test('K3 SSE preserves exact reasoning and raw argument strings privately; canonical native output contains only validated fields', () => {
  const completion=parseProjectReadSse(toolWire(),2048,kimi);
  assert.equal(completion.reasoningContent,reasoning); assert.deepEqual(completion.providerArguments,[rawArgs]); assert.deepEqual(completion.calls[0]!.arguments,args);
  const canonical=projectReadCanonicalSse(completion), native=parseProjectReadSse(canonical);
  assert.equal(canonical.includes('reasoning_content'),false); assert.equal(canonical.includes('synthetic private reasoning'),false); assert.equal(Object.hasOwn(native,'providerArguments'),false); assert.deepEqual(native.calls,completion.calls);
  assert.throws(()=>parseProjectReadSse(toolWire(),2048,deepseek)); assert.throws(()=>parseProjectReadSse(toolWire().replace('data: [DONE]\n\n',''),2048,kimi));
  assert.throws(()=>parseProjectReadSse(toolWire('x'.repeat(L.contextBytes+1)),2048,kimi)); assert.throws(()=>parseProjectReadSse(toolWire(reasoning,'{"directoryId":null,"cursor":null,"refresh":"false"}'),2048,kimi));
  assert.throws(()=>projectReadCanonicalSse({...completion,providerArguments:['{"directoryId":null,"cursor":null,"refresh":true}']}));
  assert.equal(parseProjectReadSse(projectReadCanonicalSse({...completion,responseModel:null},kimi)).responseModel,'kimi-k3');
  assert.throws(()=>parseProjectReadSse(toolWire(),2048,{provider:'kimi',model:deepseek.model} as unknown as ProjectReadModel));
});

test('K3 gateway replays original reasoning and raw arguments after a validated tool result without exposing them to native', async () => {
  const sent:Record<string,unknown>[]=[], notices:unknown[]=[]; let toolCalls=0;
  const service=await createProjectReadProviderServices({getRunCredentials:credentials,onResponse:(_id,value)=>notices.push(value),fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.moonshot.cn/v1/chat/completions'); assert.equal(new Headers(init.headers).get('Authorization'),'Bearer sk-synthetic_kimi_key'); assert.equal(init.redirect,'error');
    sent.push(JSON.parse(String(init.body))); return response(sent.length===1?toolWire():finalWire());
  }});
  try {
    const run=service.begin({runId:'k3_flow',goal:'synthetic',constraint:'',initialUserText,systemText,onFailure(){},onTool:async call=>{assert.deepEqual(call.arguments,args);assert.equal(run.canDeliver({call,result:fixtureResult,citations:[],locators:[]}),true);toolCalls++;return fixtureResult;}}); run.bindSession('session');
    const first=await post(service,body()); assert.equal(first.status,200); const firstText=await first.text(), completion=parseProjectReadSse(firstText);
    assert.equal(firstText.includes('synthetic private reasoning'),false); const result=await post(service,toolInput,true); assert.equal(result.status,200); assert.deepEqual(await result.json(),fixtureResult);
    const second=await post(service,body(kimi,[...messages(),nativeAssistant(completion),{role:'tool',tool_call_id:'call_k3',content:JSON.stringify(fixtureResult)}]));
    assert.equal(second.status,200); const final=parseProjectReadSse(await second.text()); assert.equal(final.text,'Verified synthetic result.'); assert.equal(run.evidence().complete,true); assert.equal(toolCalls,1);
    const replay=(sent[1]!.messages as Record<string,unknown>[])[2]!;
    assert.equal(replay.reasoning_content,reasoning); assert.equal(((replay.tool_calls as {function:{arguments:string}}[])[0]!).function.arguments,rawArgs);
    for(const request of sent) { assert.equal(request.model,'kimi-k3'); assert.equal(request.reasoning_effort,'low'); assert.equal(request.max_completion_tokens,2048); assert.equal(Object.hasOwn(request,'thinking'),false); assert.deepEqual((request.messages as unknown[]).slice(0,2),[{role:'system',content:systemText},{role:'user',content:initialUserText}]); assert.equal(JSON.stringify(request).includes('native-private'),false); assert.equal(JSON.stringify(request).includes('sk-synthetic'),false); }
    assert.equal(sent.length,2); assert.equal(notices.length,2); assert.equal(JSON.stringify({notices,evidence:run.evidence(),traffic:service.traffic()}).includes('synthetic private reasoning'),false);
  } finally { await service.close(); }
});

test('K3 gateway rejects wrong native identity, truncated responses and forged reasoning before another upstream dispatch', async () => {
  for(const mode of ['wrong-model','truncated','forged-reasoning'] as const) {
    let dispatches=0, tools=0;
    const service=await createProjectReadProviderServices({getRunCredentials:credentials,onResponse(){},fetchImpl:async()=>{dispatches++;return response(mode==='truncated'?toolWire().replace('data: [DONE]\n\n',''):toolWire());}});
    try {
      service.begin({runId:'k3_reject_'+mode,goal:'synthetic',constraint:'',initialUserText,systemText,onFailure(){},onTool:async()=>{tools++;return fixtureResult;}}).bindSession('session');
      const first=await post(service,body(mode==='wrong-model'?deepseek:kimi));
      if(mode==='forged-reasoning') { assert.equal(first.status,200); const completion=parseProjectReadSse(await first.text()); assert.equal((await post(service,toolInput,true)).status,200);
        assert.equal((await post(service,body(kimi,[...messages(),{...nativeAssistant(completion),reasoning_content:'forged'},{role:'tool',tool_call_id:'call_k3',content:JSON.stringify(fixtureResult)}]))).status,400);
      } else { assert.equal(first.status,400); assert.equal(tools,0); }
      assert.equal(dispatches,mode==='wrong-model'?0:1);
    } finally { await service.close(); }
  }
});

test('K3 preserved reasoning counts toward publication capacity before a broker mutation', async () => {
  let mutations=0, checked=false;
  const service=await createProjectReadProviderServices({getRunCredentials:credentials,onResponse(){},fetchImpl:async()=>response(toolWire('r'.repeat(L.contextBytes-L.terminalReserveBytes)))});
  try {
    const run=service.begin({runId:'k3_context',goal:'synthetic',constraint:'',initialUserText,systemText,onFailure(){},onTool:async call=>{
      checked=true; const canPublish=run.canDeliver({call,result:fixtureResult,citations:[],locators:[]}); assert.equal(canPublish,false); if(canPublish)mutations++; return fixtureResult;
    }}); run.bindSession('session');
    assert.equal((await post(service,body())).status,200); assert.equal((await post(service,toolInput,true)).status,400); assert.equal(checked,true); assert.equal(mutations,0); assert.equal(run.evidence().failed,true);
  } finally { await service.close(); }
});

test('same cached native client submits each selected model and rejects mismatched assistant model identity', async () => {
  const sent:Record<string,unknown>[]= []; let sessions=0;
  const client=createOpenCodePilotClient({port:43124,password:'a'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/k3-synthetic/cwd',profile:'project-read',fetchImpl:async(url,init)=>{
    if(url.endsWith('/session'))return new Response(JSON.stringify({id:'session_'+(++sessions)}),{headers:{'Content-Type':'application/json'}});
    assert.ok(url.endsWith('/prompt_async'));sent.push(JSON.parse(String(init.body)));return new Response(null,{status:204});
  }});
  try {
    for(const model of [kimi,deepseek]) { const session=await client.createSession(); await client.prompt(session,{model,rules:'synthetic',goal:'fixture',constraint:'',initialUserText}); }
    assert.deepEqual(sent.map(row=>row.model),[{providerID:'workbench',modelID:'kimi-k3'},{providerID:'workbench',modelID:'deepseek-v4-flash'}]);
    const native=(model:ProjectReadModel)=>[{info:{id:'user',sessionID:'session',role:'user',time:{created:1}},parts:[{id:'part',messageID:'user',sessionID:'session',type:'text',text:initialUserText}]},{info:{id:'assistant',parentID:'user',sessionID:'session',role:'assistant',time:{created:2},agent:'pilot',providerID:'workbench',modelID:model.model},parts:[]}];
    assert.equal(parseOpenCodeMessages(native(kimi),'session',initialUserText,'project-read',kimi).messages.length,2);
    assert.equal(parseOpenCodeMessages(native(deepseek),'session',initialUserText,'project-read',deepseek).messages.length,2);
    assert.throws(()=>parseOpenCodeMessages(native(deepseek),'session',initialUserText,'project-read',kimi));
  } finally { client.dispose(); }
});
