import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import type {ProjectReadEngine,ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk,type SessionMethod} from '../apps/desktop/src/shared/agent/chat-sessions';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import {CONTINUE_TEXT} from '../apps/desktop/src/shared/agent/continuation';
import {CloudChatErrorV1} from '../packages/agent-adapters/src/cloud-chat-contract';

// Real session host + coordinator + arbiter. Only native and project IO are synthetic.
// This suite never opens a socket, reads credentials or starts an external process.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'coord',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(done:()=>boolean){for(let n=0;n<100;n++){if(done())return;await tick();}assert.fail('synthetic operation did not settle');}
const reply=(input:ProjectReadEngineInput,text='synthetic answer')=>{input.callbacks.notice({type:'text',messageId:'reply',step:1,text});input.callbacks.notice({type:'completed'});};
function fixture(script:(input:ProjectReadEngineInput)=>Promise<void>,initial:SessionDisk={version:6,selectedId:null,sessions:[]},options:{brokenWsl?:boolean;brokenToolStore?:boolean;stop?:()=>Promise<void>;turnTimeoutMs?:number}={}){
 let disk=parseSessionDisk(initial),stops=0,attachments=0,current:ProjectReadEngineInput|undefined,answerHook:((question:string,answer:string)=>Promise<void>)|undefined;
 const starts:ProjectReadEngineInput[]=[];
 const engine:ProjectReadEngine={dispose(){},shutdown:async()=>{},health:async()=>true,status:()=>({model:{provider:'kimi',model:'kimi-k3'},canStart:true,processState:'ready',reason:null}),
  accept:(_id,model)=>model,acceptChat:(_id,model)=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:1,httpDispatches:0,contextBytes:0}),
  start:async input=>{current=input;starts.push(input);input.callbacks.notice({type:'started',sessionId:'native-'+starts.length});await script(input);},
  answer:async(_run,q,a)=>{assert.equal(disk.sessions[0]!.turns.at(-1)!.execution!.clarifications!.at(-1)!.answer,a,'answer must be durable before native dispatch');if(answerHook)await answerHook(q,a);else await current!.callbacks.questionDelivered(q);},
  stop:async()=>{stops++;await options.stop?.();},
 };
 const forbidden=():never=>{throw Error('unexpected project IO');};
 const project={captureChat:(projectId:string)=>({projectId,scope:null,wsl:options.brokenWsl?Promise.reject(Error('synthetic WSL store failure')):Promise.resolve(null),commandEnvironmentVersion:'a'.repeat(64)}),
  createChatEngine:()=>engine,attachChat:()=>{attachments++;return forbidden();},finishChat:forbidden,answerChat:forbidden,
  chatRun:()=>{if(options.brokenToolStore)throw Error('synthetic tool store failure');return null;},chatRuns:()=>{if(options.brokenToolStore)throw Error('synthetic tool store failure');return [];}} as unknown as ProjectReadHost;
 const arbiter=createAgentRuntimeArbiter();let host:ReturnType<typeof createSessionHost>;
 const service=createUnifiedChatCoordinator({project,arbiter,workspace:emptyWorkspace,getSession:id=>host.getSession(id),plain:forbidden});
 host=createSessionHost({owner,store:{load:()=>structuredClone(disk),save:value=>{disk=parseSessionDisk(structuredClone(value));}},configured:{kimi:true,deepseek:true},execute:forbidden,executeMultimodal:forbidden,turns:service,...(options.turnTimeoutMs?{replyLimits:()=>({maxOutputTokens:2048,timeoutMs:30000,requestTimeoutMs:30000,turnTimeoutMs:options.turnTimeoutMs!})}:{})});
 const invoke=<M extends SessionMethod>(method:M,args:object={})=>host.invoke(owner,method,{contractVersion:SESSION_VERSION,...args});
 const state=()=>{const result=invoke('readState');assert(result.ok);return result.value;};
 if(!disk.selectedId){assert(invoke('createSession',{provider:'kimi',title:'synthetic unified'}).ok);}
 const sessionId=state().selectedId!;
 return {host,invoke,state,starts,service,sessionId,durable:()=>structuredClone(disk),stops:()=>stops,attachments:()=>attachments,
  answerHook(hook:(question:string,answer:string)=>Promise<void>){answerHook=hook;},send(text='synthetic input'){const requestId=randomUUID();assert(invoke('sendMessage',{sessionId,requestId,text}).ok);return requestId;},
  async close(){host.revoke();await tick();await arbiter.close();},
 };
}

