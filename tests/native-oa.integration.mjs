// Explicit integration: pinned native OpenCode + real saved OA copy + local scripted provider.
// No external model/API requests or source engineering writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(root.toLowerCase(),'c:\\work\\analog_ai_workbench');
assert.equal(process.version,'v24.20.0');
const compiled=rel=>require(path.join(root,'.local/test-build/apps/desktop/src',rel));
const {createProjectReadRuntime}=compiled('main/agent-project-read/runtime.js');
const {startOpenCodeSupervisor}=compiled('main/engine-pilot/opencode-supervisor.js');
const {createOaReadRuntime}=compiled('main/oa-read/runtime.js');
const {createReviewedSourceLoader}=compiled('main/schematic/reviewed-source-loader.js');
const {parseProjectReadToolResult}=compiled('shared/agent/agent-project-read-validation.js');
const {projectToolSystem}=compiled('main/agent-project-read/host.js');
const directory=path.join(root,'.local/oa-query-location-20261028','native-'+Date.now());fs.mkdirSync(directory,{recursive:true});
const model={provider:'kimi',model:'kimi-k3'},conversationId=randomUUID(),projectId=randomUUID(),frozen=new Map(),turns=[];
let current,totalRequests=0,runtime;
const models={status:()=>({model,canStart:true,reason:null}),freeze(){throw Error('Expected chat model snapshot');},
  freezeChat(runId,selected,limits){assert.deepEqual(selected,model);frozen.set(runId,{apiKey:'synthetic-local-oa-test',model,maxRequests:null,maxOutputTokens:limits.maxOutputTokens,requestTimeoutMs:limits.timeoutMs,replyLimits:limits});return model;},
  get(runId){assert(frozen.has(runId));return frozen.get(runId);},forget:id=>frozen.delete(id),close:()=>frozen.clear()};
const response=(owner,call,text='')=>{
  const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'oa_'+owner.runId+'_'+owner.requests,object:'chat.completion.chunk',model:model.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:'call_'+randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{role:'assistant',content:text};
  return new Response(frame(delta)+frame({},call?'tool_calls':'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
};
runtime=createProjectReadRuntime({models,workCycle:true,conversation:true,startNative:startOpenCodeSupervisor,fetchImpl:async(url,init)=>{
  assert.equal(url,'https://api.moonshot.cn/v1/chat/completions'); // intercepted here; never sent to the network
  const owner=current;assert(owner);owner.requests++;totalRequests++;assert(totalRequests<=8,'No unintended replay');
  const body=JSON.parse(init.body);assert.equal(body.model,model.model);assert(body.tools.some(t=>t.function.name==='oa_open_design'));
  if(owner.requests===1)return response(owner,{name:'oa_open_design',args:{designId:'folded-cascode-copy',refresh:false}});
  const first=owner.results[0]?.value;assert.equal(first?.kind,'oa_read');
  const bound={designHandle:first.source.designHandle,savedRevision:first.source.savedRevision};
  if(owner.requests===2)return response(owner,{name:owner.kind==='device'?'oa_query_instances':'oa_query_nets',args:{...bound,selector:{kind:'exact_name',name:owner.kind==='device'?'M1':'VIN'},...(owner.kind==='net'?{section:'summary'}:{}),cursor:null}});
  const found=owner.results[1]?.value;assert.equal(found?.data.items.length,1);
  if(owner.requests===3)return response(owner,{name:owner.kind==='device'?'oa_describe_device':'oa_query_nets',args:owner.kind==='device'
    ?{...bound,instanceId:found.data.items[0].id,section:'parameters',cursor:null}
    :{...bound,selector:{kind:'id',objectId:found.data.items[0].id},section:'members',cursor:null}});
  assert.equal(owner.requests,4);const result=owner.results[2].value;
  assert(JSON.stringify(body.messages).includes(result.evidenceId),'Actual tool result must reach continuation');
  assert(result.displayReferences?.length,'Verified answer navigation required');
  return response(owner,null,`${owner.kind==='device'?'M1 保存参数':'VIN 网络成员'}查询完成，共 ${result.data.items.length} 项。[原理图:${result.evidenceId}]`);
}});
try{
  for(const kind of ['device','net']){
    const runId='oa-integration-'+randomUUID(),abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),150000);
    const owner=current={runId,kind,requests:0,results:[],calls:[],events:[]};
    const oa=createOaReadRuntime({runId,projectId,loadReviewed:createReviewedSourceLoader(root)});
    runtime.acceptChat(runId,model,{maxOutputTokens:8192,timeoutMs:120000});
    try{
      const text=kind==='device'?'查询现有 FOLDED_CASCODE 本地副本中 M1 的保存参数。':'查询同一电路副本中 VIN 网络连接的器件和端口。';
      await runtime.start({runId,model,signal:abort.signal,workCycle:true,chatContext:{...model,maxOutputTokens:8192,timeoutMs:120000,messages:[{role:'user',content:text}]},nativeConversation:{conversationId,legacyMessages:[]},
        prompt:{goal:text,constraint:'只读现有电路副本。',rules:'Use the registered read-only OA tools for the selected saved copy.',systemText:projectToolSystem(true),initialUserText:text},
        callbacks:{notice:e=>owner.events.push(e),questionDelivered:async()=>{throw Error('Unexpected question');},tool:async call=>{
          assert(call.toolName.startsWith('oa_'));assert(!owner.calls.includes(call.callId),'No duplicate physical tool execution');owner.calls.push(call.callId);
          const result=await oa.execute({toolName:call.toolName,arguments:call.arguments},abort.signal);
          assert(parseProjectReadToolResult(result),'Main/shared result validation');assert(result.ok,JSON.stringify(result));owner.results.push(result);return result;
        }}});
      assert(!abort.signal.aborted);assert.equal(owner.events.at(-1)?.type,'completed',JSON.stringify(owner.events.slice(-3)));
      assert.equal(owner.calls.length,3);assert.equal(owner.requests,4);
      const result=owner.results[2].value;assert.equal(result.source.dirty.status,'unknown');assert.equal(result.coverage.complete,true);
      const sessionId=owner.events.find(e=>e.type==='started')?.sessionId;assert(sessionId);if(turns.length)assert.equal(sessionId,turns[0].sessionId);
      const accounting=runtime.accounting(runId);assert.equal(accounting.httpDispatches,4);
      turns.push({...owner,sessionId,accounting,answer:owner.events.filter(e=>e.type==='text').map(e=>e.text).join('')});
    }finally{clearTimeout(deadline);await runtime.stop(runId);abort.abort();await oa.close();}
  }
  await runtime.shutdown();
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({status:'PASS',externalModelRequests:0,scriptedProviderRequests:totalRequests,turns},null,2));
  console.log(JSON.stringify({status:'PASS',directory,turns:turns.length,scriptedProviderRequests:totalRequests,externalModelRequests:0}));
}catch(error){
  try{await runtime.shutdown();}catch{}
  fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({status:'FAIL',message:String(error),totalRequests,current,turns},null,2));throw error;
}
