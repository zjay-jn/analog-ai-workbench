import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DISPLAY_PATH_VERSION,DISPLAY_PATH_LIMIT,emptyDisplayPaths,displayPathChannel,parseDisplayPathRecord,parseDisplayPathDisk,parseDisplayPathRead,parseDisplayPathRemember,parseDisplayPathResult,type DisplayPathRecord} from '../apps/desktop/src/shared/agent/display-paths';
import {createDisplayPathHost,createDisplayPathStore} from '../apps/desktop/src/main/cloud/display-path-host';
import {displayPathExtension} from '../apps/desktop/src/main/cloud/register-display-paths';
import {parseFileContext,filePrompt} from '../apps/desktop/src/shared/agent/file-context';

const record=():DisplayPathRecord=>({id:randomUUID(),name:'synthetic.txt',segments:['C','synthetic-private-directory','synthetic.txt']});
const remember=(r=record())=>({contractVersion:DISPLAY_PATH_VERSION,record:r});
const read=(ids:string[]=[])=>({contractVersion:DISPLAY_PATH_VERSION,ids});
const failure=(code:string)=>({ok:false,error:{code}});
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'synthetic-session',windowId:'synthetic-window',webContentsId:1,workspaceId:'synthetic-workspace',rootId:'synthetic-root'};
function fixture(){
 const root=path.resolve(process.cwd());assert.equal(root.toLowerCase(),'c:\\work\\analog_ai_workbench');
 const folder=fs.mkdtempSync(path.join(root,'.local','display-path-security-'));
 assert.ok(folder.startsWith(root+path.sep));return {root,folder,directory:path.join(folder,'metadata')};
}

test('display metadata schemas reject extra authority fields, accessors and abnormal objects without evaluation',()=>{
 const r=record();let getters=0;
 for(const raw of [{...r,path:'C:/synthetic.txt'},{...r,text:'must not enter metadata'},Object.assign(Object.create({}),r),Object.defineProperty({...r},'segments',{get(){getters++;return r.segments;}})])assert.throws(()=>parseDisplayPathRecord(raw));
 const indexed=[...r.segments];Object.defineProperty(indexed,'0',{get(){getters++;return 'C';}});
 for(const segments of [indexed,['C',,'synthetic.txt'],Object.assign([...r.segments],{extra:true}),Object.assign(Object.create(null),{0:'C',length:1})])assert.throws(()=>parseDisplayPathRecord({...r,segments}));
 assert.throws(()=>parseDisplayPathRemember({...remember(r),directory:'C:/elsewhere'}));
 assert.throws(()=>parseDisplayPathRead({...read([r.id]),path:'C:/elsewhere'}));
 assert.throws(()=>parseDisplayPathResult({ok:true,records:[r],path:'leaked'}));
 assert.equal(getters,0);
});

test('display metadata rejects traversal, separators, controls and sensitive or nontext leaves',()=>{
 const r=record();for(const part of ['', '.', '..','a/b','a\\b','C:','x:stream','x\u0000','x\u0085','x\u202e','x\u2066'])assert.throws(()=>parseDisplayPathRecord({...r,segments:['C',part,r.name]}));
 for(const name of ['api.txt','credentials.json','secret.md','photo.png','file.exe'])assert.throws(()=>parseDisplayPathRecord({...r,name,segments:['C',name]}));
 assert.throws(()=>parseDisplayPathRecord({...r,segments:['C','different.txt']}));
 assert.throws(()=>parseDisplayPathRecord({...r,id:'not-a-uuid'}));
});

test('display metadata rejects every Unicode bidi control promised by its gate',()=>{
 const r=record();for(const code of [0x061c,0x200e,0x200f,0x202a,0x202b,0x202c,0x202d,0x202e,0x2066,0x2067,0x2068,0x2069])assert.throws(()=>parseDisplayPathRecord({...r,segments:['C','prefix'+String.fromCodePoint(code)+'suffix',r.name]}),TypeError,'U+'+code.toString(16));
});

