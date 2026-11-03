import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {buildMultimodalContext,type MultimodalRequest} from '../apps/desktop/src/main/cloud/multimodal-context';
import {SESSION_VERSION,parseSessionRequest,parseSessionDisk,parseSessionResult,type SessionDisk,type SessionMethod} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {ImageAttachment} from '../apps/desktop/src/shared/agent/image-attachment';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(initial:SessionDisk={version:3,selectedId:null,sessions:[]}) {
 let disk=structuredClone(initial),fail=false,saves=0;
 const wires:MultimodalRequest[]=[],release:Array<()=>void>=[];
 const store={load:()=>structuredClone(disk),save:(next:SessionDisk)=>{if(fail)throw Error('synthetic storage failure');disk=parseSessionDisk(next);saves++;}};
 const host=createSessionHost({owner,store,configured:{deepseek:true,kimi:true},execute:async()=>{throw Error('legacy transport not used');},executeMultimodal:async(request,o)=>{wires.push(request);return new Promise<{text:string}>(r=>release.push(()=>{o.onText('answer');r({text:'answer'});}));}});
 const invoke=(method:SessionMethod,args:object={})=>host.invoke(owner,method,{contractVersion:SESSION_VERSION,...args});
 const state=()=>{const r=parseSessionResult(invoke('readState'));assert.ok(r.ok);return r.value;};
 return {host,invoke,state,wires,release,store,get:()=>structuredClone(disk),fail:()=>{fail=true;},saves:()=>saves};
}
test('model selector accepts only exact session and catalog identities without evaluating accessors',()=>{
 const value={contractVersion:SESSION_VERSION,sessionId:randomUUID(),provider:'kimi',model:'kimi-k3'};
 assert.equal(parseSessionRequest('setSessionModel',value).model,'kimi-k3');
 for(const v of [{...value,url:'https://example.invalid'},{...value,provider:'deepseek'},{...value,model:'unknown'},{...value,sessionId:'../x'},{...value,contractVersion:'workbench.sessions.v3'}])assert.throws(()=>parseSessionRequest('setSessionModel',v));
 let read=false;assert.throws(()=>parseSessionRequest('setSessionModel',Object.defineProperty({...value},'model',{enumerable:true,get(){read=true;return 'kimi-k3';}})));assert.equal(read,false);
});
test('switching during generation captures old wire and attribution, then routes the next send with intact context',async()=>{
 const s=fixture();try{
  s.invoke('createSession',{provider:'deepseek',title:'preserved'});const id=s.state().selectedId!,requestId=randomUUID();
  s.invoke('sendMessage',{sessionId:id,text:'first',requestId});
  assert.ok(s.invoke('setSessionModel',{sessionId:id,provider:'kimi',model:'kimi-k3'}).ok);
  assert.equal(s.state().runningSessionId,id);assert.equal(s.state().selected?.provider,'kimi');await tick();
  assert.equal(s.wires.length,1);assert.equal(s.wires[0]!.provider,'deepseek');assert.equal(s.state().selected?.turns[0]!.model,'deepseek-v4-flash');
  s.release[0]!();await tick();assert.equal(s.state().selected?.turns[0]!.status,'completed');
  const count=s.saves();assert.ok(s.invoke('sendMessage',{sessionId:id,text:'first',requestId}).ok);await tick();assert.equal(s.wires.length,1);assert.equal(s.saves(),count);
  s.invoke('sendMessage',{sessionId:id,text:'second',requestId:randomUUID()});await tick();assert.equal(s.wires[1]!.provider,'kimi');assert.deepEqual(s.wires[1]!.messages.map(m=>m.content),['first','answer','second']);
  s.release[1]!();await tick();assert.equal(s.state().selected?.id,id);assert.equal(s.state().selected?.title,'preserved');assert.deepEqual(s.state().selected?.turns.map(t=>t.model),['deepseek-v4-flash','kimi-k3']);
  const restored=fixture(s.get());assert.equal(restored.state().selected?.model,'kimi-k3');assert.deepEqual(restored.state().selected?.turns.map(t=>t.provider),['deepseek','kimi']);assert.equal(restored.wires.length,0);restored.host.revoke();
 }finally{s.host.revoke();}
});
test('switch stamps legacy turn identity, preserves other sessions, and rejects storage failure without relabeling',()=>{
 const id=randomUUID(),other=randomUUID(),now=new Date().toISOString(),row={id,title:'old',provider:'deepseek' as const,model:'deepseek-v4-flash',createdAt:now,updatedAt:now,turns:[{id:randomUUID(),user:'u',assistant:'a',status:'completed' as const,error:''}]};
 const s=fixture({version:3,selectedId:id,sessions:[row,{...row,id:other,turns:[]}]});try{
  assert.equal(s.saves(),0);assert.ok(s.invoke('setSessionModel',{sessionId:id,provider:'kimi',model:'kimi-k3'}).ok);
  assert.equal(s.state().selected?.turns[0]!.provider,'deepseek');assert.equal(s.state().sessions.find(x=>x.id===other)!.provider,'deepseek');
  const previous=s.get();s.fail();assert.deepEqual(s.invoke('setSessionModel',{sessionId:id,provider:'deepseek',model:'deepseek-v4-flash'}),{ok:false,error:{code:'STORAGE_ERROR'}});
  assert.equal(s.state().selected?.provider,'kimi');assert.deepEqual(s.get(),previous);
 }finally{s.host.revoke();}
});
test('model mutation enforces owner, nonexistent session and permanent revoke with zero sends',()=>{
 const s=fixture();s.invoke('createSession',{provider:'deepseek',title:'test'});const request={contractVersion:SESSION_VERSION,sessionId:s.state().selectedId!,provider:'kimi',model:'kimi-k3'};
 assert.deepEqual(s.host.invoke({...owner,windowId:'other'},'setSessionModel',request),{ok:false,error:{code:'CAPABILITY_DENIED'}});
 assert.deepEqual(s.invoke('setSessionModel',{...request,sessionId:randomUUID()}),{ok:false,error:{code:'NOT_FOUND'}});
 s.host.revoke();assert.deepEqual(s.host.invoke(owner,'setSessionModel',request),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.equal(s.wires.length,0);
});
test('text target retains historical text and stored image attribution while omitting image wire payload',()=>{
 const image:ImageAttachment={id:randomUUID(),name:'synthetic.jpg',data:Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64'),width:1,height:1};
 const id=randomUUID(),now=new Date().toISOString(),disk:SessionDisk={version:3,selectedId:id,sessions:[{id,title:'image history',provider:'kimi',model:'kimi-k3',createdAt:now,updatedAt:now,turns:[{id:randomUUID(),user:'picture question',assistant:'picture answer',status:'completed',error:'',images:[image]}]}]};
 const s=fixture(disk);try{
  assert.ok(s.invoke('setSessionModel',{sessionId:id,provider:'deepseek',model:'deepseek-v4-flash'}).ok);
  const history=s.state().selected!.turns;assert.equal(history[0]!.images!.length,1);assert.equal(history[0]!.model,'kimi-k3');
  const request=buildMultimodalContext('deepseek','deepseek-v4-flash','next',[],history);
  assert.deepEqual(request.messages.map(m=>m.content),['picture question','picture answer','next']);assert.ok(!JSON.stringify(request).includes('image_url'));
  assert.throws(()=>buildMultimodalContext('deepseek','deepseek-v4-flash','new',[image],history));
 }finally{s.host.revoke();}
});
