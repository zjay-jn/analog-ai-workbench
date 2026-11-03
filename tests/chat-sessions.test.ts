import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createSessionStore,type SessionStore} from '../apps/desktop/src/main/cloud/session-store';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {SESSION_VERSION,parseSessionRequest,parseSessionResult,parseSessionDisk,type SessionDisk,type SessionMethod,type SessionState} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {CloudExecutorV2} from '../apps/desktop/src/main/cloud/cloud-host';
import {sessionExtension} from '../apps/desktop/src/main/cloud/register-session-ipc';
import {SESSION_METHODS,sessionChannel} from '../apps/desktop/src/shared/agent/chat-sessions';
const root=process.cwd(),owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'},tick=()=>new Promise(r=>setImmediate(r));
function memory(){let disk:SessionDisk={version:1,selectedId:null,sessions:[]},fail=false;return {store:{load:()=>structuredClone(disk),save:(s:SessionDisk)=>{if(fail)throw Error('private error');disk=parseSessionDisk(s);}} satisfies SessionStore,get:()=>disk,fail:()=>{fail=true;}};}
function setup(execute:CloudExecutorV2=async(_r,o)=>{o.onText('answer');return {text:'answer'};},store:SessionStore=memory().store){
 const host=createSessionHost({owner,store,configured:{deepseek:true,kimi:true},execute});
 const invoke=(method:SessionMethod,args:object={})=>host.invoke(owner,method,{contractVersion:SESSION_VERSION,...args});
 const state=(method:SessionMethod='readState',args:Record<string,unknown>={}):SessionState=>{const exactArgs=method==='cancelReply'&&!Object.hasOwn(args,'turnId')?{...args,turnId:host.getSession(String(args.sessionId))?.turns.at(-1)?.id}:args;const r=parseSessionResult(invoke(method,exactArgs));assert.equal(r.ok,true);if(!r.ok)throw Error();return r.value;};
 const create=(provider='deepseek')=>state('createSession',{provider,title:'新会话'}).selectedId!;
 const send=(sessionId:string,text='hello',requestId=randomUUID())=>state('sendMessage',{sessionId,text,requestId});
 return {host,invoke,state,create,send};
}
test('session requests reject paths, malformed IDs, accessors and invalid title without invoking getters',()=>{
 assert.throws(()=>parseSessionRequest('readState',{contractVersion:SESSION_VERSION,path:'D:/api.txt'}));
 assert.throws(()=>parseSessionRequest('deleteSession',{contractVersion:SESSION_VERSION,sessionId:'../other'}));
 assert.throws(()=>parseSessionRequest('createSession',{contractVersion:SESSION_VERSION,provider:'deepseek',title:'bad\nname'}));
 let invoked=false;assert.throws(()=>parseSessionRequest('readState',Object.defineProperty({},'contractVersion',{enumerable:true,get(){invoked=true;return SESSION_VERSION;}})));assert.equal(invoked,false);
});
test('store saves and reopens, refuses external change and malformed data without overwriting',()=>{
 const folder=path.join(root,'.local/test-workspaces',`sessions-${randomUUID()}`);fs.mkdirSync(folder,{recursive:true});const store=createSessionStore(root,folder),empty=store.load();store.save(empty);
 assert.deepEqual(createSessionStore(root,folder).load(),empty);const file=path.join(folder,'sessions.json');fs.writeFileSync(file,'corrupt');assert.throws(()=>store.save(empty));assert.equal(fs.readFileSync(file,'utf8'),'corrupt');assert.throws(()=>createSessionStore(root,folder).load());
});
test('store rejects outside roots, hardlinked targets and directory symlinks',()=>{
 assert.throws(()=>createSessionStore(root,path.dirname(root)));const folder=path.join(root,'.local/test-workspaces',`session-links-${randomUUID()}`);fs.mkdirSync(folder,{recursive:true});
 const source=path.join(folder,'source.json');fs.writeFileSync(source,'{"version":1,"selectedId":null,"sessions":[]}');fs.linkSync(source,path.join(folder,'sessions.json'));assert.throws(()=>createSessionStore(root,folder).load());
 const link=path.join(folder,'linked');fs.symlinkSync(folder,link,'junction');assert.throws(()=>createSessionStore(root,link).load());
});
test('session identity, persisted restart and context isolation include only completed current-session pairs',async()=>{
 const mem=memory(),requests:string[][]=[];const executor:CloudExecutorV2=async(r,o)=>{requests.push(r.messages.map(m=>m.content));o.onText('answer');return {text:'answer'};};
 const a=setup(executor,mem.store),first=a.create();a.send(first,'one');await tick();const second=a.create();a.send(second,'other');await tick();a.state('selectSession',{sessionId:first});a.state('renameSession',{sessionId:first,title:'SAR ADC'});a.host.revoke();
 const b=setup(executor,mem.store);assert.equal(b.state().selected?.title,'SAR ADC');b.send(first,'two');await tick();assert.deepEqual(requests,[['one'],['other'],['one','answer','two']]);b.host.revoke();
});
test('global busy, idempotency, browsing while running, cancel and late callbacks',async()=>{
 let late!:(s:string)=>void,resolve!:(v:{text:string})=>void,aborted!:AbortSignal;const s=setup(async(_r,o)=>{late=o.onText;aborted=o.signal;return new Promise(r=>{resolve=r;});});const a=s.create(),b=s.create('kimi'),requestId=randomUUID();s.send(a,'hello',requestId);await tick();late('partial');
 assert.equal(s.invoke('sendMessage',{sessionId:b,text:'x',requestId:randomUUID()}).ok,false);assert.equal(s.invoke('deleteSession',{sessionId:a}).ok,false);s.state('selectSession',{sessionId:b});assert.equal(s.state().runningSessionId,a);s.send(a,'hello',requestId);
 s.state('cancelReply',{sessionId:a});assert.equal(aborted.aborted,true);late('late');resolve({text:'partiallate'});await tick();s.state('selectSession',{sessionId:a});assert.equal(s.state().selected?.turns[0]?.assistant,'partial');assert.equal(s.state().selected?.turns[0]?.status,'cancelled');s.host.revoke();
});
test('deletion remains deleted after restart and cannot replay an old request',async()=>{
 const mem=memory(),s=setup(undefined,mem.store),id=s.create(),requestId=randomUUID();s.send(id,'hello',requestId);await tick();s.state('deleteSession',{sessionId:id});assert.equal(s.invoke('sendMessage',{sessionId:id,text:'hello',requestId}).ok,false);s.host.revoke();const reopened=setup(undefined,mem.store);assert.equal(reopened.state().sessions.length,0);reopened.host.revoke();
});
test('save failure is explicit, stops mutations and keeps partial reply available for copying and cancel',async()=>{
 const mem=memory();let late!:(s:string)=>void;const s=setup(async(_r,o)=>{late=o.onText;return new Promise(()=>{});},mem.store),id=s.create();s.send(id);await tick();late('partial');mem.fail();s.state('cancelReply',{sessionId:id});assert.equal(s.state().storage,'error');assert.equal(s.state().selected?.turns[0]?.assistant,'partial');assert.equal(s.invoke('createSession',{provider:'kimi',title:'blocked'}).ok,false);s.host.revoke();
});
test('close preserves partial as interrupted, restart makes no request and foreign callers cannot read',async()=>{
 const mem=memory();let calls=0,late!:(s:string)=>void;const executor:CloudExecutorV2=async(_r,o)=>{calls++;late=o.onText;return new Promise(()=>{});};const a=setup(executor,mem.store),id=a.create();a.send(id);await tick();late('partial');a.host.revoke();late('discard');const b=setup(executor,mem.store);assert.equal(b.state().selected?.turns[0]?.status,'interrupted');assert.equal(b.state().selected?.turns[0]?.assistant,'partial');assert.equal(calls,1);assert.equal(b.host.invoke({...owner,navigationEpoch:2},'readState',{contractVersion:SESSION_VERSION}).ok,false);b.host.revoke();
});
test('auto-title accepts pasted tabs and controls; restarted duplicate turn ID is a request error',async()=>{
 const mem=memory(),s=setup(undefined,mem.store),id=s.create(),requestId=randomUUID();s.send(id,'解释\tSAR ADC\u0000',requestId);await tick();assert.equal(s.state().storage,'saved');assert.equal(s.state().selected?.title,'解释 SAR ADC');s.host.revoke();
 const next=setup(undefined,mem.store);assert.deepEqual(next.invoke('sendMessage',{sessionId:id,requestId,text:'again'}),{ok:false,error:{code:'CONFLICT'}});assert.equal(next.state().storage,'saved');next.host.revoke();
});
test('ordinary messages have no obsolete 32-request lifetime cap after deleting sessions',async()=>{
 const s=setup();for(let i=0;i<32;i++){const id=s.create();s.send(id);await tick();s.state('deleteSession',{sessionId:id});}
 const id=s.create();assert.equal(s.invoke('sendMessage',{sessionId:id,text:'33',requestId:randomUUID()}).ok,true);await tick();assert.equal(s.state().selected?.turns[0]?.status,'completed');s.host.revoke();
});
test('invalid UTF-8, unknown version and oversized storage fail closed',()=>{
 for(const bytes of [Buffer.from([0xff]),Buffer.from('{"version":99,"selectedId":null,"sessions":[]}'),Buffer.alloc(8*1024*1024+1)]){
  const folder=path.join(root,'.local/test-workspaces',`session-invalid-${randomUUID()}`);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'sessions.json'),bytes);assert.throws(()=>createSessionStore(root,folder).load());assert.equal(fs.statSync(path.join(folder,'sessions.json')).size,bytes.length);
 }
});
test('session count remains bounded, more than 100 turns persist, and startup save failure forbids generation',()=>{
 const s=setup();for(let i=0;i<50;i++)s.create();assert.deepEqual(s.invoke('createSession',{provider:'deepseek',title:'51'}),{ok:false,error:{code:'LIMIT'}});s.host.revoke();
 const mem=memory(),a=setup(undefined,mem.store),id=a.create();a.host.revoke();const session=mem.get().sessions[0]!;session.turns=Array.from({length:100},()=>({id:randomUUID(),user:'u',assistant:'a',status:'completed' as const,error:''}));
 const b=setup(undefined,mem.store);assert.equal(b.invoke('sendMessage',{sessionId:id,requestId:randomUUID(),text:'101'}).ok,true);assert.equal(b.state().selected?.turns.length,101);b.host.revoke();assert.equal(parseSessionDisk(mem.get()).sessions[0]!.turns.length,101);mem.get().sessions[0]!.turns[0]!.status='running';mem.fail();
 let calls=0;const c=setup(async()=>{calls++;return {text:'never'};},mem.store);assert.equal(c.state().storage,'error');assert.equal(c.state().selected?.turns[0]?.status,'interrupted');assert.equal(c.invoke('sendMessage',{sessionId:id,requestId:randomUUID(),text:'no'}).ok,false);assert.equal(calls,0);c.host.revoke();
});
test('running output reservation remains protected from metadata writes at the disk limit',async()=>{
 const mem=memory(),s=setup(undefined,mem.store),id=s.create();s.host.revoke();const disk=mem.get(),now=new Date().toISOString();
 // Fill independent sessions to leave just enough room for one reserved reply.
 for(let i=0;i<8;i++)disk.sessions.push({id:randomUUID(),title:'filler',provider:'deepseek',model:'deepseek-v4-flash',createdAt:now,updatedAt:now,turns:[]});
 const target=8*1024*1024-(65536*6+16384)-700;
 for(const row of disk.sessions.slice(1))for(let i=0;i<16&&Buffer.byteLength(JSON.stringify(disk))<target;i++){
  const turn={id:randomUUID(),user:'u',assistant:'',status:'completed' as const,error:'',images:[]};row.turns.push(turn);const remaining=target-Buffer.byteLength(JSON.stringify(disk));turn.assistant='a'.repeat(Math.max(1,Math.min(65536,remaining)));
 }
 assert.ok(Math.abs(Buffer.byteLength(JSON.stringify(disk))-target)<2);parseSessionDisk(disk);
 let late!:(text:string)=>void;const live=setup(async(_r,o)=>{late=o.onText;return new Promise(()=>{});},mem.store);live.send(id,'u');await tick();
 let rejected=false;for(const row of disk.sessions.slice(1)){
  const result=live.invoke('renameSession',{sessionId:row.id,title:'x'.repeat(240)});if(!result.ok){assert.equal(result.error.code,'LIMIT');rejected=true;break;}
 }
 // Admission reserves more execution metadata than an already-running reply.
 // Consume that released headroom, while remaining below the 50-session cap.
 while(!rejected&&mem.get().sessions.length<49){
  const result=live.invoke('createSession',{provider:'deepseek',title:'x'.repeat(240)});if(!result.ok){assert.equal(result.error.code,'LIMIT');rejected=true;}
 }
 live.state('selectSession',{sessionId:id});
 assert.equal(rejected,true);assert.equal(live.state().storage,'saved');late('\u0000'.repeat(65536));live.state('cancelReply',{sessionId:id});assert.equal(live.state().storage,'saved');assert.equal(live.state().selected?.turns[0]?.assistant.length,65536);live.host.revoke();
});
test('eight session IPC handlers validate caller and result, and revoke permanently',()=>{
 const handlers=new Map<string,(event:unknown,value:unknown)=>unknown>(),mem=memory();let cleared=0;
 const register=sessionExtension({root,directory:path.join(root,'.local/test-workspaces/not-used'),store:mem.store,configured:{deepseek:true,kimi:true},execute:async()=>({text:'unused'}),clearCredentials(){cleared++;}});
 const context={owner,deriveCallerContext:(event:unknown)=>event===owner?owner:null,ipcMain:{removeHandler:(name:string)=>handlers.delete(name),handle:(name:string,fn:(event:unknown,value:unknown)=>unknown)=>handlers.set(name,fn)}} as unknown as Parameters<typeof register>[0];
 const runtime=register(context);assert.deepEqual([...handlers.keys()],SESSION_METHODS.map(sessionChannel));const read=handlers.get(sessionChannel('readState'))!;
 assert.deepEqual(read(null,{contractVersion:SESSION_VERSION}),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.deepEqual(read(owner,{contractVersion:SESSION_VERSION,path:'unexpected'}),{ok:false,error:{code:'INVALID_REQUEST'}});assert.equal(parseSessionResult(read(owner,{contractVersion:SESSION_VERSION})).ok,true);
 runtime.revoke();assert.deepEqual(read(owner,{contractVersion:SESSION_VERSION}),{ok:false,error:{code:'CAPABILITY_DENIED'}});runtime.dispose();assert.equal(handlers.size,0);assert.ok(cleared>=1);
});
test('storage failure still allows in-memory browsing to copy a different active conversation',async()=>{
 const mem=memory();let late!:(text:string)=>void;const s=setup(async(_r,o)=>{late=o.onText;return new Promise(()=>{});},mem.store),a=s.create(),b=s.create('kimi');s.send(a);await tick();late('precious partial');s.state('selectSession',{sessionId:b});mem.fail();
 assert.deepEqual(s.invoke('renameSession',{sessionId:b,title:'cannot save'}),{ok:false,error:{code:'STORAGE_ERROR'}});const restored=s.state('selectSession',{sessionId:a});assert.equal(restored.storage,'error');assert.equal(restored.selected?.turns[0]?.assistant,'precious partial');
 assert.equal(s.invoke('sendMessage',{sessionId:b,requestId:randomUUID(),text:'blocked'}).ok,false);s.state('cancelReply',{sessionId:a});assert.equal(s.state().storage,'error');s.host.revoke();
});
