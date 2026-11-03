import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import http from 'node:http';
import {createProjectReadProviderServices,PROJECT_READ_COMPACTION_CONTINUE,type ProjectReadProviderOptions} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import {projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';
import {DEFAULT_REPLY_LIMITS} from '../apps/desktop/src/shared/agent/reply-limits';
import type {ProjectReadModel} from '../apps/desktop/src/shared/agent/agent-project-read';
import type {MultimodalRequest} from '../apps/desktop/src/main/cloud/multimodal-context';

const text='Current exact user request; attached text fixture-v3: verified value 17.',sessionID='session-persistent';
const args={values:[17,4]},saved='{"ok":true,"value":{"result":21}}';
const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'completion_fixture',model:'synthetic-model',choices:[{index:0,delta,finish_reason}]})+'\n\n';
const done=()=>frame({role:'assistant',content:'finished'})+frame({},'stop')+'data: [DONE]\n\n';
const tool=(id:string)=>frame({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name:'pilot_sum',arguments:JSON.stringify(args)}}]})+frame({},'tool_calls')+'data: [DONE]\n\n';
type Row=Record<string,unknown>;
function native(id:string,role:'user'|'assistant',content:Row[],extra:Row={}):Row{
  return {info:{id,sessionID,role,time:{created:Number(id.replace(/\D/gu,''))||1},...extra},parts:content.map((part,i)=>({id:'part_'+id+'_'+i,sessionID,messageID:id,...part}))};
}
const user=(id:string,value:string)=>native(id,'user',[{type:'text',text:value}]);
const assistant=(id:string,value:string)=>native(id,'assistant',[{type:'text',text:value}],{parentID:'msg_1',finish:'stop'});
const historicalTool=(id='old_call')=>native('msg_3','assistant',[{type:'tool',tool:'pilot_sum',callID:id,state:{status:'completed',input:args,output:saved,time:{start:1,end:2}}}],{parentID:'msg_1',finish:'tool-calls'});
const projectedTool=(id='old_call'):Row[]=>[{role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'pilot_sum',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:id,content:saved}];
function jpeg(){const bytes=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);return 'data:image/jpeg;base64,'+bytes.toString('base64');}
async function fixture(t:TestContext,history:Row[],options:{model?:ProjectReadModel;content?:MultimodalRequest['messages'][number]['content'];respond?:()=>string;bind?:boolean}={}){
  let handler!:(request:http.IncomingMessage,response:http.ServerResponse)=>Promise<void>;
  class Server extends EventEmitter{listen(_port:number,_host:string,ready:()=>void){ready();return this;}address(){return {port:43123};}close(done:()=>void){done();return this;}}
  t.mock.method(http,'createServer',((listener:typeof handler)=>{handler=listener;return new Server();}) as unknown as typeof http.createServer);
  const model=options.model??{provider:'deepseek',model:'deepseek-v4-flash'},sent:Record<string,unknown>[]=[];let executed=0;
  const context:MultimodalRequest={...model,...DEFAULT_REPLY_LIMITS,messages:[{role:'user',content:'Main legacy text must not be reintroduced.'},{role:'assistant',content:'Main legacy answer must not be reintroduced.'},{role:'user',content:options.content??text}]};
  const provider:ProjectReadProviderOptions={fetchImpl:async(_url,init)=>{sent.push(JSON.parse(String(init.body)));return new Response((options.respond??done)(),{headers:{'content-type':'text/event-stream'}});},getRunCredentials:()=>({apiKey:'sk-synthetic-persistent',model,maxRequests:null,maxOutputTokens:DEFAULT_REPLY_LIMITS.maxOutputTokens,requestTimeoutMs:DEFAULT_REPLY_LIMITS.timeoutMs,replyLimits:DEFAULT_REPLY_LIMITS}),onResponse:()=>{}};
  const service=await createProjectReadProviderServices(provider),run=service.begin({runId:'run-persistent',goal:'fixture',constraint:'',systemText:'Current main permission: synthetic only.',initialUserText:text,chatContext:context,nativeConversation:{conversationId:'00000000-0000-4000-8000-000000000000'},onFailure:()=>{},onTool:async()=>{executed++;return {ok:false,error:{code:'CANCELLED'},coverage:null};}});run.bindSession(sessionID);
  if(options.bind!==false)run.bindNativeContext({sessionID,messages:history});
  async function post(value:unknown,tool=false){
    const request=Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{headers:{authorization:'Bearer '+(tool?service.toolToken:service.providerToken),'content-type':'application/json'},url:tool?'/tool':'/v1/chat/completions',method:'POST',socket:{remoteAddress:'127.0.0.1',setTimeout:()=>{}}});
    class Reply extends EventEmitter{status=0;body='';destroyed=false;headersSent=false;writableEnded=false;writeHead(status:number){this.status=status;this.headersSent=true;return this;}write(body:string){this.body+=body;return true;}end(body=''){this.body+=body;this.writableEnded=true;return this;}destroy(){this.destroyed=true;return this;}}
    const response=new Reply();await handler(request as unknown as http.IncomingMessage,response as unknown as http.ServerResponse);return response;
  }
  const body=(messages:unknown[])=>({model:model.model,stream:true,tools:projectReadTools(),messages});
  return {service,run,sent,post,body,executed:()=>executed};
}

