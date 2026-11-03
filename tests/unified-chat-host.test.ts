import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import type {SessionStore} from '../apps/desktop/src/main/cloud/session-store';
import type {UnifiedChatService,UnifiedChatExecutionUpdate} from '../apps/desktop/src/main/cloud/unified-chat-service';
import {SESSION_VERSION as V,parseSessionDisk,parseSessionResult,type SessionDisk,type SessionMethod,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {ChatAcceptedContext} from '../apps/desktop/src/shared/agent/chat-turns';
import type {FileContext} from '../apps/desktop/src/shared/agent/file-context';
import type {ImageAttachment} from '../apps/desktop/src/shared/agent/image-attachment';

// Real session host, pure in-memory store and explicit service seam. No claim that
// the service stub proves run-store linkage, native cleanup, or a tool execution.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'qa',windowId:'qa-window',webContentsId:1,workspaceId:'qa-workspace',rootId:'qa-root'};
const PROJECT_A='10000000-0000-4000-8000-000000000001',PROJECT_B='10000000-0000-4000-8000-000000000002';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Input=Parameters<UnifiedChatService['execute']>[0];
type Call={input:Input;resolve:()=>void;reject:(reason:unknown)=>void};
function fixture(initial:SessionDisk={version:6,selectedId:null,sessions:[]}) {
  let disk=parseSessionDisk(structuredClone(initial)),saves=0,failNext=false,configured=true;
  let scope:Pick<ChatAcceptedContext,'projectId'|'workspaceRevision'|'bindingId'|'bindingIdentity'>={projectId:PROJECT_A,workspaceRevision:0,bindingId:null,bindingIdentity:null};
  const calls:Call[]=[],captures:ChatAcceptedContext[]=[],forgotten:string[]=[],reconciled:string[]=[],saved:SessionDisk[]=[];
  const store:SessionStore={load:()=>structuredClone(disk),save(next){if(failNext){failNext=false;throw Error('synthetic commit failure');}const checked=parseSessionDisk(structuredClone(next));disk=checked;saved.push(structuredClone(checked));saves++;}};
  const service:UnifiedChatService={
    capture(input){const result={...scope,provider:input.provider,model:input.model,historyVersion:input.historyVersion};captures.push(structuredClone(result));return result;},
    execute(input){return new Promise<void>((resolve,reject)=>{calls.push({input,resolve,reject});});},
    async answer(){throw Error('Question path belongs to separate security tests');},
    activity(sessionId,turn,afterSequence){assert.equal(afterSequence,0);return {sessionId,turnId:turn.id,version:turn.execution?.version??0,execution:turn.execution??null,run:null,parts:[],nextSequence:0,hasMore:false};},
    reconcile(_sessionId,turn){assert(turn.execution);reconciled.push(turn.id);return structuredClone(turn.execution);},
    forget(executionId){forgotten.push(executionId);},busy:()=>false,
  };
  const host=createSessionHost({owner,store,turns:service,configured:()=>({deepseek:configured,kimi:configured}),execute:async()=>{throw Error('Legacy transport must remain unused');},executeMultimodal:async()=>{throw Error('Legacy multimodal transport must remain unused');},validateImages:()=>{}});
  const invoke=<M extends SessionMethod>(method:M,args:object={})=>host.invoke(owner,method,{contractVersion:V,...args});
  const state=()=>{const result=parseSessionResult(invoke('readState'));assert(result.ok);return result.value;};
  const create=(provider:'deepseek'|'kimi'='deepseek')=>{assert(invoke('createSession',{provider,title:'合成统一聊天'}).ok);return state().selectedId!;};
  function update(index:number,patch:Partial<UnifiedChatExecutionUpdate>) {const call=calls[index];assert(call?.input.turn.execution);const e=call.input.turn.execution;call.input.onExecution({phase:e.phase,cleanupState:e.cleanupState,runLink:e.runLink,pendingInteraction:e.pendingInteraction,...patch});}
  function complete(index:number,text='已完成本地合成回答'){const call=calls[index];assert(call);call.input.onText(text);update(index,{phase:'completed',cleanupState:'idle',pendingInteraction:null});call.resolve();}
  function needsDirectory(index:number){update(index,{phase:'needs_configuration',cleanupState:'idle',pendingInteraction:{kind:'configuration',interactionId:'config-'+index,required:'project_directory',action:'select_project',message:'请选择项目目录'}});calls[index]!.resolve();}
  return {host,invoke,state,create,calls,captures,forgotten,reconciled,saved,update,complete,needsDirectory,durable:()=>structuredClone(disk),saves:()=>saves,
    failCommit(){failNext=true;},setConfigured(value:boolean){configured=value;},setScope(value:typeof scope){scope={...value};}};
}

test('lost admission response is durably idempotent before and after cold reopen, even when current settings changed',async()=>{
  const f=fixture();let cold:ReturnType<typeof fixture>|undefined;
  try {
    const sessionId=f.create(),request={sessionId,requestId:randomUUID(),text:'重复发送同一条已接纳问题'};
    assert(f.invoke('sendMessage',request).ok);const accepted=structuredClone(f.state().selected!.turns[0]!.execution!);await tick();assert.equal(f.calls.length,1);
    assert(f.invoke('setSessionModel',{sessionId,provider:'kimi',model:'kimi-k3'}).ok);f.setConfigured(false);
    const saves=f.saves();assert(f.invoke('sendMessage',request).ok);assert.equal(f.saves(),saves);assert.equal(f.captures.length,1);assert.deepEqual(f.state().selected!.turns[0]!.execution,accepted);
    assert.deepEqual(f.invoke('sendMessage',{...request,text:request.text+'不同'}),{ok:false,error:{code:'CONFLICT'}});assert.equal(f.calls.length,1);
    f.complete(0);await tick();const durable=f.durable();f.host.revoke();
    cold=fixture(durable);cold.setConfigured(false);assert(cold.invoke('sendMessage',request).ok);await tick();
    assert.equal(cold.calls.length,0);assert.equal(cold.captures.length,0);assert.equal(cold.saves(),0);assert.equal(cold.state().selected!.turns.length,1);assert.deepEqual(cold.durable(),durable);
    assert.deepEqual(cold.invoke('sendMessage',{...request,text:'冲突内容'}),{ok:false,error:{code:'CONFLICT'}});
  }finally{f.host.revoke();cold?.host.revoke();}
});

test('admission commit failure dispatches nothing and leaves no accepted durable turn',async()=>{
  const f=fixture();try {
    const sessionId=f.create(),before=f.durable();f.failCommit();
    assert.deepEqual(f.invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'只能在持久接纳后执行'}),{ok:false,error:{code:'STORAGE_ERROR'}});await tick();
    assert.equal(f.calls.length,0);assert.equal(f.captures.length,1);assert.equal(f.forgotten.length,1);assert.deepEqual(f.durable(),before);assert.equal(f.state().storage,'error');assert.equal(f.state().selected!.turns.length,0);
  }finally{f.host.revoke();}
});

