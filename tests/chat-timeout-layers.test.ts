import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createModelSettings} from '../apps/desktop/src/main/cloud/model-settings-host';
import {SETTINGS_VERSION,parseSettingsSave} from '../apps/desktop/src/shared/agent/model-settings';
import {resolveChatTurnLimits,DEFAULT_CHAT_REPLY_LIMITS,TIMEOUT_CHOICES,REQUEST_TIMEOUT_CHOICES,type ChatReplyLimits} from '../apps/desktop/src/shared/agent/reply-limits';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {UnifiedChatService} from '../apps/desktop/src/main/cloud/unified-chat-service';
import {CloudChatErrorV1} from '../packages/agent-adapters/src/cloud-chat-contract';
import * as storeModule from '../apps/desktop/src/main/cloud/session-store';

const save={contractVersion:SETTINGS_VERSION,provider:'kimi',model:'kimi-k3',keyAction:'retain',apiKey:''};
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'qa',windowId:'w',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const tick=()=>new Promise<void>(r=>setImmediate(r));
type Config=ReturnType<NonNullable<Parameters<typeof createModelSettings>[0]['store']>['load']>;
const provider={model:'kimi-k3',source:'file' as const,ciphertext:'',maxOutputTokens:8192,timeoutMs:120000};

test('absent and v1 configurations project request defaults with no total deadline or save',t=>{
 let writes=0;
 t.mock.method(storeModule,'createAtomicJsonStore',((_root:unknown,_directory:unknown,_file:unknown,_parse:unknown,_bytes:unknown,empty:()=>unknown)=>({load:empty,save(){writes++;}})) as typeof storeModule.createAtomicJsonStore);
 const options={root:'C:/work/analog_ai_workbench',directory:'unused',legacyKeys:{},encryption:{available:()=>false,encrypt:()=>'',decrypt:()=>''}};
 const fresh=createModelSettings(options);assert.deepEqual(fresh.replyLimits('kimi'),DEFAULT_CHAT_REPLY_LIMITS);assert.equal(writes,0);
 const old:Config={version:1,kimi:{model:'kimi-k3',source:'file',ciphertext:''},deepseek:{model:'deepseek-v4-flash',source:'file',ciphertext:''}};
 const legacy=createModelSettings({...options,store:{load:()=>old,save(){writes++;}}});assert.deepEqual(legacy.replyLimits('kimi'),DEFAULT_CHAT_REPLY_LIMITS);assert.equal(writes,0);
});

test('legacy request limits remain without implicit total; explicit totals survive reopen and old callers',()=>{
 for(const timeoutMs of REQUEST_TIMEOUT_CHOICES){let data:Config={version:2,kimi:{...provider,timeoutMs},deepseek:{...provider,model:'deepseek-v4-flash',timeoutMs}},saves=0;
  const opts={root:'C:/work/analog_ai_workbench',directory:'unused',legacyKeys:{},encryption:{available:()=>false,encrypt:()=>'',decrypt:()=>''},store:{load:()=>structuredClone(data),save(v:Config){saves++;data=structuredClone(v);}}};
  const h=createModelSettings(opts);assert.equal(saves,0);assert.deepEqual(resolveChatTurnLimits(h.replyLimits('kimi')),{maxOutputTokens:8192,requestTimeoutMs:timeoutMs,turnTimeoutMs:null});
  assert(h.save({...save,maxOutputTokens:8192,timeoutMs:120000,requestTimeoutMs:120000,turnTimeoutMs:1800000}).ok);assert.equal(saves,1);assert.equal(data.version,4);
  const cold=createModelSettings(opts);assert.deepEqual(resolveChatTurnLimits(cold.replyLimits('kimi')),{maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs:1800000});assert.equal(saves,1);
  assert.equal(data.deepseek.timeoutMs,timeoutMs);assert.equal(data.deepseek.requestTimeoutMs,undefined);assert(cold.save(save).ok);assert.deepEqual(cold.replyLimits('kimi'),{maxOutputTokens:8192,timeoutMs:120000,requestTimeoutMs:120000,turnTimeoutMs:1800000});
  assert(cold.save({...save,maxOutputTokens:8192,timeoutMs}).ok);assert.equal(data.kimi.requestTimeoutMs,timeoutMs);assert.deepEqual(resolveChatTurnLimits(cold.replyLimits('kimi')),{maxOutputTokens:8192,requestTimeoutMs:timeoutMs,turnTimeoutMs:1800000});
  assert(cold.save({...save,maxOutputTokens:8192,timeoutMs,requestTimeoutMs:timeoutMs,turnTimeoutMs:null}).ok);assert.equal(cold.replyLimits('kimi').turnTimeoutMs,null);
 }
 assert.deepEqual(resolveChatTurnLimits(DEFAULT_CHAT_REPLY_LIMITS),{maxOutputTokens:8192,requestTimeoutMs:600000,turnTimeoutMs:null});
 assert(TIMEOUT_CHOICES.includes(14400000));for(const requestTimeoutMs of [0,1800000,undefined])assert.throws(()=>parseSettingsSave({...save,maxOutputTokens:8192,timeoutMs:1800000,requestTimeoutMs}));
});

