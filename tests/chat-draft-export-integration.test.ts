import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sessionExtension} from '../apps/desktop/src/main/cloud/register-session-ipc';
import {SESSION_VERSION,sessionChannel,parseSessionResult,type SessionMethod,type SessionState} from '../apps/desktop/src/shared/agent/chat-sessions';
import {draftChannel,emptyDraft,parseDraftReadResult,parseDraftSaveResult,type ChatDraft} from '../apps/desktop/src/shared/agent/chat-drafts';
import {EXPORT_VERSION,EXPORT_CHANNEL,parseChatExportResult} from '../apps/desktop/src/shared/agent/chat-export';
import {createDraftController} from '../apps/desktop/src/renderer/agent/draft-controller';
import type {CloudExecutorV2} from '../apps/desktop/src/main/cloud/cloud-host';

const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'synthetic',windowId:'synthetic',webContentsId:1,workspaceId:'synthetic',rootId:'synthetic'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const attachments=(text:string):ChatDraft=>({text,revision:2,images:[{id:randomUUID(),name:'synthetic.jpg',data:Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0,255,217]).toString('base64'),width:1,height:1}],files:[{id:randomUUID(),name:'synthetic.txt',text:'private unsent excerpt',startLine:1,endLine:1,totalLines:1}]});
const contents=({text,images,files}:ChatDraft)=>({text,images,files});
function fixture(){const root=path.resolve(process.cwd());assert.equal(root.toLowerCase(),'c:\\work\\analog_ai_workbench');const folder=fs.mkdtempSync(path.join(root,'.local','draft-export-integration-'));assert.ok(folder.startsWith(root+path.sep));return {root,folder};}
type Fixture=ReturnType<typeof fixture>;
function runtime(f:Fixture,execute:CloudExecutorV2=async(_r,o)=>{o.onText('synthetic completed answer');return {text:'synthetic completed answer'};},choose:()=>Promise<string|undefined>=async()=>undefined){
 const handlers=new Map<string,(event:unknown,value:unknown)=>unknown>(),register=sessionExtension({root:f.root,directory:path.join(f.folder,'sessions'),draftDirectory:path.join(f.folder,'drafts'),configured:{deepseek:true,kimi:true},execute,clearCredentials(){},chooseExportFile:choose});
 const extension=register({owner,deriveCallerContext:()=>owner,ipcMain:{handle:(key:string,fn:(e:unknown,v:unknown)=>unknown)=>handlers.set(key,fn),removeHandler:(key:string)=>handlers.delete(key)}} as unknown as Parameters<typeof register>[0]);
 const drafts=createDraftController({read:async request=>parseDraftReadResult(await handlers.get(draftChannel('read'))!({},request)),save:async request=>parseDraftSaveResult(await handlers.get(draftChannel('save'))!({},request))});
 const invoke=(method:SessionMethod,fields:object={})=>{const r=parseSessionResult(handlers.get(sessionChannel(method))!({},{contractVersion:SESSION_VERSION,...fields}));if(!r.ok)throw Error(r.error.code);return r.value;};
 const create=(title:string)=>invoke('createSession',{provider:'deepseek',title}).selectedId!;
 return {drafts,invoke,create,export:async(sessionId:string)=>parseChatExportResult(await handlers.get(EXPORT_CHANNEL)!({},{contractVersion:EXPORT_VERSION,sessionId})),close(){drafts.dispose();extension.dispose();}};
}
function bytes(f:Fixture){return {history:fs.readFileSync(path.join(f.folder,'sessions','sessions.json'),'utf8'),drafts:fs.readFileSync(path.join(f.folder,'drafts','drafts.json'),'utf8')};}
function select(r:ReturnType<typeof runtime>,sessionId:string):SessionState{const state=r.invoke('selectSession',{sessionId});r.drafts.reconcile(state);return state;}

for(const mode of ['CANCELLED','EXISTS','WRITE_FAILED','VERIFY_FAILED'] as const)test(`integrated export ${mode} preserves history and both session drafts, then allows a fresh export`,async()=>{
 const f=fixture(),target=path.join(f.folder,'export.md');let fail=true;
 const r=runtime(f,undefined,async()=>{if(!fail)return path.join(f.folder,'retry.md');if(mode==='CANCELLED')return undefined;if(mode==='WRITE_FAILED')throw Error('synthetic picker failure');return target;});
 const originalSync=fs.fsyncSync;
 try{await r.drafts.start();const a=r.create('conversation A');r.invoke('sendMessage',{sessionId:a,requestId:randomUUID(),text:'sent A'});await tick();const b=r.create('conversation B');r.drafts.change(()=>({[a]:attachments('unsent A'),[b]:attachments('unsent B')}));assert.ok(await r.drafts.flush());const before=bytes(f),editable=structuredClone(r.drafts.snapshot().records);
  if(mode==='EXISTS')fs.writeFileSync(target,'existing user content');if(mode==='VERIFY_FAILED')fs.fsyncSync=(()=>{throw Error('synthetic fsync failure');}) as typeof fs.fsyncSync;
  const result=await r.export(a);fs.fsyncSync=originalSync;assert.deepEqual(result,{ok:false,error:{code:mode}});assert.deepEqual(bytes(f),before);assert.deepEqual(r.drafts.snapshot().records,editable);assert.equal(r.invoke('readState').selectedId,b);
  if(mode==='EXISTS')assert.equal(fs.readFileSync(target,'utf8'),'existing user content');if(mode==='CANCELLED'||mode==='WRITE_FAILED')assert.equal(fs.existsSync(target),false);
  fail=false;assert.deepEqual(await r.export(a),{ok:true});const exported=fs.readFileSync(path.join(f.folder,'retry.md'),'utf8');assert.ok(exported.includes('sent A'));assert.ok(!exported.includes('unsent A'));assert.ok(!exported.includes('unsent B'));assert.ok(!exported.includes('private unsent excerpt'));assert.deepEqual(bytes(f),before);
 }finally{fs.fsyncSync=originalSync;r.close();}
});