test('display metadata bounds read IDs, segments, total characters and disk bytes',()=>{
 const r=record();assert.deepEqual(parseDisplayPathRead(read([r.id])),read([r.id]));
 for(const ids of [[r.id,r.id],Array.from({length:9},()=>randomUUID())])assert.throws(()=>parseDisplayPathRead(read(ids)));
 assert.throws(()=>parseDisplayPathRecord({...r,segments:['x'.repeat(256),r.name]}));
 assert.throws(()=>parseDisplayPathRecord({...r,segments:[...Array<string>(128).fill('x'),r.name]}));
 assert.throws(()=>parseDisplayPathRecord({...r,segments:[...Array<string>(33).fill('x'.repeat(255)),r.name]}));
 const long=()=>({...record(),segments:[...Array<string>(30).fill('界'.repeat(250)),'synthetic.txt']});
 const over={version:1,records:Array.from({length:100},long)};assert.ok(Buffer.byteLength(JSON.stringify(over))>DISPLAY_PATH_LIMIT);assert.throws(()=>parseDisplayPathDisk(over));
 assert.throws(()=>parseDisplayPathDisk({version:1,records:[r,r]}));
});

test('display host returns only requested IDs, clones records and treats unknown old snapshots as absent',()=>{
 const a=record(),b=record(),host=createDisplayPathHost({load:()=>({version:1,records:[a,b]}),save(){throw Error('read must not write');}});
 const result=host.invoke('read',read([a.id]),true);assert.deepEqual(result,{ok:true,records:[a]});
 if(result.ok)result.records[0]!.segments[0]='tampered';
 assert.deepEqual(host.invoke('read',read([a.id]),true),{ok:true,records:[a]});assert.deepEqual(host.invoke('read',read([randomUUID()]),true),{ok:true,records:[]});
});

test('display host UUID binding is immutable and same-content replay after lost ACK is idempotent',()=>{
 const r=record();let disk=emptyDisplayPaths(),writes=0;const store={load:()=>disk,save:(v:typeof disk)=>{disk=v;writes++;}},host=createDisplayPathHost(store);
 assert.equal(host.invoke('remember',remember(r),true).ok,true);
 assert.deepEqual(host.invoke('remember',remember(r),true),{ok:true,records:[r]});assert.equal(writes,1);
 assert.deepEqual(host.invoke('remember',remember({...r,segments:['D',r.name]}),true),failure('CONFLICT'));assert.equal(writes,1);
 assert.deepEqual(createDisplayPathHost(store).invoke('read',read([r.id]),true),{ok:true,records:[r]});
});

test('display host enforces count and byte capacity without evicting or corrupting prior metadata',()=>{
 for(const records of [Array.from({length:512},record),Array.from({length:92},()=>({...record(),segments:[...Array<string>(30).fill('界'.repeat(250)),'synthetic.txt']}))]){
  let writes=0;const host=createDisplayPathHost({load:()=>({version:1,records}),save(){writes++;}}),candidate=records.length===512?record():{...record(),segments:[...Array<string>(30).fill('界'.repeat(250)),'synthetic.txt']};
  assert.deepEqual(host.invoke('remember',remember(candidate),true),failure('LIMIT'));assert.equal(writes,0);assert.deepEqual(host.invoke('read',read([records[0]!.id]),true),{ok:true,records:[records[0]]});
 }
});

test('display IPC checks every caller identity dimension, fails closed on derivation error, and revokes handlers',()=>{
 const handlers=new Map<string,(e:unknown,v:unknown)=>unknown>();let current:unknown=owner,writes=0,deriveThrows=false;
 const register=displayPathExtension({root:'C:/synthetic',directory:'C:/synthetic/metadata',store:{load:emptyDisplayPaths,save(){writes++;}}}),extension=register({owner,deriveCallerContext:()=>{if(deriveThrows)throw Error('synthetic');return current;},ipcMain:{handle:(channel:string,handler:(e:unknown,v:unknown)=>unknown)=>handlers.set(channel,handler),removeHandler:(channel:string)=>handlers.delete(channel)}} as unknown as Parameters<typeof register>[0]);
 assert.deepEqual([...handlers.keys()],[displayPathChannel('read'),displayPathChannel('remember')]);
 const invoke=(method:'read'|'remember',request:unknown)=>handlers.get(displayPathChannel(method))!({},request),r=record();
 for(const [key,value] of Object.entries(owner)){current={...owner,[key]:typeof value==='number'?value+1:typeof value==='boolean'?false:value+'-different'};assert.deepEqual(invoke('read',read([r.id])),failure('CAPABILITY_DENIED'));assert.deepEqual(invoke('remember',remember(r)),failure('CAPABILITY_DENIED'));}
 current=null;assert.deepEqual(invoke('read',read()),failure('CAPABILITY_DENIED'));current=owner;deriveThrows=true;assert.deepEqual(invoke('remember',remember(r)),failure('CAPABILITY_DENIED'));deriveThrows=false;assert.equal(writes,0);
 assert.deepEqual(invoke('remember',remember(r)),{ok:true,records:[r]});assert.equal(writes,1);extension.revoke();assert.deepEqual(invoke('read',read([r.id])),failure('CAPABILITY_DENIED'));assert.deepEqual(invoke('remember',remember(record())),failure('CAPABILITY_DENIED'));extension.dispose();assert.equal(handlers.size,0);
});