test('cold open reconciles an admitted unfinished turn without executing or replaying it',async()=>{
  const f=fixture();let cold:ReturnType<typeof fixture>|undefined;
  try {
    const sessionId=f.create(),requestId=randomUUID();assert(f.invoke('sendMessage',{sessionId,requestId,text:'已落盘但回执未知'}).ok);
    const admitted=f.durable();assert.equal(admitted.sessions[0]!.turns[0]!.execution!.phase,'accepted');
    f.host.revoke();await tick();assert.equal(f.calls.length,0);
    cold=fixture(admitted);await tick();const turn=cold.state().selected!.turns[0]!;
    assert.equal(cold.calls.length,0);assert.equal(cold.captures.length,0);assert.deepEqual(cold.reconciled,[requestId]);assert.equal(turn.status,'interrupted');assert.equal(turn.execution!.cleanupState,'failed');
    assert.deepEqual(turn.execution!.acceptedContext,admitted.sessions[0]!.turns[0]!.execution!.acceptedContext);assert.equal(turn.execution!.executionId,admitted.sessions[0]!.turns[0]!.execution!.executionId);
    assert(cold.invoke('readTurnActivity',{sessionId,turnId:requestId,afterSequence:0}).ok);await tick();assert.equal(cold.calls.length,0);
  }finally{f.host.revoke();cold?.host.revoke();}
});