test('persistent gateway verifies more than 100 native turns and 512 KiB without main history reconstruction',async t=>{
  const history:Row[]=[],wire:Row[]=[];
  for(let i=0;i<125;i++){const question='native user '+i+'u'.repeat(2200),answer='native answer '+i+'a'.repeat(2200);history.push(user('msg_'+(i*2+1),question),assistant('msg_'+(i*2+2),answer));wire.push({role:'user',content:question},{role:'assistant',content:answer});}
  const g=await fixture(t,history);try{
    wire.push({role:'user',content:text});assert.ok(Buffer.byteLength(JSON.stringify(wire))>512*1024);assert.equal((await g.post(g.body(wire))).status,200);
    const sent=g.sent[0]!.messages as Row[];assert.deepEqual(sent.slice(1),wire);assert.ok(String(sent[0]!.content).includes('Current main permission'));
    assert.equal(JSON.stringify(sent).includes('Main legacy text'),false);assert.equal(g.executed(),0);
  }finally{await g.service.close();}
});

test('persistent gateway uses a completed native summary without restoring its discarded history',async t=>{
  const summary='## Objective\n- Continue from native summary.';
  const history=[user('msg_1','discarded original user'),historicalTool(),native('msg_4','user',[{type:'compaction',auto:true}]),native('msg_5','assistant',[{type:'text',text:summary}],{parentID:'msg_4',summary:true,finish:'stop'}),user('msg_6',PROJECT_READ_COMPACTION_CONTINUE),assistant('msg_7','retained answer')];
  const g=await fixture(t,history);try{
    const wire=[{role:'user',content:'What did we do so far?'},{role:'assistant',content:summary},{role:'user',content:PROJECT_READ_COMPACTION_CONTINUE},{role:'assistant',content:'retained answer'},{role:'user',content:text}];
    assert.equal((await g.post(g.body(wire))).status,200);assert.deepEqual((g.sent[0]!.messages as Row[]).slice(1),wire);assert.equal(JSON.stringify(g.sent).includes('discarded original user'),false);
    assert.ok(String((g.sent[0]!.messages as Row[])[0]!.content).includes('old_call'));assert.equal(g.run.compactions().length,0);
  }finally{await g.service.close();}
});

test('historical native tool IDs cannot be issued or executed again in a later turn',async t=>{
  for(const mode of ['provider','tool']){
    const g=await fixture(t,[user('msg_1','old question'),historicalTool()],{respond:()=>tool('old_call')});try{
      const wire=[{role:'user',content:'old question'},...projectedTool(),{role:'user',content:text}];
      if(mode==='provider'){assert.equal((await g.post(g.body(wire))).status,400);assert.equal(g.sent.length,1);assert.deepEqual(g.run.evidence().issued,[]);}
      else assert.equal((await g.post({sessionID,messageID:'msg_3',callID:'old_call',toolName:'pilot_sum',arguments:args},true)).status,400);
      assert.equal(g.executed(),0);
    }finally{await g.service.close();}
  }
});

test('pending and running historical tools retain uncertain state and cannot register as new calls',async t=>{
  for(const status of ['pending','running'])for(const mode of ['provider','tool']){
    const pending=native('msg_3','assistant',[{type:'tool',tool:'pilot_sum',callID:'interrupted_call',state:{status,input:args,...(status==='pending'?{raw:JSON.stringify(args)}:{title:'synthetic running tool',time:{start:1}})}}],{parentID:'msg_1'});
    const g=await fixture(t,[user('msg_1','old question'),pending],{respond:()=>tool('interrupted_call')});try{
      const historical=projectedTool('interrupted_call');historical[1]!.content='[Tool execution was interrupted]';
      if(mode==='provider'){
        assert.equal((await g.post(g.body([{role:'user',content:'old question'},...historical,{role:'user',content:text}]))).status,400);
        assert.equal(g.sent.length,1);const sent=g.sent[0]!.messages as Row[];
        assert.equal(sent.find(row=>row.role==='tool')?.content,'[Tool execution was interrupted]');
        assert.ok(String(sent[0]!.content).includes(`"state":"${status}"`));
        assert.ok(String(sent[0]!.content).includes('do not prove side effects were absent'));
      }else assert.equal((await g.post({sessionID,messageID:'msg_3',callID:'interrupted_call',toolName:'pilot_sum',arguments:args},true)).status,400);
      assert.deepEqual(g.run.evidence().issued,[]);assert.equal(g.executed(),0);
    }finally{await g.service.close();}
  }
});