test('verified compaction is durable before continuing and cold history performs no execution',async()=>{
 const first={version:1,sourceHash:'d'.repeat(64),summaryHash:'e'.repeat(64),coveredResponses:27};
 const second={version:2,sourceHash:'f'.repeat(64),summaryHash:'a'.repeat(64),coveredResponses:68};
 const f=fixture(async input=>{
  input.callbacks.notice({type:'compaction',...first});
  assert.deepEqual(f.durable().sessions[0]!.turns[0]!.execution!.compaction,first);
  input.callbacks.notice({type:'compaction',...second});reply(input);
 });
 try{
  f.send('keep the original constraint');await until(()=>!f.host.isRunning());
  const saved=f.durable(),turn=saved.sessions[0]!.turns[0]!;
  assert.equal(turn.status,'completed');assert.equal(turn.user,'keep the original constraint');assert.equal(turn.assistant,'synthetic answer');assert.deepEqual(turn.execution!.compaction,second);
  const cold=fixture(async()=>assert.fail('compaction history must never launch native'),saved,{brokenToolStore:true});
  try{assert.deepEqual(cold.durable(),saved);assert.equal(cold.starts.length,0);assert.equal(cold.attachments(),0);assert.equal(cold.stops(),0);}finally{await cold.close();}
 }finally{await f.close();}
});

test('coordinator gives each turn the stable workbench conversation identity and complete current attachment text',async()=>{
 const f=fixture(async input=>reply(input));
 try{
  f.send('first native turn');await until(()=>!f.host.isRunning());
  const file={id:randomUUID(),name:'circuit-note.txt',text:'SYNTHETIC-CIRCUIT-ATTACHMENT',startLine:1,endLine:1,totalLines:1};
  assert(f.invoke('sendMessage',{sessionId:f.sessionId,requestId:randomUUID(),text:'second native turn',files:[file]}).ok);await until(()=>!f.host.isRunning());
  assert.equal(f.starts.length,2);
  assert.equal(f.starts[0]!.nativeConversation?.conversationId,f.sessionId);
  assert.equal(f.starts[1]!.nativeConversation?.conversationId,f.sessionId);
  assert.match(f.starts[1]!.prompt.initialUserText,/SYNTHETIC-CIRCUIT-ATTACHMENT/u);
  assert.deepEqual(f.starts[1]!.nativeConversation?.legacyMessages,[{role:'user',content:'first native turn'},{role:'assistant',content:'synthetic answer'}]);
 }finally{await f.close();}
});

test('nonconsecutive compaction cannot replace the durable receipt',async()=>{
 const f=fixture(async input=>{input.callbacks.notice({type:'compaction',version:2,sourceHash:'d'.repeat(64),summaryHash:'e'.repeat(64),coveredResponses:20});reply(input);});
 try{f.send();await until(()=>!f.host.isRunning());const turn=f.durable().sessions[0]!.turns[0]!;assert.equal(turn.status,'failed');assert.equal(turn.execution!.compaction,undefined);assert.equal(turn.assistant,'');}finally{await f.close();}
});

test('ordinary conversations exceed the old 32 tool-record capacity without preparing a project or querying its store',async()=>{
 const f=fixture(async input=>reply(input),undefined,{brokenToolStore:true});try{
  for(let n=0;n<34;n++){const id=f.send('ordinary '+n);await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns.at(-1)!;assert.equal(turn.status,'completed');assert.equal(turn.execution!.runLink,null);assert(f.invoke('readTurnActivity',{sessionId:f.sessionId,turnId:id,afterSequence:0}).ok);}
  assert.equal(f.starts.length,34);assert.equal(f.attachments(),0);assert.equal(f.stops(),34);
  const cold=fixture(async()=>assert.fail('cold model replay'),f.durable(),{brokenToolStore:true});try{assert.equal(cold.state().storage,'saved');assert.equal(cold.starts.length,0);}finally{await cold.close();}
 }finally{await f.close();}
});