test('display store starts empty, persists only paths.json and restores on a fresh host',()=>{
 const f=fixture(),r=record(),host=createDisplayPathHost(createDisplayPathStore(f.root,f.directory));assert.deepEqual(host.invoke('read',read([r.id]),true),{ok:true,records:[]});
 assert.deepEqual(host.invoke('remember',remember(r),true),{ok:true,records:[r]});assert.deepEqual(fs.readdirSync(f.directory),['paths.json']);assert.deepEqual(createDisplayPathHost(createDisplayPathStore(f.root,f.directory)).invoke('read',read([r.id]),true),{ok:true,records:[r]});
});

test('display store detects external changes and preserves changed bytes while stopping future writes',()=>{
 const f=fixture(),r=record(),host=createDisplayPathHost(createDisplayPathStore(f.root,f.directory));assert.equal(host.invoke('remember',remember(r),true).ok,true);
 const target=path.join(f.directory,'paths.json'),external=JSON.stringify({version:1,records:[record()]});fs.writeFileSync(target,external);
 assert.deepEqual(host.invoke('remember',remember(record()),true),failure('STORAGE_ERROR'));assert.deepEqual(host.invoke('remember',remember(record()),true),failure('STORAGE_ERROR'));assert.equal(fs.readFileSync(target,'utf8'),external);
});

test('display store preserves malformed existing metadata and fails closed on injected write errors',()=>{
 const f=fixture();fs.mkdirSync(f.directory);const target=path.join(f.directory,'paths.json');fs.writeFileSync(target,'synthetic corrupt JSON');const host=createDisplayPathHost(createDisplayPathStore(f.root,f.directory));assert.deepEqual(host.invoke('read',read(),true),failure('STORAGE_ERROR'));assert.deepEqual(host.invoke('remember',remember(),true),failure('STORAGE_ERROR'));assert.equal(fs.readFileSync(target,'utf8'),'synthetic corrupt JSON');
 let writes=0;const failing=createDisplayPathHost({load:emptyDisplayPaths,save(){writes++;throw Error('synthetic disk failure');}});assert.deepEqual(failing.invoke('remember',remember(),true),failure('STORAGE_ERROR'));assert.deepEqual(failing.invoke('remember',remember(),true),failure('STORAGE_ERROR'));assert.equal(writes,1);
});

test('display store rejects junction ancestors and hard-linked metadata without touching their targets',()=>{
 const f=fixture(),real=path.join(f.folder,'real'),linked=path.join(f.folder,'linked');fs.mkdirSync(real);fs.symlinkSync(real,linked,'junction');assert.throws(()=>createDisplayPathStore(f.root,linked).load());assert.deepEqual(fs.readdirSync(real),[]);
 fs.mkdirSync(f.directory);const original=path.join(f.folder,'synthetic-original.json'),bytes=JSON.stringify(emptyDisplayPaths());fs.writeFileSync(original,bytes);fs.linkSync(original,path.join(f.directory,'paths.json'));assert.throws(()=>createDisplayPathStore(f.root,f.directory).load());assert.equal(fs.readFileSync(original,'utf8'),bytes);
 assert.throws(()=>createDisplayPathStore(f.root,f.root));assert.throws(()=>createDisplayPathStore(f.root,path.dirname(f.root)));
});

test('display metadata cannot be admitted as file context or appear in model prompts through metadata fields',()=>{
 const r=record(),context={id:r.id,name:r.name,text:'synthetic excerpt',startLine:1,endLine:1,totalLines:1};
 assert.throws(()=>parseFileContext({...context,segments:r.segments}));assert.throws(()=>filePrompt('question',[{...context,path:r.segments.join('/')} as typeof context]));assert.ok(!filePrompt('question',[context]).includes('synthetic-private-directory'));
});