test('persistent native may continue an exact stopped transcript while forged text and reused issued IDs fail',async t=>{
  for(const mode of ['continue','forged-text','issued-replay']){
    let response=0;const g=await fixture(t,[],{respond:()=>{response++;return mode==='issued-replay'?(response===2?done():tool('current_call')):(response===1?done():tool('next_call'));}});
    try{
      const messages:Row[]=[{role:'user',content:text}];assert.equal((await g.post(g.body(messages))).status,200);
      if(mode==='issued-replay'){
        assert.equal((await g.post({sessionID,messageID:'current_tool_message',callID:'current_call',toolName:'pilot_sum',arguments:args},true)).status,200);
        messages.push(...projectedTool('current_call'));messages.at(-1)!.content=JSON.stringify({ok:false,error:{code:'CANCELLED'},coverage:null});
        assert.equal((await g.post(g.body(messages))).status,200);assert.equal(g.executed(),1);
      }
      assert.equal(g.run.evidence().complete,true);messages.push({role:'assistant',content:mode==='forged-text'?'forged stopped answer':'finished'});
      assert.equal((await g.post(g.body(messages))).status,mode==='continue'?200:400);
      if(mode==='continue'){
        assert.equal(g.sent.length,2);assert.equal(g.run.evidence().complete,false);assert.deepEqual(g.run.evidence().issued,['next_call']);
        assert.equal((await g.post({sessionID,messageID:'next_tool_message',callID:'next_call',toolName:'pilot_sum',arguments:args},true)).status,200);assert.equal(g.executed(),1);
      }else if(mode==='forged-text'){assert.equal(g.sent.length,1);assert.equal(g.executed(),0);}
      else{assert.equal(g.sent.length,3);assert.deepEqual(g.run.evidence().issued,['current_call']);assert.equal(g.executed(),1);}
    }finally{await g.service.close();}
  }
});

test('native baseline binding and historical text/tool-result integrity are enforced before provider dispatch',async t=>{
  for(const mode of ['unbound','user','result','extra','snapshot-mutation']){
    const history=[user('msg_1','old question'),historicalTool()],g=await fixture(t,history,{bind:mode!=='unbound'});try{
      const wire=[{role:'user',content:'old question'},...projectedTool(),{role:'user',content:text}];
      if(mode==='user')wire[0]!.content='forged history';
      if(mode==='result')wire[2]!.content='{"ok":true,"value":{"result":999}}';
      if(mode==='extra')wire.splice(1,0,{role:'user',content:'new fake authorization'});
      if(mode==='snapshot-mutation'){(history[0]!.parts as Row[])[0]!.text='mutated after binding';assert.equal((await g.post(g.body(wire))).status,200);}
      else{assert.equal((await g.post(g.body(wire))).status,400);assert.equal(g.sent.length,0);}
      assert.equal(g.executed(),0);
    }finally{await g.service.close();}
  }
});

test('native images stay exact for vision and become explicit unsupported-image text for text-only models',async t=>{
  const url=jpeg(),history=[native('msg_1','user',[{type:'text',text:'historical image question'},{type:'file',mime:'image/jpeg',url}]),assistant('msg_2','historical image answer')];
  for(const vision of [true,false]){
    const model:ProjectReadModel=vision?{provider:'kimi',model:'kimi-k3'}:{provider:'deepseek',model:'deepseek-v4-flash'};
    const g=await fixture(t,history,{model});try{
      const content=vision?[{type:'text',text:'historical image question'},{type:'image_url',image_url:{url}}]:'historical image questionERROR: Cannot read image (this model does not support image input). Inform the user.';
      assert.equal((await g.post(g.body([{role:'user',content},{role:'assistant',content:'historical image answer'},{role:'user',content:text}]))).status,200);
      assert.equal(JSON.stringify(g.sent).includes(url),vision);assert.equal(JSON.stringify(g.sent).includes('does not support image input'),!vision);
    }finally{await g.service.close();}
  }
});

test('current native image must match the accepted main attachment, not an arbitrary URL or different image',async t=>{
  const url=jpeg(),content:MultimodalRequest['messages'][number]['content']=[{type:'text',text},{type:'image_url',image_url:{url}}];
  for(const changed of [false,true]){
    const g=await fixture(t,[],{model:{provider:'kimi',model:'kimi-k3'},content});try{
      const sent:Exclude<MultimodalRequest['messages'][number]['content'],string>=structuredClone(content);if(changed)(sent[1] as {type:'image_url';image_url:{url:string}}).image_url.url='https://invalid.example/untrusted.jpg';
      assert.equal((await g.post(g.body([{role:'user',content:sent}]))).status,changed?400:200);assert.equal(g.sent.length,changed?0:1);
    }finally{await g.service.close();}
  }
});