test('native question without a directory persists delivery and next-turn roles, and survives cold read',async()=>{
 let resolveQuestion!:()=>void;const waiting=new Promise<void>(resolve=>{resolveQuestion=resolve;});let number=0;
 const f=fixture(async input=>{if(++number===1){input.callbacks.notice({type:'question',questionId:'question-1',prompt:'which synthetic value?'});await waiting;}reply(input);});
 try{
  f.answerHook(async(q)=>{await f.starts[0]!.callbacks.questionDelivered(q);resolveQuestion();});const turnId=f.send();await until(()=>f.state().activeTurn?.phase==='waiting_question');
  const interaction=f.state().selected!.turns[0]!.execution!.pendingInteraction!;assert.equal(interaction.kind,'question');
  const answer={sessionId:f.sessionId,turnId,interactionId:interaction.interactionId,requestId:randomUUID(),decision:{kind:'question',questionId:'question-1',answer:'value 7'}};
  assert(f.invoke('answerInteraction',answer).ok);assert(f.invoke('answerInteraction',answer).ok);await until(()=>!f.host.isRunning());
  assert.deepEqual(f.durable().sessions[0]!.turns[0]!.execution!.clarifications,[{questionId:'question-1',prompt:'which synthetic value?',answer:'value 7',delivered:true}]);
  f.send('follow up');await until(()=>!f.host.isRunning());assert.deepEqual(f.starts[1]!.chatContext!.messages.map(m=>[m.role,m.content]),[['user','synthetic input'],['assistant','which synthetic value?'],['user','value 7'],['assistant','synthetic answer'],['user','follow up']]);assert.equal(f.attachments(),0);
  const cold=fixture(async()=>assert.fail('cold question replay'),f.durable());try{assert.deepEqual(cold.durable(),f.durable());assert.equal(cold.starts.length,0);}finally{await cold.close();}
 }finally{resolveQuestion();await f.close();}
});

test('broken optional WSL settings do not stop ordinary model output',async()=>{
 const f=fixture(async input=>reply(input),undefined,{brokenWsl:true});try{f.send();await until(()=>!f.host.isRunning());assert.equal(f.state().selected!.turns[0]!.status,'completed');assert.equal(f.attachments(),0);}finally{await f.close();}
});

test('an actual tool request without a directory leaves a durable configuration card and releases the model',async()=>{
 const f=fixture(async input=>{await input.callbacks.tool({sessionId:'native-1',messageId:'message',callId:'call',toolName:'pilot_sum',arguments:{values:[1]}});});try{
  f.send();await until(()=>!f.host.isRunning());const e=f.state().selected!.turns[0]!.execution!;assert.equal(e.phase,'needs_configuration');assert.equal(e.pendingInteraction?.kind,'configuration');assert.equal(e.cleanupState,'idle');assert.equal(e.runLink,null);assert.equal(f.stops(),1);assert.equal(f.attachments(),0);
  const cold=fixture(async()=>assert.fail('configuration replay'),f.durable());try{assert.equal(cold.state().selected!.turns[0]!.execution!.pendingInteraction?.kind,'configuration');assert.equal(cold.starts.length,0);}finally{await cold.close();}
 }finally{await f.close();}
});

test('exact stop remains active until native cleanup resolves',async()=>{
 let finishStop!:()=>void;const stop=new Promise<void>(resolve=>{finishStop=resolve;});const f=fixture(input=>new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true})),undefined,{stop:()=>stop});
 try{const turnId=f.send();await until(()=>f.starts.length===1);assert(f.invoke('cancelReply',{sessionId:f.sessionId,turnId}).ok);await until(()=>f.stops()===1);assert.equal(f.host.isRunning(),true);assert.equal(f.state().activeTurn?.phase,'stopping');assert.equal(f.invoke('sendMessage',{sessionId:f.sessionId,requestId:randomUUID(),text:'too early'}).ok,false);finishStop();await until(()=>!f.host.isRunning());assert.equal(f.state().selected!.turns[0]!.status,'cancelled');assert.equal(f.state().selected!.turns[0]!.execution!.cleanupState,'idle');}
 finally{finishStop();await f.close();}
});

