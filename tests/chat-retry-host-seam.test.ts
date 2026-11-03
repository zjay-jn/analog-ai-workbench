import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createModelSettings} from '../apps/desktop/src/main/cloud/model-settings-host';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {createProjectReadModelSnapshots,createProjectReadRuntime} from '../apps/desktop/src/main/agent-project-read/runtime';
import * as nativeModule from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import * as clientModule from '../apps/desktop/src/main/engine-pilot/opencode-client';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import type {ProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import type {ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import {parseProjectReadSse,projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk} from '../apps/desktop/src/shared/agent/chat-sessions';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import type {ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';

// Real settings -> host -> coordinator -> runtime -> gateway, with synthetic native
// scheduling and in-memory transports. Native SessionRetry itself is a separate QA gate.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'retry',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const model={provider:'kimi',model:'kimi-k3'} as const,tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(done:()=>boolean){for(let n=0;n<100;n++){if(done())return;await tick();}assert.fail('synthetic retry seam did not settle');}
const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta,finish_reason}]})+'\n\n';
const finalWire=()=>frame({role:'assistant',content:'Synthetic success'})+frame({},'stop')+'data: [DONE]\n\n';
const toolWire=()=>frame({role:'assistant',tool_calls:[{index:0,id:'once',type:'function',function:{name:'pilot_sum',arguments:'{"values":[1,2]}'}}]})+frame({},'tool_calls')+'data: [DONE]\n\n';
const sum:ProjectReadToolResult={ok:true,value:{kind:'sum',sum:3,count:2,source:'deterministic-local',toolVersion:'pilot.sum.v1'}};