test('v3 split values never infer total intention and old budget saves change request only',()=>{
 let data:Config={version:3,kimi:{...provider,timeoutMs:1800000,requestTimeoutMs:30000},deepseek:{...provider,model:'deepseek-v4-flash'}};
 const host=createModelSettings({root:'C:/work/analog_ai_workbench',directory:'unused',legacyKeys:{},encryption:{available:()=>false,encrypt:()=>'',decrypt:()=>''},store:{load:()=>structuredClone(data),save(v){data=structuredClone(v);}}});
 assert.deepEqual(host.replyLimits('kimi'),{maxOutputTokens:8192,timeoutMs:30000,requestTimeoutMs:30000,turnTimeoutMs:null});
 assert(host.save({...save,maxOutputTokens:8192,timeoutMs:900000}).ok);assert.deepEqual(host.replyLimits('kimi'),{maxOutputTokens:8192,timeoutMs:900000,requestTimeoutMs:900000,turnTimeoutMs:null});
});

test('corrupt legacy aliases cannot hide behind a valid request field',()=>{
 for(const version of [3,4] as const)for(const timeoutMs of ['bad',0,120001,undefined]){
  const host=createModelSettings({root:'C:/work/analog_ai_workbench',directory:'unused',legacyKeys:{},encryption:{available:()=>false,encrypt:()=>'',decrypt:()=>''},store:{load:()=>({version,kimi:{...provider,timeoutMs,requestTimeoutMs:600000},deepseek:{...provider,model:'deepseek-v4-flash'}} as Config),save(){assert.fail('read must not repair disk');}}});
  const result=host.read();assert(result.ok);assert.equal(result.value.storage,'error');assert.equal(host.save(save).ok,false);
 }
});

function hostFixture(initialLimits:ChatReplyLimits,error?:CloudChatErrorV1){
 let disk:SessionDisk={version:6,selectedId:null,sessions:[]},limits={...initialLimits},input:Parameters<UnifiedChatService['execute']>[0]|undefined,calls=0;
 const service:UnifiedChatService={capture(i){return{projectId:'10000000-0000-4000-8000-000000000001',workspaceRevision:0,bindingId:null,bindingIdentity:null,provider:i.provider,model:i.model,historyVersion:i.historyVersion};},async execute(i){calls++;input=i;if(error)throw error;await new Promise<void>((_resolve,reject)=>{i.signal.addEventListener('abort',()=>{i.onExecution({phase:'stopping',cleanupState:'idle',runLink:null,pendingInteraction:null});reject(Error('synthetic cancelled'));},{once:true});});},async answer(){},activity(){assert.fail('unused');},reconcile(_s,t){return t.execution!;},forget(){},busy:()=>false};
 const host=createSessionHost({owner,configured:{deepseek:true,kimi:true},store:{load:()=>structuredClone(disk),save(v){disk=parseSessionDisk(v);}},replyLimits:()=>limits,turns:service,execute:async()=>{assert.fail('unused');},executeMultimodal:async()=>{assert.fail('unused');}});
 const c=host.invoke(owner,'createSession',{contractVersion:SESSION_VERSION,provider:'kimi',title:'synthetic'});assert(c.ok);const sessionId=c.value.selectedId!;
 const send=()=>host.invoke(owner,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId:randomUUID(),text:'synthetic task'});
 return{host,send,current:()=>disk.sessions[0]!.turns[0]!,input:()=>input!,calls:()=>calls,setLimits(v:ChatReplyLimits){limits=v;},cancel(){return host.invoke(owner,'cancelReply',{contractVersion:SESSION_VERSION,sessionId,turnId:disk.sessions[0]!.turns[0]!.id});}};
}