test('configuration retry atomically keeps the old scope and admits a new turn with preserved input and new snapshot',async()=>{
  const f=fixture();try {
    const sessionId=f.create(),requestId=randomUUID(),file:FileContext={id:randomUUID(),name:'fixture.txt',text:'精确保留附件',startLine:1,endLine:1,totalLines:1};
    const original={sessionId,requestId,text:'请读当前资料。',files:[file]};assert(f.invoke('sendMessage',original).ok);await tick();f.needsDirectory(0);await tick();
    const old=structuredClone(f.state().selected!.turns[0]!);assert.equal(f.host.isRunning(),false);
    f.setScope({projectId:PROJECT_B,workspaceRevision:9,bindingId:'binding-b',bindingIdentity:'b'.repeat(64)});assert(f.invoke('setSessionModel',{sessionId,provider:'kimi',model:'kimi-k3'}).ok);
    const retryId=randomUUID(),answer={sessionId,turnId:requestId,interactionId:'config-0',requestId:retryId,decision:{kind:'configuration',decision:'retry'}};
    assert(f.invoke('answerInteraction',answer).ok);await tick();assert.equal(f.calls.length,2);
    const [preserved,retry]=f.state().selected!.turns;assert(preserved&&retry);assert.deepEqual(preserved.execution!.acceptedContext,old.execution!.acceptedContext);assert.equal(preserved.execution!.executionId,old.execution!.executionId);assert.equal(preserved.execution!.phase,'needs_configuration');assert.equal(preserved.execution!.pendingInteraction,null);
    assert.equal(retry.id,retryId);assert.notEqual(retry.execution!.executionId,old.execution!.executionId);assert.equal(retry.execution!.parentTurnId,requestId);assert.equal(retry.execution!.acceptedContext.projectId,PROJECT_B);assert.equal(retry.execution!.acceptedContext.workspaceRevision,9);assert.equal(retry.execution!.acceptedContext.model,'kimi-k3');assert.equal(retry.user,old.user);assert.deepEqual(retry.files,old.files);
    assert.equal(preserved.execution!.interactionReceipts!.at(-1)!.resultTurnId,retryId);const saves=f.saves();assert(f.invoke('answerInteraction',answer).ok);assert.equal(f.saves(),saves);assert.equal(f.calls.length,2);
    f.complete(1);await tick();assert.equal(f.state().selected!.turns.length,2);
  }finally{f.host.revoke();}
});

test('failed configuration retry commit preserves the original pending interaction and creates no new durable turn',async()=>{
  const f=fixture();try {
    const sessionId=f.create(),turnId=randomUUID();assert(f.invoke('sendMessage',{sessionId,requestId:turnId,text:'需要目录的原问题'}).ok);await tick();f.needsDirectory(0);await tick();
    const before=f.durable();f.setScope({projectId:PROJECT_B,workspaceRevision:4,bindingId:'binding-b',bindingIdentity:'c'.repeat(64)});f.failCommit();
    assert.deepEqual(f.invoke('answerInteraction',{sessionId,turnId,interactionId:'config-0',requestId:randomUUID(),decision:{kind:'configuration',decision:'retry'}}),{ok:false,error:{code:'STORAGE_ERROR'}});await tick();
    assert.equal(f.calls.length,1);assert.deepEqual(f.durable(),before);assert.equal(f.state().selected!.turns.length,1);assert.equal(f.state().selected!.turns[0]!.execution!.pendingInteraction?.kind,'configuration');
  }finally{f.host.revoke();}
});

test('model and project changes during a live turn affect only the next admission',async()=>{
  const f=fixture();try {
    const sessionId=f.create(),firstId=randomUUID();assert(f.invoke('sendMessage',{sessionId,requestId:firstId,text:'第一轮'}).ok);
    const accepted=structuredClone(f.state().selected!.turns[0]!.execution!.acceptedContext);
    assert(f.invoke('setSessionModel',{sessionId,provider:'kimi',model:'kimi-k3'}).ok);f.setScope({projectId:PROJECT_B,workspaceRevision:10,bindingId:'binding-new',bindingIdentity:'d'.repeat(64)});await tick();
    assert.equal(f.calls[0]!.input.context.provider,'deepseek');assert.equal(f.calls[0]!.input.context.model,'deepseek-v4-flash');assert.deepEqual(f.calls[0]!.input.turn.execution!.acceptedContext,accepted);
    assert.deepEqual(f.invoke('deleteSession',{sessionId}),{ok:false,error:{code:'BUSY'}});
    f.complete(0);await tick();assert(f.invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'第二轮'}).ok);await tick();
    assert.equal(f.calls[1]!.input.context.provider,'kimi');assert.equal(f.calls[1]!.input.turn.execution!.acceptedContext.projectId,PROJECT_B);assert.deepEqual(f.state().selected!.turns[0]!.execution!.acceptedContext,accepted);
    f.complete(1);await tick();
  }finally{f.host.revoke();}
});