for(const mode of ['healthy','request','idle','stop_backoff','total_backoff'] as const)test('chat retry seam '+mode,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let handler!:(req:http.IncomingMessage,res:http.ServerResponse)=>Promise<void>,dispatches=0,starts=0,tools=0,backoff=false,settingsWrites=0,cleanup=0,schedulerError:unknown;
 const streams:ReadableStreamDefaultController<Uint8Array>[]=[],sent:string[]=[];
 class Server extends EventEmitter{listen(_p:number,_h:string,ready:()=>void){ready();return this;}address(){return {port:43123};}close(done:()=>void){done();return this;}}
 t.mock.method(http,'createServer',((listener:typeof handler)=>{handler=listener;return new Server();}) as unknown as typeof http.createServer);
 t.mock.method(clientModule,'createOpenCodePilotClient',()=>({}) as ReturnType<typeof clientModule.createOpenCodePilotClient>);
 t.mock.method(nativeModule,'createProjectReadNativeEngine',({services}:{services:ProjectReadProviderServices})=>({
  health:async()=>true,answer:async()=>{},dispose(){},shutdown:async()=>{},stop:async()=>{cleanup++;},
  async start(input:ProjectReadEngineInput){starts++;const run=services.begin({runId:input.runId,goal:'synthetic',constraint:'',initialUserText:input.prompt.initialUserText,systemText:input.prompt.systemText,workCycle:true,chatContext:input.chatContext!,onTool:async()=>{tools++;return sum;},onFailure:()=>input.callbacks.notice({type:'failed'})});run.bindSession('native');input.callbacks.notice({type:'started',sessionId:'native'});
   const abort=()=>services.end(input.runId);input.signal.addEventListener('abort',abort,{once:true});
   async function post(value:unknown,tool=false){const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{headers:{authorization:'Bearer '+(tool?services.toolToken:services.providerToken),'content-type':'application/json'},url:tool?'/tool':'/v1/chat/completions',method:'POST',socket:{remoteAddress:'127.0.0.1',setTimeout(){}}});
    class Reply extends EventEmitter{status=0;body='';destroyed=false;headersSent=false;writableEnded=false;writeHead(n:number){this.status=n;this.headersSent=true;return this;}write(s:string){this.body+=s;return true;}end(s=''){this.body+=s;this.writableEnded=true;return this;}destroy(){this.destroyed=true;return this;}}
    const res=new Reply();await handler(req as unknown as http.IncomingMessage,res as unknown as http.ServerResponse);return res;
   }
   const messages:unknown[]=[{role:'user',content:input.prompt.initialUserText}],body=()=>({model:model.model,stream:true,tools:projectReadTools(true),messages});
   try{let reply=await post(body());
    if(mode==='healthy'){assert.equal(reply.status,200);const parsed=parseProjectReadSse(reply.body,8192,model,{maxOutputTokens:8192,timeoutMs:120000});assert.equal(parsed.calls.length,1);
     const result=await post({sessionID:'native',messageID:'assistant',callID:'once',toolName:'pilot_sum',arguments:{values:[1,2]}},true);assert.equal(result.status,200);
     messages.push({role:'assistant',content:null,tool_calls:[{id:'once',type:'function',function:{name:'pilot_sum',arguments:'{"values":[1,2]}'}}]},{role:'tool',tool_call_id:'once',content:JSON.stringify(sum)});reply=await post(body());
    }else{assert.equal(reply.status,mode==='request'||mode==='idle'?504:503);backoff=true;
     const resume=await new Promise<boolean>(resolve=>{const stop=()=>{clearTimeout(timer);resolve(false);};const timer=setTimeout(()=>{input.signal.removeEventListener('abort',stop);resolve(true);},60000);input.signal.addEventListener('abort',stop,{once:true});});
     if(!resume)return;backoff=false;reply=await post(body());
    }
    assert.equal(reply.status,200);input.callbacks.notice({type:'text',messageId:'final',step:2,text:'Synthetic success'});input.callbacks.notice({type:'completed'});
   }catch(error){schedulerError=error;throw error;}finally{input.signal.removeEventListener('abort',abort);services.end(input.runId);}
  },
 }));
 const requestTimeoutMs=mode==='request'?30000:120000;
 const provider={model:model.model,source:'file' as const,ciphertext:'',maxOutputTokens:8192,timeoutMs:requestTimeoutMs};
 const settings=createModelSettings({root:'C:/work/analog_ai_workbench',directory:'unused',legacyKeys:{kimi:'sk-synthetic_retry_1234'},encryption:{available:()=>false,encrypt:()=>'',decrypt:()=>''},store:{load:()=>({version:2,kimi:provider,deepseek:{...provider,model:'deepseek-v4-flash'}}),save(){settingsWrites++;}}});
 const models=createProjectReadModelSnapshots(settings,{load:()=>model,save:()=>{}});
 const runtime=createProjectReadRuntime({models,workCycle:true,conversation:true,fetchImpl:async(_url,init)=>{dispatches++;sent.push(String(init.body));
  if(dispatches>1&&mode!=='healthy')return new Response(finalWire(),{headers:{'content-type':'text/event-stream'}});
  if(mode==='stop_backoff'||mode==='total_backoff')return new Response('discard upstream details',{status:503});
  if(mode==='request')return new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(Error('synthetic request aborted')),{once:true}));
  return new Response(new ReadableStream({start(c){streams.push(c);c.enqueue(new TextEncoder().encode(': accepted\n\n'));}}),{headers:{'content-type':'text/event-stream'}});
 },startNative:async()=>({port:43124,password:'c'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/unused-synthetic',pid:12345,health:async()=>true,diagnostics:()=>({stdoutBytes:0,stderrBytes:0,outputLimitExceeded:false,markers:[]}),exited:new Promise(()=>{}),stop:async()=>({exited:true,code:0,signal:null})})});
 const forbidden=():never=>{throw Error('unexpected project IO');};
 const project={captureChat:(projectId:string)=>({projectId,scope:null,wsl:Promise.resolve(null),commandEnvironmentVersion:'a'.repeat(64)}),createChatEngine:()=>runtime,attachChat:forbidden,finishChat:forbidden,answerChat:forbidden,chatRun:()=>null,chatRuns:()=>[]} as unknown as ProjectReadHost;
 const arbiter=createAgentRuntimeArbiter();let host:ReturnType<typeof createSessionHost>,disk:SessionDisk={version:6,selectedId:null,sessions:[]};
 const service=createUnifiedChatCoordinator({project,arbiter,workspace:emptyWorkspace,getSession:id=>host.getSession(id),plain:forbidden});
 host=createSessionHost({owner,configured:settings.configured,replyLimits:()=>({...settings.replyLimits('kimi'),...(mode==='total_backoff'?{turnTimeoutMs:30000}:{})}),store:{load:()=>structuredClone(disk),save(value){disk=parseSessionDisk(value);}},execute:forbidden,executeMultimodal:forbidden,turns:service});
 const turn=()=>disk.sessions[0]!.turns[0]!;
 try{const created=host.invoke(owner,'createSession',{contractVersion:SESSION_VERSION,provider:'kimi',title:'synthetic retry'});assert(created.ok);const sessionId=created.value.selectedId!,requestId=randomUUID();
  assert(host.invoke(owner,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId,text:'synthetic only'}).ok);await until(()=>dispatches===1);await tick();
  if(mode==='healthy'){
   t.mock.timers.tick(50000);streams[0]!.enqueue(new TextEncoder().encode(': progress\n\n'));await tick();t.mock.timers.tick(25000);streams[0]!.enqueue(new TextEncoder().encode(toolWire()));streams[0]!.close();await until(()=>dispatches===2||!!schedulerError);assert.equal(schedulerError,undefined);await tick();
   t.mock.timers.tick(50001);await tick();assert(host.isRunning());assert.equal(turn().status,'running');assert.equal(turn().limits!.turnTimeoutMs,null);streams[1]!.enqueue(new TextEncoder().encode(finalWire()));streams[1]!.close();
  }else{
   if(mode==='request'||mode==='idle'){t.mock.timers.tick(mode==='request'?30000:60000);await until(()=>backoff);}else await until(()=>backoff);
   assert(host.isRunning());assert.equal(turn().status,'running');assert.equal(turn().error,'');assert.equal(turn().stopReason,undefined);assert.equal(dispatches,1);
   if(mode==='stop_backoff')assert(host.invoke(owner,'cancelReply',{contractVersion:SESSION_VERSION,sessionId,turnId:requestId}).ok);
   else t.mock.timers.tick(mode==='total_backoff'?30000:60000);
  }
  await until(()=>!host.isRunning());assert.equal(starts,1);assert.equal(settingsWrites,0);assert.equal(turn().execution!.cleanupState,'idle');
  if(mode==='stop_backoff'||mode==='total_backoff'){assert.equal(turn().status,mode==='stop_backoff'?'cancelled':'failed');assert.equal(turn().stopReason,mode==='stop_backoff'?undefined:'turn_timeout');t.mock.timers.tick(120000);await tick();assert.equal(dispatches,1);}
  else {assert.equal(turn().status,'completed');assert.equal(turn().stopReason,undefined);assert.equal(turn().error,'');assert.equal(dispatches,2);assert.equal(tools,mode==='healthy'?1:0);if(mode!=='healthy')assert.equal(sent[0],sent[1]);}
  assert.equal(cleanup,1);
 }finally{host.revoke();await tick();await arbiter.close();models.close();settings.dispose();t.mock.timers.reset();}
});
