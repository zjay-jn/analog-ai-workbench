import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {createProjectReadModelSnapshots,createProjectReadRuntime} from '../apps/desktop/src/main/agent-project-read/runtime';
import * as nativeModule from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import * as clientModule from '../apps/desktop/src/main/engine-pilot/opencode-client';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import type {ProjectReadProviderServices} from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import type {ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import {projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk} from '../apps/desktop/src/shared/agent/chat-sessions';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import {DEFAULT_REPLY_LIMITS} from '../apps/desktop/src/shared/agent/reply-limits';

// Real gateway -> runtime accounting -> coordinator -> session host. The native,
// HTTP listener, provider transport and stores are memory-only: no sockets or processes.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'seam',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const model={provider:'kimi',model:'kimi-k3'} as const,tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(done:()=>boolean){for(let n=0;n<100;n++){if(done())return;await tick();}assert.fail('synthetic seam did not settle');}

for(const mode of ['request','first','idle'] as const)for(const nativeEnd of ['throw','return'] as const)test('trusted '+mode+' fault after synthetic native terminal survives '+nativeEnd+' and late cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let handler!:(req:http.IncomingMessage,res:http.ServerResponse)=>Promise<void>,dispatches=0,starts=0,stops=0,bodyCancelled=false;
 let release!:()=>void;const cleanup=new Promise<void>(resolve=>{release=resolve;});
 class Server extends EventEmitter{listen(_p:number,_h:string,ready:()=>void){ready();return this;}address(){return {port:43123};}close(done:()=>void){done();return this;}}
 t.mock.method(http,'createServer',((listener:typeof handler)=>{handler=listener;return new Server();}) as unknown as typeof http.createServer);
 t.mock.method(clientModule,'createOpenCodePilotClient',()=>({}) as ReturnType<typeof clientModule.createOpenCodePilotClient>);
 t.mock.method(nativeModule,'createProjectReadNativeEngine',({services}:{services:ProjectReadProviderServices})=>({
  health:async()=>true,answer:async()=>{},dispose(){},shutdown:async()=>{},stop:async()=>{stops++;await cleanup;},
  async start(input:ProjectReadEngineInput){starts++;const run=services.begin({runId:input.runId,goal:'synthetic',constraint:'',initialUserText:input.prompt.initialUserText,systemText:input.prompt.systemText,workCycle:true,chatContext:input.chatContext!,onTool:input.callbacks.tool,onFailure:()=>{}});run.bindSession('synthetic-native');input.callbacks.notice({type:'started',sessionId:'synthetic-native'});
   const value={model:model.model,stream:true,tools:projectReadTools(true),messages:[{role:'user',content:input.prompt.initialUserText}]};
   const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{headers:{authorization:'Bearer '+services.providerToken,'content-type':'application/json'},url:'/v1/chat/completions',method:'POST',socket:{remoteAddress:'127.0.0.1',setTimeout(){}}});
   class Reply extends EventEmitter{status=0;body='';destroyed=false;headersSent=false;writableEnded=false;writeHead(n:number){this.status=n;this.headersSent=true;return this;}write(s:string){this.body+=s;return true;}end(s=''){this.body+=s;this.writableEnded=true;return this;}destroy(){this.destroyed=true;return this;}}
   const res=new Reply();await handler(req as unknown as http.IncomingMessage,res as unknown as http.ServerResponse);assert.equal(res.status,504);services.finalizeFailure?.(input.runId);input.callbacks.notice({type:'failed'});await cleanup;if(nativeEnd==='throw')throw Error('synthetic native wraps provider failure');
  },
 }));
 const models=createProjectReadModelSnapshots({key:()=> 'sk-synthetic_timeout_1234',defaultModel:()=>model.model,read:()=>({ok:true,value:{storage:'ready',encryptionAvailable:false,providers:[{...model,address:'https://api.moonshot.cn/v1',configured:true,source:'file',...DEFAULT_REPLY_LIMITS}]}})},{load:()=>model,save:()=>{}});
 const runtime=createProjectReadRuntime({models,workCycle:true,conversation:true,fetchImpl:async(_url,init)=>{dispatches++;assert(!JSON.stringify(init.body).includes('turnTimeoutMs'));assert(!JSON.stringify(init.body).includes('requestTimeoutMs'));
  if(mode==='idle')return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': progress\n\n'));},cancel(){bodyCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  return new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(Error('synthetic aborted request')),{once:true}));
 },startNative:async()=>({port:43124,password:'c'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/unused-synthetic',pid:12345,health:async()=>true,diagnostics:()=>({stdoutBytes:0,stderrBytes:0,outputLimitExceeded:false,markers:[]}),exited:new Promise(()=>{}),stop:async()=>({exited:true,code:0,signal:null})})});
 const forbidden=():never=>{throw Error('unexpected project IO');};
 const project={captureChat:(projectId:string)=>({projectId,scope:null,wsl:Promise.resolve(null),commandEnvironmentVersion:'a'.repeat(64)}),createChatEngine:()=>runtime,attachChat:forbidden,finishChat:forbidden,answerChat:forbidden,chatRun:()=>null,chatRuns:()=>[]} as unknown as ProjectReadHost;
 const arbiter=createAgentRuntimeArbiter();let host:ReturnType<typeof createSessionHost>,disk:SessionDisk={version:6,selectedId:null,sessions:[]};
 const service=createUnifiedChatCoordinator({project,arbiter,workspace:emptyWorkspace,getSession:id=>host.getSession(id),plain:forbidden});
 host=createSessionHost({owner,configured:{deepseek:true,kimi:true},replyLimits:()=>({maxOutputTokens:8192,timeoutMs:mode==='request'?30000:300000,requestTimeoutMs:mode==='request'?30000:300000,turnTimeoutMs:600000}),store:{load:()=>structuredClone(disk),save(value){disk=parseSessionDisk(value);}},execute:forbidden,executeMultimodal:forbidden,turns:service});
 try{
  const created=host.invoke(owner,'createSession',{contractVersion:SESSION_VERSION,provider:'kimi',title:'synthetic timeout'});assert(created.ok);const sessionId=created.value.selectedId!,requestId=randomUUID();
  assert(host.invoke(owner,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId,text:'synthetic only'}).ok);await until(()=>dispatches===1);await tick();
  t.mock.timers.tick(mode==='request'?30000:mode==='first'?120000:60000);await until(()=>!!disk.sessions[0]!.turns[0]!.stopReason);assert.equal(stops,0,'native start is still awaiting its own cleanup');
  const expected=mode==='request'?'total_timeout':mode==='first'?'first_response_timeout':'idle_timeout',prior=disk.sessions[0]!.turns[0]!;assert.equal(prior.stopReason,expected);const error=prior.error;assert(host.isRunning());
  // A later hard deadline and user stop cannot overwrite the earlier provider fault.
  t.mock.timers.tick(900000);assert(host.invoke(owner,'cancelReply',{contractVersion:SESSION_VERSION,sessionId,turnId:requestId}).ok);assert.equal(disk.sessions[0]!.turns[0]!.error,error);release();await until(()=>!host.isRunning());
  const turn=disk.sessions[0]!.turns[0]!;assert.equal(turn.status,'failed');assert.equal(turn.stopReason,expected);assert.equal(turn.error,error);assert.equal(turn.execution!.cleanupState,'idle');assert.equal(starts,1);assert.equal(stops,1);assert.equal(dispatches,1);if(mode==='idle')assert(bodyCancelled);
  assert.equal(runtime.accounting(turn.execution!.executionId+'.tools').failureReason,mode==='request'?'TIMEOUT':mode==='first'?'FIRST_RESPONSE_TIMEOUT':'IDLE_TIMEOUT');
 }finally{release();host.revoke();await tick();await arbiter.close();models.close();t.mock.timers.reset();}
});