test('exact stop remains pending until the service reports cleanup without admitting a second turn',async()=>{
  const f=fixture();try {
    const sessionId=f.create(),turnId=randomUUID();assert(f.invoke('sendMessage',{sessionId,requestId:turnId,text:'当前轮'}).ok);await tick();f.update(0,{phase:'running'});
    assert(f.invoke('cancelReply',{sessionId,turnId}).ok);assert(f.calls[0]!.input.signal.aborted);assert.equal(f.state().activeTurn!.turnId,turnId);assert.equal(f.state().activeTurn!.phase,'stopping');assert.equal(f.state().activeTurn!.cleanupState,'pending');assert(f.host.isRunning());
    assert.equal(f.state().selected!.turns.length,1);assert.equal(f.calls.length,1);
    f.update(0,{phase:'cancelled',cleanupState:'idle',pendingInteraction:null});f.calls[0]!.resolve();await tick();
    assert.equal(f.state().activeTurn,null);assert.equal(f.state().selected!.turns[0]!.status,'cancelled');assert.equal(f.state().selected!.turns[0]!.execution!.cleanupState,'idle');assert.equal(f.calls.length,1);
  }finally{f.host.revoke();}
});

test('unified host preserves the full 16KiB input and old history beyond eight pairs with no tool run link',async()=>{
  const now='2026-09-16T00:00:00.000Z',sessionId=randomUUID();
  const old:SessionTurn[]=Array.from({length:12},(_,i)=>({id:randomUUID(),user:'old-question-'+i,assistant:'old-answer-'+i,status:'completed',error:''}));
  const initial:SessionDisk={version:5,selectedId:sessionId,sessions:[{id:sessionId,title:'旧会话',provider:'deepseek',model:'deepseek-v4-flash',createdAt:now,updatedAt:now,turns:old}]},f=fixture(initial);
  try {
    const boundary='中'.repeat(5461)+'x';assert.equal(Buffer.byteLength(boundary),16384);
    assert(f.invoke('sendMessage',{sessionId,requestId:randomUUID(),text:boundary}).ok);await tick();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.input.turn.user,boundary);assert.deepEqual(f.calls[0]!.input.context.messages.map(m=>m.content),[...old.flatMap(t=>[t.user,t.assistant]),boundary]);assert.equal(f.calls[0]!.input.turn.execution!.runLink,null);assert.deepEqual(f.host.referencedRunIds(),new Set([f.calls[0]!.input.turn.execution!.executionId+'.tools']));
    f.complete(0);await tick();assert.equal(f.state().selected!.turns.length,13);assert(f.state().selected!.turns.slice(0,12).every(t=>!t.execution));
  }finally{f.host.revoke();}
});

test('accepted image and text attachment bytes survive storage and service dispatch unchanged',async()=>{
  const f=fixture();try {
    const sessionId=f.create('kimi'),image:ImageAttachment={id:randomUUID(),name:'synthetic.jpg',data:Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64'),width:1,height:1},file:FileContext={id:randomUUID(),name:'synthetic.txt',text:'仅本批合成附件',startLine:2,endLine:2,totalLines:4};
    assert(f.invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'请看图片与附件',images:[image],files:[file]}).ok);await tick();
    const turn=f.state().selected!.turns[0]!;assert.deepEqual(turn.images,[image]);assert.deepEqual(turn.files,[file]);assert.deepEqual(f.durable().sessions[0]!.turns[0]!.images,[image]);
    const wire=JSON.stringify(f.calls[0]!.input.context.messages);assert(wire.includes(image.data));assert(wire.includes(file.text));f.complete(0);await tick();
  }finally{f.host.revoke();}
});

test('native admission crosses 100 turns and 512KiB without deleting the persisted history',async()=>{
  const now='2026-10-23T00:00:00.000Z',sessionId=randomUUID();
  const old:SessionTurn[]=Array.from({length:120},(_,i)=>({id:randomUUID(),user:'question-'+i,assistant:'answer-'+i+'a'.repeat(9000),status:'completed',error:''}));
  const initial:SessionDisk={version:6,selectedId:sessionId,sessions:[{id:sessionId,title:'long synthetic native history',provider:'deepseek',model:'deepseek-v4-flash',createdAt:now,updatedAt:now,turns:old}]};
  const f=fixture(initial);
  try{
    assert(Buffer.byteLength(JSON.stringify(old))>1024*1024);
    assert(f.invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'continue with the original constraints'}).ok);await tick();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.input.context.messages.length,241);
    assert.deepEqual(f.calls[0]!.input.context.messages.slice(0,-1).map(m=>m.content),old.flatMap(t=>[t.user,t.assistant]));
    f.complete(0);await tick();assert.equal(f.state().selected!.turns.length,121);
    const durable=f.durable();f.host.revoke();const cold=fixture(durable);
    try{assert.equal(cold.state().selected!.turns.length,121);assert.equal(cold.calls.length,0);}finally{cold.host.revoke();}
  }finally{f.host.revoke();}
});