test('request value reaches context while a separate frozen hard turn deadline survives progress',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=hostFixture({maxOutputTokens:8192,timeoutMs:120000,requestTimeoutMs:120000,turnTimeoutMs:300000});
 try{assert(f.send().ok);await tick();assert.equal(f.input().context.timeoutMs,120000);assert.deepEqual(f.current().limits,{maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs:300000});
  f.setLimits({maxOutputTokens:2048,timeoutMs:30000,requestTimeoutMs:30000});t.mock.timers.tick(120000);await tick();assert.equal(f.host.isRunning(),true);
  f.input().onText('partial');f.input().onExecution({phase:'running',cleanupState:'idle',runLink:null,pendingInteraction:null});t.mock.timers.tick(179999);await tick();assert.equal(f.host.isRunning(),true);
  t.mock.timers.tick(1);await tick();assert.equal(f.host.isRunning(),false);assert.equal(f.current().stopReason,'turn_timeout');assert.match(f.current().error,/300秒/);assert.equal(f.current().assistant,'partial');assert.equal(f.calls(),1);
 }finally{f.host.revoke();t.mock.timers.reset();}
});

test('legacy 120s turn remains running past 240s and explicit cancellation stays cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=hostFixture({maxOutputTokens:8192,timeoutMs:120000});
 try{assert(f.send().ok);await tick();assert.deepEqual(f.current().limits,{maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs:null});
  for(let n=0;n<2;n++){t.mock.timers.tick(120001);await tick();f.input().onText('progress');assert(f.host.isRunning());assert.equal(f.current().stopReason,undefined);assert.equal(f.current().error,'');}
  assert(f.cancel().ok);await tick();assert.equal(f.current().status,'cancelled');assert.equal(f.current().stopReason,undefined);assert.equal(f.calls(),1);
 }finally{f.host.revoke();t.mock.timers.reset();}
});

test('trusted request, first-response and idle failures get distinct stop reasons without replay',async()=>{
 for(const [code,reason] of [['TIMEOUT','total_timeout'],['FIRST_RESPONSE_TIMEOUT','first_response_timeout'],['IDLE_TIMEOUT','idle_timeout']] as const){const f=hostFixture({maxOutputTokens:8192,timeoutMs:1800000,requestTimeoutMs:120000},new CloudChatErrorV1(code));
  try{assert(f.send().ok);await tick();assert.equal(f.current().stopReason,reason);assert.equal(f.current().status,'failed');assert.equal(f.calls(),1);if(code==='TIMEOUT')assert.match(f.current().error,/单次模型请求.*120秒/);}finally{f.host.revoke();}
 }
});

test('old historical errors remain unchanged and missing snapshots are not invented',()=>{
 const id=randomUUID(),turn:SessionTurn={id:randomUUID(),user:'old',assistant:'partial',status:'failed',error:'回复超过120秒等待上限，已保留收到的内容。',stopReason:'total_timeout'};
 const d=parseSessionDisk({version:6,selectedId:id,sessions:[{id,title:'old',provider:'kimi',createdAt:'2026-09-16T00:00:00.000Z',updatedAt:'2026-09-16T00:00:00.000Z',turns:[turn]}]});assert.equal(d.sessions[0]!.turns[0]!.limits,undefined);assert.equal(d.sessions[0]!.turns[0]!.error,turn.error);assert.equal(d.sessions[0]!.turns[0]!.stopReason,'total_timeout');
 for(const turnTimeoutMs of [120000,null]){d.sessions[0]!.turns[0]!.limits={maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs};assert.deepEqual(parseSessionDisk(d),d);}
});