test('an explicit text continuation keeps each interrupted segment and its delivered clarification in order',async()=>{
 const sid=randomUUID(),first=randomUUID(),second=randomUUID(),time='2026-09-16T00:00:00.000Z';
 const record=(id:string,parent:string|null,q:string)=>({executionId:'chat-'+id,version:1,requestDigest:'a'.repeat(64),acceptedContext:{projectId:emptyWorkspace().activeId,workspaceRevision:0,bindingId:null,bindingIdentity:null,provider:'kimi' as const,model:'kimi-k3',historyVersion:'b'.repeat(64)},phase:'failed' as const,cleanupState:'idle' as const,runLink:null,parentTurnId:parent,pendingInteraction:null,toolScopeRequested:false,clarifications:[{questionId:q,prompt:q+' prompt',answer:q+' answer',delivered:true}]});
 const initial:SessionDisk={version:6,selectedId:sid,sessions:[{id:sid,title:'continuation',provider:'kimi',model:'kimi-k3',createdAt:time,updatedAt:time,turns:[
  {id:first,user:'original question',assistant:'partial one',status:'failed',error:'',provider:'kimi',model:'kimi-k3',execution:record(first,null,'q1')},
  {id:second,user:CONTINUE_TEXT,assistant:'partial two',status:'failed',error:'',provider:'kimi',model:'kimi-k3',continueFrom:first,execution:record(second,first,'q2')},
 ]}]};
 const f=fixture(async input=>reply(input),initial);try{
  assert(f.invoke('sendMessage',{sessionId:sid,requestId:randomUUID(),text:CONTINUE_TEXT,continueFrom:second}).ok);await until(()=>!f.host.isRunning());
  assert.deepEqual(f.starts[0]!.chatContext!.messages.map(m=>m.content),['original question','q1 prompt','q1 answer','partial one',CONTINUE_TEXT,'q2 prompt','q2 answer','partial two',CONTINUE_TEXT]);
 }finally{await f.close();}
});

test('the whole-turn timeout retains its failure reason when the aborted engine rejects',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(input=>new Promise<void>((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new CloudChatErrorV1('CANCELLED')),{once:true})),undefined,{turnTimeoutMs:30000});
 try{
  f.send();await until(()=>f.starts.length===1);context.mock.timers.tick(30000);await until(()=>!f.host.isRunning());
  const turn=f.state().selected!.turns[0]!;assert.equal(turn.status,'failed');assert.equal(turn.execution!.phase,'failed');assert.equal(turn.stopReason,'turn_timeout');assert.match(turn.error,/整轮任务超过30秒/u);assert.equal(turn.execution!.cleanupState,'idle');assert.equal(f.stops(),1);
 }finally{await f.close();context.mock.timers.reset();}
});

test('user cancellation before the hard deadline remains cancelled through late cleanup',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});let release!:()=>void;const stopping=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture(input=>new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true})),undefined,{stop:()=>stopping,turnTimeoutMs:30000});
 try{const turnId=f.send();await until(()=>f.starts.length===1);context.mock.timers.tick(29999);assert(f.invoke('cancelReply',{sessionId:f.sessionId,turnId}).ok);await until(()=>f.stops()===1);context.mock.timers.tick(60000);await tick();
  assert(f.host.isRunning());assert.equal(f.state().selected!.turns[0]!.stopReason,undefined);assert.equal(f.state().selected!.turns[0]!.error,'');release();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;assert.equal(turn.status,'cancelled');assert.equal(turn.stopReason,undefined);assert.equal(turn.execution!.cleanupState,'idle');assert.equal(f.starts.length,1);
 }finally{release();await f.close();context.mock.timers.reset();}
});

test('hard deadline before user cancellation preserves timeout while cleanup is pending',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});let release!:()=>void;const stopping=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture(input=>new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true})),undefined,{stop:()=>stopping,turnTimeoutMs:30000});
 try{const turnId=f.send();await until(()=>f.starts.length===1);context.mock.timers.tick(30000);await until(()=>f.stops()===1);assert(f.host.isRunning());const error=f.state().selected!.turns[0]!.error;assert(f.invoke('cancelReply',{sessionId:f.sessionId,turnId}).ok);context.mock.timers.tick(30000);release();await until(()=>!f.host.isRunning());const turn=f.state().selected!.turns[0]!;assert.equal(turn.status,'failed');assert.equal(turn.stopReason,'turn_timeout');assert.equal(turn.error,error);assert.equal(turn.execution!.cleanupState,'idle');assert.equal(f.starts.length,1);
 }finally{release();await f.close();context.mock.timers.reset();}
});