test('integrated export rejects newly introduced display-path application-data directory',async()=>{
 const f=fixture(),directory=path.join(f.folder,'display-paths'),target=path.join(directory,'export.md');fs.mkdirSync(directory);const r=runtime(f,undefined,async()=>target);
 try{await r.drafts.start();const id=r.create('synthetic');r.drafts.change(()=>({[id]:attachments('keep this draft')}));assert.ok(await r.drafts.flush());const before=bytes(f);assert.deepEqual(await r.export(id),{ok:false,error:{code:'UNSUPPORTED_FILE'}});assert.equal(fs.existsSync(target),false);assert.deepEqual(bytes(f),before);}finally{r.close();}
});

for(const uncertain of [false,true])test(`next draft remains session-owned across generation, browsing and restart with ${uncertain?'lost':'known'} send acknowledgement`,async()=>{
 const f=fixture();let requests=0,onText!:(text:string)=>void;const execute:CloudExecutorV2=async(_request,options)=>{requests++;onText=options.onText;return new Promise(()=>{});};let r=runtime(f,execute);
 try{await r.drafts.start();const a=r.create('A'),b=r.create('B');select(r,a);const submitted={...emptyDraft(),text:'first sent question',revision:1},requestId=randomUUID();r.drafts.change(()=>({[a]:submitted}));assert.ok(await r.drafts.beginSend(a,requestId,submitted));r.invoke('sendMessage',{sessionId:a,requestId,text:submitted.text});await tick();onText('partial answer');
  const next=attachments('next question for A'),other=attachments('draft for B');r.drafts.change(d=>({...d,[a]:next,[b]:other}));select(r,b);await r.drafts.finishSend(a,!uncertain,!uncertain);assert.ok(await r.drafts.flush());assert.deepEqual(contents(r.drafts.snapshot().records[a]!.draft),contents(next));assert.deepEqual(r.drafts.snapshot().records[b]!.draft,other);assert.equal(r.invoke('readState').runningSessionId,a);assert.equal(requests,1);
  r.close();r=runtime(f,execute);await r.drafts.start();r.drafts.reconcile(r.invoke('readState'));assert.equal(r.invoke('readState').selectedId,b);assert.deepEqual(contents(r.drafts.snapshot().records[a]!.draft),contents(next));assert.deepEqual(r.drafts.snapshot().records[b]!.draft,other);assert.equal(r.drafts.hasPending(a),uncertain);assert.equal(requests,1);
  const restored=select(r,a);assert.ok(await r.drafts.flush());assert.equal(restored.selected!.turns[0]!.status,'interrupted');assert.equal(restored.selected!.turns[0]!.assistant,'partial answer');assert.equal(r.drafts.hasPending(a),false);assert.deepEqual(contents(r.drafts.snapshot().records[a]!.draft),contents(next));assert.deepEqual(r.drafts.snapshot().records[b]!.draft,other);assert.equal(requests,1);
 }finally{r.close();}
});

test('running export captures clicked session and partial answer before picker while browsing and later text continue',async()=>{
 const f=fixture(),target=path.join(f.folder,'running.md');let onText!:(text:string)=>void,choose!:(target:string)=>void;const r=runtime(f,async(_request,o)=>{onText=o.onText;return new Promise(()=>{});},()=>new Promise(resolve=>choose=resolve));
 try{await r.drafts.start();const a=r.create('A'),b=r.create('B');r.invoke('sendMessage',{sessionId:a,requestId:randomUUID(),text:'A sent question'});await tick();onText('first partial');r.drafts.change(()=>({[a]:attachments('A next draft'),[b]:attachments('B next draft')}));assert.ok(await r.drafts.flush());const exporting=r.export(a);select(r,b);onText(' later partial');choose(target);assert.deepEqual(await exporting,{ok:true});const text=fs.readFileSync(target,'utf8');assert.ok(text.includes('A sent question'));assert.ok(text.includes('first partial'));assert.ok(text.includes('状态：running'));assert.ok(!text.includes('later partial'));assert.ok(!text.includes('next draft'));assert.equal(r.invoke('readState').selectedId,b);assert.equal(r.drafts.snapshot().records[a]!.draft.text,'A next draft');assert.equal(r.drafts.snapshot().records[b]!.draft.text,'B next draft');}finally{r.close();}
});
